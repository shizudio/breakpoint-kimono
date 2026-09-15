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

Three things in `site/index.html` are still the prototype's simulation:

1. **`PRESALE_ENDS`** (top of the script) is a hard-coded date. It is shared by
   every visitor — which is the fix for the prototype's per-visitor localStorage
   timer — but it still belongs on the server.
2. **The wallet flow does not touch a chain.** Picking a wallet and pressing
   "300 USDC" advances the modal and increments the local buyer list. Nothing is
   charged and nothing is recorded.
3. **The buyer list is mock data** (`state.buyers`). Count, fill bar, proof line,
   leaderboard and the sold-out state all derive from it, so wiring one API
   response into that array lights up the whole page.

The 15-piece cap must be enforced server-side; the client bar is display only.

## Notes carried over from the design handoff

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
