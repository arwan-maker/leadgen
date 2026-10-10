import { validateWebsiteLead, insertLead, listLeads } from "../lib/leads.js";
import { cors, isAdmin, sendJson } from "../lib/http.js";
import { processNewLead } from "../lib/process-lead.js";
import { allowLeadSubmission } from "../lib/ratelimit.js";

// POST /api/leads   website pop-up submissions
// GET  /api/leads   list leads (needs Authorization: Bearer $ADMIN_TOKEN)
export default async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") return sendJson(res, 204, {});
  try {
    if (req.method === "POST") {
      const body = req.body || {};
      if (body.website) return sendJson(res, 201, { ok: true }); // honeypot field that bots fill in
      if (!(await allowLeadSubmission(req, res))) return; // 5 per IP per 10 minutes, answers 429 itself
      const { lead, errors } = validateWebsiteLead(body);
      if (Object.keys(errors).length) return sendJson(res, 422, { error: "validation", fields: errors });
      const id = await insertLead(lead);
      if (id) await processNewLead(id); // match listings and alert the realtor; never throws
      return sendJson(res, 201, { ok: true, id });
    }
    if (req.method === "GET") {
      if (!isAdmin(req)) return sendJson(res, 401, { error: "unauthorized" });
      return sendJson(res, 200, await listLeads());
    }
    return sendJson(res, 405, { error: "method not allowed" });
  } catch (err) {
    console.error(err);
    return sendJson(res, 500, { error: "server error" });
  }
}
