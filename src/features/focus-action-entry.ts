import { focusActionHandler } from './focus-action-handler';

(globalThis as unknown as { __zoridFocusAction: typeof focusActionHandler }).__zoridFocusAction = focusActionHandler;
