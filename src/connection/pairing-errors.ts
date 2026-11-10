const messages = {
  expired: 'This pairing code has expired or was already used. Generate a fresh code on your host.',
  network: 'Could not reach your host. Check that Tailscale is connected on both devices, then try again.',
  timeout: 'The host did not respond in time. Check Tailscale, then try again.',
  rejected: 'The host rejected this pairing request. Generate a fresh code and try again.',
  response: 'The host returned an invalid pairing response. Check your host configuration.',
  storage: 'The host accepted pairing, but this phone could not save the connection securely. Generate a fresh code and try again.',
  updater: 'Your connection was saved, but this app could not enable updates. Install the corrected app build; your saved connection will be restored.',
} as const;

export type PairingFailure = keyof typeof messages;

// Only these fixed messages may leave the pairing boundary. Native exceptions can contain credentials.
export class PairingError extends Error {
  constructor(readonly stage: PairingFailure) {
    super(messages[stage]);
    this.name = 'PairingError';
  }
}

export async function pairingStep<T>(stage: PairingFailure, action: () => T | Promise<T>): Promise<T> {
  try { return await action(); }
  catch { throw new PairingError(stage); }
}
