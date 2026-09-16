# The Breakpoint Kimono — presale

A fifteen-piece run, sold for 300 USDC on Solana. Two apps:

    site/               the front end (Vite)
      index.html        markup, styles, behaviour — still one file
      public/           copied verbatim, served at the root
        frames-v2/      72-frame turntable sequence, f00–f71
        web/            photography, portrait, buyer avatars, share card
        vendor/         @solana/web3.js, self-hosted
        assets/         岩花 seal

    server/             the API — Node, no framework
      src/              routes, ledger, chain, sign-in, notifications
      test/             the suite; `npm test`
      .env              secrets. NOT in git. Copy .env.example.

    data/orders.db      SQLite ledger. NOT in git. Back this up.
    dist/               `npm run build` output. NOT in git.

## Running it

Two processes, two terminals:

    npm run install:all         # once

    npm run server              # the API, :4321
    npm run start               # the front end, :5173

Open **http://localhost:5173**. The API is also reachable directly on :4321, but
it no longer serves the page — `/` there is a 404 by design. `/admin` stays on
the API, since it is an operational tool rather than part of the shop.

Before taking real money, and after any change to `server/.env`:

    npm run server:check

It catches the failures that are silent rather than loud: a devnet mint on
mainnet, a treasury that cannot receive USDC, a bot token that was never
started, a closing date already in the past, an admin wallet that is not an
address.

### How the two halves meet

`VITE_SERVER_URL` in the root `.env` decides, and the two modes are not
equivalent.

**Empty (the default, and the one to prefer).** Vite proxies `/api` and `/admin`
to the API, so the browser only ever sees one origin. The session cookie stays
`SameSite=Lax`, there is no CORS, and there is nothing to keep in step. In
production you reproduce this with a reverse proxy in front of both, or by
setting `SITE_DIR=../dist` so the API process serves the build as well.

**An absolute URL** (`https://api.example.com`) makes the browser call the API
directly, cross-origin. Three things then have to line up:

- `ALLOWED_ORIGINS` on the server must name the front end's origin
- `SECURE_COOKIES=1`, because a cross-site cookie must be `SameSite=None` and
  browsers drop a `SameSite=None` cookie that is not `Secure`
- both sides on https

The server refuses to start if the first two disagree, because the failure
otherwise looks like "sign-in does nothing" rather than like an error. Even set
up correctly, this mode depends on third-party cookies, which Safari blocks by
default and Chrome is phasing out. The proxy has none of that exposure.

    npm run build               # -> dist/
    npm run preview             # serve dist/ with the same proxy

## Configuration

Two files. `server/.env` holds every secret and is never sent to the browser —
there is a test asserting the RPC key appears in no API response. The root
`.env` holds only `VITE_*` names, which are compiled into the page and are
therefore public by definition.

| `server/.env` | What it is |
| --- | --- |
| `NETWORK` | `mainnet` or `devnet`. |
| `RPC_URL` | Helius/QuickNode/Triton. **Carries an API key — server only.** |
| `TREASURY` | Where the USDC lands. |
| `PRICE_USDC`, `CAP` | 300 and 15. |
| `HOLD_MINUTES` | How long a pending order holds a piece. Default 20. |
| `PRESALE_ENDS` | ISO instant. Drives the countdown for every visitor. |
| `SESSION_SECRET` | `openssl rand -hex 32`. Rotating it signs everyone out. |
| `ADMIN_WALLETS` | Solana addresses, comma-separated, that may open `/admin`. |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Optional. Blank disables notifications; orders still record. |
| `SITE_DIR` | Empty: API only. `../dist`: also serve the built front end. |
| `ALLOWED_ORIGINS` | Only for the cross-origin mode above. |
| `PUBLIC_ORIGIN` | Used in the pickup QR. |
| `SECURE_COOKIES` | `1` once behind HTTPS. Mandatory with `ALLOWED_ORIGINS`. |

### Telegram

Four things get a message, and every one of them is something you would want to
know from across a room:

| | |
| --- | --- |
| **A sale** | piece number, name, handles, pickup code, the transaction |
| **A hand-over** | piece number, name, code, which wallet released it, how many are left |
| **A payment after sell-out** | the wallet to refund, and the transaction |
| **A restart** | how much is sold, so you know it came back up |

