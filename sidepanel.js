// Side-panel UI. Thin client: sends commands to the service worker,
// renders collections + library + now-playing from broadcast state.
const $ = (id) => document.getElementById(id);
const bg = (msg) => chrome.runtime.sendMessage({ target: "bg", ...msg });

let tracks = [];       // current collection's tracks
let collections = [];  // collection names
let counts = {};       // name -> track count
let current = "";      // current collection name
let cur = null;        // now-playing track
let seeking = false;
let remeasureNpTitle = () => {};   // set at init — see marqueeOnHover

const fmt = (s) => {
  if (!s || isNaN(s)) return "0:00";
  s = Math.floor(s);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const escapeHtml = (s) =>
  String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const trackId = (t) => t.id || t.bvid || t.videoId;
const SRC_LABEL = { bilibili: "BILI", direct: "URL", youtube: "YT" };

// static icons (lib/icons.js); dynamic ones (play/pause, repeat) swap in renderState
for (const el of document.querySelectorAll("[data-icon]")) el.innerHTML = ICON[el.dataset.icon];

// Where the track came from. For bilibili the canonical id is `BV...?p=N`,
// which is exactly the video path, part selector included.
function originalUrl(t) {
  if (!t) return null;
  switch (t.source || "bilibili") {
    case "bilibili": return `https://www.bilibili.com/video/${trackId(t)}`;
    case "youtube": return `https://www.youtube.com/watch?v=${t.videoId || trackId(t)}`;
    default: return t.url || trackId(t);
  }
}

function openOriginal(t) {
  const url = originalUrl(t);
  if (url) chrome.tabs.create({ url });
}

function toast(text, isErr) {
  const t = $("toast");
  t.textContent = text;
  t.className = "toast show" + (isErr ? " err" : "");
  setTimeout(() => (t.className = "toast"), 2200);
}

function applySnapshot(snap) {
  if (!snap) return;
  if (snap.collections) collections = snap.collections;
  if (snap.counts) counts = snap.counts;
  if (snap.current) current = snap.current;
  if (snap.tracks) tracks = snap.tracks;
  renderCollections();
  renderLibrary();
}

// ── collections dropdown (custom listbox — see .menu in the css) ────────
function renderCollections() {
  $("collLabel").textContent = current || "—";
  const menu = $("collMenu");
  menu.innerHTML = "";
  for (const name of collections) {
    const item = document.createElement("div");
    item.className = "menu-item" + (name === current ? " on" : "");
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", String(name === current));
    item.innerHTML = `<span class="menu-name">${escapeHtml(name)}</span>
      <span class="menu-count">${counts[name] ?? 0}</span>`;
    item.addEventListener("click", async () => {
      closeMenu();
      if (name === current) return;
      applySnapshot(await bg({ cmd: "switchCollection", name }));
    });
    menu.appendChild(item);
  }
}

function openMenu() {
  const menu = $("collMenu");
  const r = $("collBtn").getBoundingClientRect();
  menu.style.left = `${r.left}px`;
  menu.style.top = `${r.bottom + 6}px`;
  menu.style.minWidth = `${r.width}px`;
  menu.style.maxWidth = `${window.innerWidth - r.left - 12}px`;
  menu.classList.remove("hidden");
  $("collBtn").setAttribute("aria-expanded", "true");
}
function closeMenu() {
  $("collMenu").classList.add("hidden");
  $("collBtn").setAttribute("aria-expanded", "false");
}
const menuOpen = () => !$("collMenu").classList.contains("hidden");

// A title wider than its box is ellipsized; hovering slides the text back
// and forth so the hidden tail can be read. Measured on every hover because
// the panel can be resized and the text can change.
// Returns a re-measure hook for callers that change the text: the transport
// buttons live inside the now-playing hover area, so clicking next/prev never
// re-fires mouseenter and a long title's slide would stick to the new one.
function marqueeOnHover(hoverEl, textEl) {
  const measure = () => {
    textEl.classList.remove("marquee");
    // Reading layout here also flushes the class removal, so re-adding it below
    // restarts the slide from 0 instead of continuing the old animation.
    const shift = textEl.clientWidth - textEl.scrollWidth;
    if (shift >= 0) return; // fits — nothing to reveal
    textEl.style.setProperty("--marquee-shift", `${shift}px`);
    textEl.style.setProperty("--marquee-dur", `${Math.max(1.5, -shift / 50)}s`);
    textEl.classList.add("marquee");
  };
  hoverEl.addEventListener("mouseenter", measure);
  hoverEl.addEventListener("mouseleave", () => textEl.classList.remove("marquee"));
  return () => (hoverEl.matches(":hover") ? measure() : textEl.classList.remove("marquee"));
}

// ── library (name list) ─────────────────────────────────────────────────
function renderLibrary() {
  const lib = $("library");
  if (!tracks.length) {
    lib.innerHTML = `<div class="empty"><b>“${escapeHtml(current)}” is empty.</b><br>Paste a Bilibili link above to add music.</div>`;
    return;
  }
  lib.innerHTML = "";
  tracks.forEach((t, i) => {
    const id = trackId(t);
    const src = t.source || "bilibili";
    const active = cur && trackId(cur) === id;
    const dur = t.duration ? fmt(t.duration) : "—";
    const row = document.createElement("div");
    row.className = "row" + (active ? " active" : "");
    row.dataset.id = id;
    row.draggable = true;
    row.innerHTML = `
      <span class="row-idx">${i + 1}</span>
      <span class="row-eq">${ICON.music}</span>
      <span class="row-src src-${src}" title="Open source page">${SRC_LABEL[src] || "URL"}</span>
      <div class="row-main">
        <div class="row-title"><span>${escapeHtml(t.title)}</span></div>
        <div class="row-artist">${escapeHtml(t.author)}</div>
      </div>
      <span class="row-dur">${dur}</span>
      <button class="row-del" title="Remove">${ICON.x}</button>`;
    marqueeOnHover(row, row.querySelector(".row-title"));
    row.addEventListener("click", () => bg({ cmd: "playTrack", id }));
    row.querySelector(".row-src").addEventListener("click", (e) => {
      e.stopPropagation();
      openOriginal(t);
    });
    row.querySelector(".row-del").addEventListener("click", async (e) => {
      e.stopPropagation();
      applySnapshot(await bg({ cmd: "removeTrack", id }));
    });
    lib.appendChild(row);
  });
}

// Playback ticks twice a second. Rebuilding the list that often would reset
// the container's scrollTop (and kill an in-progress drag), so the tick path
// only moves the highlight.
function markActive() {
  const id = cur && trackId(cur);
  for (const row of $("library").querySelectorAll(".row")) {
    row.classList.toggle("active", !!id && row.dataset.id === id);
  }
}

// ── manual ordering (drag a row) ────────────────────────────────────────
// The dragged row is moved through the DOM live, so the list itself is the
// preview; on drop we hand the resulting id order to the worker, which is the
// only thing that decides what's stored.
function rowUnderY(lib, y) {
  let best = null, bestOffset = -Infinity;
  for (const row of lib.querySelectorAll(".row:not(.dragging)")) {
    const box = row.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > bestOffset) { bestOffset = offset; best = row; }
  }
  return best;
}

