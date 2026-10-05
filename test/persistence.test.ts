import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { DEV_TOKEN, signOwner, verifyOwner } from "../opencomputer/agents/funding/lib/owner";
import { buildPersistencePlan, storedReport, verificationQuery, type Statement } from "../opencomputer/agents/funding/lib/persist";
import { sha256 } from "../opencomputer/agents/funding/lib/formd";
import { createWatch, disableWatch, dueWatches, listWatches, watchRunStatements } from "../opencomputer/agents/funding/lib/watch";
import type { LookupReport } from "../opencomputer/agents/funding/lib/types";

// Executes the generated statements against SQLite with the real migration, the
// same way the model executes them through database_execute.

function db() {
  const d = new DatabaseSync(":memory:");
  d.exec(readFileSync(new URL("../opencomputer/database/migrations/001_initial.sql", import.meta.url), "utf8"));
  return d;
}
const run = (d: DatabaseSync, s: Statement) => d.prepare(s.sql).run(...(s.parameters as any[]));
const all = (d: DatabaseSync, s: Statement) => d.prepare(s.sql).all(...(s.parameters as any[])) as any[];

function report(id: string, accessions: string[] = ["0000900010-25-000001"], at = "2026-10-05T12:00:00Z"): LookupReport {
  const filings = accessions.map((acc, i) => ({
    accession: acc, form: "D" as const, cik: "0000900010", issuerName: "Quillwork Labs, Inc.", filingDate: "2025-04-30", sourceUrl: `https://www.sec.gov/Archives/edgar/data/900010/${acc.replace(/-/g, "")}/primary_doc.xml`, indexUrl: "https://www.sec.gov/x/index.json", sha256: "ab".repeat(32), fetchedAt: at,
    isAmendment: false, previousAccession: null, firstSale: { status: "date" as const, date: "2025-04-20" }, securities: { equity: true, debt: false, option: false, securityToBeAcquired: false, pooledFund: false, other: false, otherDescription: null }, category: "equity" as const, exemptions: ["06b"],
    offeringAmount: { kind: "value" as const, raw: "4000000", usd: "4000000" }, soldAmount: { kind: "value" as const, raw: "4000000", usd: "4000000" }, remainingAmount: { kind: "indefinite" as const, raw: "Indefinite" }, investorCount: { raw: null, value: null }, nonAccreditedInvestors: false, moreThanOneYear: false,
    relatedPersons: [{ name: "Ada Quill", roles: ["Director"], clarification: null }], jurisdiction: "DELAWARE", issuerCity: "Springfield", issuerState: "DELAWARE", previousNames: [], signatureDate: null, industryGroup: null, _i: i,
  }));
  return {
    lookupId: id, status: "financing_found", checkedAt: at,
    input: { submittedUrl: "quillwork.example", canonicalUrl: "https://quillwork.example/", canonicalDomain: "quillwork.example" },
    issuers: { verified: [{ cik: "0000900010", name: "Quillwork Labs, Inc.", status: "verified", confidence: "high", score: 90, reasons: ["r"], conflicts: [], evidenceUrls: [], formerNames: [], jurisdiction: "DE", isLikelyFund: false }], review: [{ cik: "0000900099", name: "Quillwork Labs, Inc.", status: "review", confidence: "low", score: 5, reasons: ["name only"], conflicts: ["jurisdiction"], evidenceUrls: [], formerNames: [], jurisdiction: "NV", isLikelyFund: false }] },
    lastKnownFinancing: null, competingCandidates: [], latestSecNotice: null,
    offerings: [{ id: "offering:" + accessions[0], cik: "0000900010", issuerName: "Quillwork Labs, Inc.", rootAccession: accessions[0], filings: accessions, latestAccession: accessions.at(-1)!, linkStatus: "single", category: "equity", firstSale: { status: "date", date: "2025-04-20" }, firstFilingDate: "2025-04-30", latestFilingDate: "2025-04-30", offeringAmount: { kind: "value", raw: "4000000", usd: "4000000" }, soldAmount: { kind: "value", raw: "0", usd: "0" }, remainingAmount: { kind: "absent", raw: null }, investorCount: null, changes: [], isNoticeOnly: false }],
    filings: filings as any, announcements: [{ id: "ann:1", url: "https://quillwork.example/news/x", title: "t", publishedAt: "2025-05-02", sourceKind: "company_announcement", publisher: null, amountUsd: "4000000", amountText: "$4 million", stageText: "Seed", excerpt: "e", retrievedAt: at }],
    announcementCheck: { status: "complete", matched: true, statement: "s", sourcesChecked: [] }, conflicts: [], coverageGaps: [], searched: [],
    evidence: Array.from({ length: 30 }, (_, i) => ({ id: `ev:${i}`, kind: "filed_fact" as const, url: `https://www.sec.gov/${i}`, excerpt: "x".repeat(300), sourceDate: "2025-04-30", retrievedAt: at, claims: ["c"] })),
    unknowns: [], budget: { secRequests: 1, webRequests: 1, researchRequests: 0, elapsedMs: 1, exhausted: false }, cache: { reusedEntries: 0, oldestReusedAgeSeconds: null }, disclaimer: "d",
  };
}

