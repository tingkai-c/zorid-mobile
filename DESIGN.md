# Design

## Source of truth
Active, 2026-11-11. No prior assets or design documents existed. User discussion defines native personal tools, app-owned navigation, hidden native settings, local operation, shared data, laptop pairing and deployment.

## Brand
Quiet, practical personal workspace. Trust comes from explicit local/connected/update state. Avoid dashboard clutter, fake metrics, and fabricated synchronization indicators.

## Product goals
A native launcher that grows through features. First proof: tasks, focus sessions, session history and native surfaces. Full Notion-like editing and desktop UI are later work. Success: create a task, track work offline, recover state after relaunch, pair with a host.

Prioritize a growing personal productivity app and reusable native capabilities. Keep direct JavaScript deployment for iteration; defer independent app distribution and additional platform management.

## Personas and jobs
One person using iPhone and eventually desktop. Agents build tools on their paired host. Everyday data must remain usable without that host.

## Information architecture
With no downloaded app, open Zorid Settings for initial pairing. Once loaded, launch the cached app directly, including offline starts. The downloaded app controls its routes and navigation. The demo supplies Today, Tasks, Focus and Calendar tabs. Open Zorid Settings with a one-second three-finger hold, a shake, or the Zorid Settings quick action on the Home Screen. These entrances are part of the installed binary. Feature routes and local storage have stable identifiers. Shared records connect tasks to sessions.

## Design principles
Native controls, readable content, explicit errors. Show saved state before decorative feedback. Small scoped components, no speculative design-system framework.

## Visual language
Warm neutral background, white cards, dark charcoal text, teal accent. System fonts and Dynamic Type. Spacing 8/12/16/24/32. Rounded cards, minimal shadows. No required animation or imagery.

## Components
Reusable screen, section/card, button, field and status styles in src/ui. Include disabled, loading and error variants. Demo-owned tab navigation and safe areas. Zorid Settings uses a SwiftUI grouped form inside a tall iOS bottom sheet with system transitions. Use semantic colors, Dynamic Type and labeled SF Symbols. When an app is loaded, show the grabber and let the user swipe down or tap Done. Each explicit opening produces one soft haptic. Automatic setup and repeated requests while already visible stay silent. Pairing success and failure use the corresponding notification feedback.

Page headers start with the page title and subtitle. Omit the repeated product/device label above them.

## Accessibility
Aim for WCAG AA contrast, labeled controls, 44-point minimum hit areas, scalable text. Forms remain usable with keyboard visible; status isn't conveyed by color alone. Avoid ticking screen-reader announcements. The Home Screen shortcut provides an alternative to the hidden multi-touch gesture.

## Responsive behavior
Primary iPhone portrait; scroll rather than clip on small screens and larger text. Tablet/web preview uses bounded content width. Native extension layouts adapt to widget size.

Live Activity banners pair warm neutral/light or deep green/dark backgrounds with matching high-contrast text. Keep task/status beside a bounded timer and controls below. Dynamic Island uses its system black background, light text, a mint timer symbol and separate compact/expanded timer sizes. Compact countdowns must have a fixed width; avoid reusing a large banner timer in narrow Island regions. Finished and stale sessions become a distinct completion card: a checkmark, “Focus complete,” task title, actual focused duration, and a quiet recharge message. Completion replaces countdowns and controls in every region; compact Island shows a checkmark and a bounded “Done” label. Validate the actual serialized Expo layout and retain physical-device visual acceptance as a separate check.

## Interaction states

Focus protection lives on the Focus page. Request Screen Time access only when the person chooses it. Present Apple's native app picker for a blocklist or allowlist; show selection counts and actual native protection state. Save app selections on the device. Pause and finish release protection. Keep a visible Turn off app blocking action and explain any failed release or emergency policy reset. Do not display an enabled preference as proof that restrictions are currently active.
Hydration must finish before edits. Empty views explain the next action. Errors retain input and offer retry. Offline is normal; local persistence is not described as synchronized. Disabled operations explain unavailable capability.

## Content voice
Short, direct and personal. Use Task, Focus session, Host, Pair, Update. Keep implementation details in diagnostics and documentation.

## Implementation constraints
React Native + Expo, Bun, generated native projects. WidgetKit/ActivityKit via expo-widgets evaluation. Signing/native builds only on GitHub macOS. Tests and export validate JS; device and screenshot checks must be reported separately.

## Open questions
- Sync engine and CRDT integration require a two-client prototype before production adoption.
- Device visual/accessibility and native-extension validation follow signed build installation.
