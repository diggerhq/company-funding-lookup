import { sha256 } from "./formd";
import type { LookupReport } from "./types";

// Persistence plan. Tool code cannot reach the project database directly in
// @opencomputer/agent 0.8: only the model's `database_execute` tool can write.
// So writes are generated here, deterministically, as parameterized statements
// that bulk-load JSON through json_each(). The model copies them verbatim; the
// app verifies the result (row counts and report_sha256) through the read-only
// management query API. Corruption in transit shows up as a hash mismatch.

export type Statement = {
  sql: string;
  parameters: (string | number | null)[];
  /** Indexes of parameters that are JSON text; code generation emits them as JSON.stringify(<literal>) so nothing is double-escaped. */
  jsonParams?: number[];
};

const CHUNK_BYTES = 7_000; // keep each statement small so copying stays reliable

export function companyId(domain: string) {
  return "co:" + sha256(domain.toLowerCase()).slice(0, 16);
}

function chunked<T>(rows: T[]): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let size = 2;
  for (const r of rows) {
    const s = JSON.stringify(r).length + 1;
    if (cur.length && size + s > CHUNK_BYTES) {
      out.push(cur);
      cur = [];
      size = 2;
    }
    cur.push(r);
    size += s;
  }
  if (cur.length) out.push(cur);
  return out;
}

function bulk(table: string, cols: string[], conflict: string, rows: Record<string, unknown>[], ownerId: string): Statement[] {
  const select = cols.map((c) => `json_extract(value, '$.${c}')`).join(", ");
  const sql = `INSERT INTO ${table} (owner_id, ${cols.join(", ")}) SELECT ?, ${select} FROM json_each(?) WHERE true ${conflict}`;
  return chunked(rows).map((chunk) => ({ sql, parameters: [ownerId, JSON.stringify(chunk)], jsonParams: [1] }));
}

const upsert = (keys: string[], cols: string[]) => `ON CONFLICT(${["owner_id", ...keys].join(", ")}) DO UPDATE SET ${cols.filter((c) => !keys.includes(c)).map((c) => `${c} = excluded.${c}`).join(", ")}`;

/**
 * Report body stored in lookup_runs. Filings, offerings, candidates and evidence
 * have their own tables, so this keeps the decision-level fields only.
 */
export function storedReport(r: LookupReport): string {
  return JSON.stringify({
    lookupId: r.lookupId,
    status: r.status,
    checkedAt: r.checkedAt,
    input: r.input,
    verifiedCiks: r.issuers.verified.map((v) => v.cik),
    reviewCiks: r.issuers.review.map((v) => v.cik),
    lastKnownFinancing: r.lastKnownFinancing,
    competingCandidates: r.competingCandidates.map((c) => c.statement),
    latestSecNotice: r.latestSecNotice,
    announcementCheck: { status: r.announcementCheck.status, statement: r.announcementCheck.statement, sourcesChecked: r.announcementCheck.sourcesChecked.slice(0, 8) },
    announcements: r.announcements.slice(0, 6).map((a) => ({ url: a.url, publishedAt: a.publishedAt, sourceKind: a.sourceKind, amountUsd: a.amountUsd, stageText: a.stageText })),
    conflicts: r.conflicts.slice(0, 10),
    coverageGaps: r.coverageGaps.slice(0, 12),
    searched: r.searched.slice(0, 10),
    unknowns: r.unknowns,
    budget: r.budget,
    cache: r.cache,
  });
}

