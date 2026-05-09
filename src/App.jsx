import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { Chart, registerables } from "chart.js";
Chart.register(...registerables);

// ── Config ────────────────────────────────────────────────────
const API = "/api";

// ── FREE LLM: Google Gemini ────────────────────────────────────
const GEMINI_API_KEY = "AIzaSyDjwBhzpVvLMi8C6I_zkb2wRXafj81Rw1s";

const GEMINI_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-2.0-flash",
  "gemini-3-flash-preview",
];
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// ── Time context constants ────────────────────────────────────
const TOD_SLOTS = [
  { key: "morning", label: "Morning", icon: "☀", hours: "05–11", desc: "Early risers" },
  { key: "afternoon", label: "Afternoon", icon: "🌤", hours: "11–17", desc: "Midday picks" },
  { key: "evening", label: "Evening", icon: "🌆", hours: "17–21", desc: "Prime time" },
  { key: "night", label: "Night", icon: "🌙", hours: "21–05", desc: "Late night" },
];
const SEASON_SLOTS = [
  { key: "winter", label: "Winter", icon: "❄", months: "Dec–Feb", desc: "Cozy season" },
  { key: "spring", label: "Spring", icon: "🌸", months: "Mar–May", desc: "Renewal mood" },
  { key: "summer", label: "Summer", icon: "☀", months: "Jun–Aug", desc: "Blockbuster season" },
  { key: "fall", label: "Fall", icon: "🍂", months: "Sep–Nov", desc: "Award season" },
];

const TOD_COLORS = {
  morning: "#EF9F27",
  afternoon: "#378ADD",
  evening: "#9b72ef",
  night: "#4caf82",
};
const SEASON_COLORS = {
  winter: "#378ADD",
  spring: "#4caf82",
  summer: "#EF9F27",
  fall: "#D85A30",
};

// ── Client-side context bias (fallback when backend endpoint absent) ──
// These tables encode which genres are over-indexed for each time/season slot.
const TOD_GENRE_BIAS = {
  0: { Animation: 0.15, Comedy: 0.12, Family: 0.12, Documentary: 0.10, Musical: 0.08 },   // Morning
  1: { Adventure: 0.12, Action: 0.10, Comedy: 0.08, Children: 0.10, Musical: 0.08 },       // Afternoon
  2: { Drama: 0.12, Romance: 0.10, Thriller: 0.08, Crime: 0.06 },                          // Evening
  3: { Horror: 0.15, Thriller: 0.12, "Sci-Fi": 0.10, Crime: 0.08, Mystery: 0.10 },        // Night
};
const SEASON_GENRE_BIAS = {
  0: { Drama: 0.12, Romance: 0.10, Family: 0.10, Animation: 0.08 },                        // Winter
  1: { Comedy: 0.12, Romance: 0.10, Adventure: 0.08, Musical: 0.08 },                      // Spring
  2: { Action: 0.12, Adventure: 0.12, "Sci-Fi": 0.10, Animation: 0.06 },                  // Summer
  3: { Horror: 0.15, Thriller: 0.10, Crime: 0.08, Drama: 0.08 },                           // Fall
};

/**
 * Re-scores and re-sorts recommendations using a genre × time/season bias.
 * Used as a client-side fallback when the backend context endpoint is unavailable.
 * Returns a new sorted array — the original baseRec stays untouched.
 */
function applyClientContextBias(recs, movies, todSlot, seasonSlot, todWeight, seasonWeight) {
  const todBias = TOD_GENRE_BIAS[todSlot] || {};
  const seasonBias = SEASON_GENRE_BIAS[seasonSlot] || {};
  return [...recs]
    .map(r => {
      const genres = movies?.[String(r.item_id)]?.genres || [];
      let bias = 0;
      genres.forEach(g => {
        bias += (todBias[g] || 0) * todWeight * 4;
        bias += (seasonBias[g] || 0) * seasonWeight * 4;
      });
      return { ...r, score: (r.score || 0) + bias };
    })
    .sort((a, b) => b.score - a.score);
}

function getCurrentTod() {
  const h = new Date().getHours();
  if (h >= 5 && h < 11) return 0;
  if (h >= 11 && h < 17) return 1;
  if (h >= 17 && h < 21) return 2;
  return 3;
}
function getCurrentSeason() {
  const m = new Date().getMonth() + 1;
  if (m === 12 || m <= 2) return 0;
  if (m <= 5) return 1;
  if (m <= 8) return 2;
  return 3;
}

// ── Explanation cache ─────────────────────────────────────────
const EXP_CACHE = {};
let _lastGeminiCall = 0;
let _geminiQueue = Promise.resolve();

function callGemini(prompt, retries = 1) {
  return new Promise(resolve => {
    _geminiQueue = _geminiQueue.then(async () => {
      try {
        const gap = Date.now() - _lastGeminiCall;
        if (gap < 4000) await new Promise(r => setTimeout(r, 4000 - gap));
        for (const model of GEMINI_MODELS) {
          const url = `${GEMINI_BASE}/${model}:generateContent?key=${GEMINI_API_KEY}`;
          for (let attempt = 0; attempt <= retries; attempt++) {
            try {
              _lastGeminiCall = Date.now();
              const res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  contents: [{ parts: [{ text: prompt }] }],
                  generationConfig: { temperature: 0.85, maxOutputTokens: 8192 },
                }),
              });
              if (res.status === 429) { console.warn(`[Gemini] 429 on ${model}`); break; }
              if (res.status === 404) { console.warn(`[Gemini] 404 ${model}`); break; }
              if (res.status === 400) { break; }
              if (!res.ok) { const b = await res.text().catch(() => ""); throw new Error(`HTTP ${res.status}: ${b.slice(0, 120)}`); }
              const data = await res.json();
              const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
              if (text) { resolve(text); return; }
              break;
            } catch (e) {
              console.warn(`[Gemini] Error on ${model} attempt ${attempt}:`, e.message);
              if (attempt === retries) break;
              await new Promise(r => setTimeout(r, 1500));
            }
          }
        }
        resolve(null);
      } catch (err) { console.error("[Gemini] Fatal:", err); resolve(null); }
    });
  });
}

async function generateGeminiExplanation({ picked, recommendations, movies, gates, historyInfluence, shapNorm, lang, todSlot, seasonSlot }) {
  const cacheKey = `${lang}::${todSlot}::${seasonSlot}::${(picked || []).map(p => p.idx ?? p).join(",")}::${(recommendations || []).slice(0, 5).map(r => r.item_id).join(",")}`;
  if (EXP_CACHE[cacheKey]) return EXP_CACHE[cacheKey];

  const topInfluence = (historyInfluence || []).slice(0, 8).map(d => {
    const m = movies?.[String(d.item_id)];
    const title = m?.title ? `${m.title} (${m.year || "Unknown"})` : `#${d.item_id}`;
    const attn = Math.round((d.attention ?? 0) * 100);
    const shap = shapNorm?.[d.position] != null ? Math.round(shapNorm[d.position] * 100) : null;
    return `"${title}": attention ${attn}%${shap != null ? `, SHAP ${shap}%` : ""}`;
  }).join("\n");

  const topRecs = recommendations.slice(0, 5).map((r, i) => {
    const m = movies?.[String(r.item_id)];
    return `${i + 1}. "${m?.title ? `${m.title} (${m.year || "Unknown"})` : `#${r.item_id}`}" (${m?.genres?.[0] || "Unknown"}, score ${r.score?.toFixed ? r.score.toFixed(3) : r.score})`;
  }).join("\n");

  const watchedGenres = [...new Set((picked || []).map(p => movies?.[String(p.idx ?? p)]?.genres?.[0]).filter(Boolean))].join(", ");
  const { gcn = 0, memory = 0, seq = 0 } = gates || {};
  const isArabic = lang === "ar";

  const todName = todSlot != null ? TOD_SLOTS[todSlot]?.label : null;
  const seasonName = seasonSlot != null ? SEASON_SLOTS[seasonSlot]?.label : null;
  const contextHint = todName && seasonName ? `The user is watching on a ${seasonName} ${todName}. Weave in a subtle nod to why these films suit that mood/season if it feels natural.` : "";

  const prompt = isArabic
    ? `You are a friendly, expert movie critic and cinephile. Explain to the user why these specific movies are being recommended to them based on their watch history. Write a concise, engaging, and personalized explanation (just 1 short paragraph). Focus on a variety of connections using your knowledge of cinema—such as the release era (year), the director, the writer, the visual style, or the story themes, rather than just relying on the genre. ${contextHint}

CRITICAL REQUIREMENT: You MUST write your entire response in highly fluent, natural, and eloquent Arabic. Do NOT use any technical AI/data jargon. Talk to them like a knowledgeable friend recommending a great movie night. Ensure your response is fully complete and does not cut off mid-sentence.

Watched genres: ${watchedGenres || "varied"}
Favorite past films: ${topInfluence || "no data"}
Top recommendations: ${topRecs}

Rules: Keep it concise (1 paragraph max). Connect their past favorite films to the new recommendations using directors, release years, or cinematic style. Be conversational and enthusiastic. Respond EXCLUSIVELY in Arabic.`
    : `You are a friendly, expert movie critic and cinephile. Explain to the user why these specific movies are being recommended to them based on their watch history. Write a concise, engaging, and personalized explanation (just 1 short paragraph). Focus on a variety of connections using your knowledge of cinema—such as the release era (year), the director, the writer, the visual style, or the story themes, rather than just relying on the genre. ${contextHint}

CRITICAL REQUIREMENT: Do NOT use any technical AI/data jargon. Talk to them like a knowledgeable friend recommending a great movie night. Ensure your response is fully complete, does not cut off mid-sentence, and ends with proper concluding punctuation.

Watched genres: ${watchedGenres || "varied"}
Favorite past films: ${topInfluence || "no data"}
Top recommendations: ${topRecs}

Rules: Keep it concise (1 paragraph max). Connect their past favorite films to the new recommendations. Be conversational and enthusiastic.`;

  const text = await callGemini(prompt);
  if (text) { EXP_CACHE[cacheKey] = text; return text; }
  const fallback = isArabic
    ? "عذراً، استنفد مفتاح Gemini API الحصة المسموحة. يرجى التحقق من لوحة تحكم Google AI Studio."
    : "Could not reach Gemini (429 Rate Limit/Quota Exceeded). Please check your API key usage in Google AI Studio.";
  return fallback;
}

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

function titleOf(id, m) { return m?.[String(id)]?.title || null; }
function genreOf(id, m) { return m?.[String(id)]?.genres?.[0] || null; }
function yearOf(id, m) { return m?.[String(id)]?.year || null; }

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
@import url('https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;0,900;1,400&family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@300;400&family=Noto+Naskh+Arabic:wght@400;500;600;700&display=swap');

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
  --arabic:   'Noto Naskh Arabic', 'Arabic Typesetting', serif;
  --radius:   14px;
  --radius-sm: 8px;
  --radius-lg: 20px;
}