test("persistence plan executes against the migration and verifies by hash and counts", () => {
  const d = db();
  const r = report("lk_a");
  const p = buildPersistencePlan(r, "owner-a", "sess-1");
  assert.ok(p.statements.length >= 6);
  for (const s of p.statements) {
    assert.ok(Buffer.byteLength(s.sql) <= 32 * 1024, "SQL under 32 KiB");
    assert.ok(Buffer.byteLength(JSON.stringify(s.parameters)) <= 64 * 1024, "params under 64 KiB");
    assert.ok(s.parameters.length <= 100);
    run(d, s);
  }
  const [v] = all(d, verificationQuery("owner-a", "lk_a"));
  assert.equal(v.report_sha256, p.reportSha256);
  assert.equal(sha256(storedReport(r)), v.report_sha256);
  assert.equal(v.evidence_rows, p.expected.evidence);
  assert.equal(v.filing_rows, p.expected.filings);
  assert.equal(v.candidate_rows, 2);
  // Amounts are stored as text, not floats.
  const [o] = d.prepare("SELECT typeof(offering_amount_usd) t, offering_amount_usd v, remaining_amount_kind k FROM offerings").all() as any[];
  assert.deepEqual({ ...o }, { t: "text", v: "4000000", k: "absent" });
  // Re-running the same plan is idempotent.
  for (const s of p.statements) run(d, s);
  assert.equal((d.prepare("SELECT COUNT(*) n FROM filings").get() as any).n, 1);
});

test("tenant isolation: rows and queries are owner-scoped", () => {
  const d = db();
  for (const s of buildPersistencePlan(report("lk_a"), "owner-a", "s1").statements) run(d, s);
  for (const s of buildPersistencePlan(report("lk_b"), "owner-b", "s2").statements) run(d, s);
  assert.equal(all(d, verificationQuery("owner-b", "lk_a")).length, 0, "owner-b cannot read owner-a's run");
  assert.equal((d.prepare("SELECT COUNT(*) n FROM filings WHERE owner_id='owner-a'").get() as any).n, 1);
  assert.equal((d.prepare("SELECT COUNT(*) n FROM filings WHERE owner_id='owner-b'").get() as any).n, 1);
  for (const s of buildPersistencePlan(report("lk_a"), "owner-a", "s1").statements) assert.equal(s.parameters[0], "owner-a", "owner bound first in every write");
});

test("a later automatic lookup never overwrites the owner's candidate decision", () => {
  const d = db();
  for (const s of buildPersistencePlan(report("lk_a"), "o", "s").statements) run(d, s);
  d.prepare("UPDATE entity_candidates SET status='user_rejected' WHERE cik='0000900099'").run();
  for (const s of buildPersistencePlan(report("lk_b"), "o", "s").statements) run(d, s);
  assert.equal((d.prepare("SELECT status FROM entity_candidates WHERE cik='0000900099'").get() as any).status, "user_rejected");
});

