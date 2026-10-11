import { WatchConnection } from './rtc.js';
import { ReactionSounds } from './reaction-sounds.js';
import { initWatchLayout } from './layout.js';

const $ = (id) => document.getElementById(id);
const SESSION_PREFIX = 'sofa:room:';
const extensionMode = location.protocol === 'chrome-extension:';
const portableMode = extensionMode || document.querySelector('meta[name="watchroom-transport"]')?.content === 'peerjs' || new URLSearchParams(location.search).get('portable') === '1';
const watchLayout = initWatchLayout();
let portableClient = null;
let entryMode = new URLSearchParams(location.hash.slice(1)).has('room') ? 'join' : 'make';
const reactionTypes = {
  heart: { glyph: '♡', description: 'sent a heart', own: 'You sent a heart.', caption: 'Heart sent.' },
  poke: { glyph: '☞', description: 'poked you', own: 'You sent a poke.', caption: 'Poke sent.' },
  tease: { glyph: '😏', description: 'sent a tease', own: 'You sent a tease.', caption: 'Tease sent.' },
  popcorn: { glyph: '🍿', description: 'sent popcorn', own: 'You sent popcorn.', caption: 'Popcorn sent.' },
  fart: { glyph: '💨', description: 'sent a fart', own: 'You sent a fart.', caption: 'Fart sent.', soundKind: 'fart' },
  awake: { glyph: '👀', description: 'asked: Are you awake?', own: 'You asked: Are you awake?', caption: 'Are you awake?', soundKind: 'awake' },
  blankets: { glyph: '🛌', description: 'stole the blankets', own: 'You stole the blankets.', caption: 'Blankets stolen.', soundKind: 'blankets' },
  'awake-reply': { glyph: '✓', description: 'is awake', own: 'You replied: I’m awake.', caption: 'Reply sent.', soundKind: 'awake-reply' },
};

let session = null;
let rtc = null;
let peer = null;
let cursor = 0;
let polling = false;
let pollTimer = null;
let activePoll = null;
let pollFailures = 0;
let deviceState = { camera: false, mic: false };
let remoteDeviceState = { camera: false, mic: false };
let localScreen = null;
let remoteScreen = null;
let screenAudio = false;
let countdownTimer = null;
let toastTimer = null;
let rtcGeneration = 0;
let recentMessages = new Set();

const storage = {
  read(key) { try { return JSON.parse(sessionStorage.getItem(key)); } catch { return null; } },
  write(key, value) { try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* Rooms still work if browser storage is blocked. */ } },
  remove(key) { try { sessionStorage.removeItem(key); } catch { /* Storage is optional. */ } },
};

let reactionSoundsEnabled = storage.read('sofa:reaction-sounds') !== false;
const reactionSounds = new ReactionSounds();
reactionSounds.setEnabled(reactionSoundsEnabled);

async function enableReactionAudio() {
  if (!reactionSoundsEnabled) return false;
  try {
    const enabled = await reactionSounds.enable();
    $('enable-reaction-audio').hidden = !!enabled;
    return !!enabled;
  } catch {
    $('enable-reaction-audio').hidden = false;
    return false;
  }
}

async function playReactionSound(kind, requested) {
  if (!kind || requested !== true || !reactionSoundsEnabled) return;
  try {
    const played = await reactionSounds.play(kind);
    if (!played && reactionSounds.context?.state !== 'running') $('enable-reaction-audio').hidden = false;
  } catch { $('enable-reaction-audio').hidden = false; }
}

function invitation() {
  const params = new URLSearchParams(location.hash.slice(1));
  const roomId = params.get('room');
  const roomSecret = params.get('key');
  return roomId && roomSecret ? { roomId, roomSecret } : null;
}

function setLandingMode() {
  const invite = invitation();
  if (portableMode && invite && !$('room-code').value) $('room-code').value = `SOFA:${invite.roomId}:${invite.roomSecret}`;
  const joining = portableMode ? entryMode === 'join' : !!invite;
  $('seat-title').textContent = joining ? 'Join room' : 'Make room';
  $('seat-description').textContent = joining ? extensionMode ? 'Paste your partner’s room code.' : invite ? 'Enter your name to join.' : 'Paste your partner’s invitation link.' : extensionMode ? 'Create a room and send your partner its code.' : 'Create a room and send your partner the invite.';
  $('entry-button').querySelector('span').textContent = joining ? 'Join room' : 'Make room';
  $('portable-room-toggle').hidden = !portableMode;
  $('room-code-field').hidden = !portableMode || !joining || (!extensionMode && !!invite);
  $('room-code').required = portableMode && joining;
  for (const [id, mode] of [['make-room-tab', 'make'], ['join-room-tab', 'join']]) {
    $(id).classList.toggle('selected', entryMode === mode);
    $(id).setAttribute('aria-pressed', String(entryMode === mode));
  }
  const rememberedName = storage.read('sofa:name');
  if (typeof rememberedName === 'string' && !$('name').value) $('name').value = rememberedName.slice(0, 32);
}

