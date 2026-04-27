import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { Chart, registerables } from "chart.js";
Chart.register(...registerables);

// ── Config ────────────────────────────────────────────────────
const API = "/api";

// ── Poster cache ──────────────────────────────────────────────
const PC = {};
function pkey(t, y) { return `${t}||${y}`; }

// ── Fetch helpers ─────────────────────────────────────────────
async function apiFetch(path, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(`${API}${path}`, { ...opts, signal: ctrl.signal });
    clearTimeout(timer);
    if (!r.ok) { const b = await r.text().catch(() => ""); throw new Error(`${r.status}: ${b.slice(0, 120)}`); }
    return r.json();
  } catch (e) { clearTimeout(timer); throw e; }
}

// ── Local explanation generator ────────────────────────────────
function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function titleOf(id, m) { return m?.[String(id)]?.title || null; }
function genreOf(id, m) { return m?.[String(id)]?.genres?.[0] || null; }
function yearOf(id, m) { return m?.[String(id)]?.year || null; }
function fmtFilm(id, m) { const t = titleOf(id, m), y = yearOf(id, m); if (!t) return null; return y ? `${t} (${y})` : t; }

function generateLocalExplanation({ picked, recommendations, movies, gates, historyInfluence, shapNorm }) {
  const influence = (historyInfluence || []).slice(0, 12);
  const classified = influence.map(d => {
    const attn = d.attention ?? 0, shap = shapNorm?.[d.position] ?? null;
    const attnHigh = attn >= 0.1, shapHigh = shap !== null ? shap >= 0.1 : null;
    let type;
    if (shapHigh === null) type = attnHigh ? "confirmed" : "irrelevant";
    else if (attnHigh && shapHigh) type = "confirmed";
    else if (attnHigh && !shapHigh) type = "misleading";
    else if (!attnHigh && shapHigh) type = "hidden";
    else type = "irrelevant";
    return { ...d, type };
  });
  const confirmed = classified.filter(d => d.type === "confirmed");
  const hidden = classified.filter(d => d.type === "hidden");
  const topDriver = confirmed[0] || influence[0];
  const topDriver2 = confirmed[1] || influence[1];
  const watchedGenres = picked.map(p => genreOf(p.idx, movies)).filter(Boolean);
  const genreFreq = {};
  watchedGenres.forEach(g => { genreFreq[g] = (genreFreq[g] || 0) + 1; });
  const topGenres = Object.entries(genreFreq).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([g]) => g);
  const topRecs = recommendations.slice(0, 3).map(r => ({ id: r.item_id, title: titleOf(r.item_id, movies), genre: genreOf(r.item_id, movies), label: fmtFilm(r.item_id, movies) })).filter(r => r.title);
  const { gcn = 0, memory = 0, seq = 0 } = gates || {};
  const dominantSignal = gcn >= memory && gcn >= seq ? "collaborative" : memory >= seq ? "memory" : "sequential";
  const sentences = [];
  if (topGenres.length >= 2) sentences.push(pickRandom([`Your watch history shows a clear pull toward ${topGenres[0]} and ${topGenres[1]} films.`, `There's a strong pattern running through what you've been watching — a real affinity for ${topGenres[0]} with threads of ${topGenres[1]}.`, `Looking at your history, ${topGenres[0]} is the throughline, with a secondary lean toward ${topGenres[1]}.`]));
  else if (topGenres.length === 1) sentences.push(`Your viewing history is anchored in ${topGenres[0]} — that preference shaped everything here.`);
  else sentences.push(`Your varied taste across genres gave the model a rich picture to work from.`);
  if (topDriver) {
    const dTitle = fmtFilm(topDriver.item_id, movies);
    const attnPct = Math.round((topDriver.attention ?? 0) * 100);
    const shapConfirmed = shapNorm && (shapNorm[topDriver.position] ?? 0) >= 0.1;
    const signal = shapConfirmed ? ` (SHAP-confirmed, attention ${attnPct}%)` : ` (attention weight ${attnPct}%)`;
    if (dTitle && topDriver2) { const d2Title = fmtFilm(topDriver2.item_id, movies); sentences.push(pickRandom([`The model leaned most heavily on ${dTitle}${signal} and ${d2Title || "another recent watch"} when building these picks.`, `Of everything you've watched, ${dTitle} and ${d2Title || "one other film"} carried the most weight${signal}.`, `${dTitle} had the strongest pull on your recommendations${signal}, closely followed by ${d2Title || "your second most influential film"}.`])); }
    else if (dTitle) sentences.push(pickRandom([`${dTitle} was the single strongest influence on these picks${signal}.`, `The model's clearest signal came from ${dTitle}${signal}.`]));
  }
  if (hidden.length > 0) { const h = hidden[0]; const hTitle = fmtFilm(h.item_id, movies); if (hTitle) sentences.push(pickRandom([`Interestingly, ${hTitle} barely registered in the attention weights but had outsized impact on the actual scores — a subtle thread the model picked up that isn't obvious on the surface.`, `One surprise: ${hTitle} had low attention weight but a high SHAP score, meaning it quietly shaped these recommendations more than it appeared to.`])); }
  if (topRecs.length >= 2) { const r1 = topRecs[0], r2 = topRecs[1]; const r1InGenre = r1.genre && topGenres.includes(r1.genre); if (r1InGenre) sentences.push(pickRandom([`${r1.title} lands at the top because it fits squarely in the ${r1.genre} space you gravitate toward, while ${r2.title} broadens things slightly${r2.genre ? ` with its ${r2.genre} sensibility` : ""}.`, `${r1.title} is the closest match to your core taste${r1.genre ? ` — solidly ${r1.genre}` : ""} — and ${r2.title} is the model's best stretch recommendation.`])); else if (r1.title && r2.title) sentences.push(`${r1.title} and ${r2.title} rank highest — they share the strongest overlap with what you've enjoyed.`); }
  else if (topRecs.length === 1) sentences.push(`${topRecs[0].title} is the top pick — the closest match to your taste profile.`);
  const gateTemplates = { collaborative: [`These picks were primarily driven by collaborative signals — viewers with a similar taste profile to yours watched and loved these.`, `The graph network found other users who share your viewing patterns, and these are what they watched next.`], memory: [`Your long-term preference patterns — not just recent watches — were the strongest predictor here.`, `The model's long-term memory component dominated, meaning these picks reflect your enduring taste rather than just recent activity.`], sequential: [`Your most recent viewing momentum drove the bulk of these picks — the model noticed where your taste has been heading lately.`, `Sequential behaviour was the dominant signal: the order and recency of your recent watches shaped these more than your broader history.`] };
  sentences.push(pickRandom(gateTemplates[dominantSignal]));
  return sentences.join(" ");
}

// ── Genre colours ─────────────────────────────────────────────
const GENRE_COLORS = {
  Action: "#e05252", Adventure: "#e07d52", Animation: "#e0b452",
  Comedy: "#b8e052", Drama: "#527be0", Horror: "#9052e0",
  Romance: "#e052b8", "Sci-Fi": "#52d4e0", Thriller: "#52e09c",
  Documentary: "#52a8e0", Crime: "#c052e0", Fantasy: "#e0d452",
};
const gcolor = genres => GENRE_COLORS[genres?.[0]] || "#888";

// ── CSS ───────────────────────────────────────────────────────
const GLOBAL_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;0,900;1,400&family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@300;400&display=swap');

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --bg:       #0a0a0f;
  --surface:  #111118;
  --card:     #16161f;
  --card2:    #1c1c27;
  --border:   #ffffff0f;
  --border2:  #ffffff1a;
  --border3:  #ffffff28;
  --text:     #f0f0f5;
  --muted:    #6b6b80;
  --muted2:   #9494aa;
  --accent:   #c9a84c;
  --accent2:  #e8c97a;
  --accent3:  #f5dfa0;
  --green:    #4caf82;
  --red:      #e05252;
  --blue:     #5b8dee;
  --purple:   #9b72ef;
  --serif:    'Playfair Display', Georgia, serif;
  --sans:     'DM Sans', sans-serif;
  --mono:     'DM Mono', monospace;
  --radius:   14px;
  --radius-sm: 8px;
  --radius-lg: 20px;
}

