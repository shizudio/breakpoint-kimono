/* Buyers' profile pictures.

   The panel names whoever reserved a piece, and a row of initials on tinted
   squares is the design's fallback, not its intent. X is where these people
   already are, so their picture comes from there — but not the way the obvious
   implementation would do it.

   The obvious implementation points an <img> at a third party and lets every
   visitor's browser ask it for "the avatar of @so-and-so". That hands the guest
   list to someone else, one lookup at a time, and it does it from the buyer's
   machine rather than ours. So the fetch happens here, once, server-side, and
   the file is kept. After that the image is ours: it survives the source going
   away, changing its terms, or rate-limiting us on the day of the event.

   Nothing here is allowed to matter. Every failure is silent and leaves the
   initial in place, because a missing picture is a cosmetic disappointment and
   a checkout that waits on an image is not. */

import { createWriteStream, existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

import { config } from "./config.js";
import { logEvent } from "./db.js";

var here = dirname(fileURLToPath(import.meta.url));
export var AVATAR_DIR = resolve(here, "..", config.avatarDir);

/* X handles are letters, digits and underscore, 1–15 — the same shape the order
   form validates. Re-checked here rather than trusted, because this value ends
   up in a filesystem path and in an outbound URL, and the cost of being wrong
   about that is not a missing picture. */
var HANDLE = /^[A-Za-z0-9_]{1,15}$/;
export function validHandle(h) { return typeof h === "string" && HANDLE.test(h); }

export function avatarFile(handle) {
  if (!validHandle(handle)) return null;
  return resolve(AVATAR_DIR, handle.toLowerCase() + ".jpg");
}

/* The URL the page should use, or null to leave the initial alone. Under /api/
   on purpose: the reverse proxy in front of this already forwards that prefix,
   so a new path here needs no new rewrite to go live. */
export function avatarUrl(handle) {
  var f = avatarFile(handle);
  return f && existsSync(f) ? "/api/avatars/" + handle.toLowerCase() + ".jpg" : null;
}

/* One attempt per handle per process. A handle with no picture must not mean a
   request to the source every time somebody loads the page — and the page is
   loaded a great deal more often than fifteen people buy a kimono. */
var tried = new Set();
var MAX_BYTES = 2 * 1024 * 1024;

export function avatarsEnabled() { return !!config.avatarSource; }

/* Fire-and-forget. Returns a promise so the suite can await it; no caller in
   the app does, and none should. */
export async function fetchAvatar(handle, opts) {
  var force = !!(opts && opts.force);
  if (!avatarsEnabled() || !validHandle(handle)) return false;
  var key = handle.toLowerCase();
  var file = avatarFile(key);
  if (!force && (tried.has(key) || existsSync(file))) return false;
  tried.add(key);

  /* fallback=false is the whole reason this is usable. Without it the source
     answers 200 with a generic placeholder for a handle it cannot find, which
     would put the same stranger's silhouette next to a real buyer's name. With
     it, a miss is a 404 and the initial stays. */
  var url = config.avatarSource + encodeURIComponent(key) + "?fallback=false";
  try {
    var res = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: "follow" });
    if (!res.ok) return false;

    var type = String(res.headers.get("content-type") || "");
    /* An avatar is a picture. Anything else — an error page, an SVG with a
       script in it — is not written to disk under a name the page will serve. */
    if (!/^image\/(jpeg|png|webp)$/.test(type.split(";")[0].trim())) return false;

    var declared = Number(res.headers.get("content-length") || 0);
    if (declared && declared > MAX_BYTES) return false;

    var buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > MAX_BYTES) return false;

    mkdirSync(AVATAR_DIR, { recursive: true });
    /* Written aside and renamed, so a half-downloaded file is never visible
       under the name the page asks for. */
    var tmp = file + "." + randomBytes(4).toString("hex") + ".part";
    await new Promise(function (ok, bad) {
      var s = createWriteStream(tmp);
      s.on("error", bad); s.on("finish", ok); s.end(buf);
    });
    renameSync(tmp, file);
    logEvent(null, "avatar.saved", key + " " + buf.length + "b");
    return true;
  } catch (e) {
    try { } finally { }
    console.error("[avatars] " + key, e.message);
    return false;
  }
}

/* Called where the buyer list is built. Anything already on disk is left alone;
   anything missing is fetched in the background and appears on the next load.
   That is also the backfill: orders taken before this existed pick up a picture
   the first time somebody looks at the page. */
export function warmAvatars(handles) {
  if (!avatarsEnabled()) return;
  handles.forEach(function (h) {
    if (validHandle(h)) fetchAvatar(h).catch(function () {});
  });
}
