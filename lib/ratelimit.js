import { query } from "./db.js";

// Fixed-window rate limit on the rate_limits table. One upsert per call.
// Returns { allowed, remaining, count }.
export async function rateLimit(key, { limit, windowSeconds }) {
  const { rows } = await query(
    `INSERT INTO rate_limits (key, window_start, count)
     VALUES ($1, to_timestamp(floor(extract(epoch FROM now()) / $2) * $2), 1)
     ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limits.count + 1
     RETURNING count`,
    [String(key).slice(0, 200), windowSeconds],
  );
  const count = rows[0].count;
  if (Math.random() < 0.01) cleanupRateLimits().catch((err) => console.error(err)); // occasional cleanup
  return { allowed: count <= limit, remaining: Math.max(0, limit - count), count };
}

// Deletes windows older than a day.
export async function cleanupRateLimits() {
  const { rowCount } = await query("DELETE FROM rate_limits WHERE window_start < now() - interval '1 day'");
  return rowCount;
}

// Client IP from Vercel's proxy headers (first x-forwarded-for entry), else the socket address.
export function clientIp(req) {
  const fwd = req.headers?.["x-forwarded-for"];
  const first = String(Array.isArray(fwd) ? fwd[0] : fwd || "").split(",")[0].trim();
  return first || String(req.headers?.["x-real-ip"] || "").trim() || req.socket?.remoteAddress || "unknown";
}

// For POST /api/leads: 5 leads per IP per 10 minutes. Returns true when allowed;
// otherwise sends 429 with Retry-After and returns false.
export const LEAD_LIMIT = { limit: 5, windowSeconds: 600 };
export async function allowLeadSubmission(req, res, opts = LEAD_LIMIT) {
  const { allowed } = await rateLimit(`lead:${clientIp(req)}`, opts);
  if (allowed) return true;
  res.statusCode = 429;
  res.setHeader("Retry-After", String(opts.windowSeconds));
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ error: "too many requests" }));
  return false;
}