body {
  background: var(--bg);
  color: var(--text);
  font-family: var(--sans);
  min-height: 100vh;
  overflow-x: hidden;
  -webkit-font-smoothing: antialiased;
}

::-webkit-scrollbar { width: 4px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: #ffffff15; border-radius: 2px; }

@keyframes fadeUp {
  from { opacity: 0; transform: translateY(24px); }
  to   { opacity: 1; transform: translateY(0); }
}
@keyframes fadeIn {
  from { opacity: 0; } to { opacity: 1; }
}
@keyframes shimmer {
  0%   { background-position: -800px 0; }
  100% { background-position:  800px 0; }
}
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
@keyframes slideIn {
  from { opacity: 0; transform: translateX(-12px); }
  to   { opacity: 1; transform: translateX(0); }
}
@keyframes glow {
  0%,100% { box-shadow: 0 0 20px var(--accent)22; }
  50%     { box-shadow: 0 0 40px var(--accent)44; }
}
@keyframes float {
  0%,100% { transform: translateY(0px); }
  50%     { transform: translateY(-6px); }
}

.fade-up  { animation: fadeUp .55s cubic-bezier(.2,.8,.4,1) both; }
.fade-in  { animation: fadeIn .4s ease both; }
.slide-in { animation: slideIn .4s cubic-bezier(.2,.8,.4,1) both; }

/* ── Cards ── */
.pcard {
  position: relative; border-radius: var(--radius); overflow: hidden;
  background: var(--card); cursor: pointer;
  transition: transform .25s cubic-bezier(.2,.8,.4,1), box-shadow .25s;
  border: 1px solid var(--border);
  will-change: transform;
}
.pcard:hover {
  transform: translateY(-6px) scale(1.02);
  box-shadow: 0 24px 48px #00000077, 0 0 0 1px var(--border2);
}
.pcard.selected { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent)55; }
.pcard.hit      { border-color: var(--green);  box-shadow: 0 0 0 2px var(--green)55; }

.pcard-img { width: 100%; aspect-ratio: 2/3; object-fit: cover; display: block; transition: transform .3s; }
.pcard:hover .pcard-img { transform: scale(1.04); }

.pcard-fallback {
  width: 100%; aspect-ratio: 2/3;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  font-family: var(--serif); font-size: 2rem; font-weight: 900; letter-spacing: -.04em;
}
.pcard-info {
  padding: 12px 10px 14px;
  background: linear-gradient(to top, #000000ee 0%, #00000066 60%, transparent 100%);
  position: absolute; bottom: 0; left: 0; right: 0;
}
.pcard-title {
  font-family: var(--sans); font-size: 12px; font-weight: 500;
  color: #fff; line-height: 1.3;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.pcard-year  { font-size: 10px; color: #ffffff70; margin-top: 3px; font-family: var(--mono); }
.pcard-genre { font-size: 9px; margin-top: 3px; font-family: var(--mono); }

.rank-badge {
  position: absolute; top: 8px; left: 8px;
  background: #000000bb; backdrop-filter: blur(6px);
  border-radius: 6px; padding: 3px 8px;
  font-family: var(--mono); font-size: 11px; font-weight: 400; color: var(--accent);
  border: 1px solid var(--accent)33;
}
.hit-badge {
  position: absolute; top: 8px; right: 8px;
  background: var(--green)dd; border-radius: 6px; padding: 3px 8px;
  font-size: 10px; font-weight: 600; color: #fff; letter-spacing: .02em;
}
.remove-btn {
  position: absolute; top: 7px; right: 7px; z-index: 10;
  width: 24px; height: 24px; border-radius: 50%;
  background: #000000cc; backdrop-filter: blur(4px);
  border: 1px solid #ffffff22; cursor: pointer;
  color: #fff; font-size: 15px; display: flex; align-items: center; justify-content: center;
  transition: all .15s; opacity: 0;
}
.pcard:hover .remove-btn { opacity: 1; }
.remove-btn:hover { background: var(--red)cc; border-color: var(--red)55; transform: scale(1.1); }

/* ── Search ── */
.search-wrap { position: relative; }
.search-input {
  width: 100%; background: var(--surface); border: 1px solid var(--border2);
  color: var(--text); border-radius: var(--radius); padding: 14px 20px 14px 48px;
  font-family: var(--sans); font-size: 15px; outline: none;
  transition: border-color .2s, box-shadow .2s, background .2s;
}
.search-input:focus {
  border-color: var(--accent)66;
  box-shadow: 0 0 0 4px var(--accent)12;
  background: var(--card);
}
.search-input::placeholder { color: var(--muted); }
.search-icon {
  position: absolute; left: 16px; top: 50%; transform: translateY(-50%);
  color: var(--muted); font-size: 18px; pointer-events: none; z-index: 1;
}

.dropdown {
  background: var(--card2); border: 1px solid var(--border2);
  border-radius: var(--radius-lg); max-height: 440px; overflow-y: auto;
  box-shadow: 0 32px 80px #000000aa;
  animation: fadeUp .18s ease;
}
.dd-item {
  display: flex; align-items: center; gap: 14px;
  padding: 10px 16px; cursor: pointer; border-bottom: 1px solid var(--border);
  transition: background .1s;
}
.dd-item:last-child { border-bottom: none; }
.dd-item:hover { background: var(--surface); }
.dd-item:first-child { border-radius: var(--radius-lg) var(--radius-lg) 0 0; }
.dd-item:last-child { border-radius: 0 0 var(--radius-lg) var(--radius-lg); }
.dd-thumb { width: 38px; height: 57px; border-radius: 6px; overflow: hidden; flex-shrink: 0; }
.dd-title { font-size: 14px; font-weight: 500; color: var(--text); }
.dd-meta  { font-size: 12px; color: var(--muted); margin-top: 2px; font-family: var(--mono); }
.dd-genre-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 5px; vertical-align: middle; }

/* ── Buttons ── */
.btn {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 11px 24px; border-radius: var(--radius); border: none;
  font-family: var(--sans); font-size: 14px; font-weight: 500;
  cursor: pointer; transition: all .18s cubic-bezier(.2,.8,.4,1); white-space: nowrap;
  letter-spacing: .01em;
}
.btn-primary {
  background: linear-gradient(135deg, var(--accent) 0%, var(--accent2) 100%);
  color: #0a0a0f; font-weight: 600;
}
.btn-primary:hover:not(:disabled) {
  background: linear-gradient(135deg, var(--accent2) 0%, var(--accent3) 100%);
  transform: translateY(-2px);
  box-shadow: 0 12px 32px var(--accent)44;
}
.btn-ghost {
  background: transparent; color: var(--muted);
  border: 1px solid var(--border2);
}
.btn-ghost:hover:not(:disabled) { background: var(--surface); color: var(--text); border-color: var(--border3); }
.btn-sm { padding: 7px 14px; font-size: 12px; border-radius: var(--radius-sm); }
.btn:disabled { opacity: .35; cursor: not-allowed; transform: none !important; }
.btn:active:not(:disabled) { transform: translateY(0) scale(.98); }

/* ── Spinner ── */
.spinner {
  width: 16px; height: 16px;
  border: 2px solid var(--border2); border-top-color: var(--accent);
  border-radius: 50%; animation: spin .7s linear infinite;
}
.spinner-lg {
  width: 36px; height: 36px;
  border: 3px solid var(--border2); border-top-color: var(--accent);
  border-radius: 50%; animation: spin .9s linear infinite;
}

/* ── Labels ── */
.section-label {
  font-family: var(--mono); font-size: 11px; letter-spacing: .13em;
  text-transform: uppercase; color: var(--muted); margin-bottom: 16px;
  display: flex; align-items: center; gap: 8px;
}
.section-label::before {
  content: ''; display: inline-block; width: 16px; height: 1px;
  background: var(--accent); opacity: .6;
}

/* ── Grids ── */
.movie-grid    { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 12px; }
.movie-grid-lg { display: grid; grid-template-columns: repeat(auto-fill, minmax(145px, 1fr)); gap: 14px; }

/* ── Explanation ── */
.exp-card {
  background: linear-gradient(135deg, var(--card) 0%, var(--card2) 100%);
  border: 1px solid var(--border2);
  border-radius: var(--radius-lg); padding: 32px 36px;
  position: relative; overflow: hidden;
}
.exp-card::before {
  content: '"'; position: absolute; top: -20px; left: 24px;
  font-family: var(--serif); font-size: 160px; color: var(--accent);
  opacity: 0.06; line-height: 1; pointer-events: none;
}
.exp-card::after {
  content: ''; position: absolute; top: 0; right: 0; bottom: 0;
  width: 200px;
  background: radial-gradient(ellipse at right center, var(--accent)05, transparent);
  pointer-events: none;
}
.exp-paragraph {
  font-family: var(--serif); font-size: 18px; line-height: 1.9;
  color: var(--text); font-weight: 400; position: relative; z-index: 1;
}

/* ── Charts ── */
.chart-box {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 22px 22px 18px;
  transition: border-color .2s;
}
.chart-box:hover { border-color: var(--border2); }
.chart-title {
  font-family: var(--mono); font-size: 11px; text-transform: uppercase;
  letter-spacing: .12em; color: var(--muted); margin-bottom: 18px;
  display: flex; align-items: center; gap: 6px;
}
.chart-subtitle {
  font-family: var(--mono); font-size: 10px; color: var(--muted);
  margin-top: -12px; margin-bottom: 14px; opacity: .7;
}

/* ── Shimmer skeleton ── */
.shimmer {
  background: linear-gradient(90deg, var(--card) 25%, #ffffff07 50%, var(--card) 75%);
  background-size: 800px 100%; animation: shimmer 1.8s infinite;
  border-radius: var(--radius-sm);
}

/* ── Nav ── */
.nav {
  position: sticky; top: 0; z-index: 200;
  background: var(--bg)e8; backdrop-filter: blur(28px) saturate(1.5);
  border-bottom: 1px solid var(--border);
  padding: 0 48px; height: 62px;
  display: flex; align-items: center; gap: 32px;
}
.nav-logo {
  font-family: var(--serif); font-size: 21px; font-weight: 700;
  color: var(--accent); letter-spacing: -.02em; white-space: nowrap;
  display: flex; align-items: center; gap: 8px;
}
.nav-logo-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--accent); animation: pulse 2s infinite;
}
.nav-pill {
  background: var(--surface); border: 1px solid var(--border2);
  border-radius: 20px; padding: 5px 14px;
  font-family: var(--mono); font-size: 11px; color: var(--muted2);
  display: flex; align-items: center; gap: 6px;
}
.nav-status { display: flex; align-items: center; gap: 8px; margin-left: auto; }
.status-dot { width: 7px; height: 7px; border-radius: 50%; }

