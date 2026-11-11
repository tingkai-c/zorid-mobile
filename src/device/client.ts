/** Installed APIs, not permission grants or proof that hardware is available. */
export type DeviceCapabilities = {
  available: true; version: 1; platform: 'ios'; features: Record<string, boolean>;
  requestBytes: number; responseBytes: number;
} | {
  available: false; version: null; platform: null; features: Record<string, boolean>;
  requestBytes: 0; responseBytes: 0; reason: string;
};
export interface NativeDevice {
  capabilities(): Promise<string>;
  call(domain: string, operation: string, json: string): Promise<string>;
}
export type DeviceJSON = null | boolean | number | string | DeviceJSON[] | { [key: string]: DeviceJSON };
export type AuthenticationStatus = {
  available: true; biometry: 'none' | 'touchID' | 'faceID' | 'opticID' | 'unknown';
  biometric: { available: boolean; reason: string | null };
  deviceOwner: { available: boolean; reason: string | null };
};
export type AuthenticationOptions = {
  policy: 'biometric' | 'deviceOwner'; reason: string; cancelTitle?: string;
  fallbackTitle?: string; reuseDuration?: number;
};
export type NotificationStatus = {
  authorization: 'notDetermined' | 'denied' | 'authorized' | 'provisional' | 'ephemeral' | 'unknown';
  alert: boolean; sound: boolean; badge: boolean; lockScreen: boolean; notificationCenter: boolean;
};
export type NotificationCategory = {
  id: string; actions: {
    id: string; title: string; options?: ('foreground' | 'destructive' | 'authenticationRequired')[];
    textInput?: { buttonTitle: string; placeholder?: string };
  }[];
};
export type NotificationTrigger = { type: 'date'; at: number }
  | { type: 'delay'; seconds: number; repeats?: boolean }
  | { type: 'calendar'; components: { year?: number; month?: number; day?: number; weekday?: number; hour?: number; minute?: number; second?: number }; repeats?: boolean };
export type NotificationInput = {
  appId: string; id: string; title?: string; subtitle?: string; body?: string;
  sound?: 'default' | null; badge?: number | null; categoryId?: string;
  data?: { [key: string]: DeviceJSON }; trigger: NotificationTrigger;
};
export type DeviceNotification = {
  id: string; title: string; subtitle: string; body: string; categoryId: string;
  data: { [key: string]: DeviceJSON }; deliveredAt?: number; nextTriggerAt?: number;
};
export type NotificationResponse = {
  id: string; notificationId: string; actionId: string; text?: string; textTruncated?: true;
  data: { [key: string]: DeviceJSON }; receivedAt: number;
};
export type PhotosStatus = { addOnly: 'notDetermined' | 'restricted' | 'denied' | 'authorized' | 'limited' | 'unknown' };
export type PickedPhoto = {
  uri: string; fileName: string; typeIdentifier: string; mimeType: string | null;
  bytes: number; kind: 'image' | 'video';
};
export type CalendarEntity = 'events' | 'reminders';
export type CalendarStatus = {
  events: 'notDetermined' | 'restricted' | 'denied' | 'full' | 'writeOnly' | 'unknown';
  reminders: 'notDetermined' | 'restricted' | 'denied' | 'full' | 'unknown';
  permissionFreeEditor: boolean;
};
export type DeviceCalendar = { id: string; title: string; color: string; allowsModifications: boolean; isDefault: boolean };
export type CalendarEventInput = {
  id?: string; calendarId?: string; title: string; start: number; end: number; allDay?: boolean;
  timeZone?: string | null; notes?: string | null; location?: string | null; url?: string | null;
  /** Numbers are seconds relative to start; absoluteAt uses epoch milliseconds. */
  alarms?: (number | { absoluteAt: number })[];
};
export type CalendarEvent = Required<Omit<CalendarEventInput, 'timeZone' | 'notes' | 'location' | 'url'>> & {
  timeZone: string | null; notes: string | null; location: string | null; url: string | null;
  hasRecurrenceRules: boolean;
};
export type ReminderInput = {
  id?: string; calendarId?: string; title: string; notes?: string | null; url?: string | null;
  dueAt?: number | null; startAt?: number | null;
  /** Omit time components for a calendar-date reminder; supply its corresponding timestamp. */
  dueDateOnly?: boolean; startDateOnly?: boolean;
  priority?: number; completed?: boolean;
};
export type DeviceReminder = Required<ReminderInput> & { completedAt: number | null };

