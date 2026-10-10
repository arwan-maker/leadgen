import { cors, sendJson } from "../lib/http.js";

// GET /api/config   public, non-secret settings the website needs.
// creaDestinationId: our CREA Analytics Web Service DestinationID (DDF rule 5(c)); null turns the beacons off.
export default function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") return sendJson(res, 204, {});
  if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
  return sendJson(res, 200, { creaDestinationId: process.env.CREA_DESTINATION_ID || null });
}
