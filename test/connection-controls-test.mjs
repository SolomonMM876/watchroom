import assert from 'node:assert/strict';
import test from 'node:test';
import { WatchConnection } from '../public/rtc.js';

class FakeStream {
  constructor(tracks = []) { this.tracks = [...tracks]; }
  getTracks() { return [...this.tracks]; }
  getAudioTracks() { return this.getTracks().filter((track) => track.kind === 'audio'); }
  getVideoTracks() { return this.getTracks().filter((track) => track.kind === 'video'); }
  addTrack(track) { if (!this.tracks.includes(track)) this.tracks.push(track); }
  removeTrack(track) { this.tracks = this.tracks.filter((item) => item !== track); }
}

class FakeChannel {
  constructor(readyState = 'connecting') {
    this.readyState = readyState;
    this.bufferedAmount = 0;
    this.sent = [];
    this.closeCalls = 0;
  }
  send(data) {
    assert.equal(this.readyState, 'open');
    this.sent.push(JSON.parse(data));
  }
  open() { this.readyState = 'open'; this.onopen?.(); }
  close() { this.closeCalls++; this.readyState = 'closed'; this.onclose?.(); }
}

class FakePeerConnection {
  connectionState = 'new';
  iceConnectionState = 'new';
  signalingState = 'stable';
  transceivers = [];
  restartCalls = 0;
  addTransceiver(kind) {
    const sender = {
      track: null,
      setStreams() {},
      async replaceTrack(track) { this.track = track; },
      getParameters() { return {}; },
    };
    const transceiver = { direction: 'sendrecv', receiver: { track: { kind } }, sender };
    this.transceivers.push(transceiver);
    return transceiver;
  }
  getTransceivers() { return this.transceivers; }
  createDataChannel() { return this.channel = new FakeChannel(); }
  setConnectionState(state) { this.connectionState = state; this.onconnectionstatechange?.(); }
  restartIce() { this.restartCalls++; }
  close() { this.connectionState = 'closed'; }
}

function restoreGlobal(t, name, value) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  });
}

function connectionFixture(t, role = 'host') {
  restoreGlobal(t, 'MediaStream', FakeStream);
  restoreGlobal(t, 'RTCPeerConnection', FakePeerConnection);
  restoreGlobal(t, 'CustomEvent', class extends Event {
    constructor(type, { detail }) { super(type); this.detail = detail; }
  });
  const rtc = new WatchConnection({ role, sendSignal: async () => {} });
  t.after(() => rtc.close());
  const events = { state: [], error: [], message: [] };
  for (const type of Object.keys(events)) rtc.addEventListener(type, ({ detail }) => events[type].push(detail));
  return { rtc, pc: rtc.connection, channel: rtc._channel, events };
}

function connect({ pc, channel }) {
  pc.setConnectionState('connected');
  channel.open();
}

test('media connectivity does not enable controls before the message channel opens', (t) => {
  const fixture = connectionFixture(t);
  fixture.pc.setConnectionState('connected');
  assert.equal(fixture.rtc.state, 'connecting');
  assert.equal(fixture.rtc.messagesReady, false);
  assert.equal(fixture.rtc.sendMessage({ type: 'chat', text: 'Too early' }), false);

  fixture.channel.open();
  assert.equal(fixture.rtc.state, 'connected');
  assert.equal(fixture.rtc.messagesReady, true);
  assert.equal(fixture.channel.sent[0].__cozyWatchControl, true, 'Initial device state is sent as the channel opens');
  assert.equal(fixture.rtc.sendMessage({ type: 'chat', text: 'Ready' }), true);
  assert.equal(fixture.channel.sent.at(-1).text, 'Ready');
});

