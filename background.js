// Service worker: owns collections + playback state, resolves streams,
// drives the offscreen audio element, routes messages to the side panel.
// Playback state is PERSISTED so auto-advance survives SW termination
// (fully background, panel closed).
import { parseBvids, fetchMeta, resolveAudioUrl } from "./lib/bili.js";
import { parseDirectUrl, directMeta } from "./lib/direct.js";

const trackId = (t) => t.id || t.bvid || t.videoId;

const COLLECTIONS_KEY = "collections";      // { name: [track,...] }
const CURRENT_KEY = "currentCollection";    // name
const PLAYSTATE_KEY = "playstate";          // persisted `state`
const LEGACY_FAVS_KEY = "favorites";        // v0.1 single list

// repeat: "all" (list loops — the default) | "one". There's no "off": running
// off the end of the list wraps to the top rather than stopping.
const DEFAULT_STATE = {
  queue: [], index: -1, playing: false,
  position: 0, duration: 0, volume: 1,
  shuffle: false, repeat: "all",
  queueName: "",   // collection the queue came from — lets edits re-point it
  order: null,     // shuffle pass: queue indices in play order
  dropped: null,   // id of a deleted track still holding its slot until it ends
  loadId: 0        // rejects stale stream resolutions and audio events
};

let state = { ...DEFAULT_STATE };
let loaded = false;
let loadPromise = null;
let offscreenCreation = null;

// ── persistence ─────────────────────────────────────────────────────────
async function loadState() {
  if (loaded) return;
  if (!loadPromise) {
    loadPromise = (async () => {
      const o = await chrome.storage.local.get(PLAYSTATE_KEY);
      if (o[PLAYSTATE_KEY]) state = { ...DEFAULT_STATE, ...o[PLAYSTATE_KEY] };
      if (state.repeat === "off") state.repeat = "all";  // v0.2 mode, dropped
      // The browser does not restore offscreen documents across restarts.
      if (state.playing && chrome.offscreen.hasDocument && !(await chrome.offscreen.hasDocument())) {
        state.playing = false;
      }
      loaded = true;
    })().finally(() => { loadPromise = null; });
  }
  await loadPromise;
}
function saveState() {
  chrome.storage.local.set({ [PLAYSTATE_KEY]: state });
}

// Header rewriting must only affect requests made by this extension. Dynamic
// rules can use the runtime extension id; a static rule would affect every tab.
// Rule 1000 was an old YouTube rule and is removed during the same update.
const AUDIO_HEADER_RULE_ID = 1001;
const headerRuleReady = chrome.declarativeNetRequest.updateDynamicRules({
  removeRuleIds: [1000, AUDIO_HEADER_RULE_ID],
  addRules: [{
    id: AUDIO_HEADER_RULE_ID,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [
        { header: "Referer", operation: "set", value: "https://www.bilibili.com" },
        { header: "Origin", operation: "set", value: "https://www.bilibili.com" }
      ]
    },
    condition: {
      initiatorDomains: [chrome.runtime.id],
      requestDomains: ["bilivideo.com", "bilivideo.cn", "akamaized.net", "hdslb.com"],
      resourceTypes: ["media", "xmlhttprequest", "other"]
    }
  }]
}).catch((e) => e);

// ── side panel opens on toolbar click ───────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// ── offscreen audio host ────────────────────────────────────────────────
async function ensureOffscreen() {
  if (!offscreenCreation) {
    offscreenCreation = (async () => {
      if (await chrome.offscreen.hasDocument?.()) return;
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["AUDIO_PLAYBACK"],
        justification: "Background playback of Bilibili audio."
      });
    })().finally(() => { offscreenCreation = null; });
  }
  await offscreenCreation;
}
function toOffscreen(msg) { send({ target: "offscreen", ...msg }); }
function send(msg) { chrome.runtime.sendMessage(msg).catch(() => {}); }

function broadcastState() {
  send({ target: "sidepanel", evt: "state", state: { ...state, current: state.queue[state.index] || null } });
}

