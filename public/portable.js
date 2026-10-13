/*
 * Portable signaling for the unpacked Brave extension. PeerJS Cloud brokers
 * an encrypted WebRTC data connection; room capabilities and the watch call's
 * SDP/ICE then travel over that connection, never in PeerJS metadata.
 * Keep the host's extension tab open for the lifetime of the room.
 */

const TIMEOUT_MS = 25_000;
const MAX_EVENTS = 256;
const MAX_QUEUE_BYTES = 1024 * 1024;
const MAX_PACKET_BYTES = 80_000;
const LABEL = 'sofa-room-v1';
const DEFAULT_ICE = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }];
const encoder = new TextEncoder();
let peerLibraryLoading = null;

async function loadPeerLibrary() {
  if (typeof globalThis.Peer === 'function') return;
  if (!peerLibraryLoading) {
    peerLibraryLoading = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const timer = setTimeout(() => finish(problem('The connection library took too long to load. Reload this tab and try again.')), TIMEOUT_MS);
      function finish(error) {
        clearTimeout(timer);
        script.onload = script.onerror = null;
        if (error) { script.remove(); reject(error); }
        else resolve();
      }
      script.src = new URL('./vendor/peerjs.min.js', import.meta.url).href;
      script.onload = () => finish(typeof globalThis.Peer === 'function' ? null : problem('The connection library did not load. Reload this tab and try again.'));
      script.onerror = () => finish(problem('The connection library did not load. Reload this tab and try again.'));
      document.head.append(script);
    }).catch((error) => { peerLibraryLoading = null; throw error; });
  }
  await peerLibraryLoading;
}

function randomHex(bytes) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (value) => value.toString(16).padStart(2, '0')).join('');
}

function displayName(value) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 32) : 'Partner';
}

function problem(message, status = 503) {
  return Object.assign(new Error(message), { status });
}

function sameSecret(received, expected) {
  if (typeof received !== 'string' || received.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index++) difference |= received.charCodeAt(index) ^ expected.charCodeAt(index);
  return difference === 0;
}

function packetSize(packet) {
  try { return encoder.encode(JSON.stringify(packet)).length; } catch { return Infinity; }
}

function signalPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw problem('Invalid connection message.', 400);
  // Authenticated peers use this one control message before resetting their
  // media connection; lifecycle join/leave events remain adapter-owned.
  if (payload.kind === 'peer-ready' && Object.keys(payload).length === 1) return { kind: 'peer-ready' };
  const description = Object.hasOwn(payload, 'description');
  const candidate = Object.hasOwn(payload, 'candidate');
  if (description === candidate || packetSize(payload) > 65_000) throw problem('Invalid connection message.', 400);
  if (description) {
    const value = payload.description;
    if (!value || !['offer', 'answer'].includes(value.type) || typeof value.sdp !== 'string') throw problem('Invalid connection description.', 400);
    return { description: { type: value.type, sdp: value.sdp } };
  }
  const value = payload.candidate;
  if (value === null) return { candidate: null };
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.candidate !== 'string' || value.candidate.length > 16_000) throw problem('Invalid connection candidate.', 400);
  const clean = { candidate: value.candidate };
  if (value.sdpMid !== undefined) {
    if (value.sdpMid !== null && typeof value.sdpMid !== 'string') throw problem('Invalid connection candidate.', 400);
    clean.sdpMid = value.sdpMid;
  }
  if (value.sdpMLineIndex !== undefined) {
    if (value.sdpMLineIndex !== null && (!Number.isSafeInteger(value.sdpMLineIndex) || value.sdpMLineIndex < 0)) throw problem('Invalid connection candidate.', 400);
    clean.sdpMLineIndex = value.sdpMLineIndex;
  }
  if (value.usernameFragment !== undefined) {
    if (value.usernameFragment !== null && typeof value.usernameFragment !== 'string') throw problem('Invalid connection candidate.', 400);
    clean.usernameFragment = value.usernameFragment;
  }
  return { candidate: clean };
}

function peerProblem(error) {
  if (error?.type === 'peer-unavailable') return Object.assign(problem('Your partner’s room is offline. Ask them to keep their Watchroom tab open, then try the invitation again.', 404), { type: error.type });
  if (error?.type === 'unavailable-id') return Object.assign(problem('This room is already open in another tab. Return to that tab, or create a fresh room.', 409), { type: error.type });
  if (error?.type === 'browser-incompatible') return problem('This browser cannot make the connection. Open the extension in desktop Brave or Chrome.', 400);
  return problem('The connection service could not be reached. Check your internet connection or try again in a moment. Some networks also need a TURN relay.');
}

