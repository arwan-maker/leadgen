import { query } from "../../lib/db.js";
import { isAdmin, sendJson } from "../../lib/http.js";
import { AREAS } from "../../lib/areas.js";

// Admin leads API (Authorization: Bearer $ADMIN_TOKEN)
// GET   /api/admin/leads?status=&source=&area=&q=&from=&to=&include_test=1&page=1&per_page=50
// GET   /api/admin/leads?format=csv   same filters, as a CSV download
// GET   /api/admin/leads?id=123       one lead with its matches and notifications
// PATCH /api/admin/leads?id=123       { status, notes, assigned_seller_id }
export const STATUSES = ["new", "contacted", "qualified", "closed", "lost"];
const SOURCES = ["website", "google_ads"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[1-9]\d{0,17}$/;

// Builds the WHERE clause from query filters. Returns { where, params, errors }.
export function buildFilters(q = {}) {
  const conds = [], params = [], errors = {};
  const tz = () => { params.push(process.env.APP_TIMEZONE || "America/Toronto"); return `$${params.length}`; };
  const add = (sql, value) => { params.push(value); conds.push(sql.replace("?", `$${params.length}`)); };
  if (q.status) STATUSES.includes(q.status) ? add("l.status = ?", q.status) : (errors.status = "invalid");
  if (q.source) SOURCES.includes(q.source) ? add("l.source = ?", q.source) : (errors.source = "invalid");
  if (q.area) {
    if (q.area === "none") conds.push("l.area IS NULL");
    else AREAS.includes(q.area) ? add("l.area = ?", q.area) : (errors.area = "invalid");
  }
  if (q.from) DATE_RE.test(q.from) && !isNaN(Date.parse(q.from)) ? add("l.created_at >= ?::date::timestamp AT TIME ZONE " + tz(), q.from) : (errors.from = "invalid");
  if (q.to) DATE_RE.test(q.to) && !isNaN(Date.parse(q.to)) ? add("l.created_at < (?::date + 1)::timestamp AT TIME ZONE " + tz(), q.to) : (errors.to = "invalid");
  const search = String(q.q ?? "").trim().slice(0, 100);
  if (search) {
    params.push(`%${search.replace(/[\\%_]/g, "\\$&")}%`);
    const p = `$${params.length}`;
    const digits = search.replace(/\D/g, "");
    let phone = "";
    if (digits.length >= 3) { params.push(`%${digits}%`); phone = ` OR regexp_replace(coalesce(l.phone, ''), '\\D', '', 'g') LIKE $${params.length}`; }
    conds.push(`(l.name ILIKE ${p} OR l.email ILIKE ${p} OR l.phone ILIKE ${p}${phone})`);
  }
  if (q.include_test !== "1") conds.push("NOT l.is_test");
  return { where: conds.length ? `WHERE ${conds.join(" AND ")}` : "", params, errors };
}

const LIST_SQL = `
  SELECT l.id, l.created_at, l.updated_at, l.source, l.name, l.email, l.phone, l.intent, l.area, l.location,
         l.budget, l.message, l.search_query, l.listing_id, l.is_test, l.status, l.notes, l.assigned_seller_id,
         s.name AS seller_name,
         (SELECT count(*)::int FROM matches m WHERE m.lead_id = l.id) AS match_count,
         n.status AS last_notification_status, n.channel AS last_notification_channel, n.created_at AS last_notification_at
  FROM leads l
  LEFT JOIN sellers s ON s.id = l.assigned_seller_id
  LEFT JOIN LATERAL (SELECT status, channel, created_at FROM notifications WHERE lead_id = l.id
                     ORDER BY created_at DESC, id DESC LIMIT 1) n ON true`;

function intParam(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
}

export async function listAdminLeads(q = {}) {
  const { where, params, errors } = buildFilters(q);
  if (Object.keys(errors).length) return { errors };
  const perPage = intParam(q.per_page, 50, 1, 200);
  const page = intParam(q.page, 1, 1, 100000);
  const [{ rows }, count] = await Promise.all([
    query(`${LIST_SQL} ${where} ORDER BY l.created_at DESC, l.id DESC LIMIT ${perPage} OFFSET ${(page - 1) * perPage}`, params),
    query(`SELECT count(*)::int AS total FROM leads l ${where}`, params),
  ]);
  return { leads: rows, total: count.rows[0].total, page, per_page: perPage };
}

const CSV_COLUMNS = ["id", "created_at", "source", "status", "name", "email", "phone", "intent", "area", "location",
  "budget", "message", "search_query", "listing_id", "seller_name", "match_count", "last_notification_status", "notes", "is_test"];

// RFC 4180 field. Also neutralizes spreadsheet formulas (=, +, -, @) except plain numbers/phones.
export function csvField(value) {
  if (value == null) return "";
  let s = value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(s) && !/^[+-]?[\d\s().-]+$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows) {
  return [CSV_COLUMNS.join(","), ...rows.map((r) => CSV_COLUMNS.map((c) => csvField(r[c])).join(","))].join("\r\n") + "\r\n";
}

async function getLead(id) {
  const { rows } = await query(`${LIST_SQL} WHERE l.id = $1`, [id]);
  if (!rows[0]) return null;
  const [matches, notifications, full] = await Promise.all([
    query(`SELECT m.id, m.score, m.created_at, li.id AS listing_id, li.address, li.city, li.price, li.listing_url,
                  li.mls_number, li.status AS listing_status, li.transaction_type, li.bedrooms, li.bathrooms
           FROM matches m JOIN listings li ON li.id = m.listing_id
           WHERE m.lead_id = $1 ORDER BY m.score DESC, m.id`, [id]),
    query(`SELECT n.id, n.created_at, n.channel, n.status, n.error, n.seller_id, s.name AS seller_name
           FROM notifications n LEFT JOIN sellers s ON s.id = n.seller_id
           WHERE n.lead_id = $1 ORDER BY n.created_at DESC, n.id DESC`, [id]),
    query("SELECT page_url, consent FROM leads WHERE id = $1", [id]),
  ]);
  return { ...rows[0], ...full.rows[0], matches: matches.rows, notifications: notifications.rows };
}

// Validates a PATCH body. Returns { fields, errors }.
export function validateLeadPatch(body) {
  const fields = {}, errors = {};
  if (!body || typeof body !== "object" || Array.isArray(body)) return { fields, errors: { body: "invalid" } };
  if ("status" in body) STATUSES.includes(body.status) ? (fields.status = body.status) : (errors.status = "invalid");
  if ("notes" in body) {
    if (body.notes != null && typeof body.notes !== "string") errors.notes = "invalid";
    else if ((body.notes || "").length > 5000) errors.notes = "too long";
    else fields.notes = body.notes?.trim() || null;
  }
  if ("assigned_seller_id" in body) {
    const v = body.assigned_seller_id;
    if (v === null || v === "") fields.assigned_seller_id = null;
    else if (ID_RE.test(String(v))) fields.assigned_seller_id = String(v);
    else errors.assigned_seller_id = "invalid";
  }
  if (!Object.keys(fields).length && !Object.keys(errors).length) errors.body = "nothing to update";
  return { fields, errors };
}

async function patchLead(id, body) {
  const { fields, errors } = validateLeadPatch(body);
  if (Object.keys(errors).length) return { status: 422, body: { error: "validation", fields: errors } };
  if (fields.assigned_seller_id) {
    const { rows } = await query("SELECT 1 FROM sellers WHERE id = $1", [fields.assigned_seller_id]);
    if (!rows.length) return { status: 422, body: { error: "validation", fields: { assigned_seller_id: "not found" } } };
  }
  const keys = Object.keys(fields);
  const { rowCount } = await query(
    `UPDATE leads SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = now() WHERE id = $1`,
    [id, ...keys.map((k) => fields[k])],
  );
  if (!rowCount) return { status: 404, body: { error: "not found" } };
  return { status: 200, body: await getLead(id) };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!isAdmin(req)) return sendJson(res, 401, { error: "unauthorized" });
  const q = req.query || {};
  try {
    if (q.id !== undefined && !ID_RE.test(String(q.id))) return sendJson(res, 400, { error: "invalid id" });
    if (req.method === "GET") {
      if (q.id) {
        const lead = await getLead(q.id);
        return lead ? sendJson(res, 200, lead) : sendJson(res, 404, { error: "not found" });
      }
      if (q.format === "csv") {
        const { where, params, errors } = buildFilters(q);
        if (Object.keys(errors).length) return sendJson(res, 422, { error: "validation", fields: errors });
        const { rows } = await query(`${LIST_SQL} ${where} ORDER BY l.created_at DESC, l.id DESC LIMIT 20000`, params);
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="leads-${new Date().toISOString().slice(0, 10)}.csv"`);
        return res.end("﻿" + toCsv(rows));
      }
      const result = await listAdminLeads(q);
      if (result.errors) return sendJson(res, 422, { error: "validation", fields: result.errors });
      return sendJson(res, 200, result);
    }
    if (req.method === "PATCH") {
      if (!q.id) return sendJson(res, 400, { error: "id required" });
      const r = await patchLead(q.id, req.body);
      return sendJson(res, r.status, r.body);
    }
    res.setHeader("Allow", "GET, PATCH");
    return sendJson(res, 405, { error: "method not allowed" });
  } catch (err) {
    console.error(err);
    return sendJson(res, 500, { error: "server error" });
  }
}