body { background:var(--bg); color:var(--text); font-family:var(--sans); min-height:100vh; overflow-x:hidden; -webkit-font-smoothing:antialiased; }
::-webkit-scrollbar{width:4px} ::-webkit-scrollbar-track{background:transparent} ::-webkit-scrollbar-thumb{background:#ffffff15;border-radius:2px}

@keyframes fadeUp{from{opacity:0;transform:translateY(24px)}to{opacity:1;transform:translateY(0)}}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
@keyframes shimmer{0%{background-position:-800px 0}100%{background-position:800px 0}}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
@keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}
@keyframes slideInLang{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}
@keyframes typing{0%,100%{opacity:1}50%{opacity:.3}}
@keyframes contextGlow{0%,100%{box-shadow:0 0 0 0 transparent}50%{box-shadow:0 0 18px 2px var(--ctx-color,#c9a84c)33}}

.fade-up{animation:fadeUp .55s cubic-bezier(.2,.8,.4,1) both}
.fade-in{animation:fadeIn .4s ease both}

.pcard{position:relative;border-radius:var(--radius);overflow:hidden;background:var(--card);cursor:pointer;transition:transform .25s cubic-bezier(.2,.8,.4,1),box-shadow .25s;border:1px solid var(--border);will-change:transform}
.pcard:hover{transform:translateY(-6px) scale(1.02);box-shadow:0 24px 48px #00000077,0 0 0 1px var(--border2)}
.pcard.selected{border-color:var(--accent);box-shadow:0 0 0 2px var(--accent)55}
.pcard.hit{border-color:var(--green);box-shadow:0 0 0 2px var(--green)55}
.pcard.ctx-boosted{border-color:var(--ctx-color,var(--accent));box-shadow:0 0 0 2px var(--ctx-color,var(--accent))44}
.pcard-img{width:100%;aspect-ratio:2/3;object-fit:cover;display:block;transition:transform .3s}
.pcard:hover .pcard-img{transform:scale(1.04)}
.pcard-fallback{width:100%;aspect-ratio:2/3;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:var(--serif);font-size:2rem;font-weight:900;letter-spacing:-.04em}
.pcard-info{padding:12px 10px 14px;background:linear-gradient(to top,#000000ee 0%,#00000066 60%,transparent 100%);position:absolute;bottom:0;left:0;right:0}
.pcard-title{font-family:var(--sans);font-size:12px;font-weight:500;color:#fff;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.pcard-year{font-size:10px;color:#ffffff70;margin-top:3px;font-family:var(--mono)}
.pcard-genre{font-size:9px;margin-top:3px;font-family:var(--mono)}
.rank-badge{position:absolute;top:8px;left:8px;background:#000000bb;backdrop-filter:blur(6px);border-radius:6px;padding:3px 8px;font-family:var(--mono);font-size:11px;color:var(--accent);border:1px solid var(--accent)33}
.hit-badge{position:absolute;top:8px;right:8px;background:var(--green)dd;border-radius:6px;padding:3px 8px;font-size:10px;font-weight:600;color:#fff}
.ctx-badge{position:absolute;bottom:52px;left:8px;right:8px;background:#00000099;backdrop-filter:blur(4px);border-radius:5px;padding:3px 6px;font-family:var(--mono);font-size:9px;text-align:center;border:1px solid var(--ctx-color,var(--accent))44;color:var(--ctx-color,var(--accent))}
.remove-btn{position:absolute;top:7px;right:7px;z-index:10;width:24px;height:24px;border-radius:50%;background:#000000cc;backdrop-filter:blur(4px);border:1px solid #ffffff22;cursor:pointer;color:#fff;font-size:15px;display:flex;align-items:center;justify-content:center;transition:all .15s;opacity:0}
.pcard:hover .remove-btn{opacity:1}
.remove-btn:hover{background:var(--red)cc;border-color:var(--red)55;transform:scale(1.1)}

.search-wrap{position:relative}
.search-input{width:100%;background:var(--surface);border:1px solid var(--border2);color:var(--text);border-radius:var(--radius);padding:14px 20px 14px 48px;font-family:var(--sans);font-size:15px;outline:none;transition:border-color .2s,box-shadow .2s,background .2s}
.search-input:focus{border-color:var(--accent)66;box-shadow:0 0 0 4px var(--accent)12;background:var(--card)}
.search-input::placeholder{color:var(--muted)}
.search-icon{position:absolute;left:16px;top:50%;transform:translateY(-50%);color:var(--muted);font-size:18px;pointer-events:none;z-index:1}

.dropdown{background:var(--card2);border:1px solid var(--border2);border-radius:var(--radius-lg);max-height:440px;overflow-y:auto;box-shadow:0 32px 80px #000000aa;animation:fadeUp .18s ease}
.dd-item{display:flex;align-items:center;gap:14px;padding:10px 16px;cursor:pointer;border-bottom:1px solid var(--border);transition:background .1s}
.dd-item:last-child{border-bottom:none}
.dd-item:hover{background:var(--surface)}
.dd-item:first-child{border-radius:var(--radius-lg) var(--radius-lg) 0 0}
.dd-item:last-child{border-radius:0 0 var(--radius-lg) var(--radius-lg)}
.dd-thumb{width:38px;height:57px;border-radius:6px;overflow:hidden;flex-shrink:0}
.dd-title{font-size:14px;font-weight:500;color:var(--text)}
.dd-meta{font-size:12px;color:var(--muted);margin-top:2px;font-family:var(--mono)}
.dd-genre-dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:5px;vertical-align:middle}

.btn{display:inline-flex;align-items:center;gap:8px;padding:11px 24px;border-radius:var(--radius);border:none;font-family:var(--sans);font-size:14px;font-weight:500;cursor:pointer;transition:all .18s cubic-bezier(.2,.8,.4,1);white-space:nowrap;letter-spacing:.01em}
.btn-primary{background:linear-gradient(135deg,var(--accent) 0%,var(--accent2) 100%);color:#0a0a0f;font-weight:600}
.btn-primary:hover:not(:disabled){background:linear-gradient(135deg,var(--accent2) 0%,var(--accent3) 100%);transform:translateY(-2px);box-shadow:0 12px 32px var(--accent)44}
.btn-ghost{background:transparent;color:var(--muted);border:1px solid var(--border2)}
.btn-ghost:hover:not(:disabled){background:var(--surface);color:var(--text);border-color:var(--border3)}
.btn-blue{background:linear-gradient(135deg,var(--blue)cc,var(--blue));color:#fff;font-weight:600}
.btn-blue:hover:not(:disabled){opacity:.9;transform:translateY(-2px);box-shadow:0 12px 32px var(--blue)44}
.btn-ctx{color:#fff;font-weight:600;border:none}
.btn-ctx:hover:not(:disabled){opacity:.9;transform:translateY(-2px)}
.btn-sm{padding:7px 14px;font-size:12px;border-radius:var(--radius-sm)}
.btn:disabled{opacity:.35;cursor:not-allowed;transform:none!important}
.btn:active:not(:disabled){transform:translateY(0) scale(.98)}

.spinner{width:16px;height:16px;border:2px solid var(--border2);border-top-color:var(--accent);border-radius:50%;animation:spin .7s linear infinite}
.spinner-lg{width:36px;height:36px;border:3px solid var(--border2);border-top-color:var(--accent);border-radius:50%;animation:spin .9s linear infinite}

.section-label{font-family:var(--mono);font-size:11px;letter-spacing:.13em;text-transform:uppercase;color:var(--muted);margin-bottom:16px;display:flex;align-items:center;gap:8px}
.section-label::before{content:'';display:inline-block;width:16px;height:1px;background:var(--accent);opacity:.6}

.movie-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:12px}
.movie-grid-lg{display:grid;grid-template-columns:repeat(auto-fill,minmax(145px,1fr));gap:14px}

/* ── Context Selector ── */
.ctx-panel{background:linear-gradient(135deg,var(--card) 0%,var(--card2) 100%);border:1px solid var(--border2);border-radius:var(--radius-lg);padding:24px 28px;margin-bottom:32px;position:relative;overflow:hidden}
.ctx-panel::before{content:'';position:absolute;top:-30px;right:-30px;width:160px;height:160px;background:radial-gradient(circle,var(--accent)06,transparent);pointer-events:none}
.ctx-slot-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:10px}
.ctx-slot{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:10px 8px 10px;text-align:center;cursor:pointer;transition:all .18s cubic-bezier(.2,.8,.4,1);position:relative;overflow:hidden}
.ctx-slot:hover{border-color:var(--border2);transform:translateY(-2px)}
.ctx-slot.active{border-color:var(--slot-color,var(--accent));box-shadow:0 0 0 1px var(--slot-color,var(--accent))55,0 6px 20px var(--slot-color,var(--accent))18;background:var(--slot-color,var(--accent))0d}
.ctx-slot-icon{font-size:20px;margin-bottom:4px;display:block}
.ctx-slot-label{font-family:var(--mono);font-size:11px;color:var(--text);display:block;font-weight:500}
.ctx-slot-hours{font-family:var(--mono);font-size:9px;color:var(--muted);display:block;margin-top:2px}
.ctx-auto-badge{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:20px;background:var(--green)12;border:1px solid var(--green)33;font-family:var(--mono);font-size:10px;color:var(--green)}
.ctx-weight-row{display:flex;align-items:center;gap:12px;margin-top:8px}
.ctx-weight-label{font-family:var(--mono);font-size:11px;color:var(--muted);width:90px;flex-shrink:0}
.ctx-weight-val{font-family:var(--mono);font-size:11px;color:var(--accent);width:32px;text-align:right;flex-shrink:0}
input[type=range].ctx-slider{flex:1;accent-color:var(--accent)}

/* ── Context compare strip ── */
.ctx-compare{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);padding:18px 22px;margin-top:20px}
.ctx-compare-row{display:flex;align-items:center;gap:10px;padding:5px 0;border-bottom:1px solid var(--border);font-family:var(--mono);font-size:12px}
.ctx-compare-row:last-child{border-bottom:none}
.ctx-rank{width:24px;text-align:right;color:var(--muted);flex-shrink:0}
.ctx-item-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text)}
.ctx-delta{padding:2px 8px;border-radius:12px;font-size:10px;flex-shrink:0}
.ctx-delta.up{background:var(--green)15;color:var(--green);border:1px solid var(--green)33}
.ctx-delta.new{background:var(--accent)15;color:var(--accent);border:1px solid var(--accent)33}
.ctx-delta.same{color:var(--muted)}
.ctx-delta.down{background:var(--red)0d;color:var(--red);border:1px solid var(--red)22}

/* ── Context active banner ── */
.ctx-banner{display:flex;align-items:center;gap:10px;padding:8px 16px;border-radius:var(--radius-sm);background:var(--ctx-bg,var(--accent)0d);border:1px solid var(--ctx-border,var(--accent)33);margin-bottom:18px;font-family:var(--mono);font-size:12px}
.ctx-banner-icon{font-size:16px}
.ctx-banner-text{color:var(--ctx-text,var(--accent));flex:1}
.ctx-banner-dismiss{cursor:pointer;color:var(--muted);font-size:16px;padding:0 4px;line-height:1;border:none;background:none;transition:color .15s}
.ctx-banner-dismiss:hover{color:var(--text)}

/* ── Explanation card ── */
.exp-card{background:linear-gradient(135deg,var(--card) 0%,var(--card2) 100%);border:1px solid var(--border2);border-radius:var(--radius-lg);padding:32px 36px;position:relative;overflow:hidden}
.exp-card::before{content:'"';position:absolute;top:-20px;left:24px;font-family:var(--serif);font-size:160px;color:var(--accent);opacity:.06;line-height:1;pointer-events:none}
.exp-card::after{content:'';position:absolute;top:0;right:0;bottom:0;width:200px;background:radial-gradient(ellipse at right center,var(--accent)05,transparent);pointer-events:none}
.exp-paragraph{font-family:var(--serif);font-size:18px;line-height:1.9;color:var(--text);font-weight:400;position:relative;z-index:1;animation:slideInLang .35s ease both}
.exp-paragraph.arabic{font-family:var(--arabic);font-size:20px;line-height:2.1;direction:rtl;text-align:right;letter-spacing:0;word-spacing:.06em}

.exp-skeleton{position:relative;z-index:1}
.exp-skeleton-line{height:18px;border-radius:4px;background:linear-gradient(90deg,var(--card) 25%,#ffffff07 50%,var(--card) 75%);background-size:800px 100%;animation:shimmer 1.8s infinite;margin-bottom:12px}
.exp-typing-dots{display:inline-flex;align-items:center;gap:5px;padding:4px 0}
.exp-typing-dot{width:6px;height:6px;border-radius:50%;background:var(--accent);animation:typing 1.2s ease-in-out infinite}
.exp-typing-dot:nth-child(2){animation-delay:.2s}
.exp-typing-dot:nth-child(3){animation-delay:.4s}

.gemini-badge{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:20px;border:1px solid var(--border2);background:var(--surface);font-family:var(--mono);font-size:10px;color:var(--muted);flex-shrink:0}
.gemini-dot{width:5px;height:5px;border-radius:50%;background:linear-gradient(135deg,#4285f4,#ea4335,#fbbc04,#34a853);flex-shrink:0}

.lang-toggle{display:inline-flex;align-items:center;background:var(--surface);border:1px solid var(--border2);border-radius:24px;padding:3px;gap:2px;flex-shrink:0}
.lang-btn{padding:5px 14px;border-radius:20px;border:none;cursor:pointer;font-size:12px;font-weight:500;transition:all .2s cubic-bezier(.2,.8,.4,1);background:transparent;letter-spacing:.02em}
.lang-btn.en{font-family:var(--mono);color:var(--muted)}
.lang-btn.ar{font-family:var(--arabic);color:var(--muted);font-size:13px}
.lang-btn.active{background:var(--card2);box-shadow:0 2px 8px #00000055}
.lang-btn.en.active{color:var(--accent)}
.lang-btn.ar.active{color:var(--accent2)}

.chart-box{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:22px 22px 18px;transition:border-color .2s}
.chart-box:hover{border-color:var(--border2)}
.chart-title{font-family:var(--mono);font-size:11px;text-transform:uppercase;letter-spacing:.12em;color:var(--muted);margin-bottom:18px}

.shimmer{background:linear-gradient(90deg,var(--card) 25%,#ffffff07 50%,var(--card) 75%);background-size:800px 100%;animation:shimmer 1.8s infinite;border-radius:var(--radius-sm)}

.nav{position:sticky;top:0;z-index:200;background:var(--bg)e8;backdrop-filter:blur(28px) saturate(1.5);border-bottom:1px solid var(--border);padding:0 48px;height:62px;display:flex;align-items:center;gap:0}
.nav-logo{font-family:var(--serif);font-size:21px;font-weight:700;color:var(--accent);letter-spacing:-.02em;white-space:nowrap;display:flex;align-items:center;gap:8px;margin-right:24px}
.nav-logo-dot{width:6px;height:6px;border-radius:50%;background:var(--accent);animation:pulse 2s infinite}
.nav-pill{background:var(--surface);border:1px solid var(--border2);border-radius:20px;padding:5px 14px;font-family:var(--mono);font-size:11px;color:var(--muted2);display:flex;align-items:center;gap:6px;margin-right:12px}
.nav-status{display:flex;align-items:center;gap:8px;margin-left:auto}
.status-dot{width:7px;height:7px;border-radius:50%}

.page-tabs{display:flex;align-items:center;gap:4px;margin-right:16px;background:var(--surface);border:1px solid var(--border2);border-radius:24px;padding:4px}
.page-tab{padding:6px 16px;border-radius:20px;font-family:var(--mono);font-size:11px;cursor:pointer;transition:all .18s;border:none;background:transparent;color:var(--muted);letter-spacing:.04em;display:flex;align-items:center;gap:6px}
.page-tab:hover{color:var(--text)}
.page-tab.active{background:var(--card2);color:var(--text);box-shadow:0 2px 8px #00000044}
.page-tab.active.explorer-tab{color:var(--blue)}
.page-tab.active.custom-tab{color:var(--accent)}

.gate-row{display:flex;align-items:center;gap:12px;margin-bottom:12px}
.gate-label{font-family:var(--mono);font-size:12px;color:var(--muted);width:64px;flex-shrink:0}
.gate-bar-wrap{flex:1;height:10px;background:var(--bg);border-radius:5px;overflow:hidden}
.gate-bar{height:100%;border-radius:5px;transition:width 1s cubic-bezier(.2,.8,.4,1)}
.gate-pct{font-family:var(--mono);font-size:12px;width:38px;text-align:right;flex-shrink:0}

.stat-card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:20px 22px;display:flex;flex-direction:column;gap:4px;transition:border-color .2s,transform .2s}
.stat-card:hover{border-color:var(--border2);transform:translateY(-2px)}
.stat-value{font-family:var(--serif);font-size:2rem;font-weight:700;color:var(--text);line-height:1}
.stat-label{font-family:var(--mono);font-size:11px;color:var(--muted);letter-spacing:.06em;text-transform:uppercase;margin-top:4px}
.stat-sub{font-family:var(--mono);font-size:11px;color:var(--muted);margin-top:2px}

.genre-tag{display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border-radius:20px;font-family:var(--mono);font-size:10px;border:1px solid;letter-spacing:.03em}

.inf-chip{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:6px 12px;display:inline-flex;align-items:center;gap:6px;font-family:var(--mono);font-size:11px;color:var(--muted);transition:border-color .15s}
.inf-chip.confirmed{border-color:var(--accent)44;color:var(--accent)}
.inf-chip.hidden-influence{border-color:var(--purple)44;color:var(--purple)}

.notice-card{background:#c9a84c0d;border:1px solid #c9a84c2a;border-radius:var(--radius);padding:16px 20px;margin-bottom:24px;font-size:13px;line-height:1.6;color:var(--accent2)}
.notice-card code{font-family:var(--mono);font-size:12px;background:#ffffff0a;padding:2px 6px;border-radius:4px;color:var(--text)}

.apikey-notice{background:#5b8dee0d;border:1px solid #5b8dee33;border-radius:var(--radius);padding:16px 20px;margin-bottom:24px;font-size:13px;line-height:1.7;color:#a0bdf5}
.apikey-notice a{color:var(--accent2);text-decoration:underline;text-underline-offset:3px}
.apikey-notice code{font-family:var(--mono);font-size:12px;background:#ffffff0a;padding:2px 6px;border-radius:4px;color:var(--text)}

.timeline-track{display:flex;align-items:center;overflow-x:auto;padding:12px 0;scrollbar-width:none}
.timeline-track::-webkit-scrollbar{display:none}
.tl-node{display:flex;flex-direction:column;align-items:center;gap:6px;flex-shrink:0;width:80px;position:relative}
.tl-node::after{content:'';position:absolute;left:50%;top:28px;width:100%;height:1px;background:var(--border2);z-index:0}
.tl-node:last-child::after{display:none}
.tl-circle{width:52px;height:52px;border-radius:50%;overflow:hidden;border:2px solid var(--border2);position:relative;z-index:1;background:var(--card);flex-shrink:0;transition:border-color .2s}
.tl-circle.active{border-color:var(--accent)}
.tl-idx{font-family:var(--mono);font-size:9px;color:var(--muted);text-align:center;white-space:nowrap}
.tl-label{font-size:10px;font-weight:500;color:var(--text);text-align:center;max-width:74px;line-height:1.2;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}

.divider{border:none;border-top:1px solid var(--border);margin:4px 0}

.gauge-card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:24px 20px 20px;display:flex;flex-direction:column;align-items:center;gap:14px;transition:border-color .2s,transform .2s;position:relative;overflow:hidden}
.gauge-card:hover{border-color:var(--border2);transform:translateY(-2px)}
.gauge-card::after{content:'';position:absolute;bottom:0;left:0;right:0;height:2px}
.gauge-card.green::after{background:linear-gradient(90deg,transparent,var(--green),transparent)}
.gauge-card.amber::after{background:linear-gradient(90deg,transparent,var(--accent),transparent)}
.gauge-card.blue::after{background:linear-gradient(90deg,transparent,var(--blue),transparent)}
.gauge-desc{font-family:var(--mono);font-size:10px;color:var(--muted);text-align:center;line-height:1.6;max-width:130px}
.quality-bar-wrap{width:100%;height:4px;background:var(--bg);border-radius:2px;overflow:hidden}
.quality-bar{height:100%;border-radius:2px;transition:width 1.6s cubic-bezier(.2,.8,.4,1)}

/* ═══ USER EXPLORER ═══ */
.user-chip{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px 14px;cursor:pointer;transition:all .18s;display:flex;align-items:center;justify-content:space-between;font-family:var(--mono)}
.user-chip:hover{border-color:var(--border2);background:var(--card);transform:translateX(3px)}
.user-chip.active{border-color:var(--blue)55;background:var(--blue)08;box-shadow:inset 3px 0 0 var(--blue)}
.user-chip-id{font-size:13px;color:var(--text)}
.user-chip-arrow{font-size:12px;color:var(--muted);transition:color .18s}
.user-chip:hover .user-chip-arrow,.user-chip.active .user-chip-arrow{color:var(--blue)}

.profile-card{background:linear-gradient(135deg,var(--card) 0%,var(--card2) 100%);border:1px solid var(--border2);border-radius:var(--radius-lg);padding:28px 32px;position:relative;overflow:hidden}
.profile-card::before{content:'';position:absolute;top:-60px;right:-60px;width:200px;height:200px;border-radius:50%;background:radial-gradient(circle,var(--blue)08,transparent);pointer-events:none}

.hit-indicator{display:inline-flex;align-items:center;gap:8px;padding:7px 16px;border-radius:var(--radius-sm);font-family:var(--mono);font-size:12px;font-weight:500}
.hit-indicator.hit{background:var(--green)12;border:1px solid var(--green)33;color:var(--green)}
.hit-indicator.miss{background:var(--red)0d;border:1px solid var(--red)22;color:var(--red)}

.load-more-btn{width:100%;padding:12px;background:var(--surface);border:1px dashed var(--border2);border-radius:var(--radius-sm);cursor:pointer;color:var(--muted);font-family:var(--mono);font-size:12px;text-align:center;transition:all .18s;margin-top:8px}
.load-more-btn:hover{border-color:var(--border3);color:var(--text);background:var(--card)}

.genre-bar-row{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.genre-bar-label{font-family:var(--mono);font-size:11px;width:76px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.genre-bar-track{flex:1;height:6px;background:var(--bg);border-radius:3px;overflow:hidden}
.genre-bar-fill{height:100%;border-radius:3px;transition:width 1s cubic-bezier(.2,.8,.4,1)}
.genre-bar-count{font-family:var(--mono);font-size:10px;color:var(--muted);width:22px;text-align:right}

.sidebar-search{width:100%;background:var(--surface);border:1px solid var(--border2);color:var(--text);border-radius:var(--radius-sm);padding:10px 14px 10px 36px;font-family:var(--mono);font-size:12px;outline:none;transition:border-color .2s}
.sidebar-search:focus{border-color:var(--blue)55;box-shadow:0 0 0 3px var(--blue)0d}
.sidebar-search::placeholder{color:var(--muted)}

@media(max-width:700px){
  .nav{padding:0 16px}
  main{padding:20px 14px!important}
  .exp-card{padding:20px 18px}
  .exp-paragraph{font-size:15px}
  .exp-paragraph.arabic{font-size:17px}
  .movie-grid{grid-template-columns:repeat(auto-fill,minmax(100px,1fr))}
  .movie-grid-lg{grid-template-columns:repeat(auto-fill,minmax(120px,1fr))}
  .tab-label{display:none}
  .ctx-slot-grid{grid-template-columns:repeat(2,1fr)}
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
    const obs = new IntersectionObserver(([e]) => { if (e.isIntersecting) { onNeeded?.(title, year); obs.disconnect(); } }, { rootMargin: "500px" });
    if (ref.current) obs.observe(ref.current);
    return () => obs.disconnect();
  }, [title, year, onNeeded]);
  const words = (title || "").replace(/[^a-zA-Z ]/g, "").split(" ").filter(w => w.length > 2);
  const abbr = words.length >= 2 ? words.slice(0, 2).map(w => w[0]).join("").toUpperCase() : (title || "??").slice(0, 2).toUpperCase();
  return (
    <div ref={ref} style={style}>
      {url === "loading" && <div className="shimmer pcard-img" style={{ aspectRatio: "2/3" }} />}
      {url && url !== "loading" && <img src={url} alt={title} className="pcard-img" onError={e => { e.target.style.display = "none"; }} />}
      {(!url || url === null) && url !== "loading" && (
        <div className="pcard-fallback" style={{ background: `linear-gradient(145deg,${color}28,${color}08)`, color }}>
          {small ? null : abbr}
          <div style={{ fontSize: small ? "9px" : "10px", fontFamily: "var(--mono)", color: "var(--muted)", marginTop: small ? 0 : 6, textAlign: "center", padding: "0 8px", lineHeight: 1.3 }}>{genres?.[0] || ""}</div>
        </div>
      )}
    </div>
  );
}

// ── Movie Card ────────────────────────────────────────────────
function MovieCard({ idx, movies, cache, onNeeded, rank, isHit, isSelected, onRemove, onClick, delay = 0, showGenre, ctxBoosted, ctxColor, ctxLabel }) {
  const m = movies?.[String(idx)];
  const title = m?.title || `#${idx}`;
  const year = m?.year;
  const genres = m?.genres || [];
  const color = gcolor(genres);
  return (
    <div
      className={`pcard${isSelected ? " selected" : ""}${isHit ? " hit" : ""}${ctxBoosted ? " ctx-boosted" : ""}`}
      onClick={() => onClick?.(idx)}
      style={{ "--ctx-color": ctxColor, animationDelay: `${delay}s`, animation: "fadeUp .45s ease both" }}
    >
      <Poster title={title} year={year} genres={genres} cache={cache} onNeeded={onNeeded} />
      <div className="pcard-info">
        <div className="pcard-title">{title}</div>
        <div className="pcard-year">{year || ""}</div>
        {showGenre && genres[0] && <div className="pcard-genre" style={{ color }}>{genres[0]}</div>}
      </div>
      {rank != null && <div className="rank-badge">#{rank}</div>}
      {isHit && <div className="hit-badge">✓ Match</div>}
      {ctxBoosted && ctxLabel && <div className="ctx-badge" style={{ "--ctx-color": ctxColor }}>{ctxLabel}</div>}
      {onRemove && <button className="remove-btn" onClick={e => { e.stopPropagation(); onRemove(idx); }}>×</button>}
    </div>
  );
}

// ── Movie Search ──────────────────────────────────────────────
function MovieSearch({ movies, cache, onNeeded, onSelect }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [dropRect, setDropRect] = useState(null);
  const wrapRef = useRef(null);
  const inputRef = useRef(null);
  const hits = useMemo(() => {
    if (q.length < 2) return [];
    const ql = q.toLowerCase();
    return Object.entries(movies).filter(([, m]) => m.title?.toLowerCase().includes(ql))
      .sort(([, a], [, b]) => { const as = a.title?.toLowerCase().startsWith(ql), bs = b.title?.toLowerCase().startsWith(ql); return as === bs ? (a.title || "").localeCompare(b.title || "") : as ? -1 : 1; })
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
    window.addEventListener("scroll", onAny, true); window.addEventListener("resize", onAny);
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
        <div key={idx} className="dd-item" onMouseDown={() => { onSelect(Number(idx), m); setQ(""); setOpen(false); }}>
          <div className="dd-thumb"><Poster title={m.title} year={m.year} genres={m.genres} cache={cache} onNeeded={onNeeded} /></div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="dd-title">{m.title}</div>
            <div className="dd-meta">{m.genres?.[0] && <span className="dd-genre-dot" style={{ background: gcolor(m.genres) }} />}{m.year}{m.genres?.[0] ? ` · ${m.genres[0]}` : ""}</div>
          </div>
          <div style={{ fontSize: 12, color: "var(--muted)", fontFamily: "var(--mono)" }}>+ Add</div>
        </div>
      ))}
    </div>, document.body
  );
  return (
    <div className="search-wrap" ref={wrapRef}>
      <span className="search-icon">🔍</span>
      <input ref={inputRef} className="search-input" value={q}
        onChange={e => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)}
        placeholder="Search for a movie — Inception, Parasite, Toy Story…" />
      {dropdown}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
//  CONTEXT SELECTOR
// ══════════════════════════════════════════════════════════════
function ContextSelector({ todSlot, setTodSlot, seasonSlot, setSeasonSlot, todWeight, setTodWeight, seasonWeight, setSeasonWeight, contextEnabled, setContextEnabled }) {
  const autoTod = getCurrentTod();
  const autoSeason = getCurrentSeason();

  const applyAuto = () => {
    setTodSlot(autoTod);
    setSeasonSlot(autoSeason);
  };

  const todSlotInfo = TOD_SLOTS[todSlot];
  const seasonSlotInfo = SEASON_SLOTS[seasonSlot];
  const todColor = TOD_COLORS[todSlotInfo?.key] || "var(--accent)";
  const seasonColor = SEASON_COLORS[seasonSlotInfo?.key] || "var(--accent)";

  return (
    <div className="ctx-panel">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div className="section-label" style={{ margin: 0 }}>Context-aware recommendations</div>
          <div className="ctx-auto-badge">
            <span style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--green)", display: "inline-block" }} />
            New
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button className="btn btn-ghost btn-sm" onClick={applyAuto} title="Use current real time">
            ⟳ Use current time
          </button>
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontFamily: "var(--mono)", fontSize: 12, color: "var(--muted)" }}>
            <div
              onClick={() => setContextEnabled(v => !v)}
              style={{
                width: 36, height: 20, borderRadius: 10, background: contextEnabled ? "var(--green)" : "var(--surface)", border: `1px solid ${contextEnabled ? "var(--green)" : "var(--border2)"}`,
                position: "relative", cursor: "pointer", transition: "all .2s", flexShrink: 0
              }}
            >
              <div style={{
                width: 14, height: 14, borderRadius: 7, background: "#fff", position: "absolute", top: 2,
                left: contextEnabled ? 19 : 2, transition: "left .2s"
              }} />
            </div>
            {contextEnabled ? "ON" : "OFF"}
          </label>
        </div>
      </div>

      {contextEnabled && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, marginBottom: 20 }}>
            {/* Time of Day */}
            <div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--muted)", marginBottom: 10, letterSpacing: ".08em", textTransform: "uppercase" }}>
                Time of Day
                <span style={{ marginLeft: 8, color: todColor, fontStyle: "normal" }}>— {todSlotInfo?.label}</span>
              </div>
              <div className="ctx-slot-grid">
                {TOD_SLOTS.map((s, i) => (
                  <div
                    key={s.key}
                    className={`ctx-slot${todSlot === i ? " active" : ""}`}
                    style={{ "--slot-color": TOD_COLORS[s.key] }}
                    onClick={() => setTodSlot(i)}
                  >
                    <span className="ctx-slot-icon">{s.icon}</span>
                    <span className="ctx-slot-label" style={{ color: todSlot === i ? TOD_COLORS[s.key] : undefined }}>{s.label}</span>
                    <span className="ctx-slot-hours">{s.hours}</span>
                  </div>
                ))}
              </div>
            </div>
            {/* Season */}
            <div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--muted)", marginBottom: 10, letterSpacing: ".08em", textTransform: "uppercase" }}>
                Season
                <span style={{ marginLeft: 8, color: seasonColor, fontStyle: "normal" }}>— {seasonSlotInfo?.label}</span>
              </div>
              <div className="ctx-slot-grid">
                {SEASON_SLOTS.map((s, i) => (
                  <div
                    key={s.key}
                    className={`ctx-slot${seasonSlot === i ? " active" : ""}`}
                    style={{ "--slot-color": SEASON_COLORS[s.key] }}
                    onClick={() => setSeasonSlot(i)}
                  >
                    <span className="ctx-slot-icon">{s.icon}</span>
                    <span className="ctx-slot-label" style={{ color: seasonSlot === i ? SEASON_COLORS[s.key] : undefined }}>{s.label}</span>
                    <span className="ctx-slot-hours">{s.months}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Bias strength sliders */}
          <div style={{ borderTop: "1px solid var(--border)", paddingTop: 18 }}>
            <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--muted)", marginBottom: 14, letterSpacing: ".08em", textTransform: "uppercase" }}>Bias strength</div>
            <div className="ctx-weight-row">
              <span className="ctx-weight-label">Time-of-Day</span>
              <input type="range" className="ctx-slider" min="0" max="0.5" step="0.05" value={todWeight}
                onChange={e => setTodWeight(parseFloat(e.target.value))} />
              <span className="ctx-weight-val">{todWeight.toFixed(2)}</span>
            </div>
            <div className="ctx-weight-row">
              <span className="ctx-weight-label">Season</span>
              <input type="range" className="ctx-slider" min="0" max="0.5" step="0.05" value={seasonWeight}
                onChange={e => setSeasonWeight(parseFloat(e.target.value))} />
              <span className="ctx-weight-val">{seasonWeight.toFixed(2)}</span>
            </div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--muted)", marginTop: 10, lineHeight: 1.6 }}>
              Higher values shift rankings more toward the selected time slot.
              Tune if context feels too strong or too subtle.
            </div>
          </div>
        </>
      )}

      {!contextEnabled && (
        <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--muted)", lineHeight: 1.7, paddingTop: 4 }}>
          Enable to surface films that fit your current time of day and season —
          e.g. lighter comedies in the morning, thrillers at night, cozy dramas in winter.
        </div>
      )}
    </div>
  );
}

// ── Context Compare Panel ─────────────────────────────────────
function ContextComparePanel({ baseRecs, ctxRecs, movies, ctxLabel }) {
  if (!baseRecs?.length || !ctxRecs?.length) return null;

  const baseOrder = {};
  baseRecs.forEach((r, i) => { baseOrder[r.item_id] = i + 1; });

  const rows = ctxRecs.slice(0, 10).map((r, i) => {
    const baseRank = baseOrder[r.item_id];
    const ctxRank = i + 1;
    const isNew = baseRank === undefined;
    const delta = isNew ? null : baseRank - ctxRank;
    const m = movies?.[String(r.item_id)];
    return { r, m, ctxRank, baseRank, delta, isNew };
  });

  const changed = rows.filter(row => row.delta !== 0 || row.isNew).length;

  return (
    <div className="ctx-compare fade-up">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--muted)", letterSpacing: ".08em", textTransform: "uppercase" }}>
          Rank shifts · {ctxLabel}
        </div>
        <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: changed > 0 ? "var(--accent)" : "var(--muted)" }}>
          {changed}/{rows.length} positions shifted
        </div>
      </div>
      {rows.map(({ r, m, ctxRank, baseRank, delta, isNew }) => {
        let deltaEl;
        if (isNew) deltaEl = <span className="ctx-delta new">new entry</span>;
        else if (delta > 0) deltaEl = <span className="ctx-delta up">↑ {delta}</span>;
        else if (delta < 0) deltaEl = <span className="ctx-delta down">↓ {Math.abs(delta)}</span>;
        else deltaEl = <span className="ctx-delta same">—</span>;
        return (
          <div key={r.item_id} className="ctx-compare-row">
            <span className="ctx-rank">#{ctxRank}</span>
            <span className="ctx-item-title">{m?.title || `#${r.item_id}`}</span>
            {m?.genres?.[0] && <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: gcolor(m.genres), flexShrink: 0 }}>{m.genres[0]}</span>}
            {deltaEl}
          </div>
        );
      })}
      <div style={{ marginTop: 12, fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)", lineHeight: 1.6, borderTop: "1px solid var(--border)", paddingTop: 10 }}>
        Arrows show rank movement vs. base recommendations. "New entry" = item not present in base top-10.
      </div>
    </div>
  );
}

// ── Charts ────────────────────────────────────────────────────
function GenreRadar({ picked, movies }) {
  const ref = useRef(null); const chartRef = useRef(null);
  const data = useMemo(() => {
    const freq = {};
    picked.forEach(p => { const id = p.idx ?? p; (movies?.[String(id)]?.genres || []).forEach(g => { freq[g] = (freq[g] || 0) + 1; }); });
    return Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 8);
  }, [picked, movies]);
  useEffect(() => {
    if (!ref.current || data.length < 3) return;
    if (chartRef.current) chartRef.current.destroy();
    chartRef.current = new Chart(ref.current, { type: "radar", data: { labels: data.map(([g]) => g), datasets: [{ data: data.map(([, v]) => v), backgroundColor: "rgba(201,168,76,0.12)", borderColor: "rgba(201,168,76,0.8)", borderWidth: 2, pointBackgroundColor: "rgba(201,168,76,1)", pointBorderColor: "transparent", pointRadius: 4, pointHoverRadius: 6 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { backgroundColor: "#16161f", borderColor: "#ffffff1a", borderWidth: 1, titleColor: "#f0f0f5", bodyColor: "#c9a84c", padding: 10 } }, scales: { r: { backgroundColor: "transparent", grid: { color: "#ffffff0c" }, angleLines: { color: "#ffffff0c" }, ticks: { display: false, stepSize: 1 }, pointLabels: { color: "#9494aa", font: { family: "DM Mono", size: 11 } } } } } });
    return () => chartRef.current?.destroy();
  }, [data]);
  if (data.length < 3) return null;
  return <div className="chart-box"><div className="chart-title">Genre profile — taste map</div><div style={{ height: 220 }}><canvas ref={ref} /></div></div>;
}
function AttentionChart({ influence, movies }) {
  const ref = useRef(null); const chartRef = useRef(null);
  useEffect(() => {
    if (!ref.current || !influence?.length) return;
    if (chartRef.current) chartRef.current.destroy();
    const top = [...influence].sort((a, b) => b.attention - a.attention).slice(0, 8);
    const labels = top.map(d => { const t = movies?.[String(d.item_id)]?.title || `#${d.item_id}`; return t.length > 20 ? t.slice(0, 18) + "…" : t; });
    const colors = top.map(d => gcolor(movies?.[String(d.item_id)]?.genres));
    chartRef.current = new Chart(ref.current, { type: "bar", data: { labels, datasets: [{ data: top.map(d => Math.round(d.attention * 100)), backgroundColor: colors.map(c => c + "77"), borderColor: colors, borderWidth: 1.5, borderRadius: 8 }] }, options: { indexAxis: "y", responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ` ${ctx.parsed.x}% attention weight` }, backgroundColor: "#16161f", borderColor: "#ffffff1a", borderWidth: 1, titleColor: "#f0f0f5", bodyColor: "#c9a84c", padding: 10 } }, scales: { x: { grid: { color: "#ffffff06" }, ticks: { color: "#6b6b80", font: { family: "DM Mono", size: 11 }, callback: v => `${v}%` }, border: { display: false } }, y: { grid: { display: false }, ticks: { color: "#f0f0f5", font: { family: "DM Sans", size: 12 } }, border: { display: false } } } } });
    return () => chartRef.current?.destroy();
  }, [influence, movies]);
  return <div className="chart-box"><div className="chart-title">Transformer attention weights</div><div style={{ height: Math.min(influence?.length || 6, 8) * 44 + 20 }}><canvas ref={ref} /></div></div>;
}
function GateChart({ gates }) {
  const ref = useRef(null); const chartRef = useRef(null);
  useEffect(() => {
    if (!ref.current || !gates) return;
    if (chartRef.current) chartRef.current.destroy();
    chartRef.current = new Chart(ref.current, { type: "doughnut", data: { labels: ["Collaborative (GCN)", "Long-term Memory", "Sequential"], datasets: [{ data: [Math.round(gates.gcn * 100), Math.round(gates.memory * 100), Math.round(gates.seq * 100)], backgroundColor: ["#5b8dee1a", "#4caf821a", "#c9a84c1a"], borderColor: ["#5b8dee", "#4caf82", "#c9a84c"], borderWidth: 2, hoverBackgroundColor: ["#5b8dee33", "#4caf8233", "#c9a84c33"], hoverOffset: 8 }] }, options: { responsive: true, maintainAspectRatio: false, cutout: "72%", plugins: { legend: { position: "bottom", labels: { color: "#6b6b80", font: { family: "DM Mono", size: 11 }, padding: 16, boxWidth: 10, boxHeight: 10, borderRadius: 5 } }, tooltip: { callbacks: { label: ctx => ` ${ctx.parsed}% contribution` }, backgroundColor: "#16161f", borderColor: "#ffffff1a", borderWidth: 1, titleColor: "#f0f0f5", bodyColor: "#c9a84c", padding: 10 } } } });
    return () => chartRef.current?.destroy();
  }, [gates]);
  return <div className="chart-box"><div className="chart-title">Model component blend</div><div style={{ height: 240 }}><canvas ref={ref} /></div></div>;
}
function ScoreChart({ recommendations, movies }) {
  const ref = useRef(null); const chartRef = useRef(null);
  useEffect(() => {
    if (!ref.current || !recommendations?.length) return;
    if (chartRef.current) chartRef.current.destroy();
    const top10 = recommendations.slice(0, 10);
    const labels = top10.map(r => { const t = movies?.[String(r.item_id)]?.title || `#${r.item_id}`; return t.length > 16 ? t.slice(0, 14) + "…" : t; });
    const colors = top10.map(r => gcolor(movies?.[String(r.item_id)]?.genres));
    chartRef.current = new Chart(ref.current, { type: "bar", data: { labels, datasets: [{ label: "Relevance score", data: top10.map(r => r.score?.toFixed ? parseFloat(r.score.toFixed(3)) : r.score), backgroundColor: colors.map(c => c + "55"), borderColor: colors, borderWidth: 1.5, borderRadius: 8, borderSkipped: false }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { backgroundColor: "#16161f", borderColor: "#ffffff1a", borderWidth: 1, titleColor: "#f0f0f5", bodyColor: "#c9a84c", padding: 10 } }, scales: { x: { grid: { display: false }, ticks: { color: "#6b6b8088", font: { family: "DM Sans", size: 11 }, maxRotation: 40 }, border: { display: false } }, y: { grid: { color: "#ffffff06" }, ticks: { color: "#6b6b80", font: { family: "DM Mono", size: 11 } }, border: { display: false } } } } });
    return () => chartRef.current?.destroy();
  }, [recommendations, movies]);
  return <div className="chart-box"><div className="chart-title">Relevance scores — top 10</div><div style={{ height: 210 }}><canvas ref={ref} /></div></div>;
}
function RecGenreChart({ recommendations, movies }) {
  const ref = useRef(null); const chartRef = useRef(null);
  useEffect(() => {
    if (!ref.current || !recommendations?.length) return;
    if (chartRef.current) chartRef.current.destroy();
    const freq = {};
    recommendations.forEach(r => { const g = movies?.[String(r.item_id)]?.genres?.[0] || "Unknown"; freq[g] = (freq[g] || 0) + 1; });
    const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]);
    chartRef.current = new Chart(ref.current, { type: "polarArea", data: { labels: sorted.map(([g]) => g), datasets: [{ data: sorted.map(([, v]) => v), backgroundColor: sorted.map(([g]) => (GENRE_COLORS[g] || "#888") + "44"), borderColor: sorted.map(([g]) => GENRE_COLORS[g] || "#888"), borderWidth: 1.5 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "right", labels: { color: "#6b6b80", font: { family: "DM Mono", size: 11 }, padding: 12, boxWidth: 10, boxHeight: 10 } }, tooltip: { backgroundColor: "#16161f", borderColor: "#ffffff1a", borderWidth: 1, titleColor: "#f0f0f5", bodyColor: "#c9a84c", padding: 10 } }, scales: { r: { grid: { color: "#ffffff08" }, ticks: { display: false } } } } });
    return () => chartRef.current?.destroy();
  }, [recommendations, movies]);
  return <div className="chart-box"><div className="chart-title">Recommendation genre spread</div><div style={{ height: 220 }}><canvas ref={ref} /></div></div>;
}
function ScoreCurveChart({ recommendations, movies }) {
  const ref = useRef(null); const chartRef = useRef(null);
  useEffect(() => {
    if (!ref.current || !recommendations?.length) return;
    if (chartRef.current) chartRef.current.destroy();
    const pts = recommendations.slice(0, 15);
    chartRef.current = new Chart(ref.current, { type: "line", data: { labels: pts.map((_, i) => `#${i + 1}`), datasets: [{ data: pts.map(r => r.score?.toFixed ? parseFloat(r.score.toFixed(4)) : r.score), fill: true, backgroundColor: "rgba(201,168,76,0.08)", borderColor: "rgba(201,168,76,0.9)", borderWidth: 2, pointBackgroundColor: "rgba(201,168,76,1)", pointRadius: 4, pointHoverRadius: 7, tension: 0.45 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { title: ctx => { const r = recommendations[ctx[0].dataIndex]; return movies?.[String(r.item_id)]?.title || `#${r.item_id}`; }, label: ctx => ` Score: ${ctx.parsed.y}` }, backgroundColor: "#16161f", borderColor: "#ffffff1a", borderWidth: 1, titleColor: "#f0f0f5", bodyColor: "#c9a84c", padding: 10 } }, scales: { x: { grid: { display: false }, ticks: { color: "#6b6b80", font: { family: "DM Mono", size: 11 } }, border: { display: false } }, y: { grid: { color: "#ffffff06" }, ticks: { color: "#6b6b80", font: { family: "DM Mono", size: 11 } }, border: { display: false } } } } });
    return () => chartRef.current?.destroy();
  }, [recommendations, movies]);
  return <div className="chart-box"><div className="chart-title">Score decay curve</div><div style={{ height: 180 }}><canvas ref={ref} /></div></div>;
}

// ── Context Score Comparison Chart ───────────────────────────
function ContextScoreChart({ baseRecs, ctxRecs, movies, ctxColor }) {
  const ref = useRef(null); const chartRef = useRef(null);
  useEffect(() => {
    if (!ref.current || !baseRecs?.length || !ctxRecs?.length) return;
    if (chartRef.current) chartRef.current.destroy();

    const allIds = [...new Set([...ctxRecs.slice(0, 8).map(r => r.item_id), ...baseRecs.slice(0, 8).map(r => r.item_id)])].slice(0, 8);
    const baseMap = {}; baseRecs.forEach(r => { baseMap[r.item_id] = r.score; });
    const ctxMap = {}; ctxRecs.forEach(r => { ctxMap[r.item_id] = r.score; });

    const labels = allIds.map(id => { const t = movies?.[String(id)]?.title || `#${id}`; return t.length > 14 ? t.slice(0, 12) + "…" : t; });

    chartRef.current = new Chart(ref.current, {
      type: "bar",
      data: {
        labels,
        datasets: [
          { label: "Base", data: allIds.map(id => baseMap[id] != null ? parseFloat((baseMap[id]).toFixed(3)) : 0), backgroundColor: "#888780aa", borderColor: "#888780", borderWidth: 1.5, borderRadius: 4 },
          { label: "Context", data: allIds.map(id => ctxMap[id] != null ? parseFloat((ctxMap[id]).toFixed(3)) : 0), backgroundColor: ctxColor + "88", borderColor: ctxColor, borderWidth: 1.5, borderRadius: 4 },
        ]
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "top", labels: { color: "#9494aa", font: { family: "DM Mono", size: 11 }, padding: 14, boxWidth: 10, boxHeight: 10 } }, tooltip: { backgroundColor: "#16161f", borderColor: "#ffffff1a", borderWidth: 1, titleColor: "#f0f0f5", bodyColor: "#c9a84c", padding: 10 } }, scales: { x: { grid: { display: false }, ticks: { color: "#6b6b8088", font: { family: "DM Sans", size: 11 }, maxRotation: 35 }, border: { display: false } }, y: { grid: { color: "#ffffff06" }, ticks: { color: "#6b6b80", font: { family: "DM Mono", size: 11 } }, border: { display: false } } } }
    });
    return () => chartRef.current?.destroy();
  }, [baseRecs, ctxRecs, movies, ctxColor]);
  return <div className="chart-box"><div className="chart-title">Base vs context scores</div><div style={{ height: 210 }}><canvas ref={ref} /></div></div>;
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
          <div className="gate-bar-wrap"><div className="gate-bar" style={{ width: `${Math.round(val * 100)}%`, background: `linear-gradient(90deg,${color}88,${color})` }} /></div>
          <div className="gate-pct" style={{ color, fontFamily: "var(--mono)", fontSize: 12 }}>{Math.round(val * 100)}%</div>
        </div>
      ))}
    </div>
  );
}