function saveSession() {
  if (!session || portableMode) return;
  storage.write(`${SESSION_PREFIX}${session.roomId}`, { ...session, cursor });
  storage.write('sofa:last-room', session.roomId);
}

function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6500);
}

function readableError(error) {
  if (error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError') return 'Permission wasn’t granted. You can turn on your camera, mic, or screen sharing whenever you’re ready.';
  if (error?.name === 'NotFoundError' || error?.name === 'DevicesNotFoundError') return 'No camera or microphone was found. You can still share a tab and chat.';
  if (error?.name === 'NotReadableError') return 'Your camera or microphone is busy. Close any other app using it and try again.';
  return error?.message || 'Something interrupted the connection. Please try again.';
}

async function api(path, { method = 'GET', body, signal, authenticated = true } = {}) {
  if (portableMode) throw new Error('This room uses its direct connection instead of a website service.');
  const headers = { 'Content-Type': 'application/json' };
  if (authenticated && session) {
    headers.Authorization = `Bearer ${session.participantSecret}`;
    headers['X-Participant-ID'] = session.participantId;
  }
  const response = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal, cache: 'no-store' });
  let data;
  try { data = await response.json(); } catch { data = {}; }
  if (!response.ok) {
    const error = new Error(data.error || data.message || 'The room couldn’t be reached. Please try again.');
    error.status = response.status;
    throw error;
  }
  return data;
}

function iceServers() {
  const base = session?.iceServers ?? [{ urls: 'stun:stun.l.google.com:19302' }];
  const turn = storage.read('sofa:turn');
  return turn?.url ? [...base, { urls: turn.url, username: turn.username || '', credential: turn.password || '' }] : base;
}

function postEvent(payload) {
  if (!session) return Promise.reject(new Error('Enter a room first.'));
  if (portableMode) return portableClient.send(payload);
  return api(`/api/rooms/${encodeURIComponent(session.roomId)}/events`, { method: 'POST', body: { payload } });
}

async function getPortableClient() {
  if (!portableClient) {
    const { PortableRoomClient } = await import('./portable.js');
    portableClient = new PortableRoomClient();
    portableClient.addEventListener('warning', (event) => { toast(readableError(event.detail)); });
  }
  return portableClient;
}

function roomCode() {
  const text = $('room-code').value.trim();
  const match = text.match(/^SOFA:([a-f\d]{16,128}):([a-f\d]{16,256})$/i);
  if (match) return { roomId: match[1].toLowerCase(), roomSecret: match[2].toLowerCase() };
  try {
    const params = new URLSearchParams(new URL(text).hash.slice(1));
    const roomId = params.get('room');
    const roomSecret = params.get('key');
    if (roomId && roomSecret && /^[a-f\d]+$/i.test(roomId) && /^[a-f\d]+$/i.test(roomSecret)) return { roomId, roomSecret };
  } catch { /* Show one clear validation message below. */ }
  throw new Error(extensionMode ? 'Paste the complete private room code your partner sent. It begins with SOFA:.' : 'Paste the complete invitation link or room code your partner sent.');
}

function updateConnection() {
  const status = $('connection-status');
  const state = rtc?.state || 'connecting';
  const connected = !!peer && state === 'connected';
  let label = portableMode && session?.role === 'guest' ? 'Partner disconnected' : 'Waiting for partner';
  if (peer) {
    label = connected ? 'Connected' : state === 'failed' ? 'Call couldn’t connect' : state === 'disconnected' ? 'Call interrupted' : 'Connecting…';
  }
  status.replaceChildren(Object.assign(document.createElement('span'), {}), document.createTextNode(label));
  status.className = `connection-status${connected ? ' connected' : peer && ['failed', 'disconnected'].includes(state) ? ' error' : ''}`;
  $('reconnect-button').hidden = connected || (!peer && !(portableMode && session?.role === 'guest'));
  document.querySelectorAll('[data-reaction]').forEach((button) => { button.disabled = !connected; });
  $('chat-input').disabled = !connected;
  $('chat-form').querySelector('button').disabled = !connected;
  $('chat-input').placeholder = connected ? 'Message your partner' : 'Connect with your partner first';
  $('countdown-button').disabled = !connected || !!countdownTimer;
  $('remote-status').textContent = !peer ? 'waiting' : connected ? 'connected' : 'connecting';
  if (!peer) $('remote-placeholder-text').textContent = 'Waiting for partner';
  else $('remote-placeholder-text').textContent = remoteDeviceState.camera ? 'Connecting camera…' : 'Camera is off';
}

