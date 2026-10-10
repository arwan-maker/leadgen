// Listing search API. Runs against a real Postgres (drops all tables first, so use a test database):
//   DATABASE_URL=postgres://... node --test test/search.test.js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { getPool } from "../lib/db.js";
import listings from "../api/listings.js";
import config from "../api/config.js";
import { seedListings } from "../scripts/seed-listings.js";

function call(qs = "", { method = "GET", query, handler = listings } = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200, headers: {},
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      end(data) { resolve({ status: this.statusCode, headers: this.headers, body: data ? JSON.parse(data) : null }); },
    };
    const req = { method, headers: {}, url: `/api/listings${qs ? "?" + qs : ""}` };
    if (query) req.query = query;
    handler(req, res);
  });
}

const fixtures = [
  // source_key, mls, status, type, property_type, city, area, price, beds, baths, modified (hours ago)
  ["A1", "W1000001", "active", "sale", "House", "Toronto", "GTA", 1200000, 4, 3, 1],
  ["A2", "W1000002", "active", "sale", "Condo", "Toronto", "GTA", 650000, 2, 2, 2],
  ["A3", "W1000003", "active", "lease", "Condo", "Mississauga", "GTA", 2500, 1, 1, 3],
  ["A4", "X2000001", "active", "sale", "House", "Kitchener", "Waterloo", 800000, 3, 2, 4],
  ["A5", "X2000002", "active", "sale", "Townhouse", "Waterloo", "Waterloo", 700000, 3, 3, 5],
  ["A6", "X3000001", "active", "sale", "House", "Cambridge", "Cambridge", 900000, 4, 2, 6],
  ["A7", "X3000002", "inactive", "sale", "House", "Cambridge", "Cambridge", 500000, 3, 1, 0],
];
const ids = {};

before(async () => {
  const pool = getPool();
  await pool.query("DROP TABLE IF EXISTS notifications, matches, rate_limits, sync_runs, listings, sellers, leads CASCADE");
  await pool.query(await readFile(new URL("../db/schema.sql", import.meta.url), "utf8"));
  for (const [key, mls, status, type, ptype, city, area, price, beds, baths, hours] of fixtures) {
    const { rows } = await pool.query(
      `INSERT INTO listings (source, source_key, mls_number, status, transaction_type, property_type, address, city, area,
         price, bedrooms, bathrooms, description, photo_urls, listing_url, office_name, modified_at, raw)
       VALUES ('crea_ddf',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'Nice home','["https://example.com/a.jpg"]',
         'https://www.realtor.ca/real-estate/1','Test Brokerage', now() - make_interval(hours => $12), '{"secret":1}') RETURNING id`,
      [key, mls, status, type, ptype, `${key} Fake St`, city, area, price, beds, baths, hours]);
    ids[key] = rows[0].id;
  }
});
after(() => getPool().end());

const keys = (r) => r.body.results.map((l) => l.source_key);

test("lists active listings only, newest first, with public fields and cache header", async () => {
  const r = await call();
  assert.equal(r.status, 200);
  assert.equal(r.body.total, 6);
  assert.deepEqual(keys(r), ["A1", "A2", "A3", "A4", "A5", "A6"]);
  assert.equal(r.headers["cache-control"], "s-maxage=300, stale-while-revalidate=600");
  assert.equal(r.headers["access-control-allow-origin"], "*");
  const l = r.body.results[0];
  assert.equal(l.raw, undefined);
  assert.equal(l.status, undefined);
  assert.equal(l.price, 1200000);
  assert.deepEqual(l.photo_urls, ["https://example.com/a.jpg"]);
  assert.equal(l.office_name, "Test Brokerage");
});

test("filters by area, city, type, property type, price, beds and baths", async () => {
  assert.deepEqual(keys(await call("area=Waterloo")), ["A4", "A5"]);
  assert.deepEqual(keys(await call("area=cambridge")), ["A6"]);
  assert.deepEqual(keys(await call("city=toronto")), ["A1", "A2"]);
  assert.deepEqual(keys(await call("type=lease")), ["A3"]);
  assert.deepEqual(keys(await call("property_type=condo")), ["A2", "A3"]);
  assert.deepEqual(keys(await call("min_price=700000&max_price=900000")), ["A4", "A5", "A6"]);
  assert.deepEqual(keys(await call("beds=4")), ["A1", "A6"]);
  assert.deepEqual(keys(await call("baths=3")), ["A1", "A5"]);
  assert.deepEqual(keys(await call("area=GTA&type=sale&beds=3")), ["A1"]);
});

