/*
 * Two-person, four-track WebRTC transport. The host creates the media slots in
 * a fixed order; the guest adopts those slots from the first offer. This keeps
 * the microphone separate from shared-tab audio throughout renegotiation.
 * Signaling payloads are { description: RTCSessionDescriptionInit } or
 * { candidate: RTCIceCandidateInit | null }. No media passes through signaling.
 */

const DEFAULT_ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
];
const SLOT_KINDS = ["video", "audio", "video", "audio"];
const CONTROL_KEY = "__cozyWatchControl";
const MAX_MESSAGE_BYTES = 24 * 1024;

function liveTrack(stream, kind) {
  return stream?.getTracks().find((track) => track.kind === kind && track.readyState === "live") ?? null;
}

function stopTracks(stream) {
  stream?.getTracks().forEach((track) => track.stop());
}

function asError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

export class WatchConnection extends EventTarget {
  constructor({ role, sendSignal, iceServers = DEFAULT_ICE_SERVERS } = {}) {
    super();
    if (role !== "host" && role !== "guest") throw new Error("A watch connection needs a host or guest role.");
    if (typeof sendSignal !== "function") throw new Error("A signaling sender is required.");
    if (typeof RTCPeerConnection === "undefined") throw new Error("This browser does not support video calls. Open the room in Brave or Chrome.");

    this.role = role;
    this.polite = role === "guest";
    this.sendSignal = sendSignal;
    this._iceServers = iceServers;
    this._generation = 0;
    this.state = "connecting";
    this.closed = false;
    this.localCamera = new MediaStream();
    this.localScreen = null;
    this.remoteCamera = new MediaStream();
    this.remoteScreen = null;
    this.devices = { camera: false, mic: false };
    this.remoteDevices = { camera: false, mic: false };
    this._screenTransport = new MediaStream();
    this._remoteScreenTransport = new MediaStream();
    this._remoteScreenActive = null;
    this._slots = [];
    this._makingOffer = false;
    this._ignoreOffer = false;
    this._settingRemoteAnswer = false;
    this._incoming = Promise.resolve();
    this._outgoing = Promise.resolve();
    this._mediaQueue = Promise.resolve();
    this._pendingCandidates = [];
    this._remoteIceFragments = new Set();
    this._pendingLocalCandidates = [];
    this._publishingDescription = false;
    this._deviceRequest = null;
    this._screenRequest = null;
    this._disconnectTimer = null;
    this._channel = null;

    this._createConnection();
  }

  _createConnection() {
    const generation = this._generation;
    this.connection = new RTCPeerConnection({ iceServers: this._iceServers, bundlePolicy: "max-bundle" });
    const pc = this.connection;
    pc.onicecandidate = ({ candidate }) => {
      if (this.closed || this.connection !== pc) return;
      const payload = { candidate: candidate?.toJSON() ?? null };
      if (this._publishingDescription) this._pendingLocalCandidates.push(payload);
      else this._signal(payload, generation).catch((error) => this._emit("error", asError(error)));
    };
    pc.onnegotiationneeded = () => {
      // A guest waits for the host's first offer, so it never invents its own
      // transceiver ordering or races a media-free initial offer.
      if (this.connection !== pc || (this.role === "guest" && !pc.remoteDescription)) return;
      this._negotiate().catch((error) => this._emit("error", asError(error)));
    };
    pc.ontrack = (event) => this._receiveTrack(event, pc);
    pc.ondatachannel = ({ channel }) => this._attachChannel(channel, pc);
    pc.onconnectionstatechange = () => this._connectionStateChanged(pc);
    pc.oniceconnectionstatechange = () => {
      // Some browsers report a useful ICE failure before the overall state.
      if (this.connection === pc && pc.iceConnectionState === "failed") this._setState("failed");
    };

    if (this.role === "host") {
      this._slots = SLOT_KINDS.map((kind, index) => pc.addTransceiver(kind, {
        direction: "sendrecv",
        streams: [index < 2 ? this.localCamera : this._screenTransport],
      }));
      this._attachChannel(pc.createDataChannel("cozy-watch", { ordered: true }), pc);
    }
  }