function updateRoster(participants) {
  if (!Array.isArray(participants) || !session) return;
  const nextPeer = participants.find((participant) => participant.id !== session.participantId) || null;
  const oldId = peer?.id;
  peer = nextPeer;
  $('remote-name').textContent = peer?.name || 'Partner';
  $('remote-initial').textContent = peer?.name?.slice(0, 1).toUpperCase() || 'P';
  if (oldId && !peer) {
    appendSystem('Your partner left the room.');
    remoteDeviceState = { camera: false, mic: false };
    remoteScreen = null;
    $('remote-camera').srcObject = null;
    $('remote-camera-placeholder').hidden = false;
    renderScreen();
  }
  updateConnection();
  return { changed: oldId !== peer?.id, oldId, newId: peer?.id };
}

function updateDeviceState(state) {
  deviceState = { camera: !!state.camera, mic: !!state.mic };
  const micLabel = deviceState.mic ? 'Mute microphone' : 'Turn microphone on';
  const cameraLabel = deviceState.camera ? 'Turn camera off' : 'Turn camera on';
  for (const [id, enabled, label] of [['mic-button', deviceState.mic, micLabel], ['camera-button', deviceState.camera, cameraLabel]]) {
    $(id).setAttribute('aria-pressed', String(enabled));
    $(id).setAttribute('aria-label', label);
    $(id).title = label;
  }
  $('local-mic-state').className = deviceState.mic ? '' : 'muted';
  $('local-mic-state').setAttribute('aria-label', deviceState.mic ? 'Microphone on' : 'Microphone muted');
  $('local-camera-placeholder').hidden = deviceState.camera;
}

function attachMedia(video, stream, { muted = false, soundButton } = {}) {
  if (video.srcObject !== stream) video.srcObject = stream;
  video.muted = muted;
  if (!stream) {
    if (soundButton) $(soundButton).hidden = true;
    return;
  }
  const result = video.play();
  if (result && typeof result.then === 'function') result.then(() => {
    if (soundButton) $(soundButton).hidden = true;
  }).catch(() => {
    if (soundButton && !muted) $(soundButton).hidden = false;
  });
}

function renderScreen() {
  const stream = localScreen || remoteScreen;
  const mine = !!localScreen;
  $('screen-empty').hidden = !!stream;
  $('screen-video').hidden = !stream;
  $('screen-indicator').className = stream ? 'active' : '';
  $('screen-label').textContent = stream ? 'SCREEN SHARE ACTIVE' : 'SCREEN SHARE';
  $('stage-owner').textContent = stream ? mine ? 'Your shared tab · preview is muted' : `${peer?.name || 'Your partner'}’s shared tab` : '';
  $('audio-status').textContent = stream ? mine ? screenAudio ? 'Tab audio is shared' : 'No tab audio selected' : 'Movie sound plays here' : '';
  const shareButton = $('share-button');
  shareButton.querySelector('span').textContent = mine ? 'Stop sharing' : remoteScreen ? 'Your partner is sharing' : 'Share a tab';
  shareButton.disabled = !!remoteScreen && !mine;
  attachMedia($('screen-video'), stream, { muted: mine, soundButton: 'enable-sound' });
  $('screen-video').volume = Number($('movie-volume').value) / 100;
  $('movie-volume').disabled = mine;
  $('movie-volume').title = mine ? 'Adjust your movie volume in the shared tab. This slider controls received movie audio.' : 'Received movie audio volume';
}

