import { query } from "./db.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const money = (n) => (n == null ? "" : "$" + Number(n).toLocaleString("en-CA", { maximumFractionDigits: 0 }));
const adminUrl = () => (process.env.APP_URL ? process.env.APP_URL.replace(/\/$/, "") + "/admin.html" : "");

function leadFields(lead) {
  return [
    ["Name", lead.name], ["Phone", lead.phone], ["Email", lead.email], ["Intent", lead.intent],
    ["Area", lead.area || lead.location], ["Budget", lead.budget], ["Message", lead.message],
    ["Source", lead.source === "google_ads" ? "Google ad" : lead.source],
  ].filter(([, v]) => v);
}

export function buildEmail(seller, lead, matches = []) {
  const fields = leadFields(lead);
  const listings = matches.map(({ listing: l }) => ({
    line: [l.address, l.city].filter(Boolean).join(", ") + (l.price != null ? ` - ${money(l.price)}${l.transaction_type === "lease" ? "/mo" : ""}` : ""),
    url: l.listing_url,
  }));
  const subject = `New ${lead.intent || ""} lead: ${lead.name || lead.phone || lead.email}`.replace(/\s+/g, " ");
  const text = [
    `Hi ${seller.name}, you have a new lead.`, "",
    ...fields.map(([k, v]) => `${k}: ${v}`),
    ...(listings.length ? ["", "Matching listings:", ...listings.map((l) => `- ${l.line}${l.url ? ` ${l.url}` : ""}`)] : []),
    ...(adminUrl() ? ["", `All leads: ${adminUrl()}`] : []),
  ].join("\n");
  const html = `<p>Hi ${esc(seller.name)}, you have a new lead.</p>
<table>${fields.map(([k, v]) => `<tr><td><b>${esc(k)}</b></td><td>${esc(v).replace(/\n/g, "<br>")}</td></tr>`).join("")}</table>
${listings.length ? `<p><b>Matching listings</b></p><ul>${listings.map((l) => `<li>${l.url ? `<a href="${esc(l.url)}">${esc(l.line)}</a>` : esc(l.line)}</li>`).join("")}</ul>` : ""}
${adminUrl() ? `<p><a href="${esc(adminUrl())}">Open the leads view</a></p>` : ""}`;
  return { subject, text, html };
}

export function buildSms(lead) {
  const what = [lead.intent, lead.area || lead.location].filter(Boolean).join(" in ");
  const head = `New lead: ${lead.name || "(no name)"}${lead.phone ? ` ${lead.phone}` : ""}${what ? ` - ${what}` : ""}`;
  const link = adminUrl() ? ` ${adminUrl()}` : "";
  return head.slice(0, 300 - link.length) + link;
}

async function sendEmail(seller, lead, matches) {
  const { RESEND_API_KEY: key, NOTIFY_FROM_EMAIL: from } = process.env;
  if (!seller.notify_email) return { status: "skipped", error: "email alerts off" };
  if (!key || !from) return { status: "skipped", error: "RESEND_API_KEY or NOTIFY_FROM_EMAIL not set" };
  if (!seller.email) return { status: "skipped", error: "seller has no email" };
  const { subject, text, html } = buildEmail(seller, lead, matches);
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [seller.email], subject, text, html }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return { status: "sent" };
}

async function sendSms(seller, lead) {
  const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, TWILIO_FROM_NUMBER: from } = process.env;
  if (!seller.notify_sms) return { status: "skipped", error: "SMS alerts off" };
  if (!sid || !token || !from) return { status: "skipped", error: "Twilio env vars not set" };
  if (!seller.phone) return { status: "skipped", error: "seller has no phone" };
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ To: seller.phone, From: from, Body: buildSms(lead) }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return { status: "sent" };
}

// Emails and texts a seller about a lead and records each attempt. Never throws.
// opts.channels limits which channels to try (default both).
export async function notifySeller(seller, lead, matches = [], { channels = ["email", "sms"] } = {}) {
  const results = [];
  for (const channel of channels) {
    let result;
    try {
      result = channel === "email" ? await sendEmail(seller, lead, matches) : await sendSms(seller, lead);
    } catch (err) {
      result = { status: "failed", error: String(err?.message || err).slice(0, 500) };
    }
    results.push({ channel, ...result });
    try {
      await query(
        "INSERT INTO notifications (lead_id, seller_id, channel, status, error) VALUES ($1, $2, $3, $4, $5)",
        [lead.id, seller.id, channel, result.status, result.error ?? null],
      );
    } catch (err) {
      console.error("notification log failed", err);
    }
  }
  return results;
}
