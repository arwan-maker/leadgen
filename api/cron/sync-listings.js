import { syncListings } from "../../lib/listings/sync.js";
import { safeEqual, sendJson } from "../../lib/http.js";

// GET /api/cron/sync-listings[?full=1]   Vercel Cron, hourly. Needs Authorization: Bearer $CRON_SECRET.
export default async function handler(req, res) {
  if (!safeEqual(req.headers.authorization, `Bearer ${process.env.CRON_SECRET ?? ""}`) || !process.env.CRON_SECRET) {
    return sendJson(res, 401, { error: "unauthorized" });
  }
  if (req.method !== "GET" && req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
  try {
    const full = String(req.query?.full ?? new URL(req.url || "/", "http://x").searchParams.get("full")) === "1";
    const results = await syncListings({ full, deadline: Date.now() + 45_000 });
    return sendJson(res, results.some((r) => r.error) ? 500 : 200, { results });
  } catch (err) {
    console.error(err);
    return sendJson(res, 500, { error: "server error" });
  }
}