/* ── Gate bars ── */
.gate-row { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.gate-label { font-family: var(--mono); font-size: 12px; color: var(--muted); width: 64px; flex-shrink: 0; }
.gate-bar-wrap {
  flex: 1; height: 10px; background: var(--bg); border-radius: 5px; overflow: hidden;
  position: relative;
}
.gate-bar { height: 100%; border-radius: 5px; transition: width 1s cubic-bezier(.2,.8,.4,1); }
.gate-pct { font-family: var(--mono); font-size: 12px; width: 38px; text-align: right; flex-shrink: 0; }

/* ── Stat cards ── */
.stat-card {
  background: var(--card); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 20px 22px;
  display: flex; flex-direction: column; gap: 4px;
  transition: border-color .2s, transform .2s;
}
.stat-card:hover { border-color: var(--border2); transform: translateY(-2px); }
.stat-value { font-family: var(--serif); font-size: 2rem; font-weight: 700; color: var(--text); line-height: 1; }
.stat-label { font-family: var(--mono); font-size: 11px; color: var(--muted); letter-spacing: .06em; text-transform: uppercase; margin-top: 4px; }
.stat-sub   { font-family: var(--mono); font-size: 11px; color: var(--muted); margin-top: 2px; }

/* ── Genre tags ── */
.genre-tag {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 3px 9px; border-radius: 20px;
  font-family: var(--mono); font-size: 10px; font-weight: 400;
  border: 1px solid; letter-spacing: .03em;
}

/* ── Influence chip ── */
.inf-chip {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 8px; padding: 6px 12px;
  display: inline-flex; align-items: center; gap: 6px;
  font-family: var(--mono); font-size: 11px; color: var(--muted);
  transition: border-color .15s;
}
.inf-chip.confirmed { border-color: var(--accent)44; color: var(--accent); }
.inf-chip.hidden    { border-color: var(--purple)44; color: var(--purple); }

/* ── Notice ── */
.notice-card {
  background: #c9a84c0d; border: 1px solid #c9a84c2a;
  border-radius: var(--radius); padding: 16px 20px; margin-bottom: 24px;
  font-size: 13px; line-height: 1.6; color: var(--accent2);
}
.notice-card code {
  font-family: var(--mono); font-size: 12px;
  background: #ffffff0a; padding: 2px 6px; border-radius: 4px; color: var(--text);
}

/* ── Timeline track ── */
.timeline-track {
  display: flex; align-items: center; gap: 0;
  overflow-x: auto; padding: 12px 0;
  scrollbar-width: none;
}
.timeline-track::-webkit-scrollbar { display: none; }
.tl-node {
  display: flex; flex-direction: column; align-items: center; gap: 6px;
  flex-shrink: 0; width: 80px; position: relative;
}
.tl-node::after {
  content: ''; position: absolute; left: 50%; top: 28px;
  width: 100%; height: 1px; background: var(--border2);
  z-index: 0;
}
.tl-node:last-child::after { display: none; }
.tl-circle {
  width: 52px; height: 52px; border-radius: 50%; overflow: hidden;
  border: 2px solid var(--border2); position: relative; z-index: 1;
  background: var(--card); flex-shrink: 0;
  transition: border-color .2s;
}
.tl-circle.active { border-color: var(--accent); }
.tl-idx {
  font-family: var(--mono); font-size: 9px; color: var(--muted);
  text-align: center; white-space: nowrap;
}
.tl-label {
  font-size: 10px; font-weight: 500; color: var(--text);
  text-align: center; max-width: 74px; line-height: 1.2;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}

/* ── Divider ── */
.divider {
  border: none; border-top: 1px solid var(--border);
  margin: 4px 0;
}

/* ── Score pill ── */
.score-pill {
  display: inline-flex; align-items: center; gap: 4px;
  background: var(--accent)12; border: 1px solid var(--accent)2a;
  border-radius: 20px; padding: 2px 9px;
  font-family: var(--mono); font-size: 11px; color: var(--accent);
}

@media (max-width: 700px) {
  .nav { padding: 0 18px; }
  main { padding: 24px 16px !important; }
  .exp-card { padding: 20px 18px; }
  .exp-paragraph { font-size: 15px; }
  .movie-grid    { grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); }
  .movie-grid-lg { grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); }
}
`;

// ── Poster component ──────────────────────────────────────────
function Poster({ title, year, genres, cache, onNeeded, style, small }) {
  const ref = useRef(null);
  const url = cache?.[pkey(title, year)];
  const color = gcolor(genres);

  useEffect(() => {
    if (!title) return;
    const k = pkey(title, year);
    if (PC[k] !== undefined) return;
    const obs = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) { onNeeded?.(title, year); obs.disconnect(); }
    }, { rootMargin: "500px" });
    if (ref.current) obs.observe(ref.current);
    return () => obs.disconnect();
  }, [title, year, onNeeded]);

  const words = (title || "").replace(/[^a-zA-Z ]/g, "").split(" ").filter(w => w.length > 2);
  const abbr = words.length >= 2 ? words.slice(0, 2).map(w => w[0]).join("").toUpperCase() : (title || "??").slice(0, 2).toUpperCase();

  return (
    <div ref={ref} style={style}>
      {url === "loading" && <div className="shimmer pcard-img" style={{ aspectRatio: "2/3" }} />}
      {url && url !== "loading" && (
        <img src={url} alt={title} className="pcard-img"
          onError={e => { e.target.style.display = "none"; }} />
      )}
      {(!url || url === null) && url !== "loading" && (
        <div className="pcard-fallback"
          style={{ background: `linear-gradient(145deg, ${color}28, ${color}08)`, color }}>
          {small ? null : abbr}
          <div style={{ fontSize: small ? "9px" : "10px", fontFamily: "var(--mono)", color: "var(--muted)", marginTop: small ? 0 : 6, textAlign: "center", padding: "0 8px", lineHeight: 1.3 }}>
            {genres?.[0] || ""}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Movie Card ─────────────────────────────────────────────────
function MovieCard({ idx, movies, cache, onNeeded, rank, isHit, isSelected, onRemove, onClick, delay = 0, showGenre }) {
  const m = movies?.[String(idx)];
  const title = m?.title || `#${idx}`;
  const year = m?.year;
  const genres = m?.genres || [];
  const color = gcolor(genres);

  return (
    <div
      className={`pcard${isSelected ? " selected" : ""}${isHit ? " hit" : ""}`}
      onClick={() => onClick?.(idx)}
      style={{ animationDelay: `${delay}s`, animation: "fadeUp .45s ease both" }}
    >
      <Poster title={title} year={year} genres={genres} cache={cache} onNeeded={onNeeded} />
      <div className="pcard-info">
        <div className="pcard-title">{title}</div>
        <div className="pcard-year">{year || ""}</div>
        {showGenre && genres[0] && (
          <div className="pcard-genre" style={{ color }}>{genres[0]}</div>
        )}
      </div>
      {rank != null && <div className="rank-badge">#{rank}</div>}
      {isHit && <div className="hit-badge">✓ Match</div>}
      {onRemove && (
        <button className="remove-btn" onClick={e => { e.stopPropagation(); onRemove(idx); }}>×</button>
      )}
    </div>
  );
}

