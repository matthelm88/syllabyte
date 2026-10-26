// chopper.js — trims the phrase and slices it at syllables (energy dips), or into equal chops.

export function toMono(buffer) {
  const n = buffer.length, ch = buffer.numberOfChannels;
  const out = new Float32Array(n);
  for (let c = 0; c < ch; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += d[i] / ch;
  }
  return out;
}

export function normalize(data) {
  let peak = 0;
  for (let i = 0; i < data.length; i++) { const a = Math.abs(data[i]); if (a > peak) peak = a; }
  if (peak > 0.0001) { const g = 0.95 / peak; for (let i = 0; i < data.length; i++) data[i] *= g; }
  return data;
}

// 10 ms RMS frames, smoothed over ~50 ms
export function envelope(data, sr) {
  const hop = Math.max(1, Math.round(sr * 0.01));
  const frames = Math.floor(data.length / hop);
  const raw = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let s = 0; const o = f * hop;
    for (let i = 0; i < hop; i++) { const v = data[o + i]; s += v * v; }
    raw[f] = Math.sqrt(s / hop);
  }
  const env = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let s = 0, c = 0;
    for (let k = -2; k <= 2; k++) { const j = f + k; if (j >= 0 && j < frames) { s += raw[j]; c++; } }
    env[f] = s / c;
  }
  return { env, hop };
}

function maxOf(a) { let m = 0; for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i]; return m; }
const len = s => s.end - s.start;

// cut off silence before and after the phrase
export function trim(data, sr) {
  const { env, hop } = envelope(data, sr);
  const thr = Math.max(maxOf(env) * 0.05, 0.003);
  let a = 0, b = env.length - 1;
  while (a < env.length && env[a] < thr) a++;
  while (b > a && env[b] < thr) b--;
  if (a >= b) return data;
  const pad = Math.round(sr * 0.02);
  return data.slice(Math.max(0, a * hop - pad), Math.min(data.length, (b + 1) * hop + pad));
}

// quietest 10 ms spot between a and b
function bestCut(data, a, b, sr) {
  const w = Math.max(1, Math.round(sr * 0.01)), stepW = Math.max(1, Math.round(w / 2));
  let best = Math.floor((a + b) / 2), bv = Infinity;
  for (let i = a; i < b - w; i += stepW) {
    let s = 0;
    for (let k = 0; k < w; k++) s += data[i + k] * data[i + k];
    if (s < bv) { bv = s; best = i + Math.floor(w / 2); }
  }
  return best;
}

// mode: 'auto' (syllables, 6–16 chops) or a number for equal chops
export function findSlices(data, sr, mode = 'auto') {
  const n = data.length;
  const minLen = Math.round(sr * 0.06);

  if (mode !== 'auto') {
    const k = Number(mode), out = [];
    for (let i = 0; i < k; i++) out.push({ start: Math.floor(i * n / k), end: Math.floor((i + 1) * n / k) });
    return out;
  }

  const { env, hop } = envelope(data, sr);
  const max = maxOf(env);
  const peakThr = max * 0.12, silThr = Math.max(max * 0.05, 0.003);

  // energy peaks (one per syllable, at least ~80 ms apart)
  const peaks = [], W = 8;
  for (let f = 0; f < env.length; f++) {
    const v = env[f];
    if (v < peakThr) continue;
    let isPeak = true;
    for (let k = -W; k <= W && isPeak; k++) {
      const j = f + k;
      if (k === 0 || j < 0 || j >= env.length) continue;
      if (env[j] > v || (env[j] === v && j < f)) isPeak = false;
    }
    if (isPeak) peaks.push(f);
  }

  // cut at the dip between neighbouring peaks when it's deep enough
  const cuts = [0];
  for (let p = 0; p < peaks.length - 1; p++) {
    const a = peaks[p], b = peaks[p + 1];
    let mi = a;
    for (let f = a; f <= b; f++) if (env[f] < env[mi]) mi = f;
    if (env[mi] < 0.65 * Math.min(env[a], env[b])) cuts.push(mi * hop);
  }
  cuts.push(n);

  // tighten each slice past silence
  let slices = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const s = cuts[i], e = cuts[i + 1];
    let fs = Math.floor(s / hop), fe = Math.min(env.length - 1, Math.ceil(e / hop) - 1);
    while (fs < fe && env[fs] < silThr) fs++;
    while (fe > fs && env[fe] < silThr) fe--;
    const ns = Math.max(s, fs * hop - hop);
    const ne = Math.min(e, (fe + 1) * hop + 2 * hop);
    if (ne - ns >= minLen) slices.push({ start: ns, end: ne });
  }
  if (!slices.length) slices = [{ start: 0, end: n }];

  // at most 16 pads: merge the shortest chop into its shorter neighbour
  while (slices.length > 16) {
    let si = 0;
    for (let i = 1; i < slices.length; i++) if (len(slices[i]) < len(slices[si])) si = i;
    const left = si - 1, right = si + 1 < slices.length ? si + 1 : -1;
    const j = right < 0 ? left : (left < 0 ? right : (len(slices[left]) < len(slices[right]) ? left : right));
    const a = Math.min(si, j);
    slices.splice(a, 2, { start: slices[a].start, end: slices[a + 1].end });
  }

  // at least 6 pads: split the longest chop at its quietest point
  while (slices.length < 6) {
    let li = 0;
    for (let i = 1; i < slices.length; i++) if (len(slices[i]) > len(slices[li])) li = i;
    const s = slices[li];
    if (len(s) < minLen * 2) break;
    const mid = bestCut(data, s.start + Math.floor(len(s) * 0.35), s.start + Math.floor(len(s) * 0.65), sr);
    slices.splice(li, 1, { start: s.start, end: mid }, { start: mid, end: s.end });
  }

  return slices;
}

// forward + reversed buffers per chop, with tiny fades so nothing clicks
export function makeSliceBuffers(ctx, data, sr, slices) {
  const fadeIn = Math.max(1, Math.round(sr * 0.002));
  const fadeOut = Math.max(1, Math.round(sr * 0.006));
  return slices.map(({ start, end }) => {
    const L = Math.max(1, end - start);
    const fwd = ctx.createBuffer(1, L, sr), rev = ctx.createBuffer(1, L, sr);
    const f = fwd.getChannelData(0), r = rev.getChannelData(0);
    for (let i = 0; i < L; i++) {
      let g = 1;
      if (i < fadeIn) g = i / fadeIn;
      else if (i > L - fadeOut) g = (L - i) / fadeOut;
      f[i] = (data[start + i] || 0) * g;
    }
    for (let i = 0; i < L; i++) r[i] = f[L - 1 - i];
    return { fwd, rev, dur: L / sr };
  });
}
