// PropTx (TRREB) RESO Web API client (https://developer.ampre.us/docs). Bearer token from PROPTX_TOKEN.
import { address, areaFor, cityFilter, cityName, cursorFilter, getJson, int, isActiveStatus, num,
  photoUrls, propertyType, queryString, sqft, text } from "./common.js";

export const source = "proptx";
export const pageSize = 100;

const baseUrl = () => process.env.PROPTX_API_URL || "https://query.ampre.ca/odata";

export function enabled() {
  return Boolean(process.env.PROPTX_TOKEN);
}

// One page of listings in our cities, oldest change first, after `cursor`. Full passes list only available ones.
export async function fetchPage({ cursor, full } = {}) {
  const filter = [cityFilter(), full ? "ContractStatus eq 'Available'" : null, cursorFilter(cursor)].filter(Boolean).join(" and ");
  const j = await getJson(`${baseUrl()}/Property?${queryString({
    $filter: filter, $orderby: "ModificationTimestamp,ListingKey", $top: pageSize,
    $expand: "Media($filter=MediaType eq 'image/jpeg')",
  })}`, { Authorization: `Bearer ${process.env.PROPTX_TOKEN}` }, "PropTx");
  return j.value || [];
}

export async function mapPage(items) {
  return items.map(mapListing).filter(Boolean);
}

function rangeLow(v) {
  const m = String(v ?? "").match(/\d[\d,]*/);
  return m ? int(m[0]) : null;
}

// Maps a PropTx Property to a listings row, or null when it's outside our service areas.
export function mapListing(p) {
  const area = areaFor(p?.City);
  if (!p?.ListingKey || !area) return null;
  const available = isActiveStatus(p.StandardStatus) && (!p.ContractStatus || p.ContractStatus === "Available");
  return {
    source, source_key: String(p.ListingKey), mls_number: text(p.ListingId) ?? String(p.ListingKey),
    status: available && p.InternetEntireListingDisplayYN !== false ? "active" : "inactive",
    transaction_type: /lease|rent/i.test(p.TransactionType || "") ? "lease" : "sale",
    property_type: propertyType(p.PropertySubType, p.PropertyType),
    address: address(p), city: cityName(p.City), area, postal_code: text(p.PostalCode),
    latitude: num(p.Latitude), longitude: num(p.Longitude),
    price: num(p.ListPrice), // TRREB lease listings carry the monthly rent here
    bedrooms: int(p.BedroomsTotal) ?? (p.BedroomsAboveGrade != null ? (int(p.BedroomsAboveGrade) || 0) + (int(p.BedroomsBelowGrade) || 0) : null),
    bathrooms: int(p.BathroomsTotalInteger),
    sqft: sqft(p.LivingArea, p.LivingAreaUnits) ?? sqft(p.BuildingAreaTotal, p.BuildingAreaUnits) ?? rangeLow(p.LivingAreaRange),
    description: text(p.PublicRemarks),
    photo_urls: photoUrls(p.Media, (m) => m.ImageSizeDescription === "Largest"),
    listing_url: null,
    office_name: text(p.ListOfficeName), agent_name: text(p.ListAgentFullName),
    modified_at: p.ModificationTimestamp || null,
    raw: p,
  };
}
