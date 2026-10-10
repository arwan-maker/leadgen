// Listing sync: pulls changed listings from each feed into `listings`, a few pages per invocation.
// Incremental runs resume from the newest modified_at of the source. Once a day (or on demand) a
// full pass walks the whole feed, possibly over several invocations, then deactivates listings it
// didn't see. A full pass is one sync_runs row with source '<source>:full' that stays unfinished
// (finished_at NULL) until the walk reaches the end.
import { query } from "../db.js";
import * as ddf from "./ddf.js";
import * as proptx from "./proptx.js";

export const SOURCES = [ddf, proptx];
const FULL_EVERY_HOURS = 20; // DDF rule 5(b): refresh and drop stale listings at least every 24 hours

const COLUMNS = ["source", "source_key", "mls_number", "status", "transaction_type", "property_type", "address",
  "city", "area", "postal_code", "latitude", "longitude", "price", "bedrooms", "bathrooms", "sqft", "description",
  "photo_urls", "listing_url", "office_name", "agent_name", "modified_at", "raw"];
const KEEP_IF_NULL = ["office_name", "agent_name"];

// Inserts or updates listings (all from one source). Returns the number written.
export async function upsertListings(rows) {
  const unique = [...new Map(rows.map((r) => [`${r.source}|${r.source_key}`, r])).values()];
  if (!unique.length) return 0;
  const values = [];
  const tuples = unique.map((row) => `(${COLUMNS.map((c) => {
    const v = row[c] ?? null;
    values.push(c === "photo_urls" ? JSON.stringify(v || []) : c === "raw" && v ? JSON.stringify(v) : v);
    return `$${values.length}`;
  }).join(", ")})`);
  const updates = COLUMNS.filter((c) => c !== "source" && c !== "source_key")
    .map((c) => (KEEP_IF_NULL.includes(c) ? `${c} = COALESCE(EXCLUDED.${c}, listings.${c})` : `${c} = EXCLUDED.${c}`));
  const { rowCount } = await query(
    `INSERT INTO listings (${COLUMNS.join(", ")}) VALUES ${tuples.join(", ")}
     ON CONFLICT (source, source_key) DO UPDATE SET ${updates.join(", ")}, last_seen_at = now(), updated_at = now()`,
    values,
  );
  return rowCount;
}

// Marks active listings of a source not seen since `since` as inactive.
export async function deactivateUnseen(source, since) {
  const { rowCount } = await query(
    `UPDATE listings SET status = 'inactive', updated_at = now()
     WHERE source = $1 AND status = 'active' AND last_seen_at < $2`,
    [source, since],
  );
  return rowCount;
}

// Deletes every listing of a source, e.g. when feed access ends (DDF rule 8(e)). Returns the count.
export async function purgeSource(source) {
  const { rowCount } = await query("DELETE FROM listings WHERE source = $1", [source]);
  return rowCount;
}

async function fullPass(source, wantFull) {
  const label = `${source}:full`;
  await query(
    `UPDATE sync_runs SET finished_at = now(), error = 'abandoned'
     WHERE source = $1 AND finished_at IS NULL AND started_at < now() - interval '2 days'`,
    [label],
  );
  const open = await query(
    "SELECT id, started_at, fetched FROM sync_runs WHERE source = $1 AND finished_at IS NULL ORDER BY id DESC LIMIT 1",
    [label],
  );
  if (open.rows[0]) return open.rows[0];
  const last = await query(
    "SELECT max(finished_at) AS at FROM sync_runs WHERE source = $1 AND finished_at IS NOT NULL AND error IS NULL",
    [label],
  );
  const due = !last.rows[0].at || Date.now() - last.rows[0].at.getTime() > FULL_EVERY_HOURS * 3600_000;
  if (!wantFull && !due) return null;
  const { rows } = await query("INSERT INTO sync_runs (source) VALUES ($1) RETURNING id, started_at, fetched", [label]);
  return rows[0];
}

// Syncs one source within a budget of pages and time. Returns a summary of the run.
export async function syncSource(client, { full = false, maxPages = 40, deadline = Date.now() + 45_000 } = {}) {
  const pass = await fullPass(client.source, full);
  const run = pass ?? (await query("INSERT INTO sync_runs (source) VALUES ($1) RETURNING id, started_at", [client.source])).rows[0];
  const latest = await query(
    `SELECT modified_at FROM listings WHERE source = $1 AND modified_at IS NOT NULL
     ${pass ? "AND last_seen_at >= $2" : ""} ORDER BY modified_at DESC LIMIT 1`,
    pass ? [client.source, pass.started_at] : [client.source],
  );
  let cursor = latest.rows[0] ? { ts: latest.rows[0].modified_at.toISOString(), key: null } : null;
  let pages = 0, fetched = 0, upserted = 0, deactivated = 0, done = false, error = null;
  try {
    while (pages < maxPages && Date.now() < deadline) {
      const items = await client.fetchPage({ cursor, full: Boolean(pass) });
      pages++;
      fetched += items.length;
      upserted += await upsertListings(await client.mapPage(items));
      if (items.length < client.pageSize) { done = true; break; }
      const last = items.at(-1);
      cursor = { ts: last.ModificationTimestamp, key: String(last.ListingKey) };
    }
    // An empty feed is more likely an outage than every listing gone, so it never deactivates.
    if (pass && done && Number(pass.fetched) + fetched > 0) deactivated = await deactivateUnseen(client.source, pass.started_at);
  } catch (err) {
    console.error(`listing sync ${client.source} failed`, err);
    error = String(err.message || err).slice(0, 1000);
  }
  await query(
    `UPDATE sync_runs SET fetched = fetched + $2, upserted = upserted + $3, deactivated = deactivated + $4, error = $5,
       finished_at = CASE WHEN $6 THEN now() ELSE finished_at END
     WHERE id = $1`,
    [run.id, fetched, upserted, deactivated, error, !pass || (done && !error)],
  );
  return { source: client.source, mode: pass ? "full" : "incremental", complete: done, pages, fetched, upserted, deactivated, error };
}

// Syncs every configured source. Sources without credentials are skipped.
export async function syncListings({ full = false, maxPages = 40, deadline = Date.now() + 45_000, sources = SOURCES } = {}) {
  const results = [];
  let left = sources.filter((c) => c.enabled()).length;
  for (const client of sources) {
    if (!client.enabled()) { results.push({ source: client.source, skipped: "not configured" }); continue; }
    const share = Date.now() + (deadline - Date.now()) / left--; // split the time between the sources
    results.push(await syncSource(client, { full, maxPages, deadline: share }));
  }
  return results;
}
