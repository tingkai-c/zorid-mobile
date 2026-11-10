import { describe, expect, test } from 'bun:test';
import { launchDestination } from './launch';

const installed = { platform: 'ios', development: false, updatesEnabled: true, embeddedLaunch: false };

describe('launcher destination', () => {
  test('a new installation and an embedded recovery launch show setup', () => {
    expect(launchDestination({ ...installed, embeddedLaunch: true })).toBe('setup');
  });

  test('a disabled updater cannot mistake its bundled demo for a downloaded app', () => {
    expect(launchDestination({ ...installed, updatesEnabled: false })).toBe('setup');
  });

  test('a cached update opens directly without consulting pairing or network state', () => {
    expect(launchDestination(installed)).toBe('app');
  });

  test('local development and web previews can show the app without an installed update', () => {
    const embedded = { ...installed, updatesEnabled: false, embeddedLaunch: true };
    expect(launchDestination({ ...embedded, development: true })).toBe('app');
    expect(launchDestination({ ...embedded, platform: 'web' })).toBe('app');
  });
});
