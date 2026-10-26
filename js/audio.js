// audio.js — shared AudioContext and the master effects chain (crush → filter → echo → limiter).

let ctx = null;
let chain = null;

export function getCtx() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC({ latencyHint: 'interactive' });
    chain = buildChain(ctx);
    chain.output.connect(ctx.destination);
  }
  return ctx;
}

export function getChain() { getCtx(); return chain; }

export async function unlock() {
  const c = getCtx();
  if (c.state !== 'running') { try { await c.resume(); } catch (e) { /* ignore */ } }
  return c;
}

// iOS audio session: 'play-and-record' while the mic is open, 'playback' otherwise
// (keeps sound on the speaker and ignores the silent switch on iOS 17+).
export function setSession(type) {
  try { if (navigator.audioSession) navigator.audioSession.type = type; } catch (e) { /* ignore */ }
}

function crushCurve(bits) {
  const n = 4096, curve = new Float32Array(n), steps = Math.pow(2, bits - 1);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.round(x * steps) / steps;
  }
  return curve;
}
const CRUSH = crushCurve(4);
const LINEAR = new Float32Array([-1, 1]);

// Builds the effects chain on any context (live or offline, so WAV export sounds identical).
export function buildChain(c) {
  const input = c.createGain();

  const crush = c.createWaveShaper();
  crush.curve = LINEAR;

  const filter = c.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 20000;
  filter.Q.value = 0.7;

  const lfo = c.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = 0.25;
  const lfoAmt = c.createGain();
  lfoAmt.gain.value = 0;
  lfo.connect(lfoAmt);
  lfoAmt.connect(filter.frequency);
  lfo.start(0);

  const delay = c.createDelay(2.0);
  const fb = c.createGain(); fb.gain.value = 0.38;
  const wet = c.createGain(); wet.gain.value = 0;

  const limiter = c.createDynamicsCompressor();
  limiter.threshold.value = -6;
  limiter.knee.value = 3;
  limiter.ratio.value = 12;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.1;

  const output = c.createGain();
  output.gain.value = 0.9;

  input.connect(crush);
  crush.connect(filter);
  filter.connect(limiter);
  filter.connect(delay);
  delay.connect(fb); fb.connect(delay);
  delay.connect(wet); wet.connect(limiter);
  limiter.connect(output);

  function update(fx, bpm, t = c.currentTime) {
    crush.curve = fx.crush ? CRUSH : LINEAR;
    const beat = 60 / bpm;
    if (fx.filter) {
      filter.frequency.setTargetAtTime(1400, t, 0.05);
      filter.Q.setTargetAtTime(9, t, 0.05);
      lfoAmt.gain.setTargetAtTime(1100, t, 0.05);
      lfo.frequency.setValueAtTime(1 / (beat * 8), t); // one sweep every 2 bars
    } else {
      filter.frequency.setTargetAtTime(20000, t, 0.05);
      filter.Q.setTargetAtTime(0.7, t, 0.05);
      lfoAmt.gain.setTargetAtTime(0, t, 0.05);
    }
    delay.delayTime.setTargetAtTime(beat * 0.75, t, 0.05); // dotted 8th echo
    wet.gain.setTargetAtTime(fx.delay ? 0.4 : 0, t, 0.05);
  }

  return { input, output, update };
}