test("free text matches city, address, MLS number and area", async () => {
  assert.deepEqual(keys(await call("q=kitchener")), ["A4"]);
  assert.deepEqual(keys(await call("q=A5%20Fake")), ["A5"]);
  assert.deepEqual(keys(await call("q=X300")), ["A6"]); // A7 shares the prefix but is inactive
  assert.deepEqual(keys(await call("q=waterloo")), ["A4", "A5"]);
  assert.equal((await call("q=%25")).body.total, 0); // LIKE wildcards are literal
  assert.equal((await call("q=%27%3B%20DROP%20TABLE%20listings%3B--")).body.total, 0);
});

test("sorts by price both ways", async () => {
  assert.deepEqual(keys(await call("sort=price_asc&type=sale")), ["A2", "A5", "A4", "A6", "A1"]);
  assert.deepEqual(keys(await call("sort=price_desc&type=sale")), ["A1", "A6", "A4", "A5", "A2"]);
});

test("pages results and caps page_size", async () => {
  const p1 = await call("page_size=4");
  assert.deepEqual([p1.body.total, p1.body.page, p1.body.page_size], [6, 1, 4]);
  assert.deepEqual(keys(p1), ["A1", "A2", "A3", "A4"]);
  const p2 = await call("page_size=4&page=2");
  assert.deepEqual(keys(p2), ["A5", "A6"]);
  const p3 = await call("page_size=4&page=9");
  assert.deepEqual([p3.body.total, p3.body.results.length], [6, 0]);
  assert.equal((await call("page_size=500")).body.page_size, 48);
});

test("reads params from req.query like Vercel", async () => {
  const r = await call("", { query: { area: "GTA", sort: "price_asc" } });
  assert.deepEqual(keys(r), ["A3", "A2", "A1"]);
});

test("rejects bad params", async () => {
  for (const qs of ["area=Ottawa", "type=rent", "sort=random", "min_price=abc", "beds=-1", "beds=2.5", "page=0", "page_size=x", "id=abc", "id=1;2"]) {
    const r = await call(qs);
    assert.equal(r.status, 400, qs);
    assert.equal(r.body.error, "validation");
  }
  assert.equal((await call("", { method: "POST" })).status, 405);
  assert.equal((await call("", { method: "OPTIONS" })).status, 204);
});

test("returns one listing by id with description, 404 if inactive or missing", async () => {
  const r = await call(`id=${ids.A4}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.source_key, "A4");
  assert.equal(r.body.description, "Nice home");
  assert.equal(r.body.listing_url, "https://www.realtor.ca/real-estate/1");
  assert.equal(r.body.raw, undefined);
  assert.equal((await call(`id=${ids.A7}`)).status, 404);
  assert.equal((await call("id=999999")).status, 404);
});

test("demo seed loads about 30 listings across all three areas and is re-runnable", async () => {
  await seedListings();
  assert.equal(await seedListings(), 30);
  const { rows } = await getPool().query("SELECT area, count(*)::int AS n FROM listings WHERE source = 'demo' GROUP BY area ORDER BY area");
  assert.deepEqual(rows.map((r) => r.area), ["Cambridge", "GTA", "Waterloo"]);
  assert.equal(rows.reduce((s, r) => s + r.n, 0), 30);
  assert.equal((await call("q=demo&page_size=48")).body.total, 30);
});

test("config exposes the CREA DestinationID or null", async () => {
  delete process.env.CREA_DESTINATION_ID;
  assert.deepEqual((await call("", { handler: config })).body, { creaDestinationId: null });
  process.env.CREA_DESTINATION_ID = "dest-42";
  assert.deepEqual((await call("", { handler: config })).body, { creaDestinationId: "dest-42" });
  delete process.env.CREA_DESTINATION_ID;
  assert.equal((await call("", { handler: config, method: "POST" })).status, 405);
});
