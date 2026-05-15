import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { Chart, registerables } from "chart.js";
Chart.register(...registerables);

const API = "/api";
const GEMINI_API_KEY = "AIzaSyDjwBhzpVvLMi8C6I_zkb2wRXafj81Rw1s";
const GEMINI_MODELS = ["gemini-2.5-flash", "gemini-2.0-flash"];
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

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
const TOD_COLORS = { morning: "#EF9F27", afternoon: "#378ADD", evening: "#9b72ef", night: "#4caf82" };
const SEASON_COLORS = { winter: "#378ADD", spring: "#4caf82", summer: "#EF9F27", fall: "#D85A30" };
const TOD_GENRE_BIAS = {
  0: { Animation: .15, Comedy: .12, Family: .12, Documentary: .10 },
  1: { Adventure: .12, Action: .10, Comedy: .08, Children: .10 },
  2: { Drama: .12, Romance: .10, Thriller: .08, Crime: .06 },
  3: { Horror: .15, Thriller: .12, "Sci-Fi": .10, Crime: .08, Mystery: .10 },
};
const SEASON_GENRE_BIAS = {
  0: { Drama: .12, Romance: .10, Family: .10, Animation: .08 },
  1: { Comedy: .12, Romance: .10, Adventure: .08, Musical: .08 },
  2: { Action: .12, Adventure: .12, "Sci-Fi": .10, Animation: .06 },
  3: { Horror: .15, Thriller: .10, Crime: .08, Drama: .08 },
};
const GENRE_COLORS = {
  Action: "#e05252", Adventure: "#e07d52", Animation: "#e0b452", Comedy: "#b8e052", Drama: "#527be0",
  Horror: "#9052e0", Romance: "#e052b8", "Sci-Fi": "#52d4e0", Thriller: "#52e09c", Documentary: "#52a8e0",
  Crime: "#c052e0", Fantasy: "#e0d452",
};

function applyClientContextBias(recs, movies, todSlot, seasonSlot, todWeight, seasonWeight) {
  const todBias = TOD_GENRE_BIAS[todSlot] || {};
  const seasonBias = SEASON_GENRE_BIAS[seasonSlot] || {};
  return [...recs].map(r => {
    const genres = movies?.[String(r.item_id)]?.genres || [];
    let bias = 0;
    genres.forEach(g => { bias += (todBias[g] || 0) * todWeight * 4; bias += (seasonBias[g] || 0) * seasonWeight * 4; });
    return { ...r, score: (r.score || 0) + bias };
  }).sort((a, b) => b.score - a.score);
}
function getCurrentTod() { const h = new Date().getHours(); if (h >= 5 && h < 11) return 0; if (h >= 11 && h < 17) return 1; if (h >= 17 && h < 21) return 2; return 3; }
function getCurrentSeason() { const m = new Date().getMonth() + 1; if (m === 12 || m <= 2) return 0; if (m <= 5) return 1; if (m <= 8) return 2; return 3; }

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
          for (let a = 0; a <= retries; a++) {
            try {
              _lastGeminiCall = Date.now();
              const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: .85, maxOutputTokens: 8192 } }) });
              if (res.status === 429 || res.status === 404 || res.status === 400) break;
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              const data = await res.json();
              const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
              if (text) { resolve(text); return; }
              break;
            } catch (e) { if (a === retries) break; await new Promise(r => setTimeout(r, 1500)); }
          }
        }
        resolve(null);
      } catch (err) { resolve(null); }
    });
  });
}

async function generateGeminiExplanation({ picked, recommendations, movies, gates, historyInfluence, shapNorm, lang, todSlot, seasonSlot }) {
  const cacheKey = `${lang}::${todSlot}::${seasonSlot}::${(picked || []).map(p => p.idx ?? p).join(",")}::${(recommendations || []).slice(0, 5).map(r => r.item_id).join(",")}`;
  if (EXP_CACHE[cacheKey]) return EXP_CACHE[cacheKey];
  const topInfluence = (historyInfluence || []).slice(0, 8).map(d => {
    const m = movies?.[String(d.item_id)];
    const title = m?.title ? `${m.title} (${m.year || "Unknown"})` : `#${d.item_id}`;
    return `"${title}": attention ${Math.round((d.attention ?? 0) * 100)}%`;
  }).join("\n");
  const topRecs = recommendations.slice(0, 5).map((r, i) => {
    const m = movies?.[String(r.item_id)];
    return `${i + 1}. "${m?.title ? `${m.title} (${m.year || "Unknown"})` : `#${r.item_id}`}" (${m?.genres?.[0] || "Unknown"}, score ${r.score?.toFixed ? r.score.toFixed(3) : r.score})`;
  }).join("\n");
  const watchedGenres = [...new Set((picked || []).map(p => movies?.[String(p.idx ?? p)]?.genres?.[0]).filter(Boolean))].join(", ");
  const todName = todSlot != null ? TOD_SLOTS[todSlot]?.label : null;
  const seasonName = seasonSlot != null ? SEASON_SLOTS[seasonSlot]?.label : null;
  const contextHint = todName && seasonName ? `The user is watching on a ${seasonName} ${todName}. Weave in a subtle nod to why these films suit that mood/season if it feels natural.` : "";
  const isArabic = lang === "ar";
  const prompt = isArabic
    ? `أنت ناقد سينمائي ودود وخبير. اشرح للمستخدم لماذا يتم اقتراح هذه الأفلام بناءً على تاريخ مشاهدته. اكتب شرحاً موجزاً وجذاباً وشخصياً (فقرة واحدة قصيرة). ${contextHint}\nالأنواع المشاهودة: ${watchedGenres || "متنوعة"}\nالأفلام المفضلة: ${topInfluence || "لا بيانات"}\nأفضل التوصيات: ${topRecs}\nاكتب باللغة العربية الفصيحة فقط.`
    : `You are a friendly, expert movie critic. Explain in one engaging paragraph why these films are recommended. Connect past favorites to new picks using directors, eras, or cinematic style. ${contextHint}\nWatched genres: ${watchedGenres || "varied"}\nFavorite past films: ${topInfluence || "no data"}\nTop recommendations: ${topRecs}\nBe conversational and enthusiastic.`;
  const text = await callGemini(prompt);
  if (text) { EXP_CACHE[cacheKey] = text; return text; }
  return isArabic ? "عذراً، استنفد مفتاح Gemini API الحصة المسموحة." : "Could not reach Gemini (429 Rate Limit). Please check your API key usage.";
}

const PC = {};
function pkey(t, y) { return `${t}||${y}`; }

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
function gcolor(genres) { return GENRE_COLORS[genres?.[0]] || "#888"; }

// ══════════════════════════════════════════════════════════════
// GLOBAL CSS — Cinematic Dark Luxury
// ══════════════════════════════════════════════════════════════
const GLOBAL_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;0,700;1,300;1,400;1,600&family=Bebas+Neue&family=JetBrains+Mono:wght@300;400;500&family=Noto+Naskh+Arabic:wght@400;500;600;700&display=swap');

*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}

:root {
  --bg: #070507;
  --bg2: #0d090d;
  --surface: #120e13;
  --card: #170f18;
  --card2: #1d1320;
  --card3: #261828;
  --border: rgba(200,169,110,0.08);
  --border2: rgba(200,169,110,0.15);
  --border3: rgba(200,169,110,0.25);
  --text: #f5ede0;
  --muted: #6b5848;
  --muted2: #a08870;
  --accent: #c8a96e;
  --accent2: #e8c98a;
  --accent3: #f5dfa8;
  --gold-glow: rgba(200,169,110,0.22);
  --red-carpet: #9b2335;
  --green: #4a9e6a;
  --red: #b83232;
  --blue: #3a5fa0;
  --purple: #7056a8;
  --serif: 'Cormorant Garamond', Georgia, serif;
  --display: 'Bebas Neue', 'Impact', sans-serif;
  --sans: 'Cormorant Garamond', Georgia, serif;
  --mono: 'JetBrains Mono', monospace;
  --arabic: 'Noto Naskh Arabic', serif;
  --radius: 4px;
  --radius-sm: 3px;
  --radius-lg: 6px;
  --radius-xl: 10px;
  --radius-pill: 999px;
}

html{scroll-behavior:smooth;}
body{background:var(--bg);color:var(--text);font-family:var(--sans);min-height:100vh;overflow-x:hidden;-webkit-font-smoothing:antialiased;}
::-webkit-scrollbar{width:3px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:rgba(200,169,110,0.3);border-radius:2px}
body::before{
  content:'';position:fixed;inset:0;z-index:1;pointer-events:none;
  background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.04'/%3E%3C/svg%3E");
  opacity:1;mix-blend-mode:overlay;
}
.fade-up{animation:fadeUp .6s cubic-bezier(.2,.8,.3,1) both}
.fade-in{animation:fadeIn .4s ease both}
.card-reveal{animation:cardReveal .5s cubic-bezier(.2,.8,.3,1) both}

/* NAV */
.nav{
  position:sticky;top:0;z-index:200;
  background:rgba(7,5,7,0.88);
  backdrop-filter:blur(32px) saturate(1.8);
  -webkit-backdrop-filter:blur(32px) saturate(1.8);
  border-bottom:1px solid var(--border2);
  padding:0 48px;height:68px;display:flex;align-items:center;gap:0;
}
.nav::after{
  content:'';position:absolute;bottom:0;left:0;right:0;height:1px;
  background:linear-gradient(90deg,transparent,var(--accent),var(--accent2),transparent);
  background-size:200% 100%;animation:borderFlow 6s ease infinite;opacity:.8;
}

.nav-logo{
  font-family:var(--display);font-size:22px;font-weight:400;
  color:var(--accent);letter-spacing:.12em;text-transform:uppercase;
  white-space:nowrap;display:flex;align-items:center;gap:12px;margin-right:28px;
}
.nav-logo-reel{
  width:22px;height:22px;border-radius:50%;border:2px solid var(--accent);
  position:relative;display:flex;align-items:center;justify-content:center;
  animation:reelSpin 4s linear infinite;flex-shrink:0;
  box-shadow:0 0 12px var(--gold-glow);
}
.nav-logo-reel::before{content:'';width:6px;height:6px;border-radius:50%;background:var(--accent);}
.nav-logo-reel::after{content:'';position:absolute;inset:3px;border-radius:50%;border:1px dashed rgba(200,169,110,0.4);}
.nav-logo-accent{color:var(--accent2);}

.page-tabs{display:flex;align-items:center;gap:2px;margin-right:16px;background:rgba(200,169,110,0.05);border:1px solid var(--border2);border-radius:var(--radius-sm);padding:3px;}
.page-tab{padding:5px 16px;border-radius:var(--radius-sm);font-family:var(--mono);font-size:9.5px;cursor:pointer;transition:all .2s;border:none;background:transparent;color:var(--muted);letter-spacing:.1em;text-transform:uppercase;display:flex;align-items:center;gap:6px;}
.page-tab:hover{color:var(--muted2);}
.page-tab.active{background:rgba(200,169,110,0.12);color:var(--accent2);box-shadow:inset 0 1px 0 rgba(200,169,110,0.15);}
.page-tab.active.custom-tab{color:var(--accent2);}
.page-tab.active.explorer-tab{color:var(--accent);}

.nav-pill{background:rgba(200,169,110,0.05);border:1px solid var(--border2);border-radius:var(--radius-sm);padding:4px 12px;font-family:var(--mono);font-size:9.5px;color:var(--muted2);display:flex;align-items:center;gap:5px;margin-right:8px;}
.nav-status{display:flex;align-items:center;gap:7px;margin-left:auto;}
.status-dot{width:6px;height:6px;border-radius:50%;}

/* TICKER */
.ticker-wrap{background:rgba(200,169,110,0.03);border-top:1px solid var(--border2);border-bottom:1px solid var(--border2);padding:8px 0;overflow:hidden;position:relative;}
.ticker-wrap::before,.ticker-wrap::after{content:'';position:absolute;top:0;bottom:0;width:100px;z-index:1;pointer-events:none;}
.ticker-wrap::before{left:0;background:linear-gradient(90deg,var(--bg),transparent);}
.ticker-wrap::after{right:0;background:linear-gradient(270deg,var(--bg),transparent);}
.ticker-track{display:flex;animation:tickertape 40s linear infinite;width:max-content;}
.ticker-item{display:inline-flex;align-items:center;gap:8px;padding:0 32px;font-family:var(--mono);font-size:9px;color:var(--muted);white-space:nowrap;letter-spacing:.1em;text-transform:uppercase;}
.ticker-item span{color:var(--accent);font-size:7px;}

/* HERO */
.hero-projector{position:relative;padding:80px 0 64px;overflow:hidden;}
.hero-scan{position:absolute;inset:0;pointer-events:none;overflow:hidden;}
.hero-scan::after{content:'';position:absolute;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,var(--accent),var(--accent2),transparent);animation:scanline 5s linear infinite;opacity:.6;}
.hero-eyebrow{font-family:var(--mono);font-size:9px;letter-spacing:.3em;text-transform:uppercase;margin-bottom:24px;display:inline-flex;align-items:center;gap:10px;border:1px solid var(--border2);padding:6px 18px;color:var(--accent);}
.hero-eyebrow::before{content:'';width:5px;height:5px;border-radius:50%;background:var(--accent);box-shadow:0 0 8px var(--accent);animation:pulse 2s infinite;}
.hero-title{font-family:var(--display);font-size:clamp(3.5rem,9vw,8rem);font-weight:400;line-height:.9;letter-spacing:.05em;text-transform:uppercase;color:var(--text);margin-bottom:24px;}
.hero-title-gradient{background:linear-gradient(135deg,var(--accent) 0%,var(--accent2) 50%,var(--accent3) 100%);-webkit-background-clip:text;background-clip:text;color:transparent;display:inline-block;}
.hero-sub{color:var(--muted2);font-family:var(--serif);font-size:18px;line-height:1.9;max-width:480px;font-weight:400;font-style:italic;}

.model-pill-list{display:flex;flex-direction:column;gap:6px;}
.model-pill{display:flex;align-items:center;gap:10px;padding:10px 16px;border-radius:var(--radius);background:rgba(200,169,110,0.04);border:1px solid var(--border2);font-family:var(--mono);font-size:10px;color:var(--muted2);transition:all .22s;position:relative;overflow:hidden;}
.model-pill:hover{border-color:var(--border3);color:var(--text);background:rgba(200,169,110,0.08);transform:translateX(4px);}
.model-pill-icon{font-size:14px;width:18px;text-align:center;flex-shrink:0;}
.model-pill-dot{width:5px;height:5px;border-radius:50%;margin-left:auto;flex-shrink:0;opacity:.7;}

/* SECTION LABEL */
.section-label{font-family:var(--mono);font-size:8.5px;letter-spacing:.28em;text-transform:uppercase;color:var(--muted);margin-bottom:16px;display:flex;align-items:center;gap:10px;}
.section-label::before{content:'';display:inline-block;width:24px;height:1px;background:var(--accent);opacity:.6;}

