// Listing sync against a real Postgres with mocked feeds. Usage: DATABASE_URL=postgres://... node --test test/listings.test.js
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { getPool, query } from "../lib/db.js";
import * as ddf from "../lib/listings/ddf.js";
import * as proptx from "../lib/listings/proptx.js";
import { syncListings, syncSource, purgeSource } from "../lib/listings/sync.js";
import cron from "../api/cron/sync-listings.js";

const realFetch = globalThis.fetch;
let feed = [], requests = [], failProperty = false;

const prop = (key, over = {}) => ({
  ListingKey: key, ListingId: `X${key}`, City: "Toronto", StateOrProvince: "Ontario", ListPrice: 900000,
  ModificationTimestamp: `2026-10-01T00:00:${key.padStart(2, "0")}.00Z`, StandardStatus: "Active",
  UnparsedAddress: `${key} King St W, Toronto, Ontario M5V1A1`, PostalCode: "M5V1A1",
  Latitude: 43.6, Longitude: -79.4, BedroomsTotal: 2, BathroomsTotalInteger: 2, LivingArea: 850, LivingAreaUnits: "square feet",
  PropertySubType: "Single Family", StructureType: ["Apartment"], CommonInterest: "Condo/Strata",
  PublicRemarks: "Nice.", ListOfficeKey: "O1", ListAgentKey: "M1", ListingURL: `www.realtor.ca/real-estate/${key}/x`,
  Media: [
    { MediaURL: `https://ddfcdn.realtor.ca/${key}/2.jpg`, Order: 2, MediaCategory: "Property Photo" },
    { MediaURL: `https://ddfcdn.realtor.ca/${key}/1.jpg`, Order: 1, MediaCategory: "Property Photo", PreferredPhotoYN: true },
  ],
  ...over,
});

// Applies the keyset cursor from $filter the way the OData server would.
function page(url, size) {
  const f = url.searchParams.get("$filter") || "";
  const ge = f.match(/ModificationTimestamp ge (\S+)/);
  const ks = f.match(/ModificationTimestamp gt (\S+) or \(ModificationTimestamp eq \S+ and ListingKey gt '([^']*)'\)/);
  const rows = [...feed].sort((a, b) => a.ModificationTimestamp.localeCompare(b.ModificationTimestamp) || a.ListingKey.localeCompare(b.ListingKey))
    .filter((p) => {
      const t = Date.parse(p.ModificationTimestamp);
      if (ks) return t > Date.parse(ks[1]) || (t === Date.parse(ks[1]) && p.ListingKey > ks[2]);
      if (ge) return t >= Date.parse(ge[1]);
      return true;
    });
  return rows.slice(0, size);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

before(async () => {
  const pool = getPool();
  await pool.query("DROP TABLE IF EXISTS notifications, matches, rate_limits, sync_runs, listings, sellers, leads CASCADE");
  await pool.query(await readFile(new URL("../db/schema.sql", import.meta.url), "utf8"));
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    requests.push({ url, init });
    if (url.href === "https://identity.crea.ca/connect/token") return json({ access_token: "tok", expires_in: 3600, token_type: "Bearer" });
    if (url.pathname.endsWith("/Property")) {
      if (failProperty) return json({ error: { message: "boom" } }, 400);
      return json({ value: page(url, 100) });
    }
    if (url.pathname.endsWith("/Office")) return json({ value: [{ OfficeKey: "O1", OfficeName: "Acme Realty Inc., Brokerage" }] });
    if (url.pathname.endsWith("/Member")) return json({ value: [{ MemberKey: "M1", MemberFirstName: "Jane", MemberLastName: "Doe" }] });
    return json({}, 404);
  };
});
after(async () => {
  globalThis.fetch = realFetch;
  await getPool().end();
});
beforeEach(async () => {
  await query("TRUNCATE listings, sync_runs RESTART IDENTITY CASCADE");
  feed = []; requests = []; failProperty = false;
  process.env.DDF_CLIENT_ID = "id"; process.env.DDF_CLIENT_SECRET = "secret";
  delete process.env.PROPTX_TOKEN;
  ddf.resetToken();
});

