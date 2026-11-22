// main.js — wires the screen to the engine.

import { getCtx, getChain, unlock, setSession } from './audio.js';
import { startRecording, stopRecording, isRecording, decode } from './recorder.js';
import { toMono, normalize, trim, findSlices, makeSliceBuffers } from './chopper.js';
import { generate, vary, extend, emptyPattern, emptyStep } from './generator.js';
import { Sequencer, playChop } from './sequencer.js';
import { renderLoop, renderLoopBuffer, shareWav, shareFile, isMobile } from './exporter.js';
import { MODES as VID_MODES, hasVideo, loadVideo, patternTime, padTime, drawAt, recordVideo, recorderType } from './video.js?v=9';
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
  fx: { rev: true, pitch: true, stutter: true, crush: false, filter: false, delay: false,
        drive: false, verb: false, chorus: false, gate: false, tape: false, phone: false },
  selPad: 0,
  playStep: -1,
  wav: null,
  vidMode: 'trim',   // trim | stretch | warp
  hit: null,         // last step that played: { i, t }
  audition: null,    // pad tapped on its own: { slice, t }
  vidOut: null,      // recorded video waiting to be saved
};

const $ = id => document.getElementById(id);
const els = {
  status: $('status'), wave: $('wave'), steps: $('steps'), pads: $('pads'),
  rec: $('btnRec'), play: $('btnPlay'), nw: $('btnNew'), vary: $('btnVary'),
  len: $('btnLen'), chops: $('btnChops'), file: $('fileIn'), exp: $('btnExport'),
  voiceBtn: $('btnVoice'), voices: $('voices'),
  naming: $('naming'), wavName: $('wavName'), wavInfo: $('wavInfo'),
  nameSave: $('btnNameSave'), nameCancel: $('btnNameCancel'),
  bpm: $('bpm'), bpmVal: $('bpmVal'), chaos: $('chaos'), chaosVal: $('chaosVal'),
  vidBtn: $('btnVid'), vidview: $('vidview'), vidCanvas: $('vidCanvas'), vidIn: $('vidIn'),
  lblVid: $('lblVid'), vidMode: $('btnVidMode'), mp4: $('btnMp4'),
};

const setStatus = t => { els.status.textContent = t; };
const hasPhrase = () => S.bufs.length > 0;
const wave = () => S.voiced || S.raw;

/* ---------- sequencer ---------- */
const seq = new Sequencer(() => S, (i, t) => {
  ui.setPlayhead(els.steps, S.playStep, i);
  S.playStep = i;
  S.hit = i >= 0 ? { i, t } : null;
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
  S.audition = null;
  seq.start();
  updatePlayBtn();
}

function stop() { seq.stop(); updatePlayBtn(); }

/* ---------- rendering + saving ---------- */
let saveTimer = null;
function changed({ rebuildSteps = false } = {}) {
  S.wav = null;
  clearVidOut();
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
    bpm: S.bpm, chaos: S.chaos, fx: S.fx, vidMode: S.vidMode,
  });
}

function renderControls() {
  els.len.textContent = S.len + ' STEPS';
  els.voiceBtn.textContent = 'VOX: ' + VOICES.find(v => v.id === S.voice).name;
  els.chops.textContent = S.chopMode === 'auto' ? 'AUTO CHOP' : S.chopMode + ' CHOPS';
  els.vidMode.textContent = S.vidMode.toUpperCase();
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
  S.audition = { slice: i, t: getCtx().currentTime };
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

// WAV: renders 4 bars, then asks for a name; SAVE opens the share sheet (a fresh tap, which iOS needs)
const cleanName = t => t.replace(/\.wav$/i, '').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 60);

function showNaming(open) {
  hideVid();
  els.naming.hidden = !open;
  els.voices.hidden = true;
  els.voiceBtn.classList.remove('on');
  els.pads.hidden = open;
  els.exp.classList.toggle('on', open);
  if (!open) els.wavName.blur();
}

