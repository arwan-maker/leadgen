// CREA DDF Web API client (https://ddfapi-docs.realtor.ca/). OAuth2 client credentials, OData v4.
import { address, areaFor, cityFilter, cityName, cursorFilter, getJson, int, isActiveStatus, num,
  odataString, photoUrls, propertyType, queryString, sqft, text } from "./common.js";

export const source = "crea_ddf";
export const pageSize = 100; // DDF's $top maximum

const TOKEN_URL = "https://identity.crea.ca/connect/token";
const baseUrl = () => process.env.DDF_API_URL || "https://ddfapi.realtor.ca/odata/v1";
let token = null;

export function enabled() {
  return Boolean(process.env.DDF_CLIENT_ID && process.env.DDF_CLIENT_SECRET);
}

export function resetToken() {
  token = null;
}

async function accessToken() {
  if (token && token.expires > Date.now() + 60_000) return token.value;
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials", scope: "DDFApi_Read",
      client_id: process.env.DDF_CLIENT_ID, client_secret: process.env.DDF_CLIENT_SECRET,
    }).toString(),
  });
  if (!r.ok) throw new Error(`DDF token ${r.status}: ${(await r.text().catch(() => "")).slice(0, 300)}`);
  const j = await r.json();
  token = { value: j.access_token, expires: Date.now() + (j.expires_in || 3600) * 1000 };
  return token.value;
}

async function get(path, params) {
  const headers = { Authorization: `Bearer ${await accessToken()}` };
  return getJson(`${baseUrl()}/${path}?${queryString(params)}`, headers, "DDF");
}

// One page of Ontario listings in our cities, oldest change first, after `cursor`.
export async function fetchPage({ cursor } = {}) {
  const filter = ["StateOrProvince eq 'Ontario'", cityFilter(), cursorFilter(cursor)].filter(Boolean).join(" and ");
  const j = await get("Property", { $filter: filter, $orderby: "ModificationTimestamp asc,ListingKey asc", $top: pageSize });
  return j.value || [];
}

// Office and agent names are separate resources in DDF; look them up by key.
async function names(resource, keyField, select, keys, format) {
  const out = new Map();
  const unique = [...new Set(keys.filter(Boolean))];
  for (let i = 0; i < unique.length; i += 50) {
    const chunk = unique.slice(i, i + 50);
    const j = await get(resource, {
      $filter: `${keyField} in (${chunk.map(odataString).join(",")})`, $select: select, $top: chunk.length,
    });
    for (const row of j.value || []) out.set(String(row[keyField]), format(row));
  }
  return out;
}

export async function mapPage(items) {
  let offices = new Map(), members = new Map();
  try {
    offices = await names("Office", "OfficeKey", "OfficeKey,OfficeName", items.map((p) => p.ListOfficeKey), (o) => text(o.OfficeName));
    members = await names("Member", "MemberKey", "MemberKey,MemberFirstName,MemberLastName", items.map((p) => p.ListAgentKey),
      (m) => text([m.MemberFirstName, m.MemberLastName].filter(Boolean).join(" ")));
  } catch (err) {
    console.error("DDF office/agent lookup failed", err.message); // names are kept from the previous sync
  }
  return items.map((p) => mapListing(p, { offices, members })).filter(Boolean);
}

function monthly(amount, frequency) {
  const f = String(frequency || "").toLowerCase();
  if (/annual|year/.test(f)) return amount / 12;
  if (/week/.test(f)) return (amount * 52) / 12;
  if (/dai/.test(f)) return (amount * 365) / 12;
  return amount;
}

function realtorUrl(url) {
  const u = text(url);
  if (!u) return null;
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith("/")) return `https://www.realtor.ca${u}`;
  return `https://${u}`;
}

// Maps a DDF Property to a listings row, or null when it's outside our service areas.
export function mapListing(p, { offices = new Map(), members = new Map() } = {}) {
  const area = areaFor(p?.City);
  if (!p?.ListingKey || !area) return null;
  const listPrice = num(p.ListPrice), lease = num(p.LeaseAmount);
  const isLease = !(listPrice > 0) && lease > 0;
  return {
    source, source_key: String(p.ListingKey), mls_number: text(p.ListingId),
    status: isActiveStatus(p.StandardStatus) && p.InternetEntireListingDisplayYN !== false ? "active" : "inactive",
    transaction_type: isLease ? "lease" : "sale",
    property_type: propertyType(p.PropertySubType, p.StructureType, p.CommonInterest),
    address: address(p), city: cityName(p.City), area, postal_code: text(p.PostalCode),
    latitude: num(p.Latitude), longitude: num(p.Longitude),
    price: isLease ? Math.round(monthly(lease, p.LeaseAmountFrequency) * 100) / 100 : listPrice,
    bedrooms: int(p.BedroomsTotal), bathrooms: int(p.BathroomsTotalInteger),
    sqft: sqft(p.LivingArea, p.LivingAreaUnits) ?? sqft(p.BuildingAreaTotal, p.BuildingAreaUnits),
    description: text(p.PublicRemarks),
    photo_urls: photoUrls(p.Media), // CREA's watermarked URLs, kept as given
    listing_url: realtorUrl(p.ListingURL),
    office_name: offices.get(String(p.ListOfficeKey)) ?? null,
    agent_name: members.get(String(p.ListAgentKey)) ?? null,
    modified_at: p.ModificationTimestamp || null,
    raw: p,
  };
}
