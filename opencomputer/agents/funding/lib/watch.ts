import { createHash } from "node:crypto";
import type { Statement } from "./persist";
import type { LookupReport } from "./types";
import { canonicalDomain, normalizeInputUrl } from "./url-safety";

// Optional monitoring. A watch exists only after an explicit opt-in. A shared,
// code-defined daily schedule processes enabled watches; there is no runtime
// cron creation. Notifications stay disabled (outbox rows 'held') until a
// destination is approved by the owner and delivery is implemented and verified.

export const HELD_DESTINATION = "unapproved";

export function watchId(ownerId: string, domain: string) {
  return "w:" + createHash("sha256").update(`${ownerId}|${domain}`).digest("hex").slice(0, 16);
}

export function createWatch(ownerId: string, url: string, now: string): { statement: Statement; watchId: string; domain: string } {
  const u = normalizeInputUrl(url);
  const domain = canonicalDomain(u);
  const id = watchId(ownerId, domain);
  return {
    watchId: id,
    domain,
    statement: {
      sql: "INSERT INTO watches (owner_id, id, company_url, canonical_domain, enabled, cadence, notifications_enabled, destination, created_at) VALUES (?, ?, ?, ?, 1, 'daily', 0, NULL, ?) ON CONFLICT(owner_id, canonical_domain) DO UPDATE SET enabled = 1, disabled_at = NULL, company_url = excluded.company_url",
      parameters: [ownerId, id, u.toString(), domain, now],
    },
  };
}

export function listWatches(ownerId: string): Statement {
  return {
    sql: "SELECT id, company_url, canonical_domain, enabled, cadence, notifications_enabled, destination, last_run_at, last_lookup_id, baseline_lookup_id, created_at, disabled_at FROM watches WHERE owner_id = ? ORDER BY created_at DESC LIMIT 100",
    parameters: [ownerId],
  };
}

export function disableWatch(ownerId: string, id: string, now: string): Statement {
  return { sql: "UPDATE watches SET enabled = 0, disabled_at = ? WHERE owner_id = ? AND id = ?", parameters: [now, ownerId, id] };
}

/** Dispatcher: enabled watches not run in the last 20 hours, oldest first. */
export function dueWatches(now: string, limit = 10): Statement {
  return {
    sql: "SELECT owner_id, id, company_url FROM watches WHERE enabled = 1 AND (last_run_at IS NULL OR last_run_at < ?) ORDER BY COALESCE(last_run_at, '') ASC LIMIT ?",
    parameters: [new Date(Date.parse(now) - 20 * 3600_000).toISOString(), limit],
  };
}

/** Deterministic finding keys: same finding on a later run converges on the same row. */
export function findingEvents(r: LookupReport): { key: string; kind: string; summary: string }[] {
  const out: { key: string; kind: string; summary: string }[] = [];
  const verified = new Set(r.issuers.verified.map((v) => v.cik));
  for (const f of r.filings.filter((f) => verified.has(f.cik))) out.push({ key: `filing:${f.accession}`, kind: f.form === "D/A" ? "sec_update" : "sec_notice", summary: `${f.form} ${f.accession} filed ${f.filingDate} by ${f.issuerName}` });
  for (const a of r.announcements) out.push({ key: `ann:${a.id}`, kind: a.sourceKind, summary: `${a.title ?? a.url} (${a.publishedAt ?? "date unknown"})` });
  for (const c of r.issuers.review) out.push({ key: `candidate:${c.cik}`, kind: "entity_review", summary: `Candidate issuer ${c.name} (CIK ${c.cik}) needs review` });
  return out;
}

export function watchRunStatements(ownerId: string, watch: string, r: LookupReport): Statement[] {
  const events = findingEvents(r).map((e) => ({ id: "ev:" + createHash("sha256").update(`${ownerId}|${watch}|${e.key}`).digest("hex").slice(0, 20), event_key: e.key, kind: e.kind, summary: e.summary.slice(0, 300) }));
  const statements: Statement[] = [];
  if (events.length) {
    // First run of a watch records a baseline: existing findings are not alerts.
    statements.push({
      sql: "INSERT INTO watch_events (owner_id, id, watch_id, event_key, kind, summary, is_baseline, lookup_id, created_at) SELECT ?, json_extract(value, '$.id'), ?, json_extract(value, '$.event_key'), json_extract(value, '$.kind'), json_extract(value, '$.summary'), CASE WHEN (SELECT baseline_lookup_id FROM watches WHERE owner_id = ? AND id = ?) IS NULL THEN 1 ELSE 0 END, ?, ? FROM json_each(?) WHERE true ON CONFLICT(owner_id, watch_id, event_key) DO NOTHING",
      parameters: [ownerId, watch, ownerId, watch, r.lookupId, r.checkedAt, JSON.stringify(events)],
    });
    // Non-baseline events from this run get a held outbox row (unique per event+destination).
    statements.push({
      sql: "INSERT INTO outbox (owner_id, id, event_id, destination, status, attempts, created_at, updated_at) SELECT owner_id, 'ob:' || id, id, ?, 'held', 0, ?, ? FROM watch_events WHERE owner_id = ? AND watch_id = ? AND lookup_id = ? AND is_baseline = 0 ON CONFLICT(owner_id, event_id, destination) DO NOTHING",
      parameters: [HELD_DESTINATION, r.checkedAt, r.checkedAt, ownerId, watch, r.lookupId],
    });
  }
  statements.push({
    sql: "UPDATE watches SET last_run_at = ?, last_lookup_id = ?, baseline_lookup_id = COALESCE(baseline_lookup_id, ?) WHERE owner_id = ? AND id = ?",
    parameters: [r.checkedAt, r.lookupId, r.lookupId, ownerId, watch],
  });
  return statements;
}
