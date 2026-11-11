import { expect, test } from 'bun:test';
import { deliverAppRoutes, type AppRouteHandler } from './routes-delivery';
import type { AppRoute } from './routes';

const route: AppRoute = { id: 'route-1', appId: 'productivity', path: ['focus'], query: {},
  url: 'zorid://apps/productivity/focus', source: 'quickAction', receivedAt: 123 };

test('routes wait for the matching downloaded app and await navigation before acknowledgment', async () => {
  const order: string[] = [];
  const handlers = new Map<string, AppRouteHandler>();
  const delivered = new Set<string>();
  const acknowledge = async (id: string) => { order.push(`ack:${id}`); };
  await deliverAppRoutes([route], handlers, acknowledge, delivered);
  expect(order).toEqual([]);
  handlers.set('other', { handle() { order.push('wrong-app'); } });
  await deliverAppRoutes([route], handlers, acknowledge, delivered);
  expect(order).toEqual([]);
  handlers.set('productivity', { async handle() { await Promise.resolve(); order.push('navigate'); } });
  await deliverAppRoutes([route], handlers, acknowledge, delivered);
  expect(order).toEqual(['navigate', 'ack:route-1']);
});

test('acknowledgment failure retries without repeating completed navigation', async () => {
  let navigations = 0;
  let acknowledgments = 0;
  const errors: unknown[] = [];
  const handlers = new Map<string, AppRouteHandler>([['productivity', {
    handle() { navigations++; }, onError(error) { errors.push(error); },
  }]]);
  const delivered = new Set<string>();
  const acknowledge = async () => { if (++acknowledgments === 1) throw new Error('bridge temporarily unavailable'); };
  await deliverAppRoutes([route], handlers, acknowledge, delivered);
  expect(navigations).toBe(1);
  expect(errors).toHaveLength(1);
  await deliverAppRoutes([route], handlers, acknowledge, delivered);
  expect(navigations).toBe(1);
  expect(acknowledgments).toBe(2);
  await deliverAppRoutes([], handlers, acknowledge, delivered);
  expect(delivered.size).toBe(0);
});

test('failed navigation remains unacknowledged and can succeed on a later retry', async () => {
  let attempts = 0;
  let acknowledged = false;
  const handlers = new Map<string, AppRouteHandler>([['productivity', {
    handle() { if (++attempts === 1) throw new Error('navigation not ready'); },
  }]]);
  const delivered = new Set<string>();
  await deliverAppRoutes([route], handlers, async () => { acknowledged = true; }, delivered);
  expect(acknowledged).toBe(false);
  expect(delivered.size).toBe(0);
  await deliverAppRoutes([route], handlers, async () => { acknowledged = true; }, delivered);
  expect(acknowledged).toBe(true);
  expect(attempts).toBe(2);
});
