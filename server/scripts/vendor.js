/* Copies the browser build of @solana/web3.js into site/vendor/.

   Self-hosted on purpose. The page already self-hosts its fonts' fallbacks,
   its photography and the buyer avatars — "nothing calls a third party at
   runtime" is a property worth keeping, and a CDN script on the checkout page
   is the one place where a compromised third party costs real money.

   The filename carries the version because site/vendor/ is served immutable
   for a year, exactly like frames-v2/ and web/. A new version is a new path. */

import { copyFileSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

var here = dirname(fileURLToPath(import.meta.url));
var pkg = JSON.parse(readFileSync(resolve(here, "../node_modules/@solana/web3.js/package.json"), "utf8"));
var src = resolve(here, "../node_modules/@solana/web3.js/lib/index.iife.min.js");
var outDir = resolve(here, "../../site/vendor");
var name = "solana-web3-" + pkg.version + ".min.js";

mkdirSync(outDir, { recursive: true });
readdirSync(outDir).forEach(function (f) {
  if (/^solana-web3-.*\.min\.js$/.test(f) && f !== name) {
    unlinkSync(resolve(outDir, f));
    console.log("removed stale " + f);
  }
});
copyFileSync(src, resolve(outDir, name));

// The page reads this to know which file to load, so bumping the dep is one command.
writeFileSync(resolve(outDir, "web3-version.json"), JSON.stringify({ version: pkg.version, file: name }, null, 2) + "\n");

var kb = Math.round(readFileSync(src).length / 1024);
console.log("vendored " + name + " (" + kb + "KB) -> site/public/vendor/");
console.log("If the filename changed, update WEB3_SRC in site/index.html.");

/* jsQR, for the ledger's camera scanner. It goes under server/vendor/ rather
   than into the front end's public/ because /admin is served by the API and may
   be opened on its own origin — it cannot assume the site is there. The API
   serves it at /vendor/jsqr.js. Loaded only when Scan is pressed.

   BarcodeDetector would avoid the download, but iOS Safari does not have it and
   a counter at an event runs on phones. */
var qrPkg = JSON.parse(readFileSync(resolve(here, "../node_modules/jsqr/package.json"), "utf8"));
var qrOut = resolve(here, "../vendor");
mkdirSync(qrOut, { recursive: true });
copyFileSync(resolve(here, "../node_modules/jsqr/dist/jsQR.js"), resolve(qrOut, "jsqr.js"));
writeFileSync(resolve(qrOut, "jsqr-version.json"), JSON.stringify({ version: qrPkg.version }, null, 2) + "\n");
console.log("vendored jsqr " + qrPkg.version + " (" +
  Math.round(readFileSync(resolve(qrOut, "jsqr.js")).length / 1024) + "KB) -> server/vendor/");
