// Admin API and rate limiting. Runs against a real Postgres (drops and recreates all tables).
// Usage: DATABASE_URL=postgres://... node --test test/admin.test.js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { getPool } from "../lib/db.js";
import adminLeads, { csvField } from "../api/admin/leads.js";
import adminSellers from "../api/admin/sellers.js";
import adminStats from "../api/admin/stats.js";
import { rateLimit, clientIp, cleanupRateLimits, allowLeadSubmission } from "../lib/ratelimit.js";

process.env.ADMIN_TOKEN = "admin-secret";
const AUTH = { authorization: "Bearer admin-secret" };

function call(handler, { method = "GET", query = {}, body, headers = AUTH } = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200, headers: {},
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      end(data) {
        const json = String(this.headers["content-type"] || "").includes("json");
        resolve({ status: this.statusCode, headers: this.headers, body: data && json ? JSON.parse(data) : data ?? null });
      },
    };
    handler({ method, query, body, headers }, res);
  });
}

const db = (sql, params) => getPool().query(sql, params);
let ids = {};

before(async () => {
  await db("DROP TABLE IF EXISTS leads, sellers, listings, sync_runs, matches, notifications, rate_limits CASCADE");
  await db(await readFile(new URL("../db/schema.sql", import.meta.url), "utf8"));
  const seller = await db("INSERT INTO sellers (name, email, phone, areas) VALUES ('Ana Realtor', 'ana@example.com', '+14165550100', '{GTA}') RETURNING id");
  ids.seller = seller.rows[0].id;
  const ins = (cols) => db(
    `INSERT INTO leads (name, email, phone, source, area, status, is_test, created_at, assigned_seller_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`, cols).then((r) => r.rows[0].id);
  ids.priya = await ins(["Priya Shah", "priya@example.com", "+1 (416) 555-0199", "google_ads", "GTA", "new", false, new Date(), ids.seller]);
  ids.sam = await ins(["Sam \"The Man\", Jr.", "sam@example.com", null, "website", "Waterloo", "contacted", false, "2026-01-15T12:00:00Z", null]);
  ids.evil = await ins(["=HYPERLINK(\"http://x\")", "evil@example.com", null, "website", "Cambridge", "new", false, new Date(Date.now() - 40 * 864e5), null]);
  ids.test = await ins(["Test Lead", "t@example.com", null, "google_ads", null, "new", true, new Date(), null]);
  const listing = await db(`INSERT INTO listings (source, source_key, address, city, area, price, listing_url)
                            VALUES ('crea_ddf', 'K1', '1 Main St', 'Toronto', 'GTA', 899000, 'https://www.realtor.ca/x') RETURNING id`);
  await db("INSERT INTO listings (source, source_key, area, status) VALUES ('crea_ddf', 'K2', 'Waterloo', 'inactive')");
  await db("INSERT INTO matches (lead_id, listing_id, score) VALUES ($1, $2, 88)", [ids.priya, listing.rows[0].id]);
  await db("INSERT INTO notifications (lead_id, seller_id, channel, status, created_at) VALUES ($1, $2, 'email', 'sent', now() - interval '1 hour'), ($1, $2, 'sms', 'failed', now())", [ids.priya, ids.seller]);
  await db("INSERT INTO sync_runs (source, started_at, finished_at, fetched) VALUES ('crea_ddf', now() - interval '2 hours', now() - interval '2 hours', 5), ('crea_ddf', now(), now(), 9)");
});
after(() => getPool().end());

test("every admin endpoint needs the admin token", async () => {
  for (const h of [adminLeads, adminSellers, adminStats]) {
    for (const method of ["GET", "POST", "PATCH"]) {
      assert.equal((await call(h, { method, headers: {} })).status, 401);
      assert.equal((await call(h, { method, headers: { authorization: "Bearer wrong" } })).status, 401);
    }
  }
  assert.equal((await call(adminLeads, { query: { format: "csv" }, headers: {} })).status, 401);
  assert.equal((await call(adminLeads, { query: { id: String(ids.priya) }, headers: {} })).status, 401);
});

test("lead list includes seller, match count, last notification; hides test leads by default", async () => {
  const r = await call(adminLeads);
  assert.equal(r.status, 200);
  assert.equal(r.body.total, 3);
  const priya = r.body.leads.find((l) => l.id === String(ids.priya));
  assert.equal(priya.seller_name, "Ana Realtor");
  assert.equal(priya.match_count, 1);
  assert.equal(priya.last_notification_status, "failed");
  assert.equal((await call(adminLeads, { query: { include_test: "1" } })).body.total, 4);
});