els.exp.addEventListener('click', async () => {
  if (!hasPhrase()) { setStatus('RECORD A PHRASE FIRST'); return; }
  if (!els.naming.hidden) { showNaming(false); return; }
  if (!S.wav) {
    setStatus('RENDERING 4 BARS…');
    try { S.wav = await renderLoop(S, getCtx().sampleRate, 4); }
    catch (e) { setStatus('EXPORT FAILED'); return; }
  }
  els.wavName.value = `syllabyte-${S.bpm}bpm-${Date.now() % 1000}`;
  els.wavInfo.textContent = `4 bars · ${S.bpm} BPM · .wav is added for you`;
  showNaming(true);
  setStatus(isMobile ? 'NAME IT, THEN SAVE ↑' : 'NAME IT, THEN SAVE ↓');
});

// select the whole name on tap so typing replaces it
els.wavName.addEventListener('focus', () => { try { els.wavName.select(); } catch (e) { /* ignore */ } });
els.wavName.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); els.wavName.blur(); } });

els.nameCancel.addEventListener('click', () => { showNaming(false); setStatus('SAVE CANCELLED'); });

els.nameSave.addEventListener('click', async () => {
  if (!S.wav) { showNaming(false); return; }
  const name = (cleanName(els.wavName.value) || `syllabyte-${S.bpm}bpm`) + '.wav';
  const r = await shareWav(S.wav, name);
  if (r === 'cancelled') { setStatus('SAVE CANCELLED'); return; }
  showNaming(false);
  setStatus(r === 'downloaded' ? 'IN DOWNLOADS: ' + name : 'SAVED: ' + name);
});

