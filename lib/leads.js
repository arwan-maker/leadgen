import { query } from "./db.js";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const LIMITS = {
  name: 120, email: 200, phone: 40, intent: 10, location: 200, budget: 60,
  message: 2000, search_query: 500, listing_id: 100, page_url: 1000,
};

function clean(value, limit) {
  const s = String(value ?? "").trim().slice(0, limit);
  return s || null;
}

// Validates a lead from the website pop-up. Returns { lead, errors }.
export function validateWebsiteLead(body) {
  const lead = {};
  for (const [key, limit] of Object.entries(LIMITS)) lead[key] = clean(body?.[key], limit);
  const errors = {};
  if (!lead.name) errors.name = "required";
  if (!lead.email) errors.email = "required";
  else if (!EMAIL_RE.test(lead.email)) errors.email = "invalid";
  if (lead.intent && !["buy", "rent", "sell"].includes(lead.intent)) errors.intent = "invalid";
  if (body?.consent !== true) errors.consent = "required";
  lead.consent = true;
  lead.consent_type = "express"; // the visitor ticked "I agree to be contacted"
  lead.source = "website";
  return { lead, errors };
}

const GOOGLE_COLUMNS = {
  FULL_NAME: "name", EMAIL: "email", PHONE_NUMBER: "phone", CITY: "location", POSTAL_CODE: "postal",
  PROPERTY_COMMUNITY: "community", PRICE_RANGE: "budget", PROPERTY_TYPE: "property_type",
  NUMBER_OF_BEDROOMS: "bedrooms", REALTOR_HELP_GOAL: "goal",
};
const GOOGLE_LABELS = { PROPERTY_TYPE: "Property type", NUMBER_OF_BEDROOMS: "Bedrooms" };
const IMPLIED_CONSENT_MONTHS = 6; // CASL: an inquiry gives implied consent for 6 months

// Maps free text such as "Buy a home" or "I want to rent" to buy | sell | rent.
export function normalizeIntent(text) {
  const t = String(text || "").toLowerCase();
  if (/\b(rent|rental|lease|leasing|tenant)/.test(t)) return "rent";
  if (/\b(sell|selling|list my|listing my)/.test(t)) return "sell";
  if (/\b(buy|buying|purchase|purchasing)/.test(t)) return "buy";
  return null;
}

// Maps a Google Ads lead form webhook payload to a lead row.
export function leadFromGoogle(body) {
  const submitted = Date.parse(body.lead_submit_time) || Date.now();
  const expires = new Date(submitted);
  expires.setMonth(expires.getMonth() + IMPLIED_CONSENT_MONTHS);
  const lead = {
    source: "google_ads", external_id: clean(body.lead_id, 200), is_test: body.is_test === true, raw: body,
    consent: true, consent_type: "implied_inquiry", consent_expires_at: expires.toISOString(),
    gcl_id: clean(body.gcl_id, 200), campaign_id: clean(body.campaign_id, 40), form_id: clean(body.form_id, 40),
  };
  const v = {};
  let first = null, last = null;
  const extras = [];
  for (const col of body.user_column_data || []) {
    const value = clean(col.string_value, 500);
    if (!value) continue;
    const field = GOOGLE_COLUMNS[col.column_id];
    if (field) v[field] ??= value;
    if (col.column_id === "FIRST_NAME") first = value;
    else if (col.column_id === "LAST_NAME") last = value;
    if (GOOGLE_LABELS[col.column_id]) extras.push(`${GOOGLE_LABELS[col.column_id]}: ${value}`);
    else if (!field && col.column_id !== "FIRST_NAME" && col.column_id !== "LAST_NAME") {
      extras.push(`${col.column_name || col.column_id}: ${value}`);
    }
  }
  lead.name = clean(v.name || [first, last].filter(Boolean).join(" "), LIMITS.name);
  lead.email = clean(v.email, LIMITS.email);
  lead.phone = clean(v.phone, LIMITS.phone);
  lead.location = clean(v.location || v.community || v.postal, LIMITS.location);
  lead.budget = clean(v.budget, LIMITS.budget);
  lead.intent = normalizeIntent(v.goal); // never the raw text: the column only allows buy/sell/rent
  lead.property_type = clean(v.property_type, 60);
  lead.bedrooms = clean(v.bedrooms, 20);
  if (v.goal && !lead.intent) extras.unshift(`Looking to: ${v.goal}`);
  if (extras.length) lead.message = clean(extras.join("\n"), LIMITS.message);
  return lead;
}

const COLUMNS = ["source", "external_id", "name", "email", "phone", "intent", "location", "budget",
  "message", "search_query", "listing_id", "page_url", "consent", "consent_type", "consent_expires_at",
  "property_type", "bedrooms", "gcl_id", "campaign_id", "form_id", "is_test", "raw"];

// Inserts a lead. Returns its id, or null when it was a duplicate delivery.
export async function insertLead(lead) {
  const values = COLUMNS.map((c) => (c === "raw" && lead.raw ? JSON.stringify(lead.raw) : lead[c] ?? null));
  values[COLUMNS.indexOf("consent")] = lead.consent === true;
  values[COLUMNS.indexOf("is_test")] = lead.is_test === true;
  const { rows } = await query(
    `INSERT INTO leads (${COLUMNS.join(", ")})
     VALUES (${COLUMNS.map((_, i) => `$${i + 1}`).join(", ")})
     ON CONFLICT (source, external_id) WHERE external_id IS NOT NULL DO NOTHING
     RETURNING id`,
    values,
  );
  return rows[0]?.id ?? null;
}

export async function listLeads(limit = 500) {
  const { rows } = await query(
    `SELECT id, created_at, source, name, email, phone, intent, location, budget, message,
            search_query, listing_id, page_url, consent_type, consent_expires_at, property_type, bedrooms, is_test, status
     FROM leads ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return rows;
}
