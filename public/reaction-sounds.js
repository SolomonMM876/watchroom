// Small, synthesized reactions. Audio is unlocked only by enable(), which the
// UI calls directly from a click; incoming reactions never request audio access.

const EFFECTS = new Set(['fart', 'awake', 'blankets', 'awake-reply']);
const MIN_INTERVAL_MS = 300;
const MAX_ACTIVE = 2;

export class ReactionSounds {
  constructor({ enabled = true } = {}) {
    this.enabled = !!enabled;
    this.context = null;
    this._activeEffects = new Set();
    this._lastPlayAt = -Infinity;
  }

  async enable() {
    if (!this.enabled) return false;
    try {
      const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AudioContextClass) return false;
      if (!this.context || this.context.state === 'closed') {
        this.context = new AudioContextClass({ latencyHint: 'interactive' });
      }
      const context = this.context;
      // Call resume before the first await to retain the initiating gesture.
      if (context.state !== 'running') await context.resume();
      return this.enabled && this.context === context && context.state === 'running';
    } catch {
      return false;
    }
  }

  setEnabled(enabled) {
    this.enabled = !!enabled;
    if (!this.enabled) this._stopEffects();
    return this.enabled;
  }

  _stopEffects() {
    for (const cleanup of [...this._activeEffects]) cleanup();
  }

  async play(kind) {
    const context = this.context;
    const clock = globalThis.performance?.now() ?? Date.now();
    if (!this.enabled || !EFFECTS.has(kind) || context?.state !== 'running' || clock - this._lastPlayAt < MIN_INTERVAL_MS || this._activeEffects.size >= MAX_ACTIVE) return false;

    const nodes = [];
    const sources = [];
    let timer = null;
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(timer);
      for (const source of sources) {
        source.onended = null;
        try { source.stop(); } catch { /* An effect may already have ended. */ }
      }
      for (const node of nodes) {
        try { node.disconnect(); } catch { /* Closing the context is safe too. */ }
      }
      this._activeEffects.delete(cleanup);
    };

    const keep = (node) => { nodes.push(node); return node; };
    const gain = (value) => {
      const node = keep(context.createGain());
      node.gain.value = value;
      return node;
    };
    const filter = (type, frequency, q = 0.7) => {
      const node = keep(context.createBiquadFilter());
      node.type = type;
      node.frequency.value = frequency;
      node.Q.value = q;
      return node;
    };
    const noise = (duration, soft = false) => {
      const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * duration), context.sampleRate);
      const data = buffer.getChannelData(0);
      let previous = 0;
      for (let index = 0; index < data.length; index++) {
        const white = Math.random() * 2 - 1;
        previous = (previous + white * 0.08) / 1.08;
        data[index] = soft ? previous * 2 : white;
      }
      const source = keep(context.createBufferSource());
      source.buffer = buffer;
      sources.push(source);
      return source;
    };
    const oscillator = (frequency, type = 'sine') => {
      const source = keep(context.createOscillator());
      source.type = type;
      source.frequency.value = frequency;
      sources.push(source);
      return source;
    };

    try {
      const now = context.currentTime;
      const master = gain(0);
      master.connect(context.destination);
      let duration;

      if (kind === 'fart') {
        duration = 2.35;
        // Uneven pressure, a low buzzing flutter, and filtered air produce a
        // longer organic sputter. Each play varies slightly; edges stay soft.
        const pitch = 78 + Math.random() * 16;
        const buzz = oscillator(pitch, 'sawtooth');
        const rumble = oscillator(pitch * 0.48, 'triangle');
        const buzzLevel = gain(0.62);
        const rumbleLevel = gain(0.3);
        const flutter = gain(0.16);
        const lowpass = filter('lowpass', 570, 0.65);
        lowpass.frequency.setValueAtTime(570, now);
        lowpass.frequency.linearRampToValueAtTime(380, now + 0.85);
        lowpass.frequency.linearRampToValueAtTime(510, now + 1.4);
        lowpass.frequency.exponentialRampToValueAtTime(190, now + duration);
        buzz.connect(buzzLevel); buzzLevel.connect(flutter);
        rumble.connect(rumbleLevel); rumbleLevel.connect(flutter);
        flutter.connect(lowpass); lowpass.connect(master);
        let pulseAt = 0.025;
        while (pulseAt < duration - 0.18) {
          const spacing = 0.035 + Math.random() * 0.065;
          const pressure = 0.38 + Math.random() * 0.46;
          const frequency = pitch * (1 - 0.4 * pulseAt / duration) + (Math.random() - 0.5) * 16;
          flutter.gain.linearRampToValueAtTime(pressure, now + pulseAt);
          flutter.gain.exponentialRampToValueAtTime(0.07 + Math.random() * 0.15, now + pulseAt + spacing * 0.7);
          buzz.frequency.linearRampToValueAtTime(frequency, now + pulseAt);
          rumble.frequency.linearRampToValueAtTime(frequency * 0.48, now + pulseAt);
          pulseAt += spacing;
        }
        flutter.gain.linearRampToValueAtTime(0.025, now + duration);
        buzz.frequency.exponentialRampToValueAtTime(34, now + duration);
        rumble.frequency.exponentialRampToValueAtTime(19, now + duration);
        const air = noise(duration, true);
        const airFilter = filter('bandpass', 620, 0.45);
        const airLevel = gain(0.48);
        air.connect(airFilter); airFilter.connect(airLevel); airLevel.connect(master);
        master.gain.setValueAtTime(0, now);
        master.gain.linearRampToValueAtTime(0.065, now + 0.045);
        master.gain.linearRampToValueAtTime(0.058, now + 0.65);
        master.gain.linearRampToValueAtTime(0.072, now + 1.25);
        master.gain.linearRampToValueAtTime(0.051, now + 1.85);
        master.gain.linearRampToValueAtTime(0.044, now + 2.1);
        master.gain.exponentialRampToValueAtTime(0.0001, now + duration);
        buzz.start(now); buzz.stop(now + duration);
        rumble.start(now); rumble.stop(now + duration);
        air.start(now); air.stop(now + duration);
      } else if (kind === 'awake' || kind === 'awake-reply') {
        duration = 0.8;
        master.gain.value = kind === 'awake-reply' ? 0.045 : 0.075;
        const frequencies = kind === 'awake-reply' ? [880, 1046.5] : [659.25, 880];
        frequencies.forEach((frequency, index) => {
          const start = now + index * 0.2;
          const note = oscillator(frequency);
          const envelope = gain(0);
          envelope.gain.setValueAtTime(0, start);
          envelope.gain.linearRampToValueAtTime(0.7, start + 0.018);
          envelope.gain.exponentialRampToValueAtTime(0.0001, start + 0.58);
          note.connect(envelope); envelope.connect(master);
          note.start(start); note.stop(start + 0.6);
        });
      } else {
        duration = 0.78;
        const fabric = noise(duration);
        const texture = filter('bandpass', 1700, 0.55);
        const soften = filter('lowpass', 4200);
        fabric.connect(texture); texture.connect(soften); soften.connect(master);
        // Two restrained swishes sound like moving fabric rather than a hiss.
        master.gain.setValueAtTime(0, now);
        master.gain.linearRampToValueAtTime(0.055, now + 0.08);
        master.gain.exponentialRampToValueAtTime(0.004, now + 0.25);
        master.gain.linearRampToValueAtTime(0.04, now + 0.39);
        master.gain.exponentialRampToValueAtTime(0.0001, now + duration);
        fabric.start(now); fabric.stop(now + duration);
      }

      this._lastPlayAt = clock;
      this._activeEffects.add(cleanup);
      // An onended event handles normal playback; a timer also frees nodes if
      // a browser suspends its audio context while an effect is scheduled.
      const lastSource = sources[sources.length - 1];
      lastSource.onended = cleanup;
      timer = setTimeout(cleanup, (duration + 0.15) * 1000);
      return true;
    } catch {
      cleanup();
      return false;
    }
  }

  close() {
    this._stopEffects();
    const context = this.context;
    this.context = null;
    this._lastPlayAt = -Infinity;
    if (context && context.state !== 'closed') {
      try { const result = context.close(); result?.catch(() => {}); } catch { /* Audio cleanup never interrupts leaving a room. */ }
    }
  }
}