test("owner tokens are bound to the session and cannot be forged", () => {
  const env = { OWNER_SIGNING_KEY: "k".repeat(32) };
  const t = signOwner("user_42", "sess-1", env.OWNER_SIGNING_KEY);
  assert.deepEqual(verifyOwner(t, "sess-1", env), { ok: true, ownerId: "user_42" });
  assert.equal(verifyOwner(t, "sess-2", env).ok, false, "replay into another session fails");
  assert.match(t, /^v2:user_42:[a-f0-9]{40}$/);
  const forged = t.replace("user_42", "user_1");
  assert.equal(verifyOwner(forged, "sess-1", env).ok, false, "swapping the owner id fails");
  assert.equal(verifyOwner(DEV_TOKEN, "sess-1", env).ok, false, "multi-user deployment refuses the single-owner token");
  assert.equal(verifyOwner(DEV_TOKEN, "sess-1", { ...env, DEV_SINGLE_USER: "1" }).ok, true);
  assert.equal(verifyOwner(DEV_TOKEN, "sess-1", {}).ok, true, "personal deployment without a signing key has one owner");
  assert.equal(verifyOwner("user_42", "sess-1", env).ok, false, "a bare user-supplied id is not an identity");
});

test("watches: explicit create, list, disable; baseline first, then held outbox rows, idempotent", () => {
  const d = db();
  const w = createWatch("owner-a", "https://quillwork.example/", "2026-10-01T00:00:00Z");
  run(d, w.statement);
  run(d, createWatch("owner-a", "quillwork.example", "2026-10-01T00:00:00Z").statement); // same domain converges
  assert.equal(all(d, listWatches("owner-a")).length, 1);
  assert.equal(all(d, listWatches("owner-b")).length, 0);
  assert.equal(all(d, dueWatches("2026-10-05T00:00:00Z")).length, 1);

  const r1 = report("lk_1", ["0000900010-25-000001"]);
  for (const s of watchRunStatements("owner-a", w.watchId, r1)) run(d, s);
  assert.equal((d.prepare("SELECT COUNT(*) n FROM watch_events WHERE is_baseline=1").get() as any).n, 3, "first run is a baseline (filing, announcement, review candidate)");
  assert.equal((d.prepare("SELECT COUNT(*) n FROM outbox").get() as any).n, 0, "no alerts for baseline");
  assert.equal(all(d, dueWatches("2026-10-05T13:00:00Z")).length, 0, "not due again within 20h");

  const r2 = report("lk_2", ["0000900010-25-000001", "0000900010-26-000005"], "2026-10-06T12:00:00Z");
  for (const s of watchRunStatements("owner-a", w.watchId, r2)) run(d, s);
  for (const s of watchRunStatements("owner-a", w.watchId, r2)) run(d, s); // retry is safe
  const ob = d.prepare("SELECT status, destination FROM outbox").all() as any[];
  assert.equal(ob.length, 1, "exactly one new finding queued");
  assert.deepEqual({ ...ob[0] }, { status: "held", destination: "unapproved" }, "held until a destination is approved; never marked delivered");
  assert.equal((d.prepare("SELECT COUNT(*) n FROM delivery_receipts").get() as any).n, 0);

  run(d, disableWatch("owner-b", w.watchId, "2026-10-07T00:00:00Z"));
  assert.equal((d.prepare("SELECT enabled FROM watches").get() as any).enabled, 1, "another owner cannot disable it");
  run(d, disableWatch("owner-a", w.watchId, "2026-10-07T00:00:00Z"));
  assert.equal(all(d, dueWatches("2026-10-09T00:00:00Z")).length, 0);
});

test("lookup ids are unique per session and tool call without relying on randomness", async () => {
  const { lookupIdFor } = await import("../opencomputer/agents/funding/lib/runtime");
  assert.notEqual(lookupIdFor("s1", "c1"), lookupIdFor("s2", "c1"));
  assert.notEqual(lookupIdFor("s1", "c1"), lookupIdFor("s1", "c2"));
  assert.equal(lookupIdFor("s1", "c1"), lookupIdFor("s1", "c1"), "a retried call converges");
  assert.match(lookupIdFor("s", "c"), /^lk_[a-f0-9]{20}$/);
});
