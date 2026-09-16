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
  pickup_code: "K7M2-9QX4",
  tx_signature: "5j7sVbfMhpQ2rA9xKq3Lm8NvYc4TdUw1ZgHbEoPnRi6kSaXyJtFuCw2eDqMz3Bh"
};

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