// ── Search ────────────────────────────────────────────────────
function MovieSearch({ movies, cache, onNeeded, onSelect }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [dropRect, setDropRect] = useState(null);
  const wrapRef = useRef(null);
  const inputRef = useRef(null);

  const hits = useMemo(() => {
    if (q.length < 2) return [];
    const ql = q.toLowerCase();
    return Object.entries(movies)
      .filter(([, m]) => m.title?.toLowerCase().includes(ql))
      .sort(([, a], [, b]) => {
        const as = a.title?.toLowerCase().startsWith(ql);
        const bs = b.title?.toLowerCase().startsWith(ql);
        return as === bs ? (a.title || "").localeCompare(b.title || "") : as ? -1 : 1;
      })
      .slice(0, 10);
  }, [q, movies]);

  const updateRect = useCallback(() => {
    if (!inputRef.current) return;
    const r = inputRef.current.getBoundingClientRect();
    setDropRect({ top: r.bottom + window.scrollY + 8, left: r.left + window.scrollX, width: r.width });
  }, []);

  useEffect(() => { if (open) updateRect(); }, [open, updateRect]);

  useEffect(() => {
    const onAny = () => { if (open) updateRect(); };
    window.addEventListener("scroll", onAny, true);
    window.addEventListener("resize", onAny);
    return () => { window.removeEventListener("scroll", onAny, true); window.removeEventListener("resize", onAny); };
  }, [open, updateRect]);

  useEffect(() => {
    const h = e => { if (!wrapRef.current?.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  const dropdown = open && hits.length > 0 && dropRect && createPortal(
    <div className="dropdown" style={{ position: "absolute", top: dropRect.top, left: dropRect.left, width: dropRect.width, zIndex: 9999 }}>
      {hits.map(([idx, m]) => (
        <div key={idx} className="dd-item"
          onMouseDown={() => { onSelect(Number(idx), m); setQ(""); setOpen(false); }}>
          <div className="dd-thumb">
            <Poster title={m.title} year={m.year} genres={m.genres} cache={cache} onNeeded={onNeeded} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="dd-title">{m.title}</div>
            <div className="dd-meta">
              {m.genres?.[0] && <span className="dd-genre-dot" style={{ background: gcolor(m.genres) }} />}
              {m.year}{m.genres?.[0] ? ` · ${m.genres[0]}` : ""}
            </div>
          </div>
          <div style={{ fontSize: 12, color: "var(--muted)", fontFamily: "var(--mono)" }}>+ Add</div>
        </div>
      ))}
    </div>,
    document.body
  );

  return (
    <div className="search-wrap" ref={wrapRef}>
      <span className="search-icon">🔍</span>
      <input ref={inputRef} className="search-input" value={q}
        onChange={e => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        placeholder="Search for a movie — Inception, Parasite, Toy Story…"
      />
      {dropdown}
    </div>
  );
}

// ── Genre Distribution Radar ──────────────────────────────────
function GenreRadar({ picked, movies }) {
  const ref = useRef(null);
  const chartRef = useRef(null);

  const data = useMemo(() => {
    const freq = {};
    picked.forEach(p => {
      const genres = movies?.[String(p.idx)]?.genres || [];
      genres.forEach(g => { freq[g] = (freq[g] || 0) + 1; });
    });
    return Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 8);
  }, [picked, movies]);

  useEffect(() => {
    if (!ref.current || data.length < 3) return;
    if (chartRef.current) chartRef.current.destroy();
    chartRef.current = new Chart(ref.current, {
      type: "radar",
      data: {
        labels: data.map(([g]) => g),
        datasets: [{
          data: data.map(([, v]) => v),
          backgroundColor: "rgba(201,168,76,0.12)",
          borderColor: "rgba(201,168,76,0.8)",
          borderWidth: 2,
          pointBackgroundColor: "rgba(201,168,76,1)",
          pointBorderColor: "transparent",
          pointRadius: 4,
          pointHoverRadius: 6,
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { backgroundColor: "#16161f", borderColor: "#ffffff1a", borderWidth: 1, titleColor: "#f0f0f5", bodyColor: "#c9a84c", padding: 10 } },
        scales: {
          r: {
            backgroundColor: "transparent",
            grid: { color: "#ffffff0c" },
            angleLines: { color: "#ffffff0c" },
            ticks: { display: false, stepSize: 1 },
            pointLabels: { color: "#9494aa", font: { family: "DM Mono", size: 11 } },
          }
        }
      }
    });
    return () => chartRef.current?.destroy();
  }, [data]);

  if (data.length < 3) return null;

  return (
    <div className="chart-box">
      <div className="chart-title">Genre profile — your taste map</div>
      <div style={{ height: 220 }}><canvas ref={ref} /></div>
    </div>
  );
}

// ── Attention bar chart ───────────────────────────────────────
function AttentionChart({ influence, movies }) {
  const ref = useRef(null);
  const chartRef = useRef(null);

  useEffect(() => {
    if (!ref.current || !influence?.length) return;
    if (chartRef.current) chartRef.current.destroy();
    const top = [...influence].sort((a, b) => b.attention - a.attention).slice(0, 8);
    const labels = top.map(d => { const m = movies?.[String(d.item_id)]; const t = m?.title || `#${d.item_id}`; return t.length > 20 ? t.slice(0, 18) + "…" : t; });
    const values = top.map(d => Math.round(d.attention * 100));
    const colors = top.map(d => gcolor(movies?.[String(d.item_id)]?.genres));
    chartRef.current = new Chart(ref.current, {
      type: "bar",
      data: { labels, datasets: [{ data: values, backgroundColor: colors.map(c => c + "77"), borderColor: colors, borderWidth: 1.5, borderRadius: 8 }] },
      options: {
        indexAxis: "y", responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ` ${ctx.parsed.x}% attention weight` }, backgroundColor: "#16161f", borderColor: "#ffffff1a", borderWidth: 1, titleColor: "#f0f0f5", bodyColor: "#c9a84c", padding: 10 } },
        scales: {
          x: { grid: { color: "#ffffff06" }, ticks: { color: "#6b6b80", font: { family: "DM Mono", size: 11 }, callback: v => `${v}%` }, border: { display: false } },
          y: { grid: { display: false }, ticks: { color: "#f0f0f5", font: { family: "DM Sans", size: 12 } }, border: { display: false } }
        }
      }
    });
    return () => chartRef.current?.destroy();
  }, [influence, movies]);

  return (
    <div className="chart-box">
      <div className="chart-title">Transformer attention weights</div>
      <div style={{ height: Math.min(influence?.length || 6, 8) * 44 + 20 }}><canvas ref={ref} /></div>
    </div>
  );
}

// ── Gate donut chart ──────────────────────────────────────────
function GateChart({ gates }) {
  const ref = useRef(null);
  const chartRef = useRef(null);
  useEffect(() => {
    if (!ref.current || !gates) return;
    if (chartRef.current) chartRef.current.destroy();
    chartRef.current = new Chart(ref.current, {
      type: "doughnut",
      data: {
        labels: ["Collaborative (GCN)", "Long-term Memory", "Sequential"],
        datasets: [{ data: [Math.round(gates.gcn * 100), Math.round(gates.memory * 100), Math.round(gates.seq * 100)], backgroundColor: ["#5b8dee1a", "#4caf821a", "#c9a84c1a"], borderColor: ["#5b8dee", "#4caf82", "#c9a84c"], borderWidth: 2, hoverBackgroundColor: ["#5b8dee33", "#4caf8233", "#c9a84c33"], hoverOffset: 8 }]
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: "72%",
        plugins: { legend: { position: "bottom", labels: { color: "#6b6b80", font: { family: "DM Mono", size: 11 }, padding: 16, boxWidth: 10, boxHeight: 10, borderRadius: 5 } }, tooltip: { callbacks: { label: ctx => ` ${ctx.parsed}% contribution` }, backgroundColor: "#16161f", borderColor: "#ffffff1a", borderWidth: 1, titleColor: "#f0f0f5", bodyColor: "#c9a84c", padding: 10 } }
      }
    });
    return () => chartRef.current?.destroy();
  }, [gates]);
  return (
    <div className="chart-box">
      <div className="chart-title">Model component blend</div>
      <div style={{ height: 240 }}><canvas ref={ref} /></div>
    </div>
  );
}

// ── Score chart ───────────────────────────────────────────────
function ScoreChart({ recommendations, movies }) {
  const ref = useRef(null);
  const chartRef = useRef(null);
  useEffect(() => {
    if (!ref.current || !recommendations?.length) return;
    if (chartRef.current) chartRef.current.destroy();
    const top10 = recommendations.slice(0, 10);
    const labels = top10.map(r => { const t = movies?.[String(r.item_id)]?.title || `#${r.item_id}`; return t.length > 16 ? t.slice(0, 14) + "…" : t; });
    const scores = top10.map(r => r.score?.toFixed ? parseFloat(r.score.toFixed(3)) : r.score);
    const colors = top10.map(r => gcolor(movies?.[String(r.item_id)]?.genres));
    chartRef.current = new Chart(ref.current, {
      type: "bar",
      data: { labels, datasets: [{ label: "Relevance score", data: scores, backgroundColor: colors.map(c => c + "55"), borderColor: colors, borderWidth: 1.5, borderRadius: 8, borderSkipped: false }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { backgroundColor: "#16161f", borderColor: "#ffffff1a", borderWidth: 1, titleColor: "#f0f0f5", bodyColor: "#c9a84c", padding: 10 } },
        scales: {
          x: { grid: { display: false }, ticks: { color: "#6b6b8088", font: { family: "DM Sans", size: 11 }, maxRotation: 40 }, border: { display: false } },
          y: { grid: { color: "#ffffff06" }, ticks: { color: "#6b6b80", font: { family: "DM Mono", size: 11 } }, border: { display: false } }
        }
      }
    });
    return () => chartRef.current?.destroy();
  }, [recommendations, movies]);
  return (
    <div className="chart-box">
      <div className="chart-title">Relevance scores — top 10</div>
      <div style={{ height: 210 }}><canvas ref={ref} /></div>
    </div>
  );
}

// ── NEW: Genre Distribution of Recommendations ────────────────
function RecGenreChart({ recommendations, movies }) {
  const ref = useRef(null);
  const chartRef = useRef(null);

  useEffect(() => {
    if (!ref.current || !recommendations?.length) return;
    if (chartRef.current) chartRef.current.destroy();
    const freq = {};
    recommendations.forEach(r => {
      const g = movies?.[String(r.item_id)]?.genres?.[0] || "Unknown";
      freq[g] = (freq[g] || 0) + 1;
    });
    const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]);
    const labels = sorted.map(([g]) => g);
    const values = sorted.map(([, v]) => v);
    const colors = sorted.map(([g]) => GENRE_COLORS[g] || "#888");

    chartRef.current = new Chart(ref.current, {
      type: "polarArea",
      data: {
        labels,
        datasets: [{
          data: values,
          backgroundColor: colors.map(c => c + "44"),
          borderColor: colors,
          borderWidth: 1.5,
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: "right", labels: { color: "#6b6b80", font: { family: "DM Mono", size: 11 }, padding: 12, boxWidth: 10, boxHeight: 10 } }, tooltip: { backgroundColor: "#16161f", borderColor: "#ffffff1a", borderWidth: 1, titleColor: "#f0f0f5", bodyColor: "#c9a84c", padding: 10 } },
        scales: { r: { grid: { color: "#ffffff08" }, ticks: { display: false }, } }
      }
    });
    return () => chartRef.current?.destroy();
  }, [recommendations, movies]);

  return (
    <div className="chart-box">
      <div className="chart-title">Recommendation genre spread</div>
      <div style={{ height: 220 }}><canvas ref={ref} /></div>
    </div>
  );
}