function initDragReorder() {
  const lib = $("library");   // rows are replaced on every render; the container isn't

  lib.addEventListener("dragstart", (e) => {
    const row = e.target.closest?.(".row");
    if (!row) return;
    row.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", row.dataset.id); // Chrome won't start a drag without data
  });

  lib.addEventListener("dragover", (e) => {
    const dragging = lib.querySelector(".dragging");
    if (!dragging) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const after = rowUnderY(lib, e.clientY);
    if (after === dragging) return;
    if (after) lib.insertBefore(dragging, after);
    else lib.appendChild(dragging);
  });

  lib.addEventListener("drop", (e) => e.preventDefault());

  lib.addEventListener("dragend", async (e) => {
    const row = e.target.closest?.(".row");
    if (!row) return;
    row.classList.remove("dragging");
    const ids = [...lib.querySelectorAll(".row")].map((r) => r.dataset.id);
    if (ids.join("\n") === tracks.map(trackId).join("\n")) return;  // dropped where it started
    applySnapshot(await bg({ cmd: "reorderTracks", ids }));
  });
}

// ── now playing ─────────────────────────────────────────────────────────
function renderState(st) {
  cur = st.current;
  const player = $("player");
  if (cur) {
    player.classList.remove("hidden");
    $("npCover").style.backgroundImage = cur.cover ? `url('${cur.cover}')` : "";
    // Guarded because state ticks twice a second: only a genuinely new title
    // needs its scroll distance re-measured (or dropped, if it now fits).
    const title = $("npTitle").firstElementChild;
    if (title.textContent !== cur.title) {
      title.textContent = cur.title;
      remeasureNpTitle();
    }
    $("npArtist").textContent = cur.author;
    if (cur.cover) $("bgArt").style.backgroundImage = `url('${cur.cover}')`;
  }
  $("btnPlay").innerHTML = ICON[st.playing ? "pause" : "play"];
  $("btnShuffle").classList.toggle("on", st.shuffle);
  // the list always loops; the button only toggles single-track repeat
  const one = st.repeat === "one";
  $("btnRepeat").classList.toggle("on", one);
  $("btnRepeat").innerHTML = ICON[one ? "repeat-1" : "repeat"];
  $("btnRepeat").title = one ? "Repeat one — click to loop the list" : "Looping the list — click to repeat one";

  if (!seeking) {
    const d = st.duration || cur?.duration || 0;
    $("seek").value = d ? Math.round((st.position / d) * 1000) : 0;
    $("tCur").textContent = fmt(st.position);
    $("tDur").textContent = fmt(d);
  }
  markActive();
  // A track's duration is often only learned once it plays; patch the row in
  // place, since the list no longer rebuilds on every tick.
  const d = st.duration || cur?.duration;
  if (d) {
    const cell = $("library").querySelector(".row.active .row-dur");
    if (cell && cell.textContent === "—") cell.textContent = fmt(d);
  }
}