Every send is fire-and-forget: a sale is recorded the moment SQLite commits, and
nothing about telling you is allowed to stand between a buyer and their
confirmation. A failed send is logged and lands in the event trail; it never
reaches the buyer and never fails the order. `notify.test.js` runs a stand-in
Telegram to prove exactly that, including the case where it answers 500.

Scanning the same code twice does **not** send a second hand-over message.
Handing over is idempotent, and a code scanned twice at a busy counter should
not read as a second kimono going out.

Message **@BotFather** → `/newbot` → copy the token into `TELEGRAM_BOT_TOKEN`.
Then message **@userinfobot** for your numeric id into `TELEGRAM_CHAT_ID`.
**Send your new bot a message first** — a bot cannot open a conversation, so
until you do, every send fails with "chat not found". `npm run server:check`
sends a test message and says so if this is the problem.

## How a payment actually works

The browser's word for "I paid" is worth nothing. A piece is awarded only when
the server has found the transaction on chain and checked it:

1. **Connect.** The buyer signs a nonce with their wallet. No payment is
   approved at this step, and the message says so. The server verifies the
   ed25519 signature and sets a session cookie.
2. **Details.** `POST /api/orders` validates the form again server-side, takes
   the write lock, checks the cap and writes a **pending** order. This is the
   moment a piece comes off the board. The server then builds the USDC transfer
   — amount, mint and destination all decided here, never by the page — and
   returns it unsigned.
3. **Pay.** The wallet signs and sends it. The page gets back a signature.
4. **Verify.** `POST /api/orders/:id/confirm` fetches that transaction from the
   chain and requires all of: it exists, it did not fail, it carries this
   order's reference key, its fee payer is the signed-in wallet, and the
   treasury's USDC balance went **up by at least 300**. Only then does the order
   become `paid`, take a piece number and get a pickup code.

The balance check reads pre/post token balances rather than parsing
instructions, so it is identical whether the wallet sent `transfer` or
`transferChecked`, and whether the token account was created in the same
transaction. An outgoing transfer computes as a negative delta and is refused —
verified against real treasury history.

### What stops a tampered front end

The page can be modified in the browser: it can send any signature it likes and
report any outcome it likes. What it cannot do is change what the chain says, and
every payment rule is applied to the chain's own record of the transaction:

| Forgery | Refused because |
| --- | --- |
| A transfer of USDT, or any other token | the mint is not the configured one |
| A transfer to another address | no account the treasury owns was credited |
| 299.999999 USDC | the credit is below the configured price |
| `300` with the decimals moved | same — comparison is in base units, as BigInt |
| A withdrawal presented as a payment | an outgoing transfer is a negative delta |
| Another buyer's real payment | its fee payer is not the signed-in wallet |
| A real payment for a different order | it does not carry this order's reference |
| An older payment replayed | it landed before the order existed |
| A transaction that failed on chain | `meta.err` is set |
| A signature the chain never saw | there is nothing to verify |

The reference is a fresh random public key minted per order, which is why no
pre-existing transaction can be claimed against a new one, and the mint,
treasury and price are read from configuration rather than from the transaction
— change the treasury and yesterday's valid payment stops verifying, which is
the property worth having.

This logic is deliberately free of network and database (`checkTransaction` in
`src/solana.js`) so it can be attacked directly: `test/forgery.test.js` puts
twenty-two forgeries through it, including each row above.

### The cap

Enforced in SQLite and nowhere else. Every write that can consume a slot runs
inside `BEGIN IMMEDIATE`, which takes the write lock *before* reading, so two
buyers confirming in the same millisecond serialise. `test/cap.test.js` races 40
processes for 15 pieces and asserts exactly 15 come away, numbered 1–15 with no
gaps or repeats. The fill bar on the page is display only.

One wallet holds one slot: a buyer who reopens the modal reuses their pending
order rather than taking a second piece. Without that, fifteen clicks would empty
the run. The wallet address is also on every row of the ledger, so a full board
reads as however many people it actually is — without it there is no way to tell
four rows from one person pressing Reserve four times.

### When things go wrong

- **Paid but not verified.** The page keeps the signature on screen with a
  "Check again" button rather than a spinner. The two retry ladders — the
  server's six-second poll and the page's six tries — are sized together to
  about a minute; they used to multiply out to nearly three.
- **Paid after sell-out.** The order is marked `overflow`, never awarded a
  piece, and Telegram is alerted that a refund is owed. `npm run check` lists
  any outstanding ones.