function buildConnection() {
  const generation = ++rtcGeneration;
  rtc = new WatchConnection({ role: session.role, sendSignal: postEvent, iceServers: iceServers() });
  const on = (type, handler) => rtc.addEventListener(type, (event) => { if (generation === rtcGeneration && session) handler(event.detail); });
  on('local-camera', (stream) => { attachMedia($('local-camera'), stream, { muted: true }); });
  on('remote-camera', (stream) => {
    attachMedia($('remote-camera'), stream, { soundButton: 'enable-voice' });
    $('remote-camera').volume = Number($('voice-volume').value) / 100;
    const liveVideo = stream?.getVideoTracks().some((track) => track.readyState === 'live' && !track.muted);
    $('remote-camera-placeholder').hidden = !!liveVideo && remoteDeviceState.camera;
  });
  on('device-state', updateDeviceState);
  on('remote-device-state', (state) => {
    remoteDeviceState = { camera: !!state.camera, mic: !!state.mic };
    $('remote-camera-placeholder').hidden = remoteDeviceState.camera;
    $('remote-placeholder-text').textContent = remoteDeviceState.camera ? 'Connecting camera…' : 'Camera is off';
  });
  on('local-screen', (stream) => { localScreen = stream; renderScreen(); });
  on('remote-screen', (stream) => { remoteScreen = stream; renderScreen(); });
  on('screen-audio', (hasAudio) => {
    screenAudio = hasAudio;
    renderScreen();
    if (localScreen && !hasAudio) toast('Your tab has no shared audio. Stop sharing, choose the tab again, and turn on “Share tab audio”.');
  });
  on('state', (state) => {
    updateConnection();
    if (state === 'connected') {
      appendSystem('Connected.');
    } else if (state === 'failed') toast('The call couldn’t connect across your networks. Try Reconnect, or add a TURN relay in connection settings.');
  });
  on('message', receiveMessage);
  on('error', (error) => { toast(readableError(error)); });
  updateConnection();
}

