# The Breakpoint Kimono — presale landing page

A single static page. `site/` is the deploy root; there is no build step.

    site/
      index.html      the whole page (markup, styles, behaviour)
      frames3/        72-frame turntable sequence, f00–f71
      web/            photography + self-hosted portrait
      assets/logo.png 岩花 seal, recoloured white in the loader

Local preview:

    npx serve site

## Before this takes real money

Four things in `site/index.html` are still the prototype's simulation:

1. **`PRESALE_ENDS`** (top of the script) is a hard-coded date. It is shared by
   every visitor — which is the fix for the prototype's per-visitor localStorage
   timer — but it still belongs on the server.
2. **The wallet flow does not touch a chain.** Picking a wallet and pressing
   "300 USDC" advances the modal and increments the local buyer list. Nothing is
   charged and nothing is recorded.
3. **The order form has no destination.** It validates and shows a
   confirmation, but the submit handler POSTs nowhere — the request is dropped.
   This is the highest-value thing to wire up: it is the only path on the page
   that could capture a real buyer today, since the wallet flow is simulated. A
   Vercel route handler writing to a sheet, a Telegram bot message, or a form
   service are each an afternoon. Send `{ name, email, x, tg }` — the client already
   normalises pasted profile URLs to a bare handle.
4. **The buyer list is mock data** (`state.buyers`). Count, fill bar, proof line,
   leaderboard and the sold-out state all derive from it, so wiring one API
   response into that array lights up the whole page.

The 15-piece cap must be enforced server-side; the client bar is display only.

## Notes carried over from the design handoff

- The hero holds on the finished garment before releasing the page. `HOLD` (ms)
  is the beat; `END` is the float-safe "rotation complete" test, because the
  wheel notches sum to 0.9999999999999999 rather than 1. Release also waits for
  `curP` to settle — releasing on `targetP` alone scrolled the page away while
  the turntable was still six frames from finishing. A failsafe releases after
  `HOLD + 2500`ms so a suspended rAF can never trap anyone in the hero.
- The turntable image is the only `flex:1` child of the hero and must never get a
  `min-height` — it absorbs the fixed-height hero's shortfall. Verified to hold
  from 900px down to 520px of viewport height.
- The marquee's loop period is `children[6].offsetLeft`, not `scrollWidth/2`:
  12 children carry 11 gaps, so half the track is half a gap short.
- `prefers-reduced-motion` skips the scroll lock, the loader and the marquee.

## Preview notice

The page currently carries three preview notices — a strip above the countdown,
a line on the order card, and a line on the confirmation step — because the
wallet flow takes no payment. Remove all three (search `preview-bar` and
`preview-note`) when payments go live. The strip is hidden under 540px of
viewport height so it never eats the turntable's height budget.

## Mobile

Verified at 375×812, 360×640, 667×375 (landscape) and 1280×800. No horizontal
scroll at any size; the hero's turntable never overlaps the reserve stack.

What the touch rules change, all scoped to `(hover:none) and (pointer:coarse)`
so the desktop design is untouched:

- **Inputs go to 16px.** iOS Safari zooms the page when a focused input is under
  16px, which threw the user out of the hero. This is a deliberate deviation
  from the 14px in the design spec — it is a desktop number.
- **Tap targets.** "Order by form" and the modal's "Close" get a 44px hit area
  from an `::after` box, so the label does not move. Leaderboard rows go to
  61px, the X opt-in checkbox to 20px. The meta ledger links reach ~31px; a full
  44px would make adjacent rows overlap, so they stop short deliberately.
- **No hover pause on the marquee**, since a touch hover state can stick.

Two layout rules are width-based rather than pointer-based:

- Under 640px the materiality grid drops to one column.
- On portrait phones the turntable scales to `min(190vw,900px)`. The frames are
  16:9, which letterboxes the garment into a thin band on a portrait screen —
  scaling up and letting the hero's `overflow:hidden` crop the empty sides
  renders it ~1.9× larger. The radial mask already feathers the edges.

The preview strip hides under 540px of viewport height so it never eats the
turntable's height budget. Hero integrity holds from 900px down to 480px.

## Purchase flow

Both CTAs open one modal, in order:

1. **Your details** — the form (name, email, X, Telegram). Validation blocks here.
2. **Connect a wallet** — Phantom · Solflare · Backpack, plus an "I cannot use a
   wallet" escape that ends at the confirmation with payment details by email.
3. **Pay 300** — USDC or USDT.
4. **Reserved** — the order card, made out to the X handle from step one.

The details step adopts the `<form>` out of `#formHolder` rather than rebuilding
it, so its validation wiring survives every re-render of the panel. The pay step
no longer asks for an X handle — step one already has it.

## Order form

Collects **name**, **email**, **X account** and **Telegram**. Name and email are
required; the handles are optional and feed the order card.

- Pasted profile URLs are normalised to a bare handle on blur:
  `https://x.com/foo?s=21`, `x.com/foo`, `@foo` and `t.me/foo/` all become `foo`.
- Handle shapes are checked against the real limits — X is 1–15 of
  `[A-Za-z0-9_]`, Telegram 5–32.
- Email validation is deliberately loose (`something@something.tld`). The only
  real authority on an address is sending to it, and strict regexes reject valid
  addresses.
- Errors appear per field, and only after a field has been marked once, so
  nobody is scolded mid-typing. The errored underline turns `#9945FF`; the
  palette has no red and the system forbids inventing one.
- The confirmation names the address back ("…send payment details to
  you@example.com"), so a typo surfaces there rather than in silence.
- Fields use real `<label>` elements at the system's 9.5px micro-label spec,
  rather than placeholder-as-label.

## Turntable frames

Re-extracted from `source/hf_*.mp4` at the source's full **1920×1080**; the
handoff bundle had been downscaled to 1280×720, which the browser then upscaled
1.3–1.7× on any Retina screen. That was the blur.

    ffmpeg -i source/hf_*.mp4 -vf "fps=72/10.041667" \
           -frames:v 72 -q:v 8 -start_number 0 site/frames3/f%02d.jpg

`-q:v 8` lands the set at 3.2MB, within a rounding error of the old 1280 set, so
the loader's preload budget is unchanged for 2.25× the pixels. Going finer (q6,
q4) costs 0.5–1.2MB for well under 1dB — not worth it in front of a blocking
loader.

Anything that re-encodes these must keep 72 frames spanning exactly one 360°
rotation. Consecutive-frame PSNR should average ~25dB with the f71→f00 wrap
close behind at ~18dB; a spike means a dropped or duplicated frame.

No WebP/AVIF here — this machine has no encoder for either. WebP would cut
roughly a third off at equal quality and is worth doing in CI if the preload
ever needs to get lighter.

## Share card

`site/web/share-card.jpg` — 1200×600 (2:1), the shape `summary_large_image`
wants. Generated from `source/thumbnail.png` (1774×887):

    ffmpeg -i source/thumbnail.png -vf "scale=1200:600:flags=lanczos" \
           -q:v 3 site/web/share-card.jpg

Two bugs fixed alongside it, either of which alone meant **no card rendered at
all**:

1. `og:image` was a relative path. The Open Graph spec requires an absolute URL;
   crawlers do not resolve relative ones.
2. The share button tweeted text with no URL, so X had nothing to unfurl.

`SHARE_URL` at the top of the script and the absolute URLs in the `og:`/
`twitter:` tags are hard-coded to the vercel.app domain — **update all of them
together if a custom domain is attached.**

The card is a fixed image, so every buyer posts the same one; the piece number
lives in the tweet text instead. Per-buyer cards need a rendered
`/o/<id>` route — see the note on `@vercel/og` above.
