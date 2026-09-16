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
          piece       integer UNIQUE,
          name        text NOT NULL,
          email       text NOT NULL,
          x_handle    text,
          tg_handle   text,
          status      text NOT NULL DEFAULT 'reserved',
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
      // One live order per email — a double submit must not take two pieces.
      await client`
        CREATE UNIQUE INDEX IF NOT EXISTS orders_email_live
        ON orders (lower(email)) WHERE status <> 'cancelled'`;
      await client`
        CREATE UNIQUE INDEX IF NOT EXISTS waitlist_email_once
        ON waitlist (lower(email))`;
      return client;
    })();
  }
  return sqlPromise;
}

export const PIECES = 15;

export async function listOrders() {
  const client = await sql();
  if (!client) return [];
  return client`SELECT piece, name, email, x_handle, tg_handle, status, created_at
                FROM orders WHERE status <> 'cancelled' ORDER BY piece ASC`;
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
export async function claimPiece({ name, email, x, tg, wallet, tx }) {
  const client = await sql();
  if (!client) return { ok: false, reason: "not_configured" };

  const existing = await client`
    SELECT piece FROM orders WHERE lower(email) = lower(${email}) AND status <> 'cancelled'`;
  if (existing.length) return { ok: true, piece: existing[0].piece, already: true };

  const rows = await client`
    INSERT INTO orders (piece, name, email, x_handle, tg_handle, wallet, tx)
    SELECT gs, ${name}, ${email}, ${x || null}, ${tg || null}, ${wallet || null}, ${tx || null}
    FROM generate_series(1, ${PIECES}) AS gs
    WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.piece = gs AND o.status <> 'cancelled')
    ORDER BY gs
    LIMIT 1
    RETURNING piece`;

  if (!rows.length) return { ok: false, reason: "sold_out" };
  return { ok: true, piece: rows[0].piece };
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
