// voices.js — synth voices baked into the whole phrase before it's chopped.
// Pure DSP on Float32Arrays: renderVoice(data, sampleRate, id) -> new Float32Array.

export const VOICES = [
  { id: 'dry',     name: 'DRY',     hint: 'your voice' },
  { id: 'robot',   name: 'ROBOT',   hint: 'monotone buzz' },
  { id: 'vocoder', name: 'VOCODE',  hint: 'synth chord' },
  { id: 'whisper', name: 'WHISPER', hint: 'breathy ghost' },
  { id: 'chip',    name: 'CHIP',    hint: '8-bit crunch' },
  { id: 'metal',   name: 'METAL',   hint: 'ringing tube' },
  { id: 'deep',    name: 'DEEP',    hint: 'pitched down' },
  { id: 'helium',  name: 'HELIUM',  hint: 'pitched up' },
  { id: 'choir',   name: 'CHOIR',   hint: '4-voice stack' },
];

/* ---------- helpers ---------- */

function normalize(y) {
  let peak = 0;
  for (let i = 0; i < y.length; i++) { const a = Math.abs(y[i]); if (a > peak) peak = a; }
  if (peak > 1e-6) { const g = 0.95 / peak; for (let i = 0; i < y.length; i++) y[i] *= g; }
  return y;
}

// in-place radix-2 complex FFT (inverse includes the 1/N)
function fft(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inverse ? 2 : -2) * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

const hann = N => Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));

// short-time Fourier processing: frameFn(re, im, pos) edits each frame's spectrum
function stft(data, N, hop, frameFn) {
  const win = hann(N), L = data.length;
  const out = new Float64Array(L + N), norm = new Float64Array(L + N);
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let pos = 0; pos < L; pos += hop) {
    for (let i = 0; i < N; i++) { re[i] = (data[pos + i] || 0) * win[i]; im[i] = 0; }
    fft(re, im, false);
    frameFn(re, im, pos);
    fft(re, im, true);
    for (let i = 0; i < N; i++) { out[pos + i] += re[i] * win[i]; norm[pos + i] += win[i] * win[i]; }
  }
  const y = new Float32Array(L);
  for (let i = 0; i < L; i++) y[i] = out[i] / Math.max(norm[i], 0.1);
  return y;
}

// fill bins N/2+1..N-1 as the mirror of 1..N/2-1 so the output stays real
function mirror(re, im) {
  const N = re.length;
  im[0] = 0; im[N / 2] = 0;
  for (let k = 1; k < N / 2; k++) { re[N - k] = re[k]; im[N - k] = -im[k]; }
}

function smoothMag(re, im, half, w) {
  const mag = new Float64Array(half + 1), env = new Float64Array(half + 1);
  for (let k = 0; k <= half; k++) mag[k] = Math.hypot(re[k], im[k]);
  for (let k = 0; k <= half; k++) {
    let s = 0, c = 0;
    for (let j = Math.max(0, k - w); j <= Math.min(half, k + w); j++) { s += mag[j]; c++; }
    env[k] = s / c;
  }
  return { mag, env };
}

/* ---------- voices ---------- */

// zero phase: every frame becomes one pulse, so the voice buzzes at a fixed pitch (110 Hz)
function robot(x, sr) {
  const N = 1024, hop = Math.round(sr / 110);
  return stft(x, N, hop, (re, im) => {
    for (let k = 0; k <= N / 2; k++) {
      const m = Math.hypot(re[k], im[k]);
      re[k] = k % 2 ? -m : m; // linear phase centres the pulse in the frame
      im[k] = 0;
    }
    mirror(re, im);
  });
}

// random phase: keeps the shape of the words, loses the pitch
function whisper(x) {
  const N = 512;
  return stft(x, N, N / 4, (re, im) => {
    for (let k = 1; k < N / 2; k++) {
      const m = Math.hypot(re[k], im[k]), p = Math.random() * 2 * Math.PI;
      re[k] = m * Math.cos(p); im[k] = m * Math.sin(p);
    }
    mirror(re, im);
  });
}