async function enterRoom(data, name, { resume = false, useDevices = false, roomSecret } = {}) {
  session = { ...data, name: name || data.name || 'You', roomSecret: data.roomSecret || roomSecret };
  cursor = Number(data.cursor) || 0;
  peer = null;
  recentMessages = new Set();
  $('local-name').textContent = session.name;
  $('local-initial').textContent = session.name.slice(0, 1).toUpperCase();
  $('landing').hidden = true;
  $('room').hidden = false;
  watchLayout.activate();
  $('entry-error').hidden = true;
  $('invite-button').disabled = !session.roomSecret;
  updateDeviceState({ camera: false, mic: false });
  updateRoster(data.participants || []);
  if (resume) {
    try { await postEvent({ kind: 'peer-ready' }); } catch (error) { toast(readableError(error)); }
  }
  buildConnection();
  saveSession();
  startPolling();
  if (resume) {
    toast('Room restored. Camera and microphone are off.');
  } else if (useDevices) {
    rtc.startDevices({ camera: true, mic: true }).catch(() => { updateDeviceState(rtc?.devices || {}); });
  }
  if (session.role === 'host' && !resume) openInvite();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function startPolling() {
  if (polling) return;
  polling = true;
  pollFailures = 0;
  poll();
}

async function poll() {
  if (!polling || !session) return;
  const roomId = session.roomId;
  activePoll = new AbortController();
  let delay = 1000;
  try {
    const data = portableMode ? await portableClient.poll(cursor) : await api(`/api/rooms/${encodeURIComponent(roomId)}/events?after=${cursor}`, { signal: activePoll.signal });
    if (!session || session.roomId !== roomId || !polling) return;
    pollFailures = 0;
    if (data.closed) { await exitRoom({ serverClosed: true }); toast('The room has ended.'); return; }
    const change = updateRoster(data.participants);
    let reset = false;
    for (const event of data.events || []) {
      cursor = Math.max(cursor, Number(event.id) || 0);
      const payload = event.payload;
      if (event.sender !== peer?.id || !payload) continue;
      if (payload.kind === 'peer-joined' && session.role === 'host') {
        reset = true;
        await (rtc.reset ? rtc.reset() : rtc.retry());
      } else if (payload.kind === 'peer-ready') {
        reset = true;
        await (rtc.reset ? rtc.reset() : rtc.retry());
      } else if (payload.description || Object.prototype.hasOwnProperty.call(payload, 'candidate')) {
        try { await rtc.receiveSignal(payload); } catch (error) { toast(readableError(error)); }
      }
    }
    cursor = Math.max(cursor, Number(data.cursor) || 0);
    saveSession();
    if (change?.changed && change.newId && session.role === 'host' && !reset) await rtc.retry();
  } catch (error) {
    if (error.name === 'AbortError') return;
    if (!polling || !session || session.roomId !== roomId) return;
    if ([401, 403, 404, 410].includes(error.status)) {
      await exitRoom({ serverClosed: true });
      toast('This invitation or room session has ended. Start a new room or ask your partner for a fresh invite.');
      return;
    }
    pollFailures += 1;
    delay = Math.min(1000 * 2 ** Math.min(pollFailures, 3), 8000);
    if (pollFailures === 3) toast('The room service is temporarily unreachable. Your call may continue; we’ll keep trying to reconnect.');
  } finally {
    activePoll = null;
    if (polling && session?.roomId === roomId) pollTimer = setTimeout(poll, delay);
  }
}

async function exitRoom({ serverClosed = false } = {}) {
  const leaving = session;
  polling = false;
  clearTimeout(pollTimer);
  activePoll?.abort();
  if (!serverClosed && leaving) {
    try {
      if (portableMode) await portableClient?.leave();
      else await api(`/api/rooms/${encodeURIComponent(leaving.roomId)}/leave`, { method: 'POST', body: {} });
    } catch { /* Stop local capture even if a network request cannot finish. */ }
  }
  if (serverClosed && portableMode) { try { await portableClient?.leave(); } catch { /* Capture still stops locally below. */ } }
  ++rtcGeneration;
  rtc?.close();
  rtc = null;
  session = null;
  if (portableMode) portableClient = null;
  peer = null;
  cursor = 0;
  localScreen = remoteScreen = null;
  clearInterval(countdownTimer);
  countdownTimer = null;
  $('countdown-overlay').hidden = true;
  for (const id of ['local-camera', 'remote-camera', 'screen-video']) $(id).srcObject = null;
  if (leaving) storage.remove(`${SESSION_PREFIX}${leaving.roomId}`);
  storage.remove('sofa:last-room');
  if (leaving?.role === 'host' || serverClosed) history.replaceState(null, '', location.pathname + location.search);
  $('room').hidden = true;
  watchLayout.deactivate();
  $('landing').hidden = false;
  document.body.classList.remove('theater-mode');
  for (const modal of document.querySelectorAll('dialog[open]')) modal.close();
  $('chat-log').replaceChildren();
  $('reaction-layer').replaceChildren();
  updateDeviceState({ camera: false, mic: false });
  renderScreen();
  setLandingMode();
}

function openInvite() {
  if (!session?.roomSecret) return;
  const url = new URL(location.href);
  url.hash = new URLSearchParams({ room: session.roomId, key: session.roomSecret }).toString();
  $('invite-link').value = extensionMode ? `SOFA:${session.roomId}:${session.roomSecret}` : url.toString();
  $('invite-description').textContent = extensionMode ? 'Both people open Watchroom. Send this code to your partner and have them choose “Join room”. Keep the code private: anyone with it can join.' : 'Send this private link to your partner. Anyone with it can take the second seat, so keep it between you.';
  $('invite-label').textContent = extensionMode ? 'Your private room code' : 'Your private invitation link';
  $('copy-status').textContent = portableMode ? 'Keep this tab open. Closing or refreshing the host’s tab ends this room.' : 'The room expires after 12 hours.';
  $('copy-invite').textContent = extensionMode ? 'Copy code' : 'Copy link';
  $('invite-dialog').showModal();
}

function appendSystem(text) {
  const log = $('chat-log');
  const message = document.createElement('div');
  message.className = 'chat-system';
  message.textContent = text;
  log.append(message);
  trimChat();
}

function trimChat() {
  const log = $('chat-log');
  while (log.children.length > 100) log.firstElementChild.remove();
  log.scrollTop = log.scrollHeight;
}

function appendChat(message, own = false) {
  $('chat-log').querySelector('.chat-welcome')?.remove();
  const entry = document.createElement('div');
  entry.className = `chat-message${own ? ' own' : ''}`;
  const metadata = document.createElement('div');
  metadata.className = 'chat-message-meta';
  const name = document.createElement('span');
  name.textContent = own ? 'You' : peer?.name || 'Partner';
  const time = document.createElement('time');
  const stamp = Number(message.time) || Date.now();
  time.textContent = new Date(stamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const text = document.createElement('div');
  text.className = 'chat-message-text';
  text.textContent = message.text.slice(0, 2000);
  metadata.append(name, time);
  entry.append(metadata, text);
  $('chat-log').append(entry);
  trimChat();
}

function showReaction(type, own = false, sound = false) {
  const reaction = reactionTypes[type];
  if (!reaction) return;
  const layer = $('reaction-layer');
  const caption = document.createElement('span');
  caption.className = 'reaction-caption';
  caption.textContent = own ? reaction.caption : `${peer?.name || 'Partner'} ${reaction.description}`;
  layer.append(caption);
  for (let index = 0; index < 5; index++) {
    const glyph = document.createElement('span');
    glyph.className = 'floating-reaction';
    glyph.textContent = reaction.glyph;
    glyph.style.left = `${18 + Math.random() * 64}%`;
    glyph.style.animationDelay = `${index * 0.12}s`;
    glyph.style.fontSize = `${30 + Math.random() * 26}px`;
    layer.append(glyph);
    setTimeout(() => glyph.remove(), 3600);
  }
  setTimeout(() => caption.remove(), 3200);
  if (type === 'blankets') {
    const sheet = document.createElement('div');
    sheet.className = 'blanket-sheet';
    layer.prepend(sheet);
    setTimeout(() => sheet.remove(), 3200);
  }
  if (type === 'poke' && !own) {
    $('screen-stage').classList.remove('poke-shake');
    requestAnimationFrame(() => { $('screen-stage').classList.add('poke-shake'); });
    setTimeout(() => $('screen-stage').classList.remove('poke-shake'), 700);
  }
  const punctuation = /[.!?]$/.test(reaction.description) ? '' : '.';
  appendSystem(own ? reaction.own : `${peer?.name || 'Partner'} ${reaction.description}${punctuation}`);
  if (type === 'awake' && !own) showAwakePrompt();
  if (type === 'awake-reply') $('awake-prompt')?.remove();
  if (own) enableReactionAudio().then(() => playReactionSound(reaction.soundKind, sound));
  else playReactionSound(reaction.soundKind, sound);
}

function showAwakePrompt() {
  $('awake-prompt')?.remove();
  const prompt = document.createElement('div');
  prompt.id = 'awake-prompt';
  prompt.className = 'wake-prompt';
  const text = document.createElement('p');
  text.textContent = `${peer?.name || 'Partner'} asked: Are you awake?`;
  const actions = document.createElement('div');
  const reply = document.createElement('button');
  reply.type = 'button';
  reply.id = 'awake-reply-button';
  reply.className = 'secondary-button small';
  reply.textContent = 'I’m awake';
  reply.addEventListener('click', () => {
    enableReactionAudio();
    const message = sendMessage({ type: 'reaction', reaction: 'awake-reply', sound: reactionSoundsEnabled });
    if (message) { showReaction('awake-reply', true, message.sound); prompt.remove(); }
  });
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'quiet-button';
  dismiss.textContent = 'Dismiss';
  dismiss.addEventListener('click', () => { prompt.remove(); });
  actions.append(reply, dismiss);
  prompt.append(text, actions);
  $('chat-log').append(prompt);
  trimChat();
}

function startCountdown(goAt) {
  if (countdownTimer) return;
  const overlay = $('countdown-overlay');
  overlay.hidden = false;
  $('countdown-button').disabled = true;
  const tick = () => {
    const remaining = goAt - Date.now();
    const seconds = Math.ceil(remaining / 1000);
    overlay.textContent = seconds > 3 ? 'Ready?' : seconds > 0 ? String(seconds) : 'Play!';
    if (remaining < -1000) {
      clearInterval(countdownTimer);
      countdownTimer = null;
      overlay.hidden = true;
      updateConnection();
    }
  };
  countdownTimer = setInterval(tick, 100);
  tick();
  appendSystem('Press play in your own streaming player at “Play!” This countdown is a shared cue; it doesn’t control playback.');
}

function receiveMessage(message) {
  if (!message || typeof message !== 'object' || typeof message.id !== 'string' || recentMessages.has(message.id)) return;
  recentMessages.add(message.id);
  if (recentMessages.size > 200) recentMessages.delete(recentMessages.values().next().value);
  if (message.type === 'chat' && typeof message.text === 'string' && message.text.length <= 2000) appendChat(message);
  else if (message.type === 'reaction' && Object.prototype.hasOwnProperty.call(reactionTypes, message.reaction)) showReaction(message.reaction, false, message.sound === true);
  else if (message.type === 'countdown' && Number.isFinite(message.goAt) && Math.abs(message.goAt - Date.now()) < 30000) startCountdown(message.goAt);
}

function sendMessage(payload) {
  if (!session || !peer || rtc?.state !== 'connected') { toast('Connect with your partner first.'); return null; }
  const message = { ...payload, id: crypto.randomUUID(), time: Date.now() };
  if (!rtc.sendMessage(message)) { toast('The chat connection isn’t ready. Try Reconnect.'); return null; }
  return message;
}

$('entry-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  enableReactionAudio();
  const name = $('name').value.trim().slice(0, 32);
  if (!name) { $('name').setCustomValidity('Enter your name.'); $('name').reportValidity(); return; }
  $('name').setCustomValidity('');
  const button = $('entry-button');
  button.disabled = true;
  $('entry-error').hidden = true;
  try {
    const invite = portableMode ? entryMode === 'join' ? roomCode() : null : invitation();
    let data;
    if (portableMode) {
      const client = await getPortableClient();
      data = await (invite ? client.join({ ...invite, name, iceServers: iceServers() }) : client.create({ name, iceServers: iceServers() }));
    } else data = await api(invite ? `/api/rooms/${encodeURIComponent(invite.roomId)}/join` : '/api/rooms', { method: 'POST', authenticated: false, body: invite ? { name, roomSecret: invite.roomSecret } : { name } });
    storage.write('sofa:name', name);
    await enterRoom(data, name, { useDevices: $('start-devices').checked, roomSecret: invite?.roomSecret });
  } catch (error) {
    if (portableMode && !session) { try { await portableClient?.leave(); } catch {} portableClient = null; }
    $('entry-error').textContent = readableError(error);
    $('entry-error').hidden = false;
  } finally { button.disabled = false; }
});
$('name').addEventListener('input', () => { $('name').setCustomValidity(''); });
$('invite-button').addEventListener('click', openInvite);
$('copy-invite').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('invite-link').value);
    $('copy-invite').textContent = 'Copied!';
    $('copy-status').textContent = extensionMode ? 'Code copied. Keep this tab open.' : portableMode ? 'Link copied. Keep this tab open.' : 'Link copied.';
  } catch {
    $('invite-link').focus();
    $('invite-link').select();
    $('copy-status').textContent = 'Select the link and press Ctrl+C (or ⌘C) to copy it.';
  }
});

