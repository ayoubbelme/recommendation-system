import { useState, useEffect, useCallback, useRef, useMemo } from "react";

// ── CHANGE THIS to your Cloudflare tunnel URL ─────────────────────────────
const API = "https://becomes-tmp-relevant-portsmouth.trycloudflare.com";

// ── Tokens ────────────────────────────────────────────────────────────────
const C = {
  bg: "#080810",
  surface: "#0E0E1A",
  panel: "#13131F",
  border: "#1C1C2E",
  accent: "#7B68EE",
  accentLo: "#7B68EE18",
  green: "#2DD4A0",
  amber: "#F5A623",
  red: "#FF6B81",
  blue: "#60A5FA",
  pink: "#F472B6",
  muted: "#3D3D5C",
  text: "#DDDDF5",
  textSub: "#7070A0",
};

const GENRE_PALETTE = {
  "Action": "#FF6B81", "Adventure": "#F97316", "Animation": "#F5A623",
  "Children's": "#FBBF24", "Comedy": "#FCD34D", "Crime": "#C084FC",
  "Documentary": "#60A5FA", "Drama": "#7B68EE", "Fantasy": "#F472B6",
  "Film-Noir": "#6B7280", "Horror": "#EF4444", "Musical": "#EC4899",
  "Mystery": "#818CF8", "Romance": "#F472B6", "Sci-Fi": "#38BDF8",
  "Thriller": "#2DD4A0", "War": "#9CA3AF", "Western": "#FB923C",
};
const genreColor = g => GENRE_PALETTE[g?.[0]] || C.accent;

// Module-level poster cache (survives re-renders)
const PC = {};

// ── Global CSS ────────────────────────────────────────────────────────────
const css = `
  @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=JetBrains+Mono:wght@300;400;500&display=swap');
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  body{background:${C.bg};color:${C.text};font-family:'Space Grotesk',sans-serif;min-height:100vh;overflow-x:hidden}
  ::-webkit-scrollbar{width:5px}::-webkit-scrollbar-track{background:${C.surface}}
  ::-webkit-scrollbar-thumb{background:${C.border};border-radius:3px}
  .mono{font-family:'JetBrains Mono',monospace}

  @keyframes fadeUp{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:translateY(0)}}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
  @keyframes spin{to{transform:rotate(360deg)}}
  @keyframes shimmer{0%{background-position:-400% 0}100%{background-position:400% 0}}

  .fade-up{animation:fadeUp .38s cubic-bezier(.2,.8,.4,1) both}

  .btn{display:inline-flex;align-items:center;gap:7px;padding:9px 18px;
    background:${C.accent};color:#fff;border:none;border-radius:10px;
    font-family:'Space Grotesk',sans-serif;font-size:13px;font-weight:600;
    cursor:pointer;transition:all .15s;white-space:nowrap;letter-spacing:.01em}
  .btn:hover:not(:disabled){background:#9585FF;transform:translateY(-1px);box-shadow:0 6px 20px ${C.accent}44}
  .btn:active:not(:disabled){transform:translateY(0)}
  .btn:disabled{opacity:.3;cursor:not-allowed}
  .btn-ghost{background:transparent;border:1px solid ${C.border};color:${C.textSub}}
  .btn-ghost:hover:not(:disabled){background:${C.panel};color:${C.text};box-shadow:none}
  .btn-sm{padding:6px 12px;font-size:12px;border-radius:8px}
  .btn-danger{background:${C.red}22;border:1px solid ${C.red}44;color:${C.red}}
  .btn-danger:hover:not(:disabled){background:${C.red}33;box-shadow:none}

  .card{background:${C.panel};border:1px solid ${C.border};border-radius:16px;padding:20px}

  .tag{display:inline-flex;align-items:center;padding:2px 8px;border-radius:20px;
    font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;white-space:nowrap}

  .spinner{width:15px;height:15px;border:2px solid ${C.border};border-top-color:${C.accent};
    border-radius:50%;animation:spin .7s linear infinite;flex-shrink:0}

  .shimmer{background:linear-gradient(90deg,${C.panel} 25%,${C.border} 50%,${C.panel} 75%);
    background-size:400% 100%;animation:shimmer 1.4s infinite}

  input[type=number],input[type=text],input[type=password]{
    background:${C.surface};border:1px solid ${C.border};color:${C.text};
    border-radius:10px;padding:9px 13px;font-family:'JetBrains Mono',monospace;
    font-size:13px;outline:none;transition:border-color .15s,box-shadow .15s;width:100%}
  input:focus{border-color:${C.accent};box-shadow:0 0 0 3px ${C.accent}18}
  input::placeholder{color:${C.muted}}

  .movie-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:12px}
  .movie-grid-lg{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:14px}

  .mcard{background:${C.surface};border:1px solid ${C.border};border-radius:12px;
    overflow:hidden;transition:all .2s;position:relative}
  .mcard:hover{border-color:${C.accent}55;transform:translateY(-2px);box-shadow:0 12px 32px #00000055}
  .mcard.clickable{cursor:pointer}
  .mcard.hit{border-color:${C.green}66;background:${C.green}06}
  .mcard.selected{border-color:${C.accent}88;background:${C.accent}06}

  .dropdown{position:absolute;top:calc(100% + 5px);left:0;right:0;
    background:${C.panel};border:1px solid ${C.border};border-radius:12px;
    box-shadow:0 20px 60px #00000077;z-index:300;max-height:380px;overflow-y:auto}
  .dditem{display:flex;align-items:center;gap:12px;padding:10px 14px;cursor:pointer;
    transition:background .1s;border-bottom:1px solid ${C.border}}
  .dditem:last-child{border-bottom:none}
  .dditem:hover{background:${C.surface}}

  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  .grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
  @media(max-width:760px){.grid2,.grid3{grid-template-columns:1fr}}
  @media(max-width:600px){.movie-grid,.movie-grid-lg{grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:8px}}
`;