export function buildPersistencePlan(r: LookupReport, ownerId: string, sessionId: string, trigger: "check" | "watch" = "check") {
  if (!r.input.canonicalDomain) return { statements: [] as Statement[], reportSha256: null, expected: {} as Record<string, number>, companyId: null };
  const cid = companyId(r.input.canonicalDomain);
  const at = r.checkedAt;
  const reportJson = storedReport(r);
  const reportSha256 = sha256(reportJson);
  const statements: Statement[] = [];

  statements.push({
    sql: "INSERT INTO companies (owner_id, id, canonical_domain, submitted_url, canonical_url, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(owner_id, id) DO UPDATE SET submitted_url = excluded.submitted_url, canonical_url = excluded.canonical_url, display_name = COALESCE(excluded.display_name, companies.display_name), updated_at = excluded.updated_at",
    parameters: [ownerId, cid, r.input.canonicalDomain, r.input.submittedUrl, r.input.canonicalUrl, r.issuers.verified[0]?.name ?? null, at, at],
  });

  statements.push({
    sql: "INSERT INTO lookup_runs (owner_id, id, company_id, session_id, submitted_url, canonical_url, status, checked_at, trigger, report_json, report_sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(owner_id, id) DO NOTHING",
    parameters: [ownerId, r.lookupId, cid, sessionId, r.input.submittedUrl, r.input.canonicalUrl, r.status, at, trigger, reportJson, reportSha256, at],
    jsonParams: [9],
  });

  const candCols = ["company_id", "cik", "name", "status", "confidence", "score", "reasons_json", "conflicts_json", "evidence_urls_json", "last_lookup_id", "updated_at"];
  const candRows = [...r.issuers.verified, ...r.issuers.review].map((c) => ({
    company_id: cid, cik: c.cik, name: c.name, status: c.status, confidence: c.confidence, score: c.score,
    reasons_json: c.reasons.slice(0, 6), conflicts_json: c.conflicts, evidence_urls_json: c.evidenceUrls, last_lookup_id: r.lookupId, updated_at: at,
  }));
  // A user's confirm/reject decision is never overwritten by a later automatic lookup.
  const candConflict = `ON CONFLICT(owner_id, company_id, cik) DO UPDATE SET name = excluded.name, confidence = excluded.confidence, score = excluded.score, reasons_json = excluded.reasons_json, conflicts_json = excluded.conflicts_json, evidence_urls_json = excluded.evidence_urls_json, last_lookup_id = excluded.last_lookup_id, updated_at = excluded.updated_at, status = CASE WHEN entity_candidates.status IN ('user_confirmed','user_rejected') THEN entity_candidates.status ELSE excluded.status END`;
  statements.push(...bulk("entity_candidates", candCols, candConflict, candRows, ownerId));

  const verifiedCiks = new Set(r.issuers.verified.map((v) => v.cik));
  const filingCols = ["accession", "company_id", "cik", "issuer_name", "form", "filing_date", "attribution", "source_url", "index_url", "sha256", "fetched_at", "is_amendment", "previous_accession", "first_sale_status", "first_sale_date", "category", "securities_json", "exemptions_json", "offering_amount_raw", "offering_amount_kind", "sold_amount_raw", "sold_amount_kind", "remaining_amount_raw", "remaining_amount_kind", "investor_count_raw", "related_persons_json", "jurisdiction", "last_lookup_id"];
  const filingRows = r.filings.map((f) => ({
    accession: f.accession, company_id: cid, cik: f.cik, issuer_name: f.issuerName, form: f.form, filing_date: f.filingDate,
    attribution: verifiedCiks.has(f.cik) ? "verified" : "unverified_candidate", source_url: f.sourceUrl, index_url: f.indexUrl, sha256: f.sha256, fetched_at: f.fetchedAt,
    is_amendment: f.isAmendment ? 1 : 0, previous_accession: f.previousAccession, first_sale_status: f.firstSale.status, first_sale_date: f.firstSale.status === "date" ? f.firstSale.date : null,
    category: f.category, securities_json: f.securities, exemptions_json: f.exemptions,
    offering_amount_raw: f.offeringAmount.raw, offering_amount_kind: f.offeringAmount.kind, sold_amount_raw: f.soldAmount.raw, sold_amount_kind: f.soldAmount.kind,
    remaining_amount_raw: f.remainingAmount.raw, remaining_amount_kind: f.remainingAmount.kind, investor_count_raw: f.investorCount.raw,
    related_persons_json: f.relatedPersons.slice(0, 8).map((p) => ({ name: p.name, roles: p.roles })), jurisdiction: f.jurisdiction, last_lookup_id: r.lookupId,
  }));
  statements.push(...bulk("filings", filingCols, upsert(["accession"], filingCols), filingRows, ownerId));

  const offCols = ["id", "company_id", "cik", "root_accession", "latest_accession", "accessions_json", "link_status", "category", "first_sale_status", "first_sale_date", "first_filing_date", "latest_filing_date", "offering_amount_kind", "offering_amount_raw", "offering_amount_usd", "sold_amount_kind", "sold_amount_raw", "sold_amount_usd", "remaining_amount_kind", "remaining_amount_raw", "investor_count", "is_notice_only", "changes_json", "last_lookup_id", "updated_at"];
  const offRows = r.offerings.map((o) => ({
    id: o.id, company_id: cid, cik: o.cik, root_accession: o.rootAccession, latest_accession: o.latestAccession, accessions_json: o.filings, link_status: o.linkStatus, category: o.category,
    first_sale_status: o.firstSale.status, first_sale_date: o.firstSale.status === "date" ? o.firstSale.date : null, first_filing_date: o.firstFilingDate, latest_filing_date: o.latestFilingDate,
    offering_amount_kind: o.offeringAmount.kind, offering_amount_raw: o.offeringAmount.raw, offering_amount_usd: o.offeringAmount.kind === "value" ? o.offeringAmount.usd : null,
    sold_amount_kind: o.soldAmount.kind, sold_amount_raw: o.soldAmount.raw, sold_amount_usd: o.soldAmount.kind === "value" ? o.soldAmount.usd : null,
    remaining_amount_kind: o.remainingAmount.kind, remaining_amount_raw: o.remainingAmount.raw, investor_count: o.investorCount, is_notice_only: o.isNoticeOnly ? 1 : 0,
    changes_json: o.changes.slice(0, 6), last_lookup_id: r.lookupId, updated_at: at,
  }));
  statements.push(...bulk("offerings", offCols, upsert(["id"], offCols), offRows, ownerId));

  const evCols = ["id", "lookup_id", "company_id", "kind", "url", "excerpt", "source_date", "retrieved_at", "claims_json"];
  const evRows = r.evidence.slice(0, 25).map((e) => ({ id: e.id, lookup_id: r.lookupId, company_id: cid, kind: e.kind, url: e.url, excerpt: e.excerpt.slice(0, 200), source_date: e.sourceDate, retrieved_at: e.retrievedAt, claims_json: e.claims.slice(0, 3) }));
  statements.push(...bulk("evidence", evCols, "ON CONFLICT(owner_id, lookup_id, id) DO NOTHING", evRows, ownerId));

  return {
    statements,
    reportSha256,
    companyId: cid,
    expected: { entity_candidates: candRows.length, filings: filingRows.length, offerings: offRows.length, evidence: evRows.length },
    trigger,
  };
}

/** Read-only verification query, owner-scoped. Used by the app and the CLI. */
export function verificationQuery(ownerId: string, lookupId: string): Statement {
  return {
    sql: "SELECT r.report_sha256 AS report_sha256, r.report_json AS report_json, r.status AS status, (SELECT COUNT(*) FROM evidence e WHERE e.owner_id = r.owner_id AND e.lookup_id = r.id) AS evidence_rows, (SELECT COUNT(*) FROM filings f WHERE f.owner_id = r.owner_id AND f.last_lookup_id = r.id) AS filing_rows, (SELECT COUNT(*) FROM offerings o WHERE o.owner_id = r.owner_id AND o.last_lookup_id = r.id) AS offering_rows, (SELECT COUNT(*) FROM entity_candidates c WHERE c.owner_id = r.owner_id AND c.last_lookup_id = r.id) AS candidate_rows, length(r.report_json) AS report_bytes FROM lookup_runs r WHERE r.owner_id = ? AND r.id = ?",
    parameters: [ownerId, lookupId],
  };
}
