// main.js — wires the screen to the engine.

import { getCtx, getChain, unlock, setSession } from './audio.js';
import { startRecording, stopRecording, isRecording, decode } from './recorder.js';
import { toMono, normalize, trim, findSlices, makeSliceBuffers } from './chopper.js';
import { generate, vary, extend, emptyPattern, emptyStep } from './generator.js';
import { Sequencer, playChop } from './sequencer.js';
import { renderLoop, shareWav } from './exporter.js';
import * as store from './storage.js';
import * as ui from './ui.js';
import { VOICES, renderVoice } from './voices.js';

const MAX_REC_SECONDS = 10;
const CHOP_MODES = ['auto', 8, 16];

const S = {
  raw: null,          // trimmed, normalised mono phrase
  voiced: null,       // the phrase after the synth voice
  voice: 'dry',
  sr: 48000,
  slices: [],
  bufs: [],
  pattern: emptyPattern(16),
  len: 16,
  chopMode: 'auto',
  bpm: 120,
  chaos: 0.35,
  fx: { rev: true, pitch: true, stutter: true, crush: false, filter: false, delay: false },
  selPad: 0,
  playStep: -1,
  wav: null,
};

const $ = id => document.getElementById(id);
const els = {
  status: $('status'), wave: $('wave'), steps: $('steps'), pads: $('pads'),
  rec: $('btnRec'), play: $('btnPlay'), nw: $('btnNew'), vary: $('btnVary'),
  len: $('btnLen'), chops: $('btnChops'), file: $('fileIn'), exp: $('btnExport'),
  voiceBtn: $('btnVoice'), voices: $('voices'),
  bpm: $('bpm'), bpmVal: $('bpmVal'), chaos: $('chaos'), chaosVal: $('chaosVal'),
};

const setStatus = t => { els.status.textContent = t; };
const hasPhrase = () => S.bufs.length > 0;
const wave = () => S.voiced || S.raw;

/* ---------- sequencer ---------- */
const seq = new Sequencer(() => S, i => {
  ui.setPlayhead(els.steps, S.playStep, i);
  S.playStep = i;
  const st = i >= 0 ? S.pattern[i] : null;
  const active = st && st.slice != null ? st.slice : -1;
  ui.renderPads(els.pads, S.selPad, active);
  ui.drawWave(els.wave, wave(), S.slices, active);
});

function updatePlayBtn() {
  els.play.textContent = seq.playing ? '■ STOP' : '▶ PLAY';
  els.play.classList.toggle('on', seq.playing);
}

async function play() {
  if (!hasPhrase()) { setStatus('RECORD A PHRASE FIRST'); return; }
  await unlock();
  getChain().update(S.fx, S.bpm);
  seq.start();
  updatePlayBtn();
}

function stop() { seq.stop(); updatePlayBtn(); }

/* ---------- rendering + saving ---------- */
let saveTimer = null;
function changed({ rebuildSteps = false } = {}) {
  S.wav = null;
  els.exp.textContent = 'WAV';
  els.exp.classList.remove('ready');
  if (rebuildSteps) {
    ui.buildSteps(els.steps, S.pattern, S.fx, onStepTap);
    S.playStep = -1;
  } else {
    ui.renderSteps(els.steps, S.pattern, S.fx);
  }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveSession, 800);
}

function saveSession() {
  store.save('session', {
    chopMode: S.chopMode, pattern: S.pattern, len: S.len, voice: S.voice,
    bpm: S.bpm, chaos: S.chaos, fx: S.fx,
  });
}

function renderControls() {
  els.len.textContent = S.len + ' STEPS';
  els.voiceBtn.textContent = 'VOX: ' + VOICES.find(v => v.id === S.voice).name;
  els.chops.textContent = S.chopMode === 'auto' ? 'AUTO CHOP' : S.chopMode + ' CHOPS';
  els.bpm.value = S.bpm; els.bpmVal.textContent = S.bpm;
  els.chaos.value = Math.round(S.chaos * 100); els.chaosVal.textContent = Math.round(S.chaos * 100);
  document.querySelectorAll('button.fx').forEach(b => b.classList.toggle('on', !!S.fx[b.dataset.fx]));
}

