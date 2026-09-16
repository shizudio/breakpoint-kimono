/* The pickup pass, as a picture.

   Two callers want the same image in different forms — the buyer's panel wants
   SVG inline in the page, the confirmation email wants a PNG it can attach —
   and both must encode exactly the same string. Keeping the target in one
   place is the point of this file: if the two ever drifted, a code scanned off
   an email would open a different URL from the same code scanned off a screen,
   and the failure would only show up at the counter.

   The code travels in the fragment. Everything after "#" stays in the browser:
   it is never sent to the server, never reaches an access log or a proxy, and
   never rides in a Referer header. The admin page reads it and clears it. */

import QRCode from "qrcode";
import { config } from "./config.js";

/* The house palette, so the pass looks the same in the panel and on paper. */
var INK = "#0E0E0E", GROUND = "#F7F4EE";

export function pickupTarget(order) {
  return config.publicOrigin + "/admin#c=" + encodeURIComponent(order.pickup_code);
}

export function pickupQrSvg(order) {
  return QRCode.toString(pickupTarget(order), {
    type: "svg", errorCorrectionLevel: "M", margin: 1,
    color: { dark: INK, light: GROUND }
  });
}

/* Printed, or squinted at on a phone in a hall with bad light. A wider quiet
   zone and a heavier error correction than the on-screen version, because this
   one has to survive being a photo of a screen, or a crease down the middle. */
export function pickupQrPng(order) {
  return QRCode.toBuffer(pickupTarget(order), {
    type: "png", errorCorrectionLevel: "Q", margin: 2, width: 600,
    color: { dark: INK, light: GROUND }
  });
}
