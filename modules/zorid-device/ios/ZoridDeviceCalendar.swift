import Foundation
import CoreFoundation
import UIKit
import EventKit
import EventKitUI

// App-process service. Bridge entry and editor callbacks run on the main queue.
final class ZoridDeviceCalendar: NSObject, EKEventEditViewDelegate, UIAdaptivePresentationControllerDelegate {
  static let shared = ZoridDeviceCalendar()
  private let store = EKEventStore()
  private var editorCompletion: ((Result<String, Error>) -> Void)?
  private weak var editor: EKEventEditViewController?
  private var eventQueries: [UUID: (Result<String, Error>) -> Void] = [:]
  private var reminderFetches: [UUID: (token: Any, completion: (Result<String, Error>) -> Void)] = [:]

  // Reload cleanup cancels pending UI/reads, never native authorization or committed writes.
  func cancel() {
    let completion = editorCompletion
    let controller = editor
    editorCompletion = nil
    editor = nil
    controller?.dismiss(animated: false)
    if let completion { finish(["action": "canceled", "id": NSNull()], completion) }
    let queries = Array(eventQueries.values)
    eventQueries.removeAll()
    for completion in queries { completion(.failure(ZoridDeviceError.failure("The calendar query was canceled."))) }
    let fetches = Array(reminderFetches.values)
    reminderFetches.removeAll()
    for fetch in fetches {
      store.cancelFetchRequest(fetch.token)
      fetch.completion(.failure(ZoridDeviceError.failure("The reminders query was canceled.")))
    }
  }

  func call(_ operation: String, json: String, completion: @escaping (Result<String, Error>) -> Void) {
    do {
      let keys: Set<String>
      switch operation {
      case "status": keys = []
      case "request": keys = ["entity", "access"]
      case "calendars": keys = ["entity"]
      case "events": keys = ["start", "end", "calendarIds", "limit"]
      case "event", "reminder", "removeReminder": keys = ["id"]
      case "saveEvent": keys = ["event", "span"]
      case "removeEvent": keys = ["id", "span"]
      case "editEvent": keys = ["event"]
      case "reminders": keys = ["calendarIds", "completed", "limit"]
      case "saveReminder": keys = ["reminder"]
      case "setReminderCompleted": keys = ["id", "completed"]
      default: throw ZoridDeviceError.unsupported("Unknown calendar operation.")
      }
      let input = try ZoridDeviceJSON.object(json, keys: keys)
      guard editorCompletion == nil || operation == "status" else { throw ZoridDeviceError.failure("Finish the open calendar editor first.") }
      switch operation {
      case "status": finish(status(), completion)
      case "request": try request(input, completion)
      case "calendars":
        let entity = try self.entity(input["entity"])
        try requireAccess(entity, writeOnlyAllowed: true)
        let defaultID = entity == .event ? store.defaultCalendarForNewEvents?.calendarIdentifier : store.defaultCalendarForNewReminders()?.calendarIdentifier
        let calendars = store.calendars(for: entity).map { calendar -> [String: Any] in
          ["id": calendar.calendarIdentifier, "title": calendar.title ?? "", "color": color(calendar),
           "allowsModifications": calendar.allowsContentModifications, "isDefault": calendar.calendarIdentifier == defaultID]
        }
        finish(["calendars": calendars], completion)
      case "events": try events(input, completion)
      case "event":
        try requireAccess(.event)
        let event = store.event(withIdentifier: try string(input["id"], "id"))
        finish(event.map { eventObject($0) as Any } ?? NSNull(), completion)
      case "saveEvent": try saveEvent(input, completion)
      case "removeEvent":
        try requireAccess(.event)
        guard let event = store.event(withIdentifier: try string(input["id"], "id")) else { throw ZoridDeviceError.failure("The calendar event is no longer available.") }
        try requireNonrecurring(event)
        try writable(event.calendar, entity: .event)
        try store.remove(event, span: span(input["span"]), commit: true)
        finish(["removed": true], completion)
      case "editEvent": try editEvent(input, completion)
      case "reminders": try reminders(input, completion)
      case "reminder":
        try requireAccess(.reminder)
        let reminder = store.calendarItem(withIdentifier: try string(input["id"], "id")) as? EKReminder
        finish(reminder.map { reminderObject($0) as Any } ?? NSNull(), completion)
      case "saveReminder": try saveReminder(input, completion)
      case "setReminderCompleted":
        try requireAccess(.reminder)
        guard let reminder = store.calendarItem(withIdentifier: try string(input["id"], "id")) as? EKReminder else { throw ZoridDeviceError.failure("The reminder is no longer available.") }
        try writable(reminder.calendar, entity: .reminder)
        reminder.isCompleted = try boolean(input["completed"], "completed")
        try store.save(reminder, commit: true)
        finish(reminderObject(reminder), completion)
      case "removeReminder":
        try requireAccess(.reminder)
        guard let reminder = store.calendarItem(withIdentifier: try string(input["id"], "id")) as? EKReminder else { throw ZoridDeviceError.failure("The reminder is no longer available.") }
        try writable(reminder.calendar, entity: .reminder)
        try store.remove(reminder, commit: true)
        finish(["removed": true], completion)
      default: break
      }
    } catch {
      // Failed validation/save must not leave edited cached EventKit objects for a later call.
      if ["saveEvent", "saveReminder", "setReminderCompleted", "removeEvent", "removeReminder"].contains(operation) { store.reset() }
      completion(.failure(error))
    }
  }

