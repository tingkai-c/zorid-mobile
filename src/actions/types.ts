/** Values that survive the native bridge without lossy JSON coercion. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type ActionCapability = 'records' | 'outbox' | 'surfaces';

/** Sources are bundled on the host. Hermes does not guarantee Function.toString source. */
export type ActionBundle = {
  appId: string;
  version: string;
  runtimeVersion: 1;
  capabilities: ActionCapability[];
  handlers: Record<string, string>;
};

export type ActionRequest = {
  appId: string;
  actionId: string;
  invocationId: string;
  args: JsonValue;
  bundleVersion?: string;
};

export type SurfacePublication = {
  widget?: string;
  activity?: string;
  props: { [key: string]: JsonValue };
  endActivity?: boolean;
  /** Starts an activity only when foreground execution permits it. */
  startActivity?: boolean;
  /** Optional app route associated with a newly started activity. */
  url?: string;
  staleAt?: number;
  timeline?: { date: number; props: { [key: string]: JsonValue } }[];
};
export type SurfaceEffect = SurfacePublication & { id: string; appId: string; sequence?: number };

/** Available to a synchronous action handler, independently of React and its UI state. */
export type ActionSDK = {
  readonly now: number;
  records: {
    get<T = JsonValue>(collection: string, id: string, expectedSchemaVersion?: number): T | null;
    list<T = JsonValue>(collection: string, expectedSchemaVersion?: number): T[];
    put<T>(collection: string, id: string, data: T, schemaVersion?: number): void;
    delete(collection: string, id: string, expectedSchemaVersion?: number): void;
  };
  outbox: { enqueue(type: string, payload: JsonValue): string };
  surfaces: { publish(effect: SurfacePublication): void };
};

export type ActionResult<T = JsonValue> = {
  invocationId: string;
  duplicate: boolean;
  result: T;
  effects: SurfaceEffect[];
  /** Records are committed even when a separate surface refresh needs retrying. */
  surfaceError?: string;
};

export type OutboxEntry = {
  id: string;
  appId: string;
  type: string;
  payload: JsonValue;
  createdAt: number;
};

export interface NativeActions {
  prepareDatabase(legacyDirectory: string | null): Promise<string>;
  installBundle(bundleJSON: string): Promise<void>;
  dispatch(requestJSON: string): Promise<string>;
  pendingEffects(appId: string): Promise<string>;
  acknowledgeEffects(ids: string[]): Promise<void>;
  readOutbox(appId: string): Promise<string>;
  acknowledgeOutbox(appId: string, ids: string[]): Promise<void>;
}
export interface NativeActionSurfaces {
  flushZoridActionEffects(appId: string): Promise<number>;
}
