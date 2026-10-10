import { query } from "./db.js";
import { findMatches, assignSeller, leadArea } from "./matching.js";
import { notifySeller } from "./notify.js";

// Matches a saved lead to listings, assigns a seller and alerts them. Safe to run again:
// matches aren't duplicated, the seller is kept, and channels already sent aren't resent.
// Never throws; returns a summary ({ ok: false, error } on failure).
export async function processNewLead(leadId) {
  const summary = { ok: true, leadId, area: null, matches: 0, sellerId: null, notifications: [] };
  try {
    const { rows } = await query("SELECT * FROM leads WHERE id = $1", [leadId]);
    const lead = rows[0];
    if (!lead) return { ...summary, ok: false, error: "lead not found" };

    const matches = await findMatches(lead);
    const area = leadArea(lead) || matches.find((m) => m.viewed)?.listing.area || null;
    if (area && !lead.area) {
      await query("UPDATE leads SET area = $2, updated_at = now() WHERE id = $1", [lead.id, area]);
      lead.area = area;
    }
    summary.area = area;

    if (matches.length) {
      await query(
        `INSERT INTO matches (lead_id, listing_id, score)
         SELECT $1, * FROM unnest($2::bigint[], $3::numeric[])
         ON CONFLICT (lead_id, listing_id) DO NOTHING`,
        [lead.id, matches.map((m) => m.listing.id), matches.map((m) => m.score)],
      );
    }
    summary.matches = matches.length;

    let seller = null;
    if (lead.assigned_seller_id) {
      seller = (await query("SELECT * FROM sellers WHERE id = $1", [lead.assigned_seller_id])).rows[0] ?? null;
    }
    if (!seller) {
      seller = await assignSeller(lead);
      if (seller) await query("UPDATE leads SET assigned_seller_id = $2, updated_at = now() WHERE id = $1", [lead.id, seller.id]);
    }
    summary.sellerId = seller?.id ?? null;
    if (!seller) return summary;
    if (lead.is_test) return { ...summary, skipped: "test lead" };

    const { rows: sent } = await query(
      "SELECT DISTINCT channel FROM notifications WHERE lead_id = $1 AND seller_id = $2 AND status = 'sent'",
      [lead.id, seller.id],
    );
    const channels = ["email", "sms"].filter((c) => !sent.some((r) => r.channel === c));
    if (channels.length) summary.notifications = await notifySeller(seller, lead, matches, { channels });
    return summary;
  } catch (err) {
    console.error("processNewLead failed", leadId, err);
    return { ...summary, ok: false, error: String(err?.message || err) };
  }
}
