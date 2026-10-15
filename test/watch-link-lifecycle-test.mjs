import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { parseWatchLink } from '../public/watch-link.js';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const firstId = '11111111-1111-4111-8111-111111111111';
const secondId = '99999999-9999-4999-8999-999999999999';
const appOrigin = 'https://watchroom.example.test';
const movieA = 'https://media.example.test/movie-a.mp4?signature=a%2Fb';
const movieB = 'https://player.example.test/movie-b';
const plain = (value) => JSON.parse(JSON.stringify(value));

function extract(name, endMarker) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf(endMarker, start);
  assert.ok(start !== -1 && end > start, `The actual app ${name} function is available`);
  return source.slice(start, end);
}

const appFunctions = [
  extract('applyWatchLink', '\nfunction chooseWatchLink('),
  extract('chooseWatchLink', '\nfunction openWatchLink('),
  extract('sendMessage', "\n$('entry-form').addEventListener("),
  extract('buildConnection', '\nasync function enterRoom('),
].join('\n');

function fixture({ peer = null, id = firstId, sendResult = true, messagesReady = true } = {}) {
  const calls = { clear: 0, render: 0, update: 0, stop: 0, sends: [], toasts: [], systems: [] };
  const handlers = new Map();
  let nextId = id;
  let state;
  const rtc = {
    messagesReady,
    sendMessage(message) { calls.sends.push(plain(message)); return sendResult; },
    // Keep this synchronous: the real transport returns undefined here.
    stopScreen() { calls.stop++; state.localScreen = null; },
    addEventListener(type, handler) { handlers.set(type, handler); },
  };
  state = {
    parseWatchLink,
    watchLinkOptions: { appOrigin },
    watchLinkSelection: null,
    activeWatchLink: null,
    localScreen: null,
    remoteScreen: null,
    screenShareIntent: null,
    session: { role: 'host' },
    peer,
    rtc,
    rtcGeneration: 0,
    WatchConnection: class { constructor() { return rtc; } },
    postEvent() {},
    iceServers() { return []; },
    crypto: { randomUUID() { return nextId; } },
    Date: { now() { return 1000; } },
    clearWatchPlayer() { calls.clear++; },
    renderScreen() { calls.render++; },
    updateConnection() { calls.update++; },
    updateDeviceState() {},
    receiveMessage() {},
    appendSystem(message) { calls.systems.push(message); },
    toast(message) { calls.toasts.push(message); },
    readableError(error) { return error.message; },
  };
  vm.runInNewContext(appFunctions, state);
  return {
    state,
    calls,
    apply: (message) => state.applyWatchLink(message),
    choose: (url) => state.chooseWatchLink(url),
    setId(value) { nextId = value; },
    build() { state.buildConnection(); },
    emit(type, detail) {
      const handler = handlers.get(type);
      assert.ok(handler, `A real app handler is registered for ${type}`);
      handler({ detail });
    },
  };
}

const selection = (overrides = {}) => ({ type: 'watch-link', url: movieA, revision: 1, id: firstId, time: 1000, ...overrides });

function snapshot(f) {
  return { selected: f.state.watchLinkSelection, active: f.state.activeWatchLink, local: f.state.localScreen, calls: plain(f.calls) };
}

function unchanged(f, before) {
  assert.equal(f.state.watchLinkSelection, before.selected);
  assert.equal(f.state.activeWatchLink, before.active);
  assert.equal(f.state.localScreen, before.local);
  assert.deepEqual(f.calls, before.calls);
}

test('invalid remote URLs cannot mutate selection, rendering, or an existing capture', () => {
  const f = fixture();
  assert.equal(f.apply(selection()), true);
  f.state.localScreen = { granted: true };
  for (const url of [
    'javascript:alert(1)',
    'http://media.example.test/movie.mp4',
    `${appOrigin}/watchroom#private`,
    'https://user:password@media.example.test/movie.mp4',
    'https://media.example.test/movie.mp4\n',
    undefined,
    123,
  ]) {
    const before = snapshot(f);
    assert.equal(f.apply(selection({ url, revision: 2, id: secondId })), false);
    unchanged(f, before);
  }
});

test('malformed selection revisions, IDs, and timestamps are side-effect free', () => {
  const f = fixture();
  assert.equal(f.apply(selection()), true);
  f.state.localScreen = { granted: true };
  for (const override of [
    { revision: 0 }, { revision: -1 }, { revision: 1.5 }, { revision: '2' },
    { revision: NaN }, { revision: Infinity }, { revision: Number.MAX_SAFE_INTEGER },
    { id: '' }, { id: null }, { id: 123 }, { id: 'a'.repeat(65) },
    { time: undefined }, { time: '1000' }, { time: NaN }, { time: Infinity },
  ]) {
    const before = snapshot(f);
    assert.equal(f.apply(selection({ revision: 2, id: secondId, ...override })), false, JSON.stringify(override));
    unchanged(f, before);
  }
});

test('failed or unavailable message delivery never applies a local choice', () => {
  for (const options of [{ sendResult: false }, { messagesReady: false }]) {
    const f = fixture({ peer: { id: 'partner' }, ...options });
    assert.equal(f.apply(selection()), true);
    const before = snapshot(f);
    assert.equal(f.choose(movieB), false);
    assert.equal(f.state.watchLinkSelection, before.selected);
    assert.equal(f.state.activeWatchLink, before.active);
    assert.equal(f.calls.clear, before.calls.clear);
    assert.equal(f.calls.render, before.calls.render);
    assert.equal(f.calls.update, before.calls.update);
    assert.equal(f.calls.stop, 0);
    assert.equal(f.calls.toasts.length, 1, 'The failed delivery is explained to the user');
  }
});