// ── Arc Gauge ─────────────────────────────────────────────────
function ArcGauge({ value, color, size = 88 }) {
  const r = 36, cx = 48, cy = 48, circ = 2 * Math.PI * r;
  const filled = circ * Math.min(value, 1);
  return (
    <svg viewBox="0 0 96 96" width={size} height={size} style={{ overflow: "visible", display: "block" }}>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="#ffffff09" strokeWidth={7} />
      <circle cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth={7}
        strokeDasharray={`${filled} ${circ - filled}`} strokeDashoffset={circ * 0.25} strokeLinecap="round"
        style={{ transition: "stroke-dasharray 1.6s cubic-bezier(.2,.8,.4,1)" }} />
      <text x={cx} y={cy + 2} textAnchor="middle" dominantBaseline="middle" fill="#f0f0f5" fontSize="14" fontFamily="'Playfair Display',serif" fontWeight="700">
        {(value * 100).toFixed(1)}%
      </text>
    </svg>
  );
}

function MetricGaugeCard({ label, k, value, color, colorClass, description }) {
  const pct = Math.min(value, 1);
  const getQuality = (lbl, v) => {
    const ranges = { HR: { great: 0.42, good: 0.35, ok: 0.25 }, NDCG: { great: 0.28, good: 0.22, ok: 0.15 }, MRR: { great: 0.22, good: 0.16, ok: 0.10 } };
    const r = ranges[lbl];
    if (!r) return { label: "", color: "var(--muted)" };
    if (v >= r.great) return { label: "Excellent", color: "#4caf82" };
    if (v >= r.good) return { label: "Good", color: "#c9a84c" };
    if (v >= r.ok) return { label: "Fair", color: "#5b8dee" };
    return { label: "Training", color: "#9b72ef" };
  };
  const quality = getQuality(label, value);
  return (
    <div className={`gauge-card ${colorClass}`} style={{ flex: 1, minWidth: 160 }}>
      <ArcGauge value={pct} color={color} size={88} />
      <div style={{ textAlign: "center" }}>
        <div style={{ fontFamily: "var(--mono)", fontSize: 13, color, letterSpacing: ".06em" }}>{label}@{k}</div>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 4, marginTop: 6, padding: "2px 10px", borderRadius: 20, border: `1px solid ${quality.color}33`, background: `${quality.color}0d`, fontFamily: "var(--mono)", fontSize: 10, color: quality.color }}>{quality.label}</div>
      </div>
      <div className="quality-bar-wrap"><div className="quality-bar" style={{ width: `${pct * 100}%`, background: `linear-gradient(90deg,${color}66,${color})` }} /></div>
      <div className="gauge-desc">{description}</div>
    </div>
  );
}