const transportBytes = 8 * 1024 * 1024;
const unavailableMessage = 'Install a Zorid iPhone build with the device bridge (runtime zorid-5) to use this API.';
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function byteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length
      && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) { bytes += 4; index++; }
    else bytes += 3;
    if (bytes > transportBytes) break;
  }
  return bytes;
}
/** Reject values JSON would silently drop, invoke, coerce or change. */
function snapshotJSON(value: unknown, ancestors = new Set<object>(), depth = 0, budget = { nodes: 0 }): DeviceJSON {
  if (++budget.nodes > 100_000 || depth > 32) throw new Error('Device arguments exceed the JSON nesting or item limit.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw new Error('Device arguments require finite, lossless JSON numbers.');
    }
    return value;
  }
  if (typeof value !== 'object' || !value || ancestors.has(value)) throw new Error('Device arguments must be acyclic JSON values.');
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Device arguments require plain JSON objects.');
  if (Object.getOwnPropertySymbols(value).length) throw new Error('Device arguments cannot contain symbol properties.');
  ancestors.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const array = Array.isArray(value);
  if (array && Object.getPrototypeOf(value) !== Array.prototype) throw new Error('Device arrays require the standard array prototype.');
  const copy: DeviceJSON[] | { [key: string]: DeviceJSON } = array ? [] : Object.create(null);
  if (array && Object.keys(descriptors).length !== value.length + 1) throw new Error('Device arrays must be dense and cannot have extra properties.');
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (array && key === 'length') continue;
    if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) throw new Error('Device arrays cannot have extra properties.');
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error('Device arguments cannot contain getters or hidden properties.');
    const item = snapshotJSON(descriptor.value, ancestors, depth + 1, budget);
    if (array) (copy as DeviceJSON[]).push(item);
    else (copy as { [key: string]: DeviceJSON })[key] = item;
  }
  ancestors.delete(value);
  return copy;
}
function encode(value: unknown): string {
  if (!record(value)) throw new Error('Device operation arguments must be a JSON object.');
  const json = JSON.stringify(snapshotJSON(value));
  if (byteLength(json) > transportBytes) throw new Error('Device arguments exceed the 8 MiB transport limit.');
  return json;
}
function decode(json: unknown, nullable = false): unknown {
  if (typeof json !== 'string' || byteLength(json) > transportBytes) throw new Error('Invalid or oversized native device response.');
  let value: unknown;
  try { value = JSON.parse(json); snapshotJSON(value); }
  catch { throw new Error('Invalid native device JSON response.'); }
  if (!(nullable && value === null) && !record(value)) throw new Error('Invalid native device response object.');
  return value;
}