// voice shapes a saw-wave A-minor chord (plus a little noise so S and T sounds come through)
function vocoder(x, sr) {
  const N = 1024, hop = 256, half = N / 2, L = x.length;
  const notes = [110, 130.81, 164.81, 220, 221.3];
  const car = new Float32Array(L + N);
  for (let i = 0; i < car.length; i++) {
    let s = 0;
    for (const f of notes) s += 2 * ((i * f / sr) % 1) - 1;
    car[i] = s / notes.length + (Math.random() * 2 - 1) * 0.06;
  }
  const win = hann(N);
  const cre = new Float64Array(N), cim = new Float64Array(N);
  return stft(x, N, hop, (re, im, pos) => {
    for (let i = 0; i < N; i++) { cre[i] = car[pos + i] * win[i]; cim[i] = 0; }
    fft(cre, cim, false);
    const v = smoothMag(re, im, half, 4).env;
    const c = smoothMag(cre, cim, half, 4).env;
    for (let k = 0; k <= half; k++) {
      const g = v[k] / (c[k] + 1e-9);
      re[k] = cre[k] * g; im[k] = cim[k] * g;
    }
    mirror(re, im);
  });
}

// lower sample rate + fewer bits
function chip(x, sr) {
  const hold = Math.max(1, Math.round(sr / 8000)), steps = 16;
  const y = new Float32Array(x.length);
  let v = 0;
  for (let i = 0; i < x.length; i++) {
    if (i % hold === 0) v = Math.round(x[i] * steps) / steps;
    y[i] = v;
  }
  return y;
}

// feedback comb tuned to A3: metallic, resonant
function metal(x, sr) {
  const D = Math.round(sr / 220), fb = 0.82;
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) y[i] = x[i] * 0.6 + (i >= D ? y[i - D] * fb : 0);
  return y;
}

// pitch shift that keeps the timing (two crossfaded delay taps), latency-compensated
export function pitchShift(x, ratio, sr) {
  const W = Math.round(sr * 0.05), half = W / 2, L = x.length;
  const y = new Float32Array(L);
  const dPhase = (1 - ratio) / W;
  let phase = 0;
  const read = p => {
    if (p < 0 || p >= L - 1) return 0;
    const i = Math.floor(p), f = p - i;
    return x[i] + (x[i + 1] - x[i]) * f;
  };
  for (let n = 0; n < L; n++) {
    phase += dPhase;
    phase -= Math.floor(phase);
    const p2 = (phase + 0.5) % 1;
    const g1 = 1 - Math.abs(2 * phase - 1), g2 = 1 - Math.abs(2 * p2 - 1);
    y[n] = g1 * read(n + half - phase * W) + g2 * read(n + half - p2 * W);
  }
  return y;
}

function choir(x, sr) {
  const parts = [[1, 0.5], [0.5, 0.35], [1.5, 0.35], [2, 0.25]]; // octave down, fifth, octave up
  const y = new Float32Array(x.length);
  for (const [r, g] of parts) {
    const s = r === 1 ? x : pitchShift(x, r, sr);
    for (let i = 0; i < y.length; i++) y[i] += s[i] * g;
  }
  return y;
}

export function renderVoice(data, sr, id) {
  let y;
  switch (id) {
    case 'robot':   y = robot(data, sr); break;
    case 'vocoder': y = vocoder(data, sr); break;
    case 'whisper': y = whisper(data); break;
    case 'chip':    y = chip(data, sr); break;
    case 'metal':   y = metal(data, sr); break;
    case 'deep':    y = pitchShift(data, 0.667, sr); break;
    case 'helium':  y = pitchShift(data, 1.5, sr); break;
    case 'choir':   y = choir(data, sr); break;
    default:        return data;
  }
  return normalize(y);
}
