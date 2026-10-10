import { query } from "../../lib/db.js";
import { isAdmin, sendJson } from "../../lib/http.js";
import { AREAS } from "../../lib/areas.js";

// Admin sellers (realtors who receive leads). Authorization: Bearer $ADMIN_TOKEN
// GET   /api/admin/sellers            list (active first)
// POST  /api/admin/sellers            { name, email, phone, areas, notify_email, notify_sms, active }
// PATCH /api/admin/sellers?id=123     any of the same fields; there is no delete, set active=false
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const E164_RE = /^\+[1-9]\d{7,14}$/;
const ID_RE = /^[1-9]\d{0,17}$/;
const COLUMNS = "id, created_at, name, email, phone, areas, notify_email, notify_sms, active";
const BOOLS = ["notify_email", "notify_sms", "active"];

// Validates a seller. partial=true for PATCH (only given fields). Returns { fields, errors }.
export function validateSeller(body, { partial = false } = {}) {
  const fields = {}, errors = {};
  if (!body || typeof body !== "object" || Array.isArray(body)) return { fields, errors: { body: "invalid" } };
  const has = (k) => !partial || k in body;
  if (has("name")) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) errors.name = "required";
    else if (name.length > 120) errors.name = "too long";
    else fields.name = name;
  }
  for (const [key, re, max] of [["email", EMAIL_RE, 200], ["phone", E164_RE, 16]]) {
    if (!has(key)) continue;
    const v = body[key] == null ? "" : typeof body[key] === "string" ? body[key].trim() : null;
    if (v === null || (v && (v.length > max || !re.test(v)))) errors[key] = "invalid";
    else fields[key] = v || null;
  }
  if (has("areas")) {
    const areas = body.areas ?? [];
    if (!Array.isArray(areas) || !areas.every((a) => AREAS.includes(a))) errors.areas = "invalid";
    else fields.areas = [...new Set(areas)];
  }
  for (const key of BOOLS) {
    if (!(key in body)) continue;
    typeof body[key] === "boolean" ? (fields[key] = body[key]) : (errors[key] = "invalid");
  }
  if (!partial && !errors.email && !errors.phone && !fields.email && !fields.phone) errors.contact = "email or phone required";
  if (partial && !Object.keys(fields).length && !Object.keys(errors).length) errors.body = "nothing to update";
  return { fields, errors };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!isAdmin(req)) return sendJson(res, 401, { error: "unauthorized" });
  const q = req.query || {};
  try {
    if (req.method === "GET") {
      const { rows } = await query(`SELECT ${COLUMNS} FROM sellers ORDER BY active DESC, name, id`);
      return sendJson(res, 200, rows);
    }
    if (req.method === "POST") {
      const { fields, errors } = validateSeller(req.body);
      if (Object.keys(errors).length) return sendJson(res, 422, { error: "validation", fields: errors });
      const keys = Object.keys(fields);
      const { rows } = await query(
        `INSERT INTO sellers (${keys.join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING ${COLUMNS}`,
        keys.map((k) => fields[k]),
      );
      return sendJson(res, 201, rows[0]);
    }
    if (req.method === "PATCH") {
      if (!ID_RE.test(String(q.id ?? ""))) return sendJson(res, 400, { error: "invalid id" });
      const { fields, errors } = validateSeller(req.body, { partial: true });
      if (Object.keys(errors).length) return sendJson(res, 422, { error: "validation", fields: errors });
      const current = await query("SELECT email, phone FROM sellers WHERE id = $1", [q.id]);
      if (!current.rows[0]) return sendJson(res, 404, { error: "not found" });
      const merged = { ...current.rows[0], ...fields };
      if (!merged.email && !merged.phone) return sendJson(res, 422, { error: "validation", fields: { contact: "email or phone required" } });
      const keys = Object.keys(fields);
      const { rows } = await query(
        `UPDATE sellers SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")} WHERE id = $1 RETURNING ${COLUMNS}`,
        [q.id, ...keys.map((k) => fields[k])],
      );
      if (!rows[0]) return sendJson(res, 404, { error: "not found" });
      return sendJson(res, 200, rows[0]);
    }
    res.setHeader("Allow", "GET, POST, PATCH");
    return sendJson(res, 405, { error: "method not allowed" });
  } catch (err) {
    console.error(err);
    return sendJson(res, 500, { error: "server error" });
  }
}
