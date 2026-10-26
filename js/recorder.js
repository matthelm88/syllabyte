// recorder.js — mic recording to an AudioBuffer.

let stream = null;
let rec = null;
let chunks = [];

export function isRecording() { return !!rec && rec.state === 'recording'; }

export async function startRecording() {
  stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  const types = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];
  const type = window.MediaRecorder && MediaRecorder.isTypeSupported
    ? types.find(t => MediaRecorder.isTypeSupported(t)) : undefined;
  rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  chunks = [];
  rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.start();
}

export function stopRecording(ctx) {
  return new Promise((resolve, reject) => {
    if (!rec) { reject(new Error('not recording')); return; }
    const r = rec;
    r.onstop = async () => {
      if (stream) stream.getTracks().forEach(t => t.stop());
      stream = null; rec = null;
      try {
        const blob = new Blob(chunks, { type: r.mimeType || 'audio/mp4' });
        resolve(await decode(ctx, await blob.arrayBuffer()));
      } catch (e) { reject(e); }
    };
    r.stop();
  });
}

export function decode(ctx, arrayBuffer) {
  return new Promise((resolve, reject) => {
    const p = ctx.decodeAudioData(arrayBuffer, resolve, reject);
    if (p && p.then) p.then(resolve, reject);
  });
}