// ── collections ─────────────────────────────────────────────────────────
async function getCollections() {
  const o = await chrome.storage.local.get([COLLECTIONS_KEY, CURRENT_KEY, LEGACY_FAVS_KEY]);
  let cols = o[COLLECTIONS_KEY];
  // migrate v0.1 single "favorites" list → a collection
  if (!cols || !Object.keys(cols).length) {
    cols = { Favorites: o[LEGACY_FAVS_KEY] || [] };
    await chrome.storage.local.set({ [COLLECTIONS_KEY]: cols });
  }
  let current = o[CURRENT_KEY];
  if (!current || !cols[current]) current = Object.keys(cols)[0];
  return { cols, current };
}
async function setCollections(cols, current) {
  const patch = { [COLLECTIONS_KEY]: cols };
  if (current) patch[CURRENT_KEY] = current;
  await chrome.storage.local.set(patch);
}

async function snapshot() {
  const { cols, current } = await getCollections();
  return {
    collections: Object.keys(cols),
    counts: Object.fromEntries(Object.entries(cols).map(([k, v]) => [k, v.length])),
    current,
    tracks: cols[current] || []
  };
}

// One item per source-kind found in the text. Parsed per line so a pasted list
// can mix bilibili links and plain audio URLs; a bilibili URL is matched as a
// BV id first, so it never falls through to the direct-URL branch.
// `skipped` counts lines that looked like content but matched no source, so an
// import can say so instead of quietly dropping them. Blank lines and the `#`
// comments our own export writes don't count.
function parseItems(text) {
  const items = [];
  const seen = new Set();
  let skipped = 0;
  const push = (kind, id) => { if (!seen.has(id)) { seen.add(id); items.push({ kind, id }); } };
  for (const line of String(text || "").split(/[\r\n]+/)) {
    const bvids = parseBvids(line);
    if (bvids.length) { bvids.forEach((b) => push("bili", b)); continue; }
    const url = parseDirectUrl(line);
    if (url) { push("direct", url); continue; }
    if (line.trim() && !line.trim().startsWith("#")) skipped++;
  }
  return { items, skipped };
}

// Handles one item or a pasted list — same path, so batch add is just "more".
// Bilibili metadata fetches are sequential (it rate-limits bursts) and progress
// is pushed to the panel so a long import doesn't look frozen. Direct URLs need
// no network at all.
async function addTracks(input) {
  const { items, skipped } = parseItems(input);
  if (!items.length) {
    throw new Error("Not a supported link — paste a Bilibili video / BV id, or a direct audio URL (.mp3, .m4a, .flac …).");
  }

  let added = 0, dup = 0, failed = 0, done = 0;
  const pending = [];
  const before = await getCollections();
  const target = before.current;

  // Flush re-reads storage each time: a long import can span the panel being
  // used, and an interrupted one keeps whatever it already fetched. The target
  // is fixed at import start so switching collections cannot split the batch.
  // A batch lands at the top, but every chunk after the first is spliced in
  // below the ones before it — otherwise each `unshift` would stack the chunks
  // backwards and a 25-line import would read 21-25, 11-20, 1-10.
  let at = 0;
  const flush = async () => {
    if (!pending.length) return;
    const { cols } = await getCollections();
    if (!cols[target]) throw new Error("The destination collection was deleted during import.");
    const have = new Set(cols[target].map(trackId));
    const toAdd = pending.filter((t) => !have.has(trackId(t)));
    pending.length = 0;
    if (!toAdd.length) return;
    cols[target].splice(at, 0, ...toAdd);
    at += toAdd.length;
    added += toAdd.length;
    await setCollections(cols);
  };

  const seen = new Set((before.cols[target] || []).map(trackId));
  for (const { kind, id } of items) {
    if (seen.has(id)) dup++;
    else {
      try {
        pending.push(kind === "direct" ? directMeta(id) : await fetchMeta(id));
        seen.add(id);
      } catch { failed++; }
    }
    done++;
    if (pending.length >= 10) await flush();
    if (items.length > 1) send({ target: "sidepanel", evt: "addProgress", done, total: items.length });
  }
  await flush();
  // A batch lands in the middle of a running queue if it went to the playing
  // collection: re-point it so the new tracks join the rotation (and the
  // shuffle pass counts them) instead of waiting for the next manual play.
  if (added && state.queueName === target) {
    const { cols } = await getCollections();
    syncQueue(cols[target] || []);
  }
  return { ...(await snapshot()), added, dup, failed, skipped };
}
// Panel hands over the id order it just dragged into place. Ids it doesn't
// know about (added by another panel mid-drag) keep their relative order at
// the end rather than being dropped.
async function reorderTracks(ids) {
  const { cols, current } = await getCollections();
  const byId = new Map((cols[current] || []).map((t) => [trackId(t), t]));
  const next = [];
  for (const id of ids) {
    const t = byId.get(id);
    if (t) { next.push(t); byId.delete(id); }
  }
  next.push(...byId.values());
  cols[current] = next;
  await setCollections(cols);
  if (state.queueName === current) syncQueue(next);
  return snapshot();
}