/* MOVIE CARDS */
.pcard{position:relative;border-radius:0;overflow:hidden;background:var(--card);cursor:pointer;border:1px solid var(--border);will-change:transform;transition:transform .35s cubic-bezier(.16,1,.3,1),box-shadow .35s,border-color .25s;}
.pcard:hover{transform:translateY(-12px) scale(1.035);box-shadow:0 32px 64px rgba(0,0,0,.9),0 0 0 1px var(--border2),0 0 32px var(--gold-glow);}
.pcard::before{content:'';position:absolute;inset:0;z-index:2;pointer-events:none;background:linear-gradient(135deg,rgba(200,169,110,0.07) 0%,transparent 50%);opacity:0;transition:opacity .3s;}
.pcard:hover::before{opacity:1;}
.pcard.selected{border-color:rgba(200,169,110,0.6);box-shadow:0 0 0 2px rgba(200,169,110,0.2),0 0 40px var(--gold-glow);}
.pcard.hit{border-color:rgba(74,158,106,0.55);box-shadow:0 0 0 2px rgba(74,158,106,0.2);}
.pcard.ctx-boosted{border-color:var(--ctx-color,var(--accent))88;}
.pcard-img{width:100%;aspect-ratio:2/3;object-fit:cover;display:block;transition:transform .5s cubic-bezier(.16,1,.3,1),filter .3s;}
.pcard:hover .pcard-img{transform:scale(1.06);filter:saturate(1.15) contrast(1.05);}
.pcard-fallback{width:100%;aspect-ratio:2/3;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:var(--display);font-size:2.5rem;letter-spacing:.1em;}
.pcard-info{padding:14px 12px 16px;background:linear-gradient(to top,rgba(7,5,7,.98) 0%,rgba(7,5,7,.8) 55%,transparent 100%);position:absolute;bottom:0;left:0;right:0;}
.pcard-title{font-family:var(--serif);font-size:12px;font-weight:600;color:#fff;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
.pcard-year{font-size:9.5px;color:var(--accent);margin-top:3px;font-family:var(--mono);letter-spacing:.08em;}
.pcard-genre{font-size:8.5px;margin-top:3px;font-family:var(--mono);}
.rank-badge{position:absolute;top:8px;left:8px;background:rgba(7,5,7,.85);backdrop-filter:blur(10px);border-radius:0;padding:3px 9px;font-family:var(--display);font-size:11px;color:var(--accent);border-left:2px solid var(--accent);letter-spacing:.1em;}
.hit-badge{position:absolute;top:8px;right:8px;background:rgba(74,158,106,0.9);border-radius:0;padding:2px 8px;font-size:8.5px;font-weight:700;color:#fff;letter-spacing:.08em;text-transform:uppercase;}
.ctx-badge{position:absolute;bottom:52px;left:6px;right:6px;background:rgba(7,5,7,.85);backdrop-filter:blur(8px);border-radius:0;padding:3px 6px;font-family:var(--mono);font-size:8px;text-align:center;color:var(--ctx-color,var(--accent));border:1px solid var(--ctx-color,var(--accent))33;}
.remove-btn{position:absolute;top:6px;right:6px;z-index:10;width:22px;height:22px;border-radius:50%;background:rgba(0,0,0,.8);backdrop-filter:blur(6px);border:1px solid rgba(255,255,255,0.15);cursor:pointer;color:#fff;font-size:14px;display:flex;align-items:center;justify-content:center;transition:all .15s;opacity:0;}
.pcard:hover .remove-btn{opacity:1;}
.remove-btn:hover{background:rgba(184,50,50,0.8);border-color:rgba(184,50,50,0.4);transform:scale(1.1);}

/* SEARCH */
.search-wrap{position:relative;}
.search-input{width:100%;background:rgba(200,169,110,0.03);border:1px solid var(--border2);color:var(--text);border-radius:0;padding:16px 22px 16px 54px;font-family:var(--serif);font-size:17px;outline:none;transition:border-color .25s,box-shadow .25s,background .25s;}
.search-input:focus{border-color:rgba(200,169,110,0.5);box-shadow:0 0 0 3px rgba(200,169,110,0.07),0 16px 40px rgba(0,0,0,0.4);background:rgba(200,169,110,0.05);}
.search-input::placeholder{color:var(--muted);font-style:italic;}
.search-icon{position:absolute;left:18px;top:50%;transform:translateY(-50%);color:var(--muted);font-size:18px;pointer-events:none;z-index:1;}

/* DROPDOWN */
.dropdown{background:rgba(13,9,13,0.97);backdrop-filter:blur(40px);border:1px solid var(--border2);border-radius:0;max-height:440px;overflow-y:auto;box-shadow:0 40px 100px rgba(0,0,0,.95),0 0 0 1px var(--border3);animation:fadeUp .18s ease;}
.dd-item{display:flex;align-items:center;gap:14px;padding:10px 16px;cursor:pointer;border-bottom:1px solid var(--border);transition:background .12s;}
.dd-item:hover{background:rgba(200,169,110,0.05);}
.dd-thumb{width:36px;height:54px;border-radius:6px;overflow:hidden;flex-shrink:0;}
.dd-title{font-size:13.5px;font-weight:500;color:var(--text);}
.dd-meta{font-size:10.5px;color:var(--muted);margin-top:2px;font-family:var(--mono);}
.dd-genre-dot{display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:5px;vertical-align:middle;}

/* BUTTONS */
.btn{display:inline-flex;align-items:center;gap:8px;padding:11px 26px;border-radius:var(--radius-pill);border:none;font-family:var(--sans);font-size:13.5px;font-weight:600;cursor:pointer;transition:all .22s cubic-bezier(.2,.8,.3,1);white-space:nowrap;letter-spacing:.02em;position:relative;overflow:hidden;}
.btn::after{content:'';position:absolute;inset:0;background:linear-gradient(135deg,rgba(255,255,255,0.12) 0%,transparent 50%);opacity:0;transition:opacity .2s;}
.btn:hover:not(:disabled)::after{opacity:1;}
.btn-primary{background:linear-gradient(135deg,var(--accent) 0%,var(--cyan) 100%);color:#060610;font-weight:700;box-shadow:0 0 0 1px rgba(167,139,250,0.3);}
.btn-primary:hover:not(:disabled){transform:translateY(-2px);box-shadow:0 8px 30px rgba(167,139,250,0.45),0 0 0 1px rgba(167,139,250,0.5);}
.btn-ghost{background:rgba(255,255,255,0.05);color:var(--muted);border:1px solid var(--border2);}
.btn-ghost:hover:not(:disabled){background:rgba(255,255,255,0.08);color:var(--text);border-color:var(--border3);}
.btn-blue{background:linear-gradient(135deg,var(--blue),var(--cyan));color:#06101e;font-weight:700;}
.btn-blue:hover:not(:disabled){transform:translateY(-2px);box-shadow:0 8px 24px rgba(96,165,250,0.35);}
.btn-sm{padding:6px 14px;font-size:11.5px;}
.btn:disabled{opacity:.28;cursor:not-allowed;transform:none!important;}
.btn:active:not(:disabled){transform:scale(.97) translateY(0);}

/* SPINNER */
.spinner{width:15px;height:15px;border:2px solid rgba(255,255,255,0.1);border-top-color:var(--accent);border-radius:50%;animation:spin .7s linear infinite;}
.spinner-lg{width:42px;height:42px;border:2px solid rgba(255,255,255,0.06);border-top-color:var(--accent);border-radius:50%;animation:spin .9s linear infinite;}

/* CONTEXT PANEL */
.ctx-panel{background:rgba(9,9,24,0.55);backdrop-filter:blur(20px);border:1px solid var(--border2);border-radius:var(--radius-xl);padding:28px 32px;margin-bottom:40px;position:relative;overflow:hidden;}
.ctx-panel::before{content:'';position:absolute;top:-80px;right:-80px;width:240px;height:240px;border-radius:50%;background:radial-gradient(circle,rgba(167,139,250,0.07),transparent 70%);pointer-events:none;}
.ctx-panel::after{content:'';position:absolute;bottom:-60px;left:-60px;width:180px;height:180px;border-radius:50%;background:radial-gradient(circle,rgba(34,211,238,0.05),transparent 70%);pointer-events:none;}
.ctx-slot-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(86px,1fr));gap:8px;}
.ctx-slot{background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:var(--radius);padding:10px 8px;text-align:center;cursor:pointer;transition:all .22s cubic-bezier(.2,.8,.3,1);position:relative;overflow:hidden;}
.ctx-slot:hover{border-color:var(--border2);transform:translateY(-2px);}
.ctx-slot.active{border-color:var(--slot-color,var(--accent));box-shadow:0 0 20px rgba(167,139,250,0.15);}
.ctx-slot-icon{font-size:18px;margin-bottom:4px;display:block;transition:transform .2s;}
.ctx-slot.active .ctx-slot-icon{transform:scale(1.2);}
.ctx-slot-label{font-family:var(--mono);font-size:10px;color:var(--text);display:block;font-weight:400;letter-spacing:.03em;}
.ctx-slot-hours{font-family:var(--mono);font-size:8px;color:var(--muted);display:block;margin-top:2px;}
.ctx-weight-row{display:flex;align-items:center;gap:12px;margin-top:8px;}
.ctx-weight-label{font-family:var(--mono);font-size:10px;color:var(--muted);width:84px;flex-shrink:0;}
.ctx-weight-val{font-family:var(--mono);font-size:10px;color:var(--accent);width:30px;text-align:right;flex-shrink:0;}
input[type=range].ctx-slider{flex:1;accent-color:var(--accent);}

/* CONTEXT COMPARE */
.ctx-compare{background:rgba(255,255,255,0.02);border:1px solid var(--border);border-radius:var(--radius-lg);padding:20px 24px;margin-top:20px;}
.ctx-compare-row{display:flex;align-items:center;gap:10px;padding:5px 0;border-bottom:1px solid var(--border);font-family:var(--mono);font-size:11px;}
.ctx-compare-row:last-child{border-bottom:none;}
.ctx-rank{width:22px;text-align:right;color:var(--muted);flex-shrink:0;}
.ctx-item-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text);}
.ctx-delta{padding:2px 8px;border-radius:var(--radius-pill);font-size:9px;flex-shrink:0;}
.ctx-delta.up{background:rgba(52,211,153,0.12);color:var(--green);border:1px solid rgba(52,211,153,0.25);}
.ctx-delta.new{background:rgba(167,139,250,0.12);color:var(--accent);border:1px solid rgba(167,139,250,0.25);}
.ctx-delta.same{color:var(--muted);}
.ctx-delta.down{background:rgba(248,113,113,0.08);color:var(--red);border:1px solid rgba(248,113,113,0.2);}

/* EXPLANATION CARD */
.exp-card{background:rgba(9,9,24,0.5);backdrop-filter:blur(20px);border:1px solid var(--border2);border-radius:var(--radius-xl);padding:36px 40px;position:relative;overflow:hidden;}
.exp-card::before{content:'\\201C';position:absolute;top:-40px;left:24px;font-family:var(--serif);font-size:240px;background:linear-gradient(135deg,var(--accent),var(--cyan));-webkit-background-clip:text;background-clip:text;color:transparent;opacity:.06;line-height:1;pointer-events:none;}
.exp-card::after{content:'';position:absolute;top:0;right:0;bottom:0;width:260px;background:radial-gradient(ellipse at right center,rgba(167,139,250,0.05),transparent);pointer-events:none;}
.exp-paragraph{font-family:var(--sans);font-size:17px;line-height:2;color:var(--text);font-weight:300;position:relative;z-index:1;animation:fadeIn .5s ease both;}
.exp-paragraph.arabic{font-family:var(--arabic);font-size:20px;line-height:2.2;direction:rtl;text-align:right;font-style:normal;}
.exp-skeleton-line{height:16px;border-radius:4px;background:linear-gradient(90deg,var(--card) 25%,rgba(167,139,250,0.05) 50%,var(--card) 75%);background-size:800px 100%;animation:shimmer 2s infinite;margin-bottom:12px;}
.exp-typing-dot{width:5px;height:5px;border-radius:50%;background:var(--accent);animation:typing 1.2s ease-in-out infinite;display:inline-block;margin-right:4px;box-shadow:0 0 6px var(--accent);}
.exp-typing-dot:nth-child(2){animation-delay:.2s}
.exp-typing-dot:nth-child(3){animation-delay:.4s}
.gemini-badge{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:var(--radius-pill);border:1px solid var(--border2);background:rgba(255,255,255,0.04);font-family:var(--mono);font-size:9px;color:var(--muted);flex-shrink:0;}
.gemini-dot{width:5px;height:5px;border-radius:50%;background:linear-gradient(135deg,#4285f4,#ea4335,#fbbc04,#34a853);flex-shrink:0;}
.lang-toggle{display:inline-flex;align-items:center;background:rgba(255,255,255,0.04);border:1px solid var(--border2);border-radius:var(--radius-pill);padding:3px;gap:2px;flex-shrink:0;}
.lang-btn{padding:4px 12px;border-radius:var(--radius-pill);border:none;cursor:pointer;font-size:11px;font-weight:500;transition:all .2s;background:transparent;letter-spacing:.02em;}
.lang-btn.en{font-family:var(--mono);color:var(--muted);}
.lang-btn.ar{font-family:var(--arabic);color:var(--muted);font-size:13px;}
.lang-btn.active{background:rgba(255,255,255,0.08);box-shadow:0 2px 8px rgba(0,0,0,0.4);}
.lang-btn.en.active{color:var(--accent2);}
.lang-btn.ar.active{color:var(--gold2);}

/* CHARTS */
.chart-box{background:rgba(255,255,255,0.025);border:1px solid var(--border);border-radius:var(--radius);padding:22px 22px 18px;transition:border-color .2s,box-shadow .2s;}
.chart-box:hover{border-color:var(--border2);box-shadow:0 8px 32px rgba(0,0,0,0.3);}
.chart-title{font-family:var(--mono);font-size:9px;text-transform:uppercase;letter-spacing:.2em;color:var(--muted);margin-bottom:18px;}

/* STAT CARDS */
.stat-card{background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:var(--radius);padding:20px 22px;display:flex;flex-direction:column;gap:4px;transition:all .28s cubic-bezier(.2,.8,.3,1);position:relative;overflow:hidden;}
.stat-card::after{content:'';position:absolute;inset:0;background:linear-gradient(135deg,rgba(167,139,250,0.04),transparent 50%);opacity:0;transition:opacity .3s;border-radius:var(--radius);}
.stat-card:hover{border-color:rgba(167,139,250,0.25);transform:translateY(-4px);box-shadow:0 16px 40px rgba(0,0,0,0.5),0 0 20px rgba(167,139,250,0.08);}
.stat-card:hover::after{opacity:1;}
.stat-value{font-family:var(--serif);font-size:2.2rem;font-weight:700;color:var(--text);line-height:1;animation:countUp .5s ease both;}
.stat-label{font-family:var(--mono);font-size:9px;color:var(--muted);letter-spacing:.12em;text-transform:uppercase;margin-top:4px;}
.stat-sub{font-family:var(--mono);font-size:9px;color:var(--muted);margin-top:2px;}

/* GATE BARS */
.gate-row{display:flex;align-items:center;gap:12px;margin-bottom:12px;}
.gate-label{font-family:var(--mono);font-size:10.5px;color:var(--muted);width:58px;flex-shrink:0;display:flex;flex-direction:column;gap:1px;}
.gate-bar-wrap{flex:1;height:6px;background:rgba(255,255,255,0.04);border-radius:3px;overflow:hidden;}
.gate-bar{height:100%;border-radius:3px;transition:width 1.4s cubic-bezier(.2,.8,.3,1);}
.gate-pct{font-family:var(--mono);font-size:10.5px;width:34px;text-align:right;flex-shrink:0;}

/* SHIMMER */
.shimmer{background:linear-gradient(90deg,var(--card) 25%,rgba(167,139,250,0.05) 50%,var(--card) 75%);background-size:800px 100%;animation:shimmer 2s infinite;border-radius:var(--radius-sm);}

/* GENRE TAGS */
.genre-tag{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:var(--radius-pill);font-family:var(--mono);font-size:9px;border:1px solid;letter-spacing:.04em;}

/* INFLUENCE CHIPS */
.inf-chip{background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:8px;padding:5px 12px;display:inline-flex;align-items:center;gap:6px;font-family:var(--mono);font-size:10px;color:var(--muted);transition:all .15s;}
.inf-chip.confirmed{border-color:rgba(167,139,250,0.35);color:var(--accent2);}
.inf-chip.hidden-influence{border-color:rgba(244,114,182,0.35);color:var(--pink);}

/* TIMELINE */
.timeline-track{display:flex;align-items:center;overflow-x:auto;padding:12px 0;scrollbar-width:none;}
.timeline-track::-webkit-scrollbar{display:none;}
.tl-node{display:flex;flex-direction:column;align-items:center;gap:6px;flex-shrink:0;width:82px;position:relative;}
.tl-node::after{content:'';position:absolute;left:50%;top:27px;width:100%;height:1px;background:linear-gradient(90deg,rgba(167,139,250,0.2),transparent);z-index:0;}
.tl-node:last-child::after{display:none;}
.tl-circle{width:54px;height:54px;border-radius:50%;overflow:hidden;border:2px solid var(--border2);position:relative;z-index:1;background:var(--card);flex-shrink:0;transition:border-color .2s,box-shadow .2s;}
.tl-circle.active{border-color:var(--accent);box-shadow:0 0 16px rgba(167,139,250,0.3);animation:auraPulse 2.5s ease-in-out infinite;}
.tl-idx{font-family:var(--mono);font-size:8.5px;color:var(--muted);text-align:center;white-space:nowrap;}
.tl-label{font-size:9.5px;font-weight:500;color:var(--text);text-align:center;max-width:76px;line-height:1.2;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}

/* NOTICES */
.notice-card{background:rgba(167,139,250,0.06);border:1px solid rgba(167,139,250,0.2);border-radius:var(--radius);padding:16px 20px;margin-bottom:24px;font-size:12.5px;line-height:1.7;color:var(--accent2);}
.apikey-notice{background:rgba(96,165,250,0.06);border:1px solid rgba(96,165,250,0.2);border-radius:var(--radius);padding:16px 20px;margin-bottom:24px;font-size:12.5px;line-height:1.7;color:#93c5fd;}
.apikey-notice a{color:var(--gold2);text-decoration:underline;text-underline-offset:3px;}

/* GAUGE CARDS */
.gauge-card{background:rgba(255,255,255,0.025);border:1px solid var(--border);border-radius:var(--radius);padding:24px 20px 20px;display:flex;flex-direction:column;align-items:center;gap:14px;transition:all .25s;position:relative;overflow:hidden;}
.gauge-card:hover{border-color:var(--border2);transform:translateY(-3px);box-shadow:0 12px 32px rgba(0,0,0,0.4);}
.gauge-card::after{content:'';position:absolute;bottom:0;left:0;right:0;height:2px;}
.gauge-card.green::after{background:linear-gradient(90deg,transparent,var(--green),transparent);}
.gauge-card.amber::after{background:linear-gradient(90deg,transparent,var(--gold),transparent);}
.gauge-card.blue::after{background:linear-gradient(90deg,transparent,var(--blue),transparent);}
.gauge-desc{font-family:var(--mono);font-size:9px;color:var(--muted);text-align:center;line-height:1.6;max-width:130px;}
.quality-bar-wrap{width:100%;height:2px;background:rgba(255,255,255,0.05);border-radius:1px;overflow:hidden;}
.quality-bar{height:100%;border-radius:1px;transition:width 2s cubic-bezier(.2,.8,.3,1);}

/* USER EXPLORER */
.user-chip{background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px 14px;cursor:pointer;transition:all .2s;display:flex;align-items:center;justify-content:space-between;font-family:var(--mono);}
.user-chip:hover{border-color:var(--border2);background:rgba(255,255,255,0.05);transform:translateX(4px);}
.user-chip.active{border-color:rgba(96,165,250,0.4);background:rgba(96,165,250,0.06);box-shadow:inset 3px 0 0 var(--blue);}
.user-chip-id{font-size:12px;color:var(--text);}
.user-chip-arrow{font-size:12px;color:var(--muted);}
.profile-card{background:rgba(9,9,24,0.6);backdrop-filter:blur(20px);border:1px solid var(--border2);border-radius:var(--radius-xl);padding:28px 32px;position:relative;overflow:hidden;}
.hit-indicator{display:inline-flex;align-items:center;gap:8px;padding:7px 16px;border-radius:var(--radius-sm);font-family:var(--mono);font-size:11px;font-weight:500;}
.hit-indicator.hit{background:rgba(52,211,153,0.1);border:1px solid rgba(52,211,153,0.3);color:var(--green);}
.hit-indicator.miss{background:rgba(248,113,113,0.08);border:1px solid rgba(248,113,113,0.2);color:var(--red);}
.load-more-btn{width:100%;padding:12px;background:rgba(255,255,255,0.02);border:1px dashed var(--border2);border-radius:var(--radius-sm);cursor:pointer;color:var(--muted);font-family:var(--mono);font-size:11px;text-align:center;transition:all .2s;margin-top:8px;}
.load-more-btn:hover{border-color:var(--border3);color:var(--text);background:rgba(255,255,255,0.04);}
.genre-bar-row{display:flex;align-items:center;gap:10px;margin-bottom:8px;}
.genre-bar-label{font-family:var(--mono);font-size:10px;width:70px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.genre-bar-track{flex:1;height:4px;background:rgba(255,255,255,0.04);border-radius:2px;overflow:hidden;}
.genre-bar-fill{height:100%;border-radius:2px;transition:width 1.2s cubic-bezier(.2,.8,.3,1);}
.genre-bar-count{font-family:var(--mono);font-size:9px;color:var(--muted);width:20px;text-align:right;}
.sidebar-search{width:100%;background:rgba(255,255,255,0.04);border:1px solid var(--border2);color:var(--text);border-radius:var(--radius-sm);padding:10px 14px 10px 34px;font-family:var(--mono);font-size:11px;outline:none;transition:border-color .2s;}
.sidebar-search:focus{border-color:rgba(96,165,250,0.4);box-shadow:0 0 0 3px rgba(96,165,250,0.08);}
.sidebar-search::placeholder{color:var(--muted);}

/* GRIDS */
.movie-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(118px,1fr));gap:10px;}
.movie-grid-lg{display:grid;grid-template-columns:repeat(auto-fill,minmax(148px,1fr));gap:12px;}

/* CTX BADGES */
.ctx-auto-badge{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:var(--radius-pill);background:rgba(52,211,153,0.1);border:1px solid rgba(52,211,153,0.25);font-family:var(--mono);font-size:9px;color:var(--green);}

/* MOBILE */
@media(max-width:700px){
  .nav{padding:0 16px;}
  main{padding:20px 14px!important;}
  .exp-card{padding:20px 18px;}
  .exp-paragraph{font-size:15px;}
  .movie-grid{grid-template-columns:repeat(auto-fill,minmax(98px,1fr));}
  .movie-grid-lg{grid-template-columns:repeat(auto-fill,minmax(118px,1fr));}
  .tab-label{display:none;}
  .hero-title{font-size:2.5rem;}
  .ctx-slot-grid{grid-template-columns:repeat(2,1fr);}
  .ctx-panel{padding:20px 18px;}
}

.fade-up{animation:fadeUp .6s cubic-bezier(.2,.8,.3,1) both}
.fade-in{animation:fadeIn .4s ease both}
.card-reveal{animation:cardReveal .5s cubic-bezier(.2,.8,.3,1) both}

/* ── NAV ── */
.nav{
  position:sticky;top:0;z-index:200;
  background:linear-gradient(180deg,var(--bg)f0 0%,var(--bg)cc 100%);
  backdrop-filter:blur(32px) saturate(1.8);
  border-bottom:1px solid var(--border2);
  padding:0 48px;height:64px;
  display:flex;align-items:center;gap:0;
  position:relative;overflow:hidden;
}
.nav::after{
  content:'';position:absolute;bottom:0;left:0;right:0;height:1px;
  background:linear-gradient(90deg,transparent,var(--accent)44,transparent);
}

/* ── Logo ── */
.nav-logo{
  font-family:var(--serif);font-size:26px;font-weight:700;
  color:var(--accent);letter-spacing:-.03em;
  white-space:nowrap;display:flex;align-items:center;gap:10px;margin-right:28px;
  position:relative;
}
.nav-logo-reel{
  width:22px;height:22px;border-radius:50%;border:2px solid var(--accent);
  position:relative;display:flex;align-items:center;justify-content:center;
  animation:reelSpin 3s linear infinite;flex-shrink:0;
}
.nav-logo-reel::before{
  content:'';width:6px;height:6px;border-radius:50%;
  background:var(--accent);
}
.nav-logo-reel::after{
  content:'';position:absolute;inset:2px;border-radius:50%;
  border:1px dashed var(--accent)55;
}

/* ── Page tabs ── */
.page-tabs{display:flex;align-items:center;gap:3px;margin-right:18px;background:var(--surface);border:1px solid var(--border2);border-radius:28px;padding:4px;}
.page-tab{padding:6px 18px;border-radius:24px;font-family:var(--mono);font-size:10.5px;cursor:pointer;transition:all .22s cubic-bezier(.2,.8,.3,1);border:none;background:transparent;color:var(--muted);letter-spacing:.06em;display:flex;align-items:center;gap:6px;}
.page-tab:hover{color:var(--muted2);}
.page-tab.active{background:var(--card3);color:var(--text);box-shadow:0 2px 12px #00000055;}
.page-tab.active.custom-tab{color:var(--accent);}
.page-tab.active.explorer-tab{color:var(--blue);}

/* ── Nav pills ── */
.nav-pill{
  background:var(--surface);border:1px solid var(--border2);border-radius:20px;
  padding:5px 14px;font-family:var(--mono);font-size:10.5px;color:var(--muted2);
  display:flex;align-items:center;gap:6px;margin-right:10px;
}
.nav-status{display:flex;align-items:center;gap:8px;margin-left:auto;}
.status-dot{width:6px;height:6px;border-radius:50%;}

/* ── Film ticker ── */
.ticker-wrap{
  background:var(--card);border-top:1px solid var(--border);border-bottom:1px solid var(--border);
  padding:8px 0;overflow:hidden;position:relative;
  margin-bottom:0;
}
.ticker-wrap::before,.ticker-wrap::after{
  content:'';position:absolute;top:0;bottom:0;width:80px;z-index:1;pointer-events:none;
}
.ticker-wrap::before{left:0;background:linear-gradient(90deg,var(--bg),transparent);}
.ticker-wrap::after{right:0;background:linear-gradient(270deg,var(--bg),transparent);}
.ticker-track{display:flex;gap:0;animation:tickertape 30s linear infinite;width:max-content;}
.ticker-item{
  display:inline-flex;align-items:center;gap:8px;padding:0 32px;
  font-family:var(--mono);font-size:10px;color:var(--muted);white-space:nowrap;
}
.ticker-item span{color:var(--accent);font-size:8px;}

/* ── Projector hero ── */
.hero-projector{
  position:relative;text-align:left;
  padding:72px 0 60px;margin-bottom:8px;
  overflow:hidden;
}
.hero-projector::before{
  content:'';position:absolute;top:-200px;left:50%;transform:translateX(-50%);
  width:600px;height:600px;
  background:radial-gradient(ellipse at top,var(--accent)08 0%,transparent 60%);
  pointer-events:none;
}
.hero-scan{
  position:absolute;inset:0;pointer-events:none;overflow:hidden;
}
.hero-scan::after{
  content:'';position:absolute;left:0;right:0;height:2px;
  background:linear-gradient(90deg,transparent,var(--accent)66,transparent);
  animation:scanline 4s linear infinite;
}

.hero-eyebrow{
  font-family:var(--mono);font-size:10.5px;color:var(--accent);
  letter-spacing:.2em;text-transform:uppercase;margin-bottom:20px;opacity:.8;
  display:flex;align-items:center;gap:10px;
}
.hero-eyebrow::before{content:'';display:inline-block;width:20px;height:1px;background:var(--accent);}

.hero-title{
  font-family:var(--serif);
  font-size:clamp(3rem,7vw,5.5rem);
  font-weight:700;line-height:.95;
  letter-spacing:-.04em;color:var(--text);margin-bottom:20px;
}
.hero-title em{
  color:transparent;
  background:linear-gradient(135deg,var(--accent) 0%,var(--accent2) 40%,var(--accent3) 60%,var(--accent) 100%);
  background-size:200% auto;
  -webkit-background-clip:text;background-clip:text;
  animation:goldShimmer 4s linear infinite;
  font-style:italic;
}
.hero-sub{color:var(--muted2);font-size:15px;max-width:480px;line-height:1.8;font-weight:400;font-family:'Cormorant Garamond',serif;font-size:18px;}

/* ── Model pills (hero right) ── */
.model-pill-list{display:flex;flex-direction:column;gap:6px;padding-top:8px;}
.model-pill{
  display:flex;align-items:center;gap:10px;padding:10px 16px;
  border-radius:var(--radius);background:var(--surface);border:1px solid var(--border2);
  font-family:var(--mono);font-size:11px;color:var(--muted2);
  transition:all .2s;position:relative;overflow:hidden;
}
.model-pill:hover{border-color:var(--border3);color:var(--text);}
.model-pill::after{
  content:'';position:absolute;inset:0;
  background:linear-gradient(90deg,transparent,var(--accent)05,transparent);
  transform:translateX(-100%);transition:transform .4s;
}
.model-pill:hover::after{transform:translateX(100%);}
.model-pill-icon{font-size:14px;width:20px;text-align:center;}

/* ── Section label ── */
.section-label{
  font-family:var(--mono);font-size:10px;letter-spacing:.16em;text-transform:uppercase;
  color:var(--muted);margin-bottom:16px;display:flex;align-items:center;gap:8px;
}
.section-label::before{content:'';display:inline-block;width:16px;height:1px;background:var(--accent);opacity:.5;}

/* ── Movie Card ── */
.pcard{
  position:relative;border-radius:var(--radius);overflow:hidden;
  background:var(--card);cursor:pointer;
  border:1px solid var(--border);will-change:transform;
  transition:transform .3s cubic-bezier(.2,.8,.3,1),box-shadow .3s,border-color .3s;
}
.pcard:hover{
  transform:translateY(-8px) scale(1.03);
  box-shadow:0 32px 60px #00000090,0 0 0 1px var(--border2),0 0 24px var(--accent)18;
}
.pcard.selected{border-color:var(--accent)88;box-shadow:0 0 0 2px var(--accent)44;}
.pcard.hit{border-color:var(--green)88;box-shadow:0 0 0 2px var(--green)44;}
.pcard.ctx-boosted{border-color:var(--ctx-color,var(--accent))88;}
.pcard-img{width:100%;aspect-ratio:2/3;object-fit:cover;display:block;transition:transform .4s cubic-bezier(.2,.8,.3,1);}
.pcard:hover .pcard-img{transform:scale(1.06);}
.pcard-fallback{
  width:100%;aspect-ratio:2/3;display:flex;flex-direction:column;
  align-items:center;justify-content:center;
  font-family:var(--serif);font-size:2.2rem;font-weight:700;letter-spacing:-.04em;
}
.pcard-info{
  padding:12px 10px 14px;
  background:linear-gradient(to top,#000000f0 0%,#00000088 55%,transparent 100%);
  position:absolute;bottom:0;left:0;right:0;
}
.pcard-title{font-family:var(--sans);font-size:11.5px;font-weight:500;color:#fff;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
.pcard-year{font-size:10px;color:#ffffff60;margin-top:3px;font-family:var(--mono);}
.pcard-genre{font-size:9px;margin-top:3px;font-family:var(--mono);}
.rank-badge{
  position:absolute;top:8px;left:8px;
  background:#000000cc;backdrop-filter:blur(8px);
  border-radius:5px;padding:2px 8px;
  font-family:var(--mono);font-size:10px;color:var(--accent);
  border:1px solid var(--accent)22;
}
.hit-badge{position:absolute;top:8px;right:8px;background:var(--green)cc;border-radius:5px;padding:2px 8px;font-size:9px;font-weight:600;color:#fff;}
.ctx-badge{position:absolute;bottom:50px;left:6px;right:6px;background:#00000099;backdrop-filter:blur(4px);border-radius:4px;padding:2px 6px;font-family:var(--mono);font-size:8px;text-align:center;color:var(--ctx-color,var(--accent));}
.remove-btn{position:absolute;top:6px;right:6px;z-index:10;width:22px;height:22px;border-radius:50%;background:#000000cc;backdrop-filter:blur(4px);border:1px solid #ffffff22;cursor:pointer;color:#fff;font-size:14px;display:flex;align-items:center;justify-content:center;transition:all .15s;opacity:0;}
.pcard:hover .remove-btn{opacity:1;}
.remove-btn:hover{background:var(--red)cc;border-color:var(--red)55;}

/* ── Scanline overlay on hover ── */
.pcard::after{
  content:'';position:absolute;inset:0;pointer-events:none;
  background:repeating-linear-gradient(0deg,transparent,transparent 2px,#00000008 2px,#00000008 4px);
  opacity:0;transition:opacity .3s;border-radius:var(--radius);
}
.pcard:hover::after{opacity:1;}

/* ── Search ── */
.search-wrap{position:relative;}
.search-input{
  width:100%;background:var(--surface);border:1px solid var(--border2);
  color:var(--text);border-radius:var(--radius-lg);
  padding:16px 22px 16px 52px;font-family:var(--sans);font-size:15px;outline:none;
  transition:border-color .2s,box-shadow .2s,background .2s;
}
.search-input:focus{border-color:var(--accent)55;box-shadow:0 0 0 4px var(--accent)0e,0 8px 32px #00000055;background:var(--card);}
.search-input::placeholder{color:var(--muted);}
.search-icon{position:absolute;left:18px;top:50%;transform:translateY(-50%);color:var(--muted);font-size:17px;pointer-events:none;z-index:1;}

/* ── Dropdown ── */
.dropdown{
  background:var(--card2);border:1px solid var(--border2);border-radius:var(--radius-lg);
  max-height:420px;overflow-y:auto;
  box-shadow:0 40px 100px #000000cc,0 0 0 1px var(--border3);
  animation:fadeUp .2s ease;
}
.dd-item{display:flex;align-items:center;gap:14px;padding:10px 16px;cursor:pointer;border-bottom:1px solid var(--border);transition:background .12s;}
.dd-item:hover{background:var(--card3);}
.dd-thumb{width:36px;height:54px;border-radius:5px;overflow:hidden;flex-shrink:0;}
.dd-title{font-size:13.5px;font-weight:500;color:var(--text);}
.dd-meta{font-size:11px;color:var(--muted);margin-top:2px;font-family:var(--mono);}
.dd-genre-dot{display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:5px;vertical-align:middle;}

/* ── Buttons ── */
.btn{display:inline-flex;align-items:center;gap:8px;padding:11px 26px;border-radius:var(--radius);border:none;font-family:var(--sans);font-size:13.5px;font-weight:600;cursor:pointer;transition:all .2s cubic-bezier(.2,.8,.3,1);white-space:nowrap;letter-spacing:.03em;}
.btn-primary{background:linear-gradient(135deg,var(--accent) 0%,var(--accent2) 100%);color:#0a0808;font-weight:700;position:relative;overflow:hidden;}
.btn-primary::after{content:'';position:absolute;inset:0;background:linear-gradient(135deg,transparent 40%,#ffffff22 60%,transparent 61%);transform:translateX(-100%);transition:transform .4s;}
.btn-primary:hover:not(:disabled)::after{transform:translateX(100%);}
.btn-primary:hover:not(:disabled){transform:translateY(-2px);box-shadow:0 12px 40px var(--accent)55;}
.btn-ghost{background:transparent;color:var(--muted);border:1px solid var(--border2);}
.btn-ghost:hover:not(:disabled){background:var(--surface);color:var(--text);border-color:var(--border3);}
.btn-blue{background:linear-gradient(135deg,var(--blue)cc,var(--blue));color:#fff;font-weight:700;}
.btn-blue:hover:not(:disabled){opacity:.9;transform:translateY(-2px);box-shadow:0 12px 32px var(--blue)44;}
.btn-sm{padding:7px 14px;font-size:11.5px;border-radius:var(--radius-sm);}
.btn:disabled{opacity:.3;cursor:not-allowed;transform:none!important;}
.btn:active:not(:disabled){transform:translateY(0) scale(.97);}

/* ── Spinner ── */
.spinner{width:15px;height:15px;border:2px solid var(--border2);border-top-color:var(--accent);border-radius:50%;animation:spin .7s linear infinite;}
.spinner-lg{width:38px;height:38px;border:3px solid var(--border2);border-top-color:var(--accent);border-radius:50%;animation:spin .9s linear infinite;}

/* ── Context Panel ── */
.ctx-panel{
  background:linear-gradient(135deg,var(--card) 0%,var(--card2) 100%);
  border:1px solid var(--border2);border-radius:var(--radius-xl);
  padding:28px 32px;margin-bottom:36px;position:relative;overflow:hidden;
}
.ctx-panel::before{
  content:'';position:absolute;top:-60px;right:-60px;width:200px;height:200px;
  background:radial-gradient(circle,var(--accent)08,transparent);pointer-events:none;
}
.ctx-slot-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(88px,1fr));gap:8px;}
.ctx-slot{
  background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);
  padding:10px 8px;text-align:center;cursor:pointer;
  transition:all .2s cubic-bezier(.2,.8,.3,1);position:relative;overflow:hidden;
}
.ctx-slot::after{content:'';position:absolute;inset:0;background:var(--slot-color,var(--accent));opacity:0;transition:opacity .2s;}
.ctx-slot:hover::after{opacity:.05;}
.ctx-slot.active{
  border-color:var(--slot-color,var(--accent));
  box-shadow:0 0 0 1px var(--slot-color,var(--accent))44,0 8px 24px var(--slot-color,var(--accent))18;
  background:var(--slot-color,var(--accent))0e;
}
.ctx-slot-icon{font-size:18px;margin-bottom:3px;display:block;transition:transform .2s;}
.ctx-slot.active .ctx-slot-icon{transform:scale(1.15);}
.ctx-slot-label{font-family:var(--mono);font-size:10.5px;color:var(--text);display:block;font-weight:500;}
.ctx-slot-hours{font-family:var(--mono);font-size:8.5px;color:var(--muted);display:block;margin-top:1px;}
.ctx-weight-row{display:flex;align-items:center;gap:12px;margin-top:8px;}
.ctx-weight-label{font-family:var(--mono);font-size:10.5px;color:var(--muted);width:86px;flex-shrink:0;}
.ctx-weight-val{font-family:var(--mono);font-size:10.5px;color:var(--accent);width:30px;text-align:right;flex-shrink:0;}
input[type=range].ctx-slider{flex:1;accent-color:var(--accent);}

/* ── Context compare ── */
.ctx-compare{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);padding:20px 24px;margin-top:20px;}
.ctx-compare-row{display:flex;align-items:center;gap:10px;padding:5px 0;border-bottom:1px solid var(--border);font-family:var(--mono);font-size:11.5px;}
.ctx-compare-row:last-child{border-bottom:none;}
.ctx-rank{width:22px;text-align:right;color:var(--muted);flex-shrink:0;}
.ctx-item-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text);}
.ctx-delta{padding:2px 8px;border-radius:12px;font-size:9.5px;flex-shrink:0;}
.ctx-delta.up{background:var(--green)15;color:var(--green);border:1px solid var(--green)33;}
.ctx-delta.new{background:var(--accent)15;color:var(--accent);border:1px solid var(--accent)33;}
.ctx-delta.same{color:var(--muted);}
.ctx-delta.down{background:var(--red)0d;color:var(--red);border:1px solid var(--red)22;}

/* ── Explanation card ── */
.exp-card{
  background:linear-gradient(135deg,var(--card) 0%,var(--card2) 60%,var(--card3) 100%);
  border:1px solid var(--border2);border-radius:var(--radius-xl);
  padding:36px 40px;position:relative;overflow:hidden;
}
.exp-card::before{
  content:'\\201C';position:absolute;top:-30px;left:28px;
  font-family:var(--serif);font-size:200px;color:var(--accent);opacity:.05;
  line-height:1;pointer-events:none;
}
.exp-card::after{
  content:'';position:absolute;top:0;right:0;bottom:0;width:240px;
  background:radial-gradient(ellipse at right center,var(--accent)06,transparent);
  pointer-events:none;
}
.exp-paragraph{font-family:var(--serif);font-size:19px;line-height:2;color:var(--text);font-weight:400;position:relative;z-index:1;font-style:italic;animation:fadeIn .5s ease both;}
.exp-paragraph.arabic{font-family:var(--arabic);font-size:21px;line-height:2.2;direction:rtl;text-align:right;font-style:normal;}
.exp-skeleton-line{height:17px;border-radius:4px;background:linear-gradient(90deg,var(--card) 25%,#ffffff05 50%,var(--card) 75%);background-size:800px 100%;animation:shimmer 2s infinite;margin-bottom:12px;}
.exp-typing-dot{width:5px;height:5px;border-radius:50%;background:var(--accent);animation:typing 1.2s ease-in-out infinite;display:inline-block;margin-right:4px;}
.exp-typing-dot:nth-child(2){animation-delay:.2s}
.exp-typing-dot:nth-child(3){animation-delay:.4s}
.gemini-badge{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:20px;border:1px solid var(--border2);background:var(--surface);font-family:var(--mono);font-size:9.5px;color:var(--muted);flex-shrink:0;}
.gemini-dot{width:5px;height:5px;border-radius:50%;background:linear-gradient(135deg,#4285f4,#ea4335,#fbbc04,#34a853);flex-shrink:0;}
.lang-toggle{display:inline-flex;align-items:center;background:var(--surface);border:1px solid var(--border2);border-radius:24px;padding:3px;gap:2px;flex-shrink:0;}
.lang-btn{padding:4px 12px;border-radius:20px;border:none;cursor:pointer;font-size:11.5px;font-weight:500;transition:all .2s;background:transparent;letter-spacing:.02em;}
.lang-btn.en{font-family:var(--mono);color:var(--muted);}
.lang-btn.ar{font-family:var(--arabic);color:var(--muted);font-size:13px;}
.lang-btn.active{background:var(--card3);box-shadow:0 2px 8px #00000055;}
.lang-btn.en.active{color:var(--accent);}
.lang-btn.ar.active{color:var(--accent2);}

/* ── Charts ── */
.chart-box{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:22px 22px 18px;transition:border-color .2s;}
.chart-box:hover{border-color:var(--border2);}
.chart-title{font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.14em;color:var(--muted);margin-bottom:18px;}

/* ── Stat cards ── */
.stat-card{
  background:var(--card);border:1px solid var(--border);border-radius:var(--radius);
  padding:20px 22px;display:flex;flex-direction:column;gap:4px;
  transition:border-color .25s,transform .25s,box-shadow .25s;
  position:relative;overflow:hidden;
}
.stat-card::before{
  content:'';position:absolute;bottom:0;left:0;right:0;height:1px;
  background:linear-gradient(90deg,transparent,var(--accent)33,transparent);
  opacity:0;transition:opacity .3s;
}
.stat-card:hover{border-color:var(--border2);transform:translateY(-3px);box-shadow:0 12px 32px #00000055;}
.stat-card:hover::before{opacity:1;}
.stat-value{font-family:var(--serif);font-size:2.1rem;font-weight:700;color:var(--text);line-height:1;}
.stat-label{font-family:var(--mono);font-size:10px;color:var(--muted);letter-spacing:.08em;text-transform:uppercase;margin-top:4px;}
.stat-sub{font-family:var(--mono);font-size:10px;color:var(--muted);margin-top:2px;}

/* ── Gate bars ── */
.gate-row{display:flex;align-items:center;gap:12px;margin-bottom:12px;}
.gate-label{font-family:var(--mono);font-size:11px;color:var(--muted);width:60px;flex-shrink:0;display:flex;flex-direction:column;gap:1px;}
.gate-bar-wrap{flex:1;height:8px;background:var(--bg);border-radius:4px;overflow:hidden;}
.gate-bar{height:100%;border-radius:4px;transition:width 1.2s cubic-bezier(.2,.8,.3,1);}
.gate-pct{font-family:var(--mono);font-size:11px;width:36px;text-align:right;flex-shrink:0;}

/* ── Shimmer ── */
.shimmer{background:linear-gradient(90deg,var(--card) 25%,#ffffff05 50%,var(--card) 75%);background-size:800px 100%;animation:shimmer 2s infinite;border-radius:var(--radius-sm);}

/* ── Genre tags ── */
.genre-tag{display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border-radius:20px;font-family:var(--mono);font-size:9.5px;border:1px solid;letter-spacing:.03em;}

/* ── Influence chips ── */
.inf-chip{background:var(--surface);border:1px solid var(--border);border-radius:7px;padding:5px 11px;display:inline-flex;align-items:center;gap:6px;font-family:var(--mono);font-size:10.5px;color:var(--muted);transition:all .15s;}
.inf-chip.confirmed{border-color:var(--accent)44;color:var(--accent);}
.inf-chip.hidden-influence{border-color:var(--purple)44;color:var(--purple);}

/* ── Timeline ── */
.timeline-track{display:flex;align-items:center;overflow-x:auto;padding:12px 0;scrollbar-width:none;}
.timeline-track::-webkit-scrollbar{display:none;}
.tl-node{display:flex;flex-direction:column;align-items:center;gap:6px;flex-shrink:0;width:82px;position:relative;}
.tl-node::after{content:'';position:absolute;left:50%;top:28px;width:100%;height:1px;background:linear-gradient(90deg,var(--border2),transparent);z-index:0;}
.tl-node:last-child::after{display:none;}
.tl-circle{width:54px;height:54px;border-radius:50%;overflow:hidden;border:2px solid var(--border2);position:relative;z-index:1;background:var(--card);flex-shrink:0;transition:border-color .2s,box-shadow .2s;}
.tl-circle.active{border-color:var(--accent);box-shadow:0 0 12px var(--accent)33;}
.tl-idx{font-family:var(--mono);font-size:9px;color:var(--muted);text-align:center;white-space:nowrap;}
.tl-label{font-size:9.5px;font-weight:500;color:var(--text);text-align:center;max-width:76px;line-height:1.2;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}

/* ── Notice ── */
.notice-card{background:#c8a96e0e;border:1px solid #c8a96e2a;border-radius:var(--radius);padding:16px 20px;margin-bottom:24px;font-size:12.5px;line-height:1.7;color:var(--accent2);}
.apikey-notice{background:#4a7ce80e;border:1px solid #4a7ce833;border-radius:var(--radius);padding:16px 20px;margin-bottom:24px;font-size:12.5px;line-height:1.7;color:#a0bdf5;}
.apikey-notice a{color:var(--accent2);text-decoration:underline;text-underline-offset:3px;}

/* ── Gauge ── */
.gauge-card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:24px 20px 20px;display:flex;flex-direction:column;align-items:center;gap:14px;transition:border-color .2s,transform .2s;position:relative;overflow:hidden;}
.gauge-card:hover{border-color:var(--border2);transform:translateY(-2px);}
.gauge-card::after{content:'';position:absolute;bottom:0;left:0;right:0;height:2px;}
.gauge-card.green::after{background:linear-gradient(90deg,transparent,var(--green),transparent);}
.gauge-card.amber::after{background:linear-gradient(90deg,transparent,var(--accent),transparent);}
.gauge-card.blue::after{background:linear-gradient(90deg,transparent,var(--blue),transparent);}
.gauge-desc{font-family:var(--mono);font-size:9.5px;color:var(--muted);text-align:center;line-height:1.6;max-width:130px;}
.quality-bar-wrap{width:100%;height:3px;background:var(--bg);border-radius:2px;overflow:hidden;}
.quality-bar{height:100%;border-radius:2px;transition:width 1.8s cubic-bezier(.2,.8,.3,1);}

/* ── User explorer ── */
.user-chip{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px 14px;cursor:pointer;transition:all .2s;display:flex;align-items:center;justify-content:space-between;font-family:var(--mono);}
.user-chip:hover{border-color:var(--border2);background:var(--card);transform:translateX(3px);}
.user-chip.active{border-color:var(--blue)44;background:var(--blue)08;box-shadow:inset 3px 0 0 var(--blue);}
.user-chip-id{font-size:12.5px;color:var(--text);}
.user-chip-arrow{font-size:12px;color:var(--muted);}
.profile-card{background:linear-gradient(135deg,var(--card) 0%,var(--card2) 100%);border:1px solid var(--border2);border-radius:var(--radius-xl);padding:28px 32px;position:relative;overflow:hidden;}
.hit-indicator{display:inline-flex;align-items:center;gap:8px;padding:7px 16px;border-radius:var(--radius-sm);font-family:var(--mono);font-size:11.5px;font-weight:500;}
.hit-indicator.hit{background:var(--green)12;border:1px solid var(--green)33;color:var(--green);}
.hit-indicator.miss{background:var(--red)0d;border:1px solid var(--red)22;color:var(--red);}
.load-more-btn{width:100%;padding:12px;background:var(--surface);border:1px dashed var(--border2);border-radius:var(--radius-sm);cursor:pointer;color:var(--muted);font-family:var(--mono);font-size:11.5px;text-align:center;transition:all .2s;margin-top:8px;}
.load-more-btn:hover{border-color:var(--border3);color:var(--text);background:var(--card);}
.genre-bar-row{display:flex;align-items:center;gap:10px;margin-bottom:8px;}
.genre-bar-label{font-family:var(--mono);font-size:10.5px;width:72px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.genre-bar-track{flex:1;height:5px;background:var(--bg);border-radius:3px;overflow:hidden;}
.genre-bar-fill{height:100%;border-radius:3px;transition:width 1s cubic-bezier(.2,.8,.3,1);}
.genre-bar-count{font-family:var(--mono);font-size:9.5px;color:var(--muted);width:20px;text-align:right;}
.sidebar-search{width:100%;background:var(--surface);border:1px solid var(--border2);color:var(--text);border-radius:var(--radius-sm);padding:10px 14px 10px 34px;font-family:var(--mono);font-size:11.5px;outline:none;transition:border-color .2s;}
.sidebar-search:focus{border-color:var(--blue)44;}
.sidebar-search::placeholder{color:var(--muted);}

/* ── Movie grid ── */
.movie-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(118px,1fr));gap:10px;}
.movie-grid-lg{display:grid;grid-template-columns:repeat(auto-fill,minmax(142px,1fr));gap:12px;}

/* ── Ctx auto badge ── */
.ctx-auto-badge{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:20px;background:var(--green)12;border:1px solid var(--green)33;font-family:var(--mono);font-size:9.5px;color:var(--green);}

/* ── Context banner ── */
.ctx-banner{display:flex;align-items:center;gap:10px;padding:8px 16px;border-radius:var(--radius-sm);background:var(--ctx-bg,var(--accent)0d);border:1px solid var(--ctx-border,var(--accent)33);margin-bottom:18px;font-family:var(--mono);font-size:11.5px;}

/* ── Mobile ── */
@media(max-width:700px){
  .nav{padding:0 16px;}
  main{padding:20px 14px!important;}
  .exp-card{padding:22px 20px;}
  .exp-paragraph{font-size:16px;}
  .movie-grid{grid-template-columns:repeat(auto-fill,minmax(98px,1fr));}
  .movie-grid-lg{grid-template-columns:repeat(auto-fill,minmax(118px,1fr));}
  .tab-label{display:none;}
  .hero-title{font-size:2.8rem;}
  .ctx-slot-grid{grid-template-columns:repeat(2,1fr);}
}
`;

// ══════════════════════════════════════════════════════════════
// AMBIENT FILM FRAMES BACKGROUND
// ══════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════
// THREE.JS 3D CINEMATIC BACKGROUND
// ══════════════════════════════════════════════════════════════
function CinematicBackground3D() {
  const mountRef = useRef(null);
  const frameRef = useRef(null);

  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;

    // Dynamically load Three.js from CDN
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
    script.onload = () => initScene(el);
    document.head.appendChild(script);

    function initScene(container) {
      const W = window.innerWidth;
      const H = window.innerHeight;

      // ── Renderer ──
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
      renderer.setSize(W, H);
      renderer.setClearColor(0x000000, 0);
      container.appendChild(renderer.domElement);

      // ── Scene & Camera ──
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(60, W / H, 0.1, 200);
      camera.position.set(0, 0, 18);

      // ── Gold color ──
      const GOLD = 0xc8a96e;
      const GOLD_DIM = 0x5a4020;
      const PURPLE = 0x4a2a80;
      const BLUE = 0x1a2a60;

      // ─────────────────────────────────────────────
      // 1. STAR FIELD (deep background dots)
      // ─────────────────────────────────────────────
      const starGeo = new THREE.BufferGeometry();
      const starCount = 600;
      const starPos = new Float32Array(starCount * 3);
      for (let i = 0; i < starCount * 3; i++) {
        starPos[i] = (Math.random() - 0.5) * 160;
      }
      starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
      const starMat = new THREE.PointsMaterial({ color: 0xffffff, size: 0.06, transparent: true, opacity: 0.35 });
      scene.add(new THREE.Points(starGeo, starMat));

      // ─────────────────────────────────────────────
      // 2. FLOATING FILM REELS
      // ─────────────────────────────────────────────
      function makeReel(radius, tubeR, x, y, z, color, speed, tiltX, tiltZ) {
        const group = new THREE.Group();

        // Outer ring (torus)
        const torusGeo = new THREE.TorusGeometry(radius, tubeR, 16, 80);
        const torusMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.18, wireframe: false });
        const torus = new THREE.Mesh(torusGeo, torusMat);
        group.add(torus);

        // Inner ring
        const innerGeo = new THREE.TorusGeometry(radius * 0.55, tubeR * 0.7, 12, 60);
        const innerMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.12 });
        group.add(new THREE.Mesh(innerGeo, innerMat));

        // Hub (center circle)
        const hubGeo = new THREE.CircleGeometry(radius * 0.15, 16);
        const hubMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.20, side: THREE.DoubleSide });
        group.add(new THREE.Mesh(hubGeo, hubMat));

        // Spokes (6 spokes like a real film reel)
        for (let i = 0; i < 6; i++) {
          const angle = (i / 6) * Math.PI * 2;
          const spokeGeo = new THREE.CylinderGeometry(tubeR * 0.5, tubeR * 0.5, radius * 0.72, 4);
          const spokeMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.14 });
          const spoke = new THREE.Mesh(spokeGeo, spokeMat);
          spoke.position.set(Math.cos(angle) * radius * 0.36, Math.sin(angle) * radius * 0.36, 0);
          spoke.rotation.z = angle + Math.PI / 2;
          group.add(spoke);
        }

        // Sprocket holes (8 small circles around the edge)
        for (let i = 0; i < 8; i++) {
          const angle = (i / 8) * Math.PI * 2;
          const holeGeo = new THREE.CircleGeometry(radius * 0.07, 10);
          const holeMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22, side: THREE.DoubleSide });
          const hole = new THREE.Mesh(holeGeo, holeMat);
          hole.position.set(Math.cos(angle) * radius * 0.82, Math.sin(angle) * radius * 0.82, 0);
          group.add(hole);
        }

        group.position.set(x, y, z);
        group.rotation.x = tiltX;
        group.rotation.z = tiltZ;
        group.userData = { speed, floatOffset: Math.random() * Math.PI * 2 };
        scene.add(group);
        return group;
      }

      const reels = [
        makeReel(3.2, 0.08, -14, 5, -8, GOLD, 0.18, 0.3, 0.1),
        makeReel(2.4, 0.06, 13, -3, -6, GOLD_DIM, 0.12, -0.2, 0.4),
        makeReel(1.8, 0.05, -8, -7, -4, GOLD, 0.22, 0.5, -0.2),
        makeReel(4.0, 0.10, 16, 8, -12, PURPLE, 0.08, 0.1, 0.6),
        makeReel(1.4, 0.04, 6, 9, -3, GOLD_DIM, 0.30, -0.4, 0.3),
        makeReel(2.8, 0.07, -18, -2, -10, BLUE, 0.10, 0.6, -0.1),
      ];

      // ─────────────────────────────────────────────
      // 3. FLOATING FILM FRAMES (rectangular portals)
      // ─────────────────────────────────────────────
      function makeFilmFrame(w, h, x, y, z, color, speed, rx, ry, rz) {
        const group = new THREE.Group();

        // Outer border
        const outerEdges = new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, 0.02));
        const lineMat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.22 });
        group.add(new THREE.LineSegments(outerEdges, lineMat));

        // Inner border (inset)
        const innerEdges = new THREE.EdgesGeometry(new THREE.BoxGeometry(w * 0.85, h * 0.85, 0.02));
        const lineMat2 = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.12 });
        group.add(new THREE.LineSegments(innerEdges, lineMat2));

        // Corner accents — 4 small squares at corners
        const cornerSize = Math.min(w, h) * 0.1;
        [[-1, -1], [-1, 1], [1, -1], [1, 1]].forEach(([sx, sy]) => {
          const cEdges = new THREE.EdgesGeometry(new THREE.BoxGeometry(cornerSize, cornerSize, 0.01));
          const cMat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.35 });
          const corner = new THREE.LineSegments(cEdges, cMat);
          corner.position.set(sx * w * 0.5, sy * h * 0.5, 0);
          group.add(corner);
        });

        // Sprocket holes on top & bottom strip (like real 35mm film)
        for (let side = -1; side <= 1; side += 2) {
          for (let i = -2; i <= 2; i++) {
            const hGeo = new THREE.PlaneGeometry(w * 0.06, h * 0.07);
            const hMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.18, side: THREE.DoubleSide });
            const hole = new THREE.Mesh(hGeo, hMat);
            hole.position.set(i * w * 0.2, side * h * 0.44, 0);
            group.add(hole);
          }
        }

        group.position.set(x, y, z);
        group.rotation.set(rx, ry, rz);
        group.userData = { speed, floatOffset: Math.random() * Math.PI * 2, rx, ry, rz };
        scene.add(group);
        return group;
      }

      const frames3d = [
        makeFilmFrame(4.0, 3.0, -10, 2, -5, GOLD, 0.06, 0.2, 0.3, 0.05),
        makeFilmFrame(3.0, 2.2, 11, -5, -7, GOLD_DIM, 0.09, -0.1, -0.4, 0.08),
        makeFilmFrame(2.2, 1.6, 5, 6, -3, GOLD, 0.12, 0.4, 0.2, -0.06),
        makeFilmFrame(5.0, 3.8, -16, -8, -14, PURPLE, 0.04, 0.1, 0.5, 0.02),
        makeFilmFrame(2.8, 2.0, 17, 4, -9, BLUE, 0.07, -0.3, -0.2, 0.10),
        makeFilmFrame(1.8, 1.4, -4, -9, -2, GOLD_DIM, 0.15, 0.6, 0.1, -0.04),
      ];

      // ─────────────────────────────────────────────
      // 4. GOLD PARTICLE FIELD (floating dust)
      // ─────────────────────────────────────────────
      const particleCount = 280;
      const particleGeo = new THREE.BufferGeometry();
      const pPos = new Float32Array(particleCount * 3);
      const pVel = new Float32Array(particleCount * 3);
      const pPhase = new Float32Array(particleCount);

      for (let i = 0; i < particleCount; i++) {
        pPos[i * 3] = (Math.random() - 0.5) * 40;
        pPos[i * 3 + 1] = (Math.random() - 0.5) * 28;
        pPos[i * 3 + 2] = (Math.random() - 0.5) * 20 - 6;
        pVel[i * 3] = (Math.random() - 0.5) * 0.003;
        pVel[i * 3 + 1] = Math.random() * 0.004 + 0.001;
        pVel[i * 3 + 2] = (Math.random() - 0.5) * 0.002;
        pPhase[i] = Math.random() * Math.PI * 2;
      }
      particleGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
      const particleMat = new THREE.PointsMaterial({
        color: GOLD, size: 0.055, transparent: true, opacity: 0.55,
      });
      const particles = new THREE.Points(particleGeo, particleMat);
      scene.add(particles);

      // ─────────────────────────────────────────────
      // 5. LAZY DRIFT GRID (very subtle perspective grid)
      // ─────────────────────────────────────────────
      const gridGroup = new THREE.Group();
      const gridMat = new THREE.LineBasicMaterial({ color: 0xc8a96e, transparent: true, opacity: 0.04 });
      for (let i = -10; i <= 10; i += 2) {
        const hGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-20, i, -15), new THREE.Vector3(20, i, -15)]);
        const vGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(i * 2, -12, -15), new THREE.Vector3(i * 2, 12, -15)]);
        gridGroup.add(new THREE.Line(hGeo, gridMat));
        gridGroup.add(new THREE.Line(vGeo, gridMat));
      }
      scene.add(gridGroup);

      // ─────────────────────────────────────────────
      // 6. MOUSE PARALLAX
      // ─────────────────────────────────────────────
      let mouseX = 0, mouseY = 0;
      let targetX = 0, targetY = 0;
      const onMouseMove = (e) => {
        mouseX = (e.clientX / window.innerWidth - 0.5) * 2;
        mouseY = (e.clientY / window.innerHeight - 0.5) * 2;
      };
      window.addEventListener('mousemove', onMouseMove);

      // ─────────────────────────────────────────────
      // ANIMATION LOOP
      // ─────────────────────────────────────────────
      let t = 0;
      const animate = () => {
        frameRef.current = requestAnimationFrame(animate);
        t += 0.008;

        // Smooth camera parallax from mouse
        targetX += (mouseX * 1.8 - targetX) * 0.04;
        targetY += (-mouseY * 1.2 - targetY) * 0.04;
        camera.position.x = targetX;
        camera.position.y = targetY;
        camera.lookAt(0, 0, 0);

        // Spin & float reels
        reels.forEach((r, i) => {
          r.rotation.z += r.userData.speed * 0.016;
          r.position.y += Math.sin(t * 0.6 + r.userData.floatOffset) * 0.004;
          r.position.x += Math.cos(t * 0.4 + r.userData.floatOffset) * 0.002;
        });

        // Float & slow-rotate frames
        frames3d.forEach((f, i) => {
          f.position.y += Math.sin(t * 0.5 + f.userData.floatOffset) * 0.003;
          f.rotation.y += f.userData.speed * 0.008;
          f.rotation.x += f.userData.speed * 0.004;
        });

        // Drift grid gently
        gridGroup.rotation.z = Math.sin(t * 0.15) * 0.02;
        gridGroup.position.x = Math.sin(t * 0.1) * 0.3;

        // Animate particles (drift upward, wrap)
        const pos = particles.geometry.attributes.position.array;
        for (let i = 0; i < particleCount; i++) {
          const ix = i * 3, iy = i * 3 + 1, iz = i * 3 + 2;
          pos[ix] += pVel[ix] + Math.sin(t + pPhase[i]) * 0.0012;
          pos[iy] += pVel[iy];
          pos[iz] += pVel[iz];
          // Wrap top to bottom
          if (pos[iy] > 15) pos[iy] = -14;
          if (pos[ix] > 21) pos[ix] = -21;
          if (pos[ix] < -21) pos[ix] = 21;
        }
        particles.geometry.attributes.position.needsUpdate = true;

        // Pulse particle opacity with time
        particleMat.opacity = 0.45 + Math.sin(t * 0.7) * 0.15;

        renderer.render(scene, camera);
      };
      animate();

      // ── Resize handler ──
      const onResize = () => {
        const W2 = window.innerWidth, H2 = window.innerHeight;
        camera.aspect = W2 / H2;
        camera.updateProjectionMatrix();
        renderer.setSize(W2, H2);
      };
      window.addEventListener('resize', onResize);

      // ── Cleanup stored on ref ──
      mountRef.current._cleanup = () => {
        cancelAnimationFrame(frameRef.current);
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('resize', onResize);
        renderer.dispose();
        if (container.contains(renderer.domElement)) container.removeChild(renderer.domElement);
      };
    }

    return () => {
      if (mountRef.current?._cleanup) mountRef.current._cleanup();
    };
  }, []);

  return (
    <div
      ref={mountRef}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 0,
        pointerEvents: 'none',
        overflow: 'hidden',
      }}
    />
  );
}

// ══════════════════════════════════════════════════════════════
// FILM TICKER
// ══════════════════════════════════════════════════════════════
function FilmTicker({ movies }) {
  const titles = useMemo(() => {
    const all = Object.values(movies).slice(0, 30).map(m => m.title).filter(Boolean);
    return all.length ? all : ["Citizen Kane", "Vertigo", "2001: A Space Odyssey", "Casablanca", "Sunset Boulevard", "La Dolce Vita", "The Godfather", "Mulholland Drive", "Tokyo Story", "Stalker"];
  }, [movies]);
  const doubled = [...titles, ...titles];
  return (
    <div className="ticker-wrap">
      <div className="ticker-track">
        {doubled.map((t, i) => (
          <div key={i} className="ticker-item">
            <span>✦</span>{t}
          </div>
        ))}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// POSTER
// ══════════════════════════════════════════════════════════════
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

// ══════════════════════════════════════════════════════════════
// MOVIE CARD — with staggered reveal
// ══════════════════════════════════════════════════════════════
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
      style={{ "--ctx-color": ctxColor, animationDelay: `${delay}s`, animation: "cardReveal .5s cubic-bezier(.2,.8,.3,1) both" }}
    >
      <Poster title={title} year={year} genres={genres} cache={cache} onNeeded={onNeeded} />
      <div className="pcard-info">
        <div className="pcard-title">{title}</div>
        <div className="pcard-year">{year || ""}</div>
        {showGenre && genres[0] && <div className="pcard-genre" style={{ color }}>{genres[0]}</div>}
      </div>
      {rank != null && <div className="rank-badge">#{rank}</div>}
      {isHit && <div className="hit-badge">✓</div>}
      {ctxBoosted && ctxLabel && <div className="ctx-badge" style={{ "--ctx-color": ctxColor }}>{ctxLabel}</div>}
      {onRemove && <button className="remove-btn" onClick={e => { e.stopPropagation(); onRemove(idx); }}>×</button>}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// MOVIE SEARCH
// ══════════════════════════════════════════════════════════════
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
          <div style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--mono)" }}>+ Add</div>
        </div>
      ))}
    </div>, document.body
  );
  return (
    <div className="search-wrap" ref={wrapRef}>
      <span className="search-icon">🔍</span>
      <input ref={inputRef} className="search-input" value={q}
        onChange={e => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)}
        placeholder="Search — Inception, Parasite, Mulholland Drive…" />
      {dropdown}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// CONTEXT SELECTOR
// ══════════════════════════════════════════════════════════════
function ContextSelector({ todSlot, setTodSlot, seasonSlot, setSeasonSlot, todWeight, setTodWeight, seasonWeight, setSeasonWeight, contextEnabled, setContextEnabled }) {
  const autoTod = getCurrentTod();
  const autoSeason = getCurrentSeason();
  const todSlotInfo = TOD_SLOTS[todSlot];
  const seasonSlotInfo = SEASON_SLOTS[seasonSlot];
  const todColor = TOD_COLORS[todSlotInfo?.key] || "var(--accent)";
  const seasonColor = SEASON_COLORS[seasonSlotInfo?.key] || "var(--accent)";
  return (
    <div className="ctx-panel">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div className="section-label" style={{ margin: 0 }}>Context-aware screening</div>
          <div className="ctx-auto-badge"><span style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--green)", display: "inline-block" }} />New</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => { setTodSlot(autoTod); setSeasonSlot(autoSeason); }}>⟳ Auto-detect</button>
          <div onClick={() => setContextEnabled(v => !v)} style={{ width: 38, height: 22, borderRadius: 11, background: contextEnabled ? "var(--green)" : "var(--surface)", border: `1px solid ${contextEnabled ? "var(--green)" : "var(--border2)"}`, position: "relative", cursor: "pointer", transition: "all .2s", flexShrink: 0 }}>
            <div style={{ width: 16, height: 16, borderRadius: 8, background: "#fff", position: "absolute", top: 2, left: contextEnabled ? 19 : 2, transition: "left .2s" }} />
          </div>
          <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: contextEnabled ? "var(--green)" : "var(--muted)" }}>{contextEnabled ? "ON" : "OFF"}</span>
        </div>
      </div>
      {contextEnabled && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, marginBottom: 20 }}>
            <div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)", marginBottom: 10, letterSpacing: ".1em", textTransform: "uppercase" }}>
                Time of Day <span style={{ marginLeft: 8, color: todColor }}>— {todSlotInfo?.label}</span>
              </div>
              <div className="ctx-slot-grid">
                {TOD_SLOTS.map((s, i) => (
                  <div key={s.key} className={`ctx-slot${todSlot === i ? " active" : ""}`} style={{ "--slot-color": TOD_COLORS[s.key] }} onClick={() => setTodSlot(i)}>
                    <span className="ctx-slot-icon">{s.icon}</span>
                    <span className="ctx-slot-label" style={{ color: todSlot === i ? TOD_COLORS[s.key] : undefined }}>{s.label}</span>
                    <span className="ctx-slot-hours">{s.hours}</span>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)", marginBottom: 10, letterSpacing: ".1em", textTransform: "uppercase" }}>
                Season <span style={{ marginLeft: 8, color: seasonColor }}>— {seasonSlotInfo?.label}</span>
              </div>
              <div className="ctx-slot-grid">
                {SEASON_SLOTS.map((s, i) => (
                  <div key={s.key} className={`ctx-slot${seasonSlot === i ? " active" : ""}`} style={{ "--slot-color": SEASON_COLORS[s.key] }} onClick={() => setSeasonSlot(i)}>
                    <span className="ctx-slot-icon">{s.icon}</span>
                    <span className="ctx-slot-label" style={{ color: seasonSlot === i ? SEASON_COLORS[s.key] : undefined }}>{s.label}</span>
                    <span className="ctx-slot-hours">{s.months}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div style={{ borderTop: "1px solid var(--border)", paddingTop: 18 }}>
            <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)", marginBottom: 14, letterSpacing: ".1em", textTransform: "uppercase" }}>Bias strength</div>
            <div className="ctx-weight-row">
              <span className="ctx-weight-label">Time-of-Day</span>
              <input type="range" className="ctx-slider" min="0" max="0.5" step="0.05" value={todWeight} onChange={e => setTodWeight(parseFloat(e.target.value))} />
              <span className="ctx-weight-val">{todWeight.toFixed(2)}</span>
            </div>
            <div className="ctx-weight-row">
              <span className="ctx-weight-label">Season</span>
              <input type="range" className="ctx-slider" min="0" max="0.5" step="0.05" value={seasonWeight} onChange={e => setSeasonWeight(parseFloat(e.target.value))} />
              <span className="ctx-weight-val">{seasonWeight.toFixed(2)}</span>
            </div>
          </div>
        </>
      )}
      {!contextEnabled && (
        <div style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--muted)", lineHeight: 1.8, paddingTop: 4 }}>
          Enable to surface films that match your time of day and season — lighter comedies in the morning, thrillers at night, cozy dramas in winter.
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// CONTEXT COMPARE PANEL
// ══════════════════════════════════════════════════════════════
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
        <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)", letterSpacing: ".1em", textTransform: "uppercase" }}>Rank shifts · {ctxLabel}</div>
        <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: changed > 0 ? "var(--accent)" : "var(--muted)" }}>{changed}/{rows.length} positions shifted</div>
      </div>
      {rows.map(({ r, m, ctxRank, delta, isNew }) => {
        let deltaEl;
        if (isNew) deltaEl = <span className="ctx-delta new">new</span>;
        else if (delta > 0) deltaEl = <span className="ctx-delta up">↑{delta}</span>;
        else if (delta < 0) deltaEl = <span className="ctx-delta down">↓{Math.abs(delta)}</span>;
        else deltaEl = <span className="ctx-delta same">—</span>;
        return (
          <div key={r.item_id} className="ctx-compare-row">
            <span className="ctx-rank">#{ctxRank}</span>
            <span className="ctx-item-title">{m?.title || `#${r.item_id}`}</span>
            {m?.genres?.[0] && <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: gcolor(m.genres), flexShrink: 0 }}>{m.genres[0]}</span>}
            {deltaEl}
          </div>
        );
      })}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// CHARTS
// ══════════════════════════════════════════════════════════════
const CHART_OPTS = {
  plugins: { legend: { display: false }, tooltip: { backgroundColor: "#0f0f1c", borderColor: "#ffffff14", borderWidth: 1, titleColor: "#f4f0e8", bodyColor: "#c8a96e", padding: 10 } },
};
function GenreRadar({ picked, movies }) {
  const ref = useRef(null); const chartRef = useRef(null);
  const data = useMemo(() => { const freq = {}; picked.forEach(p => { const id = p.idx ?? p; (movies?.[String(id)]?.genres || []).forEach(g => { freq[g] = (freq[g] || 0) + 1; }); }); return Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 8); }, [picked, movies]);
  useEffect(() => {
    if (!ref.current || data.length < 3) return;
    if (chartRef.current) chartRef.current.destroy();
    chartRef.current = new Chart(ref.current, { type: "radar", data: { labels: data.map(([g]) => g), datasets: [{ data: data.map(([, v]) => v), backgroundColor: "rgba(200,169,110,0.1)", borderColor: "rgba(200,169,110,0.8)", borderWidth: 2, pointBackgroundColor: "rgba(200,169,110,1)", pointBorderColor: "transparent", pointRadius: 4 }] }, options: { ...CHART_OPTS, responsive: true, maintainAspectRatio: false, scales: { r: { backgroundColor: "transparent", grid: { color: "#ffffff06" }, angleLines: { color: "#ffffff06" }, ticks: { display: false }, pointLabels: { color: "#8a8aaa", font: { family: "JetBrains Mono", size: 11 } } } } } });
    return () => chartRef.current?.destroy();
  }, [data]);
  if (data.length < 3) return null;
  return <div className="chart-box"><div className="chart-title">Taste radar — genre profile</div><div style={{ height: 220 }}><canvas ref={ref} /></div></div>;
}
function AttentionChart({ influence, movies }) {
  const ref = useRef(null); const chartRef = useRef(null);
  useEffect(() => {
    if (!ref.current || !influence?.length) return;
    if (chartRef.current) chartRef.current.destroy();
    const top = [...influence].sort((a, b) => b.attention - a.attention).slice(0, 8);
    const labels = top.map(d => { const t = movies?.[String(d.item_id)]?.title || `#${d.item_id}`; return t.length > 20 ? t.slice(0, 18) + "…" : t; });
    const colors = top.map(d => gcolor(movies?.[String(d.item_id)]?.genres));
    chartRef.current = new Chart(ref.current, { type: "bar", data: { labels, datasets: [{ data: top.map(d => Math.round(d.attention * 100)), backgroundColor: colors.map(c => c + "66"), borderColor: colors, borderWidth: 1.5, borderRadius: 7 }] }, options: { ...CHART_OPTS, indexAxis: "y", responsive: true, maintainAspectRatio: false, scales: { x: { grid: { color: "#ffffff04" }, ticks: { color: "#5a5a72", font: { family: "JetBrains Mono", size: 11 }, callback: v => `${v}%` }, border: { display: false } }, y: { grid: { display: false }, ticks: { color: "#f4f0e8", font: { family: "Syne", size: 12 } }, border: { display: false } } } } });
    return () => chartRef.current?.destroy();
  }, [influence, movies]);
  return <div className="chart-box"><div className="chart-title">Transformer attention weights</div><div style={{ height: Math.min(influence?.length || 6, 8) * 44 + 20 }}><canvas ref={ref} /></div></div>;
}
function GateChart({ gates }) {
  const ref = useRef(null); const chartRef = useRef(null);
  useEffect(() => {
    if (!ref.current || !gates) return;
    if (chartRef.current) chartRef.current.destroy();
    chartRef.current = new Chart(ref.current, { type: "doughnut", data: { labels: ["Graph Network", "Long-term Memory", "Sequential"], datasets: [{ data: [Math.round(gates.gcn * 100), Math.round(gates.memory * 100), Math.round(gates.seq * 100)], backgroundColor: ["#4a7ce81a", "#3db87a1a", "#c8a96e1a"], borderColor: ["#4a7ce8", "#3db87a", "#c8a96e"], borderWidth: 2, hoverOffset: 8 }] }, options: { responsive: true, maintainAspectRatio: false, cutout: "74%", plugins: { legend: { position: "bottom", labels: { color: "#5a5a72", font: { family: "JetBrains Mono", size: 10.5 }, padding: 14, boxWidth: 10, borderRadius: 4 } }, tooltip: { callbacks: { label: ctx => ` ${ctx.parsed}% contribution` }, ...CHART_OPTS.plugins.tooltip } } } });
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
    chartRef.current = new Chart(ref.current, { type: "bar", data: { labels, datasets: [{ label: "Score", data: top10.map(r => r.score?.toFixed ? parseFloat(r.score.toFixed(3)) : r.score), backgroundColor: colors.map(c => c + "44"), borderColor: colors, borderWidth: 1.5, borderRadius: 7, borderSkipped: false }] }, options: { ...CHART_OPTS, responsive: true, maintainAspectRatio: false, scales: { x: { grid: { display: false }, ticks: { color: "#5a5a7277", font: { family: "Syne", size: 11 }, maxRotation: 38 }, border: { display: false } }, y: { grid: { color: "#ffffff04" }, ticks: { color: "#5a5a72", font: { family: "JetBrains Mono", size: 11 } }, border: { display: false } } } } });
    return () => chartRef.current?.destroy();
  }, [recommendations, movies]);
  return <div className="chart-box"><div className="chart-title">Relevance scores — top 10</div><div style={{ height: 210 }}><canvas ref={ref} /></div></div>;
}
function RecGenreChart({ recommendations, movies }) {
  const ref = useRef(null); const chartRef = useRef(null);
  useEffect(() => {
    if (!ref.current || !recommendations?.length) return;
    if (chartRef.current) chartRef.current.destroy();
    const freq = {}; recommendations.forEach(r => { const g = movies?.[String(r.item_id)]?.genres?.[0] || "Unknown"; freq[g] = (freq[g] || 0) + 1; });
    const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]);
    chartRef.current = new Chart(ref.current, { type: "polarArea", data: { labels: sorted.map(([g]) => g), datasets: [{ data: sorted.map(([, v]) => v), backgroundColor: sorted.map(([g]) => (GENRE_COLORS[g] || "#888") + "44"), borderColor: sorted.map(([g]) => GENRE_COLORS[g] || "#888"), borderWidth: 1.5 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "right", labels: { color: "#5a5a72", font: { family: "JetBrains Mono", size: 10.5 }, padding: 12, boxWidth: 10 } }, tooltip: { ...CHART_OPTS.plugins.tooltip } }, scales: { r: { grid: { color: "#ffffff06" }, ticks: { display: false } } } } });
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
    chartRef.current = new Chart(ref.current, { type: "line", data: { labels: pts.map((_, i) => `#${i + 1}`), datasets: [{ data: pts.map(r => r.score?.toFixed ? parseFloat(r.score.toFixed(4)) : r.score), fill: true, backgroundColor: "rgba(200,169,110,0.07)", borderColor: "rgba(200,169,110,0.85)", borderWidth: 2, pointBackgroundColor: "rgba(200,169,110,1)", pointRadius: 4, pointHoverRadius: 7, tension: .45 }] }, options: { ...CHART_OPTS, responsive: true, maintainAspectRatio: false, plugins: { ...CHART_OPTS.plugins, tooltip: { ...CHART_OPTS.plugins.tooltip, callbacks: { title: ctx => { const r = recommendations[ctx[0].dataIndex]; return movies?.[String(r.item_id)]?.title || `#${r.item_id}`; }, label: ctx => ` Score: ${ctx.parsed.y}` } } }, scales: { x: { grid: { display: false }, ticks: { color: "#5a5a72", font: { family: "JetBrains Mono", size: 11 } }, border: { display: false } }, y: { grid: { color: "#ffffff04" }, ticks: { color: "#5a5a72", font: { family: "JetBrains Mono", size: 11 } }, border: { display: false } } } } });
    return () => chartRef.current?.destroy();
  }, [recommendations, movies]);
  return <div className="chart-box"><div className="chart-title">Score decay curve</div><div style={{ height: 180 }}><canvas ref={ref} /></div></div>;
}
function ContextScoreChart({ baseRecs, ctxRecs, movies, ctxColor }) {
  const ref = useRef(null); const chartRef = useRef(null);
  useEffect(() => {
    if (!ref.current || !baseRecs?.length || !ctxRecs?.length) return;
    if (chartRef.current) chartRef.current.destroy();
    const allIds = [...new Set([...ctxRecs.slice(0, 8).map(r => r.item_id), ...baseRecs.slice(0, 8).map(r => r.item_id)])].slice(0, 8);
    const baseMap = {}; baseRecs.forEach(r => { baseMap[r.item_id] = r.score; });
    const ctxMap = {}; ctxRecs.forEach(r => { ctxMap[r.item_id] = r.score; });
    const labels = allIds.map(id => { const t = movies?.[String(id)]?.title || `#${id}`; return t.length > 14 ? t.slice(0, 12) + "…" : t; });
    chartRef.current = new Chart(ref.current, { type: "bar", data: { labels, datasets: [{ label: "Base", data: allIds.map(id => baseMap[id] != null ? parseFloat((baseMap[id]).toFixed(3)) : 0), backgroundColor: "#88878055", borderColor: "#888780", borderWidth: 1.5, borderRadius: 4 }, { label: "Context", data: allIds.map(id => ctxMap[id] != null ? parseFloat((ctxMap[id]).toFixed(3)) : 0), backgroundColor: ctxColor + "66", borderColor: ctxColor, borderWidth: 1.5, borderRadius: 4 }] }, options: { ...CHART_OPTS, responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "top", labels: { color: "#8a8aaa", font: { family: "JetBrains Mono", size: 10.5 }, padding: 14, boxWidth: 10 } }, tooltip: { ...CHART_OPTS.plugins.tooltip } }, scales: { x: { grid: { display: false }, ticks: { color: "#5a5a7277", font: { family: "Syne", size: 11 }, maxRotation: 32 }, border: { display: false } }, y: { grid: { color: "#ffffff04" }, ticks: { color: "#5a5a72", font: { family: "JetBrains Mono", size: 11 } }, border: { display: false } } } } });
    return () => chartRef.current?.destroy();
  }, [baseRecs, ctxRecs, movies, ctxColor]);
  return <div className="chart-box"><div className="chart-title">Base vs context scores</div><div style={{ height: 210 }}><canvas ref={ref} /></div></div>;
}

// ══════════════════════════════════════════════════════════════
// GATE BARS
// ══════════════════════════════════════════════════════════════
function GateBars({ gates }) {
  const items = [
    { label: "GCN", val: gates.gcn, color: "#4a7ce8", desc: "Collaborative" },
    { label: "Memory", val: gates.memory, color: "#3db87a", desc: "Long-term" },
    { label: "Seq", val: gates.seq, color: "#c8a96e", desc: "Sequential" },
  ];
  return (
    <div>
      {items.map(({ label, val, color, desc }) => (
        <div key={label} className="gate-row">
          <div className="gate-label">
            <span style={{ fontFamily: "var(--mono)", fontSize: 11.5, color }}>{label}</span>
            <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--muted)" }}>{desc}</span>
          </div>
          <div className="gate-bar-wrap"><div className="gate-bar" style={{ width: `${Math.round(val * 100)}%`, background: `linear-gradient(90deg,${color}66,${color})` }} /></div>
          <div className="gate-pct" style={{ color, fontFamily: "var(--mono)", fontSize: 11.5 }}>{Math.round(val * 100)}%</div>
        </div>
      ))}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// ARC GAUGE
// ══════════════════════════════════════════════════════════════
function ArcGauge({ value, color, size = 88 }) {
  const r = 36, cx = 48, cy = 48, circ = 2 * Math.PI * r;
  const filled = circ * Math.min(value, 1);
  return (
    <svg viewBox="0 0 96 96" width={size} height={size} style={{ overflow: "visible", display: "block" }}>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="#ffffff07" strokeWidth={7} />
      <circle cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth={7}
        strokeDasharray={`${filled} ${circ - filled}`} strokeDashoffset={circ * .25} strokeLinecap="round"
        style={{ transition: "stroke-dasharray 1.8s cubic-bezier(.2,.8,.3,1)" }} />
      <text x={cx} y={cy + 2} textAnchor="middle" dominantBaseline="middle" fill="#f4f0e8" fontSize="14" fontFamily="'Cormorant Garamond',serif" fontWeight="700">
        {(value * 100).toFixed(1)}%
      </text>
    </svg>
  );
}
function MetricGaugeCard({ label, k, value, color, colorClass, description }) {
  const pct = Math.min(value, 1);
  const getQ = (lbl, v) => {
    const ranges = { HR: { great: .42, good: .35, ok: .25 }, NDCG: { great: .28, good: .22, ok: .15 }, MRR: { great: .22, good: .16, ok: .10 } };
    const r = ranges[lbl]; if (!r) return { label: "", color: "var(--muted)" };
    if (v >= r.great) return { label: "Excellent", color: "#3db87a" };
    if (v >= r.good) return { label: "Good", color: "#c8a96e" };
    if (v >= r.ok) return { label: "Fair", color: "#4a7ce8" };
    return { label: "Training", color: "#8b6be8" };
  };
  const quality = getQ(label, value);
  return (
    <div className={`gauge-card ${colorClass}`} style={{ flex: 1, minWidth: 160 }}>
      <ArcGauge value={pct} color={color} size={88} />
      <div style={{ textAlign: "center" }}>
        <div style={{ fontFamily: "var(--mono)", fontSize: 13, color, letterSpacing: ".06em" }}>{label}@{k}</div>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 4, marginTop: 6, padding: "2px 10px", borderRadius: 20, border: `1px solid ${quality.color}33`, background: `${quality.color}0d`, fontFamily: "var(--mono)", fontSize: 9.5, color: quality.color }}>{quality.label}</div>
      </div>
      <div className="quality-bar-wrap"><div className="quality-bar" style={{ width: `${pct * 100}%`, background: `linear-gradient(90deg,${color}55,${color})` }} /></div>
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
    hr !== null && { label: "HR", k, value: hr, color: "#3db87a", colorClass: "green", description: "Fraction of users whose true next item appeared in top-K" },
    ndcg !== null && { label: "NDCG", k, value: ndcg, color: "#c8a96e", colorClass: "amber", description: "Position-sensitive ranking quality metric" },
    mrr !== null && { label: "MRR", k, value: mrr, color: "#4a7ce8", colorClass: "blue", description: "Mean reciprocal rank of the first relevant item" },
  ].filter(Boolean);
  return (
    <section className="fade-up" style={{ animationDelay: ".07s" }}>
      <div className="section-label">Evaluation metrics</div>
      <div style={{ background: "linear-gradient(135deg,var(--card) 0%,var(--card2) 100%)", border: "1px solid var(--border2)", borderRadius: "var(--radius-xl)", padding: "28px 28px 24px", position: "relative", overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24, flexWrap: "wrap", gap: 10 }}>
          <div>
            <div style={{ fontFamily: "var(--serif)", fontSize: 18, fontWeight: 700, color: "var(--text)", fontStyle: "italic" }}>Held-out test set performance</div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--muted)", marginTop: 4 }}>Sampled evaluation · 99 negatives per user · MovieLens 1M</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 14px", background: "var(--surface)", border: "1px solid var(--border2)", borderRadius: 20, fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--muted2)" }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#3db87a", display: "inline-block" }} />Top-{k} evaluation
          </div>
        </div>
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
          {gauges.map(g => <MetricGaugeCard key={g.label} {...g} />)}
        </div>
      </div>
    </section>
  );
}

// ══════════════════════════════════════════════════════════════
// STATS ROW
// ══════════════════════════════════════════════════════════════
function StatsRow({ picked, recommendations, movies, expData, contextEnabled, todSlot, seasonSlot }) {
  const avgYear = useMemo(() => { const ids = picked.map(p => p.idx ?? p); const years = ids.map(i => movies?.[String(i)]?.year).filter(Boolean); if (!years.length) return null; return Math.round(years.reduce((a, b) => a + b, 0) / years.length); }, [picked, movies]);
  const genres = useMemo(() => { const freq = {}; picked.map(p => p.idx ?? p).forEach(i => { (movies?.[String(i)]?.genres || []).forEach(g => { freq[g] = (freq[g] || 0) + 1; }); }); return Object.entries(freq).sort((a, b) => b[1] - a[1]); }, [picked, movies]);
  const topGate = useMemo(() => { if (!expData?.component_weights) return null; const g = expData.component_weights; if (g.gcn >= g.memory && g.gcn >= g.seq) return { label: "Collaborative", color: "#4a7ce8" }; if (g.memory >= g.seq) return { label: "Memory-driven", color: "#3db87a" }; return { label: "Sequential", color: "#c8a96e" }; }, [expData]);
  const todInfo = contextEnabled && todSlot != null ? TOD_SLOTS[todSlot] : null;
  const seasonInfo = contextEnabled && seasonSlot != null ? SEASON_SLOTS[seasonSlot] : null;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(136px,1fr))", gap: 10, marginBottom: 36 }} className="fade-up">
      <div className="stat-card"><div className="stat-value">{recommendations?.length || 0}</div><div className="stat-label">Picks generated</div></div>
      <div className="stat-card"><div className="stat-value">{picked.length}</div><div className="stat-label">History films</div></div>
      {avgYear && <div className="stat-card"><div className="stat-value">{avgYear}</div><div className="stat-label">Avg watch year</div></div>}
      {genres[0] && <div className="stat-card"><div className="stat-value" style={{ fontSize: "1.3rem", color: gcolor([genres[0][0]]) }}>{genres[0][0]}</div><div className="stat-label">Top genre</div><div className="stat-sub">{genres.length} genres total</div></div>}
      {topGate && <div className="stat-card"><div className="stat-value" style={{ fontSize: "1rem", color: topGate.color, marginTop: 4 }}>{topGate.label}</div><div className="stat-label">Dominant signal</div></div>}
      {todInfo && <div className="stat-card" style={{ borderColor: TOD_COLORS[todInfo.key] + "33" }}><div className="stat-value" style={{ fontSize: "1.5rem" }}>{todInfo.icon}</div><div className="stat-label" style={{ color: TOD_COLORS[todInfo.key] }}>{todInfo.label}</div><div className="stat-sub">{todInfo.hours}</div></div>}
      {seasonInfo && <div className="stat-card" style={{ borderColor: SEASON_COLORS[seasonInfo.key] + "33" }}><div className="stat-value" style={{ fontSize: "1.5rem" }}>{seasonInfo.icon}</div><div className="stat-label" style={{ color: SEASON_COLORS[seasonInfo.key] }}>{seasonInfo.label}</div><div className="stat-sub">{seasonInfo.months}</div></div>}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// HISTORY TIMELINE
// ══════════════════════════════════════════════════════════════
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
          const isActive = attn !== undefined && attn >= .1;
          return (
            <div key={p.idx} className="tl-node">
              <div className="tl-circle" style={{ borderColor: isActive ? gcolor(m?.genres) : undefined }}>
                <Poster title={m?.title} year={m?.year} genres={m?.genres} cache={cache} onNeeded={onNeeded} small />
              </div>
              <div className="tl-label" style={{ color: isActive ? "var(--text)" : "var(--muted)" }}>{m?.title ? (m.title.length > 10 ? m.title.slice(0, 9) + "…" : m.title) : `#${p.idx}`}</div>
              {attn !== undefined ? <div className="tl-idx" style={{ color: isActive ? "var(--accent)" : "var(--muted)" }}>{Math.round(attn * 100)}%</div> : <div className="tl-idx">#{i + 1}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// LANGUAGE TOGGLE
// ══════════════════════════════════════════════════════════════
function LangToggle({ lang, onChange, loadingLang }) {
  return (
    <div className="lang-toggle">
      <button className={`lang-btn en${lang === "en" ? " active" : ""}`} onClick={() => onChange("en")} disabled={loadingLang === "en"}>
        {loadingLang === "en" ? "…" : "EN"}
      </button>
      <button className={`lang-btn ar${lang === "ar" ? " active" : ""}`} onClick={() => onChange("ar")} disabled={loadingLang === "ar"}>
        {loadingLang === "ar" ? "…" : "العربية"}
      </button>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// EXPLANATION PANEL
// ══════════════════════════════════════════════════════════════
function ExplanationPanel({ picked, recData, expData, movies, requestKey, todSlot, seasonSlot, contextEnabled }) {
  const [lang, setLang] = useState("en");
  const [texts, setTexts] = useState({ en: null, ar: null });
  const [loadingLang, setLoadingLang] = useState(null);
  const [noApiKey] = useState(GEMINI_API_KEY === "YOUR_GEMINI_API_KEY_HERE");
  const genRef = useRef(0);
  const payload = useMemo(() => ({ picked, recommendations: recData?.recommendations || [], movies, gates: expData?.component_weights ?? null, historyInfluence: expData?.history_influence ?? [], shapNorm: expData?.shap_norm ?? null, todSlot: contextEnabled ? todSlot : null, seasonSlot: contextEnabled ? seasonSlot : null }), [requestKey]);
  useEffect(() => {
    if (!recData?.recommendations?.length || !picked?.length || noApiKey) return;
    const id = ++genRef.current;
    setTexts({ en: null, ar: null }); setLoadingLang("en");
    generateGeminiExplanation({ ...payload, lang: "en" }).then(text => {
      if (genRef.current !== id) return;
      setTexts(t => ({ ...t, en: text })); setLoadingLang(null);
    });
  }, [requestKey]);
  const handleLangChange = async (newLang) => {
    setLang(newLang);
    if (newLang === "ar" && !texts.ar && !noApiKey) {
      setLoadingLang("ar");
      const text = await generateGeminiExplanation({ ...payload, lang: "ar" });
      setTexts(t => ({ ...t, ar: text })); setLoadingLang(null);
    }
  };
  const topDriver = expData?.history_influence?.[0];
  const topTitle = topDriver ? movies[String(topDriver.item_id)]?.title : null;
  const classified = useMemo(() =>
    (expData?.history_influence || []).slice(0, 5).map(d => {
      const attn = d.attention ?? 0;
      const shap = expData?.shap_norm?.[d.position] ?? null;
      const isKey = attn >= .1;
      const isHidden = shap !== null && shap >= .1 && !isKey;
      return { ...d, isKey, isHidden };
    }), [expData]);
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
          {topTitle && <span style={{ color: "var(--accent)", marginLeft: 4, fontFamily: "var(--sans)", fontSize: 10.5, fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>· anchored by {topTitle}</span>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {todInfo && <div style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "2px 10px", borderRadius: 20, border: `1px solid ${TOD_COLORS[todInfo.key]}44`, background: TOD_COLORS[todInfo.key] + "0e", fontFamily: "var(--mono)", fontSize: 9.5, color: TOD_COLORS[todInfo.key] }}>{todInfo.icon} {todInfo.label}</div>}
          {seasonInfo && <div style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "2px 10px", borderRadius: 20, border: `1px solid ${SEASON_COLORS[seasonInfo.key]}44`, background: SEASON_COLORS[seasonInfo.key] + "0e", fontFamily: "var(--mono)", fontSize: 9.5, color: SEASON_COLORS[seasonInfo.key] }}>{seasonInfo.icon} {seasonInfo.label}</div>}
          <div className="gemini-badge"><div className="gemini-dot" />Gemini</div>
          <LangToggle lang={lang} onChange={handleLangChange} loadingLang={loadingLang} />
        </div>
      </div>
      {noApiKey && <div className="apikey-notice">🔑 Add your Gemini API key to enable AI explanations. Get one free at <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer">aistudio.google.com</a>.</div>}
      {isLoading && !noApiKey && (
        <div>
          <div className="exp-skeleton-line" style={{ width: "96%" }} />
          <div className="exp-skeleton-line" style={{ width: "88%" }} />
          <div className="exp-skeleton-line" style={{ width: "92%" }} />
          <div className="exp-skeleton-line" style={{ width: "68%" }} />
          <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8 }}>
            <span className="exp-typing-dot" /><span className="exp-typing-dot" /><span className="exp-typing-dot" />
            <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--muted)" }}>Reading your taste profile…</span>
          </div>
        </div>
      )}
      {currentText && !isLoading && (
        <p key={`${lang}-${requestKey}`} className={`exp-paragraph${isArabic ? " arabic" : ""}`} style={isArabic ? { textAlign: "right", direction: "rtl" } : {}}>
          {currentText}
        </p>
      )}
      {classified.length > 0 && (
        <div style={{ marginTop: 24, display: "flex", gap: 8, flexWrap: "wrap" }}>
          {classified.map(d => {
            const m = movies[String(d.item_id)];
            const title = m?.title ? (m.title.length > 18 ? m.title.slice(0, 16) + "…" : m.title) : `#${d.item_id}`;
            return (
              <div key={d.item_id} className={`inf-chip${d.isKey ? " confirmed" : d.isHidden ? " hidden-influence" : ""}`}>
                <span style={{ color: "var(--text)", fontFamily: "var(--sans)", fontSize: 11.5 }}>{title}</span>
                <span style={{ color: "var(--muted)" }}>·</span>
                <span>{Math.round(d.attention * 100)}%</span>
                {d.isKey && <span style={{ fontSize: 9.5 }}>✦</span>}
              </div>
            );
          })}
        </div>
      )}
      <div style={{ marginTop: 20, paddingTop: 16, borderTop: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 9.5, color: "var(--muted)", fontFamily: "var(--mono)" }}>AI explanation from Gemini · attention weights + SHAP values · GCN · Memory · Transformer{contextEnabled ? " · Context" : ""}</span>
      </div>
    </section>
  );
}

// ══════════════════════════════════════════════════════════════
// LOADER / ERROR
// ══════════════════════════════════════════════════════════════
function Loader({ text = "Loading…" }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 18, padding: "64px 0" }}>
      {/* Film reel loader */}
      <div style={{ position: "relative", width: 56, height: 56 }}>
        <div style={{ width: 56, height: 56, borderRadius: "50%", border: "2px solid var(--border2)", position: "absolute" }} />
        <div style={{ width: 56, height: 56, borderRadius: "50%", border: "2px solid transparent", borderTopColor: "var(--accent)", position: "absolute", animation: "spin .8s linear infinite" }} />
        <div style={{ position: "absolute", inset: 8, borderRadius: "50%", border: "1px dashed var(--border2)", animation: "spin 3s linear infinite reverse" }} />
        <div style={{ position: "absolute", inset: "50%", width: 8, height: 8, marginLeft: -4, marginTop: -4, borderRadius: "50%", background: "var(--accent)" }} />
      </div>
      <div style={{ color: "var(--muted)", fontSize: 12, fontFamily: "var(--mono)", letterSpacing: ".1em" }}>{text}</div>
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

// ══════════════════════════════════════════════════════════════
// POSTER LOADER HOOK
// ══════════════════════════════════════════════════════════════
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

// ══════════════════════════════════════════════════════════════
// RESULTS BLOCK
// ══════════════════════════════════════════════════════════════
function ResultsBlock({ pickedIds, recData, baseRecData, expData, movies, cache, loadPoster, requestKey, status, contextEnabled, todSlot, seasonSlot }) {
  const pickedNorm = useMemo(() => pickedIds.map(p => (typeof p === "object" ? p : { idx: p })), [pickedIds]);
  const todInfo = contextEnabled && todSlot != null ? TOD_SLOTS[todSlot] : null;
  const seasonInfo = contextEnabled && seasonSlot != null ? SEASON_SLOTS[seasonSlot] : null;
  const ctxColor = todInfo ? TOD_COLORS[todInfo.key] : "var(--accent)";
  const ctxLabel = todInfo ? `${todInfo.icon} ${todInfo.label}${seasonInfo ? ` · ${seasonInfo.icon} ${seasonInfo.label}` : ""}` : null;
  const boostedIds = useMemo(() => {
    if (!contextEnabled || !baseRecData?.recommendations || !recData?.recommendations) return new Set();
    const baseMap = {}; baseRecData.recommendations.forEach((r, i) => { baseMap[r.item_id] = i; });
    const boosted = new Set();
    recData.recommendations.forEach((r, ctxRank) => { const baseRank = baseMap[r.item_id]; if (baseRank === undefined || ctxRank < baseRank) boosted.add(r.item_id); });
    return boosted;
  }, [contextEnabled, baseRecData, recData]);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 44 }}>
      <StatsRow picked={pickedNorm} recommendations={recData.recommendations} movies={movies} expData={expData} contextEnabled={contextEnabled} todSlot={todSlot} seasonSlot={seasonSlot} />
      <ModelMetrics testMetrics={status?.test_metrics} />
      {pickedNorm.length > 0 && (
        <div className="fade-up" style={{ animationDelay: ".05s" }}>
          <HistoryTimeline picked={pickedNorm} movies={movies} cache={cache} onNeeded={loadPoster} influence={expData?.history_influence} />
        </div>
      )}
      <section className="fade-up" style={{ animationDelay: ".1s" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <div className="section-label" style={{ margin: 0 }}>{contextEnabled && ctxLabel ? `Recommended for you · ${ctxLabel}` : "Recommended for you"}</div>
          {contextEnabled && boostedIds.size > 0 && (
            <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: ctxColor, padding: "3px 10px", borderRadius: 20, border: `1px solid ${ctxColor}33`, background: ctxColor + "0d" }}>{boostedIds.size} context-boosted</div>
          )}
        </div>
        <div className="movie-grid-lg">
          {recData.recommendations.map((r, i) => (
            <MovieCard key={r.item_id} idx={r.item_id} movies={movies} cache={cache} onNeeded={loadPoster} rank={i + 1}
              isHit={recData.ground_truth != null && r.item_id === recData.ground_truth}
              ctxBoosted={contextEnabled && boostedIds.has(r.item_id)} ctxColor={ctxColor} ctxLabel={ctxLabel}
              delay={i * .04} showGenre />
          ))}
        </div>
      </section>
      {contextEnabled && baseRecData?.recommendations && (
        <section className="fade-up" style={{ animationDelay: ".12s" }}>
          <div className="section-label">Context shift analysis</div>
          <ContextComparePanel baseRecs={baseRecData.recommendations} ctxRecs={recData.recommendations} movies={movies} ctxLabel={ctxLabel} />
        </section>
      )}
      <ExplanationPanel key={requestKey} requestKey={requestKey} picked={pickedNorm} recData={recData} expData={expData} movies={movies} todSlot={todSlot} seasonSlot={seasonSlot} contextEnabled={contextEnabled} />
      {expData ? (
        <section className="fade-up" style={{ animationDelay: ".15s" }}>
          <div className="section-label">Model analytics</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(272px,1fr))", gap: 12, marginBottom: 12 }}>
            <GateChart gates={expData.component_weights} />
            <div className="chart-box" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div className="chart-title">Signal breakdown</div>
              <GateBars gates={expData.component_weights} />
              <hr style={{ border: "none", borderTop: "1px solid var(--border)", margin: "4px 0" }} />
              <div style={{ fontSize: 12.5, color: "var(--muted)", lineHeight: 1.8, fontFamily: "var(--serif)", fontStyle: "italic" }}>
                {expData.component_weights.gcn > expData.component_weights.memory && expData.component_weights.gcn > expData.component_weights.seq
                  ? "Collaborative signals from similar viewers dominated — the graph network found your tribe."
                  : expData.component_weights.memory > expData.component_weights.seq
                    ? "Long-term preference patterns were the strongest predictor for your picks."
                    : "Recent viewing behaviour drove this result — your current arc is clear."}
              </div>
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(272px,1fr))", gap: 12, marginBottom: 12 }}>
            <AttentionChart influence={expData.history_influence} movies={movies} />
            <RecGenreChart recommendations={recData.recommendations} movies={movies} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(272px,1fr))", gap: 12 }}>
            {contextEnabled && baseRecData?.recommendations
              ? <ContextScoreChart baseRecs={baseRecData.recommendations} ctxRecs={recData.recommendations} movies={movies} ctxColor={ctxColor} />
              : <ScoreChart recommendations={recData.recommendations} movies={movies} />}
            <ScoreCurveChart recommendations={recData.recommendations} movies={movies} />
          </div>
        </section>
      ) : (
        <section className="fade-up">
          <div className="section-label">Score distribution</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(272px,1fr))", gap: 12 }}>
            {contextEnabled && baseRecData?.recommendations
              ? <ContextScoreChart baseRecs={baseRecData.recommendations} ctxRecs={recData.recommendations} movies={movies} ctxColor={ctxColor} />
              : <ScoreChart recommendations={recData.recommendations} movies={movies} />}
            <ScoreCurveChart recommendations={recData.recommendations} movies={movies} />
          </div>
        </section>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// USER EXPLORER PAGE