- **Hold lapsed while the transaction confirmed.** The money is real, so the
  payment is taken and a piece assigned if one remains.

## Collecting at Breakpoint

Paying mints an **8-character pickup code** (`K7M2-9QX4` — Crockford base32
without I, L, O or U, so it survives being read aloud across a noisy hall).

An order is reachable exactly two ways, and there is no third:

- **The buyer** connects the wallet that paid. That is the same sign-in placing
  the order already required, so it costs them nothing new. Pressing Reserve
  while already signed in asks the server what the wallet holds before offering
  anything, so a buyer who has paid gets their pass back rather than an order
  form for a piece they own — including in the same session, in another tab, or
  after a reload that restored the session from the cookie.
- **Staff** open `/admin` and sign in with a wallet named in `ADMIN_WALLETS` —
  the same signature buyers give, checked against a list. Then press **Scan** to
  open the camera in the page, or type the first characters of the code or the
  buyer's name. Either way the ledger filters to that row, which shows the piece
  number in large type; "Hand over" records **which wallet** released it and
  when. A second scan is not an error and does not move the recorded time.

  Scanning only filters. Handing a piece over stays a press, made while looking
  at the person — never something a camera does on its own, and it goes through
  the page's own confirmation rather than `window.confirm`. The browser's dialog
  is an OS sheet titled with the hostname; it cannot show the piece number or
  the name, which are the two things staff should be checking. The page's can,
  and says that the release is recorded against their wallet.

### The scanner

`Scan` opens the camera inside the ledger. It decodes with jsQR rather than the
browser's `BarcodeDetector`, which iOS Safari does not have and a counter at an
event runs on phones; the 251KB decoder is fetched from the API at
`/vendor/jsqr.js` the first time the button is pressed, never on load. Frames are
decoded at 480px wide, which is plenty at arm's length and stops the phone
getting hot.

It accepts either form: the URL the buyer's QR carries (code in the fragment) or
a bare `XXXX-XXXX`, so a printed list still scans.

**The camera needs a secure context.** `localhost` counts; a bare LAN address
over http does not, and the browser's refusal is an unhelpful `NotAllowedError`
— so the page says what is actually wrong. Serve the ledger over https at the
event, or fall back to typing the code.

A buyer's own camera app still works as a second route: the QR holds this page's
URL, so scanning it from outside opens the ledger with the code already filled.

At the counter the buyer only has to produce the code — read it out, or let it
be scanned. They need neither a wallet nor a signal, because the authoritative
view is the ledger's, not theirs.

**Ask for the name as well.** The code is a bearer token for a physical object:
whoever reads it out can be handed the piece. Since no page will trade a code
for an order, the code on its own does not say whose it is — the name is in the
ledger and a passer-by does not have it, which makes asking a real second check
rather than a formality. The confirmation panel tells buyers to expect it.

For the same reason the code is **masked until asked for** in both places it
appears. On the buyer's confirmation panel it sits behind "Show code", and the
QR — the same string in another form — is not even fetched until then. In the
ledger every code is masked at once, with a single toggle above the list; search
still matches a masked code, so the usual job at the counter (type four
characters, find the row) never needs any of them shown. Both start masked again
on reload, because the alternative is a screen full of bearer tokens held up in
front of a queue.

An earlier version also served the order to anyone holding the code, at
`/pass?code=…`. It is gone. It leaked a name — and through its transaction link
a wallet, which the public leaderboard's X handle would then have been tied to —
to whoever glanced at a screen over someone's shoulder. Nothing needed it.

### Coming back later

The session cookie is good for 72 hours, so a visitor returns to a page that
knows their address without ever having called `connect()` in that page load.
Everything needing the *wallet* rather than the session is unavailable in that
state unless it is put back deliberately — so `reattachWallet()` runs as soon as
a live session is recognised, using `connect({ onlyIfTrusted: true })`, which
reconnects without a prompt where the site is already approved and stays quiet
where it is not. A wallet answering with a different address is ignored rather
than trusted.

Paying used to begin `if (!state.provider) return`. After a reload there was no
provider, so the button was dead and said nothing — the worst shape a failure
can take on a checkout. It now reattaches, and if it cannot, it says so and
sends the buyer back to connect with their piece still held.

A wallet that got as far as the wallet prompt and stopped comes back to a piece
that is still held **and to the details it already typed**: the order is on the
server with the name and address in it, so the form is filled from it and the
panel says when the hold runs out. Only empty fields are touched, and only once
per arrival at the step, so a re-render mid-typing cannot overwrite what is
being typed — and a field cleared on purpose stays cleared.

