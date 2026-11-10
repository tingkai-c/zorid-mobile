import { describe, expect, test } from 'bun:test';
import { focusTimeline, presentFocus } from './focus';

describe('focus surface presentation', () => {
  test('schedules an end state without needing a foreground JavaScript timer', () => {
    const props = presentFocus({ taskTitle: 'Write', status: 'running', endsAt: 61_000 }, 1_000);
    const timeline = focusTimeline(props, 1_000);
    expect(timeline.map((entry) => entry.date.getTime())).toEqual([1_000, 61_000]);
    expect(timeline[1].props.status).toBe('completed');
    expect(timeline[1].props.elapsedLabel).toBe('1:00');
    expect(props.startsAt).toBe(1_000);
  });
  test('does not revive an expired session after process restart', () => {
    const props = presentFocus({ taskTitle: 'Write', status: 'running', endsAt: 1_000 }, 2_000);
    expect(props.status).toBe('completed');
    expect(focusTimeline(props, 2_000)).toHaveLength(1);
  });
  test('paused sessions do not schedule completion', () => {
    const props = presentFocus({ taskTitle: 'Write', status: 'paused', endsAt: 61_000, elapsedSeconds: 125 }, 1_000);
    expect(focusTimeline(props, 1_000)).toHaveLength(1);
    expect(props.elapsedLabel).toBe('2:05');
  });
  test('normalizes absent and invalid input before crossing native boundary', () => {
    const props = presentFocus({ taskTitle: '   ', status: 'running', endsAt: Number.NaN, elapsedSeconds: Infinity }, 1_000);
    expect(props.taskTitle).toBe('Choose a task');
    expect(props.status).toBe('completed');
    expect(props.elapsedLabel).toBe('0:00');
  });
});