// ══════════════════════════════════════════════════════════════
function UserGenreBars({ historyIds, movies }) {
  const data = useMemo(() => {
    const freq = {}; historyIds.forEach(id => { (movies?.[String(id)]?.genres || []).forEach(g => { freq[g] = (freq[g] || 0) + 1; }); });
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
      const off = reset ? 0 : offset; const data = await apiFetch(`/users?limit=${PAGE_SIZE}&offset=${off}`);
      if (reset) { setUserList(data.users || []); setOffset(PAGE_SIZE); } else { setUserList(p => [...p, ...(data.users || [])]); setOffset(o => o + PAGE_SIZE); }
      setTotalUsers(data.total || 0);
    } catch { }
    setLoadingUsers(false);
  }, [offset]);
  useEffect(() => { fetchUsers(true); }, []);
  const filteredUsers = useMemo(() => !userFilter.trim() ? userList : userList.filter(u => String(u).includes(userFilter.trim())), [userList, userFilter]);
  const selectUser = useCallback(async (userId, tk) => {
    const usedTopK = tk ?? topK;
    setSelectedUser(userId); setRecData(null); setBaseRecData(null); setExpData(null); setErr(null);
    const id = ++runId.current; setLoading(true);
    try {
      const [rec, exp] = await Promise.allSettled([
        apiFetch("/recommend", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user_id: userId, top_k: usedTopK }) }),
        apiFetch("/explain", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user_id: userId, top_k: usedTopK }) }),
      ]);
      if (runId.current !== id) return;
      if (rec.status === "fulfilled") {
        const baseRec = rec.value; setBaseRecData(baseRec);
        if (contextEnabled) {
          try {
            const ctxRec = await apiFetch("/recommend/context", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user_id: userId, top_k: usedTopK, tod_slot: todSlot, season_slot: seasonSlot, tod_weight: todWeight, season_weight: seasonWeight }) });
            if (runId.current !== id) return; setRecData(ctxRec);
          } catch { setRecData({ ...baseRec, recommendations: applyClientContextBias(baseRec.recommendations, movies, todSlot, seasonSlot, todWeight, seasonWeight) }); }
        } else { setRecData(baseRec); }
        setRequestKey(k => k + 1);
      } else { setErr(rec.reason?.message || "Recommendation failed"); }
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
      <div style={{ width: 232, flexShrink: 0, position: "sticky", top: 80, maxHeight: "calc(100vh - 96px)", overflowY: "auto", paddingRight: 2 }}>
        <div className="section-label">Choose a user</div>
        <div style={{ position: "relative", marginBottom: 10 }}>
          <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--muted)", fontSize: 12, pointerEvents: "none" }}>🔎</span>
          <input className="sidebar-search" value={userFilter} onChange={e => setUserFilter(e.target.value)} placeholder="Filter by ID…" />
        </div>
        <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--muted)", marginBottom: 10 }}>{totalUsers.toLocaleString()} users · {filteredUsers.length} shown</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
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
      {/* Main */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {!selectedUser && !loading && (
          <div style={{ textAlign: "center", padding: "90px 0", color: "var(--muted)" }} className="fade-up">
            <div style={{ fontSize: 64, opacity: .1, marginBottom: 24, animation: "float 3.5s ease-in-out infinite" }}>🎬</div>
            <div style={{ fontFamily: "var(--serif)", fontSize: "1.8rem", color: "var(--text)", fontWeight: 700, marginBottom: 12, fontStyle: "italic" }}>Select a user</div>
            <div style={{ fontSize: 14, lineHeight: 1.8, maxWidth: 340, margin: "0 auto", fontFamily: "var(--serif)", color: "var(--muted2)" }}>Choose any user from the sidebar to explore their watch history and model recommendations.</div>
          </div>
        )}
        {loading && <Loader text={`Fetching recommendations for User ${selectedUser}…`} />}
        {err && <ErrBox msg={err} />}
        {recData && !loading && (
          <div style={{ display: "flex", flexDirection: "column", gap: 32 }} className="fade-up">
            <div className="profile-card">
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 20 }}>
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 18 }}>
                    <div style={{ width: 52, height: 52, borderRadius: "50%", background: "linear-gradient(135deg,var(--blue)22,var(--blue)08)", border: "2px solid var(--blue)44", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--serif)", fontSize: 20, color: "var(--blue)", fontWeight: 700, flexShrink: 0 }}>
                      {String(selectedUser).slice(-2)}
                    </div>
                    <div>
                      <div style={{ fontFamily: "var(--serif)", fontSize: 24, fontWeight: 700, color: "var(--text)", fontStyle: "italic" }}>User {selectedUser}</div>
                      <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--muted)", marginTop: 3 }}>{recData.history_len} films in history · test-set user</div>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                    <div className={`hit-indicator ${isHit ? "hit" : "miss"}`}>{isHit ? "✓ Hit" : "✗ Miss"} (Local HR@{topK}: {isHit ? "1" : "0"})</div>
                    {groundTruth != null && <div className={`hit-indicator ${isHit ? "hit" : "miss"}`}>Local NDCG@{topK}: {localNDCG}</div>}
                    {groundTruth != null && (
                      <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--muted)", display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                        <span>Target:</span>
                        <span style={{ color: "var(--text)" }}>{movies?.[String(groundTruth)]?.title || `#${groundTruth}`}</span>
                        {localRank !== undefined && localRank !== -1 && <><span style={{ margin: "0 4px", color: "var(--border2)" }}>|</span><span style={{ color: "var(--text)" }}>Rank: #{localRank + 1}</span></>}
                      </div>
                    )}
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, background: "var(--surface)", border: "1px solid var(--border2)", borderRadius: "var(--radius)", padding: "8px 16px" }}>
                    <span style={{ color: "var(--muted)", fontSize: 12, fontFamily: "var(--mono)" }}>Top</span>
                    <input type="number" value={topK} min={5} max={20} onChange={e => setTopK(Number(e.target.value))} style={{ width: 44, background: "transparent", border: "none", color: "var(--accent)", fontFamily: "var(--mono)", fontSize: 16, fontWeight: 700, outline: "none", textAlign: "center" }} />
                    <span style={{ color: "var(--muted)", fontSize: 12, fontFamily: "var(--mono)" }}>picks</span>
                  </div>
                  <button className="btn btn-blue btn-sm" onClick={rerun} disabled={loading}>{loading ? <><span className="spinner" />Running…</> : "↺ Re-run"}</button>
                </div>
              </div>
              {userHistory.length > 0 && (
                <div style={{ marginTop: 24, paddingTop: 20, borderTop: "1px solid var(--border)" }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
                    <div><div className="section-label" style={{ marginBottom: 12 }}>Genre breakdown</div><UserGenreBars historyIds={userHistory} movies={movies} /></div>
                    <div>
                      <div className="section-label" style={{ marginBottom: 12 }}>Last watched</div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        {[...userHistory].reverse().slice(0, 7).map(id => {
                          const m = movies?.[String(id)];
                          return (
                            <div key={id} style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: "var(--mono)", fontSize: 10.5 }}>
                              <span style={{ color: gcolor(m?.genres), fontSize: 7, flexShrink: 0 }}>●</span>
                              <span style={{ color: "var(--text)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m?.title || `#${id}`}</span>
                              {m?.year && <span style={{ color: "var(--muted)", flexShrink: 0 }}>{m.year}</span>}
                            </div>
                          );
                        })}
                        {userHistory.length > 7 && <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--muted)", marginTop: 2 }}>+ {userHistory.length - 7} more</div>}
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
                    <MovieCard key={id} idx={id} movies={movies} cache={cache} onNeeded={loadPoster} delay={i * .04} showGenre />
                  ))}
                </div>
              </section>
            )}
            <ResultsBlock pickedIds={userHistory} recData={recData} baseRecData={baseRecData} expData={expData} movies={movies} cache={cache} loadPoster={loadPoster} requestKey={requestKey} status={status} contextEnabled={contextEnabled} todSlot={todSlot} seasonSlot={seasonSlot} />
          </div>
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// CUSTOM HISTORY PAGE
// ══════════════════════════════════════════════════════════════
function CustomHistoryPage({ movies, cache, loadPoster, status, contextEnabled, todSlot, seasonSlot, todWeight, seasonWeight }) {
  const [picked, setPicked] = useState([]);
  const [topK, setTopK] = useState(10);
  const [recData, setRecData] = useState(null);
  const [baseRecData, setBaseRecData] = useState(null);
  const [expData, setExpData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
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
    const id = ++runId.current; setLoading(true); setErr(null); setRecData(null); setBaseRecData(null); setExpData(null);
    try {
      const baseRec = await apiFetch("/recommend/custom", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ history: cp.map(p => p.idx), top_k: ck }) });
      if (runId.current !== id) return; setBaseRecData(baseRec);
      let finalRec = baseRec;
      if (contextEnabled) {
        try {
          const ctxRec = await apiFetch("/recommend/custom/context", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ history: cp.map(p => p.idx), top_k: ck, tod_slot: todSlot, season_slot: seasonSlot, tod_weight: todWeight, season_weight: seasonWeight }) });
          if (runId.current !== id) return; finalRec = ctxRec;
        } catch { finalRec = { ...baseRec, recommendations: applyClientContextBias(baseRec.recommendations, movies, todSlot, seasonSlot, todWeight, seasonWeight) }; }
      }
      setRecData(finalRec); setRequestKey(k => k + 1);
      try {
        const exp = await apiFetch("/explain/custom", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ history: cp.map(p => p.idx), top_k: ck }) });
        if (runId.current !== id) return; setExpData(exp);
      } catch { }
    } catch (e) { if (runId.current === id) setErr(e.message); }
    finally { if (runId.current === id) setLoading(false); }
  }, [contextEnabled, todSlot, seasonSlot, todWeight, seasonWeight, movies]);
  const noMovies = Object.keys(movies).length === 0;
  return (
    <>
      {/* ── HERO ── */}
      <div className="hero-projector fade-up">
        <div className="hero-scan" />
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 32, flexWrap: "wrap" }}>
          <div>
            <div className="hero-eyebrow">Hybrid recommendation engine</div>
            <h1 className="hero-title">
              What should you<br />watch <em>next?</em>
            </h1>
            <p className="hero-sub">Add films you've loved. Our model blends graph networks, long-term memory, and transformers to surface what's perfect for you.</p>
          </div>
          <div className="model-pill-list">
            {[
              { icon: "⬡", label: "Graph Neural Network", color: "#4a7ce8" },
              { icon: "◉", label: "Long-term Memory", color: "#3db87a" },
              { icon: "▸", label: "Transformer Attention", color: "#c8a96e" },
              { icon: "◷", label: "Time & Season Context", color: "#8b6be8" },
            ].map(({ icon, label, color }) => (
              <div key={label} className="model-pill">
                <span className="model-pill-icon" style={{ color }}>{icon}</span>{label}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Film strip divider ── */}
      <div className="film-strip-h" style={{ marginBottom: 36, opacity: .5 }} />

      {/* ── Search ── */}
      <div style={{ marginBottom: 32 }} className="fade-up">
        <div className="section-label">Build your screening history</div>
        {noMovies
          ? <div style={{ color: "var(--muted)", fontSize: 13, padding: "16px 0", fontFamily: "var(--mono)" }}>⚠ Movie catalogue not loaded — check server connection.</div>
          : <MovieSearch movies={movies} cache={cache} onNeeded={loadPoster} onSelect={addMovie} />}
      </div>

      {/* ── Selected ── */}
      {picked.length > 0 && (
        <div style={{ marginBottom: 36 }} className="fade-up">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <div className="section-label" style={{ margin: 0 }}>Selected · {picked.length} {picked.length === 1 ? "film" : "films"}</div>
            <button className="btn btn-ghost btn-sm" onClick={() => { setPicked([]); setRecData(null); setBaseRecData(null); setExpData(null); }}>Clear all</button>
          </div>
          <div className="movie-grid">
            {picked.map(({ idx }, i) => (
              <MovieCard key={idx} idx={idx} movies={movies} cache={cache} onNeeded={loadPoster} onRemove={removeMovie} delay={i * .05} showGenre />
            ))}
          </div>
          {picked.length >= 3 && <div style={{ marginTop: 20 }}><GenreRadar picked={picked} movies={movies} /></div>}
          <div style={{ display: "flex", gap: 12, marginTop: 24, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, background: "var(--surface)", border: "1px solid var(--border2)", borderRadius: "var(--radius)", padding: "8px 16px" }}>
              <span style={{ color: "var(--muted)", fontSize: 12, fontFamily: "var(--mono)" }}>Top</span>
              <input type="number" value={topK} min={5} max={20} onChange={e => setTopK(Number(e.target.value))} style={{ width: 48, background: "transparent", border: "none", color: "var(--accent)", fontFamily: "var(--mono)", fontSize: 16, fontWeight: 700, outline: "none", textAlign: "center" }} />
              <span style={{ color: "var(--muted)", fontSize: 12, fontFamily: "var(--mono)" }}>picks</span>
            </div>
            <button className="btn btn-primary" onClick={run} disabled={loading || !picked.length}>
              {loading ? <><span className="spinner" />Analysing…</> : `✦ Get ${contextEnabled ? "context-aware " : ""}recommendations`}
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

      {/* ── Empty state ── */}
      {!recData && !loading && picked.length === 0 && (
        <div style={{ textAlign: "center", padding: "90px 0", color: "var(--muted)" }} className="fade-up">
          {/* Animated projector reel */}
          <div style={{ position: "relative", display: "inline-block", marginBottom: 32 }}>
            <div style={{ width: 80, height: 80, borderRadius: "50%", border: "2px solid var(--border2)", position: "relative", margin: "0 auto", animation: "reelSpin 6s linear infinite" }}>
              <div style={{ position: "absolute", inset: 8, borderRadius: "50%", border: "1px dashed var(--border)", }} />
              <div style={{ position: "absolute", inset: "50%", width: 12, height: 12, marginLeft: -6, marginTop: -6, borderRadius: "50%", background: "var(--accent)", opacity: .4 }} />
              {[0, 60, 120, 180, 240, 300].map(deg => (
                <div key={deg} style={{ position: "absolute", width: 6, height: 6, borderRadius: "50%", background: "var(--border2)", top: "50%", left: "50%", transformOrigin: "0 0", transform: `rotate(${deg}deg) translateX(20px)` }} />
              ))}
            </div>
          </div>
          <div style={{ fontFamily: "var(--serif)", fontSize: "1.8rem", color: "var(--text)", marginBottom: 12, fontWeight: 700, fontStyle: "italic" }}>Start with a film you love</div>
          <div style={{ fontSize: 15, color: "var(--muted2)", maxWidth: 360, margin: "0 auto", lineHeight: 1.8, fontFamily: "var(--serif)" }}>Search above and build your screening history. The more you add, the better the model understands your taste.</div>
          <div style={{ marginTop: 32, display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
            {["Action", "Drama", "Sci-Fi", "Comedy", "Thriller", "Horror"].map(g => (
              <span key={g} className="genre-tag" style={{ color: gcolor([g]), borderColor: gcolor([g]) + "44", background: gcolor([g]) + "0a" }}>{g}</span>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

// ══════════════════════════════════════════════════════════════
// ROOT APP
// ══════════════════════════════════════════════════════════════
export default function App() {
  const [movies, setMovies] = useState({});
  const [status, setStatus] = useState(null);
  const [activePage, setActivePage] = useState("custom");
  const tmdbKey = "394771898f564a5285ada7bd1fd50b1b";
  const [cache, loadPoster] = usePosterLoader(tmdbKey);
  const [contextEnabled, setContextEnabled] = useState(false);
  const [todSlot, setTodSlot] = useState(getCurrentTod);
  const [seasonSlot, setSeasonSlot] = useState(getCurrentSeason);
  const [todWeight, setTodWeight] = useState(0.25);
  const [seasonWeight, setSeasonWeight] = useState(0.15);
  useEffect(() => {
    (async () => {
      try {
        const [s, m] = await Promise.all([apiFetch("/status").catch(() => ({ loaded: false })), apiFetch("/movies").catch(() => ({}))]);
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
      <div className="cinematic-leak" />
      <CinematicBackground3D />

      {/* ── NAV ── */}
      <nav className="nav">
        <div className="nav-logo">
          <div className="nav-logo-reel" />
          <span>CinéRec</span>
        </div>
        <div className="page-tabs">
          <button className={`page-tab custom-tab${activePage === "custom" ? " active" : ""}`} onClick={() => setActivePage("custom")}>
            ✦ <span className="tab-label">Custom</span>
          </button>
          <button className={`page-tab explorer-tab${activePage === "explorer" ? " active" : ""}`} onClick={() => setActivePage("explorer")}>
            👤 <span className="tab-label">Explorer</span>
          </button>
        </div>
        <div className="nav-pill">
          <span style={{ color: "#4a7ce8", fontSize: 10 }}>⬡</span>GCN
          <span style={{ color: "var(--border2)", margin: "0 4px" }}>·</span>
          <span style={{ color: "#3db87a", fontSize: 10 }}>◉</span>Memory
          <span style={{ color: "var(--border2)", margin: "0 4px" }}>·</span>
          <span style={{ color: "#c8a96e", fontSize: 10 }}>▸</span>Seq
          {contextEnabled && (<>
            <span style={{ color: "var(--border2)", margin: "0 4px" }}>·</span>
            <span style={{ color: TOD_COLORS[todInfo?.key], fontSize: 10 }}>{todInfo?.icon}</span>
            <span style={{ color: TOD_COLORS[todInfo?.key] }}>{todInfo?.label}</span>
          </>)}
        </div>
        {metricPill?.hr != null && (
          <div className="nav-pill">
            <span style={{ color: "#3db87a" }}>HR@{metricPill.k}</span>
            <span style={{ color: "var(--text)", fontWeight: 600 }}>{(metricPill.hr * 100).toFixed(1)}%</span>
            {metricPill.ndcg != null && (<>
              <span style={{ color: "var(--border2)" }}>·</span>
              <span style={{ color: "#c8a96e" }}>NDCG@{metricPill.k}</span>
              <span style={{ color: "var(--text)", fontWeight: 600 }}>{(metricPill.ndcg * 100).toFixed(1)}%</span>
            </>)}
          </div>
        )}
        <div className="nav-status">
          <div className="status-dot" style={{ background: status?.loaded ? "var(--green)" : "var(--red)", animation: !status?.loaded ? "pulse 1.5s infinite" : "none" }} />
          <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--muted)" }}>
            {status?.loaded ? `${status.n_users?.toLocaleString()} users · ${Object.keys(movies).length.toLocaleString()} titles` : "connecting…"}
          </span>
        </div>
      </nav>

      {/* ── Film ticker ── */}
      <FilmTicker movies={movies} />

      <main style={{ maxWidth: 1200, margin: "0 auto", padding: "48px 28px", position: "relative", zIndex: 1 }}>
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