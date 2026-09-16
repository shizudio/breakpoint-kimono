/* Retired. This implementation has been replaced by the presale server in
 * server/, which verifies payment on chain. Closed rather than deleted so that
 * anything still pointing here gets a clear answer instead of a silent 404.
 *
 * /api/admin and /api/health still work: the rows already written are readable
 * until they have been migrated.
 */
export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(410).json({
    error: "retired",
    message: "This presale endpoint has moved. Write to @shizudio."
  });
}
