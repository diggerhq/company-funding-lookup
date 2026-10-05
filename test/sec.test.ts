import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { RunContext } from "../opencomputer/agents/funding/lib/run-context";
import { efts, fetchIssuer, parseCompanyList, zipRecent, formDFullTextSearch } from "../opencomputer/agents/funding/lib/sec";
import { SecClient, resetSecClientState, throttleState } from "../opencomputer/agents/funding/lib/sec-http";
import { FakeSec, testConfig } from "./fixtures/world";

beforeEach(() => resetSecClientState());

function client(fake: FakeSec, ua: string | null = "app ops@research.example", rps = 2) {
  return new SecClient({ userAgent: ua, requestsPerSecond: rps, fetchFn: fake.fetchFn, now: () => fake.clock.now, sleep: async (ms) => void (fake.clock.now += ms), random: () => 0 });
}
const ctx = (fake: FakeSec, over = {}) => new RunContext(testConfig(over).budget, () => fake.clock.now);

test("zips parallel recent-filing arrays and rejects unequal lengths", () => {
  const rows = zipRecent({ accessionNumber: ["a", "b"], filingDate: ["2026-01-01", "2025-01-01"], form: ["D", "10-K"], primaryDocument: ["x.xml", ""] });
  assert.deepEqual(rows[1], { accessionNumber: "b", filingDate: "2025-01-01", form: "10-K", primaryDocument: null });
  assert.throws(() => zipRecent({ accessionNumber: ["a", "b"], filingDate: ["2026-01-01"], form: ["D", "D"], primaryDocument: ["", ""] }), /length mismatch/);
});

test("builds EDGAR search URLs with the encodings the live endpoint requires", () => {
  const u = efts({ q: '"Synthetic Widgets, Inc."', forms: "D,D/A" });
  assert.match(u, /forms=D%2CD%2FA/);
  assert.doesNotMatch(u, /forms=D,D\/A/);
  assert.match(efts({ keysTyped: "synthetic widgets" }), /keysTyped=synthetic\+widgets$/);
});

test("reads historical submission files and processes D and D/A only", async () => {
  const fake = new FakeSec().issuer({
    cik: "900002",
    name: "Old Widgets Corp",
    filings: [{ acc: "0000900002-26-000001", date: "2026-02-01", form: "10-K" } as any],
    historyFiles: [{ name: "CIK0000900002-submissions-001.json", filings: [{ acc: "0000900002-19-000003", date: "2019-06-01", form: "D/A" } as any, { acc: "0000900002-19-000001", date: "2019-03-01" } as any] }],
  });
  const c = ctx(fake);
  const recentOnly = await fetchIssuer(client(fake), "900002", c, { includeHistory: false });
  assert.equal(recentOnly!.formDRows.length, 0);
  assert.equal(recentOnly!.coverage.complete, false);
  assert.ok(c.gaps.some((g) => g.kind === "not_searched"), "unread history is a disclosed gap");
  const full = await fetchIssuer(client(fake), "900002", ctx(fake), { includeHistory: true });
  assert.deepEqual(full!.formDRows.map((r) => r.form), ["D/A", "D"]);
  assert.equal(full!.coverage.complete, true);
});

test("throttles all SEC requests in a process to the configured rate, including concurrent runs", async () => {
  const fake = new FakeSec().json("https://data.sec.gov/a.json", {}).json("https://data.sec.gov/b.json", {}).json("https://data.sec.gov/b.json?x", {});
  fake.realTime = true;
  // Two independent clients (as two concurrent lookups in one runtime) on the real clock.
  const real = () => new SecClient({ userAgent: "app ops@research.example", requestsPerSecond: 2, fetchFn: fake.fetchFn });
  const rc = () => new RunContext(testConfig().budget);
  const a = real();
  const b = real();
  await Promise.all([a.get("https://data.sec.gov/a.json", rc(), "t"), b.get("https://data.sec.gov/b.json", rc(), "t"), a.get("https://data.sec.gov/b.json?x", rc(), "t")]);
  const times = fake.calls.map((c) => c.at).sort((x, y) => x - y);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 480, `spacing ${times[i] - times[i - 1]}ms`);
  assert.ok(fake.calls.every((c) => c.ua.includes("ops@research.example")));
});

test("never sends SEC requests without a configured contact address", async () => {
  const fake = new FakeSec().json("https://data.sec.gov/a.json", {});
  const c = ctx(fake);
  const r = await client(fake, null).get("https://data.sec.gov/a.json", c, "t");
  assert.equal(r.ok, false);
  assert.equal(fake.calls.length, 0);
  assert.ok(c.gaps.some((g) => g.kind === "unavailable" && /SEC_CONTACT_EMAIL/.test(g.detail)));
});