test('a guest adopts an already open message channel without waiting for another event', (t) => {
  const fixture = connectionFixture(t, 'guest');
  fixture.pc.setConnectionState('connected');
  assert.equal(fixture.rtc.state, 'connecting');
  assert.equal(fixture.rtc.messagesReady, false);

  const channel = new FakeChannel('open');
  fixture.pc.ondatachannel({ channel });
  assert.equal(fixture.rtc.state, 'connected');
  assert.equal(fixture.rtc.messagesReady, true);
  assert.equal(channel.sent[0].__cozyWatchControl, true);
  assert.equal(fixture.rtc.sendMessage({ type: 'chat', text: 'Guest ready' }), true);
});

test('device state is sent when media becomes connected after the channel opens', (t) => {
  const fixture = connectionFixture(t);
  fixture.rtc.devices = { camera: true, mic: true };
  fixture.channel.open();
  assert.equal(fixture.rtc.state, 'connecting');
  assert.equal(fixture.rtc.messagesReady, false);
  assert.deepEqual(fixture.channel.sent, []);

  fixture.pc.setConnectionState('connected');
  assert.equal(fixture.rtc.state, 'connected');
  assert.equal(fixture.rtc.messagesReady, true);
  assert.deepEqual(fixture.channel.sent, [{ __cozyWatchControl: true, screen: false, camera: true, mic: true }]);
});

test('a closed message channel remains interrupted after a later connected media event', (t) => {
  const fixture = connectionFixture(t);
  connect(fixture);
  fixture.channel.close();
  assert.equal(fixture.rtc.state, 'disconnected');
  assert.equal(fixture.rtc.messagesReady, false);

  fixture.pc.setConnectionState('connected');
  assert.equal(fixture.rtc.state, 'disconnected');
  assert.equal(fixture.rtc.sendMessage({ type: 'reaction', reaction: 'heart' }), false);
});

test('a closing message channel is interrupted even while media stays connected', (t) => {
  const fixture = connectionFixture(t);
  connect(fixture);
  fixture.channel.readyState = 'closing';
  fixture.channel.onclosing();
  assert.equal(fixture.rtc.state, 'disconnected');
  fixture.pc.setConnectionState('connected');
  assert.equal(fixture.rtc.state, 'disconnected');
  assert.equal(fixture.rtc.messagesReady, false);
});

for (const state of ['failed', 'disconnected']) {
  test(`a channel open event cannot hide a ${state} peer connection`, (t) => {
    const fixture = connectionFixture(t);
    fixture.pc.setConnectionState(state);
    fixture.channel.open();
    assert.equal(fixture.rtc.state, state);
    assert.equal(fixture.rtc.messagesReady, false);
    assert.equal(fixture.rtc.sendMessage({ type: 'chat', text: 'No transport' }), false);
  });
}

test('a closed peer connection cannot leave an open message channel ready', (t) => {
  const fixture = connectionFixture(t);
  connect(fixture);
  fixture.pc.setConnectionState('closed');
  assert.equal(fixture.rtc.state, 'disconnected');
  assert.equal(fixture.rtc.messagesReady, false);
  assert.equal(fixture.rtc.sendMessage({ type: 'chat', text: 'Ended transport' }), false);
  fixture.channel.onopen();
  assert.equal(fixture.rtc.state, 'disconnected');
});

test('a channel error exposes interruption and preserves granted camera and screen media', (t) => {
  const fixture = connectionFixture(t);
  connect(fixture);
  const camera = { kind: 'video', readyState: 'live', stopCalls: 0, stop() { this.stopCalls++; } };
  const screen = { kind: 'video', readyState: 'live', stopCalls: 0, stop() { this.stopCalls++; } };
  fixture.rtc.localCamera.addTrack(camera);
  fixture.rtc.localScreen = new FakeStream([screen]);
  fixture.channel.onerror();

  assert.equal(fixture.rtc.state, 'disconnected');
  assert.equal(fixture.rtc.messagesReady, false);
  assert.equal(fixture.channel.closeCalls, 1);
  assert.equal(fixture.events.error.length, 1);
  assert.match(fixture.events.error[0].message, /Reconnect/);
  assert.equal(camera.stopCalls, 0);
  assert.equal(screen.stopCalls, 0);
  assert.equal(fixture.rtc.localCamera.getVideoTracks()[0], camera);
  assert.equal(fixture.rtc.localScreen.getVideoTracks()[0], screen);
  fixture.pc.setConnectionState('connected');
  assert.equal(fixture.rtc.state, 'disconnected');
});