export class PortableRoomClient extends EventTarget {
  constructor() {
    super();
    this.session = null;
    this._peer = null;
    this._connection = null;
    this._remote = null;
    this._records = new Map();
    this._events = [];
    this._counter = 0;
    this._queueBytes = 0;
    this._droppedThrough = 0;
    this._closed = false;
    this._fatalError = null;
    this._serviceError = null;
    this._brokerWaiters = new Set();
    this._brokerOpen = false;
    this._reconnectTimer = null;
    this._retryDelay = 2_000;
    this._joining = null;
    this._iceServers = DEFAULT_ICE;
  }

  _notify(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  _roster() {
    if (!this.session) return [];
    const self = { id: this.session.participantId, name: this.session.name, role: this.session.role, lastSeen: Date.now() };
    const participants = this._remote ? [self, { ...this._remote, lastSeen: Date.now() }] : [self];
    return participants.sort((left) => left.role === 'host' ? -1 : 1);
  }

  _snapshot() {
    return { ...this.session, participants: this._roster(), cursor: this._counter, iceServers: this._iceServers };
  }

  _push(sender, payload) {
    const event = { id: ++this._counter, sender, payload };
    const bytes = packetSize(event);
    this._events.push({ event, bytes });
    this._queueBytes += bytes;
    while (this._events.length > MAX_EVENTS || this._queueBytes > MAX_QUEUE_BYTES) {
      const removed = this._events.shift();
      this._queueBytes -= removed.bytes;
      this._droppedThrough = removed.event.id;
    }
  }

  _clearPeerEvents() {
    this._events = [];
    this._queueBytes = 0;
    // A new peer-joined event replaces the obsolete peer's negotiation.
    this._droppedThrough = 0;
  }

  _flushBrokerWaiters(error) {
    for (const waiter of this._brokerWaiters) {
      clearTimeout(waiter.timer);
      if (error) waiter.reject(error); else waiter.resolve();
    }
    this._brokerWaiters.clear();
  }

  _waitForBroker() {
    if (this._brokerOpen && this._peer && !this._peer.destroyed && !this._peer.disconnected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this._brokerWaiters.delete(waiter);
        reject(problem('Connecting took too long. Check your internet connection, then try again.'));
      }, TIMEOUT_MS);
      this._brokerWaiters.add(waiter);
    });
  }

  _scheduleBrokerReconnect() {
    if (this._closed || this._reconnectTimer || !this._peer || this._peer.destroyed) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this._closed || !this._peer || this._peer.destroyed) return;
      if (this._peer.disconnected) {
        try { this._peer.reconnect(); } catch { this._scheduleBrokerReconnect(); }
      }
    }, this._retryDelay);
    this._retryDelay = Math.min(this._retryDelay * 2, 30_000);
  }

  async _openPeer(id) {
    await loadPeerLibrary();
    if (this._closed) throw problem('This room connection was cancelled.', 410);
    if (typeof globalThis.Peer !== 'function') throw problem('The extension’s connection library did not load. Reload this tab and try again.');
    const peer = new globalThis.Peer(id, {
      host: '0.peerjs.com', port: 443, path: '/', secure: true, debug: 0,
      config: { iceServers: this._iceServers, sdpSemantics: 'unified-plan' },
    });
    this._peer = peer;
    this._brokerOpen = false;
    peer.on('open', () => {
      if (this._peer !== peer || this._closed) return;
      this._brokerOpen = true;
      this._serviceError = null;
      this._retryDelay = 2_000;
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
      this._flushBrokerWaiters();
    });
    peer.on('connection', (connection) => {
      if (this._peer !== peer || this._closed || this.session?.role !== 'host') { connection.close(); return; }
      this._acceptIncoming(connection);
    });
    peer.on('call', (call) => { call.close(); });
    peer.on('disconnected', () => {
      if (this._peer !== peer || this._closed) return;
      this._brokerOpen = false;
      this._serviceError = peerProblem();
      this._notify('warning', this._serviceError);
      // An established data connection stays alive when the broker disconnects.
      // Re-register the same peer without destroying the ongoing movie/call.
      this._scheduleBrokerReconnect();
    });
    peer.on('error', (error) => {
      if (this._peer !== peer || this._closed) return;
      const converted = peerProblem(error);
      this._serviceError = converted;
      this._flushBrokerWaiters(converted);
      if (this._joining) this._joining.reject(converted);
      if (peer.destroyed) this._fatalError = converted;
      else if (peer.disconnected) this._scheduleBrokerReconnect();
      this._notify('warning', converted);
    });
    peer.on('close', () => {
      if (this._peer !== peer || this._closed) return;
      this._brokerOpen = false;
      this._fatalError = problem('The room connection ended. Open the invitation again, or create a fresh room.');
      this._flushBrokerWaiters(this._fatalError);
      if (this._joining) this._joining.reject(this._fatalError);
    });
    await this._waitForBroker();
  }

  _bindConnection(connection, incoming) {
    const record = { authenticated: false, timer: null, closeTimer: null };
    this._records.set(connection, record);
    record.timer = setTimeout(() => {
      if (record.authenticated || this._closed) return;
      if (!incoming && this._joining) this._joining.reject(problem('The room could not connect in time. Ask your partner to keep their Watchroom tab open. If your networks block direct calls, add TURN relay details in Connection settings.'));
      this._closeConnection(connection);
    }, TIMEOUT_MS);
    connection.on('data', (packet) => {
      if (this._closed || !this._records.has(connection)) return;
      if (!packet || typeof packet !== 'object' || Array.isArray(packet) || packetSize(packet) > MAX_PACKET_BYTES) {
        this._rejectConnection(connection, 'Invalid room message.', 400);
        return;
      }
      this._receive(connection, packet, incoming);
    });
    connection.on('error', () => {
      if (this._closed || !this._records.has(connection)) return;
      const error = problem('The link to your partner was interrupted. Use Reconnect to try again; some networks need a TURN relay.');
      if (!incoming && this._joining) this._joining.reject(error);
      this._notify('warning', error);
      this._closeConnection(connection);
    });
    connection.on('close', () => this._connectionClosed(connection));
    return record;
  }

  _acceptIncoming(connection) {
    const record = this._bindConnection(connection, true);
    connection.on('open', () => {
      if (this._closed) { this._closeConnection(connection); return; }
      if (connection.label !== LABEL || !/^sofa-guest-[a-f0-9]{32}$/.test(connection.peer)) this._rejectConnection(connection, 'This invitation is not valid.', 403);
      else if (this._records.size > 4 || (this._connection?.open && this._records.get(this._connection)?.authenticated)) this._rejectConnection(connection, 'Both seats are taken. Ask your partner to leave their old room tab, then try again.', 409);
      else if (!record.timer) this._closeConnection(connection);
    });
  }

  _sendPacket(connection, packet) {
    if (!connection?.open || packetSize(packet) > MAX_PACKET_BYTES || connection.bufferSize > 32 || connection.dataChannel?.bufferedAmount > 512 * 1024) throw problem('The connection is busy or offline. Wait a moment and use Reconnect.');
    connection.send(packet);
  }

  _rejectConnection(connection, message, status = 403) {
    const record = this._records.get(connection);
    if (!record) return;
    clearTimeout(record.timer);
    record.timer = null;
    try { this._sendPacket(connection, { kind: 'reject', message, status }); } catch { /* Closing still revokes the attempted connection. */ }
    if (!record.closeTimer) record.closeTimer = setTimeout(() => this._closeConnection(connection), 150);
  }

  _closeConnection(connection) {
    this._connectionClosed(connection);
    try { connection.close(); } catch { /* A failed transport may already be closed. */ }
  }

  _connectionClosed(connection) {
    const record = this._records.get(connection);
    if (!record) return;
    clearTimeout(record.timer);
    clearTimeout(record.closeTimer);
    this._records.delete(connection);
    if (this._connection === connection) {
      this._connection = null;
      this._remote = null;
      this._clearPeerEvents();
      this._notify('peer-left', { closed: this._closed });
    }
    if (this.session?.role === 'guest' && !record.authenticated && this._joining) this._joining.reject(problem('Your partner’s room disconnected before it could admit you. Open the invitation again.'));
  }

  _receive(connection, packet, incoming) {
    const record = this._records.get(connection);
    if (!record || record.closeTimer) return;
    if (!record.authenticated) {
      if (incoming && packet.kind === 'join') {
        if (!sameSecret(packet.roomSecret, this.session.roomSecret) || !/^[a-f0-9]{48}$/.test(packet.participantSecret || '')) {
          this._rejectConnection(connection, 'This invitation is not valid.', 403);
          return;
        }
        if (connection.label !== LABEL || !/^sofa-guest-[a-f0-9]{32}$/.test(connection.peer)) {
          this._rejectConnection(connection, 'This invitation is not valid.', 403);
          return;
        }
        if (this._connection?.open && this._records.get(this._connection)?.authenticated) {
          this._rejectConnection(connection, 'Both seats are taken. Ask your partner to leave their old room tab, then try again.', 409);
          return;
        }
        record.authenticated = true;
        clearTimeout(record.timer);
        record.timer = null;
        this._connection = connection;
        this._remote = { id: connection.peer, name: displayName(packet.name), role: 'guest', lastSeen: Date.now() };
        this._clearPeerEvents();
        try { this._sendPacket(connection, { kind: 'welcome', roomId: this.session.roomId, participants: this._roster() }); }
        catch { this._closeConnection(connection); return; }
        this._push(connection.peer, { kind: 'peer-joined' });
        this._notify('peer-joined', this._remote);
        return;
      }
      if (!incoming && packet.kind === 'reject') {
        const message = typeof packet.message === 'string' ? packet.message.slice(0, 240) : 'This room could not admit you.';
        if (this._joining) this._joining.reject(problem(message, [400, 403, 409, 410].includes(packet.status) ? packet.status : 403));
        this._closeConnection(connection);
        return;
      }
      if (!incoming && packet.kind === 'welcome') {
        const hostId = `sofa-${this.session.roomId}`;
        const roster = packet.participants;
        const host = Array.isArray(roster) ? roster.find((entry) => entry?.id === hostId && entry.role === 'host') : null;
        const self = Array.isArray(roster) ? roster.find((entry) => entry?.id === this.session.participantId && entry.role === 'guest') : null;
        if (packet.roomId !== this.session.roomId || connection.peer !== hostId || !host || !self || roster.length !== 2) {
          if (this._joining) this._joining.reject(problem('This invitation is not valid.', 403));
          this._closeConnection(connection);
          return;
        }
        record.authenticated = true;
        clearTimeout(record.timer);
        record.timer = null;
        this._connection = connection;
        this._remote = { id: hostId, name: displayName(host.name), role: 'host', lastSeen: Date.now() };
        this._serviceError = null;
        if (this._joining) this._joining.resolve(this._snapshot());
        return;
      }
      this._rejectConnection(connection, 'This invitation is not valid.', 403);
      return;
    }
    if (connection !== this._connection) return;
    if (packet.kind === 'signal') {
      try { this._push(connection.peer, signalPayload(packet.payload)); }
      catch { this._rejectConnection(connection, 'Invalid connection message.', 400); }
    } else if (packet.kind === 'leave') {
      if (this.session.role === 'guest' && packet.closed === true) this._closed = true;
      this._closeConnection(connection);
    }
  }

  async create({ name, iceServers = DEFAULT_ICE, roomId = randomHex(16), roomSecret = randomHex(24), shared = false } = {}) {
    if (this.session || this._closed) throw problem('Use a fresh room client to create another room.', 400);
    if (!/^[a-f0-9]{32}$/.test(roomId) || !/^[a-f0-9]{48}$/.test(roomSecret)) throw problem('This shared room is not configured correctly.', 400);
    this._iceServers = iceServers;
    this.session = { roomId, roomSecret, participantId: `sofa-${roomId}`, participantSecret: randomHex(24), role: 'host', name: displayName(name), portable: true, shared: shared === true };
    try {
      await this._openPeer(this.session.participantId);
      return this._snapshot();
    } catch (error) {
      await this.leave();
      throw error;
    }
  }

  async join({ roomId, roomSecret, name, iceServers = DEFAULT_ICE, shared = false } = {}) {
    if (this.session || this._closed) throw problem('Use a fresh room client to enter another room.', 400);
    if (!/^[a-f0-9]{32}$/.test(roomId || '') || !/^[a-f0-9]{48}$/.test(roomSecret || '')) throw problem('This invitation is not valid.', 403);
    this._iceServers = iceServers;
    this.session = { roomId, roomSecret, participantId: `sofa-guest-${randomHex(16)}`, participantSecret: randomHex(24), role: 'guest', name: displayName(name), portable: true, shared: shared === true };
    try {
      await this._openPeer(this.session.participantId);
      return await this._connectGuest();
    } catch (error) {
      await this.leave();
      throw error;
    }
  }

  _connectGuest() {
    if (this._joining) return this._joining.promise;
    let resolveJoin, rejectJoin;
    const promise = new Promise((resolve, reject) => { resolveJoin = resolve; rejectJoin = reject; });
    const joining = { promise, resolve: resolveJoin, reject: rejectJoin };
    this._joining = joining;
    const timer = setTimeout(() => rejectJoin(problem('Your partner’s room could not connect in time. Keep both Watchroom tabs open and try again, or add TURN relay details for restricted networks.')), TIMEOUT_MS);
    try {
      const connection = this._peer.connect(`sofa-${this.session.roomId}`, { label: LABEL, serialization: 'json', reliable: true });
      if (!connection || typeof connection.on !== 'function') throw peerProblem({ type: 'disconnected' });
      this._bindConnection(connection, false);
      connection.on('open', () => {
        if (this._closed || !this._records.has(connection)) { this._closeConnection(connection); return; }
        try {
          // Do not put this capability in connect().metadata: the broker sees
          // metadata. The already-open data channel is encrypted peer to peer.
          this._sendPacket(connection, { kind: 'join', roomSecret: this.session.roomSecret, participantSecret: this.session.participantSecret, name: this.session.name });
        } catch (error) { rejectJoin(error); this._closeConnection(connection); }
      });
    } catch (error) { rejectJoin(peerProblem(error)); }
    return promise.finally(() => {
      clearTimeout(timer);
      if (this._joining === joining) this._joining = null;
    });
  }

  async poll(after = 0) {
    if (!Number.isSafeInteger(after) || after < 0) throw problem('Invalid message cursor.', 400);
    if (this._closed) return { events: [], cursor: Math.max(after, this._counter), participants: this._roster(), closed: true };
    if (this._fatalError) throw this._fatalError;
    if (!this.session) throw problem('Enter a room first.', 401);
    if (after < this._droppedThrough) throw problem('Too many connection updates arrived while this tab was paused. Use Reconnect to start the call again.');
    if (this._serviceError && !this._connection?.open && !this._brokerOpen) throw this._serviceError;
    while (this._events.length && this._events[0].event.id <= after) this._queueBytes -= this._events.shift().bytes;
    const events = this._events.filter((entry) => entry.event.id > after).slice(0, 100).map((entry) => entry.event);
    return { events, cursor: events.length ? events[events.length - 1].id : after, participants: this._roster(), closed: false };
  }

  async send(payload) {
    if (this._closed || !this.session) throw problem('This room has ended. Open the invitation again.', 410);
    const clean = signalPayload(payload);
    if (!this._connection?.open || !this._records.get(this._connection)?.authenticated) {
      // The host creates media slots before a guest arrives. The host's UI
      // retries its media connection after polling the peer-joined event.
      if (this.session.role === 'host') return { ok: true };
      throw problem('The link to your partner is offline. Use Reconnect to try again.');
    }
    this._sendPacket(this._connection, { kind: 'signal', payload: clean });
    return { ok: true };
  }

  async reconnect(iceServers = this._iceServers) {
    if (this._closed || !this.session) throw problem('This room has ended. Open the invitation again.', 410);
    this._iceServers = iceServers;
    this._fatalError = null;
    this._clearPeerEvents();
    // PeerJS exposes options through a public getter; its Negotiator reads
    // provider.options.config each time it creates a new RTCPeerConnection.
    // Update both future transports and the currently established transport.
    if (this._peer?.options) this._peer.options.config = { ...this._peer.options.config, iceServers };
    if (this._connection?.open && this._records.get(this._connection)?.authenticated) {
      this._connection.peerConnection?.setConfiguration({ iceServers });
      return this._snapshot();
    }
    if (!this._peer || this._peer.destroyed) await this._openPeer(this.session.participantId);
    else if (!this._brokerOpen || this._peer.disconnected) {
      if (this._peer.disconnected) this._peer.reconnect();
      await this._waitForBroker();
    }
    this._serviceError = null;
    if (this.session.role === 'guest') return this._connectGuest();
    return this._snapshot();
  }

  async resume() {
    throw problem('Portable rooms last while their tabs stay open. Create a new room, or reopen your partner’s invitation.', 410);
  }

  async leave() {
    if (this._closed && !this._peer) return { ok: true };
    let sentLeave = false;
    try {
      if (this._connection?.open && this._records.get(this._connection)?.authenticated) {
        this._sendPacket(this._connection, { kind: 'leave', closed: this.session?.role === 'host' && !this.session.shared });
        sentLeave = true;
      }
    } catch { /* Local cleanup does not depend on an already-failed network. */ }
    this._closed = true;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    this._flushBrokerWaiters(problem('This room has ended.', 410));
    if (this._joining) this._joining.reject(problem('This room has ended.', 410));
    // Give the ordered leave packet a chance to leave the RTCDataChannel
    // before destroying its transport, so the guest sees a closed room.
    if (sentLeave && !this.session?.shared) await new Promise((resolve) => setTimeout(resolve, 150));
    for (const connection of [...this._records.keys()]) this._closeConnection(connection);
    const peer = this._peer;
    this._peer = null;
    this._brokerOpen = false;
    this._remote = null;
    this._clearPeerEvents();
    try { peer?.destroy(); } catch { /* Destroying an already-closed peer is safe. */ }
    return { ok: true };
  }
}
