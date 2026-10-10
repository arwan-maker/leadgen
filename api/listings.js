import { query } from "../lib/db.js";
import { cors, sendJson } from "../lib/http.js";
import { AREAS } from "../lib/areas.js";
import { rateLimit, clientIp } from "../lib/ratelimit.js";

// GET /api/listings?q=&area=&city=&type=&min_price=&max_price=&beds=&baths=&property_type=&sort=&page=&page_size=
// GET /api/listings?id=123   one active listing
// Public: only active listings and only display fields (never `raw`).
const FIELDS = `id, source, source_key, mls_number, transaction_type, property_type, address, city, area,
  postal_code, latitude, longitude, price, bedrooms, bathrooms, sqft, photo_urls, listing_url,
  office_name, agent_name, modified_at`;
const SORTS = {
  newest: "modified_at DESC NULLS LAST, id DESC",
  price_asc: "price ASC NULLS LAST, id ASC",
  price_desc: "price DESC NULLS LAST, id DESC",
};
const MAX_PAGE_SIZE = 48;

function params(req) {
  if (req.query && typeof req.query === "object") return req.query;
  return Object.fromEntries(new URL(req.url || "/", "http://localhost").searchParams);
}

const str = (v) => (Array.isArray(v) ? v[0] : v ?? "").toString().trim();

function num(p, key, errors, { int = false, min = 0 } = {}) {
  const v = str(p[key]);
  if (!v) return null;
  const n = Number(v.replace(/[$,\s]/g, ""));
  if (!Number.isFinite(n) || n < min || (int && !Number.isInteger(n))) { errors[key] = "invalid"; return null; }
  return n;
}

function shape(row) {
  return { ...row, id: Number(row.id), price: row.price == null ? null : Number(row.price) };
}

export function buildSearch(p) {
  const errors = {};
  const where = ["status = 'active'"], values = [];
  const add = (sql, value) => { values.push(value); where.push(sql.replace(/\?/g, `$${values.length}`)); };

  const q = str(p.q).slice(0, 100);
  if (q) add("(city ILIKE ? OR address ILIKE ? OR area ILIKE ? OR mls_number ILIKE ? OR postal_code ILIKE ?)",
    `%${q.replace(/[\\%_]/g, "\\$&")}%`);

  const area = str(p.area);
  if (area) {
    const match = AREAS.find((a) => a.toLowerCase() === area.toLowerCase());
    if (match) add("area = ?", match); else errors.area = "invalid";
  }
  const city = str(p.city).slice(0, 80);
  if (city) add("lower(city) = lower(?)", city);
  const type = str(p.type).toLowerCase();
  if (type) {
    if (type === "sale" || type === "lease") add("transaction_type = ?", type); else errors.type = "invalid";
  }
  const propertyType = str(p.property_type).slice(0, 40);
  if (propertyType) add("lower(property_type) = lower(?)", propertyType);

  const minPrice = num(p, "min_price", errors), maxPrice = num(p, "max_price", errors);
  if (minPrice != null) add("price >= ?", minPrice);
  if (maxPrice != null) add("price <= ?", maxPrice);
  const beds = num(p, "beds", errors, { int: true }), baths = num(p, "baths", errors, { int: true });
  if (beds != null) add("bedrooms >= ?", beds);
  if (baths != null) add("bathrooms >= ?", baths);

  const sort = str(p.sort) || "newest";
  if (!SORTS[sort]) errors.sort = "invalid";
  const page = num(p, "page", errors, { int: true, min: 1 }) ?? 1;
  const pageSize = Math.min(num(p, "page_size", errors, { int: true, min: 1 }) ?? 12, MAX_PAGE_SIZE);

  return { errors, where: where.join(" AND "), values, order: SORTS[sort], page, pageSize };
}

export default async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") return sendJson(res, 204, {});
  if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
  try {
    // Anti-scraping (CREA DDF rules 5(k)-(l)): cached responses don't reach here, so this only counts real queries.
    const limit = Number(process.env.LISTINGS_RATE_LIMIT) || 120;
    if (!(await rateLimit(`listings:${clientIp(req)}`, { limit, windowSeconds: 60 })).allowed) {
      console.warn("listings rate limit hit", clientIp(req));
      res.setHeader("Retry-After", "60");
      return sendJson(res, 429, { error: "too many requests" });
    }
    const p = params(req);
    if (p.id !== undefined) {
      const id = str(p.id);
      if (!/^\d{1,18}$/.test(id)) return sendJson(res, 400, { error: "validation", fields: { id: "invalid" } });
      const { rows } = await query(`SELECT ${FIELDS}, description FROM listings WHERE id = $1 AND status = 'active'`, [id]);
      if (!rows.length) return sendJson(res, 404, { error: "not found" });
      res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
      return sendJson(res, 200, shape(rows[0]));
    }

    const s = buildSearch(p);
    if (Object.keys(s.errors).length) return sendJson(res, 400, { error: "validation", fields: s.errors });
    const offset = (s.page - 1) * s.pageSize;
    const [count, list] = await Promise.all([
      query(`SELECT count(*)::int AS total FROM listings WHERE ${s.where}`, s.values),
      query(`SELECT ${FIELDS} FROM listings WHERE ${s.where} ORDER BY ${s.order} LIMIT $${s.values.length + 1} OFFSET $${s.values.length + 2}`,
        [...s.values, s.pageSize, offset]),
    ]);
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    return sendJson(res, 200, { total: count.rows[0].total, page: s.page, page_size: s.pageSize, results: list.rows.map(shape) });
  } catch (err) {
    console.error(err);
    return sendJson(res, 500, { error: "server error" });
  }
}