test('queued callbacks from a reset channel cannot change the replacement connection', async (t) => {
  const fixture = connectionFixture(t);
  const old = {
    open: fixture.channel.onopen,
    close: fixture.channel.onclose,
    closing: fixture.channel.onclosing,
    error: fixture.channel.onerror,
    message: fixture.channel.onmessage,
    state: fixture.pc.onconnectionstatechange,
  };
  await fixture.rtc.reset();
  const replacement = { pc: fixture.rtc.connection, channel: fixture.rtc._channel };
  old.open();
  assert.equal(fixture.rtc.state, 'connecting');
  assert.equal(fixture.rtc.messagesReady, false);
  assert.equal(replacement.channel.sent.length, 0);

  connect(replacement);
  const sent = replacement.channel.sent.length;
  old.open();
  old.close();
  old.closing();
  old.error();
  old.message({ data: JSON.stringify({ type: 'chat', text: 'Former participant' }) });
  assert.equal(fixture.rtc.state, 'connected');
  assert.equal(fixture.rtc.messagesReady, true);
  assert.equal(replacement.channel.sent.length, sent);
  assert.equal(replacement.channel.closeCalls, 0);
  assert.deepEqual(fixture.events.error, []);
  assert.deepEqual(fixture.events.message, []);

  // A queued former-PC event must not process a pending state change belonging
  // to the new PC. Only that new PC's own event may publish its interruption.
  replacement.pc.connectionState = 'disconnected';
  old.state();
  assert.equal(fixture.rtc.state, 'connected');
  replacement.pc.onconnectionstatechange();
  assert.equal(fixture.rtc.state, 'disconnected');
});

test('callbacks from a replaced channel on the same peer connection are ignored', (t) => {
  const fixture = connectionFixture(t);
  connect(fixture);
  const old = {
    open: fixture.channel.onopen,
    close: fixture.channel.onclose,
    closing: fixture.channel.onclosing,
    error: fixture.channel.onerror,
    message: fixture.channel.onmessage,
  };
  const replacement = new FakeChannel();
  fixture.pc.ondatachannel({ channel: replacement });
  assert.equal(fixture.rtc.state, 'connecting');
  assert.equal(fixture.rtc.messagesReady, false);
  replacement.open();
  const sent = replacement.sent.length;
  old.open();
  old.close();
  old.closing();
  old.error();
  old.message({ data: JSON.stringify({ __cozyWatchControl: true, camera: true, mic: true }) });

  assert.equal(fixture.rtc.state, 'connected');
  assert.equal(fixture.rtc.messagesReady, true);
  assert.equal(replacement.sent.length, sent);
  assert.equal(replacement.closeCalls, 0);
  assert.deepEqual(fixture.events.error, []);
  assert.deepEqual(fixture.rtc.remoteDevices, { camera: false, mic: false });
});

test('an already queued ICE retry cannot restart a replacement peer connection', async (t) => {
  const fixture = connectionFixture(t);
  const callbacks = [];
  restoreGlobal(t, 'setTimeout', (callback) => { callbacks.push(callback); return callbacks.length; });
  // Keep cancelled callbacks available to emulate a timeout task that was
  // already queued when resetting the old peer connection.
  restoreGlobal(t, 'clearTimeout', () => {});
  fixture.pc.setConnectionState('disconnected');
  const oldRetry = callbacks[0];
  await fixture.rtc.reset();
  const replacement = fixture.rtc.connection;
  replacement.setConnectionState('disconnected');
  oldRetry();
  assert.equal(fixture.pc.restartCalls, 0);
  assert.equal(replacement.restartCalls, 0);
  callbacks.at(-1)();
  assert.equal(replacement.restartCalls, 1, 'The current host still performs its own ICE recovery');
});