test('an unsafe local choice is rejected before sending or rendering', () => {
  const f = fixture({ peer: { id: 'partner' } });
  const before = snapshot(f);
  assert.throws(() => f.choose('data:text/html,<script>alert(1)</script>'), TypeError);
  unchanged(f, before);
});

test('a person alone can stage a link without a ready messaging channel', () => {
  const f = fixture({ messagesReady: false });
  assert.equal(f.choose(movieA), true);
  assert.equal(f.state.activeWatchLink.url, movieA);
  assert.deepEqual(plain(f.state.watchLinkSelection), selection());
  assert.equal(f.calls.sends.length, 0);
  assert.equal(f.calls.clear, 1);
  assert.equal(f.calls.render, 1);
  assert.equal(f.calls.update, 1);
});

test('concurrent selections at the same revision converge by ID in either delivery order', () => {
  for (const reverse of [false, true]) {
    const a = fixture({ peer: { id: 'b' }, id: firstId });
    const b = fixture({ peer: { id: 'a' }, id: secondId });
    assert.equal(a.choose(movieA), true);
    assert.equal(b.choose(movieB), true);
    const delivery = [() => a.apply(b.calls.sends[0]), () => b.apply(a.calls.sends[0])];
    if (reverse) delivery.reverse();
    delivery.forEach((deliver) => deliver());
    assert.equal(a.state.activeWatchLink.url, movieB);
    assert.equal(b.state.activeWatchLink.url, movieB);
    assert.deepEqual(plain(a.state.watchLinkSelection), plain(b.state.watchLinkSelection));

    a.setId(firstId);
    assert.equal(a.choose(movieA), true);
    assert.equal(a.state.watchLinkSelection.revision, 2);
    assert.equal(b.apply(a.calls.sends[1]), true);
    assert.equal(b.state.activeWatchLink.url, movieA);
  }
});

test('replayed, older, and losing concurrent selections cannot reload the player', () => {
  const f = fixture();
  assert.equal(f.apply(selection({ revision: 2, id: secondId, url: movieB })), true);
  for (const message of [
    selection({ revision: 2, id: secondId, url: movieB }),
    selection({ revision: 1, id: secondId }),
    selection({ revision: 2, id: firstId }),
  ]) {
    const before = snapshot(f);
    assert.equal(f.apply(message), false);
    unchanged(f, before);
  }
});

test('a new link stops granted capture using the synchronous transport method', () => {
  const f = fixture();
  f.state.localScreen = { granted: true };
  assert.doesNotThrow(() => { assert.equal(f.apply(selection()), true); });
  assert.equal(f.calls.stop, 1);
  assert.equal(f.state.localScreen, null);
  assert.equal(f.state.activeWatchLink.url, movieA);
  assert.equal(f.calls.render, 1);
  assert.equal(f.calls.update, 1);
});

test('the latest selection and explicit clear are resent unchanged on connection', () => {
  const f = fixture();
  assert.equal(f.choose(movieA), true);
  f.state.peer = { id: 'partner' };
  f.build();
  f.emit('state', 'connected');
  assert.deepEqual(f.calls.sends[0], selection());

  f.setId(secondId);
  assert.equal(f.choose(null), true);
  const cleared = plain(f.state.watchLinkSelection);
  assert.equal(cleared.url, null);
  assert.equal(cleared.revision, 2);
  assert.equal(f.state.activeWatchLink, null);
  f.emit('state', 'connected');
  assert.deepEqual(f.calls.sends.at(-1), cleared);
});

test('a screen picker completing after a newer selection stops capture and preserves the newer link', () => {
  const f = fixture({ peer: { id: 'partner' } });
  assert.equal(f.apply(selection()), true);
  f.state.screenShareIntent = { selectionId: firstId };
  assert.equal(f.apply(selection({ revision: 2, id: secondId, url: movieB })), true);
  f.build();
  f.emit('local-screen', { granted: true });
  assert.equal(f.calls.stop, 1);
  assert.equal(f.state.localScreen, null);
  assert.equal(f.state.activeWatchLink.url, movieB);
  assert.equal(f.calls.sends.length, 0);
});

test('a screen picker completing after message delivery fails stops capture', () => {
  const f = fixture({ peer: { id: 'partner' }, messagesReady: false });
  assert.equal(f.apply(selection()), true);
  f.state.screenShareIntent = { selectionId: firstId };
  f.build();
  f.emit('local-screen', { granted: true });
  assert.equal(f.calls.stop, 1);
  assert.equal(f.state.localScreen, null);
  assert.equal(f.state.activeWatchLink.url, movieA);
  assert.equal(f.calls.sends.length, 0);
});

test('remote screen changes refresh both rendering and control availability', () => {
  const f = fixture();
  f.build();
  const before = snapshot(f);
  f.emit('remote-screen', null);
  assert.equal(f.calls.render, before.calls.render + 1);
  assert.equal(f.calls.update, before.calls.update + 1);
});
