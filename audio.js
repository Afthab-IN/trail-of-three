// Racing audio — synthesized engine that tracks RPM, screech, collision, beeps.

let ctx = null;
let masterGain = null;
let muted = false;

// Engine state
const engine = {
  ready: false,
  osc1: null, osc2: null,
  gain: null,
  filter: null,
  noiseGain: null,
};

let ambientStarted = false;

function ensureCtx() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = ctx.createGain();
    masterGain.gain.value = 0.55;
    masterGain.connect(ctx.destination);
  }
  return ctx;
}

export function unlockAudio() {
  const c = ensureCtx();
  if (c.state === "suspended") c.resume();
  if (!engine.ready) startEngine();
  if (!ambientStarted) {
    ambientStarted = true;
    startWind();
  }
}

export function setMuted(v) {
  muted = !!v;
  if (masterGain) masterGain.gain.value = muted ? 0 : 0.55;
}

// === Engine — two detuned sawtooths + noise, frequency = base + speed coefficient ===

function startEngine() {
  const c = ensureCtx();
  engine.osc1 = c.createOscillator();
  engine.osc2 = c.createOscillator();
  engine.osc1.type = "sawtooth";
  engine.osc2.type = "sawtooth";
  engine.osc1.frequency.value = 90;
  engine.osc2.frequency.value = 94;

  engine.filter = c.createBiquadFilter();
  engine.filter.type = "lowpass";
  engine.filter.frequency.value = 1200;
  engine.filter.Q.value = 1.4;

  engine.gain = c.createGain();
  engine.gain.gain.value = 0.0;     // silent until set

  // Noise component for top-end grit
  const noiseBuf = c.createBuffer(1, c.sampleRate * 1, c.sampleRate);
  const nd = noiseBuf.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = (Math.random() * 2 - 1) * 0.4;
  const noise = c.createBufferSource();
  noise.buffer = noiseBuf;
  noise.loop = true;
  const noiseFilter = c.createBiquadFilter();
  noiseFilter.type = "bandpass";
  noiseFilter.frequency.value = 600;
  noiseFilter.Q.value = 2;
  engine.noiseGain = c.createGain();
  engine.noiseGain.gain.value = 0;
  noise.connect(noiseFilter).connect(engine.noiseGain).connect(engine.filter);

  engine.osc1.connect(engine.filter);
  engine.osc2.connect(engine.filter);
  engine.filter.connect(engine.gain).connect(masterGain);

  engine.osc1.start();
  engine.osc2.start();
  noise.start();
  engine.ready = true;
}

// speedNorm: 0 (idle) to 1 (top speed). throttle: 0..1
export function setEngine(speedNorm, throttle, boosting) {
  if (!engine.ready || muted) return;
  const c = ctx;
  const baseHz = 50 + speedNorm * 250 + (boosting ? 60 : 0);
  engine.osc1.frequency.setTargetAtTime(baseHz, c.currentTime, 0.05);
  engine.osc2.frequency.setTargetAtTime(baseHz * 1.03, c.currentTime, 0.05);
  const cutoff = 600 + speedNorm * 2200 + (throttle * 400);
  engine.filter.frequency.setTargetAtTime(cutoff, c.currentTime, 0.05);
  // Volume rises with engine load
  const targetGain = 0.05 + speedNorm * 0.16 + throttle * 0.08 + (boosting ? 0.08 : 0);
  engine.gain.gain.setTargetAtTime(targetGain, c.currentTime, 0.08);
  engine.noiseGain.gain.setTargetAtTime(0.04 + speedNorm * 0.1, c.currentTime, 0.1);
}

export function silenceEngine() {
  if (!engine.ready) return;
  engine.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.1);
  engine.noiseGain.gain.setTargetAtTime(0, ctx.currentTime, 0.1);
}

// === SFX ===