function ModelMetrics({ testMetrics }) {
  if (!testMetrics) return null;
  const k = parseInt(Object.keys(testMetrics).find(key => key.startsWith("HR@"))?.split("@")[1] || "10");
  const hr = testMetrics[`HR@${k}`] ?? null, ndcg = testMetrics[`NDCG@${k}`] ?? null, mrr = testMetrics[`MRR@${k}`] ?? null;
  if (hr === null && ndcg === null && mrr === null) return null;
  const gauges = [
    hr !== null && { label: "HR", k, value: hr, color: "#4caf82", colorClass: "green", description: "Fraction of users whose true next item appeared in top-K" },
    ndcg !== null && { label: "NDCG", k, value: ndcg, color: "#c9a84c", colorClass: "amber", description: "Position-sensitive — rewards finding the right item at higher rank" },
    mrr !== null && { label: "MRR", k, value: mrr, color: "#5b8dee", colorClass: "blue", description: "Mean reciprocal rank of the first relevant item" },
  ].filter(Boolean);
  return (
    <section className="fade-up" style={{ animationDelay: ".07s" }}>
      <div className="section-label">Evaluation metrics</div>
      <div style={{ background: "linear-gradient(135deg,var(--card) 0%,var(--card2) 100%)", border: "1px solid var(--border2)", borderRadius: "var(--radius-lg)", padding: "28px 28px 24px", position: "relative", overflow: "hidden" }}>
        <div style={{ position: "absolute", top: -60, right: -60, width: 240, height: 240, background: "radial-gradient(circle,#4caf8208,transparent 70%)", pointerEvents: "none" }} />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24, flexWrap: "wrap", gap: 10 }}>
          <div>
            <div style={{ fontFamily: "var(--serif)", fontSize: 17, fontWeight: 700, color: "var(--text)" }}>Held-out test set performance</div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--muted)", marginTop: 4 }}>Sampled evaluation · 99 negatives per user · MovieLens 1M</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 14px", background: "var(--surface)", border: "1px solid var(--border2)", borderRadius: 20, fontFamily: "var(--mono)", fontSize: 11, color: "var(--muted2)" }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#4caf82", display: "inline-block" }} /> Top-{k} evaluation
          </div>
        </div>
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
          {gauges.map(g => <MetricGaugeCard key={g.label} {...g} />)}
        </div>
        <div style={{ marginTop: 22, paddingTop: 18, borderTop: "1px solid var(--border)", display: "flex", alignItems: "flex-start", gap: 10, fontSize: 12, color: "var(--muted)", fontFamily: "var(--mono)", lineHeight: 1.65 }}>
          <span style={{ color: "var(--accent)", flexShrink: 0 }}>ℹ</span>
          <span>Global test-set metrics from training. To refresh, run Cell 13 and call <code style={{ fontFamily: "var(--mono)", fontSize: 11, background: "#ffffff0a", padding: "1px 6px", borderRadius: 4 }}>save_bundle_now(test_metrics=test_metrics)</code>.</span>
        </div>
      </div>
    </section>
  );
}

