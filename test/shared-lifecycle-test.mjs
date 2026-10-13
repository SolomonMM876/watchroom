import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { PortableRoomClient } from '../public/portable.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function restoreGlobal(t, name, value) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  });
}

test('Leave during library loading cannot register an abandoned shared host', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const appended = deferred();
  let allocations = 0;
  restoreGlobal(t, 'Peer', undefined);
  restoreGlobal(t, 'document', {
    createElement() { return { remove() {} }; },
    head: { append(script) { appended.resolve(script); } },
  });

  const client = new PortableRoomClient();
  const entering = client.create({ roomId: 'a'.repeat(32), roomSecret: 'b'.repeat(48), shared: true });
  const rejected = assert.rejects(entering, { status: 410, message: 'This room connection was cancelled.' });
  const script = await appended.promise;
  await client.leave();

  globalThis.Peer = class {
    constructor() { allocations++; }
    on() {}
    destroy() {}
  };
  script.onload();
  // Drain the load continuation before advancing any broker timeout. This
  // also makes the regression finish promptly if a cancelled Peer is created.
  for (let index = 0; index < 10; index++) await Promise.resolve();
  t.mock.timers.tick(25_000);
  await rejected;
  assert.equal(allocations, 0);
  assert.equal(client._peer, null);
  assert.equal(client._brokerWaiters.size, 0);
});

function activeHost(shared) {
  const client = new PortableRoomClient();
  const packets = [];
  let destroyed = false;
  const connection = {
    open: true,
    peer: 'sofa-guest-test',
    bufferSize: 0,
    send(packet) { packets.push(packet); },
    close() { this.open = false; },
  };
  client.session = { role: 'host', shared };
  client._peer = { destroy() { destroyed = true; } };
  client._connection = connection;
  client._records.set(connection, { authenticated: true, timer: null, closeTimer: null });
  return { client, packets, get destroyed() { return destroyed; } };
}

test('a departing shared host releases its broker claim without a grace period', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const host = activeHost(true);
  const leaving = host.client.leave();
  try {
    assert.equal(host.destroyed, true, 'The claim must be released before a guest starts promotion');
    assert.equal(host.client._peer, null);
    assert.deepEqual(host.packets, [{ kind: 'leave', closed: false }]);
  } finally {
    t.mock.timers.tick(150);
    await leaving;
  }
});

test('an ordinary host keeps its graceful closed-room notification', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const host = activeHost(false);
  const leaving = host.client.leave();
  assert.deepEqual(host.packets, [{ kind: 'leave', closed: true }]);
  assert.equal(host.destroyed, false);
  t.mock.timers.tick(149);
  await Promise.resolve();
  assert.equal(host.destroyed, false);
  t.mock.timers.tick(1);
  await leaving;
  assert.equal(host.destroyed, true);
  assert.equal(host.client._peer, null);
});

async function pollFixture(events, operation = 'reset') {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function poll() {');
  const end = source.indexOf('\nasync function exitRoom(', start);
  assert.ok(start !== -1 && end > start, 'The app polling function is available for lifecycle checks');
  const started = deferred();
  const finish = deferred();
  const received = [];
  const timers = [];
  let saves = 0;
  const rtc = {
    async reset() {
      if (operation === 'reset') { started.resolve(); await finish.promise; }
    },
    async receiveSignal(payload) {
      received.push(payload);
      if (operation === 'receiveSignal') { started.resolve(); await finish.promise; }
    },
    async retry() {},
  };
  const state = {
    AbortController,
    polling: true,
    session: { roomId: 'reusable-room', role: 'host' },
    pollGeneration: 1,
    activePoll: null,
    portableMode: true,
    portableClient: { async poll() { return { participants: [], cursor: 42, events }; } },
    cursor: 0,
    pollFailures: 0,
    peer: { id: 'partner' },
    sharedMode: true,
    rtc,
    updateRoster() { return { changed: false, newId: 'partner' }; },
    saveSession() { saves++; },
    toast() {},
    readableError(error) { return error.message; },
    setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; },
  };
  const poll = vm.runInNewContext(`(${source.slice(start, end)})`, state);
  function replaceConnection({ changeGeneration = true, changeSession = true } = {}) {
    if (changeGeneration) state.pollGeneration++;
    if (changeSession) state.session = { roomId: 'reusable-room', role: 'host' };
    state.rtc = { async receiveSignal(payload) { received.push({ stale: payload }); }, async retry() {} };
    state.cursor = 0;
    state.activePoll = new AbortController();
  }
  return { poll, state, started, finish, received, timers, replaceConnection, get saves() { return saves; } };
}

const oldOffer = { description: { type: 'offer', sdp: 'offer-from-former-partner' } };

test('a poll paused in reset cannot signal or advance a rejoined room', async () => {
  const fixture = await pollFixture([
    { id: 41, sender: 'partner', payload: { kind: 'peer-joined' } },
    { id: 42, sender: 'partner', payload: oldOffer },
  ]);
  const pending = fixture.poll();
  await fixture.started.promise;
  fixture.replaceConnection();
  const newController = fixture.state.activePoll;
  fixture.finish.resolve();
  await pending;
  assert.deepEqual(fixture.received, []);
  assert.equal(fixture.state.cursor, 0);
  assert.equal(fixture.saves, 0);
  assert.equal(fixture.timers.length, 0);
  assert.equal(fixture.state.activePoll, newController);
});

test('a poll paused in signal handling cannot commit its stale cursor or next candidate', async () => {
  const fixture = await pollFixture([
    { id: 41, sender: 'partner', payload: oldOffer },
    { id: 42, sender: 'partner', payload: { candidate: null } },
  ], 'receiveSignal');
  const pending = fixture.poll();
  await fixture.started.promise;
  fixture.replaceConnection();
  fixture.finish.resolve();
  await pending;
  assert.deepEqual(fixture.received, [oldOffer]);
  assert.equal(fixture.state.cursor, 0);
  assert.equal(fixture.saves, 0);
  assert.equal(fixture.timers.length, 0);
});

test('replacing the RTC alone invalidates an in-flight polling batch', async () => {
  const fixture = await pollFixture([
    { id: 41, sender: 'partner', payload: { kind: 'peer-ready' } },
    { id: 42, sender: 'partner', payload: oldOffer },
  ]);
  const pending = fixture.poll();
  await fixture.started.promise;
  fixture.replaceConnection({ changeGeneration: false, changeSession: false });
  fixture.finish.resolve();
  await pending;
  assert.deepEqual(fixture.received, []);
  assert.equal(fixture.state.cursor, 0);
  assert.equal(fixture.saves, 0);
});

test('an unchanged polling connection still consumes signals and schedules its next poll', async () => {
  const fixture = await pollFixture([{ id: 42, sender: 'partner', payload: oldOffer }]);
  await fixture.poll();
  assert.deepEqual(fixture.received, [oldOffer]);
  assert.equal(fixture.state.cursor, 42);
  assert.equal(fixture.saves, 1);
  assert.equal(fixture.timers.length, 1);
  assert.equal(fixture.timers[0].delay, 1000);
  assert.equal(fixture.state.activePoll, null);
});
