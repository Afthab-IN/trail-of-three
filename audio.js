// Procedural audio via WebAudio — no asset loading.
// All sounds are synthesized at play time.

let ctx = null;
let masterGain = null;
let muted = false;
let ambientStarted = false;

function ensureCtx() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = ctx.createGain();
    masterGain.gain.value = 0.6;
    masterGain.connect(ctx.destination);
  }
  return ctx;
}

export function unlockAudio() {
  const c = ensureCtx();
  if (c.state === "suspended") c.resume();
  if (!ambientStarted) {
    ambientStarted = true;
    startAmbient();
  }
}

export function setMuted(v) {
  muted = !!v;
  if (masterGain) masterGain.gain.value = muted ? 0 : 0.6;
}

function playNoise({ dur = 0.2, type = "bandpass", freq = 800, q = 4, vol = 0.4, attack = 0.001, decay = null }) {
  if (muted) return;
  const c = ensureCtx();
  const len = Math.max(1, Math.floor(c.sampleRate * dur));
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1);
  const src = c.createBufferSource();
  src.buffer = buf;
  const filter = c.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = freq;
  filter.Q.value = q;
  const gain = c.createGain();
  gain.gain.setValueAtTime(0, c.currentTime);
  gain.gain.linearRampToValueAtTime(vol, c.currentTime + attack);
  gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + (decay ?? dur));
  src.connect(filter).connect(gain).connect(masterGain);
  src.start();
  src.stop(c.currentTime + dur + 0.05);
}

function playTone({ freq = 440, dur = 0.2, type = "sine", vol = 0.3, sweepTo = null, attack = 0.002 }) {
  if (muted) return;
  const c = ensureCtx();
  const osc = c.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, c.currentTime);
  if (sweepTo !== null) osc.frequency.exponentialRampToValueAtTime(Math.max(20, sweepTo), c.currentTime + dur);
  const gain = c.createGain();
  gain.gain.setValueAtTime(0, c.currentTime);
  gain.gain.linearRampToValueAtTime(vol, c.currentTime + attack);
  gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + dur);
  osc.connect(gain).connect(masterGain);
  osc.start();
  osc.stop(c.currentTime + dur + 0.02);
}

// === Public SFX ===

export function sfxSwordSwing() {
  // Whoosh — filtered noise sweep
  playNoise({ dur: 0.18, type: "bandpass", freq: 1200, q: 2, vol: 0.35 });
  setTimeout(() => playNoise({ dur: 0.12, type: "bandpass", freq: 600, q: 2, vol: 0.2 }), 30);
}

export function sfxHit() {
  // Meaty thud — low square + noise click
  playTone({ freq: 140, dur: 0.08, type: "square", vol: 0.45, sweepTo: 60 });
  playNoise({ dur: 0.05, type: "lowpass", freq: 200, q: 1, vol: 0.4 });
}

export function sfxEnemyDeath() {
  playTone({ freq: 200, dur: 0.18, type: "sawtooth", vol: 0.35, sweepTo: 80 });
  setTimeout(() => playTone({ freq: 100, dur: 0.3, type: "sawtooth", vol: 0.2, sweepTo: 50 }), 60);
}

export function sfxPlayerHurt() {
  playTone({ freq: 320, dur: 0.12, type: "triangle", vol: 0.35, sweepTo: 220 });
  playNoise({ dur: 0.08, type: "bandpass", freq: 400, q: 2, vol: 0.25 });
}

export function sfxFireball() {
  // Whoosh up + flame crackle
  playNoise({ dur: 0.4, type: "bandpass", freq: 600, q: 3, vol: 0.4 });
  playTone({ freq: 220, dur: 0.4, type: "sawtooth", vol: 0.25, sweepTo: 120 });
}

export function sfxFireballHit() {
  playNoise({ dur: 0.3, type: "bandpass", freq: 350, q: 1.5, vol: 0.5 });
  playTone({ freq: 80, dur: 0.2, type: "square", vol: 0.4, sweepTo: 30 });
}