// ── Stats + Timeline ──────────────────────────────────────────
function StatsRow({ picked, recommendations, movies, expData, contextEnabled, todSlot, seasonSlot }) {
  const avgYear = useMemo(() => {
    const ids = picked.map(p => p.idx ?? p);
    const years = ids.map(i => movies?.[String(i)]?.year).filter(Boolean);
    if (!years.length) return null;
    return Math.round(years.reduce((a, b) => a + b, 0) / years.length);
  }, [picked, movies]);
  const genres = useMemo(() => {
    const freq = {};
    picked.map(p => p.idx ?? p).forEach(i => { (movies?.[String(i)]?.genres || []).forEach(g => { freq[g] = (freq[g] || 0) + 1; }); });
    return Object.entries(freq).sort((a, b) => b[1] - a[1]);
  }, [picked, movies]);
  const topGate = useMemo(() => {
    if (!expData?.component_weights) return null;
    const g = expData.component_weights;
    if (g.gcn >= g.memory && g.gcn >= g.seq) return { label: "Collaborative", color: "#5b8dee" };
    if (g.memory >= g.seq) return { label: "Memory-driven", color: "#4caf82" };
    return { label: "Sequential", color: "#c9a84c" };
  }, [expData]);

  const todInfo = contextEnabled && todSlot != null ? TOD_SLOTS[todSlot] : null;
  const seasonInfo = contextEnabled && seasonSlot != null ? SEASON_SLOTS[seasonSlot] : null;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 12, marginBottom: 36 }} className="fade-up">
      <div className="stat-card"><div className="stat-value">{recommendations?.length || 0}</div><div className="stat-label">Picks generated</div></div>
      <div className="stat-card"><div className="stat-value">{picked.length}</div><div className="stat-label">History films</div></div>
      {avgYear && <div className="stat-card"><div className="stat-value">{avgYear}</div><div className="stat-label">Avg watch year</div></div>}
      {genres[0] && <div className="stat-card"><div className="stat-value" style={{ fontSize: "1.3rem", color: gcolor([genres[0][0]]) }}>{genres[0][0]}</div><div className="stat-label">Top genre</div><div className="stat-sub">{genres.length} genres total</div></div>}
      {topGate && <div className="stat-card"><div className="stat-value" style={{ fontSize: "1rem", color: topGate.color, marginTop: 4 }}>{topGate.label}</div><div className="stat-label">Dominant signal</div></div>}
      {todInfo && <div className="stat-card" style={{ borderColor: TOD_COLORS[todInfo.key] + "44" }}><div className="stat-value" style={{ fontSize: "1.4rem" }}>{todInfo.icon}</div><div className="stat-label" style={{ color: TOD_COLORS[todInfo.key] }}>{todInfo.label} mode</div><div className="stat-sub">{todInfo.hours}</div></div>}
      {seasonInfo && <div className="stat-card" style={{ borderColor: SEASON_COLORS[seasonInfo.key] + "44" }}><div className="stat-value" style={{ fontSize: "1.4rem" }}>{seasonInfo.icon}</div><div className="stat-label" style={{ color: SEASON_COLORS[seasonInfo.key] }}>{seasonInfo.label} picks</div><div className="stat-sub">{seasonInfo.months}</div></div>}
    </div>
  );
}