// Re-point the live queue at an edited list (dragged, added to, removed from),
// keeping the playing track under the cursor so the edit never interrupts
// playback.
function syncQueue(list) {
  const playing = state.queue[state.index];
  const id = playing && trackId(playing);
  let index = id ? list.findIndex((t) => trackId(t) === id) : -1;
  if (id && index < 0 && state.dropped === id) {
    // A track deleted while playing isn't in the collection any more but is
    // still audible: keep its slot so the panel keeps showing it, and so a
    // later edit doesn't cost us the cursor.
    index = Math.min(state.index, list.length);
    list = [...list];
    list.splice(index, 0, playing);
  } else {
    state.dropped = null;   // a list straight from storage can't still hold it
  }
  state.queue = list;
  state.index = index;
  state.order = null;   // positions moved; the shuffle pass no longer means anything
  saveState();
  broadcastState();
}

async function removeTrack(id) {
  const { cols, current } = await getCollections();
  cols[current] = cols[current].filter((t) => trackId(t) !== id);
  await setCollections(cols);
  // Drop it from the live queue too, unless it's the track playing right now —
  // that one keeps its slot until it ends rather than cutting the audio, and is
  // pruned on the way out (see `leaveCurrent`) so no later pass replays a track
  // that is no longer in the collection.
  if (state.queueName === current) {
    const playing = state.queue[state.index];
    if (!playing || trackId(playing) !== id) syncQueue(cols[current]);
    else { state.dropped = id; saveState(); }
  }
  return snapshot();
}

// Persist a duration learned at play time (when metadata didn't include one).
async function patchDuration(id, d) {
  if (!id || !d) return;
  const { cols } = await getCollections();
  let changed = false;
  for (const name of Object.keys(cols)) {
    for (const t of cols[name]) {
      if (trackId(t) === id && !t.duration) { t.duration = Math.round(d); changed = true; }
    }
  }
  if (changed) await setCollections(cols);
}
async function createCollection(name) {
  name = (name || "").trim();
  if (!name) throw new Error("Empty name.");
  const { cols } = await getCollections();
  if (cols[name]) throw new Error("Collection already exists.");
  cols[name] = [];
  await setCollections(cols, name);
  return snapshot();
}
async function switchCollection(name) {
  const { cols } = await getCollections();
  if (!cols[name]) throw new Error("No such collection.");
  await setCollections(cols, name);
  return snapshot();
}
async function renameCollection(from, to) {
  to = (to || "").trim();
  if (!to) throw new Error("Empty name.");
  const { cols, current } = await getCollections();
  if (!cols[from]) throw new Error("No such collection.");
  if (to === from) return snapshot();
  if (cols[to]) throw new Error("Collection already exists.");
  // rebuild instead of delete+add so the collection keeps its menu position
  const renamed = {};
  for (const [k, v] of Object.entries(cols)) renamed[k === from ? to : k] = v;
  await setCollections(renamed, current === from ? to : undefined);
  if (state.queueName === from) { state.queueName = to; saveState(); }
  return snapshot();
}
async function deleteCollection(name) {
  const { cols } = await getCollections();
  const names = Object.keys(cols);
  if (names.length <= 1) throw new Error("Can't delete the last collection.");
  delete cols[name];
  const nextCurrent = Object.keys(cols)[0];
  await setCollections(cols, nextCurrent);
  return snapshot();
}

// ── playback ────────────────────────────────────────────────────────────
async function playIndex(i, startAt = 0) {
  if (i < 0 || i >= state.queue.length) return;
  const loadId = (state.loadId || 0) + 1;
  state.loadId = loadId;
  state.index = i;
  state.position = startAt;
  const track = state.queue[i];
  state.duration = track.duration || 0;
  state.playing = false;
  const source = track.source || "bilibili";
  toOffscreen({ op: "pause", loadId });
  broadcastState();
  try {
    await ensureOffscreen();
    const ruleError = await headerRuleReady;
    if (ruleError) throw ruleError;
    if (state.loadId !== loadId) return;
    if (source === "youtube") {
      throw new Error("YouTube support was removed — this track can no longer play.");
    }
    // Direct URLs are the stream; bilibili's expire, so they're re-signed per play.
    const url = source === "direct" ? track.url : await resolveAudioUrl(track.bvid, track.cid);
    if (state.loadId !== loadId) return;
    toOffscreen({ op: "load", url, volume: state.volume, position: startAt, loadId });
    state.playing = true;
  } catch (e) {
    if (state.loadId !== loadId) return;
    state.playing = false;
    send({ target: "sidepanel", evt: "error", message: e.message });
    // Skip unresolvable tracks (dead video, legacy YouTube entry) so
    // auto-advance doesn't stall; errStreak guards a fully-dead queue.
    state.errStreak = (state.errStreak || 0) + 1;
    if (state.repeat !== "one" && state.errStreak < state.queue.length) {
      saveState();
      return next();
    }
  }
  saveState();
  broadcastState();
}

