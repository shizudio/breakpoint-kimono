/* Serves site/ — the same files Vercel was serving, with the same cache rules
   as vercel.json so a build deployed either way behaves identically. */

import { createReadStream, statSync } from "node:fs";
import { resolve, join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";

var here = fileURLToPath(new URL(".", import.meta.url));
export var SITE = config.siteDir ? resolve(here, "..", config.siteDir) : null;

var TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".webp": "image/webp", ".avif": "image/avif", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".woff2": "font/woff2", ".mp4": "video/mp4",
  ".txt": "text/plain; charset=utf-8"
};

function cacheFor(urlPath) {
  // Frames and photography are content-addressed by folder name — see the
  // cache-busting note in the README. Everything else must revalidate.
  if (/^\/(frames-v\d+|web|vendor)\//.test(urlPath)) return "public, max-age=31536000, immutable";
  return "no-cache";
}

export function serveStatic(req, res, urlPath) {
  if (!SITE) return false;
  var clean = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, "");
  if (clean.indexOf("\0") !== -1) return false;

  var candidates = [clean];
  if (clean === "/" ) candidates = ["/index.html"];
  else if (!extname(clean)) candidates = [clean + ".html", join(clean, "index.html")]; // cleanUrls

  for (var i = 0; i < candidates.length; i++) {
    var abs = resolve(SITE, "." + candidates[i]);
    // resolve() collapses any ../ that survived; refuse anything that escaped.
    if (abs !== SITE && abs.indexOf(SITE + "/") !== 0) continue;
    var st;
    try { st = statSync(abs); } catch (e) { continue; }
    if (!st.isFile()) continue;

    var etag = '"' + st.size.toString(16) + "-" + st.mtimeMs.toString(16) + '"';
    var headers = {
      "content-type": TYPES[extname(abs).toLowerCase()] || "application/octet-stream",
      "content-length": st.size,
      "cache-control": cacheFor(candidates[i]),
      "etag": etag,
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin"
    };
    if (req.headers["if-none-match"] === etag) { res.writeHead(304, headers); res.end(); return true; }
    res.writeHead(200, headers);
    if (req.method === "HEAD") { res.end(); return true; }
    createReadStream(abs).pipe(res);
    return true;
  }
  return false;
}
