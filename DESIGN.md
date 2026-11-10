# Design

## Source of truth
Active, 2026-11-11. No prior assets or design documents existed. User discussion defines native personal tools, app-owned navigation, hidden native settings, local operation, shared data, laptop pairing and deployment.

## Brand
Quiet, practical personal workspace. Trust comes from explicit local/connected/update state. Avoid dashboard clutter, fake metrics, and fabricated synchronization indicators.

## Product goals
A native launcher that grows through features. First proof: tasks, focus sessions, session history and native surfaces. Full Notion-like editing and desktop UI are later work. Success: create a task, track work offline, recover state after relaunch, pair with a host.

## Personas and jobs
One person using iPhone and eventually desktop. Agents build tools on their paired host. Everyday data must remain usable without that host.

## Information architecture
With no downloaded app, show native connection setup. Once loaded, launch the cached app directly, including offline starts. The downloaded app controls its routes and navigation. The demo supplies Today, Tasks, Focus and Calendar tabs. Launcher settings opens through a three-finger hold (one second) or Home Screen icon long press → Zorid Settings. These native entrances remain available independently of app JavaScript. Feature routes and local storage have stable identifiers; shared records connect tasks to sessions.

## Design principles
Native controls, readable content, explicit errors. Show saved state before decorative feedback. Small scoped components, no speculative design-system framework.

## Visual language
Warm neutral background, white cards, dark charcoal text, teal accent. System fonts and Dynamic Type. Spacing 8/12/16/24/32. Rounded cards, minimal shadows. No required animation or imagery.

## Components
Reusable screen, section/card, button, field and status styles in src/ui. Include disabled, loading and error variants. Demo-owned tab navigation and safe areas. The entire connection/settings screen is SwiftUI, owned by the installed binary. Use system grouped forms, semantic colors, Dynamic Type, labeled SF Symbols, and an explicit Done button when an app is loaded. Explicit opening through any entrance produces one soft haptic; automatic setup and repeated requests while already visible stay silent. Pairing success and failure use the corresponding notification feedback.

Page headers start with the page title and subtitle. Omit the repeated product/device label above them.

## Accessibility
Aim for WCAG AA contrast, labeled controls, 44-point minimum hit areas, scalable text. Forms remain usable with keyboard visible; status isn't conveyed by color alone. Avoid ticking screen-reader announcements. The Home Screen shortcut provides an alternative to the hidden multi-touch gesture.

## Responsive behavior
Primary iPhone portrait; scroll rather than clip on small screens and larger text. Tablet/web preview uses bounded content width. Native extension layouts adapt to widget size.

## Interaction states
Hydration must finish before edits. Empty views explain the next action. Errors retain input and offer retry. Offline is normal; local persistence is not described as synchronized. Disabled operations explain unavailable capability.

## Content voice
Short, direct and personal. Use Task, Focus session, Host, Pair, Update. Keep implementation details in diagnostics and documentation.

## Implementation constraints
React Native + Expo, Bun, generated native projects. WidgetKit/ActivityKit via expo-widgets evaluation. Signing/native builds only on GitHub macOS. Tests and export validate JS; device and screenshot checks must be reported separately.

## Open questions
- Sync engine and CRDT integration require a two-client prototype before production adoption.
- Device visual/accessibility and native-extension validation follow signed build installation.