async function playFromCurrent(id) {
  // Reserve the request before reading storage so a later click always wins,
  // even if this collection lookup happens to complete out of order.
  const requestId = (state.loadId || 0) + 1;
  state.loadId = requestId;
  const { cols, current } = await getCollections();
  if (state.loadId !== requestId) return;
  const list = cols[current] || [];
  const start = list.findIndex((t) => trackId(t) === id);
  state.queue = list;
  state.queueName = current;
  state.order = null;     // indices belong to the old queue
  state.dropped = null;   // whatever it was, this queue doesn't contain it
  await playIndex(start < 0 ? 0 : start);
}

// Shuffle plays a permutation of the queue, not a random pick per track: a
// pass visits every track exactly once, then reshuffles. `state.order` holds
// queue indices in play order and is rebuilt whenever it stops matching the
// queue (tracks added, removed, or dragged).
function reshuffle(startAt) {
  const order = [...Array(state.queue.length).keys()];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  // Put the given track first so toggling shuffle on doesn't jump elsewhere.
  const at = startAt >= 0 ? order.indexOf(startAt) : -1;
  if (at > 0) [order[0], order[at]] = [order[at], order[0]];
  state.order = order;
}
function orderPos() {
  if (!Array.isArray(state.order) || state.order.length !== state.queue.length) reshuffle(state.index);
  return state.order.indexOf(state.index);
}

function nextIndex() {
  if (state.repeat === "one") return state.index;
  if (state.shuffle && state.queue.length > 1) {
    const p = orderPos();
    if (p < 0) return state.order[0];
    if (p + 1 < state.order.length) return state.order[p + 1];
    reshuffle(-1);                                   // pass finished → fresh one
    if (state.order[0] === state.index) {            // never repeat across the seam
      const last = state.order.length - 1;           // send it to the far end of
      [state.order[0], state.order[last]] = [state.order[last], state.order[0]]; // the new pass
    }
    return state.order[0];
  }
  const n = state.index + 1;
  return n >= state.queue.length ? 0 : n;   // past the end → back to the top
}
function prevIndex() {
  if (state.position > 3) return state.index;
  if (state.shuffle && state.queue.length > 1) {
    const p = orderPos();
    return state.order[p <= 0 ? state.order.length - 1 : p - 1];
  }
  const p = state.index - 1;
  return p < 0 ? state.queue.length - 1 : p;
}
// Every hop to another track goes through here so a track deleted mid-play can
// be pruned once we leave it: the destination is resolved to a track object
// first, then looked up again in the shortened queue.
async function leaveCurrent(i) {
  const target = state.queue[i];
  if (!target) return;
  if (state.dropped && trackId(target) !== state.dropped) {
    const at = state.queue.findIndex((t) => trackId(t) === state.dropped);
    state.dropped = null;
    if (at >= 0) {
      state.queue = state.queue.filter((_, k) => k !== at);
      state.order = null;   // positions shifted; the pass no longer means anything
    }
  }
  await playIndex(state.queue.indexOf(target));
}

async function next() {
  if (!state.queue.length) { state.playing = false; toOffscreen({ op: "pause" }); saveState(); broadcastState(); return; }
  await leaveCurrent(nextIndex());
}