// ── events from service worker ──────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== "sidepanel") return;
  if (msg.evt === "state") renderState(msg.state);
  else if (msg.evt === "error") toast(msg.message, true);
  else if (msg.evt === "addProgress") toast(`Adding ${msg.done}/${msg.total}…`);
});

// ── add (one id or a whole pasted list) ─────────────────────────────────
function addSummary(r) {
  const bits = [];
  if (r.added) bits.push(`Added ${r.added} ✓`);
  if (r.dup) bits.push(`${r.dup} already in list`);
  if (r.failed) bits.push(`${r.failed} failed`);
  if (r.skipped) bits.push(`${r.skipped} unsupported`);
  return bits.join(" · ") || "Nothing added";
}

async function submitAdd(input, btn) {
  btn.disabled = true;
  const r = await bg({ cmd: "addTrack", input });
  btn.disabled = false;
  if (r.error) { toast(r.error, true); return null; }
  applySnapshot(r);
  toast(addSummary(r), !r.added);
  return r;
}

$("addForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("addInput").value.trim();
  if (!input) return;
  if (await submitAdd(input, $("addBtn"))) $("addInput").value = "";
});

// ── collections ─────────────────────────────────────────────────────────
$("collBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  menuOpen() ? closeMenu() : openMenu();
});
document.addEventListener("click", () => { if (menuOpen()) closeMenu(); });
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (menuOpen()) closeMenu();
  else if (!$("modal").classList.contains("hidden")) closeImport();
  else if (!$("nameModal").classList.contains("hidden")) closeNameModal();
});
window.addEventListener("resize", () => { if (menuOpen()) openMenu(); });

