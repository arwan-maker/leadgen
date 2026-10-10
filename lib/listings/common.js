// Helpers shared by the listing feed clients (CREA DDF, PropTx). Both speak RESO / OData.
import { areaForCity, allCities } from "../areas.js";

export function num(v) {
  const n = typeof v === "string" ? Number(v.replace(/[$,\s]/g, "")) : Number(v);
  return v === null || v === undefined || v === "" || !Number.isFinite(n) ? null : n;
}

export function int(v) {
  const n = num(v);
  return n === null ? null : Math.round(n);
}

export function text(v) {
  if (Array.isArray(v)) v = v.filter(Boolean).join(", ");
  const s = String(v ?? "").trim();
  return s || null;
}

// "Toronto (Waterfront Communities)", "Toronto C08", "KITCHENER" -> "Toronto", "Toronto", "Kitchener".
function baseCity(city) {
  return text(city)?.replace(/\s*\(.*\)\s*$/, "").replace(/\s+[A-Z]\d{2}$/i, "") ?? null;
}

export function areaFor(city) {
  return areaForCity(city) ?? areaForCity(baseCity(city));
}

// The city spelled as in lib/areas.js when it is one of ours.
export function cityName(city) {
  const base = baseCity(city)?.toLowerCase();
  return allCities().find((c) => c.toLowerCase() === base) ?? text(city);
}

// Maps feed type fields to 'House' | 'Condo' | 'Townhouse' | 'Land' | 'Commercial'.
export function propertyType(...fields) {
  const t = fields.flat().filter(Boolean).join(" ").toLowerCase();
  if (!t) return null;
  if (/commercial|business|industrial|office|retail|farm|agricultur/.test(t)) return "Commercial";
  if (/\bland\b/.test(t)) return "Land";
  if (/town|\brow\b/.test(t)) return "Townhouse";
  if (/condo|apartment|strata|co-op|coop/.test(t)) return "Condo";
  if (/house|detached|single family|duplex|triplex|bungalow|link|cottage|freehold|residential/.test(t)) return "House";
  return null;
}

export function isActiveStatus(status) {
  return !status || !/closed|sold|leased|expired|withdrawn|cancel|terminat|suspend|delete/i.test(status);
}

export function sqft(area, units) {
  const n = num(area);
  if (n === null || n <= 0) return null;
  return /met/i.test(units || "") ? Math.round(n * 10.7639) : Math.round(n);
}

export function address(p) {
  if (p.InternetAddressDisplayYN === false) return null;
  if (text(p.UnparsedAddress)) return text(p.UnparsedAddress);
  const street = [p.StreetNumber, p.StreetDirPrefix, p.StreetName, p.StreetSuffix, p.StreetDirSuffix].filter(Boolean).join(" ");
  return text(p.UnitNumber && street ? `${p.UnitNumber} - ${street}` : street);
}

// Photo URLs in display order. `prefer` picks a subset (e.g. the largest size) when the feed has several.
export function photoUrls(media, prefer) {
  const items = (media || []).filter((m) => m?.MediaURL && (!m.MediaCategory || /photo/i.test(m.MediaCategory)));
  const preferred = prefer ? items.filter(prefer) : [];
  const list = (preferred.length ? preferred : items)
    .sort((a, b) => (b.PreferredPhotoYN === true) - (a.PreferredPhotoYN === true) || (a.Order ?? 0) - (b.Order ?? 0));
  return [...new Set(list.map((m) => m.MediaURL))];
}

export const odataString = (s) => `'${String(s).replace(/'/g, "''")}'`;

// Keyset paging on (ModificationTimestamp, ListingKey). A cursor without key resumes from a timestamp.
export function cursorFilter(cursor) {
  if (!cursor?.ts) return null;
  if (!cursor.key) return `ModificationTimestamp ge ${cursor.ts}`;
  return `(ModificationTimestamp gt ${cursor.ts} or (ModificationTimestamp eq ${cursor.ts} and ListingKey gt ${odataString(cursor.key)}))`;
}

export function cityFilter() {
  return `(${allCities().map((c) => `City eq ${odataString(c)}`).join(" or ")})`;
}

export function queryString(params) {
  return Object.entries(params).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
}

export async function getJson(url, headers, label) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, { headers: { Accept: "application/json", ...headers } });
    if (r.ok) return r.json();
    if (attempt < 2 && (r.status === 429 || r.status >= 500)) {
      await new Promise((ok) => setTimeout(ok, 1000 * (attempt + 1)));
      continue;
    }
    const body = await r.text().catch(() => "");
    throw new Error(`${label} ${r.status}: ${body.slice(0, 300)}`);
  }
}