/* ---------- synth voices ---------- */
function showVoices(open) {
  hideVid();
  els.naming.hidden = true;
  els.exp.classList.remove('on');
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

if (!isMobile) els.nameSave.textContent = 'SAVE ↓'; // on a computer it saves to disk

/* ---------- video (v8) ---------- */
// The video follows the pads: whenever a pad plays, its piece of the video plays. VID shows it in the pads' place.
const vctx = els.vidCanvas.getContext('2d');
let vidLoop = false, lastVt = 0;

function hideVid() {
  els.vidview.hidden = true;
  els.vidBtn.classList.remove('on');
}

function showVid(open) {
  els.naming.hidden = true;
  els.voices.hidden = true;
  els.voiceBtn.classList.remove('on');
  els.exp.classList.remove('on');
  els.vidview.hidden = !open;
  els.pads.hidden = open;
  els.vidBtn.classList.toggle('on', open);
  if (open && !vidLoop) { vidLoop = true; requestAnimationFrame(drawVid); }
}

function currentVidTime() {
  const now = getCtx().currentTime;
  if (seq.playing && S.hit) {
    const vt = patternTime(S, S.vidMode, S.hit.i, Math.max(0, now - S.hit.t));
    if (vt != null) return vt;
  } else if (S.audition && S.bufs[S.audition.slice]) {
    return padTime(S, S.vidMode, S.audition.slice, Math.max(0, now - S.audition.t));
  }
  return lastVt;
}

function drawVid() {
  if (els.vidview.hidden) { vidLoop = false; return; }
  if (hasPhrase() && hasVideo() && !recordingVid) lastVt = currentVidTime();
  drawAt(vctx, els.vidCanvas.width, els.vidCanvas.height, hasVideo() ? lastVt : null);
  if (!hasVideo()) {
    vctx.fillStyle = '#3b7f7c'; vctx.font = '22px "Share Tech Mono", monospace'; vctx.textAlign = 'center';
    vctx.fillText('TAP VIDEO TO LOAD ONE', els.vidCanvas.width / 2, els.vidCanvas.height / 2);
  }
  requestAnimationFrame(drawVid);
}

function clearVidOut() {
  S.vidOut = null;
  els.mp4.textContent = 'MP4';
  els.mp4.classList.remove('ready');
}

els.vidBtn.addEventListener('click', () => { unlock(); showVid(els.vidview.hidden); });

els.vidIn.addEventListener('change', async () => {
  const f = els.vidIn.files && els.vidIn.files[0];
  els.vidIn.value = '';
  if (!f) return;
  setStatus('LOADING VIDEO…');
  try {
    await loadVideo(f, (d, n) => setStatus(`CUTTING VIDEO ${Math.round(d / n * 100)}%`));
  } catch (e) { setStatus('VIDEO FAILED: ' + ((e && e.message) || 'UNKNOWN')); return; }
  els.lblVid.classList.add('has');
  clearVidOut();
  showVid(true);
  setStatus(hasPhrase() ? 'VIDEO LOADED · ' + S.vidMode.toUpperCase() : 'VIDEO LOADED · NOW RECORD OR LOAD AUDIO');
});

els.vidMode.addEventListener('click', () => {
  S.vidMode = VID_MODES[(VID_MODES.indexOf(S.vidMode) + 1) % VID_MODES.length];
  renderControls();
  setStatus('VIDEO: ' + ({ trim: 'TRIM · NORMAL SPEED', stretch: 'STRETCH · ONE SPEED FOR ALL', warp: 'WARP · EACH PAD ITS OWN SPEED' })[S.vidMode]);
  changed();
});

// MP4: records 4 bars in real time (you hear it), then the button turns into SAVE ↑ — a fresh tap, which iOS needs to share
let recordingVid = false;
els.mp4.addEventListener('click', async () => {
  if (recordingVid) return;
  if (S.vidOut) {
    const name = `syllabyte-${S.bpm}bpm-${Date.now() % 1000}.${S.vidOut.ext}`;
    const type = S.vidOut.blob.type || 'video/mp4';
    const r = await shareFile(S.vidOut.blob, name, type, 'Video', '.' + S.vidOut.ext);
    if (r === 'cancelled') { setStatus('SAVE CANCELLED'); return; }
    setStatus(r === 'downloaded' ? 'IN DOWNLOADS: ' + name : 'SAVED: ' + name);
    return;
  }
  if (!hasPhrase()) { setStatus('RECORD A PHRASE FIRST'); return; }
  if (!hasVideo()) { setStatus('LOAD A VIDEO FIRST'); return; }
  if (!recorderType()) { setStatus("THIS BROWSER CAN'T RECORD VIDEO"); return; }
  await unlock();
  stop();
  showVid(true);
  recordingVid = true;
  els.mp4.classList.add('on');
  try {
    setStatus('RENDERING AUDIO…');
    const buf = await renderLoopBuffer(S, getCtx().sampleRate, 4);
    const out = await recordVideo(S, S.vidMode, getCtx(), buf, (p, vt) => {
      setStatus(`RECORDING VIDEO ${Math.round(p * 100)}%`);
      if (vt != null) lastVt = vt;
    });
    S.vidOut = out;
    els.mp4.textContent = 'SAVE ↑';
    els.mp4.classList.add('ready');
    setStatus(`VIDEO READY · TAP SAVE ↑ (${out.ext.toUpperCase()})`);
  } catch (e) {
    setStatus('VIDEO EXPORT FAILED');
  } finally {
    recordingVid = false;
    els.mp4.classList.remove('on');
  }
});

/* ---------- desktop keys: SPACE play/stop · R rec · N new · V vary ---------- */
document.addEventListener('keydown', e => {
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
  if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
  const k = e.key.toLowerCase();
  if (e.target && e.target.tagName === 'BUTTON') e.target.blur(); // stop SPACE also pressing the focused button
  if (k === ' ') { e.preventDefault(); els.play.click(); }
  else if (k === 'r') els.rec.click();
  else if (k === 'n') els.nw.click();
  else if (k === 'v') els.vary.click();
});

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
      vidMode: VID_MODES.includes(sess.vidMode) ? sess.vidMode : 'trim',
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