// One modal serves both flows; the mode picks the title, button, and command.
let nameMode = "create";
function openNameModal(mode) {
  nameMode = mode;
  $("nameTitle").textContent = mode === "rename" ? "Rename collection" : "New collection";
  $("nameGo").textContent = mode === "rename" ? "Rename" : "Create";
  $("nameInput").value = mode === "rename" ? current : "";
  $("nameModal").classList.remove("hidden");
  $("nameInput").focus();
  $("nameInput").select();
}
function closeNameModal() { $("nameModal").classList.add("hidden"); }

$("newColl").addEventListener("click", () => openNameModal("create"));
$("renColl").addEventListener("click", () => openNameModal("rename"));
$("nameCancel").addEventListener("click", closeNameModal);
$("nameModal").addEventListener("click", (e) => { if (e.target === $("nameModal")) closeNameModal(); });
$("nameForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("nameInput").value.trim();
  if (!name) return;
  closeNameModal();
  if (nameMode === "rename" && name === current) return;
  const r = await bg(nameMode === "rename"
    ? { cmd: "renameCollection", from: current, to: name }
    : { cmd: "createCollection", name });
  if (r.error) { toast(r.error, true); return; }
  applySnapshot(r);
  toast(nameMode === "rename" ? `Renamed to “${name}”` : `Created “${name}”`);
});
$("delColl").addEventListener("click", async () => {
  if (!confirm(`Delete collection “${current}”? Its list is removed.`)) return;
  const r = await bg({ cmd: "deleteCollection", name: current });
  if (r.error) { toast(r.error, true); return; }
  applySnapshot(r);
});

// ── export / import ─────────────────────────────────────────────────────
// Plain text, one track per line: BV id first (that's all the importer reads),
// title/author trailing as a human-readable comment.
function exportText() {
  const head = `# kon · ${current} · ${tracks.length} track${tracks.length === 1 ? "" : "s"}`;
  const lines = tracks.map((t) => `${trackId(t)}  # ${t.title}${t.author ? ` — ${t.author}` : ""}`);
  return [head, ...lines].join("\n");
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // clipboard API can be blocked if the panel isn't focused — fall back
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

$("expColl").addEventListener("click", async () => {
  if (!tracks.length) { toast("Collection is empty", true); return; }
  const ok = await copyText(exportText());
  toast(ok ? `Copied ${tracks.length} tracks ✓` : "Copy failed", !ok);
});

function openImport() {
  $("importText").value = "";
  $("modal").classList.remove("hidden");
  $("importText").focus();
}
function closeImport() { $("modal").classList.add("hidden"); }

$("impColl").addEventListener("click", openImport);
$("importCancel").addEventListener("click", closeImport);
$("modal").addEventListener("click", (e) => { if (e.target === $("modal")) closeImport(); });
$("importGo").addEventListener("click", async () => {
  const text = $("importText").value.trim();
  if (!text) { toast("Nothing to import", true); return; }
  closeImport();
  await submitAdd(text, $("importGo"));
});

// ── playback controls ───────────────────────────────────────────────────
$("btnPlay").addEventListener("click", () => bg({ cmd: "toggle" }));
$("btnNext").addEventListener("click", () => bg({ cmd: "next" }));
$("btnPrev").addEventListener("click", () => bg({ cmd: "prev" }));
$("btnShuffle").addEventListener("click", () => bg({ cmd: "shuffle" }));
$("btnRepeat").addEventListener("click", () => bg({ cmd: "repeat" }));
$("npCover").addEventListener("click", () => openOriginal(cur));

const seek = $("seek");
seek.addEventListener("input", () => { seeking = true; });
seek.addEventListener("change", () => {
  const d = (cur && cur.duration) || 0;
  bg({ cmd: "seek", t: (seek.value / 1000) * d });
  seeking = false;
});
$("vol").addEventListener("input", (e) => bg({ cmd: "volume", v: e.target.value / 100 }));

// ── init ─────────────────────────────────────────────────────────────────
(async () => {
  initDragReorder();
  remeasureNpTitle = marqueeOnHover($("player"), $("npTitle"));
  const r = await bg({ cmd: "getState" });
  applySnapshot(r);
  renderState(r.state || { playing: false, repeat: "all", shuffle: false, position: 0, current: null });
})();
