// sequencer.js — schedules chops on the audio clock. scheduleStep is shared with WAV export.

import { getCtx, getChain } from './audio.js';

// how many steps until the next hit (a chop rings until the next one starts)
export function holdSteps(pattern, i) {
  const L = pattern.length;
  for (let k = 1; k <= L; k++) if (pattern[(i + k) % L].slice != null) return k;
  return L;
}

// gate: { start, period } chops the sound into on/off pulses locked to the step grid
function playVoice(c, dest, buf, rate, t, d, gate) {
  const maxD = buf.duration / rate;
  d = Math.min(d, maxD);
  if (d < 0.015) d = Math.min(0.015, maxD);
  if (d <= 0) return;
  const src = c.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = rate;
  const g = c.createGain();
  if (gate) {
    // on for the first half of every pulse, silent for the rest
    const P = gate.period, on = P * 0.5, end = t + d;
    g.gain.setValueAtTime(0, t);
    let k = Math.floor((t - gate.start) / P + 1e-6);
    for (; gate.start + k * P < end; k++) {
      const a = Math.max(t, gate.start + k * P), b = Math.min(end, gate.start + k * P + on);
      if (b - a < 0.008) continue;
      g.gain.setValueAtTime(0, a);
      g.gain.linearRampToValueAtTime(1, a + 0.003);
      g.gain.setValueAtTime(1, b - 0.004);
      g.gain.linearRampToValueAtTime(0, b);
    }
  } else {
    const fadeOutAt = Math.max(t + 0.003, t + d - 0.008);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(1, t + 0.003);
    g.gain.setValueAtTime(1, fadeOutAt);
    g.gain.linearRampToValueAtTime(0, t + d);
  }
  src.connect(g);
  g.connect(dest);
  src.start(t);
  src.stop(t + d + 0.02);
  src.onended = () => { try { g.disconnect(); } catch (e) { /* ignore */ } };
}

export function scheduleStep(c, dest, bufs, pattern, i, time, stepDur, fx) {
  const st = pattern[i];
  if (!st || st.slice == null) return;
  const b = bufs[st.slice];
  if (!b) return;
  const buf = fx.rev && st.rev ? b.rev : b.fwd;
  const rate = fx.pitch && st.pitch ? Math.pow(2, st.pitch / 12) : 1;
  const hold = holdSteps(pattern, i) * stepDur * st.len;
  const n = fx.stutter && st.stutter > 1 ? st.stutter : 1;
  const sub = Math.min(stepDur, hold) / n;
  const gate = fx.gate ? { start: time, period: stepDur / 2 } : null; // 32nd-note trance gate
  for (let k = 0; k < n; k++) {
    const d = k < n - 1 ? sub : Math.max(sub, hold - (n - 1) * sub);
    playVoice(c, dest, buf, rate, time + k * sub, d, gate);
  }
}

// audition one chop straight away (pad taps)
export function playChop(bufs, slice) {
  const b = bufs[slice];
  if (!b) return;
  const c = getCtx();
  playVoice(c, getChain().input, b.fwd, 1, c.currentTime + 0.005, b.dur);
}

export class Sequencer {
  constructor(getState, onStep) {
    this.getState = getState;
    this.onStep = onStep;
    this.playing = false;
    this.timer = null;
    this.queue = [];
  }

  start() {
    if (this.playing) return;
    const c = getCtx();
    this.playing = true;
    this.step = 0;
    this.next = c.currentTime + 0.06;
    this.queue = [];
    this.timer = setInterval(() => this.tick(), 25);
    this.tick();
    this.frame();
  }

  stop() {
    this.playing = false;
    clearInterval(this.timer);
    this.queue = [];
    this.onStep(-1);
  }

  tick() {
    if (!this.playing) return;
    const c = getCtx(), S = this.getState();
    if (!S.pattern.length) return;
    const stepDur = 60 / S.bpm / 4;
    if (this.next < c.currentTime - 0.05) this.next = c.currentTime + 0.05; // woke up late
    while (this.next < c.currentTime + 0.12) {
      const i = this.step % S.pattern.length;
      scheduleStep(c, getChain().input, S.bufs, S.pattern, i, this.next, stepDur, S.fx);
      this.queue.push({ i, t: this.next });
      this.next += stepDur;
      this.step = (i + 1) % S.pattern.length;
    }
  }

  frame() {
    if (!this.playing) return;
    const c = getCtx();
    let last = null;
    while (this.queue.length && this.queue[0].t <= c.currentTime) last = this.queue.shift();
    if (last) this.onStep(last.i);
    requestAnimationFrame(() => this.frame());
  }
}
