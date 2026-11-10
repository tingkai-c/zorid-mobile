import { describe, expect, test } from 'bun:test';
import { changeFocus, startFocus, workedMs } from '../src/domain/focus';
describe('persistent focus clock', () => {
  test('pause and restart excludes time spent paused', () => {
    const paused = changeFocus(startFocus('a', undefined, 1000), 'pause', 61000);
    expect(workedMs(paused, 900000)).toBe(60000);
    const restored = JSON.parse(JSON.stringify(paused));
    const resumed = changeFocus(restored, 'resume', 901000);
    expect(workedMs(resumed, 961000)).toBe(120000);
    const finished = changeFocus(resumed, 'finish', 961000);
    expect(finished.intervals).toEqual([{ startedAt: 1000, endedAt: 61000 }, { startedAt: 901000, endedAt: 961000 }]);
  });
  test('background completion stops exactly at target', () => {
    const session = startFocus('a', undefined, 1000, 60000);
    const completed = changeFocus(session, 'finish', 999999);
    expect(completed.endedAt).toBe(61000);
    expect(workedMs(completed, 999999)).toBe(60000);
  });
  test('repeated actions cannot double count intervals', () => {
    const initial = startFocus('a', undefined, 1000);
    expect(changeFocus(initial, 'resume', 2000)).toEqual(initial);
    const paused = changeFocus(initial, 'pause', 5000);
    expect(changeFocus(paused, 'pause', 6000).intervals).toEqual(paused.intervals);
    const finished = changeFocus(paused, 'finish', 7000);
    expect(changeFocus(finished, 'resume', 8000)).toEqual(finished);
  });
  test('clock rollback cannot create negative work', () => {
    const session = startFocus('a', undefined, 10000);
    expect(workedMs(session, 0)).toBe(0);
    expect(changeFocus(session, 'pause', 0).intervals).toEqual([]);
  });
});