/* ---------- chopping ---------- */
function rechop() {
  S.slices = findSlices(S.raw, S.sr, S.chopMode);
  S.bufs = makeSliceBuffers(getCtx(), wave(), S.sr, S.slices);
  S.selPad = 0;
  ui.buildPads(els.pads, S.slices.length, onPadTap);
  ui.renderPads(els.pads, S.selPad, -1);
  ui.drawWave(els.wave, wave(), S.slices, -1);
}

function newPattern() {
  S.pattern = generate(S.slices.length, S.len, S.chaos);
  changed({ rebuildSteps: true });
}

async function ingest(audioBuffer) {
  S.sr = audioBuffer.sampleRate;
  S.raw = trim(normalize(toMono(audioBuffer)), S.sr);
  if (S.raw.length < S.sr * 0.15) { setStatus('TOO SHORT / TOO QUIET — TRY AGAIN'); return; }
  S.voiced = renderVoice(S.raw, S.sr, S.voice);
  rechop();
  newPattern();
  setStatus(`${S.slices.length} CHOPS · ${(S.raw.length / S.sr).toFixed(1)}s`);
  store.save('audio', { raw: S.raw, sr: S.sr });
  await play();
}

/* ---------- recording ---------- */
let recTimer = null, recClock = null;

async function toggleRec() {
  await unlock();
  if (isRecording()) { await stopRec(); return; }
  stop();
  setSession('play-and-record');
  try {
    await startRecording();
  } catch (e) {
    setSession('playback');
    setStatus('MIC BLOCKED — ALLOW MIC OR USE LOAD');
    return;
  }
  els.rec.classList.add('on');
  els.rec.textContent = '■ STOP';
  const t0 = Date.now();
  setStatus('RECORDING… SAY IT');
  recClock = setInterval(() => setStatus(`RECORDING… ${((Date.now() - t0) / 1000).toFixed(1)}s`), 100);
  recTimer = setTimeout(stopRec, MAX_REC_SECONDS * 1000);
}

async function stopRec() {
  clearTimeout(recTimer); clearInterval(recClock);
  els.rec.classList.remove('on');
  els.rec.textContent = '● REC';
  if (!isRecording()) return;
  setStatus('CHOPPING…');
  try {
    const ab = await stopRecording(getCtx());
    setSession('playback');
    await unlock();
    await ingest(ab);
  } catch (e) {
    setSession('playback');
    setStatus('COULD NOT READ RECORDING');
  }
}

/* ---------- taps ---------- */
function onPadTap(i) {
  unlock();
  S.selPad = i;
  playChop(S.bufs, i);
  ui.renderPads(els.pads, S.selPad, i);
  ui.drawWave(els.wave, wave(), S.slices, i);
}

// tap a step: place the selected pad there; tap again to clear it
function onStepTap(i) {
  if (!hasPhrase()) return;
  const st = S.pattern[i];
  S.pattern[i] = st.slice === S.selPad ? emptyStep() : { ...emptyStep(), slice: S.selPad };
  changed();
}

els.rec.addEventListener('click', toggleRec);
els.play.addEventListener('click', () => (seq.playing ? stop() : play()));

els.nw.addEventListener('click', () => {
  if (!hasPhrase()) { setStatus('RECORD A PHRASE FIRST'); return; }
  newPattern();
  if (!seq.playing) play();
});

els.vary.addEventListener('click', () => {
  if (!hasPhrase()) return;
  S.pattern = vary(S.pattern, S.slices.length, S.chaos);
  changed();
});

els.len.addEventListener('click', () => {
  if (S.len === 16) { S.len = 32; S.pattern = hasPhrase() ? extend(S.pattern, S.slices.length, S.chaos) : emptyPattern(32); }
  else { S.len = 16; S.pattern = S.pattern.slice(0, 16); }
  renderControls();
  changed({ rebuildSteps: true });
});

els.chops.addEventListener('click', () => {
  S.chopMode = CHOP_MODES[(CHOP_MODES.indexOf(S.chopMode) + 1) % CHOP_MODES.length];
  renderControls();
  if (hasPhrase()) {
    rechop();
    newPattern();
    setStatus(`${S.slices.length} CHOPS`);
  } else {
    changed();
  }
});

els.file.addEventListener('change', async () => {
  const f = els.file.files && els.file.files[0];
  els.file.value = '';
  if (!f) return;
  await unlock();
  stop();
  setStatus('LOADING…');
  try { await ingest(await decode(getCtx(), await f.arrayBuffer())); }
  catch (e) { setStatus("CAN'T READ THAT FILE"); }
});