  _emit(type, detail) {
    if (!this.closed) this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  _setState(state) {
    if (this.state === state || this.closed) return;
    this.state = state;
    this._emit("state", state);
  }

  _assertOpen() {
    if (this.closed) throw new Error("This room connection has ended.");
  }

  get messagesReady() {
    return !this.closed && this.connection.connectionState === "connected" && this._channel?.readyState === "open";
  }

  _syncState(pc = this.connection) {
    if (this.closed || this.connection !== pc) return;
    const state = pc.connectionState;
    if (state === "failed") this._setState("failed");
    else if (state === "disconnected" || state === "closed" || ["closing", "closed"].includes(this._channel?.readyState)) this._setState("disconnected");
    else if (this.messagesReady) {
      const becameConnected = this.state !== "connected";
      this._setState("connected");
      // The media transport may become ready after the channel's open event.
      // Publish device state at either ordering's first usable connection.
      if (becameConnected) this._sendControl();
    } else this._setState("connecting");
  }

  _signal(payload, generation = this._generation) {
    const operation = this._outgoing.catch(() => {}).then(() => {
      if (!this.closed && generation === this._generation) return this.sendSignal(payload);
    });
    this._outgoing = operation;
    return operation;
  }

  async _publishDescription(pc = this.connection) {
    const generation = this._generation;
    this._publishingDescription = true;
    try {
      await pc.setLocalDescription();
      if (this.closed || this.connection !== pc) return;
      await this._signal({ description: pc.localDescription.toJSON() }, generation);
    } finally {
      if (this.connection === pc) {
        this._publishingDescription = false;
        const candidates = this._pendingLocalCandidates.splice(0);
        for (const payload of candidates) {
          this._signal(payload, generation).catch((error) => this._emit("error", asError(error)));
        }
      }
    }
  }

  async _negotiate() {
    const pc = this.connection;
    if (this.closed || this._makingOffer || pc.signalingState !== "stable") return;
    try {
      this._makingOffer = true;
      await this._publishDescription(pc);
    } catch (error) {
      if (!this.closed && this.connection === pc) throw error;
    } finally {
      if (this.connection === pc) this._makingOffer = false;
    }
  }

  async receiveSignal(payload) {
    if (this.closed) return;
    const generation = this._generation;
    const operation = this._incoming.then(() => generation === this._generation ? this._receiveSignal(payload) : undefined);
    // Keep the incoming queue usable after a malformed message or a transient
    // failure. The caller still receives the rejection for that message.
    this._incoming = operation.catch((error) => {
      if (generation === this._generation) this._emit("error", asError(error));
    });
    return operation;
  }

  async _receiveSignal(payload) {
    if (this.closed || !payload || typeof payload !== "object") return;
    const pc = this.connection;
    if (payload.description) {
      const description = payload.description;
      if (!["offer", "answer"].includes(description.type) || typeof description.sdp !== "string") {
        throw new Error("Received an invalid connection description.");
      }
      const readyForOffer = !this._makingOffer && (pc.signalingState === "stable" || this._settingRemoteAnswer);
      const offerCollision = description.type === "offer" && !readyForOffer;
      this._ignoreOffer = !this.polite && offerCollision;
      if (this._ignoreOffer) return;

      this._settingRemoteAnswer = description.type === "answer";
      try {
        // A polite peer's setRemoteDescription(offer) rolls back a colliding
        // local offer automatically in current Chromium/Firefox browsers.
        await pc.setRemoteDescription(description);
      } finally {
        if (this.connection === pc) this._settingRemoteAnswer = false;
      }
      if (this.closed || this.connection !== pc) return;
      this._remoteIceFragments = new Set([...description.sdp.matchAll(/^a=ice-ufrag:([^\r\n]+)/gm)].map((match) => match[1]));
      this._slots = pc.getTransceivers().slice(0, SLOT_KINDS.length);
      if (this._slots.length !== SLOT_KINDS.length || this._slots.some((slot, index) => slot.receiver.track.kind !== SLOT_KINDS[index])) {
        throw new Error("The other room participant has an incompatible media connection. Refresh both rooms.");
      }
      for (const slot of this._slots) slot.direction = "sendrecv";
      await this._applyLocalTracks();
      if (this.closed || this.connection !== pc) return;
      const candidates = this._pendingCandidates.splice(0);
      for (const candidate of candidates) {
        if (this.closed || this.connection !== pc) return;
        await this._addCandidate(candidate, pc);
      }
      if (description.type === "offer" && this.connection === pc) await this._publishDescription(pc);
    } else if (Object.prototype.hasOwnProperty.call(payload, "candidate")) {
      if (this._ignoreOffer) return;
      if (!pc.remoteDescription) this._pendingCandidates.push(payload.candidate);
      else await this._addCandidate(payload.candidate, pc);
    }
  }

  async _addCandidate(candidate, pc = this.connection) {
    // Polling can deliver a late candidate from an earlier ICE restart. A
    // candidate's username fragment identifies the SDP generation it belongs
    // to; discard stale generations rather than failing the new connection.
    if (candidate?.usernameFragment && this._remoteIceFragments.size && !this._remoteIceFragments.has(candidate.usernameFragment)) return;
    try {
      await pc.addIceCandidate(candidate);
    } catch (error) {
      // Candidates from an ignored glare offer do not belong to our accepted
      // description. Every other error is surfaced instead of being hidden.
      if (!this._ignoreOffer && !this.closed && this.connection === pc) throw error;
    }
  }

  _receiveTrack({ track, transceiver }, pc = this.connection) {
    if (this.connection !== pc) return;
    const index = pc.getTransceivers().indexOf(transceiver);
    if (index < 0 || index >= SLOT_KINDS.length) return;
    const stream = index < 2 ? this.remoteCamera : this._remoteScreenTransport;
    // Keep at most one track of each kind in each preview after a renegotiation.
    for (const existing of stream.getTracks()) {
      if (existing.kind === track.kind && existing !== track) stream.removeTrack(existing);
    }
    if (!stream.getTracks().includes(track)) stream.addTrack(track);
    const update = () => {
      if (this.connection !== pc) return;
      if (index < 2) this._emit("remote-camera", stream);
      else this._updateRemoteScreen();
    };
    track.addEventListener("unmute", update);
    track.addEventListener("ended", () => {
      stream.removeTrack(track);
      update();
    });
    update();
  }

  _updateRemoteScreen() {
    const stream = this._remoteScreenTransport;
    const video = liveTrack(stream, "video");
    const active = this._remoteScreenActive === true || (this._remoteScreenActive !== false && video && !video.muted);
    this.remoteScreen = active && video ? stream : null;
    this._emit("remote-screen", this.remoteScreen);
  }

  _attachChannel(channel, pc = this.connection) {
    if (this.closed || this.connection !== pc) { channel.close(); return; }
    const previous = this._channel;
    this._channel = channel;
    if (previous && previous !== channel) {
      previous.onopen = previous.onclose = previous.onclosing = previous.onmessage = previous.onerror = null;
      previous.close();
    }
    const isCurrent = () => !this.closed && this.connection === pc && this._channel === channel;
    channel.onopen = () => {
      if (!isCurrent()) return;
      const wasConnected = this.state === "connected";
      this._syncState(pc);
      // A replacement channel can arrive already open while media remains
      // connected. Its partner still needs our current device state.
      if (wasConnected) this._sendControl();
    };
    channel.onclose = channel.onclosing = () => {
      if (isCurrent()) this._syncState(pc);
    };
    channel.onerror = () => {
      if (!isCurrent()) return;
      // Recover a broken control channel explicitly, keeping camera and tab
      // captures running so Reconnect can reuse their granted permissions.
      channel.close();
      this._syncState(pc);
      this._emit("error", new Error("The chat connection was interrupted. Use Reconnect to try again."));
    };
    channel.onmessage = ({ data }) => {
      if (!isCurrent()) return;
      if (typeof data !== "string" || data.length > MAX_MESSAGE_BYTES) return;
      let payload;
      try { payload = JSON.parse(data); } catch { return; }
      if (payload && typeof payload === "object" && payload[CONTROL_KEY] === true) {
        this.remoteDevices = {
          camera: typeof payload.camera === "boolean" ? payload.camera : this.remoteDevices.camera,
          mic: typeof payload.mic === "boolean" ? payload.mic : this.remoteDevices.mic,
        };
        this._emit("remote-device-state", { ...this.remoteDevices });
        if (typeof payload.screen === "boolean") {
          this._remoteScreenActive = payload.screen;
          this._updateRemoteScreen();
        }
      } else {
        this._emit("message", payload);
      }
    };
    if (channel.readyState === "open") channel.onopen();
    else this._syncState(pc);
  }

  sendMessage(payload) {
    if (!this.messagesReady || this._channel.bufferedAmount > 256 * 1024) return false;
    try {
      const text = JSON.stringify(payload);
      if (typeof text !== "string" || new TextEncoder().encode(text).length > MAX_MESSAGE_BYTES) return false;
      this._channel.send(text);
      return true;
    } catch {
      return false;
    }
  }

  _sendControl() {
    this.sendMessage({ [CONTROL_KEY]: true, screen: !!liveTrack(this.localScreen, "video"), ...this.devices });
  }

  async _applyLocalTracks() {
    const pc = this.connection;
    const operation = this._mediaQueue.catch(() => {}).then(async () => {
      if (this.closed || this.connection !== pc || this._slots.length !== SLOT_KINDS.length) return;
      const tracks = [
        liveTrack(this.localCamera, "video"),
        liveTrack(this.localCamera, "audio"),
        liveTrack(this.localScreen, "video"),
        liveTrack(this.localScreen, "audio"),
      ];
      await Promise.all(this._slots.map(async ({ sender }, index) => {
        sender.setStreams(index < 2 ? this.localCamera : this._screenTransport);
        if (sender.track !== tracks[index]) {
          try { await sender.replaceTrack(tracks[index]); }
          catch (error) { if (!this.closed && this.connection === pc) throw error; else return; }
        }
        // These are quality hints, not prerequisites for successful capture.
        // Avoid changing codecs, which would unnecessarily renegotiate a share.
        if (tracks[index]) {
          try {
            const parameters = sender.getParameters();
            if (!parameters.encodings?.length) return;
            parameters.encodings[0].maxBitrate = [800_000, 64_000, 4_000_000, 192_000][index];
            if (tracks[index].kind === "video") parameters.encodings[0].maxFramerate = index === 2 ? 30 : 24;
            await sender.setParameters(parameters);
          } catch { /* Some browsers restrict parameters until media starts. */ }
        }
      }));
    });
    this._mediaQueue = operation;
    return operation;
  }

  async startDevices({ camera = true, mic = true } = {}) {
    this._assertOpen();
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera and microphone access needs a secure HTTPS page in Brave or Chrome.");
    if (this._deviceRequest) return this._deviceRequest;
    const needCamera = camera && !liveTrack(this.localCamera, "video");
    const needMic = mic && !liveTrack(this.localCamera, "audio");
    // Invoke capture before the first await, preserving the initiating click.
    const capture = needCamera || needMic ? navigator.mediaDevices.getUserMedia({
      video: needCamera ? { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24, max: 30 }, facingMode: "user" } : false,
      audio: needMic ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true } : false,
    }) : Promise.resolve(null);
    this._deviceRequest = (async () => {
      let captured;
      try {
        captured = await capture;
        if (this.closed) { stopTracks(captured); return this.localCamera; }
        for (const track of captured?.getTracks() ?? []) {
          for (const old of this.localCamera.getTracks()) {
            if (old.kind === track.kind) { this.localCamera.removeTrack(old); old.stop(); }
          }
          this.localCamera.addTrack(track);
          track.addEventListener("ended", () => {
            if (!this.localCamera.getTracks().includes(track)) return;
            this.localCamera.removeTrack(track);
            this._updateDevices();
            this._emit("local-camera", this.localCamera);
            this._applyLocalTracks().catch((error) => this._emit("error", asError(error)));
          });
        }
        const video = liveTrack(this.localCamera, "video");
        const audio = liveTrack(this.localCamera, "audio");
        if (video) video.enabled = !!camera;
        if (audio) audio.enabled = !!mic;
        await this._applyLocalTracks();
        this._updateDevices();
        this._emit("local-camera", this.localCamera);
        return this.localCamera;
      } catch (error) {
        // A permission rejection leaves any already-working devices running.
        this._emit("error", asError(error));
        throw error;
      } finally {
        this._deviceRequest = null;
      }
    })();
    return this._deviceRequest;
  }

  _updateDevices() {
    this.devices = {
      camera: !!liveTrack(this.localCamera, "video")?.enabled,
      mic: !!liveTrack(this.localCamera, "audio")?.enabled,
    };
    this._emit("device-state", { ...this.devices });
    this._sendControl();
  }

  setMic(enabled) {
    const track = liveTrack(this.localCamera, "audio");
    if (track) track.enabled = !!enabled;
    this._updateDevices();
    return this.devices.mic;
  }

  setCamera(enabled) {
    const track = liveTrack(this.localCamera, "video");
    if (track) track.enabled = !!enabled;
    this._updateDevices();
    return this.devices.camera;
  }

  async shareScreen() {
    this._assertOpen();
    if (!navigator.mediaDevices?.getDisplayMedia) throw new Error("Screen sharing needs desktop Brave or Chrome on a secure HTTPS page.");
    if (this._screenRequest) return this._screenRequest;
    // This call must run directly from Share's click handler. The browser asks
    // the user to choose a tab and to check its Share tab audio checkbox.
    const capture = navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: "browser", width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 30 } },
      audio: { suppressLocalAudioPlayback: false, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      selfBrowserSurface: "exclude",
      systemAudio: "exclude",
      surfaceSwitching: "include",
      preferCurrentTab: false,
    });
    this._screenRequest = (async () => {
      let captured;
      try {
        captured = await capture;
        if (this.closed) { stopTracks(captured); return null; }
        const video = liveTrack(captured, "video");
        if (!video) { stopTracks(captured); throw new Error("The selected source did not provide a video track."); }
        video.contentHint = "motion";
        const old = this.localScreen;
        this.localScreen = captured;
        for (const track of this._screenTransport.getTracks()) this._screenTransport.removeTrack(track);
        captured.getTracks().forEach((track) => this._screenTransport.addTrack(track));
        video.addEventListener("ended", () => {
          if (this.localScreen === captured) this.stopScreen();
        });
        await this._applyLocalTracks();
        stopTracks(old);
        this._emit("local-screen", captured);
        this._emit("screen-audio", !!liveTrack(captured, "audio"));
        this._sendControl();
        return captured;
      } catch (error) {
        if (captured && captured !== this.localScreen) stopTracks(captured);
        this._emit("error", asError(error));
        throw error;
      } finally {
        this._screenRequest = null;
      }
    })();
    return this._screenRequest;
  }

  stopScreen() {
    const old = this.localScreen;
    this.localScreen = null;
    for (const track of this._screenTransport.getTracks()) this._screenTransport.removeTrack(track);
    stopTracks(old);
    this._emit("local-screen", null);
    this._emit("screen-audio", false);
    this._sendControl();
    this._applyLocalTracks().catch((error) => this._emit("error", asError(error)));
  }

  _connectionStateChanged(pc = this.connection) {
    if (this.closed || this.connection !== pc) return;
    clearTimeout(this._disconnectTimer);
    this._disconnectTimer = null;
    this._syncState(pc);
    if (pc.connectionState === "disconnected") {
      // Short network interruptions often recover by themselves. If they do
      // not, the host makes one fresh ICE attempt without stopping capture.
      this._disconnectTimer = setTimeout(() => {
        if (!this.closed && this.connection === pc && pc.connectionState === "disconnected" && this.role === "host") {
          pc.restartIce();
        }
      }, 6_000);
    }
  }

  async retry() {
    this._assertOpen();
    this._setState("connecting");
    if (this.connection.signalingState === "have-local-offer" && this.connection.localDescription) {
      // A room may have been created before the guest joined its polling feed.
      // Resend the unanswered offer. localDescription now includes any ICE
      // candidates gathered since the initial offer, so a late guest receives
      // a complete starting description even if it missed candidate messages.
      await this._signal({ description: this.connection.localDescription.toJSON() });
      return;
    }
    this.connection.restartIce();
    // restartIce schedules negotiationneeded. An explicit attempt also works
    // when the user retries before a peer has joined and negotiation is idle.
    if (this.role === "host" || this.connection.remoteDescription) await this._negotiate();
  }

  async reset({ iceServers } = {}) {
    this._assertOpen();
    if (iceServers !== undefined) this._iceServers = iceServers;
    // A refreshed/replaced participant has a new DTLS identity and SCTP
    // channel. Rebuild the transport while preserving our granted captures.
    // Generation guards prevent an old in-flight negotiation mutating it.
    this._generation += 1;
    this._detachConnection();
    stopTracks(this.remoteCamera);
    stopTracks(this._remoteScreenTransport);
    this.remoteCamera = new MediaStream();
    this._remoteScreenTransport = new MediaStream();
    this.remoteScreen = null;
    this.remoteDevices = { camera: false, mic: false };
    this._remoteScreenActive = null;
    this._slots = [];
    this._makingOffer = false;
    this._ignoreOffer = false;
    this._settingRemoteAnswer = false;
    this._publishingDescription = false;
    this._incoming = Promise.resolve();
    this._outgoing = Promise.resolve();
    this._mediaQueue = Promise.resolve();
    this._pendingCandidates = [];
    this._pendingLocalCandidates = [];
    this._remoteIceFragments = new Set();
    this._channel = null;
    this._setState("connecting");
    this._emit("remote-camera", this.remoteCamera);
    this._emit("remote-screen", null);
    this._emit("remote-device-state", { ...this.remoteDevices });
    this._createConnection();
    await this._applyLocalTracks();
  }

  _detachConnection() {
    clearTimeout(this._disconnectTimer);
    this._disconnectTimer = null;
    if (this._channel) {
      this._channel.onopen = this._channel.onclose = this._channel.onclosing = this._channel.onmessage = this._channel.onerror = null;
      this._channel.close();
    }
    const pc = this.connection;
    pc.onicecandidate = pc.onnegotiationneeded = pc.ontrack = pc.ondatachannel = pc.onconnectionstatechange = pc.oniceconnectionstatechange = null;
    pc.close();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this._generation += 1;
    this._detachConnection();
    stopTracks(this.localCamera);
    stopTracks(this.localScreen);
    stopTracks(this.remoteCamera);
    stopTracks(this._remoteScreenTransport);
    this.localScreen = null;
    this.remoteScreen = null;
    this._pendingCandidates.length = 0;
    this._pendingLocalCandidates.length = 0;
    this.state = "disconnected";
    this.devices = { camera: false, mic: false };
  }
}
