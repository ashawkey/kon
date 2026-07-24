// Invisible audio host. Survives side-panel close so playback continues while
// the user browses other pages. <audio> element playing a resolved Bilibili
// DASH audio (.m4s) URL. Controlled by the service worker.
const audio = document.getElementById("a");

let vol = 1;         // 0..1
let lastSent = 0;
let loadId = 0;

function toBg(msg, id = loadId) {
  chrome.runtime.sendMessage({ target: "background", loadId: id, ...msg }).catch(() => {});
}
function throttleTime(t, d) {
  const now = Date.now();
  if (now - lastSent < 500) return;
  lastSent = now;
  toBg({ evt: "timeupdate", t, d: d || 0 });
}

// ── command router from service worker ───────────────────────────────────
chrome.runtime.onMessage.addListener((m) => {
  if (m?.target !== "offscreen") return;
  if (typeof m.loadId === "number") loadId = m.loadId;
  if (typeof m.volume === "number") vol = m.volume;

  switch (m.op) {
    case "load": {
      const id = loadId;
      audio.volume = vol;
      audio.src = m.url;
      if (m.position > 0) {
        const seek = () => {
          if (loadId !== id) return;
          audio.currentTime = Math.min(m.position, Number.isFinite(audio.duration) ? audio.duration : m.position);
        };
        if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) seek();
        else audio.addEventListener("loadedmetadata", seek, { once: true });
      }
      audio.play().catch((e) => toBg({ evt: "error", message: String(e) }, id));
      break;
    }
    case "play": {
      const id = loadId;
      audio.play().catch((e) => toBg({ evt: "error", message: String(e) }, id));
      break;
    }
    case "pause":
      audio.pause();
      break;
    case "seek":
      audio.currentTime = m.t;
      break;
    case "volume":
      vol = m.v;
      audio.volume = m.v;
      break;
  }
});

// ── <audio> events ───────────────────────────────────────────────────────
audio.addEventListener("timeupdate", () => throttleTime(audio.currentTime, audio.duration || 0));
audio.addEventListener("ended", () => toBg({ evt: "ended" }));
audio.addEventListener("error", () => { if (audio.src) toBg({ evt: "error", message: "audio element error" }); });