export function sfxPickup() {
  playTone({ freq: 880, dur: 0.08, type: "sine", vol: 0.3 });
  setTimeout(() => playTone({ freq: 1320, dur: 0.12, type: "sine", vol: 0.25 }), 60);
}

export function sfxPotion() {
  playTone({ freq: 600, dur: 0.08, type: "triangle", vol: 0.3 });
  setTimeout(() => playTone({ freq: 900, dur: 0.1, type: "triangle", vol: 0.3 }), 50);
  setTimeout(() => playTone({ freq: 1200, dur: 0.14, type: "triangle", vol: 0.3 }), 110);
}

export function sfxJump() {
  playTone({ freq: 380, dur: 0.06, type: "triangle", vol: 0.18, sweepTo: 520 });
}

export function sfxFootstep() {
  playNoise({ dur: 0.06, type: "lowpass", freq: 250, q: 1, vol: 0.12 });
}

export function sfxDragonRoar() {
  if (muted) return;
  const c = ensureCtx();
  for (let i = 0; i < 4; i++) {
    setTimeout(() => {
      const osc = c.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(55 + i * 6 + Math.random() * 10, c.currentTime);
      osc.frequency.linearRampToValueAtTime(70 + i * 4, c.currentTime + 1.0);
      const gain = c.createGain();
      gain.gain.setValueAtTime(0, c.currentTime);
      gain.gain.linearRampToValueAtTime(0.45, c.currentTime + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.01, c.currentTime + 1.2);
      const filter = c.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 380;
      osc.connect(filter).connect(gain).connect(masterGain);
      osc.start();
      osc.stop(c.currentTime + 1.3);
    }, i * 80);
  }
}

export function sfxVictory() {
  if (muted) return;
  const c = ensureCtx();
  const notes = [523, 659, 784, 1046]; // C E G C
  notes.forEach((f, i) => {
    setTimeout(() => playTone({ freq: f, dur: 0.4, type: "triangle", vol: 0.35 }), i * 150);
  });
}

// === Ambient drone ===
function startAmbient() {
  if (muted) return;
  const c = ensureCtx();
  // Two detuned low oscillators through a slow LFO-modulated filter
  const o1 = c.createOscillator();
  const o2 = c.createOscillator();
  o1.type = "sawtooth"; o2.type = "sawtooth";
  o1.frequency.value = 55;   // A1
  o2.frequency.value = 55.4; // slightly detuned
  const filter = c.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 320;
  filter.Q.value = 2;
  const lfo = c.createOscillator();
  lfo.frequency.value = 0.08;
  const lfoGain = c.createGain();
  lfoGain.gain.value = 80;
  lfo.connect(lfoGain).connect(filter.frequency);
  const gain = c.createGain();
  gain.gain.value = 0.06;
  o1.connect(filter); o2.connect(filter);
  filter.connect(gain).connect(masterGain);
  o1.start(); o2.start(); lfo.start();

  // Wind: pink-noise-like, slowly modulated
  const noiseBuf = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
  const nd = noiseBuf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < nd.length; i++) {
    const w = Math.random() * 2 - 1;
    last = (last + w * 0.02) * 0.995;
    nd[i] = last;
  }
  const noiseSrc = c.createBufferSource();
  noiseSrc.buffer = noiseBuf;
  noiseSrc.loop = true;
  const nFilter = c.createBiquadFilter();
  nFilter.type = "bandpass";
  nFilter.frequency.value = 600;
  nFilter.Q.value = 1.2;
  const nLfo = c.createOscillator();
  nLfo.frequency.value = 0.15;
  const nLfoGain = c.createGain();
  nLfoGain.gain.value = 200;
  nLfo.connect(nLfoGain).connect(nFilter.frequency);
  const nGain = c.createGain();
  nGain.gain.value = 0.05;
  noiseSrc.connect(nFilter).connect(nGain).connect(masterGain);
  noiseSrc.start(); nLfo.start();
}