test("lead list filters and paging", async () => {
  const names = async (query) => (await call(adminLeads, { query })).body.leads.map((l) => l.email).sort();
  assert.deepEqual(await names({ status: "contacted" }), ["sam@example.com"]);
  assert.deepEqual(await names({ source: "google_ads" }), ["priya@example.com"]);
  assert.deepEqual(await names({ area: "Cambridge" }), ["evil@example.com"]);
  assert.deepEqual(await names({ q: "PRIYA" }), ["priya@example.com"]);
  assert.deepEqual(await names({ q: "4165550199" }), ["priya@example.com"]);
  assert.deepEqual(await names({ q: "100%" }), []);
  assert.deepEqual(await names({ from: "2026-01-01", to: "2026-01-31" }), ["sam@example.com"]);
  const page = await call(adminLeads, { query: { per_page: "2", page: "2" } });
  assert.equal(page.body.leads.length, 1);
  assert.equal(page.body.total, 3);
  const bad = await call(adminLeads, { query: { status: "bogus", area: "Mars", from: "yesterday" } });
  assert.equal(bad.status, 422);
  assert.deepEqual(Object.keys(bad.body.fields).sort(), ["area", "from", "status"]);
});

test("lead detail has matches with listing fields and notifications", async () => {
  const r = await call(adminLeads, { query: { id: String(ids.priya) } });
  assert.equal(r.status, 200);
  assert.equal(r.body.matches[0].address, "1 Main St");
  assert.equal(r.body.matches[0].listing_url, "https://www.realtor.ca/x");
  assert.equal(Number(r.body.matches[0].price), 899000);
  assert.deepEqual(r.body.notifications.map((n) => n.status), ["failed", "sent"]);
  assert.equal((await call(adminLeads, { query: { id: "999999" } })).status, 404);
  assert.equal((await call(adminLeads, { query: { id: "1; drop table leads" } })).status, 400);
});

test("PATCH updates status, notes, seller and updated_at; rejects bad input", async () => {
  const id = String(ids.sam);
  const old = (await db("SELECT updated_at FROM leads WHERE id = $1", [id])).rows[0].updated_at;
  const r = await call(adminLeads, { method: "PATCH", query: { id }, body: { status: "qualified", notes: "  Call after 5pm ", assigned_seller_id: ids.seller } });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "qualified");
  assert.equal(r.body.notes, "Call after 5pm");
  assert.equal(r.body.seller_name, "Ana Realtor");
  assert.ok(new Date(r.body.updated_at) > old);
  const clear = await call(adminLeads, { method: "PATCH", query: { id }, body: { assigned_seller_id: null, notes: "" } });
  assert.equal(clear.body.assigned_seller_id, null);
  assert.equal(clear.body.notes, null);
  const bad = await call(adminLeads, { method: "PATCH", query: { id }, body: { status: "won", notes: 5, assigned_seller_id: "x" } });
  assert.equal(bad.status, 422);
  assert.deepEqual(Object.keys(bad.body.fields).sort(), ["assigned_seller_id", "notes", "status"]);
  assert.equal((await call(adminLeads, { method: "PATCH", query: { id }, body: { assigned_seller_id: 424242 } })).status, 422);
  assert.equal((await call(adminLeads, { method: "PATCH", query: { id }, body: {} })).status, 422);
  assert.equal((await call(adminLeads, { method: "PATCH", body: { status: "new" } })).status, 400);
  assert.equal((await call(adminLeads, { method: "PATCH", query: { id: "999999" }, body: { status: "new" } })).status, 404);
  assert.equal((await call(adminLeads, { method: "DELETE", query: { id } })).status, 405);
});

test("CSV export escapes quotes, commas and formulas", async () => {
  const r = await call(adminLeads, { query: { format: "csv" } });
  assert.equal(r.status, 200);
  assert.match(r.headers["content-type"], /^text\/csv/);
  assert.match(r.headers["content-disposition"], /^attachment; filename="leads-\d{4}-\d{2}-\d{2}\.csv"$/);
  const text = r.body.replace(/^﻿/, "");
  const lines = text.trim().split("\r\n");
  assert.equal(lines.length, 4); // header + 3 non-test leads
  assert.ok(lines[0].startsWith("id,created_at,source,status,name,email,phone"));
  assert.ok(text.includes(`"Sam ""The Man"", Jr."`));
  assert.ok(text.includes(`"'=HYPERLINK(""http://x"")"`));
  assert.ok(text.includes(",+1 (416) 555-0199,")); // phone numbers are left alone
  assert.equal(csvField("a\nb"), '"a\nb"');
  assert.equal(csvField("@SUM(A1)"), "'@SUM(A1)");
  assert.equal(csvField(null), "");
  const filtered = await call(adminLeads, { query: { format: "csv", source: "google_ads" } });
  assert.equal(filtered.body.trim().split("\r\n").length, 2);
});