test("DDF fields map to a listings row", () => {
  const row = ddf.mapListing(prop("7"), { offices: new Map([["O1", "Acme"]]), members: new Map([["M1", "Jane Doe"]]) });
  assert.equal(row.source, "crea_ddf");
  assert.equal(row.source_key, "7");
  assert.equal(row.mls_number, "X7");
  assert.equal(row.area, "GTA");
  assert.equal(row.transaction_type, "sale");
  assert.equal(row.price, 900000);
  assert.equal(row.property_type, "Condo");
  assert.equal(row.sqft, 850);
  assert.deepEqual(row.photo_urls, ["https://ddfcdn.realtor.ca/7/1.jpg", "https://ddfcdn.realtor.ca/7/2.jpg"]);
  assert.equal(row.listing_url, "https://www.realtor.ca/real-estate/7/x");
  assert.equal(row.office_name, "Acme");
  assert.equal(row.agent_name, "Jane Doe");

  const lease = ddf.mapListing(prop("8", { ListPrice: null, LeaseAmount: 30000, LeaseAmountFrequency: "Annually", City: "Kitchener" }));
  assert.equal(lease.transaction_type, "lease");
  assert.equal(lease.price, 2500);
  assert.equal(lease.area, "Waterloo");
  assert.equal(ddf.mapListing(prop("9", { City: "Ottawa" })), null);
  assert.equal(ddf.mapListing(prop("10", { InternetEntireListingDisplayYN: false })).status, "inactive");
  assert.equal(ddf.mapListing(prop("11", { InternetAddressDisplayYN: false })).address, null);
});

test("PropTx fields map to a listings row", () => {
  const row = proptx.mapListing({
    ListingKey: "W9002096", City: "Mississauga", TransactionType: "For Lease", ListPrice: 3200, ContractStatus: "Available",
    StandardStatus: "Active", PropertyType: "Residential Freehold", PropertySubType: "Att/Row/Townhouse",
    BedroomsAboveGrade: 3, BedroomsBelowGrade: 1, LivingAreaRange: "1500-2000", ListOfficeName: "Acme", ListAgentFullName: "Joe",
    ModificationTimestamp: "2026-10-01T00:00:00Z",
    Media: [{ MediaURL: "https://cdn/s.jpg", Order: 0, ImageSizeDescription: "Thumbnail" }, { MediaURL: "https://cdn/l.jpg", Order: 0, ImageSizeDescription: "Largest" }],
  });
  assert.equal(row.source, "proptx");
  assert.equal(row.mls_number, "W9002096");
  assert.equal(row.transaction_type, "lease");
  assert.equal(row.price, 3200);
  assert.equal(row.property_type, "Townhouse");
  assert.equal(row.bedrooms, 4);
  assert.equal(row.sqft, 1500);
  assert.deepEqual(row.photo_urls, ["https://cdn/l.jpg"]);
  assert.equal(row.status, "active");
  assert.equal(proptx.mapListing({ ListingKey: "A", City: "Toronto", ContractStatus: "Unavailable" }).status, "inactive");
});

