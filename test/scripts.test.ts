import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, test } from "node:test";
import { sha256 } from "../opencomputer/agents/funding/lib/formd";
import { runLookup } from "../opencomputer/agents/funding/lib/lookup";
import { buildPersistencePlan, verificationQuery } from "../opencomputer/agents/funding/lib/persist";
import { UnavailableProvider } from "../opencomputer/agents/funding/lib/research-provider";
import { readCode, writeCode } from "../opencomputer/agents/funding/lib/scripts";
import { SecClient, resetSecClientState } from "../opencomputer/agents/funding/lib/sec-http";
import { createWatch, dueWatches, listWatches, watchRunStatements } from "../opencomputer/agents/funding/lib/watch";
import { quillworkSec, quillworkSite } from "./fixtures/quillwork";
import { testConfig } from "./fixtures/world";

// Runs generated Code Mode code the way the runtime's execute tool does, with a
// fake `tools.database` backed by SQLite and the real migration.

beforeEach(() => resetSecClientState());

function harness() {
  const d = new DatabaseSync(":memory:");
  d.exec(readFileSync(new URL("../opencomputer/database/migrations/001_initial.sql", import.meta.url), "utf8"));
  const asRows = (rows: any[]) => ({ columns: rows[0] ? Object.keys(rows[0]) : [], rows: rows.map((r) => Object.values(r)) });
  const tools: any = {
    database: {
      execute: async (s: any) => d.prepare(s.sql).run(...s.parameters),
      query: async (s: any) => asRows(d.prepare(s.sql).all(...s.parameters) as any[]),
    },
  };
  const exec = (code: string) => new Function("tools", `return (async () => {\n${code}\n})()`)(tools);
  return { d, tools, exec };
}

async function realReport(id: string) {
  const sec = quillworkSec();
  const web = quillworkSite();
  return runLookup({ url: "quillwork.example", lookupId: id }, { config: testConfig(), sec: new SecClient({ userAgent: "t ops@research.example", requestsPerSecond: 2, fetchFn: sec.fetchFn, sleep: async () => {} }), research: new UnavailableProvider("off"), hop: web.hop, resolve: web.resolve });
}

test("persist code writes a real lookup and the app-side hash check passes", async () => {
  const h = harness();
  const r = await realReport("lk_s1");
  const plan = buildPersistencePlan(r, "owner-a", "sess");
  const code = writeCode(plan.statements, verificationQuery("owner-a", r.lookupId));
  assert.ok(code.length < 40_000, `persist code is ${code.length} chars`);
  assert.doesNotMatch(code, /\\\\"/, "no double-escaped JSON for the model to copy");
  const out = await h.exec(code);
  assert.deepEqual(out.writes.failed, []);
  assert.equal(out.verification.report_sha256, plan.reportSha256);
  // What the trusted app does: recompute the hash of the stored report text.
  const row: any = h.d.prepare("SELECT report_json FROM lookup_runs WHERE owner_id = ? AND id = ?").get("owner-a", "lk_s1");
  assert.equal(sha256(row.report_json), plan.reportSha256);
  const cand: any = h.d.prepare("SELECT reasons_json FROM entity_candidates WHERE cik = '0000900010'").get();
  assert.ok(Array.isArray(JSON.parse(cand.reasons_json)), "JSON columns hold JSON text");
  // Running the same code again is idempotent.
  const again = await h.exec(code);
  assert.deepEqual(again.writes.failed, []);
  assert.equal((h.d.prepare("SELECT COUNT(*) n FROM lookup_runs").get() as any).n, 1);
});

test("a copy error in the report literal is detected by the hash check", async () => {
  const h = harness();
  const r = await realReport("lk_s2");
  const plan = buildPersistencePlan(r, "owner-a", "sess");
  const tampered = writeCode(plan.statements, verificationQuery("owner-a", r.lookupId)).replace('"status":"financing_found"', '"status":"nothing_found_in_completed_searches"');
  await h.exec(tampered);
  const row: any = h.d.prepare("SELECT report_json FROM lookup_runs WHERE id = 'lk_s2'").get();
  assert.notEqual(sha256(row.report_json), plan.reportSha256);
});

test("code asks for a retry while the database tools are not loaded", async () => {
  const h = harness();
  h.tools.database = { query: async () => { throw new Error("Unknown tool 'database.query'"); }, execute: async () => { throw new Error("Unknown tool"); } };
  assert.deepEqual(await h.exec(writeCode([])), { retry: true, reason: "database tools not loaded yet; run the same code again" });
});

test("read code returns named, owner-scoped rows", async () => {
  const h = harness();
  const w = createWatch("owner-a", "quillwork.example", "2026-10-01T00:00:00Z");
  await h.exec(writeCode([w.statement]));
  const mine = await h.exec(readCode([{ name: "watches", statement: listWatches("owner-a") }]));
  const theirs = await h.exec(readCode([{ name: "watches", statement: listWatches("owner-b") }]));
  assert.equal(mine.watches.length, 1);
  assert.equal(mine.watches[0].canonical_domain, "quillwork.example");
  assert.equal(theirs.watches.length, 0);
});

test("dispatcher code path: baseline run creates no outbox rows", async () => {
  const h = harness();
  const w = createWatch("owner-a", "quillwork.example", "2026-10-01T00:00:00Z");
  await h.exec(writeCode([w.statement]));
  const due = await h.exec(readCode([{ name: "due", statement: dueWatches("2026-10-05T00:00:00Z", 5) }]));
  assert.equal(due.due[0].owner_id, "owner-a");
  const r = await realReport("lk_s3");
  const out = await h.exec(writeCode([...buildPersistencePlan(r, "owner-a", "s", "watch").statements, ...watchRunStatements("owner-a", w.watchId, r)]));
  assert.deepEqual(out.writes.failed, []);
  assert.ok((h.d.prepare("SELECT COUNT(*) n FROM watch_events WHERE is_baseline = 1").get() as any).n > 0);
  assert.equal((h.d.prepare("SELECT COUNT(*) n FROM outbox").get() as any).n, 0);
});

test("generated code uses only Code Mode-supported syntax", async () => {
  const r = await realReport("lk_s4");
  const code = writeCode(buildPersistencePlan(r, "o", "s").statements, verificationQuery("o", "lk_s4"));
  const structure = code.replace(/"(?:[^"\\]|\\.)*"/g, '""'); // ignore data inside string literals
  assert.doesNotMatch(structure, /\bthis\b|\bfunction\b|\bclass\b|\bimport\b|\brequire\(/);
});