`reconnect.test.js` holds all of it.

### The confirmation panel

It has to fit without scrolling. It is what someone holds up at a counter, and
the pickup code sits in the middle of it — a panel that scrolls is a panel where
the code is below the fold. `npm run measure` checks this in a real browser at
six sizes.

Getting there meant cutting rather than shrinking: the "lost it, reconnect your
wallet" line appeared twice, the warning ran to five lines that nobody would
read, and the amount and its transaction link were two rows saying one thing.
The order card is cropped to a band, which costs nothing — the garment and the
wordmark both sit in the middle of that image.

Every step with a session behind it also carries **Disconnect** next to Close.
It clears the cookie, drops what the page cached about the wallet, and asks the
extension to forget the approval, so the next connect actually prompts. A shared
laptop at an event is the case that needs it.

### The code is never in a URL

Not in a path, not in a query string, and not in what the QR encodes. URLs are
written to browser history, to proxy and server access logs, and travel in the
`Referer` header to wherever the page links next — none of which is a place for
a bearer token to a physical object.

So the buyer's QR comes from `POST /api/orders/:id/qr`, behind their own
session, with the code in the response rather than the path. What it encodes is
`/admin#c=CODE` — a **fragment**, which by definition never leaves the browser:
it is not sent to the server, so it cannot reach a log or a proxy, and it is not
carried in `Referer`. The admin page reads it and immediately clears it out of
the address bar with `history.replaceState`, so it does not linger in the
history entry either. `/admin` also sends `referrer: no-referrer`.

### Why admin is a wallet and not a password

A shared token gets pasted into a chat to get someone else onto the ledger,
photographed off a laptop at a counter, and keeps working afterwards. A wallet
signature is per-person, proves possession rather than knowledge, and removing
someone is one edit to `ADMIN_WALLETS`.

It also makes the hand-over record true: `collected_by` is the wallet that
signed, not a name someone typed into a prompt. Every admin route calls the same
check — a signed-in buyer's session gets a 403 there, because holding *a*
session is not the same as holding an admin one.

## Tests

    cd server && npm test

- `cap.test.js` — 40 processes race for 15 pieces. No oversell.
- `api.test.js` — the API end to end: sign-in, replay, ownership, cap, path
  traversal, that no response leaks the RPC key, and that every admin route
  refuses both an anonymous caller and a signed-in buyer.
- `page.test.js` — loads the real `site/index.html` in jsdom with a wallet that
  signs with a real ed25519 key, and walks connect → details → pay. Asserts the
  transaction the server built: right treasury token account, 300000000 base
  units, buyer as fee payer.
- `pickup.test.js` — the hand-over, and that no endpoint will trade a pickup
  code for an order.
- `notify.test.js` — every Telegram message, against a local stand-in: what
  each one says, that a repeat scan sends nothing, and that a hand-over still
  completes when Telegram answers 500.
- `reconnect.test.js` — the returning visitor, in two page loads sharing one
  cookie: the session is recognised without signing in again, the wallet is
  reattached quietly, paying works after a reload, and a wallet that has
  forgotten the site sends you back to connect rather than doing nothing.
- `scan.test.js` — the camera scanner, with a real camera: a QR is rendered
  into a Y4M video and played into Chrome in place of a webcam, then the run is
  sign in → scan → filter → hand over. The video is written by hand rather than
  shelled out to ffmpeg, which is not on every machine.
- `forgery.test.js` — twenty-two tampered transactions against the payment
  gate: wrong token, wrong destination, wrong amount, wrong payer, wrong order,
  replayed, failed, malformed. No network, no database.

Separately, `npm run measure` drives Chrome against the running dev server and
reports the confirmation panel's height at six viewport sizes. It writes a
fabricated paid order to have something to measure, so it **refuses to run
against a ledger that already holds a paid order** and deletes its own row on
the way out, including when a measurement throws. An earlier version did
neither and left six invented orders in the real ledger. It is not part of
`npm test` because it needs both processes up and a Chrome on the machine, but
it is the only way to answer "does this need scrolling" — jsdom has no layout.
Run it after touching that panel: it must say "no scroll" everywhere, down to a
375×667 iPhone SE. It reached 763px once, which is how the rule got written.

