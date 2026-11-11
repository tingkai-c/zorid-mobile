import { expect, test } from 'bun:test';
import { appURL, decodeRouteQueue, parseAppRoute, validateQuickActions } from './routes';

test('downloaded app routes preserve encoded segments and query values', () => {
  const url = appURL('productivity', ['notes', 'my note'], { view: 'board', filter: 'a+b c' });
  expect(parseAppRoute(url)).toEqual({ appId: 'productivity', path: ['notes', 'my note'], query: { view: 'board', filter: 'a+b c' }, url });
  expect(parseAppRoute('zorid://apps/productivity')).toMatchObject({ appId: 'productivity', path: [], query: {} });
});

test('routes reject ambiguous traversal, injected authorities and malformed data', () => {
  for (const url of [
    'https://apps/productivity/focus', 'zorid://focus', 'zorid://pair?token=x',
    'zorid://user@apps/productivity/focus', 'zorid://apps:99/productivity/focus',
    'zorid://apps/productivity/../other', 'zorid://apps/productivity/%2E%2E/other',
    'zorid://apps/productivity/a%2fb', 'zorid://apps/productivity/a%5cb',
    'zorid://apps/productivity//focus', 'zorid://apps/productivity/%',
    'zorid://apps/productivity/%GG', 'zorid://apps/productivity/%FF',
    'zorid://apps/productivity/focus?a=1&a=2', 'zorid://apps/productivity/focus?=x',
    'zorid://apps/productivity/focus?a=%00', 'zorid://apps/productivity/focus#action',
    'zorid://apps/productivity/focus#', 'zorid://@apps/productivity/focus',
    'zorid://apps/productivity/focus?a=tab\t',
    'zorid://apps/Uppercase/focus', `zorid://apps/productivity/${'x'.repeat(257)}`,
  ]) expect(parseAppRoute(url)).toBeNull();
  expect(() => appURL('../bad')).toThrow('Invalid app ID');
  expect(() => appURL('productivity', ['../bad'])).toThrow('Invalid app route');
});

test('query keys cannot mutate the query prototype', () => {
  const route = parseAppRoute('zorid://apps/notes/record?__proto__=value');
  expect(Object.getPrototypeOf(route?.query)).toBe(Object.prototype);
  expect(Object.hasOwn(route!.query, '__proto__')).toBe(true);
  expect(route!.query.__proto__).toBe('value');
});

test('quick actions reserve settings and scope destinations to their app', () => {
  const action = { id: 'focus', title: 'Open Focus', systemImage: 'timer', url: appURL('productivity', ['focus']) };
  expect(validateQuickActions('productivity', [action])).toEqual([action]);
  expect(validateQuickActions('productivity', [])).toEqual([]);
  for (const items of [
    [action, action], [{ ...action, id: 'settings' }], [{ ...action, title: '   ' }],
    [{ ...action, title: 'x\n' }], [{ ...action, systemImage: '../icon' }],
    [{ ...action, url: appURL('other', ['focus']) }],
    ['one', 'two', 'three', 'four'].map(id => ({ ...action, id })),
  ]) expect(() => validateQuickActions('productivity', items)).toThrow();
});

test('native envelopes are parsed from the validated URL rather than untrusted extra fields', () => {
  const native = { id: 'invocation-1', source: 'quickAction', receivedAt: 123,
    url: appURL('productivity', ['focus']), appId: 'forged', path: ['forged'] };
  expect(decodeRouteQueue(JSON.stringify([native]))).toEqual([{ id: 'invocation-1', source: 'quickAction', receivedAt: 123,
    appId: 'productivity', path: ['focus'], query: {}, url: native.url }]);
  expect(() => decodeRouteQueue('{}')).toThrow('Invalid route queue');
  expect(() => decodeRouteQueue(JSON.stringify([{ ...native, source: 'trusted' }]))).toThrow('Invalid route');
  expect(() => decodeRouteQueue(JSON.stringify([{ ...native, id: '' }]))).toThrow('Invalid route');
});
