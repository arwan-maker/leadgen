import { query } from "./db.js";
import { areaFromText, allCities } from "./areas.js";
import { parseBudget, budgetText } from "./budget.js";

const TYPE_FOR_INTENT = { buy: "sale", rent: "lease" };
const LISTING_COLUMNS = `id, source, source_key, mls_number, transaction_type, property_type, address, city, area,
  price, bedrooms, bathrooms, listing_url, photo_urls`;

function leadText(lead) {
  return [lead.location, lead.search_query].filter(Boolean).join(" ").toLowerCase();
}

export function leadArea(lead) {
  return lead.area || areaFromText(lead.location) || areaFromText(lead.search_query);
}

function citiesInText(text) {
  return allCities().map((c) => c.toLowerCase())
    .filter((c) => new RegExp(`\\b${c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text));
}

// 0 to 30 points for how well a price fits the budget.
function budgetScore(price, budget) {
  if (!budget) return 15;
  if (price == null) return 5;
  if (budget.max != null && price > budget.max) return price <= budget.max * 1.1 ? 15 * (1 - (price / budget.max - 1) * 5) + 5 : 0;
  if (budget.min != null && price < budget.min) return price >= budget.min * 0.8 ? 20 : 0;
  return 30;
}

// Scores one listing against a lead, 0 to 100. The listing the lead was viewing always scores 100.
export function scoreListing(listing, lead, ctx = {}) {
  if (ctx.viewedId != null && String(listing.id) === String(ctx.viewedId)) return 100;
  const price = listing.price == null ? null : Number(listing.price);
  let score = 0;
  if (ctx.area && listing.area === ctx.area) score += 30;
  if (listing.city && (ctx.cities || []).includes(listing.city.toLowerCase())) score += 20;
  if (ctx.type && listing.transaction_type === ctx.type) score += 20;
  score += budgetScore(price, ctx.budget);
  return Math.round(Math.min(95, score * 0.95) * 100) / 100;
}

function viewedListing(lead) {
  if (!lead.listing_id) return null;
  return query(
    `SELECT ${LISTING_COLUMNS} FROM listings
     WHERE status = 'active' AND (mls_number = $1 OR source_key = $1) LIMIT 1`,
    [lead.listing_id],
  ).then((r) => r.rows[0] ?? null);
}

// Active listings that fit a lead, best first: [{ listing, score, viewed }].
// 'sell' leads get none. Without an area, only the viewed listing can match.
export async function findMatches(lead, { limit = 5 } = {}) {
  if (lead.intent === "sell") return [];
  const viewed = await viewedListing(lead);
  const budget = parseBudget(budgetText(lead));
  const type = TYPE_FOR_INTENT[lead.intent]
    || (budget ? (budget.monthly ? "lease" : "sale") : null)
    || (viewed?.transaction_type ?? null);
  const area = leadArea(lead) || viewed?.area || null;
  const cities = citiesInText(leadText(lead));
  const ctx = { area, cities, type, budget, viewedId: viewed?.id };
  const results = viewed ? [{ listing: viewed, score: 100, viewed: true }] : [];
  if (area) {
    const { rows } = await query(
      `SELECT ${LISTING_COLUMNS} FROM listings
       WHERE status = 'active' AND area = $1
         AND ($2::text IS NULL OR transaction_type = $2)
         AND ($3::numeric IS NULL OR price <= $3 * 1.1)
         AND ($4::numeric IS NULL OR price >= $4 * 0.8)
         AND ($5::bigint IS NULL OR id <> $5)
       ORDER BY (lower(city) = ANY($6)) DESC, modified_at DESC NULLS LAST, id DESC
       LIMIT 200`,
      [area, type, budget?.max ?? null, budget?.min ?? null, viewed?.id ?? null, cities],
    );
    for (const listing of rows) {
      const score = scoreListing(listing, lead, ctx);
      if (score > 0) results.push({ listing, score, viewed: false });
    }
  }
  for (const r of results) r.listing.price = r.listing.price == null ? null : Number(r.listing.price);
  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

// The active seller covering the lead's area (empty areas = all) with the fewest leads in the last 30 days.
// LEAD_ROUTING=owner (default): every lead goes to the realtor who owns the listing feeds
// (OWNER_SELLER_ID, else the first active seller). The feed rules may not allow sending leads
// to other agents until CREA and PropTx confirm. LEAD_ROUTING=area: spread by service area.
export async function assignSeller(lead) {
  if ((process.env.LEAD_ROUTING || "owner") === "owner") {
    const { rows } = await query(
      `SELECT * FROM sellers WHERE active AND ($1::bigint IS NULL OR id = $1::bigint) ORDER BY id LIMIT 1`,
      [process.env.OWNER_SELLER_ID || null],
    );
    return rows[0] ?? null;
  }
  const area = leadArea(lead) || null;
  const { rows } = await query(
    `SELECT s.*, count(l.id)::int AS recent_leads FROM sellers s
     LEFT JOIN leads l ON l.assigned_seller_id = s.id AND l.created_at > now() - interval '30 days'
       AND l.id IS DISTINCT FROM $2::bigint
     WHERE s.active AND (cardinality(s.areas) = 0 OR $1::text = ANY(s.areas))
     GROUP BY s.id
     ORDER BY count(l.id), s.id
     LIMIT 1`,
    [area, lead.id ?? null],
  );
  return rows[0] ?? null;
}