// ── download ────────────────────────────────────────────────────────────
// Resolves a fresh stream URL for a track (default: the one playing) without
// touching playback state. Only the URL is returned — the bytes are fetched by
// the panel, because an MV3 service worker has no URL.createObjectURL and so
// can't hand a downloaded blob to anything.
async function streamFor(id) {
  let track = state.queue[state.index];
  if (id) {
    track = state.queue.find((t) => trackId(t) === id);
    if (!track) {
      const { cols } = await getCollections();
      for (const list of Object.values(cols)) {
        const hit = list.find((t) => trackId(t) === id);
        if (hit) { track = hit; break; }
      }
    }
  }
  if (!track) throw new Error("Nothing playing.");
  const source = track.source || "bilibili";
  if (source === "direct") return { url: track.url, source, title: track.title, author: track.author };
  if (source !== "bilibili") throw new Error("This source can't be downloaded.");
  // same Referer/Origin rewrite playback depends on — without it the CDN 403s
  const ruleError = await headerRuleReady;
  if (ruleError) throw ruleError;
  const url = await resolveAudioUrl(track.bvid, track.cid);
  return { url, source, title: track.title, author: track.author };
}

// ── message router ──────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // events from offscreen audio host — must reload state first (SW may have slept)
  if (msg?.target === "background") {
    (async () => {
      await loadState();
      if (typeof msg.loadId === "number" && msg.loadId !== state.loadId) return;
      if (msg.evt === "timeupdate") {
        state.errStreak = 0;
        state.position = msg.t; state.duration = msg.d || state.duration;
        const t = state.queue[state.index];
        if (t && !t.duration && msg.d) { t.duration = Math.round(msg.d); patchDuration(trackId(t), msg.d); }
        broadcastState(); // note: not saved every tick (too chatty); saved on transitions
      } else if (msg.evt === "ended") {
        await next();
      } else if (msg.evt === "error") {
        send({ target: "sidepanel", evt: "error", message: msg.message || "playback error" });
        // Unplayable track: skip ahead instead of stalling the queue. errStreak
        // (reset by any successful timeupdate) stops it after a full failed pass.
        state.errStreak = (state.errStreak || 0) + 1;
        if (state.playing && state.repeat !== "one" && state.errStreak < state.queue.length) {
          await next();
        } else {
          state.playing = false; saveState(); broadcastState();
        }
      }
    })();
    return;
  }

  if (msg?.target !== "bg") return;
  (async () => {
    await loadState();
    try {
      switch (msg.cmd) {
        case "getState": {
          const snap = await snapshot();
          sendResponse({ ...snap, state: { ...state, current: state.queue[state.index] || null } });
          return;
        }
        case "addTrack": sendResponse(await addTracks(msg.input)); return;
        case "removeTrack": sendResponse(await removeTrack(msg.id)); return;
        case "reorderTracks": sendResponse(await reorderTracks(msg.ids || [])); return;
        case "createCollection": sendResponse(await createCollection(msg.name)); return;
        case "switchCollection": sendResponse(await switchCollection(msg.name)); return;
        case "renameCollection": sendResponse(await renameCollection(msg.from, msg.to)); return;
        case "deleteCollection": sendResponse(await deleteCollection(msg.name)); return;
        case "playTrack": await playFromCurrent(msg.id); sendResponse({ ok: true }); return;
        case "toggle":
          if (state.playing) {
            state.playing = false;
            state.loadId = (state.loadId || 0) + 1;
            toOffscreen({ op: "pause", loadId: state.loadId });
            saveState(); broadcastState();
          } else {
            // Reloading also recreates an AUDIO_PLAYBACK offscreen document
            // after Chrome has closed it and refreshes an expired Bilibili URL.
            await playIndex(state.index, state.position || 0);
          }
          sendResponse({ ok: true }); return;
        case "streamUrl": sendResponse(await streamFor(msg.id)); return;
        case "next": await next(); sendResponse({ ok: true }); return;
        case "prev": await leaveCurrent(prevIndex()); sendResponse({ ok: true }); return;
        case "seek":
          state.position = msg.t; toOffscreen({ op: "seek", t: msg.t });
          saveState(); sendResponse({ ok: true }); return;
        case "volume":
          state.volume = msg.v; toOffscreen({ op: "volume", v: msg.v });
          saveState(); sendResponse({ ok: true }); return;
        case "shuffle":
          state.shuffle = !state.shuffle;
          if (state.shuffle) reshuffle(state.index);   // new pass, starting where we are
          saveState(); broadcastState(); sendResponse({ ok: true }); return;
        case "repeat":
          state.repeat = state.repeat === "one" ? "all" : "one";
          saveState(); broadcastState(); sendResponse({ ok: true }); return;
        default: sendResponse({ error: "unknown cmd" });
      }
    } catch (e) {
      sendResponse({ error: e.message });
    }
  })();
  return true; // async sendResponse
});