function HistoryTimeline({ picked, movies, cache, onNeeded, influence }) {
  const attnMap = useMemo(() => { const m = {}; (influence || []).forEach(d => { m[d.item_id] = d.attention; }); return m; }, [influence]);
  const items = picked.map(p => ({ idx: p.idx ?? p }));
  return (
    <div style={{ marginBottom: 28 }}>
      <div className="section-label">Viewing history sequence</div>
      <div className="timeline-track">
        {items.map((p, i) => {
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
              {attn !== undefined
                ? <div className="tl-idx" style={{ color: isActive ? "var(--accent)" : "var(--muted)" }}>{Math.round(attn * 100)}%</div>
                : <div className="tl-idx">#{i + 1}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Language Toggle ───────────────────────────────────────────
function LangToggle({ lang, onChange, loadingLang }) {
  return (
    <div className="lang-toggle" title="Toggle explanation language">
      <button className={`lang-btn en${lang === "en" ? " active" : ""}`} onClick={() => onChange("en")} disabled={loadingLang === "en"} aria-label="English">
        {loadingLang === "en" ? "…" : "EN"}
      </button>
      <button className={`lang-btn ar${lang === "ar" ? " active" : ""}`} onClick={() => onChange("ar")} disabled={loadingLang === "ar"} aria-label="العربية">
        {loadingLang === "ar" ? "…" : "العربية"}
      </button>
    </div>
  );
}

// ── Explanation Panel ─────────────────────────────────────────
function ExplanationPanel({ picked, recData, expData, movies, requestKey, todSlot, seasonSlot, contextEnabled }) {
  const [lang, setLang] = useState("en");
  const [texts, setTexts] = useState({ en: null, ar: null });
  const [loadingLang, setLoadingLang] = useState(null);
  const [noApiKey] = useState(GEMINI_API_KEY === "YOUR_GEMINI_API_KEY_HERE");
  const genRef = useRef(0);

  const payload = useMemo(() => ({
    picked,
    recommendations: recData?.recommendations || [],
    movies,
    gates: expData?.component_weights ?? null,
    historyInfluence: expData?.history_influence ?? [],
    shapNorm: expData?.shap_norm ?? null,
    todSlot: contextEnabled ? todSlot : null,
    seasonSlot: contextEnabled ? seasonSlot : null,
  }), [requestKey]);

  useEffect(() => {
    if (!recData?.recommendations?.length || !picked?.length) return;
    if (noApiKey) return;
    const id = ++genRef.current;
    setTexts({ en: null, ar: null });
    setLoadingLang("en");
    generateGeminiExplanation({ ...payload, lang: "en" }).then(text => {
      if (genRef.current !== id) return;
      setTexts(t => ({ ...t, en: text }));
      setLoadingLang(null);
    });
  }, [requestKey]);

  const handleLangChange = async (newLang) => {
    setLang(newLang);
    if (newLang === "ar" && !texts.ar && !noApiKey) {
      setLoadingLang("ar");
      const text = await generateGeminiExplanation({ ...payload, lang: "ar" });
      setTexts(t => ({ ...t, ar: text }));
      setLoadingLang(null);
    }
  };

  const topDriver = expData?.history_influence?.[0];
  const topTitle = topDriver ? movies[String(topDriver.item_id)]?.title : null;

  const classified = useMemo(() =>
    (expData?.history_influence || []).slice(0, 5).map(d => {
      const attn = d.attention ?? 0;
      const shap = expData?.shap_norm?.[d.position] ?? null;
      const isKey = attn >= 0.1;
      const isHidden = shap !== null && shap >= 0.1 && !isKey;
      return { ...d, isKey, isHidden };
    }),
    [expData]
  );

  const isArabic = lang === "ar";
  const currentText = isArabic ? texts.ar : texts.en;
  const isLoading = loadingLang === lang || (lang === "en" && !texts.en && !noApiKey);

  const todInfo = contextEnabled && todSlot != null ? TOD_SLOTS[todSlot] : null;
  const seasonInfo = contextEnabled && seasonSlot != null ? SEASON_SLOTS[seasonSlot] : null;

  if (!recData?.recommendations?.length) return null;

  return (
    <section className="fade-up exp-card">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
        <div className="section-label" style={{ margin: 0 }}>
          {isArabic ? "لماذا هذه الأفلام" : "Why these films"}
          {topTitle && (
            <span style={{ color: "var(--accent)", marginLeft: isArabic ? 0 : 4, marginRight: isArabic ? 4 : 0, fontFamily: "var(--sans)", fontSize: 11, fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>
              {isArabic ? `· بتأثير ${topTitle}` : `· anchored by ${topTitle}`}
            </span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          {todInfo && (
            <div style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 10px", borderRadius: 20, border: `1px solid ${TOD_COLORS[todInfo.key]}44`, background: TOD_COLORS[todInfo.key] + "12", fontFamily: "var(--mono)", fontSize: 10, color: TOD_COLORS[todInfo.key] }}>
              {todInfo.icon} {todInfo.label}
            </div>
          )}
          {seasonInfo && (
            <div style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 10px", borderRadius: 20, border: `1px solid ${SEASON_COLORS[seasonInfo.key]}44`, background: SEASON_COLORS[seasonInfo.key] + "12", fontFamily: "var(--mono)", fontSize: 10, color: SEASON_COLORS[seasonInfo.key] }}>
              {seasonInfo.icon} {seasonInfo.label}
            </div>
          )}
          <div className="gemini-badge"><div className="gemini-dot" />Gemini 2.0 Flash</div>
          <LangToggle lang={lang} onChange={handleLangChange} loadingLang={loadingLang} />
        </div>
      </div>

      {noApiKey && (
        <div className="apikey-notice">
          <strong>🔑 Add your free Gemini API key</strong> to enable AI-powered explanations.<br />
          Get one free at <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer">aistudio.google.com</a>, then replace <code>YOUR_GEMINI_API_KEY_HERE</code> at the top of this file.
        </div>
      )}

      {isLoading && !noApiKey && (
        <div className="exp-skeleton">
          <div className="exp-skeleton-line" style={{ width: "95%" }} />
          <div className="exp-skeleton-line" style={{ width: "88%" }} />
          <div className="exp-skeleton-line" style={{ width: "92%" }} />
          <div className="exp-skeleton-line" style={{ width: "70%" }} />
          <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8 }}>
            <div className="exp-typing-dots">
              <div className="exp-typing-dot" /><div className="exp-typing-dot" /><div className="exp-typing-dot" />
            </div>
            <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--muted)" }}>
              {todInfo ? `Gemini is tuning for ${todInfo.label} ${seasonInfo ? `/ ${seasonInfo.label}` : ""}…` : "Gemini is reading your taste profile…"}
            </span>
          </div>
        </div>
      )}

      {currentText && !isLoading && (
        <p key={`${lang}-${requestKey}`} className={`exp-paragraph${isArabic ? " arabic" : ""}`} style={isArabic ? { textAlign: "right", direction: "rtl" } : {}}>
          {currentText}
        </p>
      )}

      {classified.length > 0 && (
        <div style={{ marginTop: 24, display: "flex", gap: 8, flexWrap: "wrap", ...(isArabic ? { flexDirection: "row-reverse" } : {}) }}>
          {classified.map(d => {
            const m = movies[String(d.item_id)];
            const title = m?.title ? (m.title.length > 18 ? m.title.slice(0, 16) + "…" : m.title) : `#${d.item_id}`;
            return (
              <div key={d.item_id} className={`inf-chip${d.isKey ? " confirmed" : d.isHidden ? " hidden-influence" : ""}`}>
                <span style={{ color: "var(--text)", fontFamily: "var(--sans)", fontSize: 12 }}>{title}</span>
                <span style={{ color: "var(--muted)" }}>·</span>
                <span>{Math.round(d.attention * 100)}%</span>
                {d.isKey && <span style={{ fontSize: 10 }}>✦</span>}
                {d.isHidden && <span style={{ fontSize: 10 }} title="High SHAP, low attention — hidden influence">◈</span>}
              </div>
            );
          })}
        </div>
      )}

      <div style={{ marginTop: 20, paddingTop: 16, borderTop: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 8, ...(isArabic ? { flexDirection: "row-reverse", direction: "rtl" } : {}) }}>
        <span style={{ fontSize: 10, color: "var(--muted)", fontFamily: isArabic ? "var(--arabic)" : "var(--mono)" }}>
          {isArabic
            ? "التفسير مولَّد بواسطة Gemini 2.0 Flash استناداً إلى بيانات الانتباه والـ SHAP"
            : "AI explanation generated by Gemini 2.0 Flash from attention weights and SHAP values"}
        </span>
        <span style={{ width: 4, height: 4, borderRadius: "50%", background: "var(--accent)", opacity: 0.4, display: "inline-block", flexShrink: 0 }} />
        <span style={{ fontSize: 10, color: "var(--muted)", fontFamily: "var(--mono)" }}>GCN · Memory · Transformer{contextEnabled ? " · Context" : ""}</span>
      </div>
    </section>
  );
}

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
      <span style={{ flex: "none", fontSize: 16 }}>⚠</span><span>{msg}</span>
    </div>
  );
}

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

// ── Shared results block ──────────────────────────────────────
function ResultsBlock({ pickedIds, recData, baseRecData, expData, movies, cache, loadPoster, requestKey, status, contextEnabled, todSlot, seasonSlot }) {
  const pickedNorm = useMemo(() => pickedIds.map(p => (typeof p === "object" ? p : { idx: p })), [pickedIds]);

  const todInfo = contextEnabled && todSlot != null ? TOD_SLOTS[todSlot] : null;
  const seasonInfo = contextEnabled && seasonSlot != null ? SEASON_SLOTS[seasonSlot] : null;
  const ctxColor = todInfo ? TOD_COLORS[todInfo.key] : "var(--accent)";
  const ctxLabel = todInfo ? `${todInfo.icon} ${todInfo.label}${seasonInfo ? ` · ${seasonInfo.icon} ${seasonInfo.label}` : ""}` : null;

  const boostedIds = useMemo(() => {
    if (!contextEnabled || !baseRecData?.recommendations || !recData?.recommendations) return new Set();
    const baseMap = {};
    baseRecData.recommendations.forEach((r, i) => { baseMap[r.item_id] = i; });
    const boosted = new Set();
    recData.recommendations.forEach((r, ctxRank) => {
      const baseRank = baseMap[r.item_id];
      if (baseRank === undefined || ctxRank < baseRank) boosted.add(r.item_id);
    });
    return boosted;
  }, [contextEnabled, baseRecData, recData]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 44 }}>
      <StatsRow picked={pickedNorm} recommendations={recData.recommendations} movies={movies} expData={expData}
        contextEnabled={contextEnabled} todSlot={todSlot} seasonSlot={seasonSlot} />
      <ModelMetrics testMetrics={status?.test_metrics} />

      {pickedNorm.length > 0 && (
        <div className="fade-up" style={{ animationDelay: ".05s" }}>
          <HistoryTimeline picked={pickedNorm} movies={movies} cache={cache} onNeeded={loadPoster} influence={expData?.history_influence} />
        </div>
      )}

      <section className="fade-up" style={{ animationDelay: ".1s" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <div className="section-label" style={{ margin: 0 }}>
            {contextEnabled && ctxLabel ? `Recommended for you · ${ctxLabel}` : "Recommended for you"}
          </div>
          {contextEnabled && boostedIds.size > 0 && (
            <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: ctxColor, padding: "3px 10px", borderRadius: 20, border: `1px solid ${ctxColor}33`, background: ctxColor + "0d" }}>
              {boostedIds.size} boosted by context
            </div>
          )}
        </div>
        <div className="movie-grid-lg">
          {recData.recommendations.map((r, i) => (
            <MovieCard key={r.item_id} idx={r.item_id} movies={movies} cache={cache} onNeeded={loadPoster} rank={i + 1}
              isHit={recData.ground_truth != null && r.item_id === recData.ground_truth}
              ctxBoosted={contextEnabled && boostedIds.has(r.item_id)}
              ctxColor={ctxColor}
              ctxLabel={ctxLabel}
              delay={i * 0.04} showGenre />
          ))}
        </div>
      </section>

      {contextEnabled && baseRecData?.recommendations && (
        <section className="fade-up" style={{ animationDelay: ".12s" }}>
          <div className="section-label">Context shift analysis</div>
          <ContextComparePanel
            baseRecs={baseRecData.recommendations}
            ctxRecs={recData.recommendations}
            movies={movies}
            ctxLabel={ctxLabel}
          />
        </section>
      )}

      <ExplanationPanel key={requestKey} requestKey={requestKey} picked={pickedNorm} recData={recData} expData={expData}
        movies={movies} todSlot={todSlot} seasonSlot={seasonSlot} contextEnabled={contextEnabled} />

      {expData ? (
        <section className="fade-up" style={{ animationDelay: ".15s" }}>
          <div className="section-label">Model analytics</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 14, marginBottom: 14 }}>
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
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 14, marginBottom: 14 }}>
            <AttentionChart influence={expData.history_influence} movies={movies} />
            <RecGenreChart recommendations={recData.recommendations} movies={movies} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 14 }}>
            {contextEnabled && baseRecData?.recommendations
              ? <ContextScoreChart baseRecs={baseRecData.recommendations} ctxRecs={recData.recommendations} movies={movies} ctxColor={ctxColor} />
              : <ScoreChart recommendations={recData.recommendations} movies={movies} />
            }
            <ScoreCurveChart recommendations={recData.recommendations} movies={movies} />
          </div>
        </section>
      ) : (
        <section className="fade-up">
          <div className="section-label">Score distribution</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 14 }}>
            {contextEnabled && baseRecData?.recommendations
              ? <ContextScoreChart baseRecs={baseRecData.recommendations} ctxRecs={recData.recommendations} movies={movies} ctxColor={ctxColor} />
              : <ScoreChart recommendations={recData.recommendations} movies={movies} />
            }
            <ScoreCurveChart recommendations={recData.recommendations} movies={movies} />
          </div>
        </section>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
