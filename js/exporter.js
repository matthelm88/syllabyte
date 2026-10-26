// exporter.js — renders 4 bars of the loop (with FX) to a WAV and hands it to the share sheet.

import { buildChain } from './audio.js';
import { scheduleStep } from './sequencer.js';

export function encodeWAV(buffer) {
  const ch = buffer.numberOfChannels, sr = buffer.sampleRate, n = buffer.length;
  const bytes = 44 + n * ch * 2;
  const ab = new ArrayBuffer(bytes);
  const v = new DataView(ab);
  let o = 0;
  const str = s => { for (let i = 0; i < s.length; i++) v.setUint8(o++, s.charCodeAt(i)); };
  const u32 = x => { v.setUint32(o, x, true); o += 4; };
  const u16 = x => { v.setUint16(o, x, true); o += 2; };
  str('RIFF'); u32(bytes - 8); str('WAVE');
  str('fmt '); u32(16); u16(1); u16(ch); u32(sr); u32(sr * ch * 2); u16(ch * 2); u16(16);
  str('data'); u32(n * ch * 2);
  const data = [];
  for (let c = 0; c < ch; c++) data.push(buffer.getChannelData(c));
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, data[c][i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}

export async function renderLoop(S, sampleRate, bars = 4) {
  const stepDur = 60 / S.bpm / 4;
  const steps = Math.max(S.pattern.length, 16 * bars);
  const off = new OfflineAudioContext(2, Math.ceil(steps * stepDur * sampleRate), sampleRate);
  const chain = buildChain(off);
  chain.output.connect(off.destination);
  chain.update(S.fx, S.bpm, 0);
  for (let k = 0; k < steps; k++) {
    scheduleStep(off, chain.input, S.bufs, S.pattern, k % S.pattern.length, k * stepDur, stepDur, S.fx);
  }
  return encodeWAV(await off.startRendering());
}

export async function shareWav(blob, name) {
  const file = new File([blob], name, { type: 'audio/wav' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return 'shared'; }
    catch (e) { if (e.name === 'AbortError') return 'cancelled'; }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return 'downloaded';
}
