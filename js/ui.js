// ui.js — draws the waveform, step lane and pads. Each chop keeps one colour everywhere.

// Dark-HUD palette: all teal/cyan, just shifted in hue and brightness so chops stay tell-apart-able.
export const COLORS = [
  '#6fe3d8', '#4fc3e0', '#a6f7ec', '#3fa89f', '#7fd4f0', '#57dbb4', '#c4fbf4', '#46a9bd',
  '#8ae9c9', '#3a929c', '#62c6dd', '#9ce6d2', '#4cbfa6', '#78dcf2', '#3f9f8a', '#b7efe6',
];

// read theme colours from the stylesheet so the canvas matches the CSS
function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/* ---------- pads ---------- */
export function buildPads(el, n, onTap) {
  el.innerHTML = '';
  for (let i = 0; i < 16; i++) {
    const b = document.createElement('button');
    b.className = 'pad';
    if (i < n) {
      b.style.setProperty('--c', COLORS[i]);
      b.append(String(i + 1).padStart(2, '0') + ']');
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
  g.fillStyle = cssVar('--ink', '#6fe3d8');
  g.shadowColor = g.fillStyle; g.shadowBlur = 3;
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
  g.fillStyle = cssVar('--panel', '#0c1d20');
  g.fillRect(0, 0, w, h);
  // faint grid, like the scope in the corner of the reference
  g.strokeStyle = cssVar('--line', '#1f4a4c');
  g.globalAlpha = 0.5; g.lineWidth = 1;
  g.beginPath();
  for (let x = 0.5; x < w; x += 24) { g.moveTo(x, 0); g.lineTo(x, h); }
  for (let y = 0.5; y < h; y += 16) { g.moveTo(0, y); g.lineTo(w, y); }
  g.stroke();
  g.globalAlpha = 1;
  g.beginPath(); g.moveTo(0, h / 2 + 0.5); g.lineTo(w, h / 2 + 0.5); g.stroke();
  g.font = '10px "Share Tech Mono", ui-monospace, Menlo, monospace';

  if (!data || !data.length) {
    g.fillStyle = cssVar('--dim', '#3b7f7c');
    g.textAlign = 'center';
    g.fillText('NO PHRASE YET', w / 2, h / 2 + 4);
    return;
  }

  const n = data.length;
  slices.forEach((s, i) => {
    const x0 = s.start / n * w, x1 = s.end / n * w;
    g.globalAlpha = i === active ? 0.35 : 0.07;
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
    g.fillText(String(i + 1).padStart(2, '0'), x0 + 3, 11);
  });
}
