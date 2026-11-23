// video.js — the video layer. Each pad gets a piece of a video you load; whenever a pad plays, its piece plays.
// The video is pre-cut into still frames when it loads (720×1280 JPEGs, so they stay sharp but light on memory),
// so playback and export never have to seek.
//
// Modes (how a pad's audio chop picks its stretch of video):
//   TRIM    — video cut at the same points as the audio, normal speed (extra video past the audio's end is unused)
//   STRETCH — whole video sped up / slowed by one factor to fit the audio's length, then cut at the same points
//   WARP    — video split into equal pieces, one per pad; each piece squeezed or stretched to fit its own chop

import { holdSteps } from './sequencer.js';

export const MODES = ['trim', 'stretch', 'warp'];

const FRAME_W = 720, FRAME_H = 1280;  // stored frame size (9:16, cropped to fill)
const MAX_FRAMES = 600, MAX_FPS = 30;  // full 30 fps for clips up to 20 s
const JPEG_Q = 0.9;
const OUT_W = 1080, OUT_H = 1920, OUT_FPS = 30, OUT_BITRATE = 12_000_000; // Reels size

export const V = {
  frames: [],      // <img> elements holding JPEG frames
  fps: 0,
  dur: 0,          // video length in seconds
  name: '',
};

export const hasVideo = () => V.frames.length > 0;