The one step no test performs is the transfer itself. Rehearse that on devnet:
set `NETWORK=devnet` with a devnet `RPC_URL`, get devnet USDC from Circle's
faucet, and buy a piece from a throwaway wallet. Delete `data/orders.db`
afterwards so the run starts from zero.

## Vendored web3

`site/vendor/solana-web3-<version>.min.js` is the browser build of
`@solana/web3.js`, copied out of `node_modules` by `npm run vendor`. It is
self-hosted rather than loaded from a CDN: this is the one page where a
compromised third-party script costs someone 300 USDC, and the page already
self-hosts its photography and avatars on the same principle.

It is 473KB and only the checkout needs it, so it loads on the first click of a
reserve button, not in front of the hero. `site/vendor/` is served immutable for
a year like `frames-v2/`, so the filename carries the version — after bumping
the dependency, run `npm run vendor` and update `WEB3_SRC` in `site/index.html`.

## Deploying

Two artifacts now: `dist/` from `npm run build`, which is static and can go
anywhere, and the API, which needs a **process and a persistent disk** for the
SQLite ledger. Platforms with ephemeral filesystems (Vercel, Netlify, Cloudflare
Workers) cannot host the API — the ledger would be wiped on every deploy. A
small VPS works as-is; Fly, Railway or Docker need a volume mounted at `data/`.

Serving both from one hostname is worth the small effort: it keeps the session
cookie same-site. Either put a reverse proxy in front of both, or set
`SITE_DIR=../dist` and let the API process hand out the build.

Behind TLS, with:

- `SECURE_COOKIES=1` and `PUBLIC_ORIGIN` set to the real https origin
- `TRUST_PROXY=1` if a reverse proxy sits in front, so rate limits see real IPs
- **a backup of `data/orders.db`**. It is fifteen people who have paid you.
  The chain is the record of the money; this file is the record of who they are
  and where their piece goes.

`SHARE_URL` at the top of the script and the absolute `og:`/`twitter:` URLs are
still hard-coded to the vercel.app domain — **update all of them together** when
the real domain is attached.

## What is still simulated

Nothing in the payment path. Two things remain deliberate choices rather than
gaps:

1. **The "I cannot use a wallet" escape** ends at a note to write to @shizudio.
   It captures no lead. Pieces sold that way come out of the same fifteen and
   have to be entered by hand.
2. **No email is sent.** The confirmation names the address back, and the pass
   is on screen and bookmarkable, but nothing arrives in an inbox. A buyer who
   loses the tab has their wallet — reconnecting reopens their pass.

## Notes carried over from the design handoff

- During that hold the CTA lights up (`.cta.is-live`, the same gradient, wave and
  dual glow as its hover state), so the beat reads as "this is next" rather than
  a frozen page. Every `holdStart` transition goes through `setHold()` so the
  glow cannot drift out of sync with the hold it represents.
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

## Mobile

Verified at 375×812, 360×640, 667×375 (landscape) and 1280×800. No horizontal
scroll at any size; the hero's turntable never overlaps the reserve stack.

What the touch rules change, all scoped to `(hover:none) and (pointer:coarse)`
so the desktop design is untouched:

- **The hold at the end of the rotation is shorter** (420ms against 900ms).
  Release happens inside `consume()`, which only runs on input: a wheel streams
  events so desktop lets go the moment the beat is up, but a swipe is one
  discrete burst, so if the finger lifts first the entire next swipe is eaten by
  the hero. `touchstart` now also releases once the beat has passed, so the
  swipe that follows the hold scrolls the page instead of being consumed.
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
- The About section is image-left / copy-right at every width. Above 640px it is
  a pinned two-column grid, `clamp(180px,32%,300px)` for the portrait — the
  shared `.two-col` auto-fit had been giving it a full half of the row (414px on
  a 1280 desktop), dwarfing the copy. Below 640px the grid would have collapsed
  and taken the portrait full-bleed (319×399 on a 375px phone), so the portrait
  floats left at 40% / max 158px instead: same left-right reading, and the
  paragraphs keep a usable measure rather than the ~27 characters a true
  two-column split would leave them. Section height on a 375px phone went from
  1017px to 648px.
- On portrait phones the turntable scales to `min(190vw,900px)`. The frames are
  16:9, which letterboxes the garment into a thin band on a portrait screen —
  scaling up and letting the hero's `overflow:hidden` crop the empty sides
  renders it ~1.9× larger. The radial mask already feathers the edges.

