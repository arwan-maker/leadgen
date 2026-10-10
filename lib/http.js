import { timingSafeEqual } from "node:crypto";

// Origins allowed to post leads, e.g. "https://icloudrealty.ca,https://www.icloudrealty.ca". Unset = any.
export function cors(req, res) {
  const allowed = (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.origin;
  if (!allowed.length) res.setHeader("Access-Control-Allow-Origin", "*");
  else if (origin && allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? "")), y = Buffer.from(String(b ?? ""));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

export function isAdmin(req) {
  const header = req.headers.authorization || "";
  return safeEqual(header.replace(/^Bearer /, ""), process.env.ADMIN_TOKEN);
}

export function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}