// ── Helpers ───────────────────────────────────────────────────────────────

// Robust fetch with timeout + retries — fixes movies not loading
async function fetchWithRetry(url, opts = {}, retries = 3, timeout = 8000) {
  for (let i = 0; i < retries; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, { ...opts, signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 120)}`);
      }
      return await res.json();
    } catch (e) {
      clearTimeout(timer);
      if (i === retries - 1) throw e;
      await new Promise(r => setTimeout(r, 800 * (i + 1)));
    }
  }
}

// ── Micro components ───────────────────────────────────────────────────────

function Tag({ children, color = C.accent }) {
  return <span className="tag" style={{ background: color + "22", color }}>{children}</span>;
}

function PopTag({ pop }) {
  const m = {
    viral: [C.red, "🔥 Viral"],
    popular: [C.amber, "⭐ Pop"],
    niche: [C.green, "💎 Niche"],
    rare: [C.muted, "🌙 Rare"],
  };
  const [color, label] = m[pop] || m.rare;
  return <Tag color={color}>{label}</Tag>;
}

function Loader({ text = "Fetching from model…" }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, color: C.textSub, fontSize: 13, padding: "24px 0" }}>
      <div className="spinner" /> {text}
    </div>
  );
}

function Err({ msg }) {
  return (
    <div style={{
      background: C.red + "11", border: `1px solid ${C.red}44`, borderRadius: 10,
      padding: "11px 15px", color: C.red, fontSize: 13, marginBottom: 14
    }}>
      ⚠ {msg}
    </div>
  );
}

function SectionTitle({ children, sub }) {
  return (
    <div style={{ marginBottom: 22 }}>
      <h2 style={{ fontSize: 21, fontWeight: 700, letterSpacing: "-.03em" }}>{children}</h2>
      {sub && <p style={{ color: C.textSub, fontSize: 13, marginTop: 4 }}>{sub}</p>}
    </div>
  );
}

// ── Poster system ──────────────────────────────────────────────────────────

function pkey(title, year) { return `${title}||${year}`; }

function PosterFallback({ title, genres }) {
  const color = genreColor(genres);
  const words = (title || "").replace(/[^a-zA-Z\s]/g, "").split(/\s+/).filter(w => w.length > 1);
  const abbr = words.length >= 2
    ? words.slice(0, 2).map(w => w[0].toUpperCase()).join("")
    : (title || "??").slice(0, 2).toUpperCase();
  return (
    <div style={{
      width: "100%", aspectRatio: "2/3",
      background: `linear-gradient(155deg,${color}28 0%,${color}08 100%)`,
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 10
    }}>
      <div className="mono" style={{ fontSize: 28, fontWeight: 700, color, letterSpacing: "-.04em", opacity: .9 }}>
        {abbr}
      </div>
      {genres?.[0] && (
        <div style={{
          fontSize: 9, color: C.textSub, marginTop: 5, textTransform: "uppercase",
          letterSpacing: ".07em", textAlign: "center"
        }}>
          {genres[0]}
        </div>
      )}
    </div>
  );
}

function Poster({ title, year, genres, cache, onNeeded }) {
  const ref = useRef(null);
  const url = cache[pkey(title, year)];

  useEffect(() => {
    if (!title) return;
    const k = pkey(title, year);
    if (PC[k] !== undefined) return;
    const obs = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) { onNeeded?.(title, year); obs.disconnect(); }
    }, { rootMargin: "300px" });
    if (ref.current) obs.observe(ref.current);
    return () => obs.disconnect();
  }, [title, year, onNeeded]);

  return (
    <div ref={ref} style={{ aspectRatio: "2/3", borderRadius: 8, overflow: "hidden", background: C.surface }}>
      {url === "loading" && <div className="shimmer" style={{ width: "100%", height: "100%" }} />}
      {url && url !== "loading" && (
        <img src={url} alt={title}
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
          onError={e => { e.target.style.display = "none"; }}
        />
      )}
      {(!url || url === null) && url !== "loading" && (
        <PosterFallback title={title} genres={genres} />
      )}
    </div>
  );
}

// ── Movie Card ─────────────────────────────────────────────────────────────

function MCard({ itemIdx, movies, cache, onNeeded, rank, score, pop, isHit, isSelected, onClick, delay = 0 }) {
  const m = movies?.[String(itemIdx)];
  // FIX: show real title/year/genres if available, else clear fallback
  const title = m?.title || null;
  const year = m?.year || null;
  const genres = m?.genres || [];
  const color = genreColor(genres);

  return (
    <div
      className={`mcard${onClick ? " clickable" : ""}${isHit ? " hit" : ""}${isSelected ? " selected" : ""}`}
      onClick={() => onClick?.(itemIdx)}
      style={{ animation: `fadeUp .35s cubic-bezier(.2,.8,.4,1) ${delay}s both` }}
    >
      {rank != null && (
        <div style={{
          position: "absolute", top: 7, left: 7, zIndex: 2,
          background: "#000000BB", borderRadius: 5, padding: "2px 6px",
          fontSize: 10, fontWeight: 700, fontFamily: "'JetBrains Mono',monospace",
          color: isHit ? C.green : C.text
        }}>
          #{rank}
        </div>
      )}
      {isHit && (
        <div style={{
          position: "absolute", top: 7, right: 7, zIndex: 2,
          background: C.green + "CC", borderRadius: 5, padding: "2px 6px",
          fontSize: 9, fontWeight: 700, color: "#fff"
        }}>
          HIT ✓
        </div>
      )}
      {isSelected && !isHit && (
        <div style={{
          position: "absolute", top: 7, right: 7, zIndex: 2,
          background: C.accent + "CC", borderRadius: 5, padding: "2px 6px",
          fontSize: 9, fontWeight: 700, color: "#fff"
        }}>
          ✓
        </div>
      )}

      <Poster title={title} year={year} genres={genres} cache={cache} onNeeded={onNeeded} />

      <div style={{ padding: "10px 10px 12px" }}>
        <div style={{
          fontSize: 12, fontWeight: 600, color: title ? C.text : C.muted,
          lineHeight: 1.3, marginBottom: 3,
          display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden"
        }}>
          {title || `Movie #${itemIdx}`}
        </div>
        <div style={{ fontSize: 11, color: C.textSub, marginBottom: 5 }}>
          {year || ""}
          {genres[0] && <span style={{ color, marginLeft: year ? 5 : 0 }}>• {genres[0]}</span>}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
          {score != null && (
            <span className="mono" style={{ fontSize: 10, color: C.muted }}>{score.toFixed(3)}</span>
          )}
          {pop && <PopTag pop={pop} />}
        </div>
      </div>
    </div>
  );
}

