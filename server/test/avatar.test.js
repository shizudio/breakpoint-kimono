/* Buyers' profile pictures, against a stand-in source.

   The interesting cases are all failures. The source answers 200 with a generic
   silhouette for a handle it does not know unless you ask it not to, so the
   test that matters is that a miss leaves no file — a placeholder written under
   a real buyer's name is a stranger's face on the wall next to their purchase.

   Everything else here is about the fetch being unable to hurt anyone: not
   twice for the same handle, not for something shaped like a path, not for a
   response that is not an image, and never on the buyer's own browser. */

import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { rmSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

var here = dirname(fileURLToPath(import.meta.url));
var root = resolve(here, "../..");
rmSync(resolve(root, "data/test"), { recursive: true, force: true });
mkdirSync(resolve(root, "data/test/avatars"), { recursive: true });

var SRC_PORT = 4397;

/* A JPEG, as far as anything here is concerned: the magic bytes are what a
   content sniffer would look at, and the module trusts content-type. */
var JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(600)]);
/* What the real source returns for a handle it cannot resolve, when you forget
   to ask it not to. */
var PLACEHOLDER = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');

var hits = [];
var src = createServer(function (req, res) {
  hits.push(req.url);
  var u = new URL(req.url, "http://x");
  var handle = decodeURIComponent(u.pathname.replace(/^\//, ""));
  var noFallback = u.searchParams.get("fallback") === "false";

  if (handle === "html") {                       // not an image at all
    res.writeHead(200, { "content-type": "text/html" }); return res.end("<h1>hi</h1>");
  }
  if (handle === "huge") {
    res.writeHead(200, { "content-type": "image/jpeg", "content-length": String(50 * 1024 * 1024) });
    return res.end(JPEG);
  }
  if (handle === "shizudio" || handle === "gizmothegizzer" || handle === "realbuyer") {
    res.writeHead(200, { "content-type": "image/jpeg" }); return res.end(JPEG);
  }
  /* Unknown. This is the branch the whole design turns on. */
  if (noFallback) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": "image/svg+xml" }); return res.end(PLACEHOLDER);
});
await new Promise(function (r) { src.listen(SRC_PORT, r); });

var pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log("  FAIL " + label + (detail !== undefined ? "  <- " + JSON.stringify(detail) : "")); }
}

process.env.DB_PATH = "../data/test/avatar.db";
process.env.AVATAR_DIR = "../data/test/avatars";
process.env.AVATAR_SOURCE = "http://127.0.0.1:" + SRC_PORT + "/";
process.env.ADMIN_WALLETS = "DWDeu7snxGK9uscdJbtjcQ4oU9cCdpNZPaate6BVqEuD";

var av = await import("../src/avatars.js");
var store = await import("../src/db.js");

console.log("\na buyer with a picture");
var ok1 = await av.fetchAvatar("realbuyer");
check("it is fetched", ok1 === true);
check("and kept on disk", existsSync(av.avatarFile("realbuyer")));
check("as the bytes that were sent", readFileSync(av.avatarFile("realbuyer")).equals(JPEG));
check("the page is given a URL for it", av.avatarUrl("realbuyer") === "/api/avatars/realbuyer.jpg", av.avatarUrl("realbuyer"));
/* Under /api/ so the reverse proxy in front of this already forwards it. */
check("under /api/, which is already proxied", /^\/api\//.test(av.avatarUrl("realbuyer")));

console.log("\nasked for the same one again");
var before = hits.length;
await av.fetchAvatar("realbuyer");
check("nothing is fetched twice", hits.length === before, hits.length - before);

console.log("\na handle the source does not know");
var ok2 = await av.fetchAvatar("nobodyatall");
check("it is not fetched", ok2 === false);
check("no file is written", !existsSync(av.avatarFile("nobodyatall")));
check("and the page is told to keep the initial", av.avatarUrl("nobodyatall") === null);
/* The request has to carry fallback=false, or the source answers 200 with a
   generic silhouette and the check above passes for the wrong reason. */
check("the request asked for no placeholder", hits.some(function (u) { return /nobodyatall\?fallback=false/.test(u); }), hits);

console.log("\nresponses that are not a picture");
check("html is refused", (await av.fetchAvatar("html")) === false);
check("and nothing is written", !existsSync(av.avatarFile("html")));
check("an oversized one is refused", (await av.fetchAvatar("huge")) === false);
check("and nothing is written", !existsSync(av.avatarFile("huge")));

console.log("\nhandles that are not handles");
/* This value becomes a filename and a URL. A handle is validated here rather
   than trusted from the order, because being wrong about it is not a missing
   picture. */
var nasty = ["../../etc/passwd", "a/b", "with space", "", "waytoolongahandle123", "dot.dot", null];
check("all refused", nasty.every(function (h) { return av.validHandle(h) === false; }));
check("and none resolve to a file", nasty.every(function (h) { return av.avatarFile(h) === null; }));
var beforeNasty = hits.length;
for (var i = 0; i < nasty.length; i++) await av.fetchAvatar(nasty[i]);
check("and none are fetched", hits.length === beforeNasty, hits.length - beforeNasty);

console.log("\nwhen it is switched off");
/* A separate process, because config.js reads the environment once at load and
   a second import of this module gets the same evaluated config. */
var offRun = spawnSync(process.execPath, ["--env-file=.env", "-e", `
  process.env.DB_PATH = "../data/test/avatar.db";
  process.env.AVATAR_DIR = "../data/test/avatars";
  process.env.AVATAR_SOURCE = "";
  var av = await import("./src/avatars.js");
  var store = await import("./src/db.js");
  var fetched = await av.fetchAvatar("realbuyer", { force: true });
  console.log(JSON.stringify({ enabled: av.avatarsEnabled(), fetched: fetched }));
  store.db.close();
`], { cwd: resolve(here, ".."), encoding: "utf8" });
var offOut = {};
try { offOut = JSON.parse((offRun.stdout || "").trim().split("\n").pop()); }
catch (e) { check("the off-run reported", false, (offRun.stderr || "").slice(-300)); }
check("nothing is enabled", offOut.enabled === false, offOut);
check("and no fetch happens", offOut.fetched === false, offOut);

store.db.close();
console.log("\n" + pass + " passed, " + fail + " failed");
src.close();
process.exit(fail ? 1 : 0);