test("403 opens the breaker: a coverage failure, not an empty result", async () => {
  const fake = new FakeSec().set("https://data.sec.gov/a.json", { status: 403, body: "Request Rate Threshold Exceeded" }).json("https://data.sec.gov/b.json", {});
  const c = ctx(fake);
  const sec = client(fake);
  const r1 = await sec.get("https://data.sec.gov/a.json", c, "t");
  const r2 = await sec.get("https://data.sec.gov/b.json", c, "t");
  assert.equal(r1.ok, false);
  assert.equal((r1 as any).kind, "blocked");
  assert.equal(r2.ok, false, "further SEC calls stopped");
  assert.equal(fake.calls.length, 1);
  assert.ok(throttleState.blockedUntil > fake.clock.now);
});

test("429 honors Retry-After then succeeds; long Retry-After stops", async () => {
  let n = 0;
  const fake = new FakeSec().set("https://data.sec.gov/a.json", () => (n++ === 0 ? { status: 429, body: "", headers: { "retry-after": "3" } } : { status: 200, body: "{}" }));
  const c = ctx(fake);
  const t0 = fake.clock.now;
  const r = await client(fake).get("https://data.sec.gov/a.json", c, "t");
  assert.equal(r.ok, true);
  assert.ok(fake.clock.now - t0 >= 3000, "waited at least Retry-After");
  resetSecClientState();
  const fake2 = new FakeSec().set("https://data.sec.gov/a.json", { status: 429, body: "", headers: { "retry-after": "600" } });
  const c2 = ctx(fake2);
  const r2 = await client(fake2).get("https://data.sec.gov/a.json", c2, "t");
  assert.equal(r2.ok, false);
  assert.equal(fake2.calls.length, 1);
  assert.ok(c2.gaps.some((g) => g.kind === "blocked"));
});

test("timeouts retry with bounded backoff then record a timeout gap", async () => {
  const fake = new FakeSec().set("https://data.sec.gov/a.json", () => Promise.reject(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" })));
  const c = ctx(fake);
  const r = await client(fake).get("https://data.sec.gov/a.json", c, "t");
  assert.equal(r.ok, false);
  assert.equal((r as any).kind, "timeout");
  assert.equal(fake.calls.length, 3);
  assert.ok(c.gaps.some((g) => g.kind === "timeout"));
});

test("malformed JSON is a coverage failure", async () => {
  const fake = new FakeSec().set("https://data.sec.gov/a.json", { status: 200, body: "<html>maintenance</html>" });
  const c = ctx(fake);
  const r = await client(fake).getJson("https://data.sec.gov/a.json", c, "t");
  assert.equal(r.ok, false);
  assert.ok(c.gaps.some((g) => g.kind === "malformed"));
});

test("request budget exhaustion is reported", async () => {
  const fake = new FakeSec().json("https://data.sec.gov/a.json", {}).json("https://data.sec.gov/b.json", {});
  const c = ctx(fake, { secMaxRequests: 1 });
  await client(fake).get("https://data.sec.gov/a.json", c, "t");
  const r = await client(fake).get("https://data.sec.gov/b.json", c, "t");
  assert.equal((r as any).kind, "budget_exhausted");
  assert.equal(c.exhausted, true);
});

test("cache reuse is counted and its age disclosed", async () => {
  const fake = new FakeSec().json("https://data.sec.gov/a.json", { x: 1 });
  const sec = client(fake);
  await sec.get("https://data.sec.gov/a.json", ctx(fake), "t");
  fake.clock.now += 120_000;
  const c = ctx(fake);
  const r = await sec.get("https://data.sec.gov/a.json", c, "t");
  assert.equal((r as any).fromCacheAgeSeconds, 120);
  assert.equal(c.cacheReused, 1);
  assert.equal(fake.calls.length, 1);
});

test("full-text search expands beyond the recent window only when it is empty", async () => {
  const fake = new FakeSec();
  const today = "2026-10-05";
  const recentUrl = efts({ q: '"Old Widgets Corp"', forms: "D,D/A", dateRange: "custom", startdt: "2024-10-05", enddt: today });
  const allUrl = efts({ q: '"Old Widgets Corp"', forms: "D,D/A", dateRange: "custom", startdt: "2001-01-01", enddt: today });
  fake.json(recentUrl, { hits: { hits: [] } });
  fake.json(allUrl, { hits: { hits: [{ _source: { ciks: ["0000900002"], display_names: ["Old Widgets Corp  (CIK 0000900002)"], adsh: "0000900002-19-000001", form: "D", file_date: "2019-03-01" } }] } });
  const r = await formDFullTextSearch(client(fake), "Old Widgets Corp", ctx(fake), { today, recentMonths: 24, label: "t" });
  assert.equal(r.hits[0].name, "Old Widgets Corp");
  assert.deepEqual(r.ranges.map((x) => x.from), ["2024-10-05", "2001-01-01"]);
});

test("parses the official EDGAR company list fallback", () => {
  const h = `<td valign="top" scope="row"><a href="/cgi-bin/browse-edgar?action=getcompany&amp;CIK=0000900003&amp;owner=include">0000900003</a></td>\n<td scope="row">Synthetic Widgets, Inc.</td>`;
  assert.deepEqual(parseCompanyList(h, "q")[0], { cik: "0000900003", name: "Synthetic Widgets, Inc.", via: "edgar_company_list", query: "q" });
});