// ── NEW: Score vs Rank line ───────────────────────────────────
function ScoreCurveChart({ recommendations, movies }) {
  const ref = useRef(null);
  const chartRef = useRef(null);

  useEffect(() => {
    if (!ref.current || !recommendations?.length) return;
    if (chartRef.current) chartRef.current.destroy();
    const pts = recommendations.slice(0, 15);
    const labels = pts.map((_, i) => `#${i + 1}`);
    const scores = pts.map(r => r.score?.toFixed ? parseFloat(r.score.toFixed(4)) : r.score);

    chartRef.current = new Chart(ref.current, {
      type: "line",
      data: {
        labels,
        datasets: [{
          label: "Score",
          data: scores,
          fill: true,
          backgroundColor: "rgba(201,168,76,0.08)",
          borderColor: "rgba(201,168,76,0.9)",
          borderWidth: 2,
          pointBackgroundColor: "rgba(201,168,76,1)",
          pointRadius: 4,
          pointHoverRadius: 7,
          tension: 0.45,
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { title: ctx => { const r = recommendations[ctx[0].dataIndex]; return movies?.[String(r.item_id)]?.title || `#${r.item_id}`; }, label: ctx => ` Score: ${ctx.parsed.y}` }, backgroundColor: "#16161f", borderColor: "#ffffff1a", borderWidth: 1, titleColor: "#f0f0f5", bodyColor: "#c9a84c", padding: 10 } },
        scales: {
          x: { grid: { display: false }, ticks: { color: "#6b6b80", font: { family: "DM Mono", size: 11 } }, border: { display: false } },
          y: { grid: { color: "#ffffff06" }, ticks: { color: "#6b6b80", font: { family: "DM Mono", size: 11 } }, border: { display: false } }
        }
      }
    });
    return () => chartRef.current?.destroy();
  }, [recommendations, movies]);

  return (
    <div className="chart-box">
      <div className="chart-title">Score decay curve</div>
      <div style={{ height: 180 }}><canvas ref={ref} /></div>
    </div>
  );
}

