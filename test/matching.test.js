// Runs against a real Postgres: DATABASE_URL=postgres://... node --test test/matching.test.js
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { getPool } from "../lib/db.js";
import { parseBudget, budgetText } from "../lib/budget.js";
import { findMatches, assignSeller } from "../lib/matching.js";
import { notifySeller, buildSms, buildEmail } from "../lib/notify.js";
import { processNewLead } from "../lib/process-lead.js";

const db = (sql, params) => getPool().query(sql, params);
const ENV = {
  RESEND_API_KEY: "re_test", NOTIFY_FROM_EMAIL: "alerts@example.com", TWILIO_ACCOUNT_SID: "AC1",
  TWILIO_AUTH_TOKEN: "tok", TWILIO_FROM_NUMBER: "+15550001111", APP_URL: "https://app.example.com",
};
let calls = [];
let fail = false;
const realFetch = globalThis.fetch;

before(async () => {
  await db("DROP TABLE IF EXISTS notifications, matches, listings, sellers, sync_runs, rate_limits, leads CASCADE");
  await db(await readFile(new URL("../db/schema.sql", import.meta.url), "utf8"));
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    return fail ? new Response("boom", { status: 500 }) : new Response("{}", { status: 200 });
  };
  let n = 0;
  const listing = (over) => ({ source_key: `K${++n}`, mls_number: `M${n}`, status: "active", transaction_type: "sale",
    address: `${n} Main St`, city: "Kitchener", area: "Waterloo", price: 700000, listing_url: `https://x.ca/${n}`, ...over });
  const rows = [
    listing({ price: 750000 }),                                   // K1 in budget
    listing({ price: 820000 }),                                   // K2 ~9% over
    listing({ price: 1000000 }),                                  // K3 too expensive
    listing({ price: 790000, city: "Waterloo" }),                 // K4 in budget, other city
    listing({ price: 2400, transaction_type: "lease" }),          // K5 lease
    listing({ price: 760000, status: "inactive" }),               // K6 inactive
    listing({ price: 650000, city: "Toronto", area: "GTA" }),     // K7 GTA
    listing({ price: 1500000, city: "Toronto", area: "GTA", mls_number: "C999" }), // K8 viewed elsewhere
  ];
  for (const r of rows) {
    await db(`INSERT INTO listings (source, source_key, mls_number, status, transaction_type, address, city, area, price, listing_url)
              VALUES ('crea_ddf', $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [r.source_key, r.mls_number, r.status, r.transaction_type, r.address, r.city, r.area, r.price, r.listing_url]);
  }
});
after(async () => { globalThis.fetch = realFetch; await getPool().end(); });
beforeEach(() => { calls = []; fail = false; Object.assign(process.env, ENV); });

async function addLead(over = {}) {
  const l = { name: "Sam Lee", email: "sam@example.com", phone: "+15195550100", intent: "buy", location: "Kitchener",
    budget: "$800k", ...over };
  const { rows } = await db(
    `INSERT INTO leads (name, email, phone, intent, location, budget, message, listing_id, is_test, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [l.name, l.email, l.phone, l.intent, l.location, l.budget, l.message ?? null, l.listing_id ?? null, l.is_test ?? false, l.source ?? "website"]);
  return rows[0];
}
async function addSeller(over = {}) {
  const s = { name: "Ria", email: "ria@example.com", phone: "+14165550199", areas: [], notify_email: true, notify_sms: true, ...over };
  const { rows } = await db(
    "INSERT INTO sellers (name, email, phone, areas, notify_email, notify_sms) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *",
    [s.name, s.email, s.phone, s.areas, s.notify_email, s.notify_sms]);
  return rows[0];
}
const keys = (ms) => ms.map((m) => m.listing.source_key);

test("budget parsing", () => {
  assert.deepEqual(parseBudget("$800k"), { min: null, max: 800000, monthly: false });
  assert.deepEqual(parseBudget("800,000"), { min: null, max: 800000, monthly: false });
  assert.deepEqual(parseBudget("1.2M"), { min: null, max: 1200000, monthly: false });
  assert.deepEqual(parseBudget("$2,500/mo"), { min: null, max: 2500, monthly: true });
  assert.deepEqual(parseBudget("600-750k"), { min: 600000, max: 750000, monthly: false });
  assert.deepEqual(parseBudget("$600k - $1.1M"), { min: 600000, max: 1100000, monthly: false });
  assert.deepEqual(parseBudget("1M+"), { min: 1000000, max: null, monthly: false });
  assert.equal(parseBudget("flexible"), null);
  assert.equal(parseBudget(""), null);
  assert.equal(budgetText({ message: "Budget?: $800k" }), " $800k");
});

test("scores in-budget, same-city listings highest; excludes inactive, lease, other areas", async () => {
  const ms = await findMatches(await addLead());
  assert.deepEqual(keys(ms), ["K1", "K2", "K4"]); // same city slightly over beats other city
  assert.ok(ms[0].score > ms[1].score && ms[1].score > ms[2].score);
  assert.ok(ms.every((m) => m.score > 0 && m.score <= 100));
  assert.equal(typeof ms[0].listing.price, "number");
});

test("intent filters transaction type; sell leads get nothing", async () => {
  assert.deepEqual(keys(await findMatches(await addLead({ intent: "rent", budget: "$2,500/mo" }))), ["K5"]);
  assert.deepEqual(await findMatches(await addLead({ intent: "sell" })), []);
  assert.deepEqual(keys(await findMatches(await addLead({ intent: null, budget: "$2,500/mo" }))), ["K5"]);
});

test("viewed listing is the top match, even outside the area or budget", async () => {
  const ms = await findMatches(await addLead({ listing_id: "C999" }));
  assert.equal(ms[0].listing.source_key, "K8");
  assert.equal(ms[0].score, 100);
  assert.equal(ms[0].viewed, true);
  assert.deepEqual(keys(await findMatches(await addLead({ listing_id: "K1" }))).slice(0, 2), ["K1", "K2"]);
  const noArea = await findMatches(await addLead({ location: null, listing_id: "C999", budget: "2M" }));
  assert.deepEqual(keys(noArea), ["K8", "K7"]); // area comes from the viewed listing (GTA)
});

test("owner routing (default) sends every lead to the feed owner", async () => {
  await db("DELETE FROM sellers");
  const owner = await addSeller({ name: "Owner", areas: ["GTA"] });
  const other = await addSeller({ name: "Other", areas: ["Waterloo"] });
  assert.equal((await assignSeller({ area: "Waterloo" })).id, owner.id);
  process.env.OWNER_SELLER_ID = String(other.id);
  assert.equal((await assignSeller({ area: "GTA" })).id, other.id);
  delete process.env.OWNER_SELLER_ID;
});

test("seller assignment by area and recent load", async () => {
  process.env.LEAD_ROUTING = "area";
  await db("DELETE FROM sellers");
  const gta = await addSeller({ name: "GTA", areas: ["GTA"] });
  const wat1 = await addSeller({ name: "Wat1", areas: ["Waterloo"] });
  const wat2 = await addSeller({ name: "Wat2", areas: ["Waterloo", "Cambridge"] });
  await addSeller({ name: "Off", areas: ["Waterloo"] }).then((s) => db("UPDATE sellers SET active = false WHERE id = $1", [s.id]));
  assert.equal((await assignSeller({ area: "GTA" })).id, gta.id);
  assert.equal((await assignSeller({ location: "Kitchener" })).id, wat1.id);
  const l = await addLead();
  await db("UPDATE leads SET assigned_seller_id = $1 WHERE id = $2", [wat1.id, l.id]);
  assert.equal((await assignSeller({ area: "Waterloo" })).id, wat2.id);
  assert.equal(await assignSeller({ area: "Cambridge", id: 0 }).then((s) => s.id), wat2.id);
  const old = await addLead();
  await db("UPDATE leads SET assigned_seller_id = $1, created_at = now() - interval '40 days' WHERE id = $2", [wat2.id, old.id]);
  assert.equal((await assignSeller({ area: "Waterloo" })).id, wat2.id); // old lead doesn't count
  assert.equal(await assignSeller({ location: "Nowhere" }), null);
  const all = await addSeller({ name: "All", areas: [] });
  assert.equal((await assignSeller({ location: "Nowhere" })).id, all.id);
  delete process.env.LEAD_ROUTING;
});

test("notifications: sent, skipped and failed are recorded; never throws", async () => {
  const lead = await addLead({ name: "<b>Eve</b>", message: "Hi & bye" });
  const seller = await addSeller({ notify_sms: false });
  let r = await notifySeller(seller, lead, [{ listing: { address: "1 Main St", city: "Kitchener", price: 750000, listing_url: "https://x.ca/1" } }]);
  assert.deepEqual(r.map((x) => [x.channel, x.status]), [["email", "sent"], ["sms", "skipped"]]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.resend.com/emails");
  const body = JSON.parse(calls[0].opts.body);
  assert.deepEqual(body.to, ["ria@example.com"]);
  assert.match(body.html, /&lt;b&gt;Eve&lt;\/b&gt;/);
  assert.match(body.html, /Hi &amp; bye/);
  assert.match(body.text, /1 Main St, Kitchener - \$750,000 https:\/\/x.ca\/1/);

  calls = [];
  delete process.env.RESEND_API_KEY;
  r = await notifySeller(await addSeller(), lead, []);
  assert.deepEqual(r.map((x) => x.status), ["skipped", "sent"]);
  assert.match(calls[0].url, /api\.twilio\.com\/2010-04-01\/Accounts\/AC1\/Messages\.json/);
  const sms = new URLSearchParams(calls[0].opts.body);
  assert.equal(sms.get("To"), "+14165550199");
  assert.match(sms.get("Body"), /https:\/\/app\.example\.com\/admin\.html$/);

  process.env.RESEND_API_KEY = "re_test";
  fail = true;
  r = await notifySeller(await addSeller(), lead, []);
  assert.deepEqual(r.map((x) => x.status), ["failed", "failed"]);
  assert.match(r[0].error, /Resend 500/);
  fail = false;

  const { rows } = await db("SELECT channel, status FROM notifications WHERE lead_id = $1 ORDER BY id", [lead.id]);
  assert.deepEqual(rows.map((x) => x.status), ["sent", "skipped", "skipped", "sent", "failed", "failed"]);
});

test("sms stays short and email subject is plain", () => {
  const sms = buildSms({ name: "x".repeat(400), phone: "+1", intent: "buy", area: "GTA" });
  assert.ok(sms.length <= 300);
  assert.ok(sms.endsWith("/admin.html"));
  assert.equal(buildEmail({ name: "R" }, { name: "Sam", intent: "buy" }).subject, "New buy lead: Sam");
});

test("processNewLead matches, assigns, notifies, and is idempotent", async () => {
  await db("DELETE FROM sellers");
  const seller = await addSeller({ areas: ["Waterloo"] });
  const lead = await addLead({ location: "near Kitchener", budget: null, message: "Budget?: 800,000", source: "google_ads" });
  const s = await processNewLead(lead.id);
  assert.equal(s.ok, true);
  assert.equal(s.area, "Waterloo");
  assert.equal(s.matches, 3);
  assert.equal(s.sellerId, seller.id);
  assert.deepEqual(s.notifications.map((n) => n.status), ["sent", "sent"]);
  assert.match(JSON.parse(calls[0].opts.body).text, /Source: Google ad/);
  const { rows } = await db("SELECT area, assigned_seller_id FROM leads WHERE id = $1", [lead.id]);
  assert.deepEqual(rows[0], { area: "Waterloo", assigned_seller_id: seller.id });

  calls = [];
  await addSeller({ areas: ["Waterloo"] }); // a less-loaded seller appears; the lead keeps its seller
  const again = await processNewLead(lead.id);
  assert.equal(again.sellerId, seller.id);
  assert.deepEqual(again.notifications, []);
  assert.equal(calls.length, 0);
  assert.equal((await db("SELECT count(*)::int AS n FROM matches WHERE lead_id = $1", [lead.id])).rows[0].n, 3);
  assert.equal((await db("SELECT count(*)::int AS n FROM notifications WHERE lead_id = $1", [lead.id])).rows[0].n, 2);
});

test("processNewLead retries only failed channels", async () => {
  await db("DELETE FROM sellers");
  await addSeller();
  const lead = await addLead();
  process.env.TWILIO_AUTH_TOKEN = "";
  assert.deepEqual((await processNewLead(lead.id)).notifications.map((n) => n.status), ["sent", "skipped"]);
  process.env.TWILIO_AUTH_TOKEN = "tok";
  calls = [];
  const r = await processNewLead(lead.id);
  assert.deepEqual(r.notifications.map((n) => [n.channel, n.status]), [["sms", "sent"]]);
  assert.equal(calls.length, 1);
});

test("test leads are matched and assigned but not notified", async () => {
  await addSeller();
  const lead = await addLead({ is_test: true });
  const s = await processNewLead(lead.id);
  assert.equal(s.skipped, "test lead");
  assert.ok(s.sellerId);
  assert.ok(s.matches > 0);
  assert.equal(calls.length, 0);
  assert.equal((await db("SELECT count(*)::int AS n FROM notifications WHERE lead_id = $1", [lead.id])).rows[0].n, 0);
});

test("processNewLead never throws", async () => {
  const missing = await processNewLead(999999);
  assert.deepEqual([missing.ok, missing.error], [false, "lead not found"]);
  const bad = await processNewLead("not-a-number");
  assert.equal(bad.ok, false);
});
