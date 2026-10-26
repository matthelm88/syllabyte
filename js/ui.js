// ui.js — draws the waveform, step lane and pads. Each chop keeps one colour everywhere.

export const COLORS = [
  '#ff5a1f', '#2a7de1', '#e0a800', '#1fa774', '#d64b8a', '#7b5cd6', '#00a3a3', '#e07a1f',
  '#5aa02c', '#c23b3b', '#3b6fc2', '#b8892b', '#2f9c8f', '#a14bc2', '#6b7d2a', '#c2603b',
];

/* ---------- pads ---------- */
export function buildPads(el, n, onTap) {
  el.innerHTML = '';
  for (let i = 0; i < 16; i++) {
    const b = document.createElement('button');
    b.className = 'pad';
    if (i < n) {
      b.style.setProperty('--c', COLORS[i]);
      b.textContent = String(i + 1);
      b.addEventListener('pointerdown', e => { e.preventDefault(); onTap(i); });
    } else {
      b.classList.add('off');
      b.disabled = true;
    }
    el.appendChild(b);
  }
}

export function renderPads(el, sel, active) {
  [...el.children].forEach((b, i) => {
    b.classList.toggle('sel', i === sel);
    b.classList.toggle('hit', i === active);
  });
}

/* ---------- voice picker ---------- */
export function buildVoices(el, voices, current, onPick) {
  el.innerHTML = '';
  voices.forEach(v => {
    const b = document.createElement('button');
    b.className = 'voice' + (v.id === current ? ' sel' : '');
    b.innerHTML = `<b>${v.name}</b><i>${v.hint}</i>`;
    b.addEventListener('click', () => onPick(v.id));
    el.appendChild(b);
  });
}

/* ---------- steps ---------- */
export function buildSteps(el, pattern, fx, onTap) {
  el.innerHTML = '';
  pattern.forEach((_, i) => {
    const b = document.createElement('button');
    b.className = 'step' + (i % 4 === 0 ? ' beat' : '');
    b.addEventListener('click', () => onTap(i));
    el.appendChild(b);
  });
  renderSteps(el, pattern, fx);
}

export function renderSteps(el, pattern, fx) {
  [...el.children].forEach((b, i) => {
    const st = pattern[i];
    if (!st || st.slice == null) {
      b.classList.add('empty');
      b.style.removeProperty('--c');
      b.innerHTML = '';
      return;
    }
    b.classList.remove('empty');
    b.style.setProperty('--c', COLORS[st.slice]);
    let tags = '';
    if (fx.rev && st.rev) tags += 'R';
    if (fx.pitch && st.pitch) tags += st.pitch > 0 ? '↑' : '↓';
    if (fx.stutter && st.stutter > 1) tags += '×' + st.stutter;
    b.innerHTML = `<b>${st.slice + 1}</b><i>${tags}</i>`;
  });
}

export function setPlayhead(el, prev, cur) {
  const kids = el.children;
  if (prev >= 0 && kids[prev]) kids[prev].classList.remove('play');
  if (cur >= 0 && kids[cur]) kids[cur].classList.add('play');
}

/* ---------- waveform ---------- */
let waveCache = null, waveKey = null;

function waveLayer(data, w, h, dpr) {
  const key = data.length + ':' + w + 'x' + h + ':' + dpr + ':' + data[Math.floor(data.length / 3)];
  if (waveCache && waveKey === key) return waveCache;
  const cv = document.createElement('canvas');
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = '#e9e6df';
  const n = data.length, mid = h / 2;
  for (let x = 0; x < w; x++) {
    const a = Math.floor(x / w * n), b = Math.max(a + 1, Math.floor((x + 1) / w * n));
    let mn = 1, mx = -1;
    for (let i = a; i < b && i < n; i++) { const v = data[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
    if (mn > mx) { mn = 0; mx = 0; }
    g.fillRect(x, mid - mx * mid * 0.9, 1, Math.max(1, (mx - mn) * mid * 0.9));
  }
  waveCache = cv; waveKey = key;
  return cv;
}

export function drawWave(cv, data, slices, active) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = '#141414';
  g.fillRect(0, 0, w, h);
  g.font = '10px ui-monospace, Menlo, monospace';

  if (!data || !data.length) {
    g.fillStyle = '#777';
    g.textAlign = 'center';
    g.fillText('NO PHRASE YET', w / 2, h / 2 + 4);
    return;
  }

  const n = data.length;
  slices.forEach((s, i) => {
    const x0 = s.start / n * w, x1 = s.end / n * w;
    g.globalAlpha = i === active ? 0.6 : 0.2;
    g.fillStyle = COLORS[i];
    g.fillRect(x0, 0, x1 - x0, h);
  });
  g.globalAlpha = 1;
  g.drawImage(waveLayer(data, w, h, dpr), 0, 0, w, h);
  g.textAlign = 'left';
  slices.forEach((s, i) => {
    const x0 = s.start / n * w;
    g.fillStyle = COLORS[i];
    g.fillRect(x0, 0, 1.5, h);
    g.fillText(String(i + 1), x0 + 3, 11);
  });
}
