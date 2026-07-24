// Plain audio URLs: anything the <audio> element can play on its own.
// No API, no signing, no expiry — the URL the user pasted IS the stream, so
// it's stored on the track and handed straight to the offscreen player.

const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|weba|webm)$/i;

// First http(s) URL on the line, if it points at an audio file.
export function parseDirectUrl(input) {
  const m = String(input || "").match(/https?:\/\/[^\s"'<>]+/i);
  if (!m) return null;
  let u;
  try { u = new URL(m[0]); } catch { return null; }
  return AUDIO_EXT.test(u.pathname) ? u.toString() : null;
}

// Metadata without a network call: filename is the title, host is the "artist".
// Duration is filled in by the player on first play (see patchDuration).
export function directMeta(url) {
  const u = new URL(url);
  const file = decodeURIComponent(u.pathname.split("/").pop() || "");
  const title = file.replace(AUDIO_EXT, "").replace(/[_+]+/g, " ").trim();
  return {
    source: "direct",
    id: url,
    url,
    title: title || u.hostname,
    author: u.hostname.replace(/^www\./, ""),
    cover: "",
    duration: 0,
    addedAt: Date.now()
  };
}