Hero integrity holds from 900px down to 480px.

## Purchase flow

Both CTAs open one modal, in order:

1. **Connect a wallet** — Phantom · Solflare · Backpack, plus an "I cannot use a
   wallet" escape. A wallet that is not installed stays in the list as a link to
   its download page; hiding two of the three because of what the visitor happens
   to have installed reads as a broken panel. Each is found at render time, since
   extensions inject themselves at different moments.
2. **Your details** — the form (name, email, X, Telegram). Validation blocks
   here, then the server holds a piece.
3. **Pay 300 USDC** — one button; the transaction is already built.
4. **Reserved** — the order card and the pickup pass.

The wallet moved to the front when payments went live: the order is created
against the signed-in wallet, so there is nothing to submit before connecting.
USDT is gone — one asking price in one token is one less thing to reconcile
against the treasury.

The details step adopts the `<form>` out of `#formHolder` rather than rebuilding
it, so its validation wiring survives every re-render of the panel. Between
showings the panel is cleared and the form lives detached, held only by the
variable — which is why every field lookup is scoped to the form and not to the
document.

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
- The confirmation names the address back, so a typo surfaces there rather than
  in silence.
- The same rules are enforced again in `server/src/util.js`. The duplication is
  the point: the client's copy is there to save a round trip, the server's is
  there because the client's can be deleted from the console.
- Fields use real `<label>` elements at the system's 9.5px micro-label spec,
  rather than placeholder-as-label.

## Turntable frames

Re-extracted from `source/video_new.mp4` at the source's full **1920×1080**; the
handoff bundle had been downscaled to 1280×720, which the browser then upscaled
1.3–1.7× on any Retina screen. That was the blur.

    ffmpeg -i source/video_new.mp4 -vf "fps=72/10.041667" \
           -frames:v 72 -q:v 8 -start_number 0 site/frames-v2/f%02d.jpg

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

## Buyer avatars

`site/web/avatar-<handle>.jpg`, 128×128 — self-hosted snapshots of the X profile
pictures, fetched once via unavatar.io and re-encoded. Nothing on the page calls
a third party at runtime.

    curl -L "https://unavatar.io/x/<handle>" -o /tmp/a.jpg
    ffmpeg -i /tmp/a.jpg -vf "scale=128:128:flags=lanczos" -q:v 3 \
           site/web/avatar-<handle>.jpg

Then add the handle to `AVATARS` in the script. Anyone missing from that map
falls back to the initial on a tinted ground, which is the design's own
treatment — so a new buyer never renders broken. These are snapshots: if someone
changes their picture, theirs goes stale until it is re-fetched.

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

The same image is the order card in the modal's final step, replacing the flat
purple→green gradient block. The handle and piece number stay as DOM text in the
row beneath it, so they render crisply at any panel width instead of being baked
into a 370px-wide bitmap.

Note the `<img>` keeps its `width`/`height` attributes for CLS, so the CSS must
set `height:auto` — an explicit height attribute beats `aspect-ratio` and
crops the artwork to a tall slice.

The card is a fixed image, so every buyer posts the same one; the piece number
lives in the tweet text instead. Per-buyer cards need a rendered
`/o/<id>` route — see the note on `@vercel/og` above.

## The hero owns the scroll position

The hero locks the page on load, so it must also control where the page sits.
Left to the browser, `history.scrollRestoration` puts a refreshing visitor back
where they were — say 3000px down — and the lock then freezes them there with
every wheel and swipe consumed by a turntable that is off screen at the top.
It reads as a completely dead page and only recovers after 2600px of scrolling
into nothing.

So: `scrollRestoration` is set to `manual` (only when the lock is active — under
reduced motion the browser keeps its normal restore), `setLock(true)` forces the
page to the top, and a `pageshow` with `persisted` resets to the hero, because a
bfcache restore brings back the frozen lock without re-running the script.

## Cache-busting the turntable

Frames are served `immutable, max-age=31536000`, so **a new turntable must land
on a new path**. Swapping the files under an existing folder deploys fine and
still leaves every returning visitor on the old render, out of their own disk
cache, for up to a year — this already happened once going from the original
master to `video_new.mp4`.

To swap the video: extract into `site/frames-<next>/`, then update all three of
`FRAMES_DIR` in the script, the hero `<img src>`, and the `headers` source in
`vercel.json`. The script comment next to `FRAMES_DIR` says the same.