test("first sync is a full pass that pages through the feed and upserts", async () => {
  feed = Array.from({ length: 150 }, (_, i) => prop(String(i + 1), { ModificationTimestamp: `2026-10-01T00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.00Z` }));
  feed.push(prop("999", { City: "Ottawa", ModificationTimestamp: "2026-10-02T00:00:00.00Z" }));
  const [r] = await syncListings();
  assert.equal(r.mode, "full");
  assert.equal(r.complete, true);
  assert.equal(r.pages, 2);
  assert.equal(r.fetched, 151);
  assert.equal(r.upserted, 150);
  const token = requests.find((q) => q.url.pathname === "/connect/token");
  assert.match(token.init.body, /grant_type=client_credentials/);
  assert.match(token.init.body, /scope=DDFApi_Read/);
  const first = requests.find((q) => q.url.pathname.endsWith("/Property"));
  assert.match(first.url.searchParams.get("$filter"), /^StateOrProvince eq 'Ontario' and \(City eq 'Toronto' or /);
  assert.equal(first.url.searchParams.get("$top"), "100");
  const second = requests.filter((q) => q.url.pathname.endsWith("/Property"))[1];
  assert.match(second.url.searchParams.get("$filter"), /ListingKey gt '100'/);
  const { rows } = await query("SELECT * FROM listings WHERE source_key = '5'");
  assert.equal(rows[0].office_name, "Acme Realty Inc., Brokerage");
  assert.equal(rows[0].agent_name, "Jane Doe");
  assert.equal(rows[0].photo_urls.length, 2);
  const runs = await query("SELECT source, fetched, upserted, finished_at FROM sync_runs");
  assert.equal(runs.rows[0].source, "crea_ddf:full");
  assert.ok(runs.rows[0].finished_at);
});

test("next sync is incremental from the latest modified_at and updates in place", async () => {
  feed = [prop("1"), prop("2")];
  await syncListings();
  requests = [];
  feed[1] = prop("2", { ListPrice: 850000, ModificationTimestamp: "2026-10-05T00:00:00.00Z" });
  feed.push(prop("3", { ModificationTimestamp: "2026-10-05T00:00:01.00Z" }));
  const [r] = await syncListings();
  assert.equal(r.mode, "incremental");
  const filter = requests.find((q) => q.url.pathname.endsWith("/Property")).url.searchParams.get("$filter");
  assert.match(filter, /ModificationTimestamp ge 2026-10-01T00:00:02.000Z$/);
  assert.equal(r.upserted, 2);
  const { rows } = await query("SELECT source_key, price FROM listings ORDER BY source_key");
  assert.deepEqual(rows.map((x) => [x.source_key, Number(x.price)]), [["1", 900000], ["2", 850000], ["3", 900000]]);
});

test("full sync deactivates listings that left the feed; empty feed deactivates nothing", async () => {
  feed = [prop("1"), prop("2"), prop("3")];
  await syncListings();
  feed = [prop("1"), prop("3")];
  const [r] = await syncListings({ full: true });
  assert.equal(r.mode, "full");
  assert.equal(r.deactivated, 1);
  const { rows } = await query("SELECT source_key, status FROM listings ORDER BY source_key");
  assert.deepEqual(rows.map((x) => x.status), ["active", "inactive", "active"]);

  feed = [];
  const [r2] = await syncListings({ full: true });
  assert.equal(r2.deactivated, 0);
});

test("a full pass that runs out of budget resumes on the next run", async () => {
  feed = Array.from({ length: 250 }, (_, i) => prop(String(1000 + i), { ModificationTimestamp: `2026-10-01T01:00:00.00Z` }));
  feed[0] = prop("1000", { ModificationTimestamp: "2026-09-01T00:00:00.00Z" });
  const first = await syncSource(ddf, { maxPages: 1 });
  assert.deepEqual([first.mode, first.complete, first.upserted], ["full", false, 100]);
  assert.equal((await query("SELECT finished_at FROM sync_runs")).rows[0].finished_at, null);
  const second = await syncSource(ddf, { maxPages: 5 });
  assert.equal(second.mode, "full");
  assert.equal(second.complete, true);
  assert.equal((await query("SELECT count(*)::int AS n FROM listings")).rows[0].n, 250);
  const runs = await query("SELECT fetched, finished_at FROM sync_runs");
  assert.equal(runs.rows.length, 1);
  assert.ok(runs.rows[0].finished_at);
});

test("feed errors are recorded on the run", async () => {
  failProperty = true;
  const [r] = await syncListings();
  assert.match(r.error, /DDF 400/);
  const { rows } = await query("SELECT error, finished_at FROM sync_runs");
  assert.match(rows[0].error, /boom/);
  assert.equal(rows[0].finished_at, null); // the full pass stays open and resumes next run
});

test("PropTx is skipped without a token and used with one", async () => {
  delete process.env.DDF_CLIENT_ID;
  const results = await syncListings();
  assert.deepEqual(results.map((r) => r.skipped), ["not configured", "not configured"]);
  assert.equal(requests.length, 0);

  process.env.PROPTX_TOKEN = "ptx";
  feed = [{ ListingKey: "C1", City: "Toronto", ListPrice: 1, TransactionType: "For Sale", ContractStatus: "Available", ModificationTimestamp: "2026-10-01T00:00:00Z" }];
  const [, r] = await syncListings();
  assert.equal(r.upserted, 1);
  const q = requests.find((x) => x.url.host === "query.ampre.ca");
  assert.equal(q.init.headers.Authorization, "Bearer ptx");
  assert.match(q.url.searchParams.get("$filter"), /ContractStatus eq 'Available'/);
  assert.equal((await query("SELECT source FROM listings")).rows[0].source, "proptx");
});

test("purgeSource deletes a source's listings", async () => {
  feed = [prop("1")];
  await syncListings();
  assert.equal(await purgeSource("crea_ddf"), 1);
  assert.equal((await query("SELECT count(*)::int AS n FROM listings")).rows[0].n, 0);
});

function call(handler, { method = "GET", headers = {}, query: q = {} } = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200, headers: {},
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      end(data) { resolve({ status: this.statusCode, body: data ? JSON.parse(data) : null }); },
    };
    handler({ method, headers, query: q, url: "/api/cron/sync-listings" }, res);
  });
}

test("cron endpoint needs CRON_SECRET", async () => {
  delete process.env.CRON_SECRET;
  assert.equal((await call(cron, { headers: { authorization: "Bearer " } })).status, 401);
  process.env.CRON_SECRET = "cron-secret";
  assert.equal((await call(cron)).status, 401);
  assert.equal((await call(cron, { headers: { authorization: "Bearer wrong" } })).status, 401);
  feed = [prop("1")];
  const r = await call(cron, { headers: { authorization: "Bearer cron-secret" }, query: { full: "1" } });
  assert.equal(r.status, 200);
  assert.equal(r.body.results[0].mode, "full");
  assert.equal(r.body.results[0].upserted, 1);
  assert.equal(r.body.results[1].skipped, "not configured");
});