els.bpm.addEventListener('input', () => {
  S.bpm = Number(els.bpm.value);
  els.bpmVal.textContent = S.bpm;
  getChain().update(S.fx, S.bpm);
  changed();
});

els.chaos.addEventListener('input', () => {
  S.chaos = Number(els.chaos.value) / 100;
  els.chaosVal.textContent = els.chaos.value;
  changed();
});

document.querySelectorAll('button.fx').forEach(b => {
  b.addEventListener('click', () => {
    const k = b.dataset.fx;
    S.fx[k] = !S.fx[k];
    b.classList.toggle('on', S.fx[k]);
    getChain().update(S.fx, S.bpm);
    changed();
  });
});

// WAV: first tap renders, second tap opens the share sheet (iOS needs a fresh tap to share)
els.exp.addEventListener('click', async () => {
  if (!hasPhrase()) { setStatus('RECORD A PHRASE FIRST'); return; }
  if (S.wav) {
    const r = await shareWav(S.wav, `syllabyte-${S.bpm}bpm-${Date.now() % 100000}.wav`);
    setStatus(r === 'cancelled' ? 'SHARE CANCELLED' : 'WAV SAVED');
    return;
  }
  setStatus('RENDERING 4 BARS…');
  try {
    S.wav = await renderLoop(S, getCtx().sampleRate, 4);
    els.exp.textContent = 'SAVE ↑';
    els.exp.classList.add('ready');
    setStatus('READY — TAP SAVE ↑');
  } catch (e) {
    setStatus('EXPORT FAILED');
  }
});

/* ---------- synth voices ---------- */
function showVoices(open) {
  els.voices.hidden = !open;
  els.pads.hidden = open;
  els.voiceBtn.classList.toggle('on', open);
  if (open) ui.buildVoices(els.voices, VOICES, S.voice, setVoice);
}

// re-voices the whole phrase, then re-cuts the same chop points from it; the pattern stays
function setVoice(id) {
  S.voice = id;
  showVoices(false);
  renderControls();
  if (hasPhrase()) {
    S.voiced = renderVoice(S.raw, S.sr, S.voice);
    S.bufs = makeSliceBuffers(getCtx(), S.voiced, S.sr, S.slices);
    ui.drawWave(els.wave, wave(), S.slices, -1);
    if (!seq.playing) playChop(S.bufs, S.selPad);
  }
  setStatus('VOICE: ' + VOICES.find(v => v.id === id).name);
  changed();
}

els.voiceBtn.addEventListener('click', () => { unlock(); showVoices(els.voices.hidden); });

window.addEventListener('resize', () => ui.drawWave(els.wave, wave(), S.slices, -1));

/* ---------- start-up: restore last session ---------- */
(async function init() {
  setSession('playback');
  ui.buildSteps(els.steps, S.pattern, S.fx, onStepTap);
  ui.buildPads(els.pads, 0, onPadTap);
  const sess = await store.load('session');
  if (sess) {
    Object.assign(S, {
      chopMode: sess.chopMode ?? S.chopMode, len: sess.len ?? S.len,
      voice: VOICES.some(v => v.id === sess.voice) ? sess.voice : 'dry', bpm: sess.bpm ?? S.bpm, chaos: sess.chaos ?? S.chaos, fx: { ...S.fx, ...(sess.fx || {}) },
    });
  }
  renderControls();
  const audio = await store.load('audio');
  if (audio && audio.raw && audio.raw.length) {
    S.raw = audio.raw; S.sr = audio.sr;
    S.voiced = renderVoice(S.raw, S.sr, S.voice);
    rechop();
    const ok = sess && Array.isArray(sess.pattern) && sess.pattern.length === S.len &&
      sess.pattern.every(s => s.slice == null || s.slice < S.slices.length);
    S.pattern = ok ? sess.pattern : generate(S.slices.length, S.len, S.chaos);
    ui.buildSteps(els.steps, S.pattern, S.fx, onStepTap);
    setStatus(`LAST PHRASE LOADED · ${S.slices.length} CHOPS`);
  } else {
    S.pattern = emptyPattern(S.len);
    ui.buildSteps(els.steps, S.pattern, S.fx, onStepTap);
    ui.drawWave(els.wave, null, [], -1);
  }
})();
