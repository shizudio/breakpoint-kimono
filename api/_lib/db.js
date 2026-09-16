/* Storage for orders and the waitlist.
 *
 * Backed by Vercel Postgres / Neon via the DATABASE_URL that the Vercel
 * integration injects — no credential is ever committed or pasted by hand.
 * Until that variable exists every route still answers, saying plainly that
 * storage is not configured, so the site never breaks while it is being set up.
 */
let sqlPromise = null;

export function isConfigured() {
  return Boolean(process.env.DATABASE_URL || process.env.POSTGRES_URL);
}

async function sql() {
  if (!isConfigured()) return null;
  if (!sqlPromise) {
    sqlPromise = (async () => {
      const { neon } = await import("@neondatabase/serverless");
      const client = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);
      // One table per intent. Both carry the same four fields, so the waitlist
      // can be promoted into an order without reshaping anything.
      await client`
        CREATE TABLE IF NOT EXISTS orders (
          id          bigserial PRIMARY KEY,
          wave        integer NOT NULL DEFAULT 1,
          piece       integer,
          name        text NOT NULL,
          email       text NOT NULL,
          x_handle    text,
          tg_handle   text,
          status      text NOT NULL DEFAULT 'reserved',
          solana_mark boolean,
          wallet      text,
          tx          text,
          created_at  timestamptz NOT NULL DEFAULT now()
        )`;
      await client`
        CREATE TABLE IF NOT EXISTS waitlist (
          id          bigserial PRIMARY KEY,
          name        text NOT NULL,
          email       text NOT NULL,
          x_handle    text,
          tg_handle   text,
          created_at  timestamptz NOT NULL DEFAULT now()
        )`;
      // Existing rows predate the column; default them to wave one.
      await client`ALTER TABLE orders ADD COLUMN IF NOT EXISTS wave integer NOT NULL DEFAULT 1`;
      await client`ALTER TABLE orders ADD COLUMN IF NOT EXISTS solana_mark boolean`;
      // Piece numbers are unique within a wave, not across the whole table.
      await client`
        CREATE UNIQUE INDEX IF NOT EXISTS orders_wave_piece
        ON orders (wave, piece) WHERE status <> 'cancelled'`;
      // One live order per email per wave — a double submit must not take two.
      await client`
        CREATE UNIQUE INDEX IF NOT EXISTS orders_email_live
        ON orders (wave, lower(email)) WHERE status <> 'cancelled'`;
      await client`
        CREATE UNIQUE INDEX IF NOT EXISTS waitlist_email_once
        ON waitlist (lower(email))`;
      return client;
    })();
  }
  return sqlPromise;
}

export const PIECES = 15;

export async function listOrders(wave = null) {
  const client = await sql();
  if (!client) return [];
  if (wave === null) {
    return client`SELECT wave, piece, name, email, x_handle, tg_handle, status, solana_mark, created_at
                  FROM orders WHERE status <> 'cancelled' ORDER BY wave ASC, piece ASC`;
  }
  return client`SELECT wave, piece, name, email, x_handle, tg_handle, status, solana_mark, created_at
                FROM orders WHERE status <> 'cancelled' AND wave = ${wave} ORDER BY piece ASC`;
}

export async function listWaitlist() {
  const client = await sql();
  if (!client) return [];
  return client`SELECT name, email, x_handle, tg_handle, created_at
                FROM waitlist ORDER BY created_at ASC`;
}

/* Claims the lowest free piece number inside a single statement, so two
   simultaneous buyers cannot be handed the same one. The client-side cap is
   display only; this is the one that counts. */
/* Wave one is a hard run of fifteen, so its pieces are claimed from a fixed
   series and run out. Wave two is open-ended — it is confirmed by volume, not
   capped by it — so its orders simply take the next number and never sell out.
   Wave-two rows are held as 'pending_wave' until the run is confirmed, which is
   what the refund promise on the page is anchored to. */
export async function claimPiece({ name, email, x, tg, wallet, tx, wave = 1, mark = null }) {
  const client = await sql();
  if (!client) return { ok: false, reason: "not_configured" };
  const w = wave === 2 ? 2 : 1;

  const existing = await client`
    SELECT piece FROM orders
    WHERE wave = ${w} AND lower(email) = lower(${email}) AND status <> 'cancelled'`;
  if (existing.length) return { ok: true, piece: existing[0].piece, wave: w, already: true };

  if (w === 2) {
    const rows = await client`
      INSERT INTO orders (wave, piece, name, email, x_handle, tg_handle, wallet, tx, status, solana_mark)
      SELECT 2,
             COALESCE((SELECT MAX(piece) FROM orders WHERE wave = 2 AND status <> 'cancelled'), 0) + 1,
             ${name}, ${email}, ${x || null}, ${tg || null}, ${wallet || null}, ${tx || null},
             'pending_wave', ${mark}
      RETURNING piece`;
    return { ok: true, piece: rows[0].piece, wave: 2 };
  }

  const rows = await client`
    INSERT INTO orders (wave, piece, name, email, x_handle, tg_handle, wallet, tx, solana_mark)
    SELECT 1, gs, ${name}, ${email}, ${x || null}, ${tg || null}, ${wallet || null}, ${tx || null}, ${mark}
    FROM generate_series(1, ${PIECES}) AS gs
    WHERE NOT EXISTS (
      SELECT 1 FROM orders o WHERE o.wave = 1 AND o.piece = gs AND o.status <> 'cancelled')
    ORDER BY gs
    LIMIT 1
    RETURNING piece`;

  if (!rows.length) return { ok: false, reason: "sold_out" };
  return { ok: true, piece: rows[0].piece, wave: 1 };
}

export async function addWaitlist({ name, email, x, tg }) {
  const client = await sql();
  if (!client) return { ok: false, reason: "not_configured" };
  await client`
    INSERT INTO waitlist (name, email, x_handle, tg_handle)
    VALUES (${name}, ${email}, ${x || null}, ${tg || null})
    ON CONFLICT DO NOTHING`;
  return { ok: true };
}