function shareScreen() {
  if (!rtc) return;
  if (localScreen) { rtc.stopScreen(); return; }
  if (remoteScreen) { toast('Your partner is sharing. They need to stop before you can share.'); return; }
  // Keep capture directly in the click handler so the browser recognizes the user's gesture.
  rtc.shareScreen().catch(() => {});
}
$('share-button').addEventListener('click', shareScreen);
$('stage-share-button').addEventListener('click', shareScreen);
$('mic-button').addEventListener('click', async () => {
  if (!rtc) return;
  if (deviceState.mic) rtc.setMic(false);
  else if (rtc.localCamera?.getAudioTracks().some((track) => track.readyState === 'live')) rtc.setMic(true);
  else try { await rtc.startDevices({ camera: deviceState.camera, mic: true }); } catch { /* The media error is shown by the connection. */ }
});
$('camera-button').addEventListener('click', async () => {
  if (!rtc) return;
  if (deviceState.camera) rtc.setCamera(false);
  else if (rtc.localCamera?.getVideoTracks().some((track) => track.readyState === 'live')) rtc.setCamera(true);
  else try { await rtc.startDevices({ camera: true, mic: deviceState.mic }); } catch { /* The media error is shown by the connection. */ }
});
$('movie-volume').addEventListener('input', (event) => {
  $('screen-video').volume = Number(event.target.value) / 100;
  $('movie-volume-value').textContent = `${event.target.value}%`;
  if (localScreen) toast('Your preview is muted to avoid echo. Adjust your streaming player for your own movie volume.');
});
$('voice-volume').addEventListener('input', (event) => { $('remote-camera').volume = Number(event.target.value) / 100; });
for (const [button, video] of [['enable-sound', 'screen-video'], ['enable-voice', 'remote-camera']]) {
  $(button).addEventListener('click', async () => {
    try { $(video).muted = false; await $(video).play(); $(button).hidden = true; } catch { toast('Click the video or check your browser’s sound permission for Watchroom.'); }
  });
}
$('chat-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const text = $('chat-input').value.trim();
  if (!text) return;
  const message = sendMessage({ type: 'chat', text });
  if (message) { appendChat(message, true); $('chat-input').value = ''; $('chat-input').focus(); }
});
document.querySelectorAll('[data-reaction]').forEach((button) => button.addEventListener('click', () => {
  enableReactionAudio();
  const type = button.dataset.reaction;
  const message = sendMessage({ type: 'reaction', reaction: type, sound: reactionSoundsEnabled });
  if (message) showReaction(type, true, message.sound);
}));
$('reaction-sounds').checked = reactionSoundsEnabled;
$('reaction-sounds').addEventListener('change', (event) => {
  reactionSoundsEnabled = event.target.checked;
  reactionSounds.setEnabled(reactionSoundsEnabled);
  storage.write('sofa:reaction-sounds', reactionSoundsEnabled);
  if (reactionSoundsEnabled) enableReactionAudio();
  else $('enable-reaction-audio').hidden = true;
});
$('enable-reaction-audio').addEventListener('click', enableReactionAudio);
$('countdown-button').addEventListener('click', () => {
  if (countdownTimer) return;
  const goAt = Date.now() + 4000;
  if (sendMessage({ type: 'countdown', goAt })) startCountdown(goAt);
});
$('theater-button').addEventListener('click', () => {
  const enabled = document.body.classList.toggle('theater-mode');
  $('theater-button').setAttribute('aria-pressed', String(enabled));
  $('theater-button').setAttribute('aria-label', enabled ? 'Exit theater mode' : 'Enter theater mode');
});
$('fullscreen-button').addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await $('screen-stage').requestFullscreen();
  } catch { toast('Fullscreen isn’t available here. Use theater mode for a larger screen.'); }
});
document.addEventListener('fullscreenchange', () => { $('fullscreen-button').setAttribute('aria-label', document.fullscreenElement ? 'Exit fullscreen' : 'Enter fullscreen'); });
$('leave-button').addEventListener('click', async () => { await exitRoom(); toast('You left the room.'); });
$('reconnect-button').addEventListener('click', async () => {
  try {
    if (portableMode && portableClient?.reconnect) await portableClient.reconnect(iceServers());
    await postEvent({ kind: 'peer-ready' });
    if (rtc?.reset) await rtc.reset(); else await rtc?.retry();
    toast('Reconnecting…');
  } catch (error) { toast(readableError(error)); }
});
$('settings-button').addEventListener('click', () => {
  const turn = storage.read('sofa:turn') || {};
  $('turn-url').value = turn.url || '';
  $('turn-username').value = turn.username || '';
  $('turn-password').value = turn.password || '';
  $('settings-dialog').showModal();
});
$('settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const url = $('turn-url').value.trim();
  if (url && !/^turns?:[^\s]+$/i.test(url)) { $('turn-url').setCustomValidity('Use a TURN URL, such as turn:your-server.example:3478'); $('turn-url').reportValidity(); return; }
  $('turn-url').setCustomValidity('');
  storage.write('sofa:turn', { url, username: $('turn-username').value, password: $('turn-password').value });
  $('settings-dialog').close();
  if (rtc) {
    try {
      if (portableMode && portableClient?.reconnect) await portableClient.reconnect(iceServers());
      await postEvent({ kind: 'peer-ready' });
      if (rtc.reset) await rtc.reset({ iceServers: iceServers() }); else { rtc.connection.setConfiguration({ iceServers: iceServers() }); await rtc.retry(); }
      toast('Connection settings saved. Reconnecting your call…');
    } catch (error) { toast(readableError(error)); }
  } else toast('Connection settings saved for this browser tab.');
});
$('turn-url').addEventListener('input', () => { $('turn-url').setCustomValidity(''); });
for (const modal of document.querySelectorAll('dialog')) modal.addEventListener('click', (event) => {
  if (event.target === modal) {
    const rect = modal.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) modal.close();
  }
});
window.addEventListener('hashchange', () => {
  if (!session) {
    if (portableMode && invitation()) { entryMode = 'join'; $('room-code').value = ''; }
    setLandingMode();
  }
});
window.addEventListener('pagehide', () => {
  saveSession();
  polling = false;
  clearTimeout(pollTimer);
  activePoll?.abort();
  rtc?.close();
  reactionSounds.close();
  watchLayout.deactivate();
});