// ── Movie Chip ─────────────────────────────────────────────────────────────

function Chip({ itemIdx, movies, onRemove }) {
  const m = movies?.[String(itemIdx)];
  const color = genreColor(m?.genres);
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5,
      background: color + "14", border: `1px solid ${color}30`, borderRadius: 8,
      padding: "4px 9px", fontSize: 12
    }}>
      <span style={{ color }}>🎬</span>
      <span style={{ color: C.text, fontWeight: 500 }}>
        {m ? `${m.title}${m.year ? ` (${m.year})` : ""}` : `#${itemIdx}`}
      </span>
      {onRemove && (
        <button onClick={() => onRemove(itemIdx)} style={{
          background: "none", border: "none",
          cursor: "pointer", color: C.muted, fontSize: 15, lineHeight: 1, padding: "0 0 0 3px"
        }}>×</button>
      )}
    </span>
  );
}

// ── Search Dropdown ────────────────────────────────────────────────────────

function MovieSearch({ movies, cache, onNeeded, onSelect, placeholder }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  const hits = useMemo(() => {
    if (q.length < 2) return [];
    const ql = q.toLowerCase();
    return Object.entries(movies)
      .filter(([, m]) => m.title?.toLowerCase().includes(ql))
      .sort(([, a], [, b]) => {
        const aS = a.title?.toLowerCase().startsWith(ql);
        const bS = b.title?.toLowerCase().startsWith(ql);
        return aS === bS ? (a.title || "").localeCompare(b.title || "") : aS ? -1 : 1;
      })
      .slice(0, 12);
  }, [q, movies]);

  useEffect(() => {
    const h = e => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <input type="text" value={q}
        onChange={e => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        placeholder={placeholder || "Search movies…"}
      />
      {open && hits.length > 0 && (
        <div className="dropdown">
          {hits.map(([idx, m]) => {
            const color = genreColor(m.genres);
            return (
              <div key={idx} className="dditem"
                onMouseDown={() => { onSelect(Number(idx), m); setQ(""); setOpen(false); }}>
                <div style={{ width: 30, height: 45, borderRadius: 4, overflow: "hidden", flexShrink: 0 }}>
                  <Poster title={m.title} year={m.year} genres={m.genres} cache={cache} onNeeded={onNeeded} />
                </div>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{m.title}</div>
                  <div style={{ fontSize: 11, color: C.textSub }}>
                    {m.year}
                    {m.genres?.[0] && <span style={{ color, marginLeft: 4 }}>• {m.genres[0]}</span>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Gate Donut ─────────────────────────────────────────────────────────────

function Donut({ gcn, memory, seq }) {
  const segs = [
    { label: "GCN", val: gcn, color: C.accent },
    { label: "Memory", val: memory, color: C.green },
    { label: "Seq", val: seq, color: C.amber },
  ];
  const r = 50, cx = 68, cy = 68, sw = 13, circ = 2 * Math.PI * r;
  let off = 0;
  const arcs = segs.map(s => {
    const dash = s.val * circ, seg = { ...s, dash, off };
    off += dash; return seg;
  });
  const dom = segs.reduce((a, b) => a.val > b.val ? a : b);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 22 }}>
      <svg width={136} height={136}>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={C.surface} strokeWidth={sw} />
        {arcs.map(({ label, dash, off: o, color }) => (
          <circle key={label} cx={cx} cy={cy} r={r} fill="none" stroke={color}
            strokeWidth={sw} strokeDasharray={`${dash} ${circ - dash}`}
            strokeDashoffset={circ / 4 - o} style={{ transition: "stroke-dasharray .8s ease" }} />
        ))}
        <text x={cx} y={cy - 5} textAnchor="middle" fill={dom.color}
          fontFamily="'JetBrains Mono',monospace" fontSize="15" fontWeight="700">
          {Math.round(dom.val * 100)}%
        </text>
        <text x={cx} y={cy + 13} textAnchor="middle" fill={C.textSub}
          fontFamily="'Space Grotesk',sans-serif" fontSize="10">
          {dom.label}
        </text>
      </svg>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {segs.map(({ label, val, color }) => (
          <div key={label} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ width: 8, height: 8, borderRadius: 2, background: color }} />
            <span style={{ color: C.textSub, fontSize: 13, width: 52 }}>{label}</span>
            <span className="mono" style={{ color, fontSize: 13, fontWeight: 600 }}>
              {Math.round(val * 100)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Nav ────────────────────────────────────────────────────────────────────

function Nav({ tab, setTab, status, moviesCount }) {
  const tabs = ["Recommend", "Custom Pick", "Explain", "Metrics", "Settings"];
  return (
    <nav style={{
      position: "sticky", top: 0, zIndex: 100,
      background: C.bg + "EE", backdropFilter: "blur(20px)",
      borderBottom: `1px solid ${C.border}`,
      display: "flex", alignItems: "center",
      padding: "0 24px", height: 56, gap: 4
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginRight: 20 }}>
        <div style={{
          width: 26, height: 26, borderRadius: 7,
          background: `linear-gradient(135deg,${C.accent},#A78BFA)`,
          display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12
        }}>⚡</div>
        <span style={{ fontWeight: 700, fontSize: 15, letterSpacing: "-.03em" }}>HybridRec</span>
      </div>
      <div style={{ display: "flex", gap: 2, flex: 1, overflowX: "auto" }}>
        {tabs.map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            background: tab === t ? C.accentLo : "transparent",
            color: tab === t ? C.accent : C.textSub,
            border: tab === t ? `1px solid ${C.accent}44` : "1px solid transparent",
            borderRadius: 8, padding: "5px 13px", font: "inherit",
            fontSize: 13, fontWeight: tab === t ? 600 : 400,
            cursor: "pointer", transition: "all .15s", whiteSpace: "nowrap"
          }}>
            {t}
          </button>
        ))}
      </div>
      {/* Status pill — shows movie count when loaded */}
      <div style={{
        display: "flex", alignItems: "center", gap: 6, padding: "3px 10px",
        background: status?.loaded ? C.green + "11" : C.red + "11",
        border: `1px solid ${status?.loaded ? C.green + "44" : C.red + "44"}`,
        borderRadius: 20, fontSize: 12, color: status?.loaded ? C.green : C.red, flexShrink: 0
      }}>
        <div style={{
          width: 6, height: 6, borderRadius: "50%",
          background: status?.loaded ? C.green : C.red,
          animation: !status?.loaded ? "pulse 1.5s infinite" : "none"
        }} />
        {status?.loaded
          ? `${status.n_users?.toLocaleString()} users · ${moviesCount} movies`
          : "Offline"}
      </div>
    </nav>
  );
}

// ── Recommend Tab ──────────────────────────────────────────────────────────

function RecommendTab({ users, movies, cache, onNeeded }) {
  const [uid, setUid] = useState("");
  const [topK, setTopK] = useState(10);
  const [res, setRes] = useState(null);
  const [load, setLoad] = useState(false);
  const [err, setErr] = useState(null);

  const run = useCallback(async (u) => {
    const id = parseInt(u ?? uid);
    if (isNaN(id)) return;
    setLoad(true); setErr(null); setRes(null);
    try {
      const data = await fetchWithRetry(`${API}/recommend`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: id, top_k: topK }),
      });
      setRes(data);
    } catch (e) { setErr(e.message); }
    finally { setLoad(false); }
  }, [uid, topK]);

  const rand = () => {
    if (!users.length) return;
    const u = users[Math.floor(Math.random() * users.length)];
    setUid(String(u)); run(u);
  };

  return (
    <div>
      <SectionTitle children="Recommendations" sub="Get personalized top-K recommendations for any user" />
      <div style={{ display: "flex", gap: 10, marginBottom: 22, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 160px" }}>
          <label style={{
            display: "block", fontSize: 11, color: C.textSub, marginBottom: 5,
            letterSpacing: ".07em", textTransform: "uppercase"
          }}>User ID</label>
          <input type="number" value={uid} onChange={e => setUid(e.target.value)}
            placeholder="e.g. 42" onKeyDown={e => e.key === "Enter" && run()} />
        </div>
        <div style={{ flex: "0 0 88px" }}>
          <label style={{
            display: "block", fontSize: 11, color: C.textSub, marginBottom: 5,
            letterSpacing: ".07em", textTransform: "uppercase"
          }}>Top K</label>
          <input type="number" value={topK} min={1} max={50}
            onChange={e => setTopK(Number(e.target.value))} />
        </div>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
          <button className="btn" onClick={() => run()} disabled={!uid || load}>
            {load ? <span className="spinner" /> : "▶"} Run
          </button>
          <button className="btn btn-ghost" onClick={rand} disabled={load}>🎲 Random</button>
        </div>
      </div>

      {err && <Err msg={err} />}
      {load && <Loader />}

      {res && (
        <div className="fade-up">
          <div className="card" style={{
            display: "flex", gap: 20, flexWrap: "wrap",
            alignItems: "center", marginBottom: 14
          }}>
            <div>
              <div style={{ fontSize: 10, color: C.textSub, textTransform: "uppercase", letterSpacing: ".07em" }}>User</div>
              <div className="mono" style={{ fontSize: 22, fontWeight: 600, color: C.accent }}>#{res.user_id}</div>
            </div>
            <div>
              <div style={{ fontSize: 10, color: C.textSub, textTransform: "uppercase", letterSpacing: ".07em" }}>History</div>
              <div className="mono" style={{ fontSize: 22, fontWeight: 600 }}>{res.history_len} films</div>
            </div>
            <div>
              <div style={{ fontSize: 10, color: C.textSub, textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 4 }}>Ground Truth</div>
              <Chip itemIdx={res.ground_truth} movies={movies} />
            </div>
            <Tag color={res.hit ? C.green : C.red}>{res.hit ? "✓ HIT" : "✗ MISS"}</Tag>
          </div>

          <div className="card" style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 10, color: C.textSub, marginBottom: 10, textTransform: "uppercase", letterSpacing: ".07em" }}>
              Last watched
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
              {res.history.map((id, i) => <Chip key={i} itemIdx={id} movies={movies} />)}
            </div>
          </div>

          <div className="card">
            <div style={{ fontSize: 10, color: C.textSub, marginBottom: 14, textTransform: "uppercase", letterSpacing: ".07em" }}>
              Top-{topK} recommendations
            </div>
            <div className="movie-grid">
              {res.recommendations.map((r, i) => (
                <MCard key={r.item_id} itemIdx={r.item_id} movies={movies}
                  cache={cache} onNeeded={onNeeded}
                  rank={i + 1} score={r.score} pop={r.popularity}
                  isHit={r.item_id === res.ground_truth} delay={i * .04} />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Custom Pick Tab ────────────────────────────────────────────────────────

function CustomPickTab({ movies, cache, onNeeded }) {
  const [selected, setSelected] = useState([]);
  const [topK, setTopK] = useState(10);
  const [res, setRes] = useState(null);
  const [load, setLoad] = useState(false);
  const [err, setErr] = useState(null);

  const addMovie = (idx, movie) => {
    if (selected.find(s => s.idx === idx)) return;
    setSelected(p => [...p, { idx, movie }]);
    setRes(null);
  };
  const removeMovie = idx => setSelected(p => p.filter(s => s.idx !== idx));

  const run = async () => {
    if (!selected.length) return;
    setLoad(true); setErr(null); setRes(null);
    try {
      const data = await fetchWithRetry(`${API}/recommend/custom`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ history: selected.map(s => s.idx), top_k: topK }),
      });
      setRes(data);
    } catch (e) { setErr(e.message); }
    finally { setLoad(false); }
  };

  const noMovies = Object.keys(movies).length === 0;

  return (
    <div>
      <SectionTitle children="Custom Movie Picker"
        sub="Search and pick movies you love — we'll find what to watch next" />

      <div className="card" style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 10, color: C.textSub, marginBottom: 10, textTransform: "uppercase", letterSpacing: ".07em" }}>
          Search & add movies to your history
        </div>
        {noMovies ? (
          <div style={{ color: C.amber, fontSize: 13, padding: "8px 0", lineHeight: 1.6 }}>
            ⚠ Movie metadata not loaded yet — the server may still be starting up. Refresh in a few seconds.
            If it persists, check that your FastAPI backend has CORS enabled and the <code style={{ color: C.accent }}>/movies</code> endpoint is working.
          </div>
        ) : (
          <MovieSearch movies={movies} cache={cache} onNeeded={onNeeded}
            onSelect={addMovie}
            placeholder="Type to search — e.g. Toy Story, Matrix, Pulp Fiction…" />
        )}
      </div>

      {selected.length > 0 && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <div style={{ fontSize: 10, color: C.textSub, textTransform: "uppercase", letterSpacing: ".07em" }}>
              Your history · {selected.length} {selected.length === 1 ? "movie" : "movies"}
            </div>
            <button className="btn btn-ghost btn-sm btn-danger" onClick={() => { setSelected([]); setRes(null); }}>
              Clear all
            </button>
          </div>
          <div className="movie-grid">
            {selected.map(({ idx }, i) => (
              <div key={idx} style={{ position: "relative" }}>
                <MCard itemIdx={idx} movies={movies} cache={cache} onNeeded={onNeeded}
                  isSelected delay={i * .04} />
                <button onClick={() => removeMovie(idx)} style={{
                  position: "absolute", top: 6, right: 6, zIndex: 10,
                  background: C.red + "CC", border: "none", borderRadius: 6,
                  color: "#fff", fontSize: 13, fontWeight: 700,
                  width: 22, height: 22, cursor: "pointer",
                  display: "flex", alignItems: "center", justifyContent: "center"
                }}>×</button>
              </div>
            ))}
          </div>

          <div style={{ display: "flex", gap: 10, marginTop: 16, alignItems: "flex-end", flexWrap: "wrap" }}>
            <div style={{ width: 88 }}>
              <label style={{
                display: "block", fontSize: 11, color: C.textSub, marginBottom: 4,
                letterSpacing: ".07em", textTransform: "uppercase"
              }}>Top K</label>
              <input type="number" value={topK} min={1} max={50}
                onChange={e => setTopK(Number(e.target.value))} />
            </div>
            <button className="btn" onClick={run} disabled={load || !selected.length}>
              {load ? <span className="spinner" /> : "⚡"} Get Recommendations
            </button>
          </div>
        </div>
      )}

      {err && <Err msg={err} />}
      {load && <Loader text="Computing recommendations…" />}

      {res && (
        <div className="card fade-up">
          <div style={{ fontSize: 10, color: C.textSub, marginBottom: 14, textTransform: "uppercase", letterSpacing: ".07em" }}>
            Recommended for you · based on {selected.length} picked movies
          </div>
          <div className="movie-grid-lg">
            {res.recommendations.map((r, i) => (
              <MCard key={r.item_id} itemIdx={r.item_id} movies={movies}
                cache={cache} onNeeded={onNeeded}
                rank={i + 1} score={r.score} pop={r.popularity} delay={i * .04} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Explain Tab ────────────────────────────────────────────────────────────

function ExplainTab({ users, movies, cache, onNeeded, apiKey }) {
  const [uid, setUid] = useState("");
  const [topK, setTopK] = useState(10);
  const [res, setRes] = useState(null);
  const [nlRes, setNl] = useState(null);
  const [load, setLoad] = useState(false);
  const [nlLoad, setNlLoad] = useState(false);
  const [err, setErr] = useState(null);

  const run = useCallback(async (u) => {
    const id = parseInt(u ?? uid);
    if (isNaN(id)) return;
    setLoad(true); setErr(null); setRes(null); setNl(null);
    try {
      const data = await fetchWithRetry(`${API}/explain`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: id, top_k: topK }),
      });
      setRes(data);
    } catch (e) { setErr(e.message); }
    finally { setLoad(false); }
  }, [uid, topK]);

  const runNL = async () => {
    if (!apiKey || !res) return;
    setNlLoad(true);
    try {
      const data = await fetchWithRetry(`${API}/explain/nl`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: res.user_id, top_k: topK, anthropic_api_key: apiKey }),
      });
      setNl(data.natural_language);
    } catch (e) { setErr(e.message); }
    finally { setNlLoad(false); }
  };

  const rand = () => {
    if (!users.length) return;
    const u = users[Math.floor(Math.random() * users.length)];
    setUid(String(u)); run(u);
  };

  return (
    <div>
      <SectionTitle children="Explainability"
        sub="Attention weights, component gates, and Claude-powered natural language explanation" />

      <div style={{ display: "flex", gap: 10, marginBottom: 22, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 160px" }}>
          <label style={{
            display: "block", fontSize: 11, color: C.textSub, marginBottom: 5,
            letterSpacing: ".07em", textTransform: "uppercase"
          }}>User ID</label>
          <input type="number" value={uid} onChange={e => setUid(e.target.value)}
            placeholder="e.g. 42" onKeyDown={e => e.key === "Enter" && run()} />
        </div>
        <div style={{ flex: "0 0 88px" }}>
          <label style={{
            display: "block", fontSize: 11, color: C.textSub, marginBottom: 5,
            letterSpacing: ".07em", textTransform: "uppercase"
          }}>Top K</label>
          <input type="number" value={topK} min={1} max={50} onChange={e => setTopK(Number(e.target.value))} />
        </div>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
          <button className="btn" onClick={() => run()} disabled={!uid || load}>
            {load ? <span className="spinner" /> : "⚡"} Explain
          </button>
          <button className="btn btn-ghost" onClick={rand} disabled={load}>🎲 Random</button>
        </div>
      </div>

      {err && <Err msg={err} />}
      {load && <Loader text="Computing explanations…" />}

      {res && (
        <div className="fade-up" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="card" style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "center" }}>
            <div>
              <div style={{ fontSize: 10, color: C.textSub, textTransform: "uppercase", letterSpacing: ".07em" }}>User</div>
              <div className="mono" style={{ fontSize: 22, fontWeight: 600, color: C.accent }}>#{res.user_id}</div>
            </div>
            <div>
              <div style={{ fontSize: 10, color: C.textSub, textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 4 }}>Target</div>
              <Chip itemIdx={res.target_item} movies={movies} />
            </div>
            <Tag color={res.hit ? C.green : C.red}>{res.hit ? "✓ HIT" : "✗ MISS"}</Tag>
          </div>

          <div className="grid2">
            <div className="card">
              <div style={{ fontSize: 10, color: C.textSub, marginBottom: 14, textTransform: "uppercase", letterSpacing: ".07em" }}>
                Component contributions
              </div>
              <Donut gcn={res.component_weights.gcn} memory={res.component_weights.memory} seq={res.component_weights.seq} />
              <div style={{ marginTop: 14, fontSize: 13, color: C.textSub, lineHeight: 1.65 }}>
                {res.component_weights.gcn > res.component_weights.memory && res.component_weights.gcn > res.component_weights.seq
                  ? "🤝 Collaborative filtering was the main signal — users with similar taste shaped this."
                  : res.component_weights.memory > res.component_weights.seq
                    ? "🧠 Long-term memory dominated — deep historic preference patterns matched."
                    : "⏱ Recent watch behavior was the key driver."}
              </div>
            </div>

            <div className="card">
              <div style={{ fontSize: 10, color: C.textSub, marginBottom: 14, textTransform: "uppercase", letterSpacing: ".07em" }}>
                Most influential in history
              </div>
              {res.history_influence.map((inf, i) => {
                const m = movies?.[String(inf.item_id)];
                const title = m?.title || `#${inf.item_id}`;
                const color = inf.label === "confirmed" ? C.green : C.muted;
                const pct = Math.round(inf.attention * 100);
                return (
                  <div key={inf.item_id} style={{ marginBottom: 10, animation: `fadeUp .3s ease ${i * .05}s both` }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                      <span style={{
                        fontSize: 12, color: C.text, fontWeight: 500,
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "75%"
                      }}>
                        {title}
                        {m?.year && <span style={{ color: C.textSub, fontWeight: 400, marginLeft: 5 }}>({m.year})</span>}
                      </span>
                      <span className="mono" style={{ color, fontSize: 11, flexShrink: 0 }}>{pct}%</span>
                    </div>
                    <div style={{ background: C.surface, borderRadius: 3, height: 5, overflow: "hidden" }}>
                      <div style={{
                        height: "100%", borderRadius: 3, background: color,
                        width: `${pct}%`, transition: "width .6s ease"
                      }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="card">
            <div style={{ fontSize: 10, color: C.textSub, marginBottom: 14, textTransform: "uppercase", letterSpacing: ".07em" }}>
              Top-{topK} recommendations
            </div>
            <div className="movie-grid">
              {res.top_recommendations.map((id, i) => (
                <MCard key={id} itemIdx={id} movies={movies} cache={cache} onNeeded={onNeeded}
                  rank={i + 1} isHit={id === res.target_item} delay={i * .04} />
              ))}
            </div>
          </div>

          <div className="card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <div style={{ fontSize: 10, color: C.textSub, textTransform: "uppercase", letterSpacing: ".07em" }}>
                Natural language explanation · Claude
              </div>
              <button className="btn btn-sm" onClick={runNL} disabled={!apiKey || nlLoad}>
                {nlLoad ? <span className="spinner" /> : "✨"} Generate
              </button>
            </div>
            {!apiKey && (
              <div style={{ color: C.amber, fontSize: 13 }}>
                ⚠ Add your Anthropic API key in Settings to enable this.
              </div>
            )}
            {nlRes && (
              <div style={{
                background: C.surface, border: `1px solid ${C.accent}2E`, borderRadius: 10,
                padding: 16, lineHeight: 1.75, fontSize: 14, animation: "fadeUp .4s ease"
              }}>
                {nlRes}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Metrics Tab ────────────────────────────────────────────────────────────

function MetricsTab() {
  const [data, setData] = useState(null);
  const [load, setLoad] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    (async () => {
      setLoad(true);
      try {
        const d = await fetchWithRetry(`${API}/metrics`);
        setData(d);
      } catch (e) {
        setErr(e.message);
      }
      setLoad(false);
    })();
  }, []);

  if (load) return <Loader />;
  if (err) return <Err msg={err} />;
  if (!data) return <div style={{ color: C.textSub }}>No metrics available.</div>;

  const { test_metrics, best_hr, best_epoch, history } = data;
  const hrK = Object.keys(history?.[0] || {}).find(k => k.startsWith("HR@")) || "HR@10";
  const ndcgK = Object.keys(history?.[0] || {}).find(k => k.startsWith("NDCG@")) || "NDCG@10";
  const mrrK = Object.keys(history?.[0] || {}).find(k => k.startsWith("MRR@")) || "MRR@10";
  const chart = (history || []).filter(r => r[hrK] != null);
  const mxHR = Math.max(...chart.map(r => r[hrK] || 0), .01);
  const mxL = Math.max(...(history || []).map(r => r.train_loss || 0), .01);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <SectionTitle children="Model Metrics"
        sub={`Best checkpoint · epoch ${best_epoch} · HR@10 = ${best_hr?.toFixed(4)}`} />

      {test_metrics && (
        <div className="grid3">
          {[hrK, ndcgK, mrrK].map(k => (
            <div key={k} className="card" style={{ textAlign: "center" }}>
              <div className="mono" style={{ fontSize: 26, fontWeight: 700, color: C.accent }}>
                {test_metrics[k]?.toFixed(4)}
              </div>
              <div style={{ color: C.textSub, fontSize: 10, marginTop: 6, textTransform: "uppercase", letterSpacing: ".07em" }}>
                {k}
              </div>
            </div>
          ))}
        </div>
      )}

      {chart.length > 0 && (
        <div className="card">
          <div style={{ fontSize: 10, color: C.textSub, marginBottom: 10, textTransform: "uppercase", letterSpacing: ".07em" }}>
            Validation HR over training
          </div>
          <svg viewBox={`0 0 ${chart.length} 100`} style={{ width: "100%", height: 110 }}
            preserveAspectRatio="none">
            <defs>
              <linearGradient id="hg" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={C.accent} stopOpacity=".35" />
                <stop offset="100%" stopColor={C.accent} stopOpacity="0" />
              </linearGradient>
            </defs>
            <path
              d={`M0,${100 - (chart[0][hrK] / mxHR) * 92} ` +
                chart.map((r, i) => `L${i},${100 - (r[hrK] / mxHR) * 92}`).join(" ") +
                ` L${chart.length - 1},100 L0,100 Z`}
              fill="url(#hg)" />
            <polyline
              points={chart.map((r, i) => `${i},${100 - (r[hrK] / mxHR) * 92}`).join(" ")}
              fill="none" stroke={C.accent} strokeWidth=".5" />
          </svg>

          <div style={{ fontSize: 10, color: C.textSub, marginTop: 18, marginBottom: 10, textTransform: "uppercase", letterSpacing: ".07em" }}>
            Training loss
          </div>
          <svg viewBox={`0 0 ${(history || []).length} 100`} style={{ width: "100%", height: 75 }}
            preserveAspectRatio="none">
            <polyline
              points={(history || []).map((r, i) => `${i},${100 - ((r.train_loss || 0) / mxL) * 92}`).join(" ")}
              fill="none" stroke={C.red} strokeWidth=".5" />
          </svg>
        </div>
      )}

      {test_metrics && (
        <div className="card">
          <div style={{ fontSize: 10, color: C.textSub, marginBottom: 12, textTransform: "uppercase", letterSpacing: ".07em" }}>
            Raw test metrics
          </div>
          {Object.entries(test_metrics).map(([k, v]) => (
            <div key={k} style={{
              display: "flex", justifyContent: "space-between",
              padding: "9px 0", borderBottom: `1px solid ${C.border}`, fontSize: 13
            }}>
              <span className="mono" style={{ color: C.textSub }}>{k}</span>
              <span className="mono" style={{ color: C.accent, fontWeight: 600 }}>{v?.toFixed(4)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Settings Tab ───────────────────────────────────────────────────────────

function SettingsTab({ apiKey, setApiKey, tmdbKey, setTmdbKey }) {
  const [dA, setDA] = useState(apiKey);
  const [dT, setDT] = useState(tmdbKey);

  return (
    <div style={{ maxWidth: 500 }}>
      <SectionTitle children="Settings" />

      <div className="card" style={{ marginBottom: 14 }}>
        <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>🎬 TMDB API Key</div>
        <div style={{ fontSize: 13, color: C.textSub, lineHeight: 1.65, marginBottom: 12 }}>
          Enables real movie poster images. Get a free key at{" "}
          <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noreferrer"
            style={{ color: C.accent }}>themoviedb.org → Settings → API</a>.
          It's free and instant. Without it, styled placeholder cards are shown instead.
        </div>
        <input type="text" value={dT} onChange={e => setDT(e.target.value)}
          placeholder="Your TMDB v3 API key" style={{ marginBottom: 10 }} />
        <button className="btn" onClick={() => {
          // Clear cached posters so they reload with new key
          Object.keys(PC).forEach(k => delete PC[k]);
          setTmdbKey(dT);
        }}>Save & reload posters</button>
        {tmdbKey && (
          <span style={{ color: C.green, fontSize: 13, marginLeft: 12 }}>✓ Active — posters loading</span>
        )}
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>✨ Anthropic API Key</div>
        <div style={{ fontSize: 13, color: C.textSub, lineHeight: 1.65, marginBottom: 12 }}>
          Required for natural language explanations via Claude in the Explain tab.
        </div>
        <input type="password" value={dA} onChange={e => setDA(e.target.value)}
          placeholder="sk-ant-…" style={{ marginBottom: 10 }} />
        <button className="btn" onClick={() => setApiKey(dA)}>Save</button>
        {apiKey && (
          <span style={{ color: C.green, fontSize: 13, marginLeft: 12 }}>✓ Saved for this session</span>
        )}
      </div>

      {/* Diagnostics panel */}
      <div className="card">
        <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10 }}>🔧 Connection diagnostics</div>
        <div style={{ fontSize: 13, color: C.textSub, lineHeight: 1.7 }}>
          If movie names or posters aren't showing:
          <ol style={{ marginTop: 8, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 6 }}>
            <li>Open browser DevTools (F12) → Network tab → reload page</li>
            <li>Check that <code style={{ color: C.accent }}>GET /movies</code> returns JSON, not an error</li>
            <li>If you see a CORS error, add <code style={{ color: C.accent }}>CORSMiddleware</code> to your FastAPI app (see below)</li>
            <li>Make sure the <code style={{ color: C.accent }}>API</code> constant at the top of this file matches your running server URL</li>
          </ol>
          <div style={{
            marginTop: 14, background: C.surface, borderRadius: 8, padding: "10px 14px",
            fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: C.textSub,
            lineHeight: 1.7
          }}>
            {`from fastapi.middleware.cors import CORSMiddleware\n\napp.add_middleware(\n    CORSMiddleware,\n    allow_origins=["*"],\n    allow_methods=["*"],\n    allow_headers=["*"],\n)`}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Root ───────────────────────────────────────────────────────────────────

export default function App() {
  const [tab, setTab] = useState("Recommend");
  const [status, setStatus] = useState(null);
  const [users, setUsers] = useState([]);
  const [movies, setMovies] = useState({});
  const [moviesErr, setMoviesErr] = useState(null);
  const [cache, setCache] = useState({});
  const [apiKey, setApiKey] = useState("");
  const [tmdbKey, setTmdbKey] = useState("");

  useEffect(() => {
    (async () => {
      // FIX: fetch status + users + movies with retry and individual error handling
      let s = null, u = [], m = {};

      // 1. Status
      try {
        s = await fetchWithRetry(`${API}/status`);
      } catch (e) {
        console.error("❌ /status failed:", e.message);
        s = { loaded: false };
      }
      setStatus(s);

      // 2. Users
      try {
        const ud = await fetchWithRetry(`${API}/users?limit=500`);
        u = ud.users || [];
      } catch (e) {
        console.error("❌ /users failed:", e.message);
      }
      setUsers(u);

      // 3. Movies — most critical fix: separate try/catch + detailed logging
      try {
        const raw = await fetchWithRetry(`${API}/movies`, {}, 4, 12000);
        // Validate it looks like a movie map
        if (raw && typeof raw === "object" && !Array.isArray(raw)) {
          const count = Object.keys(raw).length;
          if (count === 0) {
            console.warn("⚠ /movies returned empty object — model may still be loading");
            setMoviesErr("Server returned no movies yet. The model may still be loading — try refreshing in 10 seconds.");
          } else {
            console.log(`✅ /movies loaded: ${count} movies`);
            m = raw;
          }
        } else {
          console.error("❌ /movies returned unexpected shape:", raw);
          setMoviesErr("Server returned unexpected data from /movies.");
        }
      } catch (e) {
        console.error("❌ /movies failed:", e.message);
        setMoviesErr(`Could not load movie metadata: ${e.message}. Check CORS settings and server URL.`);
      }
      setMovies(m);
    })();
  }, []);

  // Lazy poster loader — only runs when TMDB key is set
  const loadPoster = useCallback((title, year) => {
    if (!tmdbKey || !title) return;
    const k = pkey(title, year);
    if (PC[k] !== undefined) return;
    PC[k] = "loading";
    setCache(p => ({ ...p, [k]: "loading" }));
    const q = encodeURIComponent(title.replace(/[,\.!:]/g, ""));
    const url = `https://api.themoviedb.org/3/search/movie?api_key=${tmdbKey}&query=${q}${year ? `&year=${year}` : ""}`;
    fetch(url)
      .then(r => r.json())
      .then(data => {
        const path = data.results?.[0]?.poster_path;
        const imgUrl = path ? `https://image.tmdb.org/t/p/w200${path}` : null;
        PC[k] = imgUrl;
        setCache(p => ({ ...p, [k]: imgUrl }));
      })
      .catch(() => {
        PC[k] = null;
        setCache(p => ({ ...p, [k]: null }));
      });
  }, [tmdbKey]);

  const cp = { movies, cache, onNeeded: loadPoster };
  const moviesCount = Object.keys(movies).length;

  return (
    <>
      <style>{css}</style>
      <Nav tab={tab} setTab={setTab} status={status} moviesCount={moviesCount} />
      <main style={{ maxWidth: 1080, margin: "0 auto", padding: "30px 18px" }}>

        {/* Global warning if movies didn't load */}
        {moviesErr && (
          <div style={{
            background: C.amber + "11", border: `1px solid ${C.amber}44`, borderRadius: 12,
            padding: "12px 16px", marginBottom: 20, color: C.amber, fontSize: 13, lineHeight: 1.6
          }}>
            ⚠ <strong>Movie metadata issue:</strong> {moviesErr}
            {" "}<button
              className="btn btn-ghost btn-sm"
              style={{ marginLeft: 10, color: C.amber, borderColor: C.amber + "44" }}
              onClick={() => window.location.reload()}
            >
              Retry
            </button>
          </div>
        )}

        {tab === "Recommend" && <RecommendTab users={users} {...cp} />}
        {tab === "Custom Pick" && <CustomPickTab {...cp} />}
        {tab === "Explain" && <ExplainTab users={users} apiKey={apiKey} {...cp} />}
        {tab === "Metrics" && <MetricsTab />}
        {tab === "Settings" && (
          <SettingsTab apiKey={apiKey} setApiKey={setApiKey}
            tmdbKey={tmdbKey} setTmdbKey={setTmdbKey} />
        )}
      </main>
    </>
  );
}