  private func status() -> [String: Any] {
    let permissionFreeEditor: Bool
    if #available(iOS 17, *) { permissionFreeEditor = true } else { permissionFreeEditor = false }
    return ["events": access(.event), "reminders": access(.reminder), "permissionFreeEditor": permissionFreeEditor]
  }

  private func access(_ entity: EKEntityType) -> String {
    let value = EKEventStore.authorizationStatus(for: entity)
    if #available(iOS 17, *) {
      if value == .fullAccess { return "full" }
      if value == .writeOnly { return "writeOnly" }
    }
    switch value {
    case .notDetermined: return "notDetermined"
    case .restricted: return "restricted"
    case .denied: return "denied"
    case .authorized: return "full"
    default: return "unknown"
    }
  }

  private func requireAccess(_ entity: EKEntityType, writeOnlyAllowed: Bool = false) throws {
    let current = access(entity)
    guard current == "full" || (writeOnlyAllowed && entity == .event && current == "writeOnly") else {
      throw ZoridDeviceError.failure(entity == .event ? "Request the required Calendar access first." : "Request full Reminders access first.")
    }
  }

  private func request(_ input: [String: Any], _ completion: @escaping (Result<String, Error>) -> Void) throws {
    let entity = try self.entity(input["entity"])
    let level = try optionalString(input["access"], "access") ?? "full"
    guard ["full", "writeOnly"].contains(level), entity == .event || level == "full" else {
      throw ZoridDeviceError.invalid("Reminders requires full access; Calendar accepts full or writeOnly.")
    }
    let callback: (Bool, Error?) -> Void = { [weak self] _, error in
      DispatchQueue.main.async {
        guard let self else { completion(.failure(ZoridDeviceError.failure("Calendar access request ended."))); return }
        if error != nil { completion(.failure(ZoridDeviceError.failure("Calendar access request failed."))); return }
        self.store.reset()
        self.finish(self.status(), completion)
      }
    }
    if #available(iOS 17, *) {
      if entity == .reminder { store.requestFullAccessToReminders(completion: callback) }
      else if level == "writeOnly" { store.requestWriteOnlyAccessToEvents(completion: callback) }
      else { store.requestFullAccessToEvents(completion: callback) }
    } else { store.requestAccess(to: entity, completion: callback) }
  }

  private func events(_ input: [String: Any], _ completion: @escaping (Result<String, Error>) -> Void) throws {
    try requireAccess(.event)
    let start = try date(input["start"], "start"), end = try date(input["end"], "end")
    guard end > start, end.timeIntervalSince(start) <= 366 * 86_400 else { throw ZoridDeviceError.invalid("Choose a positive event window of at most 366 days.") }
    let calendars = try calendarSelection(input["calendarIds"], entity: .event, required: false)
    let limit = try resultLimit(input["limit"])
    // A separate store keeps a synchronous EventKit fetch off the UI thread.
    let identifiers = calendars?.map(\.calendarIdentifier)
    let queryID = UUID()
    eventQueries[queryID] = completion
    DispatchQueue.global(qos: .userInitiated).async {
      let queryStore = EKEventStore()
      let queryCalendars = identifiers?.compactMap { queryStore.calendar(withIdentifier: $0) }
      if let identifiers, queryCalendars?.count != identifiers.count {
        DispatchQueue.main.async {
          if let completion = self.eventQueries.removeValue(forKey: queryID) { completion(.failure(ZoridDeviceError.failure("A selected calendar is no longer available."))) }
        }
        return
      }
      let predicate = queryStore.predicateForEvents(withStart: start, end: end, calendars: queryCalendars)
      let matches = queryStore.events(matching: predicate).sorted { $0.startDate < $1.startDate }
      let output: [String: Any] = ["events": matches.prefix(limit).map(self.eventObject), "truncated": matches.count > limit]
      DispatchQueue.main.async {
        guard let completion = self.eventQueries.removeValue(forKey: queryID) else { return }
        guard self.access(.event) == "full" else { completion(.failure(ZoridDeviceError.failure("Calendar access changed during the query."))); return }
        self.finish(output, completion)
      }
    }
  }

  private func saveEvent(_ input: [String: Any], _ completion: @escaping (Result<String, Error>) -> Void) throws {
    let values = try nested(input["event"], keys: eventKeys, name: "event")
    let id = try optionalString(values["id"], "id")
    try requireAccess(.event, writeOnlyAllowed: id == nil)
    let event: EKEvent
    if let id {
      guard let existing = store.event(withIdentifier: id) else { throw ZoridDeviceError.failure("The calendar event is no longer available.") }
      try requireNonrecurring(existing)
      event = existing
    } else { event = EKEvent(eventStore: store) }
    try fillEvent(event, values: values, complete: true)
    try writable(event.calendar, entity: .event)
    try store.save(event, span: span(input["span"]), commit: true)
    let canRead = access(.event) == "full"
    let representation: Any = canRead ? eventObject(event) as Any : NSNull()
    finish(["saved": true, "id": nullable(event.eventIdentifier), "event": representation], completion)
  }

  private let eventKeys: Set<String> = ["id", "calendarId", "title", "start", "end", "allDay", "timeZone", "notes", "location", "url", "alarms"]

  private func fillEvent(_ event: EKEvent, values: [String: Any], complete: Bool) throws {
    if complete || values["title"] != nil { event.title = try string(values["title"], "title", allowEmpty: true) }
    if complete || values["start"] != nil { event.startDate = try date(values["start"], "start") }
    if complete || values["end"] != nil { event.endDate = try date(values["end"], "end") }
    guard let start = event.startDate, let end = event.endDate, end > start else { throw ZoridDeviceError.invalid("The event end must follow its start.") }
    if let value = values["allDay"] { event.isAllDay = try boolean(value, "allDay") }
    if let value = values["timeZone"] {
      if value is NSNull { event.timeZone = nil }
      else {
        guard let zone = TimeZone(identifier: try string(value, "timeZone")) else { throw ZoridDeviceError.invalid("Use a valid time zone identifier.") }
        event.timeZone = zone
      }
    }
    if let value = values["notes"] { event.notes = try optionalString(value, "notes", allowEmpty: true) }
    if let value = values["location"] { event.location = try optionalString(value, "location", allowEmpty: true) }
    if let value = values["url"] { event.url = try url(value) }
    if let value = values["alarms"] { event.alarms = try alarms(value) }
    if let id = try optionalString(values["calendarId"], "calendarId") { event.calendar = try calendar(id, entity: .event) }
    else if event.calendar == nil, ["full", "writeOnly"].contains(access(.event)) { event.calendar = store.defaultCalendarForNewEvents }
  }

  private func editEvent(_ input: [String: Any], _ completion: @escaping (Result<String, Error>) -> Void) throws {
    let values = try input["event"].map { try nested($0, keys: eventKeys, name: "event") } ?? [:]
    let event: EKEvent
    if let id = try optionalString(values["id"], "id") {
      try requireAccess(.event)
      guard let existing = store.event(withIdentifier: id) else { throw ZoridDeviceError.failure("The calendar event is no longer available.") }
      event = existing
    } else {
      if #available(iOS 17, *) {} else { try requireAccess(.event) }
      event = EKEvent(eventStore: store)
      event.startDate = Date()
      event.endDate = Date().addingTimeInterval(3_600)
    }
    // A permission-free editor must not enumerate or identify the person's calendars.
    if access(.event) != "full", values["calendarId"] != nil { throw ZoridDeviceError.invalid("Selecting a calendar by identifier requires full Calendar access.") }
    try fillEvent(event, values: values, complete: false)
    guard let presenter = presenter(), !presenter.isBeingDismissed, !presenter.isBeingPresented,
          presenter.presentedViewController == nil, presenter.transitionCoordinator == nil else { throw ZoridDeviceError.failure("An idle foreground view is required for the calendar editor.") }
    let controller = EKEventEditViewController()
    controller.eventStore = store
    controller.event = event
    controller.editViewDelegate = self
    editorCompletion = completion
    editor = controller
    presenter.present(controller, animated: true)
    controller.presentationController?.delegate = self
  }

  func eventEditViewController(_ controller: EKEventEditViewController, didCompleteWith action: EKEventEditViewAction) {
    guard controller === editor else { return }
    let result: String
    switch action {
    case .saved: result = "saved"
    case .deleted: result = "deleted"
    default: result = "canceled"
    }
    let id = action == .saved && access(.event) == "full" ? controller.event?.eventIdentifier : nil
    let completion = editorCompletion
    editorCompletion = nil
    editor = nil
    controller.dismiss(animated: true) { if let completion { self.finish(["action": result, "id": self.nullable(id)], completion) } }
  }

  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
    guard presentationController.presentedViewController === editor, let completion = editorCompletion else { return }
    editorCompletion = nil
    editor = nil
    finish(["action": "canceled", "id": NSNull()], completion)
  }

  private func reminders(_ input: [String: Any], _ completion: @escaping (Result<String, Error>) -> Void) throws {
    try requireAccess(.reminder)
    let calendars = try calendarSelection(input["calendarIds"], entity: .reminder, required: true)!
    let limit = try resultLimit(input["limit"])
    let completed = try input["completed"].map { try boolean($0, "completed") }
    let predicate = store.predicateForReminders(in: calendars)
    let fetchID = UUID()
    let token = store.fetchReminders(matching: predicate) { [weak self] matches in
      DispatchQueue.main.async {
        guard let self, let pending = self.reminderFetches.removeValue(forKey: fetchID) else { return }
        let completion = pending.completion
        guard self.access(.reminder) == "full", let matches else { completion(.failure(ZoridDeviceError.failure("The reminders query failed or access changed."))); return }
        let selected = matches.filter { completed == nil || $0.isCompleted == completed }
          .sorted { ($0.creationDate ?? .distantPast) < ($1.creationDate ?? .distantPast) }
        self.finish(["reminders": selected.prefix(limit).map(self.reminderObject), "truncated": selected.count > limit], completion)
      }
    }
    reminderFetches[fetchID] = (token: token, completion: completion)
  }

  private func saveReminder(_ input: [String: Any], _ completion: @escaping (Result<String, Error>) -> Void) throws {
    try requireAccess(.reminder)
    let keys: Set<String> = ["id", "calendarId", "title", "notes", "url", "dueAt", "startAt", "dueDateOnly", "startDateOnly", "priority", "completed"]
    let values = try nested(input["reminder"], keys: keys, name: "reminder")
    let reminder: EKReminder
    if let id = try optionalString(values["id"], "id") {
      guard let existing = store.calendarItem(withIdentifier: id) as? EKReminder else { throw ZoridDeviceError.failure("The reminder is no longer available.") }
      reminder = existing
    } else { reminder = EKReminder(eventStore: store) }
    reminder.title = try string(values["title"], "title", allowEmpty: true)
    if let id = try optionalString(values["calendarId"], "calendarId") { reminder.calendar = try calendar(id, entity: .reminder) }
    else if reminder.calendar == nil { reminder.calendar = store.defaultCalendarForNewReminders() }
    try writable(reminder.calendar, entity: .reminder)
    if let value = values["notes"] { reminder.notes = try optionalString(value, "notes", allowEmpty: true) }
    if let value = values["url"] { reminder.url = try url(value) }
    if values["dueDateOnly"] != nil, values["dueAt"] == nil || values["dueAt"] is NSNull { throw ZoridDeviceError.invalid("dueDateOnly requires a dueAt date.") }
    if values["startDateOnly"] != nil, values["startAt"] == nil || values["startAt"] is NSNull { throw ZoridDeviceError.invalid("startDateOnly requires a startAt date.") }
    let dueOnly = try values["dueDateOnly"].map { try boolean($0, "dueDateOnly") } ?? false
    let startOnly = try values["startDateOnly"].map { try boolean($0, "startDateOnly") } ?? false
    if let value = values["dueAt"] { reminder.dueDateComponents = try components(value, name: "dueAt", dateOnly: dueOnly) }
    if let value = values["startAt"] { reminder.startDateComponents = try components(value, name: "startAt", dateOnly: startOnly) }
    if let due = componentDate(reminder.dueDateComponents), let start = componentDate(reminder.startDateComponents), due < start { throw ZoridDeviceError.invalid("A reminder due date cannot precede its start date.") }
    if let value = values["priority"] { reminder.priority = try integer(value, "priority", range: 0...9) }
    if let value = values["completed"] { reminder.isCompleted = try boolean(value, "completed") }
    try store.save(reminder, commit: true)
    finish(reminderObject(reminder), completion)
  }

  private func eventObject(_ event: EKEvent) -> [String: Any] {
    let alarms: [Any] = (event.alarms ?? []).map { alarm in
      if let absolute = alarm.absoluteDate { return ["absoluteAt": absolute.timeIntervalSince1970 * 1_000] }
      return alarm.relativeOffset
    }
    return ["id": event.eventIdentifier ?? "", "calendarId": event.calendar?.calendarIdentifier ?? "", "title": event.title ?? "",
      "start": event.startDate.timeIntervalSince1970 * 1_000, "end": event.endDate.timeIntervalSince1970 * 1_000,
      "allDay": event.isAllDay, "timeZone": nullable(event.timeZone?.identifier), "notes": nullable(event.notes),
      "location": nullable(event.location), "url": nullable(event.url?.absoluteString), "alarms": alarms,
      "hasRecurrenceRules": event.hasRecurrenceRules]
  }

  private func reminderObject(_ reminder: EKReminder) -> [String: Any] {
    ["id": reminder.calendarItemIdentifier, "calendarId": reminder.calendar?.calendarIdentifier ?? "", "title": reminder.title ?? "",
     "notes": nullable(reminder.notes), "url": nullable(reminder.url?.absoluteString),
     "dueAt": nullable(componentDate(reminder.dueDateComponents).map { $0.timeIntervalSince1970 * 1_000 }),
     "startAt": nullable(componentDate(reminder.startDateComponents).map { $0.timeIntervalSince1970 * 1_000 }),
     "dueDateOnly": isDateOnly(reminder.dueDateComponents), "startDateOnly": isDateOnly(reminder.startDateComponents),
     "priority": reminder.priority, "completed": reminder.isCompleted,
     "completedAt": nullable(reminder.completionDate.map { $0.timeIntervalSince1970 * 1_000 })]
  }

  private func calendarSelection(_ value: Any?, entity: EKEntityType, required: Bool) throws -> [EKCalendar]? {
    guard let value else {
      if required { throw ZoridDeviceError.invalid("Select one or more reminder calendars.") }
      return nil
    }
    guard let ids = value as? [String], (1...32).contains(ids.count), Set(ids).count == ids.count else { throw ZoridDeviceError.invalid("Choose 1 to 32 unique calendar identifiers.") }
    return try ids.map { try calendar(string($0, "calendarId"), entity: entity) }
  }

  private func calendar(_ id: String, entity: EKEntityType) throws -> EKCalendar {
    guard let calendar = store.calendar(withIdentifier: id), calendar.allowedEntityTypes.contains(entity == .event ? .event : .reminder) else { throw ZoridDeviceError.failure("The selected calendar is no longer available for this item type.") }
    return calendar
  }

  private func writable(_ calendar: EKCalendar?, entity: EKEntityType) throws {
    guard let calendar, calendar.allowsContentModifications, calendar.allowedEntityTypes.contains(entity == .event ? .event : .reminder) else { throw ZoridDeviceError.failure("Choose a writable calendar for this item type.") }
  }

  private func requireNonrecurring(_ event: EKEvent) throws {
    guard !event.hasRecurrenceRules else { throw ZoridDeviceError.unsupported("Use the native calendar editor to change or delete a recurring event.") }
  }

  private func entity(_ value: Any?) throws -> EKEntityType {
    switch try string(value, "entity") {
    case "events": return .event
    case "reminders": return .reminder
    default: throw ZoridDeviceError.invalid("Choose events or reminders.")
    }
  }

  private func span(_ value: Any?) throws -> EKSpan {
    switch try optionalString(value, "span") ?? "thisEvent" {
    case "thisEvent": return .thisEvent
    case "futureEvents": return .futureEvents
    default: throw ZoridDeviceError.invalid("Choose thisEvent or futureEvents.")
    }
  }

  private func nested(_ value: Any?, keys: Set<String>, name: String) throws -> [String: Any] {
    guard let object = value as? [String: Any], Set(object.keys).isSubset(of: keys) else { throw ZoridDeviceError.invalid("Invalid \(name) fields.") }
    return object
  }

  private func string(_ value: Any?, _ name: String, allowEmpty: Bool = false) throws -> String {
    guard let value = value as? String, (allowEmpty || !value.isEmpty), value.utf8.count <= 65_536 else { throw ZoridDeviceError.invalid("Invalid \(name).") }
    return value
  }

  private func optionalString(_ value: Any?, _ name: String, allowEmpty: Bool = false) throws -> String? {
    guard let value, !(value is NSNull) else { return nil }
    return try string(value, name, allowEmpty: allowEmpty)
  }

  private func boolean(_ value: Any?, _ name: String) throws -> Bool {
    guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { throw ZoridDeviceError.invalid("Invalid \(name) boolean.") }
    return number.boolValue
  }

  private func number(_ value: Any?, _ name: String) throws -> Double {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite else { throw ZoridDeviceError.invalid("Invalid \(name) number.") }
    return number.doubleValue
  }

  private func integer(_ value: Any?, _ name: String, range: ClosedRange<Int>) throws -> Int {
    let number = try self.number(value, name)
    guard number.rounded(.towardZero) == number, number >= Double(range.lowerBound), number <= Double(range.upperBound) else { throw ZoridDeviceError.invalid("Invalid \(name) range.") }
    return Int(number)
  }

  private func resultLimit(_ value: Any?) throws -> Int { try value.map { try integer($0, "limit", range: 1...500) } ?? 100 }

  private func date(_ value: Any?, _ name: String) throws -> Date {
    let milliseconds = try number(value, name)
    guard abs(milliseconds) <= 8_640_000_000_000_000 else { throw ZoridDeviceError.invalid("Invalid \(name) date.") }
    return Date(timeIntervalSince1970: milliseconds / 1_000)
  }

  private func components(_ value: Any, name: String, dateOnly: Bool) throws -> DateComponents? {
    if value is NSNull { return nil }
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = .current
    let fields: Set<Calendar.Component> = dateOnly ? [.year, .month, .day] : [.year, .month, .day, .hour, .minute, .second]
    var result = calendar.dateComponents(fields, from: try date(value, name))
    result.calendar = calendar
    result.timeZone = calendar.timeZone
    return result
  }

  private func componentDate(_ components: DateComponents?) -> Date? {
    guard let components else { return nil }
    var calendar = components.calendar ?? Calendar(identifier: .gregorian)
    calendar.timeZone = components.timeZone ?? .current
    return calendar.date(from: components)
  }

  private func isDateOnly(_ components: DateComponents?) -> Bool {
    guard let components else { return false }
    return components.hour == nil && components.minute == nil && components.second == nil
  }

  private func url(_ value: Any) throws -> URL? {
    if value is NSNull { return nil }
    let raw = try string(value, "url")
    guard raw.utf8.count <= 4_096, let url = URL(string: raw), url.scheme != nil, !raw.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) else { throw ZoridDeviceError.invalid("Use an absolute URL.") }
    return url
  }

  private func alarms(_ value: Any) throws -> [EKAlarm] {
    guard let values = value as? [Any], values.count <= 20 else { throw ZoridDeviceError.invalid("Use at most 20 alarms.") }
    return try values.map { value in
      if let absolute = value as? [String: Any] {
        guard Set(absolute.keys) == Set(["absoluteAt"]) else { throw ZoridDeviceError.invalid("Invalid absolute alarm.") }
        return EKAlarm(absoluteDate: try date(absolute["absoluteAt"], "absoluteAt"))
      }
      let seconds = try number(value, "alarm")
      guard abs(seconds) <= 366 * 86_400 else { throw ZoridDeviceError.invalid("Relative alarms must be within 366 days of the event.") }
      return EKAlarm(relativeOffset: seconds)
    }
  }

  private func color(_ calendar: EKCalendar) -> String {
    guard let cgColor = calendar.cgColor else { return "#808080" }
    var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
    guard UIColor(cgColor: cgColor).getRed(&red, green: &green, blue: &blue, alpha: &alpha) else { return "#808080" }
    return String(format: "#%02X%02X%02X", Int((red * 255).rounded()), Int((green * 255).rounded()), Int((blue * 255).rounded()))
  }

  private func presenter() -> UIViewController? {
    let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first { $0.activationState == .foregroundActive }
    var controller = scene?.keyWindow?.rootViewController
    while let presented = controller?.presentedViewController, !presented.isBeingDismissed { controller = presented }
    return controller
  }

  private func nullable<T>(_ value: T?) -> Any { value.map { $0 as Any } ?? NSNull() }
  private func finish(_ value: Any, _ completion: (Result<String, Error>) -> Void) {
    do { completion(.success(try ZoridDeviceJSON.encode(value))) } catch { completion(.failure(error)) }
  }
}