window.sofaApp = {
  get session() { return session; },
  get rtc() { return rtc; },
  get peer() { return peer; },
  get cursor() { return cursor; },
  get portable() { return portableClient; },
  get sounds() { return reactionSounds; },
  get layout() { return watchLayout; },
  portableMode,
  exitRoom,
};

setLandingMode();
if (portableMode && !extensionMode) {
  document.querySelector('label[for="room-code"]').textContent = 'Invitation link or room code';
  $('room-code').placeholder = 'Paste your partner’s invitation';
}
for (const [id, mode] of [['make-room-tab', 'make'], ['join-room-tab', 'join']]) $(id).addEventListener('click', () => { entryMode = mode; setLandingMode(); });
if (portableMode) $('landing-help').textContent = extensionMode ? 'Both people install Watchroom in desktop Brave or Chrome, then share a room code. Share a tab with audio. Protected video may require separate players and the countdown.' : 'Open in desktop Brave or Chrome. Make a room and send its private invitation link. Share a tab and enable tab audio.';
updateDeviceState({ camera: false, mic: false });
updateConnection();
const invite = invitation();
const savedRoomId = invite?.roomId || storage.read('sofa:last-room');
const saved = savedRoomId ? storage.read(`${SESSION_PREFIX}${savedRoomId}`) : null;
if (!portableMode && saved?.participantId && saved?.participantSecret && (!invite || saved.roomSecret === invite.roomSecret)) {
  session = saved;
  try {
    const data = await api(`/api/rooms/${encodeURIComponent(saved.roomId)}/events?after=${Number(saved.cursor) || 0}`);
    if (data.closed || !data.participants?.some((participant) => participant.id === saved.participantId)) throw new Error('This room session has ended.');
    await enterRoom({ ...saved, participants: data.participants, cursor: data.cursor }, saved.name, { resume: true });
  } catch {
    storage.remove(`${SESSION_PREFIX}${savedRoomId}`);
    storage.remove('sofa:last-room');
    session = null;
    toast('Your previous room session ended. You can join or make a fresh room.');
  }
}