// wait for an event, giving up after ms (rejects with a short code shown in the status line)
const once = (el, ev, ms = 8000, code = ev.toUpperCase()) => new Promise((res, rej) => {
  let timer;
  const off = () => { clearTimeout(timer); el.removeEventListener(ev, ok); el.removeEventListener('error', bad); };
  const ok = () => { off(); res(); };
  const bad = () => { off(); rej(new Error('CAN\'T DECODE')); };
  el.addEventListener(ev, ok); el.addEventListener('error', bad);
  timer = setTimeout(() => { off(); rej(new Error('NO ' + code)); }, ms);
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

// after a seek, wait until the new frame is actually on the video (Safari can lag behind 'seeked')
function framePainted(v, ms = 50) {
  return new Promise(res => {
    const t = setTimeout(res, ms);
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(() => { clearTimeout(t); res(); });
  });
}

// draw src into ctx, cropped to fill w×h (like object-fit: cover)
function drawCover(ctx, src, sw, sh, w, h) {
  const s = Math.max(w / sw, h / sh);
  const dw = sw * s, dh = sh * s;
  ctx.drawImage(src, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

// true when a frame came out empty (all one colour) — what Safari gives when it hasn't decoded anything
function isBlank(cx) {
  const d = cx.getImageData(0, 0, FRAME_W, FRAME_H).data;
  let min = 255, max = 0;
  for (let i = 0; i < d.length; i += 4 * 211) {
    const y = d[i] + d[i + 1] + d[i + 2];
    if (y < min) min = y; if (y > max) max = y;
  }
  return max - min < 6;
}

// a canvas snapshot as a JPEG-backed <img>. toBlob copies the canvas when called, so the canvas can be redrawn at once.
function snapJpeg(cv) {
  return new Promise((res, rej) => {
    cv.toBlob(blob => {
      if (!blob) { rej(new Error('NO JPEG')); return; }
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error('BAD JPEG'));
      img.src = URL.createObjectURL(blob);
    }, 'image/jpeg', JPEG_Q);
  });
}

function drawFrame(cx, v) {
  cx.fillStyle = '#000'; cx.fillRect(0, 0, FRAME_W, FRAME_H);
  drawCover(cx, v, v.videoWidth, v.videoHeight, FRAME_W, FRAME_H);
}

// main method: play the video (muted) and grab frames as they go by. Saving a sharp frame takes a moment, so when
// too many are waiting the video pauses until they catch up, which means a busy phone doesn't skip frames.
// Fills only empty slots, so a second, slower pass can catch anything missed.
async function playPass(v, cx, cv, dur, fps, slots, rate, onProgress) {
  const total = slots.length, pending = new Set();
  const HIGH = 6, LOW = 2;
  let held = false, done = false;
  v.currentTime = 0;
  try { await once(v, 'seeked', 2000, 'SEEK'); } catch (e) { /* already at 0 */ }
  v.loop = false;
  v.playbackRate = rate;
  await v.play();
  await new Promise(res => {
    let give = setTimeout(finish, (dur / rate + 20) * 1000);
    function finish() { if (done) return; done = true; clearTimeout(give); res(); }
    const next = () => (v.requestVideoFrameCallback ? v.requestVideoFrameCallback(grab) : requestAnimationFrame(() => grab()));
    const resumeIfReady = () => {
      if (held && pending.size <= LOW && !done) {
        held = false;
        clearTimeout(give); give = setTimeout(finish, (Math.max(0, dur - v.currentTime) / rate + 20) * 1000);
        v.play().catch(() => {});
      }
    };
    const grab = (now, meta) => {
      if (done) return;
      const t = meta && meta.mediaTime != null ? meta.mediaTime : v.currentTime;
      // +0.02 so a frame stamped exactly k/fps (often a hair under, in floating point) lands in slot k, not k-1
      const k = Math.min(total - 1, Math.floor(t * fps + 0.02));
      if (!slots[k]) {
        drawFrame(cx, v);
        slots[k] = 'busy';
        const job = snapJpeg(cv).then(img => { slots[k] = img; }, () => { slots[k] = null; })
          .finally(() => { pending.delete(job); onProgress(slots.filter(f => f && f !== 'busy').length, total); resumeIfReady(); });
        pending.add(job);
        if (pending.size >= HIGH && !held) { held = true; v.pause(); }
      }
      if (v.ended || v.currentTime >= dur - 0.02) { finish(); return; }
      next();
    };
    v.addEventListener('ended', finish, { once: true });
    next();
  });
  v.pause();
  v.playbackRate = 1;
  await Promise.all([...pending]);
}

// backup method: jump to each missing frame and grab it
async function seekPass(v, cx, cv, dur, fps, slots, onProgress) {
  const total = slots.length;
  let tried = 0, blanks = 0;
  for (let k = 0; k < total; k++) {
    if (slots[k]) continue;
    v.currentTime = Math.min(dur - 0.001, (k + 0.5) / fps);
    await once(v, 'seeked', 3000, 'SEEK');
    await framePainted(v);
    drawFrame(cx, v);
    if (tried < 6 && isBlank(cx)) blanks++;
    if (++tried === 6 && blanks === 6) throw new Error('BLANK');   // Safari isn't giving frames this way
    slots[k] = await snapJpeg(cv);
    onProgress(slots.filter(Boolean).length, total);
  }
}

const missing = slots => slots.filter(f => !f).length;

// loads a video file and cuts it into frames; onProgress(done, total)
export async function loadVideo(file, onProgress = () => {}) {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.muted = true; v.defaultMuted = true; v.playsInline = true; v.preload = 'auto';
  v.setAttribute('playsinline', ''); v.setAttribute('webkit-playsinline', ''); v.setAttribute('muted', '');
  // iOS only decodes video that's on the page, so park it there almost invisibly
  Object.assign(v.style, { position: 'fixed', left: '0', top: '0', width: '4px', height: '4px', opacity: '0.01', pointerEvents: 'none', zIndex: '-1' });
  document.body.appendChild(v);
  v.src = url;
  v.load();
  try {
    await once(v, 'loadedmetadata', 15000, 'METADATA');
    try { await v.play(); await sleep(120); } catch (e) { /* muted inline play is allowed on iOS; fine if not */ }
    v.pause();
    const dur = v.duration;
    if (!isFinite(dur) || dur <= 0) throw new Error('NO LENGTH');
    if (!v.videoWidth || !v.videoHeight) throw new Error('NO PICTURE');
    const fps = Math.max(4, Math.min(MAX_FPS, Math.floor(MAX_FRAMES / dur)));
    const total = Math.max(1, Math.floor(dur * fps));
    const cv = document.createElement('canvas');
    cv.width = FRAME_W; cv.height = FRAME_H;
    const cx = cv.getContext('2d', { willReadFrequently: true });
    const slots = new Array(total).fill(null);
    // play it through; if the phone missed frames, play again slower to fill just those; jump to any still missing
    const forceSeek = location.hash === '#seekgrab'; // for testing the backup
    if (!forceSeek) {
      for (const rate of [1, 0.5]) {
        try { await playPass(v, cx, cv, dur, fps, slots, rate, onProgress); } catch (e) { break; }
        console.log(`[video] pass at ${rate}x: ${total - missing(slots)}/${total} frames`);
        if (missing(slots) <= total * 0.02) break;
      }
    }
    if (missing(slots)) {
      try { await seekPass(v, cx, cv, dur, fps, slots, onProgress); } catch (e) { if (!slots.some(Boolean)) throw e; }
    }
    // any frame still missing borrows its neighbour
    let last = slots.find(Boolean);
    if (!last) throw new Error('NO FRAMES');
    const frames = slots.map(f => (last = f || last));
    V.frames.forEach(img => { try { URL.revokeObjectURL(img.src); } catch (e) { /* ignore */ } });
    Object.assign(V, { frames, fps, dur, name: file.name || 'video' });
  } finally {
    v.pause();
    v.removeAttribute('src'); v.load();
    v.remove();
    URL.revokeObjectURL(url);
  }
}

// stretch of video (seconds) that pad `slice` uses
function segment(S, mode, slice, chopDur) {
  const audioDur = S.raw ? S.raw.length / S.sr : 1;
  const a0 = S.slices[slice] ? S.slices[slice].start / S.sr : 0;
  if (mode === 'stretch') {
    const k = V.dur / audioDur;
    return [a0 * k, (a0 + chopDur) * k];
  }
  if (mode === 'warp') {
    const n = Math.max(1, S.slices.length), w = V.dur / n;
    return [slice * w, (slice + 1) * w];
  }
  return [a0, a0 + chopDur]; // trim
}

// video time for one chop, `e` seconds after it started (pitch speeds it up, REV runs it backwards)
function chopTime(S, mode, slice, e, rate, rev) {
  const b = S.bufs[slice];
  if (!b) return 0;
  let p = Math.min(1, Math.max(0, (e * rate) / b.dur));
  if (rev) p = 1 - p;
  const [s0, s1] = segment(S, mode, slice, b.dur);
  return s0 + p * (s1 - s0);
}

// video time while the pattern plays: step i started e seconds ago. Mirrors scheduleStep (hold, stutter, gate-free).
export function patternTime(S, mode, i, e) {
  const P = S.pattern, L = P.length;
  if (!L) return null;
  const stepDur = 60 / S.bpm / 4;
  let h = i, back = 0;
  while (P[h].slice == null) {
    h = (h - 1 + L) % L; back++;
    if (back >= L) return null;
  }
  const st = P[h], fx = S.fx;
  let t = e + back * stepDur;
  const hold = holdSteps(P, h) * stepDur * st.len;
  const n = fx.stutter && st.stutter > 1 ? st.stutter : 1;
  const sub = Math.min(stepDur, hold) / n;
  if (n > 1) t = t < (n - 1) * sub ? t % sub : t - (n - 1) * sub;
  t = Math.min(t, Math.max(sub, hold));
  const rate = fx.pitch && st.pitch ? Math.pow(2, st.pitch / 12) : 1;
  return chopTime(S, mode, st.slice, t, rate, !!(fx.rev && st.rev));
}

// one pad on its own (pad taps)
export function padTime(S, mode, slice, e) { return chopTime(S, mode, slice, e, 1, false); }

const frameIndex = vt => Math.max(0, Math.min(V.frames.length - 1, Math.floor(vt * V.fps)));

export function drawAt(ctx, w, h, vt) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  if (!hasVideo() || vt == null) return;
  ctx.drawImage(V.frames[frameIndex(vt)], 0, 0, w, h);
}

// pick the best recording format this browser has; Safari gives MP4
export function recorderType() {
  if (!window.MediaRecorder) return null;
  const types = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a', 'video/mp4;codecs=h264,aac', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return types.find(t => { try { return MediaRecorder.isTypeSupported(t); } catch (e) { return false; } }) || null;
}

// records the loop as a vertical 1080×1920 video with the rendered audio, in real time.
// Frames are drawn on an exact 30 fps grid (and pushed with requestFrame where the browser has it) to keep timing even.
// audioBuf: AudioBuffer from renderLoopBuffer. onTick(fraction, videoTime) for progress.
export async function recordVideo(S, mode, ctx, audioBuf, onTick = () => {}) {
  const type = recorderType();
  if (!type) throw new Error('no recorder');
  const W = OUT_W, H = OUT_H;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const cx = cv.getContext('2d');
  cx.imageSmoothingQuality = 'high';
  const stepDur = 60 / S.bpm / 4;
  const dur = audioBuf.duration;
  const timeAt = t => {
    const k = Math.floor(t / stepDur);
    const i = ((k % S.pattern.length) + S.pattern.length) % S.pattern.length;
    return patternTime(S, mode, i, t - k * stepDur);
  };
  // decode every frame the export will show before recording starts, so drawing never stalls
  const need = new Set();
  for (let n = 0; n <= dur * OUT_FPS; n++) { const vt = timeAt(n / OUT_FPS); if (vt != null) need.add(frameIndex(vt)); }
  await Promise.all([...need].map(k => (V.frames[k].decode ? V.frames[k].decode().catch(() => {}) : null)));

  const dest = ctx.createMediaStreamDestination();
  const src = ctx.createBufferSource();
  src.buffer = audioBuf;
  src.connect(dest);
  src.connect(ctx.destination); // so you hear it while it records
  let stream = cv.captureStream(0);
  let track = stream.getVideoTracks()[0];
  if (!track || typeof track.requestFrame !== 'function') { stream = cv.captureStream(OUT_FPS); track = null; }
  dest.stream.getAudioTracks().forEach(t => stream.addTrack(t));
  const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: OUT_BITRATE, audioBitsPerSecond: 192_000 });
  const chunks = [];
  rec.ondataavailable = ev => { if (ev.data && ev.data.size) chunks.push(ev.data); };
  const stopped = new Promise(res => { rec.onstop = res; });

  let vt = null, lastN = -1;
  const show = n => {
    vt = timeAt(Math.min(n / OUT_FPS, dur - 0.001));
    drawAt(cx, W, H, vt);
    if (track) track.requestFrame();
  };
  show(0);
  rec.start(250);
  const t0 = ctx.currentTime + 0.15;
  src.start(t0);
  await new Promise(res => {
    const loop = () => {
      const t = ctx.currentTime - t0;
      const n = Math.max(0, Math.floor(t * OUT_FPS));
      if (n !== lastN) { lastN = n; show(n); }
      onTick(Math.max(0, Math.min(1, t / dur)), vt);
      if (t >= dur + 0.1) return res();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  rec.stop();
  await stopped;
  try { src.disconnect(); } catch (e) { /* ignore */ }
  const ext = type.startsWith('video/mp4') ? 'mp4' : 'webm';
  return { blob: new Blob(chunks, { type: type.split(';')[0] }), ext };
}
