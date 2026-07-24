// Bilibili API helpers: metadata, wbi signing, audio-stream resolution.
import { md5 } from "./md5.js";

const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
];

const J = (r) => r.json();
const GET = (url) => fetch(url, { credentials: "include" }).then(J);

// --- BV id extraction ---------------------------------------------------
export function parseBvid(input) {
  if (!input) return null;
  const m = String(input).match(/BV[0-9A-Za-z]{10}/);
  return m ? m[0] : null;
}

// A `p=N` query param scoped to one matched URL tail (never a bare `p=` from
// elsewhere in the line — it must follow `?` or `&`).
const P_PARAM = /[?&]p=(\d+)/;

// Multi-part videos share one BV id; the part is the `p` query param. The
// canonical id is `BV...?p=N` for parts past the first and the bare BV id
// otherwise, so pre-multi-p tracks (stored as bare ids) still dedup against
// re-added links, and exports stay importable.
function canonicalId(bvid, p) {
  return p > 1 ? `${bvid}?p=${p}` : bvid;
}

// Every BV id in a blob of text (batch add / import), de-duped, order kept.
// Each id keeps the `p=N` part selector of the URL it came from, so the same
// BV id may appear more than once with different parts.
export function parseBvids(input) {
  const out = [];
  const seen = new Set();
  const re = /BV[0-9A-Za-z]{10}[^\s"'<>]*/g;
  for (const m of String(input || "").matchAll(re)) {
    const bvid = m[0].slice(0, 12);
    const pm = m[0].slice(12).match(P_PARAM);
    const id = canonicalId(bvid, pm ? parseInt(pm[1], 10) : 1);
    if (!seen.has(id)) { seen.add(id); out.push(id); }
  }
  return out;
}

// --- wbi signing --------------------------------------------------------
let _wbiCache = { key: null, ts: 0 };

async function getMixinKey() {
  const now = Date.now();
  if (_wbiCache.key && now - _wbiCache.ts < 3600e3) return _wbiCache.key;
  const nav = await GET("https://api.bilibili.com/x/web-interface/nav");
  const img = nav?.data?.wbi_img?.img_url || "";
  const sub = nav?.data?.wbi_img?.sub_url || "";
  const imgKey = img.slice(img.lastIndexOf("/") + 1).split(".")[0];
  const subKey = sub.slice(sub.lastIndexOf("/") + 1).split(".")[0];
  const orig = imgKey + subKey;
  const key = MIXIN_TAB.map((n) => orig[n]).join("").slice(0, 32);
  _wbiCache = { key, ts: now };
  return key;
}

async function encWbi(params) {
  const mixinKey = await getMixinKey();
  const wts = Math.round(Date.now() / 1000);
  const p = { ...params, wts };
  const query = Object.keys(p)
    .sort()
    .map((k) => {
      const v = String(p[k]).replace(/[!'()*]/g, "");
      return `${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
    })
    .join("&");
  const w_rid = md5(query + mixinKey);
  return `${query}&w_rid=${w_rid}`;
}

// --- public API ---------------------------------------------------------
// Accepts a bare BV id or a canonical `BV...?p=N` id from parseBvids. For
// multi-part videos the part's own cid/duration are used (the top-level cid
// is always part 1's) and the part name is folded into the title so parts
// are tellable apart in a list.
export async function fetchMeta(id) {
  const bvid = parseBvid(id);
  const pm = String(id).match(P_PARAM);
  const p = pm ? parseInt(pm[1], 10) : 1;
  const r = await GET(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`);
  if (r.code !== 0) throw new Error(r.message || `view failed (${r.code})`);
  const d = r.data;
  const pages = Array.isArray(d.pages) ? d.pages : [];
  const page = pages.find((x) => x.page === p);
  if (p > 1 && !page) {
    throw new Error(`${bvid} has no P${p} (only ${pages.length || 1} part${pages.length === 1 ? "" : "s"})`);
  }
  const multi = pages.length > 1;
  const part = page?.part && page.part !== d.title ? page.part : "";
  return {
    source: "bilibili",
    id: canonicalId(bvid, p),
    bvid,
    cid: page?.cid || d.cid,
    title: multi ? `${d.title}（P${p}${part ? ` ${part}` : ""}）` : d.title,
    author: d.owner?.name || "",
    cover: (d.pic || "").replace(/^http:/, "https:"),
    duration: (multi && page?.duration) || d.duration,
    addedAt: Date.now()
  };
}

// Resolve a fresh audio stream URL (URLs are short-lived — never cache).
export async function resolveAudioUrl(bvid, cid) {
  const query = await encWbi({ bvid, cid, fnval: 16, fnver: 0, fourk: 1 });
  const r = await GET(`https://api.bilibili.com/x/player/wbi/playurl?${query}`);
  if (r.code !== 0) throw new Error(r.message || `playurl failed (${r.code})`);
  const dash = r.data?.dash;
  if (!dash?.audio?.length) throw new Error("no audio stream (DASH missing)");
  // pick highest-bandwidth audio track
  const best = dash.audio.reduce((a, b) => (b.bandwidth > a.bandwidth ? b : a));
  return best.baseUrl || best.base_url;
}
