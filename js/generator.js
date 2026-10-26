// generator.js — random chop patterns. Low chaos = phrase-like order and repeats; high = wild.

const PITCHES = [-12, -7, -5, -3, 3, 5, 7, 12];
const rnd = () => Math.random();
const pick = a => a[Math.floor(rnd() * a.length)];

export function emptyStep() { return { slice: null, rev: false, pitch: 0, stutter: 1, len: 1 }; }
export function emptyPattern(len) { return Array.from({ length: len }, emptyStep); }

// every hit gets FX candidates; the FX buttons decide at playback whether they're heard
function rollFx(step, chaos) {
  step.rev = rnd() < 0.08 + chaos * 0.3;
  step.pitch = rnd() < 0.12 + chaos * 0.35 ? pick(PITCHES) : 0;
  step.stutter = rnd() < 0.08 + chaos * 0.3 ? pick([2, 2, 3, 4]) : 1;
  step.len = rnd() < chaos * 0.4 ? 0.4 : 1;
  return step;
}

function hit(slice, chaos) { return rollFx({ slice }, chaos); }

function nextSlice(prev, n, chaos) {
  const r = rnd(), inOrder = (1 - chaos) * 0.55;
  if (r < inOrder) return (prev + 1) % n;
  if (r < inOrder + 0.2) return prev;
  return Math.floor(rnd() * n);
}

function cell(n, size, chaos) {
  const out = [];
  let prev = n - 1; // so "in order" starts on chop 1
  for (let i = 0; i < size; i++) {
    const p = i === 0 ? 1 : (i % 4 === 0 ? 0.8 : 0.38 + chaos * 0.35);
    if (rnd() < p) {
      prev = i === 0 && chaos < 0.5 ? 0 : nextSlice(prev, n, chaos); // calm patterns open on chop 1
      out.push(hit(prev, chaos));
    }
    else out.push(emptyStep());
  }
  return out;
}

function mutate(pattern, n, chaos, count) {
  for (let c = 0; c < count; c++) {
    const i = Math.floor(rnd() * pattern.length);
    const st = pattern[i];
    if (st.slice == null) pattern[i] = hit(Math.floor(rnd() * n), chaos);
    else if (rnd() < 0.3 && i !== 0) pattern[i] = emptyStep();
    else pattern[i] = hit(Math.floor(rnd() * n), chaos);
  }
  return pattern;
}

// 8-step idea, repeated to fill the length, each repeat slightly mutated
export function generate(n, len, chaos) {
  if (!n) return emptyPattern(len);
  const base = cell(n, 8, chaos);
  let pat = [];
  while (pat.length < len) {
    const copy = base.map(s => ({ ...s }));
    if (pat.length) mutate(copy, n, chaos, Math.round(1 + chaos * 4));
    pat = pat.concat(copy);
  }
  return pat.slice(0, len);
}

// change a few steps of the current pattern
export function vary(pattern, n, chaos) {
  if (!n) return pattern;
  const copy = pattern.map(s => ({ ...s }));
  return mutate(copy, n, chaos, 2 + Math.round(chaos * 3));
}

// 16 → 32 keeps what you have and adds a varied second half
export function extend(pattern, n, chaos) {
  return pattern.concat(vary(pattern, n, chaos));
}