test("sellers: create, validate, update, deactivate", async () => {
  const ok = await call(adminSellers, { method: "POST", body: { name: " Bo Agent ", email: "bo@example.com", phone: "+15195550123", areas: ["Waterloo", "Cambridge"], notify_sms: false } });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.name, "Bo Agent");
  assert.deepEqual(ok.body.areas, ["Waterloo", "Cambridge"]);
  assert.equal(ok.body.notify_sms, false);
  assert.equal(ok.body.active, true);
  const bad = await call(adminSellers, { method: "POST", body: { name: "", email: "nope", phone: "416-555-0100", areas: ["GTA", "Mars"], active: "yes" } });
  assert.equal(bad.status, 422);
  assert.deepEqual(Object.keys(bad.body.fields).sort(), ["active", "areas", "email", "name", "phone"]);
  const noContact = await call(adminSellers, { method: "POST", body: { name: "X" } });
  assert.deepEqual(noContact.body.fields, { contact: "email or phone required" });
  const id = ok.body.id;
  const upd = await call(adminSellers, { method: "PATCH", query: { id }, body: { active: false, areas: [] } });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.active, false);
  assert.deepEqual(upd.body.areas, []);
  assert.equal(upd.body.email, "bo@example.com");
  assert.equal((await call(adminSellers, { method: "PATCH", query: { id }, body: { email: null, phone: "" } })).status, 422);
  assert.equal((await call(adminSellers, { method: "PATCH", query: { id }, body: { phone: "+1" } })).status, 422);
  assert.equal((await call(adminSellers, { method: "PATCH", query: { id: "999999" }, body: { active: true } })).status, 404);
  assert.equal((await call(adminSellers, { method: "PATCH", query: {}, body: { active: true } })).status, 400);
  assert.equal((await call(adminSellers, { method: "DELETE", query: { id } })).status, 405);
  const list = await call(adminSellers);
  assert.deepEqual(list.body.map((s) => [s.name, s.active]), [["Ana Realtor", true], ["Bo Agent", false]]);
});

test("stats shape", async () => {
  const r = await call(adminStats);
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ["active_listings_by_area", "by_area", "by_source", "by_status", "last_sync", "leads", "notifications_7_days"]);
  assert.equal(r.body.leads.today, 1);
  assert.equal(r.body.leads.last_7_days, 1);
  assert.equal(r.body.leads.last_30_days, 1);
  assert.equal(r.body.leads.total, 3);
  assert.deepEqual(r.body.by_source, { website: 2, google_ads: 1 });
  assert.equal(r.body.by_area.Cambridge, 1);
  assert.deepEqual(r.body.active_listings_by_area, { GTA: 1 });
  assert.equal(r.body.last_sync.crea_ddf.fetched, 9);
  assert.deepEqual(r.body.notifications_7_days, { sent: 1, failed: 1, skipped: 0 });
  assert.equal((await call(adminStats, { method: "POST" })).status, 405);
});

test("rate limit allows up to the limit then denies, per key", async () => {
  const opts = { limit: 3, windowSeconds: 600 };
  const results = [];
  for (let i = 0; i < 4; i++) results.push(await rateLimit("t:1.2.3.4", opts));
  assert.deepEqual(results.map((r) => r.allowed), [true, true, true, false]);
  assert.deepEqual(results.map((r) => r.remaining), [2, 1, 0, 0]);
  assert.equal((await rateLimit("t:5.6.7.8", opts)).allowed, true);
  const parallel = await Promise.all(Array.from({ length: 10 }, () => rateLimit("t:burst", opts)));
  assert.equal(parallel.filter((r) => r.allowed).length, 3); // the upsert is atomic
  await db("INSERT INTO rate_limits (key, window_start, count) VALUES ('old', now() - interval '2 days', 9)");
  assert.equal(await cleanupRateLimits(), 1);
});

test("clientIp and allowLeadSubmission", async () => {
  assert.equal(clientIp({ headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" } }), "203.0.113.7");
  assert.equal(clientIp({ headers: { "x-real-ip": "198.51.100.2" } }), "198.51.100.2");
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: "127.0.0.1" } }), "127.0.0.1");
  const req = { headers: { "x-forwarded-for": "192.0.2.50" } };
  const res = () => ({ headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(d) { this.body = d; } });
  const opts = { limit: 2, windowSeconds: 600 };
  assert.equal(await allowLeadSubmission(req, res(), opts), true);
  assert.equal(await allowLeadSubmission(req, res(), opts), true);
  const denied = res();
  assert.equal(await allowLeadSubmission(req, denied, opts), false);
  assert.equal(denied.statusCode, 429);
  assert.equal(denied.headers["retry-after"], "600");
});
