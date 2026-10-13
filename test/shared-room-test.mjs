import assert from 'node:assert/strict';
import test from 'node:test';
import { joinSharedRoom } from '../public/shared-room.js';

const roomId = 'a'.repeat(32);
const roomSecret = 'b'.repeat(48);
const base = { roomId, roomSecret, name: 'Sol', iceServers: [{ urls: 'stun:example.test' }] };
const error = (type, status = 503) => Object.assign(new Error(type), { type, status });

function scripted(steps) {
  const clients = [];
  function createClient() {
    const step = steps.shift();
    assert.ok(step, 'Unexpected extra room client');
    const client = {
      calls: [],
      leaves: 0,
      async create(options) { return run('create', options); },
      async join(options) { return run('join', options); },
      async leave() { client.leaves++; if (step.leaveError) throw step.leaveError; },
    };
    async function run(action, options) {
      client.calls.push({ action, options });
      assert.equal(action, step.action);
      if (step.run) return step.run(options);
      if (step.error) throw step.error;
      return step.data;
    }
    clients.push(client);
    return client;
  }
  return { clients, createClient };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('a vacant shared room elects its first entrant as host', async () => {
  const data = { roomId, role: 'host' };
  const factory = scripted([{ action: 'create', data }]);
  const result = await joinSharedRoom({ ...base, createClient: factory.createClient });
  assert.equal(result.data, data);
  assert.equal(result.client, factory.clients[0]);
  assert.equal(result.client.leaves, 0);
  assert.deepEqual(result.client.calls[0], { action: 'create', options: { ...base, shared: true } });
});

test('an occupied ID disposes the failed claim and joins with a fresh client', async () => {
  const data = { roomId, role: 'guest' };
  const factory = scripted([{ action: 'create', error: error('unavailable-id', 409) }, { action: 'join', data }]);
  const result = await joinSharedRoom({ ...base, createClient: factory.createClient });
  assert.equal(result.client, factory.clients[1]);
  assert.equal(result.data, data);
  assert.deepEqual(factory.clients.map((client) => client.leaves), [1, 0]);
  assert.deepEqual(result.client.calls[0].options, { ...base, shared: true });
});

test('simultaneous entry produces one host and one guest in the same room', async () => {
  let host = null;
  let guest = null;
  const clients = [];
  function createClient() {
    const client = {
      leaves: 0,
      async create(options) {
        if (host) throw error('unavailable-id', 409);
        host = client;
        await Promise.resolve();
        return { ...options, role: 'host' };
      },
      async join(options) {
        assert.ok(host);
        if (guest) throw error('room-full', 409);
        guest = client;
        return { ...options, role: 'guest' };
      },
      async leave() {
        client.leaves++;
        if (host === client) host = null;
        if (guest === client) guest = null;
      },
    };
    clients.push(client);
    return client;
  }
  const results = await Promise.all([
    joinSharedRoom({ ...base, createClient }),
    joinSharedRoom({ ...base, name: 'Clay', createClient }),
  ]);
  assert.deepEqual(results.map((result) => result.data.role).sort(), ['guest', 'host']);
  assert.ok(results.every((result) => result.data.roomId === roomId && result.data.roomSecret === roomSecret));
  assert.equal(clients.length, 3);
  assert.equal(clients.reduce((total, client) => total + client.leaves, 0), 1);
  assert.ok(host && guest && host !== guest);
  await assert.rejects(joinSharedRoom({ ...base, createClient }), { type: 'room-full', status: 409 });
  assert.equal(clients.length, 5, 'A full room never starts another election');
  assert.equal(host, results.find((result) => result.data.role === 'host').client);
});

test('a host vanishing between claim and join permits another election', async () => {
  const data = { role: 'host', roomId };
  const factory = scripted([
    { action: 'create', error: error('unavailable-id', 409) },
    { action: 'join', error: error('peer-unavailable', 404) },
    { action: 'create', data },
  ]);
  const result = await joinSharedRoom({ ...base, createClient: factory.createClient });
  assert.equal(result.data, data);
  assert.deepEqual(factory.clients.map((client) => client.leaves), [1, 1, 0]);
});

test('repeated offline collisions stop after four elections and dispose every attempt', async () => {
  const unavailable = error('peer-unavailable', 404);
  const factory = scripted(Array.from({ length: 4 }, () => [
    { action: 'create', error: error('unavailable-id', 409) },
    { action: 'join', error: unavailable },
  ]).flat());
  await assert.rejects(joinSharedRoom({ ...base, createClient: factory.createClient }), (caught) => caught === unavailable);
  assert.equal(factory.clients.length, 8);
  assert.ok(factory.clients.every((client) => client.leaves === 1));
});

for (const [type, status] of [['network', 503], ['room-full', 409], ['unauthorized', 403], ['timeout', 503]]) {
  test(`${type} after collision never attempts to take over the host`, async () => {
    const rejected = error(type, status);
    const factory = scripted([
      { action: 'create', error: error('unavailable-id', 409) },
      { action: 'join', error: rejected },
    ]);
    await assert.rejects(joinSharedRoom({ ...base, createClient: factory.createClient }), (caught) => caught === rejected);
    assert.equal(factory.clients.length, 2);
    assert.ok(factory.clients.every((client) => client.leaves === 1));
  });
}

test('a status-only 409 is not a broker ID collision', async () => {
  const rejected = Object.assign(new Error('Conflict'), { status: 409 });
  const factory = scripted([{ action: 'create', error: rejected }]);
  await assert.rejects(joinSharedRoom({ ...base, createClient: factory.createClient }), (caught) => caught === rejected);
  assert.equal(factory.clients.length, 1);
  assert.equal(factory.clients[0].leaves, 1);
});

test('invalid capabilities are rejected before allocating a client', async () => {
  let clients = 0;
  const createClient = () => { clients++; throw new Error('Should not allocate'); };
  for (const identity of [
    { roomId: 'invalid' },
    { roomId: roomId.toUpperCase() },
    { roomSecret: roomSecret.slice(1) },
    { roomSecret: `${roomSecret}\n` },
    { roomId: null },
  ]) {
    await assert.rejects(joinSharedRoom({ ...base, ...identity, createClient }), { status: 403 });
  }
  assert.equal(clients, 0);
});

test('cancellation before entry allocates no client', async () => {
  const factory = scripted([]);
  await assert.rejects(joinSharedRoom({ ...base, createClient: factory.createClient, isCurrent: () => false }), { name: 'AbortError' });
  assert.equal(factory.clients.length, 0);
});

test('a stale successful claim is disposed instead of entering the room', async () => {
  const started = deferred();
  const finish = deferred();
  let current = true;
  const factory = scripted([{ action: 'create', run() { started.resolve(); return finish.promise; } }]);
  const pending = joinSharedRoom({ ...base, createClient: factory.createClient, isCurrent: () => current });
  await started.promise;
  current = false;
  finish.resolve({ role: 'host' });
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(factory.clients[0].leaves, 1);
});

test('a stale successful guest connection is disposed', async () => {
  const started = deferred();
  const finish = deferred();
  let current = true;
  const factory = scripted([
    { action: 'create', error: error('unavailable-id', 409) },
    { action: 'join', run() { started.resolve(); return finish.promise; } },
  ]);
  const pending = joinSharedRoom({ ...base, createClient: factory.createClient, isCurrent: () => current });
  await started.promise;
  current = false;
  finish.resolve({ role: 'guest' });
  await assert.rejects(pending, { name: 'AbortError' });
  assert.deepEqual(factory.clients.map((client) => client.leaves), [1, 1]);
});

test('cancellation during collision cleanup never starts the guest attempt', async () => {
  let current = true;
  const factory = scripted([{ action: 'create', async run() { current = false; throw error('unavailable-id', 409); } }]);
  await assert.rejects(joinSharedRoom({ ...base, createClient: factory.createClient, isCurrent: () => current }), { name: 'AbortError' });
  assert.equal(factory.clients.length, 1);
  assert.equal(factory.clients[0].leaves, 1);
});

test('cancellation after an offline collision stops before the next election', async () => {
  let current = true;
  const factory = scripted([
    { action: 'create', error: error('unavailable-id', 409) },
    { action: 'join', async run() {
      setTimeout(() => { current = false; }, 0);
      throw error('peer-unavailable', 404);
    } },
  ]);
  await assert.rejects(joinSharedRoom({ ...base, createClient: factory.createClient, isCurrent: () => current }), { name: 'AbortError' });
  assert.equal(factory.clients.length, 2);
  assert.ok(factory.clients.every((client) => client.leaves === 1));
});

test('cleanup failure cannot mask the original connection failure', async () => {
  const rejected = error('network');
  const factory = scripted([{ action: 'create', error: rejected, leaveError: new Error('Cleanup failed') }]);
  await assert.rejects(joinSharedRoom({ ...base, createClient: factory.createClient }), (caught) => caught === rejected);
  assert.equal(factory.clients[0].leaves, 1);
});
