import { query } from "../../lib/db.js";
import { isAdmin, sendJson } from "../../lib/http.js";

// GET /api/admin/stats   dashboard counts (Authorization: Bearer $ADMIN_TOKEN). Test leads are excluded.
export const TIMEZONE = () => process.env.APP_TIMEZONE || "America/Toronto"; // "today" is the realtor's day
const toMap = (rows) => Object.fromEntries(rows.map((r) => [r.key ?? "none", r.n]));

export async function getStats() {
  const [leads, bySource, byStatus, byArea, listings, syncs, notes] = await Promise.all([
    query(`SELECT count(*) FILTER (WHERE created_at >= date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1)::int AS today,
                  count(*) FILTER (WHERE created_at >= now() - interval '7 days')::int AS last_7_days,
                  count(*) FILTER (WHERE created_at >= now() - interval '30 days')::int AS last_30_days,
                  count(*)::int AS total
           FROM leads WHERE NOT is_test`, [TIMEZONE()]),
    query("SELECT source AS key, count(*)::int AS n FROM leads WHERE NOT is_test GROUP BY 1 ORDER BY 2 DESC"),
    query("SELECT status AS key, count(*)::int AS n FROM leads WHERE NOT is_test GROUP BY 1 ORDER BY 2 DESC"),
    query("SELECT area AS key, count(*)::int AS n FROM leads WHERE NOT is_test GROUP BY 1 ORDER BY 2 DESC"),
    query("SELECT area AS key, count(*)::int AS n FROM listings WHERE status = 'active' GROUP BY 1 ORDER BY 2 DESC"),
    query(`SELECT DISTINCT ON (source) source, started_at, finished_at, fetched, upserted, deactivated, error
           FROM sync_runs ORDER BY source, started_at DESC, id DESC`),
    query(`SELECT count(*) FILTER (WHERE status = 'sent')::int AS sent,
                  count(*) FILTER (WHERE status = 'failed')::int AS failed,
                  count(*) FILTER (WHERE status = 'skipped')::int AS skipped
           FROM notifications WHERE created_at >= now() - interval '7 days'`),
  ]);
  return {
    leads: leads.rows[0],
    by_source: toMap(bySource.rows),
    by_status: toMap(byStatus.rows),
    by_area: toMap(byArea.rows),
    active_listings_by_area: toMap(listings.rows),
    last_sync: Object.fromEntries(syncs.rows.map(({ source, ...run }) => [source, run])),
    notifications_7_days: notes.rows[0],
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!isAdmin(req)) return sendJson(res, 401, { error: "unauthorized" });
  if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
  try {
    return sendJson(res, 200, await getStats());
  } catch (err) {
    console.error(err);
    return sendJson(res, 500, { error: "server error" });
  }
}