//  USER EXPLORER PAGE
// ══════════════════════════════════════════════════════════════
function UserGenreBars({ historyIds, movies }) {
  const data = useMemo(() => {
    const freq = {};
    historyIds.forEach(id => { (movies?.[String(id)]?.genres || []).forEach(g => { freq[g] = (freq[g] || 0) + 1; }); });
    const total = Object.values(freq).reduce((a, b) => a + b, 0) || 1;
    return Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([g, c]) => ({ genre: g, count: c, pct: c / total }));
  }, [historyIds, movies]);
  return (
    <div>
      {data.map(({ genre, count, pct }) => (
        <div key={genre} className="genre-bar-row">
          <div className="genre-bar-label" style={{ color: gcolor([genre]) }}>{genre}</div>
          <div className="genre-bar-track"><div className="genre-bar-fill" style={{ width: `${pct * 100}%`, background: gcolor([genre]) }} /></div>
          <div className="genre-bar-count">{count}</div>
        </div>
      ))}
    </div>
  );
}

function UserExplorerPage({ movies, cache, loadPoster, status, contextEnabled, todSlot, seasonSlot, todWeight, seasonWeight }) {
  const [userList, setUserList] = useState([]);
  const [totalUsers, setTotalUsers] = useState(0);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [offset, setOffset] = useState(0);
  const PAGE_SIZE = 50;

  const [selectedUser, setSelectedUser] = useState(null);
  const [userFilter, setUserFilter] = useState("");
  const [recData, setRecData] = useState(null);
  const [baseRecData, setBaseRecData] = useState(null);
  const [expData, setExpData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [requestKey, setRequestKey] = useState(0);
  const [topK, setTopK] = useState(10);
  const runId = useRef(0);

  const fetchUsers = useCallback(async (reset = false) => {
    setLoadingUsers(true);
    try {
      const off = reset ? 0 : offset;
      const data = await apiFetch(`/users?limit=${PAGE_SIZE}&offset=${off}`);
      if (reset) { setUserList(data.users || []); setOffset(PAGE_SIZE); }
      else { setUserList(p => [...p, ...(data.users || [])]); setOffset(o => o + PAGE_SIZE); }
      setTotalUsers(data.total || 0);
    } catch { }
    setLoadingUsers(false);
  }, [offset]);

  useEffect(() => { fetchUsers(true); }, []);

  const filteredUsers = useMemo(() => {
    if (!userFilter.trim()) return userList;
    return userList.filter(u => String(u).includes(userFilter.trim()));
  }, [userList, userFilter]);

  const selectUser = useCallback(async (userId, tk) => {
    const usedTopK = tk ?? topK;
    setSelectedUser(userId); setRecData(null); setBaseRecData(null); setExpData(null); setErr(null);
    const id = ++runId.current;
    setLoading(true);
    try {
      const [rec, exp] = await Promise.allSettled([
        apiFetch("/recommend", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user_id: userId, top_k: usedTopK }) }),
        apiFetch("/explain", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user_id: userId, top_k: usedTopK }) }),
      ]);
      if (runId.current !== id) return;
      if (rec.status === "fulfilled") {
        const baseRec = rec.value;
        setBaseRecData(baseRec);

        // ── Context recs: try backend first, fall back to client-side bias ──
        if (contextEnabled) {
          try {
            const ctxRec = await apiFetch("/recommend/context", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ user_id: userId, top_k: usedTopK, tod_slot: todSlot, season_slot: seasonSlot, tod_weight: todWeight, season_weight: seasonWeight })
            });
            if (runId.current !== id) return;
            setRecData(ctxRec);
          } catch {
            // Backend context endpoint unavailable — apply client-side genre bias
            setRecData({
              ...baseRec,
              recommendations: applyClientContextBias(
                baseRec.recommendations, movies, todSlot, seasonSlot, todWeight, seasonWeight
              ),
            });
          }
        } else {
          setRecData(baseRec);
        }
        setRequestKey(k => k + 1);
      } else {
        setErr(rec.reason?.message || "Recommendation failed");
      }
      if (exp.status === "fulfilled") setExpData(exp.value);
    } catch (e) { if (runId.current === id) setErr(e.message); }
    finally { if (runId.current === id) setLoading(false); }
  }, [topK, contextEnabled, todSlot, seasonSlot, todWeight, seasonWeight, movies]);

  const rerun = () => { if (selectedUser != null) selectUser(selectedUser, topK); };

  const userHistory = recData?.history || [];
  const groundTruth = recData?.ground_truth;
  const isHit = recData?.hit;

  const localRank = recData?.recommendations?.findIndex(r => r.item_id === groundTruth);
  const localNDCG = localRank !== undefined && localRank !== -1 ? (1 / Math.log2(localRank + 2)).toFixed(3) : "0.000";

  return (
    <div style={{ display: "flex", gap: 28, alignItems: "flex-start" }}>
      {/* Sidebar */}
      <div style={{ width: 240, flexShrink: 0, position: "sticky", top: 80, maxHeight: "calc(100vh - 96px)", overflowY: "auto", paddingRight: 2 }}>
        <div className="section-label">Choose a user</div>
        <div style={{ position: "relative", marginBottom: 12 }}>
          <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--muted)", fontSize: 13, pointerEvents: "none" }}>🔎</span>
          <input className="sidebar-search" value={userFilter} onChange={e => setUserFilter(e.target.value)} placeholder="Filter by ID…" />
        </div>
        <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)", marginBottom: 10 }}>
          {totalUsers.toLocaleString()} users · {filteredUsers.length} shown
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          {filteredUsers.map(uid => (
            <div key={uid} className={`user-chip${selectedUser === uid ? " active" : ""}`} onClick={() => selectUser(uid)}>
              <div><div className="user-chip-id">User {uid}</div></div>
              <div className="user-chip-arrow">{selectedUser === uid ? "●" : "›"}</div>
            </div>
          ))}
        </div>
        {loadingUsers && <div style={{ display: "flex", justifyContent: "center", padding: "14px 0" }}><div className="spinner" /></div>}
        {!loadingUsers && userList.length < totalUsers && !userFilter && (
          <button className="load-more-btn" onClick={() => fetchUsers(false)}>Load more ↓</button>
        )}
      </div>

      {/* Main panel */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {!selectedUser && !loading && (
          <div style={{ textAlign: "center", padding: "80px 0", color: "var(--muted)" }} className="fade-up">
            <div style={{ fontSize: 56, opacity: .1, marginBottom: 20, animation: "float 3s ease-in-out infinite" }}>👤</div>
            <div style={{ fontFamily: "var(--serif)", fontSize: "1.5rem", color: "var(--text)", fontWeight: 700, marginBottom: 12 }}>Select a user</div>
            <div style={{ fontSize: 14, lineHeight: 1.7, maxWidth: 340, margin: "0 auto" }}>
              Choose any user from the sidebar to explore their watch history, see what the model recommends, and check if it's a hit.
            </div>
          </div>
        )}
        {loading && <Loader text={`Fetching ${contextEnabled ? "context-aware " : ""}recommendations for User ${selectedUser}…`} />}
        {err && <ErrBox msg={err} />}

        {recData && !loading && (
          <div style={{ display: "flex", flexDirection: "column", gap: 32 }} className="fade-up">
            <div className="profile-card">
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 20 }}>
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 18 }}>
                    <div style={{ width: 54, height: 54, borderRadius: "50%", background: "linear-gradient(135deg,var(--blue)22,var(--blue)08)", border: "2px solid var(--blue)44", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--serif)", fontSize: 20, color: "var(--blue)", fontWeight: 700, flexShrink: 0 }}>
                      {String(selectedUser).slice(-2)}
                    </div>
                    <div>
                      <div style={{ fontFamily: "var(--serif)", fontSize: 22, fontWeight: 700, color: "var(--text)" }}>User {selectedUser}</div>
                      <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--muted)", marginTop: 3 }}>{recData.history_len} films in history · test-set user</div>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                    <div className={`hit-indicator ${isHit ? "hit" : "miss"}`}>
                      {isHit ? "✓ Hit" : "✗ Miss"} (Local HR@{topK}: {isHit ? "1" : "0"})
                    </div>
                    {groundTruth != null && (
                      <div className={`hit-indicator ${isHit ? "hit" : "miss"}`}>
                        Local NDCG@{topK}: {localNDCG}
                      </div>
                    )}
                    {groundTruth != null && (
                      <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--muted)", display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                        <span>Target:</span>
                        <span style={{ color: "var(--text)" }}>{movies?.[String(groundTruth)]?.title || `#${groundTruth}`}</span>
                        {movies?.[String(groundTruth)]?.year && <span>({movies[String(groundTruth)].year})</span>}
                        <span style={{ color: gcolor(movies?.[String(groundTruth)]?.genres), fontSize: 9 }}>●</span>
                        <span>{movies?.[String(groundTruth)]?.genres?.[0]}</span>
                        {localRank !== undefined && localRank !== -1 && (
                          <>
                            <span style={{ margin: "0 4px", color: "var(--border2)" }}>|</span>
                            <span style={{ color: "var(--text)" }}>Rank: #{localRank + 1}</span>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, background: "var(--surface)", border: "1px solid var(--border2)", borderRadius: "var(--radius)", padding: "8px 16px" }}>
                    <span style={{ color: "var(--muted)", fontSize: 13, fontFamily: "var(--mono)" }}>Top</span>
                    <input type="number" value={topK} min={5} max={20} onChange={e => setTopK(Number(e.target.value))}
                      style={{ width: 48, background: "transparent", border: "none", color: "var(--accent)", fontFamily: "var(--mono)", fontSize: 16, fontWeight: 600, outline: "none", textAlign: "center" }} />
                    <span style={{ color: "var(--muted)", fontSize: 13, fontFamily: "var(--mono)" }}>picks</span>
                  </div>
                  <button className="btn btn-blue btn-sm" onClick={rerun} disabled={loading}>
                    {loading ? <><span className="spinner" /> Running…</> : "↺ Re-run"}
                  </button>
                </div>
              </div>
              {userHistory.length > 0 && (
                <div style={{ marginTop: 24, paddingTop: 20, borderTop: "1px solid var(--border)" }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
                    <div>
                      <div className="section-label" style={{ marginBottom: 12 }}>Genre breakdown</div>
                      <UserGenreBars historyIds={userHistory} movies={movies} />
                    </div>
                    <div>
                      <div className="section-label" style={{ marginBottom: 12 }}>Last watched</div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                        {[...userHistory].reverse().slice(0, 7).map(id => {
                          const m = movies?.[String(id)];
                          return (
                            <div key={id} style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: "var(--mono)", fontSize: 11 }}>
                              <span style={{ color: gcolor(m?.genres), fontSize: 7, flexShrink: 0 }}>●</span>
                              <span style={{ color: "var(--text)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m?.title || `#${id}`}</span>
                              {m?.year && <span style={{ color: "var(--muted)", flexShrink: 0 }}>{m.year}</span>}
                            </div>
                          );
                        })}
                        {userHistory.length > 7 && <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)", marginTop: 2 }}>+ {userHistory.length - 7} more</div>}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {userHistory.length > 0 && (
              <section className="fade-up">
                <div className="section-label">Recent history — last {Math.min(userHistory.length, 12)} films</div>
                <div className="movie-grid">
                  {[...userHistory].reverse().slice(0, 12).map((id, i) => (
                    <MovieCard key={id} idx={id} movies={movies} cache={cache} onNeeded={loadPoster} delay={i * 0.04} showGenre />
                  ))}
                </div>
              </section>
            )}

            <ResultsBlock pickedIds={userHistory} recData={recData} baseRecData={baseRecData} expData={expData}
              movies={movies} cache={cache} loadPoster={loadPoster} requestKey={requestKey} status={status}
              contextEnabled={contextEnabled} todSlot={todSlot} seasonSlot={seasonSlot} />
          </div>
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
//  CUSTOM HISTORY PAGE
// ══════════════════════════════════════════════════════════════
function CustomHistoryPage({ movies, cache, loadPoster, status, contextEnabled, todSlot, seasonSlot, todWeight, seasonWeight }) {
  const [picked, setPicked] = useState([]);
  const [topK, setTopK] = useState(10);
  const [recData, setRecData] = useState(null);
  const [baseRecData, setBaseRecData] = useState(null);
  const [expData, setExpData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [backendNote, setBackendNote] = useState(false);
  const [requestKey, setRequestKey] = useState(0);
  const runId = useRef(0);

  const addMovie = useCallback((idx, movie) => { setPicked(p => p.find(x => x.idx === idx) ? p : [...p, { idx, movie }]); setRecData(null); setBaseRecData(null); setExpData(null); }, []);
  const removeMovie = useCallback(idx => { setPicked(p => p.filter(x => x.idx !== idx)); setRecData(null); setBaseRecData(null); setExpData(null); }, []);

  const pickedRef = useRef(picked); const topKRef = useRef(topK);
  useEffect(() => { pickedRef.current = picked; }, [picked]);
  useEffect(() => { topKRef.current = topK; }, [topK]);

  const run = useCallback(async () => {
    const cp = pickedRef.current, ck = topKRef.current;
    if (!cp.length) return;
    const id = ++runId.current;
    setLoading(true); setErr(null); setRecData(null); setBaseRecData(null); setExpData(null);
    try {
      // Always fetch base recs first
      const baseRec = await apiFetch("/recommend/custom", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ history: cp.map(p => p.idx), top_k: ck })
      });
      if (runId.current !== id) return;
      setBaseRecData(baseRec);

      // ── Context recs: try backend first, fall back to client-side bias ──
      let finalRec = baseRec;
      if (contextEnabled) {
        try {
          const ctxRec = await apiFetch("/recommend/custom/context", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ history: cp.map(p => p.idx), top_k: ck, tod_slot: todSlot, season_slot: seasonSlot, tod_weight: todWeight, season_weight: seasonWeight })
          });
          if (runId.current !== id) return;
          finalRec = ctxRec;
        } catch {
          // Backend context endpoint unavailable — apply client-side genre bias
          finalRec = {
            ...baseRec,
            recommendations: applyClientContextBias(
              baseRec.recommendations, movies, todSlot, seasonSlot, todWeight, seasonWeight
            ),
          };
        }
      }
      setRecData(finalRec);
      setRequestKey(k => k + 1);

      // Fetch explain
      try {
        const exp = await apiFetch("/explain/custom", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ history: cp.map(p => p.idx), top_k: ck })
        });
        if (runId.current !== id) return;
        setExpData(exp);
      } catch {
        try {
          const users = await apiFetch("/users?limit=5");
          if (users?.users?.length) {
            const exp = await apiFetch("/explain", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ user_id: users.users[0], top_k: ck })
            });
            if (runId.current !== id) return;
            setExpData({ ...exp, history_influence: cp.map((p, i) => ({ item_id: p.idx, attention: 1 / cp.length, position: i, label: "confirmed" })), history_len: cp.length });
            setBackendNote(true);
          }
        } catch { }
      }
    } catch (e) { if (runId.current === id) setErr(e.message); }
    finally { if (runId.current === id) setLoading(false); }
  }, [contextEnabled, todSlot, seasonSlot, todWeight, seasonWeight, movies]);

  const noMovies = Object.keys(movies).length === 0;

  return (
    <>
      <div style={{ marginBottom: 52, position: "relative" }} className="fade-up">
        <div style={{ position: "absolute", top: -40, left: -60, width: 300, height: 200, background: "radial-gradient(ellipse,var(--accent)08,transparent 70%)", pointerEvents: "none" }} />
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 24, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--accent)", letterSpacing: ".15em", textTransform: "uppercase", marginBottom: 12, opacity: .8 }}>Hybrid recommendation engine</div>
            <h1 style={{ fontFamily: "var(--serif)", fontSize: "clamp(2rem,5vw,3.6rem)", fontWeight: 900, lineHeight: 1.08, letterSpacing: "-.04em", color: "var(--text)", marginBottom: 14 }}>
              What should you<br />watch <span style={{ color: "var(--accent)", fontStyle: "italic" }}>next?</span>
            </h1>
            <p style={{ color: "var(--muted)", fontSize: 15, maxWidth: 480, lineHeight: 1.7, fontWeight: 300 }}>Add films you've loved. Our model blends graph networks, long-term memory, and transformers to surface what's perfect for you.</p>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 8 }}>
            {[
              { icon: "⬡", label: "Graph Neural Network", color: "#5b8dee" },
              { icon: "◉", label: "Long-term Memory", color: "#4caf82" },
              { icon: "▸", label: "Transformer Attention", color: "#c9a84c" },
              { icon: "◷", label: "Time & Season Context", color: "#9b72ef" },
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
          <strong>⚙ Backend tip:</strong> Expose <code>shap_norm</code> from <code>/explain/custom</code> and add <code>/recommend/custom/context</code> endpoint in <code>main.py</code> for full context-aware custom recommendations.
        </div>
      )}

      <div style={{ marginBottom: 32 }} className="fade-up">
        <div className="section-label">Build your history</div>
        {noMovies
          ? <div style={{ color: "var(--muted)", fontSize: 14, padding: "16px 0", fontFamily: "var(--mono)" }}>⚠ Movie catalogue not loaded — check server connection.</div>
          : <MovieSearch movies={movies} cache={cache} onNeeded={loadPoster} onSelect={addMovie} />}
      </div>

      {picked.length > 0 && (
        <div style={{ marginBottom: 36 }} className="fade-up">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <div className="section-label" style={{ margin: 0 }}>Selected · {picked.length} {picked.length === 1 ? "film" : "films"}</div>
            <button className="btn btn-ghost btn-sm" onClick={() => { setPicked([]); setRecData(null); setBaseRecData(null); setExpData(null); }}>Clear all</button>
          </div>
          <div className="movie-grid">
            {picked.map(({ idx }, i) => (
              <MovieCard key={idx} idx={idx} movies={movies} cache={cache} onNeeded={loadPoster} onRemove={removeMovie} delay={i * 0.04} showGenre />
            ))}
          </div>
          {picked.length >= 3 && <div style={{ marginTop: 20 }}><GenreRadar picked={picked} movies={movies} /></div>}
          <div style={{ display: "flex", gap: 12, marginTop: 24, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, background: "var(--surface)", border: "1px solid var(--border2)", borderRadius: "var(--radius)", padding: "8px 16px" }}>
              <span style={{ color: "var(--muted)", fontSize: 13, fontFamily: "var(--mono)" }}>Top</span>
              <input type="number" value={topK} min={5} max={20} onChange={e => setTopK(Number(e.target.value))}
                style={{ width: 52, background: "transparent", border: "none", color: "var(--accent)", fontFamily: "var(--mono)", fontSize: 16, fontWeight: 600, outline: "none", textAlign: "center" }} />
              <span style={{ color: "var(--muted)", fontSize: 13, fontFamily: "var(--mono)" }}>picks</span>
            </div>
            <button className="btn btn-primary" onClick={run} disabled={loading || !picked.length}>
              {loading ? <><span className="spinner" /> Analysing…</> : `✦ Get ${contextEnabled ? "context-aware " : ""}recommendations`}
            </button>
            {recData && <button className="btn btn-ghost" onClick={() => { setRecData(null); setBaseRecData(null); setExpData(null); }}>↺ Reset</button>}
          </div>
        </div>
      )}

      {err && <ErrBox msg={err} />}
      {loading && <Loader text={`Running hybrid model${contextEnabled ? ` · ${TOD_SLOTS[todSlot]?.label} / ${SEASON_SLOTS[seasonSlot]?.label}` : ""}…`} />}

      {recData && (
        <ResultsBlock pickedIds={picked} recData={recData} baseRecData={baseRecData} expData={expData}
          movies={movies} cache={cache} loadPoster={loadPoster} requestKey={requestKey} status={status}
          contextEnabled={contextEnabled} todSlot={todSlot} seasonSlot={seasonSlot} />
      )}

      {!recData && !loading && picked.length === 0 && (
        <div style={{ textAlign: "center", padding: "80px 0", color: "var(--muted)" }} className="fade-up">
          <div style={{ position: "relative", display: "inline-block", marginBottom: 24 }}>
            <div style={{ fontSize: 64, opacity: .15, animation: "float 3s ease-in-out infinite" }}>🎬</div>
          </div>
          <div style={{ fontFamily: "var(--serif)", fontSize: "1.5rem", color: "var(--text)", marginBottom: 10, fontWeight: 700 }}>Start with a film you love</div>
          <div style={{ fontSize: 14, color: "var(--muted)", maxWidth: 340, margin: "0 auto", lineHeight: 1.65 }}>Search above and build your history. The more you add, the better the model understands your taste.</div>
          <div style={{ marginTop: 32, display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
            {["Action", "Drama", "Sci-Fi", "Comedy", "Thriller"].map(g => (
              <span key={g} className="genre-tag" style={{ color: gcolor([g]), borderColor: gcolor([g]) + "44", background: gcolor([g]) + "0a" }}>{g}</span>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

// ══════════════════════════════════════════════════════════════
//  ROOT APP
// ══════════════════════════════════════════════════════════════
export default function App() {
  const [movies, setMovies] = useState({});
  const [status, setStatus] = useState(null);
  const [activePage, setActivePage] = useState("custom");
  const tmdbKey = "394771898f564a5285ada7bd1fd50b1b";
  const [cache, loadPoster] = usePosterLoader(tmdbKey);

  // ── Global context state (shared across both pages) ──────────
  const [contextEnabled, setContextEnabled] = useState(false);
  const [todSlot, setTodSlot] = useState(getCurrentTod);
  const [seasonSlot, setSeasonSlot] = useState(getCurrentSeason);
  const [todWeight, setTodWeight] = useState(0.25);
  const [seasonWeight, setSeasonWeight] = useState(0.15);

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

  const metricPill = useMemo(() => {
    if (!status?.test_metrics) return null;
    const k = parseInt(Object.keys(status.test_metrics).find(key => key.startsWith("HR@"))?.split("@")[1] || "10");
    return { k, hr: status.test_metrics[`HR@${k}`], ndcg: status.test_metrics[`NDCG@${k}`] };
  }, [status]);

  const todInfo = TOD_SLOTS[todSlot];
  const seasonInfo = SEASON_SLOTS[seasonSlot];

  return (
    <>
      <style>{GLOBAL_CSS}</style>

      <nav className="nav">
        <div className="nav-logo"><span>CinéRec</span><div className="nav-logo-dot" /></div>

        <div className="page-tabs">
          <button className={`page-tab custom-tab${activePage === "custom" ? " active" : ""}`} onClick={() => setActivePage("custom")}>
            ✦ <span className="tab-label">Custom History</span>
          </button>
          <button className={`page-tab explorer-tab${activePage === "explorer" ? " active" : ""}`} onClick={() => setActivePage("explorer")}>
            👤 <span className="tab-label">User Explorer</span>
          </button>
        </div>

        <div className="nav-pill">
          <span style={{ color: "#5b8dee", fontSize: 10 }}>⬡</span> GCN
          <span style={{ color: "var(--border2)", margin: "0 4px" }}>·</span>
          <span style={{ color: "#4caf82", fontSize: 10 }}>◉</span> Memory
          <span style={{ color: "var(--border2)", margin: "0 4px" }}>·</span>
          <span style={{ color: "#c9a84c", fontSize: 10 }}>▸</span> Seq
          {contextEnabled && (
            <>
              <span style={{ color: "var(--border2)", margin: "0 4px" }}>·</span>
              <span style={{ color: TOD_COLORS[todInfo?.key], fontSize: 10 }}>{todInfo?.icon}</span>
              <span style={{ color: TOD_COLORS[todInfo?.key] }}>{todInfo?.label}</span>
              <span style={{ color: "var(--border2)", margin: "0 4px" }}>·</span>
              <span style={{ color: SEASON_COLORS[seasonInfo?.key], fontSize: 10 }}>{seasonInfo?.icon}</span>
              <span style={{ color: SEASON_COLORS[seasonInfo?.key] }}>{seasonInfo?.label}</span>
            </>
          )}
        </div>

        {metricPill?.hr != null && (
          <div className="nav-pill">
            <span style={{ color: "#4caf82" }}>HR@{metricPill.k}</span>
            <span style={{ color: "var(--text)", fontWeight: 500 }}>{(metricPill.hr * 100).toFixed(1)}%</span>
            {metricPill.ndcg != null && (
              <><span style={{ color: "var(--border2)" }}>·</span>
                <span style={{ color: "#c9a84c" }}>NDCG@{metricPill.k}</span>
                <span style={{ color: "var(--text)", fontWeight: 500 }}>{(metricPill.ndcg * 100).toFixed(1)}%</span></>
            )}
          </div>
        )}

        <div className="nav-status">
          <div className="status-dot" style={{ background: status?.loaded ? "var(--green)" : "var(--red)", animation: !status?.loaded ? "pulse 1.5s infinite" : "none" }} />
          <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--muted)" }}>
            {status?.loaded ? `${status.n_users?.toLocaleString()} users · ${Object.keys(movies).length.toLocaleString()} titles` : "connecting…"}
          </span>
        </div>
      </nav>

      <main style={{ maxWidth: 1200, margin: "0 auto", padding: "48px 28px" }}>
        {/* ── Context selector — always shown at top ── */}
        <ContextSelector
          todSlot={todSlot} setTodSlot={setTodSlot}
          seasonSlot={seasonSlot} setSeasonSlot={setSeasonSlot}
          todWeight={todWeight} setTodWeight={setTodWeight}
          seasonWeight={seasonWeight} setSeasonWeight={setSeasonWeight}
          contextEnabled={contextEnabled} setContextEnabled={setContextEnabled}
        />

        {activePage === "custom" && (
          <CustomHistoryPage movies={movies} cache={cache} loadPoster={loadPoster} status={status}
            contextEnabled={contextEnabled} todSlot={todSlot} seasonSlot={seasonSlot}
            todWeight={todWeight} seasonWeight={seasonWeight} />
        )}
        {activePage === "explorer" && (
          <UserExplorerPage movies={movies} cache={cache} loadPoster={loadPoster} status={status}
            contextEnabled={contextEnabled} todSlot={todSlot} seasonSlot={seasonSlot}
            todWeight={todWeight} seasonWeight={seasonWeight} />
        )}
      </main>
    </>
  );
}