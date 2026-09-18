/* Writes the confirmation email to a file so you can open it in a browser and
   read it as a buyer would. Nothing is sent and nothing touches the ledger: the
   order is made up, and both images are inlined as data URIs because a browser
   has no cid: to resolve — the real email attaches them instead. */

import { writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sheetHtml, sheetText } from "../src/email.js";
import { pickupQrPng } from "../src/qr.js";
import { config } from "../src/config.js";

var order = {
  id: "a1b2c3d4e5f60718",
  status: "paid",
  piece_no: 7,
  wallet: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
  name: "Shina Foo",
  email: "buyer@example.com",
  x_handle: "shizudio",
  mark: 1,
  pickup_code: "K7M2-9QX4",
  tx_signature: "5j7sVbfMhpQ2rA9xKq3Lm8NvYc4TdUw1ZgHbEoPnRi6kSaXyJtFuCw2eDqMz3Bh"
};

/* `npm run email:preview wave2 [file]` renders the wave-two letter instead. */
var wantWave2 = process.argv.indexOf("wave2") !== -1;
if (wantWave2) {
  var w2 = Object.assign({}, order, { wave: 2, wave_no: 4, piece_no: null, pickup_code: null });
  var { waveTwoHtml, waveTwoText } = await import("../src/email.js");
  var w2html = waveTwoHtml(w2);
  try {
    var c = readFileSync(config.emailCardImage ||
      fileURLToPath(new URL("../../site/public/web/share-card.jpg", import.meta.url)));
    w2html = w2html.replace("cid:order-card", "data:image/jpeg;base64," + c.toString("base64"));
  } catch (e) {}
  var w2out = resolve(process.argv.filter(function (a) { return a !== "wave2"; })[2] || "./wave-two-email.html");
  writeFileSync(w2out, w2html);
  console.log(waveTwoText(w2));
  console.log("\n— written to " + w2out);
  process.exit(0);
}

var png = await pickupQrPng(order);
var card = null;
try {
  card = readFileSync(config.emailCardImage ||
    fileURLToPath(new URL("../../site/public/web/share-card.jpg", import.meta.url)));
} catch (e) { console.error("no order card image — previewing without it"); }

var html = sheetHtml(order)
  .replace("cid:pickup-qr", "data:image/png;base64," + png.toString("base64"));
if (card) html = html.replace("cid:order-card", "data:image/jpeg;base64," + card.toString("base64"));

var out = resolve(process.argv[2] || "./confirmation-email.html");
writeFileSync(out, html);
console.log(sheetText(order));
console.log("\n— written to " + out);
