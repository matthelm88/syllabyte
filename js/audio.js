// audio.js — shared AudioContext and the master effects chain.

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

// soft clipping for DRIVE, normalised so it doesn't jump in volume
function driveCurve(k) {
  const n = 4096, curve = new Float32Array(n), norm = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / norm * 0.85;
  }
  return curve;
}
const DRIVE = driveCurve(5);

// reverb tail: decaying stereo noise from a fixed seed, so the WAV export sounds the same every time
function makeImpulse(c, secs = 2.4) {
  const len = Math.floor(c.sampleRate * secs);
  const ir = c.createBuffer(2, len, c.sampleRate);
  let seed = 12345;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; };
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = rand() * Math.pow(1 - i / len, 3.2);
  }
  return ir;
}

function gain(c, v) { const g = c.createGain(); g.gain.value = v; return g; }
function lfoInto(c, param, rate, depth, type = 'sine') {
  const o = c.createOscillator(); o.type = type; o.frequency.value = rate;
  const a = gain(c, depth);
  o.connect(a); a.connect(param); o.start(0);
  return { osc: o, amt: a };
}

// Builds the effects chain on any context (live or offline, so WAV export sounds identical).
// input → drive → crush → phone → filter → tape → chorus → limiter, with echo + verb sends.
export function buildChain(c) {
  const input = c.createGain();

  // DRIVE — warm overdrive
  const drive = c.createWaveShaper();
  drive.curve = LINEAR;
  drive.oversample = '4x';

  // CRUSH — bitcrusher
  const crush = c.createWaveShaper();
  crush.curve = LINEAR;

  // PHONE — telephone / walkie-talkie band
  const phoneDry = gain(c, 1), phoneWet = gain(c, 0);
  const phHP = c.createBiquadFilter(); phHP.type = 'highpass'; phHP.frequency.value = 450; phHP.Q.value = 0.9;
  const phLP = c.createBiquadFilter(); phLP.type = 'lowpass'; phLP.frequency.value = 2800; phLP.Q.value = 1.2;
  const phPeak = c.createBiquadFilter(); phPeak.type = 'peaking'; phPeak.frequency.value = 1400; phPeak.gain.value = 8; phPeak.Q.value = 1;

  // FILT — resonant sweep
  const filter = c.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 20000;
  filter.Q.value = 0.7;
  const fl = lfoInto(c, filter.frequency, 0.25, 0);

  // TAPE — wow & flutter wobble with a darker top end
  const tapeDry = gain(c, 1), tapeWet = gain(c, 0);
  const tapeDelay = c.createDelay(0.1); tapeDelay.delayTime.value = 0.014;
  lfoInto(c, tapeDelay.delayTime, 0.9, 0.0035);   // slow wow
  lfoInto(c, tapeDelay.delayTime, 7.5, 0.0004);   // fast flutter
  const tapeLP = c.createBiquadFilter(); tapeLP.type = 'lowpass'; tapeLP.frequency.value = 4800;

  // CHORUS — two drifting voices spread left and right
  const chorusWet = gain(c, 0);
  const chL = c.createDelay(0.1); chL.delayTime.value = 0.018;
  const chR = c.createDelay(0.1); chR.delayTime.value = 0.024;
  lfoInto(c, chL.delayTime, 0.6, 0.004);
  lfoInto(c, chR.delayTime, 0.45, 0.005);
  const panL = c.createStereoPanner(); panL.pan.value = -0.8;
  const panR = c.createStereoPanner(); panR.pan.value = 0.8;

  // ECHO
  const delay = c.createDelay(2.0);
  const fb = gain(c, 0.38);
  const wet = gain(c, 0);

  // VERB — big room reverb
  const verb = c.createConvolver();
  verb.buffer = makeImpulse(c);
  const verbWet = gain(c, 0);

  const limiter = c.createDynamicsCompressor();
  limiter.threshold.value = -6;
  limiter.knee.value = 3;
  limiter.ratio.value = 12;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.1;

  const mix = c.createGain();
  const output = gain(c, 0.9);

  input.connect(drive);
  drive.connect(crush);
  crush.connect(phoneDry); phoneDry.connect(filter);
  crush.connect(phHP); phHP.connect(phLP); phLP.connect(phPeak); phPeak.connect(phoneWet); phoneWet.connect(filter);
  filter.connect(tapeDry); tapeDry.connect(mix);
  filter.connect(tapeDelay); tapeDelay.connect(tapeLP); tapeLP.connect(tapeWet); tapeWet.connect(mix);
  // chorus taps the post-tape signal (tapeDry + tapeWet both feed it via a small bus)
  const preChorus = c.createGain();
  tapeDry.connect(preChorus); tapeWet.connect(preChorus);
  preChorus.connect(chL); chL.connect(panL); panL.connect(chorusWet);
  preChorus.connect(chR); chR.connect(panR); panR.connect(chorusWet);
  chorusWet.connect(mix);

  mix.connect(limiter);
  mix.connect(delay);
  delay.connect(fb); fb.connect(delay);
  delay.connect(wet); wet.connect(limiter);
  mix.connect(verb); verb.connect(verbWet); verbWet.connect(limiter);
  limiter.connect(output);

  const set = (param, v, t) => param.setTargetAtTime(v, t, 0.05);

  function update(fx, bpm, t = c.currentTime) {
    drive.curve = fx.drive ? DRIVE : LINEAR;
    crush.curve = fx.crush ? CRUSH : LINEAR;
    set(phoneDry.gain, fx.phone ? 0 : 1, t);
    set(phoneWet.gain, fx.phone ? 1.6 : 0, t);
    const beat = 60 / bpm;
    if (fx.filter) {
      set(filter.frequency, 1400, t);
      set(filter.Q, 9, t);
      set(fl.amt.gain, 1100, t);
      fl.osc.frequency.setValueAtTime(1 / (beat * 8), t); // one sweep every 2 bars
    } else {
      set(filter.frequency, 20000, t);
      set(filter.Q, 0.7, t);
      set(fl.amt.gain, 0, t);
    }
    set(tapeDry.gain, fx.tape ? 0 : 1, t);
    set(tapeWet.gain, fx.tape ? 1 : 0, t);
    set(chorusWet.gain, fx.chorus ? 0.7 : 0, t);
    set(delay.delayTime, beat * 0.75, t); // dotted 8th echo
    set(wet.gain, fx.delay ? 0.4 : 0, t);
    set(verbWet.gain, fx.verb ? 0.45 : 0, t);
  }

  return { input, output, update };
}
