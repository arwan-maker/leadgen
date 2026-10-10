// Demo listings for local testing only (source = 'demo', fake addresses). Usage:
//   DATABASE_URL=postgres://... node scripts/seed-listings.js
// Re-running replaces the demo rows; real feed rows are untouched.
import { pathToFileURL } from "node:url";
import { getPool } from "../lib/db.js";

const PHOTO_COLORS = ["#93c5fd", "#86efac", "#fcd34d", "#f9a8d4", "#c4b5fd", "#fdba74"];
function photo(i, label) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420"><rect width="640" height="420" fill="${PHOTO_COLORS[i % PHOTO_COLORS.length]}"/>` +
    `<path d="M200 260 L320 160 L440 260 V340 H200 Z" fill="#fff" opacity=".8"/><rect x="295" y="280" width="50" height="60" fill="#475569" opacity=".6"/>` +
    `<text x="320" y="390" font-family="sans-serif" font-size="22" text-anchor="middle" fill="#1e293b">${label}</text></svg>`;
  return "data:image/svg+xml," + encodeURIComponent(svg);
}

// [city, area, street, type, property_type, price, beds, baths, sqft]
const ROWS = [
  ["Toronto", "GTA", "Sample Ave", "sale", "Condo", 689000, 2, 2, 850],
  ["Toronto", "GTA", "Demo Street", "lease", "Condo", 2650, 1, 1, 600],
  ["Toronto", "GTA", "Placeholder Cres", "sale", "House", 1495000, 4, 3, 2200],
  ["North York", "GTA", "Example Blvd", "sale", "Townhouse", 979000, 3, 3, 1600],
  ["Scarborough", "GTA", "Test Lane", "sale", "House", 1129000, 4, 2, 1900],
  ["Etobicoke", "GTA", "Mock Road", "lease", "Townhouse", 3400, 3, 2, 1400],
  ["Mississauga", "GTA", "Fictional Dr", "sale", "Condo", 549000, 1, 1, 640],
  ["Mississauga", "GTA", "Pretend Way", "sale", "House", 1349000, 5, 4, 2800],
  ["Brampton", "GTA", "Sample Ave", "sale", "House", 999000, 4, 3, 2100],
  ["Brampton", "GTA", "Imaginary Ct", "lease", "House", 3100, 3, 2, 1500],
  ["Markham", "GTA", "Demo Street", "sale", "Townhouse", 1089000, 3, 3, 1750],
  ["Vaughan", "GTA", "Example Blvd", "sale", "House", 1689000, 5, 4, 3200],
  ["Richmond Hill", "GTA", "Placeholder Cres", "lease", "Condo", 2400, 2, 1, 780],
  ["Oakville", "GTA", "Test Lane", "sale", "House", 1899000, 4, 4, 3000],
  ["Pickering", "GTA", "Mock Road", "sale", "Townhouse", 829000, 3, 2, 1500],
  ["Oshawa", "GTA", "Fictional Dr", "sale", "House", 749000, 3, 2, 1450],
  ["Waterloo", "Waterloo", "Sample Ave", "sale", "Condo", 459000, 2, 1, 820],
  ["Waterloo", "Waterloo", "Demo Street", "lease", "Condo", 2100, 1, 1, 560],
  ["Waterloo", "Waterloo", "Example Blvd", "sale", "House", 899000, 4, 3, 2000],
  ["Kitchener", "Waterloo", "Pretend Way", "sale", "House", 779000, 3, 2, 1650],
  ["Kitchener", "Waterloo", "Imaginary Ct", "sale", "Townhouse", 629000, 3, 3, 1450],
  ["Kitchener", "Waterloo", "Test Lane", "lease", "House", 2750, 3, 2, 1400],
  ["Elmira", "Waterloo", "Mock Road", "sale", "House", 849000, 4, 2, 1900],
  ["New Hamburg", "Waterloo", "Placeholder Cres", "sale", "Land", 399000, null, null, null],
  ["Cambridge", "Cambridge", "Sample Ave", "sale", "House", 829000, 4, 3, 1950],
  ["Cambridge", "Cambridge", "Demo Street", "sale", "Townhouse", 649000, 3, 3, 1500],
  ["Cambridge", "Cambridge", "Fictional Dr", "lease", "Townhouse", 2600, 3, 2, 1350],
  ["Cambridge", "Cambridge", "Example Blvd", "sale", "Condo", 479000, 2, 2, 900],
  ["Cambridge", "Cambridge", "Pretend Way", "sale", "Commercial", 1250000, null, 2, 4000],
  ["Cambridge", "Cambridge", "Imaginary Ct", "lease", "Condo", 1995, 1, 1, 620],
];

export function demoListings() {
  const now = Date.now();
  return ROWS.map(([city, area, street, type, propertyType, price, beds, baths, sqft], i) => ({
    source: "demo",
    source_key: `DEMO-${String(i + 1).padStart(3, "0")}`,
    mls_number: `X${9000001 + i}`,
    status: "active",
    transaction_type: type,
    property_type: propertyType,
    address: `${100 + i * 7} ${street} (demo)`,
    city, area,
    price, bedrooms: beds, bathrooms: baths, sqft,
    description: `DEMO LISTING, NOT A REAL PROPERTY. A ${beds ? beds + "-bedroom " : ""}${propertyType.toLowerCase()} ` +
      `for ${type === "lease" ? "lease" : "sale"} in ${city}. Bright rooms, updated kitchen, close to parks, schools and transit. ` +
      `Shown for testing the LeadGEN search page only.`,
    photo_urls: [photo(i, `${propertyType} in ${city}`), photo(i + 2, "Kitchen (demo)"), photo(i + 4, "Backyard (demo)")],
    office_name: "Demo Realty Brokerage",
    agent_name: "Demo Agent",
    modified_at: new Date(now - i * 3600_000).toISOString(),
  }));
}

export async function seedListings(pool = getPool()) {
  await pool.query("DELETE FROM listings WHERE source = 'demo'");
  for (const l of demoListings()) {
    await pool.query(
      `INSERT INTO listings (source, source_key, mls_number, status, transaction_type, property_type, address, city, area,
         price, bedrooms, bathrooms, sqft, description, photo_urls, office_name, agent_name, modified_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [l.source, l.source_key, l.mls_number, l.status, l.transaction_type, l.property_type, l.address, l.city, l.area,
        l.price, l.bedrooms, l.bathrooms, l.sqft, l.description, JSON.stringify(l.photo_urls), l.office_name, l.agent_name, l.modified_at]);
  }
  return ROWS.length;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const n = await seedListings();
  console.log(`Seeded ${n} demo listings.`);
  await getPool().end();
}