// ── Gate bars ─────────────────────────────────────────────────
function GateBars({ gates }) {
  const items = [
    { label: "GCN", val: gates.gcn, color: "#5b8dee", desc: "Collaborative" },
    { label: "Memory", val: gates.memory, color: "#4caf82", desc: "Long-term" },
    { label: "Seq", val: gates.seq, color: "#c9a84c", desc: "Sequential" },
  ];
  return (
    <div>
      {items.map(({ label, val, color, desc }) => (
        <div key={label} className="gate-row">
          <div className="gate-label" style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            <span style={{ fontFamily: "var(--mono)", fontSize: 12, color }}>{label}</span>
            <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)", opacity: .7 }}>{desc}</span>
          </div>
          <div className="gate-bar-wrap">
            <div className="gate-bar" style={{ width: `${Math.round(val * 100)}%`, background: `linear-gradient(90deg, ${color}88, ${color})` }} />
          </div>
          <div className="gate-pct" style={{ color, fontFamily: "var(--mono)", fontSize: 12 }}>
            {Math.round(val * 100)}%
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Stats bar ─────────────────────────────────────────────────
function StatsRow({ picked, recommendations, movies, expData }) {
  const avgYear = useMemo(() => {
    const years = picked.map(p => movies?.[String(p.idx)]?.year).filter(Boolean);
    if (!years.length) return null;
    return Math.round(years.reduce((a, b) => a + b, 0) / years.length);
  }, [picked, movies]);

  const genres = useMemo(() => {
    const freq = {};
    picked.forEach(p => {
      (movies?.[String(p.idx)]?.genres || []).forEach(g => { freq[g] = (freq[g] || 0) + 1; });
    });
    return Object.entries(freq).sort((a, b) => b[1] - a[1]);
  }, [picked, movies]);

  const topGate = useMemo(() => {
    if (!expData?.component_weights) return null;
    const g = expData.component_weights;
    if (g.gcn >= g.memory && g.gcn >= g.seq) return { label: "Collaborative", color: "#5b8dee" };
    if (g.memory >= g.seq) return { label: "Memory-driven", color: "#4caf82" };
    return { label: "Sequential", color: "#c9a84c" };
  }, [expData]);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12, marginBottom: 36 }} className="fade-up">
      <div className="stat-card">
        <div className="stat-value">{recommendations?.length || 0}</div>
        <div className="stat-label">Picks generated</div>
      </div>
      <div className="stat-card">
        <div className="stat-value">{picked.length}</div>
        <div className="stat-label">History films</div>
      </div>
      {avgYear && (
        <div className="stat-card">
          <div className="stat-value">{avgYear}</div>
          <div className="stat-label">Avg watch year</div>
        </div>
      )}
      {genres[0] && (
        <div className="stat-card">
          <div className="stat-value" style={{ fontSize: "1.3rem", color: gcolor([genres[0][0]]) }}>
            {genres[0][0]}
          </div>
          <div className="stat-label">Top genre</div>
          <div className="stat-sub">{genres.length} genres total</div>
        </div>
      )}
      {topGate && (
        <div className="stat-card">
          <div className="stat-value" style={{ fontSize: "1rem", color: topGate.color, marginTop: 4 }}>
            {topGate.label}
          </div>
          <div className="stat-label">Dominant signal</div>
        </div>
      )}
    </div>
  );
}

// ── Watch History Timeline ─────────────────────────────────────
function HistoryTimeline({ picked, movies, cache, onNeeded, influence }) {
  const attnMap = useMemo(() => {
    const m = {};
    (influence || []).forEach(d => { m[d.item_id] = d.attention; });
    return m;
  }, [influence]);

  return (
    <div style={{ marginBottom: 28 }}>
      <div className="section-label">Viewing history sequence</div>
      <div className="timeline-track">
        {picked.map((p, i) => {
          const m = movies?.[String(p.idx)];
          const attn = attnMap[p.idx];
          const isActive = attn !== undefined && attn >= 0.1;
          return (
            <div key={p.idx} className="tl-node">
              <div className="tl-circle" style={{ borderColor: isActive ? gcolor(m?.genres) : undefined }}>
                <Poster title={m?.title} year={m?.year} genres={m?.genres} cache={cache} onNeeded={onNeeded} small />
              </div>
              <div className="tl-label" style={{ color: isActive ? "var(--text)" : "var(--muted)" }}>
                {m?.title ? (m.title.length > 10 ? m.title.slice(0, 9) + "…" : m.title) : `#${p.idx}`}
              </div>
              {attn !== undefined && (
                <div className="tl-idx" style={{ color: isActive ? "var(--accent)" : "var(--muted)" }}>
                  {Math.round(attn * 100)}%
                </div>
              )}
              {!attn && (
                <div className="tl-idx">#{i + 1}</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Loader / Error ────────────────────────────────────────────
function Loader({ text = "Loading…" }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16, padding: "56px 0" }}>
      <div className="spinner-lg" />
      <div style={{ color: "var(--muted)", fontSize: 14, fontFamily: "var(--mono)", letterSpacing: ".06em" }}>{text}</div>
    </div>
  );
}

function ErrBox({ msg }) {
  return (
    <div style={{ background: "var(--red)0d", border: "1px solid var(--red)33", borderRadius: "var(--radius)", padding: "14px 18px", color: "var(--red)", fontSize: 13, marginBottom: 20, display: "flex", gap: 10, alignItems: "flex-start" }}>
      <span style={{ flex: "none", fontSize: 16 }}>⚠</span>
      <span>{msg}</span>
    </div>
  );
}

// ── TMDB poster loader ────────────────────────────────────────
function usePosterLoader(tmdbKey) {
  const [cache, setCache] = useState({});
  const loadPoster = useCallback((title, year) => {
    if (!tmdbKey || !title) return;
    const k = pkey(title, year);
    if (PC[k] !== undefined) return;
    PC[k] = "loading";
    setCache(p => ({ ...p, [k]: "loading" }));
    const q = encodeURIComponent(title.replace(/[,.:!]/g, ""));
    fetch(`https://api.themoviedb.org/3/search/movie?api_key=${tmdbKey}&query=${q}${year ? `&year=${year}` : ""}`)
      .then(r => r.json())
      .then(d => { const path = d.results?.[0]?.poster_path; const url = path ? `https://image.tmdb.org/t/p/w300${path}` : null; PC[k] = url; setCache(p => ({ ...p, [k]: url })); })
      .catch(() => { PC[k] = null; setCache(p => ({ ...p, [k]: null })); });
  }, [tmdbKey]);
  return [cache, loadPoster];
}

// ── Explanation Panel ─────────────────────────────────────────
function ExplanationPanel({ picked, recData, expData, movies, requestKey }) {
  const [text, setText] = useState(null);

  useEffect(() => {
    if (!recData?.recommendations?.length || !picked?.length) return;
    setText(null);
    const paragraph = generateLocalExplanation({
      picked, recommendations: recData.recommendations, movies,
      gates: expData?.component_weights ?? null,
      historyInfluence: expData?.history_influence ?? [],
      shapNorm: expData?.shap_norm ?? null,
    });
    setText(paragraph);
  }, [requestKey]);

  const topDriver = expData?.history_influence?.[0];
  const topTitle = topDriver ? movies[String(topDriver.item_id)]?.title : null;
  const classified = useMemo(() => {
    return (expData?.history_influence || []).slice(0, 5).map(d => {
      const attn = d.attention ?? 0;
      return { ...d, isKey: attn >= 0.1 };
    });
  }, [expData]);

  if (!text) return null;

  return (
    <section className="fade-up exp-card">
      <div className="section-label" style={{ marginBottom: 20 }}>
        Why these films
        {topTitle && (
          <span style={{ color: "var(--accent)", marginLeft: 4, fontFamily: "var(--sans)", fontSize: 11, fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>
            · anchored by <em style={{ fontStyle: "italic" }}>{topTitle}</em>
          </span>
        )}
      </div>

      <p className="exp-paragraph">{text}</p>

      {classified.length > 0 && (
        <div style={{ marginTop: 24, display: "flex", gap: 8, flexWrap: "wrap" }}>
          {classified.map(d => {
            const m = movies[String(d.item_id)];
            return (
              <div key={d.item_id} className={`inf-chip${d.isKey ? " confirmed" : ""}`}>
                <span style={{ color: "var(--text)", fontFamily: "var(--sans)", fontSize: 12 }}>
                  {m?.title ? (m.title.length > 18 ? m.title.slice(0, 16) + "…" : m.title) : `#${d.item_id}`}
                </span>
                <span style={{ color: "var(--muted)" }}>·</span>
                <span>{Math.round(d.attention * 100)}%</span>
                {d.isKey && <span style={{ fontSize: 10 }}>✦</span>}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// ── Empty state ───────────────────────────────────────────────
function EmptyState() {
  return (
    <div style={{ textAlign: "center", padding: "80px 0", color: "var(--muted)" }} className="fade-up">
      <div style={{ position: "relative", display: "inline-block", marginBottom: 24 }}>
        <div style={{ fontSize: 64, opacity: .15, animation: "float 3s ease-in-out infinite" }}>🎬</div>
        <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", width: 80, height: 80, borderRadius: "50%", background: "radial-gradient(circle, var(--accent)12, transparent)", pointerEvents: "none" }} />
      </div>
      <div style={{ fontFamily: "var(--serif)", fontSize: "1.5rem", color: "var(--text)", marginBottom: 10, fontWeight: 700 }}>
        Start with a film you love
      </div>
      <div style={{ fontSize: 14, color: "var(--muted)", maxWidth: 340, margin: "0 auto", lineHeight: 1.65 }}>
        Search above and build your history. The more you add, the better the model understands your taste.
      </div>
      <div style={{ marginTop: 32, display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
        {["Action", "Drama", "Sci-Fi", "Comedy", "Thriller"].map(g => (
          <span key={g} className="genre-tag" style={{ color: gcolor([g]), borderColor: gcolor([g]) + "44", background: gcolor([g]) + "0a" }}>{g}</span>
        ))}
      </div>
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────
export default function App() {
  const [movies, setMovies] = useState({});
  const [status, setStatus] = useState(null);
  const tmdbKey = "394771898f564a5285ada7bd1fd50b1b";
  const [cache, loadPoster] = usePosterLoader(tmdbKey);

  const [picked, setPicked] = useState([]);
  const [topK, setTopK] = useState(10);
  const [recData, setRecData] = useState(null);
  const [expData, setExpData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [backendNote, setBackendNote] = useState(false);
  const [requestKey, setRequestKey] = useState(0);
  const runId = useRef(0);

  useEffect(() => {
    (async () => {
      try {
        const [s, m] = await Promise.all([
          apiFetch("/status").catch(() => ({ loaded: false })),
          apiFetch("/movies").catch(() => ({})),
        ]);
        setStatus(s); setMovies(m || {});
      } catch { }
    })();
  }, []);

  const addMovie = useCallback((idx, movie) => {
    setPicked(p => p.find(x => x.idx === idx) ? p : [...p, { idx, movie }]);
    setRecData(null); setExpData(null);
  }, []);

  const removeMovie = useCallback(idx => {
    setPicked(p => p.filter(x => x.idx !== idx));
    setRecData(null); setExpData(null);
  }, []);

  const pickedRef = useRef(picked);
  const topKRef = useRef(topK);
  useEffect(() => { pickedRef.current = picked; }, [picked]);
  useEffect(() => { topKRef.current = topK; }, [topK]);

  const run = useCallback(async () => {
    const currentPicked = pickedRef.current;
    const currentTopK = topKRef.current;
    if (!currentPicked.length) return;
    const id = ++runId.current;
    setLoading(true); setErr(null); setRecData(null); setExpData(null);
    try {
      const rec = await apiFetch("/recommend/custom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ history: currentPicked.map(p => p.idx), top_k: currentTopK }),
      });
      if (runId.current !== id) return;
      setRecData(rec); setRequestKey(k => k + 1);
      try {
        const exp = await apiFetch("/explain/custom", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ history: currentPicked.map(p => p.idx), top_k: currentTopK }),
        });
        if (runId.current !== id) return;
        setExpData(exp);
      } catch {
        try {
          const users = await apiFetch("/users?limit=5");
          if (users?.users?.length) {
            const exp = await apiFetch("/explain", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ user_id: users.users[0], top_k: currentTopK }),
            });
            if (runId.current !== id) return;
            const syntheticInfluence = currentPicked.map((p, i) => ({
              item_id: p.idx, attention: 1 / currentPicked.length, position: i, label: "confirmed",
            }));
            setExpData({ ...exp, history_influence: syntheticInfluence, history_len: currentPicked.length });
            setBackendNote(true);
          }
        } catch { }
      }
    } catch (e) {
      if (runId.current === id) setErr(e.message);
    } finally {
      if (runId.current === id) setLoading(false);
    }
  }, []);

  const noMovies = Object.keys(movies).length === 0;

  return (
    <>
      <style>{GLOBAL_CSS}</style>

      {/* ── Nav ── */}
      <nav className="nav">
        <div className="nav-logo">
          <span>CinéRec</span>
          <div className="nav-logo-dot" />
        </div>

        {/* Model badge */}
        <div className="nav-pill" style={{ display: "flex" }}>
          <span style={{ color: "#5b8dee", fontSize: 10 }}>⬡</span> GCN
          <span style={{ color: "var(--border2)", margin: "0 4px" }}>·</span>
          <span style={{ color: "#4caf82", fontSize: 10 }}>◉</span> Memory
          <span style={{ color: "var(--border2)", margin: "0 4px" }}>·</span>
          <span style={{ color: "#c9a84c", fontSize: 10 }}>▸</span> Seq
        </div>

        <div className="nav-status">
          <div className="status-dot" style={{ background: status?.loaded ? "var(--green)" : "var(--red)", animation: !status?.loaded ? "pulse 1.5s infinite" : "none" }} />
          <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--muted)" }}>
            {status?.loaded
              ? `${status.n_users?.toLocaleString()} users · ${Object.keys(movies).length.toLocaleString()} titles`
              : "connecting…"}
          </span>
        </div>
      </nav>

      <main style={{ maxWidth: 1100, margin: "0 auto", padding: "48px 28px" }}>

        {/* ── Hero ── */}
        <div style={{ marginBottom: 52, position: "relative" }} className="fade-up">
          {/* Background glow */}
          <div style={{ position: "absolute", top: -40, left: -60, width: 300, height: 200, background: "radial-gradient(ellipse, var(--accent)08, transparent 70%)", pointerEvents: "none" }} />

          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 24, flexWrap: "wrap" }}>
            <div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--accent)", letterSpacing: ".15em", textTransform: "uppercase", marginBottom: 12, opacity: .8 }}>
                Hybrid recommendation engine
              </div>
              <h1 style={{ fontFamily: "var(--serif)", fontSize: "clamp(2rem, 5vw, 3.6rem)", fontWeight: 900, lineHeight: 1.08, letterSpacing: "-.04em", color: "var(--text)", marginBottom: 14 }}>
                What should you<br />watch{" "}
                <span style={{ color: "var(--accent)", fontStyle: "italic" }}>next?</span>
              </h1>
              <p style={{ color: "var(--muted)", fontSize: 15, maxWidth: 480, lineHeight: 1.7, fontWeight: 300 }}>
                Add films you've loved. Our model blends graph networks, long-term memory, and transformers to surface what's perfect for you.
              </p>
            </div>

            {/* Feature pills */}
            <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 8 }}>
              {[
                { icon: "⬡", label: "Graph Neural Network", color: "#5b8dee" },
                { icon: "◉", label: "Long-term Memory", color: "#4caf82" },
                { icon: "▸", label: "Transformer Attention", color: "#c9a84c" },
              ].map(({ icon, label, color }) => (
                <div key={label} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 14px", borderRadius: "var(--radius-sm)", background: "var(--surface)", border: "1px solid var(--border)", fontSize: 13, color: "var(--muted2)" }}>
                  <span style={{ color, fontSize: 15 }}>{icon}</span> {label}
                </div>
              ))}
            </div>
          </div>
        </div>

        {backendNote && (
          <div className="notice-card fade-up">
            <strong>⚙ Backend tip:</strong> Expose <code>shap_norm</code> from <code>/explain/custom</code> in <code>main.py</code> for full SHAP-based explanations.
          </div>
        )}

        {/* ── Search ── */}
        <div style={{ marginBottom: 32, animationDelay: ".1s" }} className="fade-up">
          <div className="section-label">Build your history</div>
          {noMovies ? (
            <div style={{ color: "var(--muted)", fontSize: 14, padding: "16px 0", fontFamily: "var(--mono)" }}>
              ⚠ Movie catalogue not loaded — check server connection and CORS settings.
            </div>
          ) : (
            <MovieSearch movies={movies} cache={cache} onNeeded={loadPoster} onSelect={addMovie} />
          )}
        </div>

        {/* ── Picked films ── */}
        {picked.length > 0 && (
          <div style={{ marginBottom: 36 }} className="fade-up">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <div className="section-label" style={{ margin: 0 }}>
                Selected · {picked.length} {picked.length === 1 ? "film" : "films"}
              </div>
              <button className="btn btn-ghost btn-sm"
                onClick={() => { setPicked([]); setRecData(null); setExpData(null); }}>
                Clear all
              </button>
            </div>
            <div className="movie-grid">
              {picked.map(({ idx }, i) => (
                <MovieCard key={idx} idx={idx} movies={movies} cache={cache}
                  onNeeded={loadPoster} onRemove={removeMovie} delay={i * 0.04} showGenre />
              ))}
            </div>

            {/* Genre radar of history */}
            {picked.length >= 3 && (
              <div style={{ marginTop: 20 }}>
                <GenreRadar picked={picked} movies={movies} />
              </div>
            )}

            <div style={{ display: "flex", gap: 12, marginTop: 24, alignItems: "center", flexWrap: "wrap" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, background: "var(--surface)", border: "1px solid var(--border2)", borderRadius: "var(--radius)", padding: "8px 16px" }}>
                <span style={{ color: "var(--muted)", fontSize: 13, fontFamily: "var(--mono)" }}>Top</span>
                <input type="number" value={topK} min={5} max={20}
                  onChange={e => setTopK(Number(e.target.value))}
                  style={{ width: 52, background: "transparent", border: "none", color: "var(--accent)", fontFamily: "var(--mono)", fontSize: 16, fontWeight: 600, outline: "none", textAlign: "center" }}
                />
                <span style={{ color: "var(--muted)", fontSize: 13, fontFamily: "var(--mono)" }}>picks</span>
              </div>
              <button className="btn btn-primary" onClick={run} disabled={loading || !picked.length}>
                {loading ? <><span className="spinner" /> Analysing…</> : "✦ Get recommendations"}
              </button>
              {recData && (
                <button className="btn btn-ghost" onClick={() => { setRecData(null); setExpData(null); }}>
                  ↺ Reset
                </button>
              )}
            </div>
          </div>
        )}

        {err && <ErrBox msg={err} />}
        {loading && <Loader text="Running hybrid model — GCN · Memory · Transformer…" />}

        {/* ── Results ── */}
        {recData && (
          <div style={{ display: "flex", flexDirection: "column", gap: 44 }}>

            {/* Stats row */}
            <StatsRow picked={picked} recommendations={recData.recommendations} movies={movies} expData={expData} />

            {/* Timeline */}
            {picked.length > 0 && (
              <div className="fade-up" style={{ animationDelay: ".05s" }}>
                <HistoryTimeline picked={picked} movies={movies} cache={cache} onNeeded={loadPoster} influence={expData?.history_influence} />
              </div>
            )}

            {/* Recommendations grid */}
            <section className="fade-up" style={{ animationDelay: ".1s" }}>
              <div className="section-label">Recommended for you</div>
              <div className="movie-grid-lg">
                {recData.recommendations.map((r, i) => (
                  <MovieCard key={r.item_id} idx={r.item_id} movies={movies}
                    cache={cache} onNeeded={loadPoster}
                    rank={i + 1} delay={i * 0.04} showGenre />
                ))}
              </div>
            </section>

            {/* Explanation */}
            <ExplanationPanel
              key={requestKey}
              requestKey={requestKey}
              picked={picked}
              recData={recData}
              expData={expData}
              movies={movies}
            />

            {/* Charts grid */}
            {expData ? (
              <section className="fade-up" style={{ animationDelay: ".15s" }}>
                <div className="section-label">Model analytics</div>

                {/* Row 1 */}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 14, marginBottom: 14 }}>
                  <GateChart gates={expData.component_weights} />
                  <div className="chart-box" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                    <div className="chart-title">Signal breakdown</div>
                    <GateBars gates={expData.component_weights} />
                    <hr className="divider" style={{ marginTop: 4 }} />
                    <div style={{ fontSize: 13, color: "var(--muted)", lineHeight: 1.7 }}>
                      {expData.component_weights.gcn > expData.component_weights.memory && expData.component_weights.gcn > expData.component_weights.seq
                        ? "Collaborative signals from similar viewers dominated — the graph network found your tribe."
                        : expData.component_weights.memory > expData.component_weights.seq
                          ? "Long-term preference patterns were the strongest predictor for your picks."
                          : "Recent viewing behaviour drove this result — your current arc is clear."}
                    </div>
                  </div>
                </div>

                {/* Row 2 */}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 14, marginBottom: 14 }}>
                  <AttentionChart influence={expData.history_influence} movies={movies} />
                  <RecGenreChart recommendations={recData.recommendations} movies={movies} />
                </div>

                {/* Row 3 */}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 14 }}>
                  <ScoreChart recommendations={recData.recommendations} movies={movies} />
                  <ScoreCurveChart recommendations={recData.recommendations} movies={movies} />
                </div>
              </section>
            ) : (
              <section className="fade-up">
                <div className="section-label">Score distribution</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 14 }}>
                  <ScoreChart recommendations={recData.recommendations} movies={movies} />
                  <ScoreCurveChart recommendations={recData.recommendations} movies={movies} />
                </div>
              </section>
            )}

          </div>
        )}

        {/* ── Empty ── */}
        {!recData && !loading && picked.length === 0 && <EmptyState />}

      </main>
    </>
  );
}