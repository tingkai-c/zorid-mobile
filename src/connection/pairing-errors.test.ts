import { describe, expect, test } from 'bun:test';
import { PairingError, pairingStep, type PairingFailure } from './pairing-errors';

describe('safe pairing failures', () => {
  test('never exposes sensitive native or server exception messages', async () => {
    const secret = 'Bearer private-device-token';
    const stages: PairingFailure[] = ['network', 'timeout', 'response', 'storage', 'updater'];
    for (const stage of stages) {
      let failure: unknown;
      try { await pairingStep(stage, () => { throw new Error(`Native request rejected: ${secret}`); }); }
      catch (reason) { failure = reason; }
      expect(failure).toBeInstanceOf(PairingError);
      expect((failure as PairingError).stage).toBe(stage);
      expect((failure as Error).message).not.toContain(secret);
      expect((failure as Error).cause).toBeUndefined();
    }
  });

  test('distinguishes an expired offer from network, storage and native setup failures', () => {
    expect(new PairingError('expired').message).toContain('expired or was already used');
    expect(new PairingError('timeout').message).toContain('did not respond in time');
    expect(new PairingError('network').message).toContain('Could not reach your host');
    expect(new PairingError('storage').message).toContain('could not save the connection securely');
    expect(new PairingError('updater').message).toContain('Your connection was saved');
    expect(new PairingError('updater').message).toContain('Install the corrected app build');
  });
});
