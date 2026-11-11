import type { ActionBundle, ActionCapability, ActionRequest, JsonValue } from './types';

export const ACTION_TARGET_PREFIX = 'zorid-action:';
/** Explicit opt-in for actions that manage an existing Live Activity. */
export const ACTIVITY_ACTION_TARGET_PREFIX = 'zorid-activity-action:';
export const ACTION_RUNTIME_VERSION = 1;
const MAX_REQUEST_BYTES = 64 * 1024;
// App Intent target transport is deliberately smaller than direct app dispatch.
const MAX_TARGET_CHARACTERS = 32 * 1024;
const MAX_BUNDLE_BYTES = 512 * 1024;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CAPABILITIES: ActionCapability[] = ['records', 'outbox', 'surfaces'];
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

// JavaScriptCore action contexts have no TextEncoder, Buffer or browser globals.
function utf8Encode(value: string): number[] {
  let escaped: string;
  try { escaped = encodeURIComponent(value); }
  catch { throw new Error('Action strings must contain valid Unicode.'); }
  const bytes: number[] = [];
  for (let index = 0; index < escaped.length; index++) {
    if (escaped[index] === '%') {
      bytes.push(parseInt(escaped.slice(index + 1, index + 3), 16)); index += 2;
    } else bytes.push(escaped.charCodeAt(index));
  }
  return bytes;
}
function utf8Decode(bytes: number[]): string {
  return decodeURIComponent(bytes.map(byte => `%${byte.toString(16).padStart(2, '0')}`).join(''));
}

export function validateIdentifier(value: unknown, label: string, maxLength = 64): asserts value is string {
  if (typeof value !== 'string' || value.length > maxLength || !IDENTIFIER.test(value)) {
    throw new Error(`${label} must be a nonempty identifier of at most ${maxLength} characters.`);
  }
}
function object(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`${label} must be a plain object.`);
}
function version(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128) throw new Error('Bundle version must contain 1–128 characters.');
}

/** Reject values JSON.stringify would silently drop, replace, or reinterpret. */
function assertJSON(value: unknown, seen = new Set<object>(), depth = 0): asserts value is JsonValue {
  if (depth > 64) throw new Error('Action JSON is too deeply nested.');
  if (typeof value === 'string') { utf8Encode(value); return; }
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || !value) throw new Error('Actions require finite, serializable JSON values.');
  if (seen.has(value)) throw new Error('Action JSON cannot contain cycles.');
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) assertJSON(value[index], seen, depth + 1);
  } else {
    object(value, 'Action JSON');
    if (Object.getOwnPropertySymbols(value).length) throw new Error('Action JSON cannot contain symbol keys.');
    for (const entry of Object.values(value)) assertJSON(entry, seen, depth + 1);
  }
  seen.delete(value);
}
function json(value: unknown, limit: number): string {
  assertJSON(value);
  const serialized = JSON.stringify(value);
  if (utf8Encode(serialized).length > limit) throw new Error('Action payload exceeds the supported byte limit.');
  return serialized;
}

export function serializeActionRequest(value: ActionRequest): string {
  object(value, 'Action request');
  validateIdentifier(value.appId, 'App ID');
  validateIdentifier(value.actionId, 'Action ID');
  validateIdentifier(value.invocationId, 'Invocation ID', 128);
  if (value.bundleVersion !== undefined) version(value.bundleVersion);
  // Reconstruct optional fields so a caller can explicitly pass bundleVersion: undefined.
  return json({ appId: value.appId, actionId: value.actionId, invocationId: value.invocationId,
    args: value.args, ...(value.bundleVersion === undefined ? {} : { bundleVersion: value.bundleVersion }) }, MAX_REQUEST_BYTES);
}

export function serializeActionBundle(value: ActionBundle): string {
  object(value, 'Action bundle');
  validateIdentifier(value.appId, 'App ID');
  version(value.version);
  if (value.runtimeVersion !== ACTION_RUNTIME_VERSION) throw new Error('Unsupported action runtime version. Update the installed Zorid binary.');
  if (!Array.isArray(value.capabilities) || value.capabilities.some(item => !CAPABILITIES.includes(item))
    || new Set(value.capabilities).size !== value.capabilities.length) throw new Error('Unsupported or duplicate action capability.');
  object(value.handlers, 'Action handlers');
  const entries = Object.entries(value.handlers);
  if (!entries.length || entries.length > 64) throw new Error('An action bundle must contain 1–64 handlers.');
  for (const [id, source] of entries) {
    validateIdentifier(id, 'Action ID');
    if (typeof source !== 'string' || !source.trim() || utf8Encode(source).length > 128 * 1024) {
      throw new Error('Each action handler must contain at most 128 KiB of bundled JavaScript source.');
    }
  }
  return json(value, MAX_BUNDLE_BYTES);
}

/** Stable invocation IDs deduplicate the same rendered button; refresh after state changes. */
export function encodeActionTarget(request: ActionRequest, options: { execution?: 'background' | 'activity' } = {}): string {
  const bytes = utf8Encode(serializeActionRequest(request));
  if (Math.ceil(bytes.length * 4 / 3) > MAX_TARGET_CHARACTERS) throw new Error('Widget action target exceeds the supported byte limit.');
  let encoded = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index], b = bytes[index + 1], c = bytes[index + 2];
    encoded += BASE64[a >> 2] + BASE64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    if (b !== undefined) encoded += BASE64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    if (c !== undefined) encoded += BASE64[c & 63];
  }
  return (options.execution === 'activity' ? ACTIVITY_ACTION_TARGET_PREFIX : ACTION_TARGET_PREFIX) + encoded;
}

export function decodeActionTarget(target: string): ActionRequest {
  const prefix = target.startsWith(ACTIVITY_ACTION_TARGET_PREFIX) ? ACTIVITY_ACTION_TARGET_PREFIX : ACTION_TARGET_PREFIX;
  if (!target.startsWith(prefix)) throw new Error('Unsupported action target.');
  const encoded = target.slice(prefix.length);
  if (!encoded.length || encoded.length > MAX_TARGET_CHARACTERS
    || encoded.length % 4 === 1 || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('Malformed action target.');
  const bytes: number[] = [];
  let buffer = 0, bits = 0;
  for (const character of encoded) {
    buffer = (buffer << 6) | BASE64.indexOf(character);
    bits += 6;
    if (bits >= 8) { bits -= 8; bytes.push((buffer >> bits) & 255); }
  }
  if (bits && (buffer & ((1 << bits) - 1))) throw new Error('Malformed action target.');
  let request: ActionRequest;
  try {
    request = JSON.parse(utf8Decode(bytes)) as ActionRequest;
  } catch { throw new Error('Malformed action target JSON.'); }
  serializeActionRequest(request);
  return request;
}