export function createDeviceClient(native: NativeDevice | null) {
  const available = typeof native?.capabilities === 'function' && typeof native.call === 'function';
  async function invoke<T>(domain: string, operation: string, args: unknown = {}, nullable = false): Promise<T> {
    if (!available || !native) throw new Error(unavailableMessage);
    // Capture synchronously, before any asynchronous native work can observe a mutated input.
    const json = encode(args);
    return decode(await native.call(domain, operation, json), nullable) as T;
  }
  return {
    available,
    async capabilities(): Promise<DeviceCapabilities> {
      if (!available || !native) return { available: false, version: null, platform: null, features: {}, requestBytes: 0, responseBytes: 0, reason: unavailableMessage };
      const value = decode(await native.capabilities()) as Record<string, unknown>;
      if (value.available !== true || value.version !== 1 || value.platform !== 'ios' || !record(value.features)
        || ['authentication', 'notifications', 'clipboard', 'photosPicker', 'photosAdd', 'calendar', 'reminders'].some(key => typeof (value.features as Record<string, unknown>)[key] !== 'boolean')
        || Object.values(value.features).some(feature => typeof feature !== 'boolean')
        || value.requestBytes !== transportBytes || value.responseBytes !== transportBytes) throw new Error('Unsupported or invalid native device capabilities.');
      return { available: true, version: 1, platform: 'ios', features: { ...value.features } as Record<string, boolean>, requestBytes: transportBytes, responseBytes: transportBytes };
    },
    authentication: {
      status: () => invoke<AuthenticationStatus>('authentication', 'status'),
      cancel: () => invoke<{ cancelled: true }>('authentication', 'cancel'),
      authenticate: (options: AuthenticationOptions) => invoke<{ success: boolean; reason: string | null }>('authentication', 'authenticate', options),
    },
    notifications: {
      status: () => invoke<NotificationStatus>('notifications', 'status'),
      request: (options: { alert?: boolean; sound?: boolean; badge?: boolean; provisional?: boolean } = {}) => invoke<NotificationStatus & { granted: boolean }>('notifications', 'request', options),
      categories: (options: { appId: string; categories: NotificationCategory[] }) => invoke<{ registered: true }>('notifications', 'categories', options),
      schedule: (options: NotificationInput) => invoke<{ id: string }>('notifications', 'schedule', options),
      pending: (appId: string) => invoke<{ notifications: DeviceNotification[] }>('notifications', 'pending', { appId }),
      delivered: (appId: string) => invoke<{ notifications: DeviceNotification[] }>('notifications', 'delivered', { appId }),
      cancel: (appId: string, ids?: string[]) => invoke<{ removed: true }>('notifications', 'cancel', { appId, ...(ids === undefined ? {} : { ids }) }),
      removeDelivered: (appId: string, ids?: string[]) => invoke<{ removed: true }>('notifications', 'removeDelivered', { appId, ...(ids === undefined ? {} : { ids }) }),
      responses: (appId: string) => invoke<{ responses: NotificationResponse[]; persistenceError: boolean; overflowed: boolean }>('notifications', 'responses', { appId }),
      acknowledge: (appId: string, ids: string[]) => invoke<{ acknowledged: true }>('notifications', 'acknowledge', { appId, ids }),
    },
    media: {
      clipboardStatus: () => invoke<{ hasStrings: boolean; hasURLs: boolean; changeCount: number }>('media', 'clipboardStatus'),
      clipboardGet: () => invoke<{ text: string | null; url: string | null }>('media', 'clipboardGet'),
      clipboardSet: (options: { text?: string; url?: string; localOnly?: boolean; expiresAt?: number }) => invoke<{ saved: true }>('media', 'clipboardSet', options),
      photosStatus: () => invoke<PhotosStatus>('media', 'photosStatus'),
      photosRequestAdd: () => invoke<PhotosStatus>('media', 'photosRequestAdd'),
      photosPick: (options: { selectionLimit?: number; filter?: 'images' | 'videos' | 'imagesAndVideos'; ordered?: boolean } = {}) => invoke<{ cancelled: boolean; assets: PickedPhoto[] }>('media', 'photosPick', options),
      photosSave: (options: { uri: string; kind: 'image' | 'video' }) => invoke<{ saved: true; localIdentifier: string | null }>('media', 'photosSave', options),
    },
    calendar: {
      status: () => invoke<CalendarStatus>('calendar', 'status'),
      request: (options: { entity: CalendarEntity; access?: 'writeOnly' | 'full' }) => invoke<CalendarStatus>('calendar', 'request', options),
      calendars: (entity: CalendarEntity) => invoke<{ calendars: DeviceCalendar[] }>('calendar', 'calendars', { entity }),
      events: (options: { start: number; end: number; calendarIds?: string[]; limit?: number }) => invoke<{ events: CalendarEvent[]; truncated: boolean }>('calendar', 'events', options),
      event: (id: string) => invoke<CalendarEvent | null>('calendar', 'event', { id }, true),
      saveEvent: (options: { event: CalendarEventInput; span?: 'thisEvent' | 'futureEvents' }) => invoke<{ saved: true; id: string | null; event: CalendarEvent | null }>('calendar', 'saveEvent', options),
      removeEvent: (id: string, span?: 'thisEvent' | 'futureEvents') => invoke<{ removed: true }>('calendar', 'removeEvent', { id, ...(span === undefined ? {} : { span }) }),
      editEvent: (event?: Partial<CalendarEventInput>) => invoke<{ action: 'saved' | 'deleted' | 'canceled'; id: string | null }>('calendar', 'editEvent', event === undefined ? {} : { event }),
      reminders: (options: { calendarIds: string[]; completed?: boolean; limit?: number }) => invoke<{ reminders: DeviceReminder[]; truncated: boolean }>('calendar', 'reminders', options),
      reminder: (id: string) => invoke<DeviceReminder | null>('calendar', 'reminder', { id }, true),
      saveReminder: (reminder: ReminderInput) => invoke<DeviceReminder>('calendar', 'saveReminder', { reminder }),
      setReminderCompleted: (id: string, completed: boolean) => invoke<DeviceReminder>('calendar', 'setReminderCompleted', { id, completed }),
      removeReminder: (id: string) => invoke<{ removed: true }>('calendar', 'removeReminder', { id }),
    },
  };
}
