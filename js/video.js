// video.js — the video layer. Each pad gets a piece of a video you load; whenever a pad plays, its piece plays.
// The video is pre-cut into still frames when it loads, so playback and export never have to seek.
//
// Modes (how a pad's audio chop picks its stretch of video):
//   TRIM    — video cut at the same points as the audio, normal speed (extra video past the audio's end is unused)
//   STRETCH — whole video sped up / slowed by one factor to fit the audio's length, then cut at the same points
//   WARP    — video split into equal pieces, one per pad; each piece squeezed or stretched to fit its own chop

import { holdSteps } from './sequencer.js';

export const MODES = ['trim', 'stretch', 'warp'];

const FRAME_W = 360, FRAME_H = 640;   // cached frame size (9:16, cropped to fill)
const MAX_FRAMES = 180, MAX_FPS = 30;

export const V = {
  frames: [],      // ImageBitmaps / canvases
  fps: 0,
  dur: 0,          // video length in seconds
  name: '',
};

export const hasVideo = () => V.frames.length > 0;

const once = (el, ev) => new Promise((res, rej) => {
  const ok = () => { off(); res(); }, bad = () => { off(); rej(new Error(ev + ' failed')); };
  const off = () => { el.removeEventListener(ev, ok); el.removeEventListener('error', bad); };
  el.addEventListener(ev, ok); el.addEventListener('error', bad);
});

// draw src into ctx, cropped to fill w×h (like object-fit: cover)
function drawCover(ctx, src, sw, sh, w, h) {
  const s = Math.max(w / sw, h / sh);
  const dw = sw * s, dh = sh * s;
  ctx.drawImage(src, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

// loads a video file and cuts it into frames; onProgress(done, total)
export async function loadVideo(file, onProgress = () => {}) {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto';
  v.setAttribute('playsinline', ''); v.setAttribute('muted', '');
  v.src = url;
  try {
    await once(v, 'loadeddata');
    try { await v.play(); v.pause(); } catch (e) { /* iOS sometimes needs this to show frames; fine if refused */ }
    const dur = v.duration;
    if (!isFinite(dur) || dur <= 0) throw new Error('no duration');
    const fps = Math.max(4, Math.min(MAX_FPS, Math.floor(MAX_FRAMES / dur)));
    const total = Math.max(1, Math.floor(dur * fps));
    const cv = document.createElement('canvas');
    cv.width = FRAME_W; cv.height = FRAME_H;
    const cx = cv.getContext('2d');
    const frames = [];
    for (let k = 0; k < total; k++) {
      const t = Math.min(dur - 0.001, (k + 0.5) / fps);
      v.currentTime = t;
      await once(v, 'seeked');
      cx.fillStyle = '#000'; cx.fillRect(0, 0, FRAME_W, FRAME_H);
      drawCover(cx, v, v.videoWidth, v.videoHeight, FRAME_W, FRAME_H);
      frames.push(window.createImageBitmap ? await createImageBitmap(cv) : cloneCanvas(cv));
      onProgress(k + 1, total);
    }
    V.frames.forEach(f => f.close && f.close());
    Object.assign(V, { frames, fps, dur, name: file.name || 'video' });
  } finally {
    v.removeAttribute('src'); v.load();
    URL.revokeObjectURL(url);
  }
}

function cloneCanvas(src) {
  const c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  c.getContext('2d').drawImage(src, 0, 0);
  return c;
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

export function drawAt(ctx, w, h, vt) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  if (!hasVideo() || vt == null) return;
  const k = Math.max(0, Math.min(V.frames.length - 1, Math.floor(vt * V.fps)));
  ctx.drawImage(V.frames[k], 0, 0, w, h);
}

// pick the best recording format this browser has; Safari gives MP4
export function recorderType() {
  if (!window.MediaRecorder) return null;
  const types = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a', 'video/mp4;codecs=h264,aac', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return types.find(t => { try { return MediaRecorder.isTypeSupported(t); } catch (e) { return false; } }) || null;
}

// records the loop as a vertical 720×1280 video with the rendered audio, in real time.
// audioBuf: AudioBuffer from renderLoopBuffer. onTick(fraction) for progress.
export async function recordVideo(S, mode, ctx, audioBuf, onTick = () => {}) {
  const type = recorderType();
  if (!type) throw new Error('no recorder');
  const W = 720, H = 1280;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const cx = cv.getContext('2d');
  const stepDur = 60 / S.bpm / 4;
  const dest = ctx.createMediaStreamDestination();
  const src = ctx.createBufferSource();
  src.buffer = audioBuf;
  src.connect(dest);
  src.connect(ctx.destination); // so you hear it while it records
  const stream = cv.captureStream(30);
  dest.stream.getAudioTracks().forEach(t => stream.addTrack(t));
  const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 6_000_000, audioBitsPerSecond: 192_000 });
  const chunks = [];
  rec.ondataavailable = ev => { if (ev.data && ev.data.size) chunks.push(ev.data); };
  const stopped = new Promise(res => { rec.onstop = res; });

  let vt = null;
  const frameAt = t => {
    const k = Math.floor(t / stepDur);
    const i = ((k % S.pattern.length) + S.pattern.length) % S.pattern.length;
    vt = patternTime(S, mode, i, t - k * stepDur);
    drawAt(cx, W, H, vt);
  };
  frameAt(0);
  rec.start(250);
  const t0 = ctx.currentTime + 0.15;
  src.start(t0);
  const dur = audioBuf.duration;
  await new Promise(res => {
    const loop = () => {
      const t = ctx.currentTime - t0;
      frameAt(Math.max(0, Math.min(t, dur - 0.001)));
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
