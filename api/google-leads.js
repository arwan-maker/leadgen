import { leadFromGoogle, insertLead } from "../lib/leads.js";
import { safeEqual, sendJson } from "../lib/http.js";
import { processNewLead } from "../lib/process-lead.js";

// POST /api/google-leads   Google Ads lead form webhook.
// In Google Ads, set the webhook URL to https://YOUR-APP/api/google-leads and the key to $GOOGLE_LEADS_KEY.
export default async function handler(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { message: "method not allowed" });
  const body = req.body || {};
  if (!safeEqual(body.google_key, process.env.GOOGLE_LEADS_KEY)) {
    return sendJson(res, 403, { message: "invalid google_key" });
  }
  const lead = leadFromGoogle(body);
  if (!lead.email && !lead.phone) return sendJson(res, 400, { message: "lead has no email or phone" });
  try {
    const id = await insertLead(lead); // null for a repeat delivery of the same lead_id
    if (id) await processNewLead(id);
    return sendJson(res, 200, {});
  } catch (err) {
    console.error(err);
    return sendJson(res, 500, { message: "server error" }); // Google retries 5xx
  }
}