function playNoise({ dur = 0.2, type = "bandpass", freq = 800, q = 4, vol = 0.4, attack = 0.001 }) {
  if (muted) return;
  const c = ensureCtx();
  const len = Math.max(1, Math.floor(c.sampleRate * dur));
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const src = c.createBufferSource();
  src.buffer = buf;
  const filter = c.createBiquadFilter();
  filter.type = type; filter.frequency.value = freq; filter.Q.value = q;
  const gain = c.createGain();
  gain.gain.setValueAtTime(0, c.currentTime);
  gain.gain.linearRampToValueAtTime(vol, c.currentTime + attack);
  gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + dur);
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

// Continuous screech — held while drifting / heavy slide
let screechSrc = null;
let screechGain = null;
export function setScreech(intensity) {
  // intensity 0..1
  if (muted) {
    if (screechSrc) stopScreech();
    return;
  }
  const c = ensureCtx();
  if (!screechSrc && intensity > 0.1) {
    const noiseBuf = c.createBuffer(1, c.sampleRate * 0.5, c.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    screechSrc = c.createBufferSource();
    screechSrc.buffer = noiseBuf;
    screechSrc.loop = true;
    const filter = c.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 3200;
    filter.Q.value = 6;
    screechGain = c.createGain();
    screechGain.gain.value = 0;
    screechSrc.connect(filter).connect(screechGain).connect(masterGain);
    screechSrc.start();
  }
  if (screechGain) {
    const target = Math.min(0.28, intensity * 0.35);
    screechGain.gain.setTargetAtTime(target, c.currentTime, 0.08);
  }
}
export function stopScreech() {
  if (screechGain) screechGain.gain.setTargetAtTime(0, ctx.currentTime, 0.15);
  setTimeout(() => {
    if (screechSrc) { try { screechSrc.stop(); } catch {} screechSrc = null; screechGain = null; }
  }, 300);
}

export function sfxCollision(force = 1.0) {
  playTone({ freq: 110, dur: 0.18, type: "square", vol: 0.45 * Math.min(1, force), sweepTo: 50 });
  playNoise({ dur: 0.18, type: "bandpass", freq: 400, q: 1.6, vol: 0.5 * Math.min(1, force) });
}

export function sfxBoost() {
  playNoise({ dur: 0.5, type: "bandpass", freq: 800, q: 1.2, vol: 0.35 });
  playTone({ freq: 220, dur: 0.4, type: "sawtooth", vol: 0.2, sweepTo: 600 });
}

export function sfxCountdownBeep(final = false) {
  if (final) {
    playTone({ freq: 880, dur: 0.45, type: "sine", vol: 0.35 });
  } else {
    playTone({ freq: 660, dur: 0.18, type: "sine", vol: 0.3 });
  }
}

export function sfxLap() {
  playTone({ freq: 660, dur: 0.12, type: "triangle", vol: 0.3 });
  setTimeout(() => playTone({ freq: 990, dur: 0.18, type: "triangle", vol: 0.3 }), 80);
}

export function sfxFinish() {
  if (muted) return;
  const c = ensureCtx();
  const notes = [523, 659, 784, 1046, 1318];
  notes.forEach((f, i) => {
    setTimeout(() => playTone({ freq: f, dur: 0.32, type: "triangle", vol: 0.32 }), i * 120);
  });
}

// === Ambient wind ===
function startWind() {
  if (muted) return;
  const c = ensureCtx();
  const noiseBuf = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
  const nd = noiseBuf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < nd.length; i++) {
    const w = Math.random() * 2 - 1;
    last = (last + w * 0.02) * 0.995;
    nd[i] = last;
  }
  const src = c.createBufferSource();
  src.buffer = noiseBuf; src.loop = true;
  const filter = c.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = 500;
  filter.Q.value = 1.0;
  const lfo = c.createOscillator();
  lfo.frequency.value = 0.12;
  const lfoGain = c.createGain();
  lfoGain.gain.value = 180;
  lfo.connect(lfoGain).connect(filter.frequency);
  const gain = c.createGain();
  gain.gain.value = 0.035;
  src.connect(filter).connect(gain).connect(masterGain);
  src.start(); lfo.start();
}
