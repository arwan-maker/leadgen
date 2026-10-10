// Runs against a real Postgres. Usage: DATABASE_URL=postgres://... npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { getPool } from "../lib/db.js";
import leads from "../api/leads.js";
import googleLeads from "../api/google-leads.js";

process.env.ADMIN_TOKEN = "admin-secret";
process.env.GOOGLE_LEADS_KEY = "google-secret";

function call(handler, { method = "POST", body, headers = {} } = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200, headers: {},
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      end(data) { resolve({ status: this.statusCode, headers: this.headers, body: data ? JSON.parse(data) : null }); },
    };
    handler({ method, body, headers }, res);
  });
}

before(async () => {
  const pool = getPool();
  await pool.query("DROP TABLE IF EXISTS leads, sellers, listings, sync_runs, matches, notifications, rate_limits CASCADE");
  await pool.query(await readFile(new URL("../db/schema.sql", import.meta.url), "utf8"));
  await pool.query(await readFile(new URL("../db/schema.sql", import.meta.url), "utf8")); // runs twice safely
});
after(() => getPool().end());

const google = (over = {}) => ({
  lead_id: "g-1", google_key: "google-secret", is_test: false, form_id: 1, campaign_id: 2,
  user_column_data: [
    { column_id: "FULL_NAME", string_value: "Priya Shah" },
    { column_id: "EMAIL", string_value: "priya@example.com" },
    { column_id: "PHONE_NUMBER", string_value: "+14165550100" },
    { column_id: "CITY", string_value: "Mississauga" },
    { column_id: "QUESTION_1", column_name: "Budget?", string_value: "$800k" },
  ], ...over,
});

test("website lead is saved", async () => {
  const r = await call(leads, { body: { name: "Sam", email: "sam@example.com", intent: "buy", location: "Waterloo", consent: true } });
  assert.equal(r.status, 201);
  assert.ok(r.body.id);
});

test("website lead without consent or valid email is rejected", async () => {
  const r = await call(leads, { body: { name: "", email: "nope" } });
  assert.equal(r.status, 422);
  assert.deepEqual(Object.keys(r.body.fields).sort(), ["consent", "email", "name"]);
});

test("honeypot submission is accepted but not stored", async () => {
  const before = await getPool().query("SELECT count(*) FROM leads");
  const r = await call(leads, { body: { name: "Bot", email: "b@x.co", consent: true, website: "spam.com" } });
  assert.equal(r.status, 201);
  const after = await getPool().query("SELECT count(*) FROM leads");
  assert.equal(after.rows[0].count, before.rows[0].count);
});

test("listing leads needs the admin token", async () => {
  assert.equal((await call(leads, { method: "GET" })).status, 401);
  assert.equal((await call(leads, { method: "GET", headers: { authorization: "Bearer wrong" } })).status, 401);
  const r = await call(leads, { method: "GET", headers: { authorization: "Bearer admin-secret" } });
  assert.equal(r.status, 200);
  assert.equal(r.body[0].email, "sam@example.com");
});

test("google lead is mapped, saved once, and duplicates are ignored", async () => {
  assert.deepEqual((await call(googleLeads, { body: google() })).body, {});
  assert.equal((await call(googleLeads, { body: google() })).status, 200);
  const { rows } = await getPool().query("SELECT * FROM leads WHERE source = 'google_ads'");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "Priya Shah");
  assert.equal(rows[0].phone, "+14165550100");
  assert.equal(rows[0].location, "Mississauga");
  assert.equal(rows[0].message, "Budget?: $800k");
});

test("google lead with a wrong key is refused", async () => {
  const r = await call(googleLeads, { body: google({ lead_id: "g-2", google_key: "bad" }) });
  assert.equal(r.status, 403);
});

test("google lead with first and last name and no email still saves", async () => {
  const r = await call(googleLeads, { body: google({ lead_id: "g-3", is_test: true, user_column_data: [
    { column_id: "FIRST_NAME", string_value: "Li" }, { column_id: "LAST_NAME", string_value: "Wei" },
    { column_id: "PHONE_NUMBER", string_value: "+15195550111" }] }) });
  assert.equal(r.status, 200);
  const { rows } = await getPool().query("SELECT name, is_test FROM leads WHERE external_id = 'g-3'");
  assert.deepEqual(rows[0], { name: "Li Wei", is_test: true });
});

test("google real-estate answers become fields, with implied consent for 6 months", async () => {
  const r = await call(googleLeads, { body: google({ lead_id: "g-4", gcl_id: "abc", lead_submit_time: "2026-10-10T12:00:00Z",
    user_column_data: [
      { column_id: "FULL_NAME", string_value: "Ana Ruiz" },
      { column_id: "EMAIL", string_value: "ana@example.com" },
      { column_id: "PROPERTY_COMMUNITY", string_value: "Kitchener" },
      { column_id: "REALTOR_HELP_GOAL", string_value: "Rent a place" },
      { column_id: "PRICE_RANGE", string_value: "$2,000 - $2,500" },
      { column_id: "PROPERTY_TYPE", string_value: "Condo" },
      { column_id: "NUMBER_OF_BEDROOMS", string_value: "2" },
    ] }) });
  assert.equal(r.status, 200);
  const { rows: [l] } = await getPool().query("SELECT * FROM leads WHERE external_id = 'g-4'");
  assert.equal(l.intent, "rent");
  assert.equal(l.budget, "$2,000 - $2,500");
  assert.equal(l.location, "Kitchener");
  assert.equal(l.property_type, "Condo");
  assert.equal(l.bedrooms, "2");
  assert.equal(l.message, "Property type: Condo\nBedrooms: 2");
  assert.equal(l.consent_type, "implied_inquiry");
  assert.equal(l.consent_expires_at.toISOString(), "2027-04-10T12:00:00.000Z");
  assert.equal(l.gcl_id, "abc");
});

test("an unclear google goal stays out of intent instead of failing the insert", async () => {
  const r = await call(googleLeads, { body: google({ lead_id: "g-5", user_column_data: [
    { column_id: "EMAIL", string_value: "x@example.com" },
    { column_id: "REALTOR_HELP_GOAL", string_value: "Just browsing" }] }) });
  assert.equal(r.status, 200);
  const { rows: [l] } = await getPool().query("SELECT intent, message FROM leads WHERE external_id = 'g-5'");
  assert.deepEqual(l, { intent: null, message: "Looking to: Just browsing" });
});

test("website leads record express consent", async () => {
  const { rows: [l] } = await getPool().query("SELECT consent_type, consent_expires_at FROM leads WHERE email = 'sam@example.com'");
  assert.deepEqual(l, { consent_type: "express", consent_expires_at: null });
});
