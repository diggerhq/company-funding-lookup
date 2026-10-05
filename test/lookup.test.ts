import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { runLookup, type LookupDeps } from "../opencomputer/agents/funding/lib/lookup";
import { renderReport, compactReport } from "../opencomputer/agents/funding/lib/report";
import { ContextDevProvider, UnavailableProvider } from "../opencomputer/agents/funding/lib/research-provider";
import { SecClient, resetSecClientState } from "../opencomputer/agents/funding/lib/sec-http";
import { FakeSec, FakeWeb, html, testConfig } from "./fixtures/world";
import { quillworkSec, quillworkSite } from "./fixtures/quillwork";

beforeEach(() => resetSecClientState());
const NOW = Date.parse("2026-10-05T12:00:00Z");

function deps(sec: FakeSec, web: FakeWeb, research = new UnavailableProvider("context.dev not enabled") as any, budget = {}): LookupDeps {
  let t = NOW;
  return {
    config: testConfig(budget),
    sec: new SecClient({ userAgent: "test-app ops@research.example", requestsPerSecond: 2, fetchFn: sec.fetchFn, sleep: async () => {}, now: () => t }),
    research,
    hop: web.hop,
    resolve: web.resolve,
    now: () => (t += 5),
  };
}

test("URL-only onboarding resolves the issuer, rejects a same-name company, and reports the financing carefully", async () => {
  const r = await runLookup({ url: "quillwork.example", lookupId: "lk_1" }, deps(quillworkSec(), quillworkSite()));
  assert.equal(r.status, "financing_found");
  assert.deepEqual(r.issuers.verified.map((v) => v.cik), ["0000900010"]);
  assert.ok(r.issuers.verified[0].reasons.some((x) => /legal name "Quillwork Labs, Inc."/.test(x)));
  assert.ok(r.issuers.verified[0].reasons.some((x) => /Founder "Ada Quill"/.test(x)));
  assert.ok(!r.issuers.verified.some((v) => v.cik === "0000900099"), "Nevada same-name company not verified");
  assert.ok(!r.issuers.verified.some((v) => v.cik === "0000900098"), "fund not verified");
  // The D/A (2026) updates the 2025 offering; it is not a new round.
  assert.equal(r.offerings.length, 1);
  assert.equal(r.offerings[0].linkStatus, "linked_by_previous_accession");
  const f = r.lastKnownFinancing!;
  assert.equal(f.eventDate, "2025-04-20");
  assert.equal(f.dateType, "first_sale");
  assert.equal(f.amountUsd, "4000000");
  assert.equal(f.basis, "filing_and_announcement");
  assert.deepEqual(f.stage, { value: "Seed", provenance: "company_stated" });
  assert.match(f.statement, /\$4,000,000 reported sold toward a \$4,000,000 offering as of filing date 2026-08-20/);
  assert.equal(r.latestSecNotice!.form, "D/A");
  assert.equal(r.latestSecNotice!.isNewFinancing, false);
  assert.match(r.latestSecNotice!.note, /not a new round/);
  // Unavailable enrichment is honest.
  assert.equal(r.announcementCheck.status, "incomplete");
  assert.match(r.announcementCheck.statement, /incomplete.*context\.dev not enabled.*does not mean the financing is unannounced/);
  const text = renderReport(r);
  assert.match(text, /Latest SEC notice\/update/);
  assert.match(text, /not a guaranteed latest private transaction/);
  assert.doesNotMatch(text, /unannounced round|Series A led by/i);
  assert.ok(Buffer.byteLength(JSON.stringify(compactReport(r, { planned: true, tables: [] }))) <= 8192);
});

test("filing with no matching announcement uses the exact cautious wording", async () => {
  const web = quillworkSite({ news: html({ body: "<p>Product updates only.</p>" }) });
  const research = new ContextDevProvider(async (path) => ({ status: 200, json: async () => (path.includes("news") ? { data: [] } : path.includes("search") ? { results: [] } : { brand: { title: "Quillwork" } }) }));
  const r = await runLookup({ url: "https://quillwork.example", lookupId: "lk_2" }, deps(quillworkSec(), web, research));
  assert.equal(r.lastKnownFinancing!.basis, "sec_filing");
  assert.equal(r.announcementCheck.status, "complete");
  assert.match(r.announcementCheck.statement, /^No matching announcement found in checked sources as of 2026-10-05T/);
});

test("unresolved identity goes to a review queue; candidate filings are shown unverified only", async () => {
  const web = new FakeWeb().page("https://brightloom.example/", html({ title: "Brightloom", body: "<p>Looms, but bright.</p>" }));
  const sec = new FakeSec()
    .entitySearch("Brightloom", [{ cik: "900020", name: "Brightloom Inc" }])
    .issuer({ cik: "900020", name: "Brightloom Inc", filings: [{ acc: "0000900020-26-000001", date: "2026-03-01", firstSale: "2026-02-15", cik: "900020", name: "Brightloom Inc" }] });
  const r = await runLookup({ url: "brightloom.example", lookupId: "lk_3" }, deps(sec, web));
  assert.equal(r.status, "entity_review_required");
  assert.equal(r.issuers.verified.length, 0);
  assert.equal(r.issuers.review[0].cik, "0000900020");
  assert.equal(r.lastKnownFinancing, null, "candidate filing is not attributed");
  assert.match(renderReport(r), /UNVERIFIED Brightloom Inc D 0000900020-26-000001/);
  assert.ok(r.unknowns.some((u) => u.field === "legalName"));
  // After the owner confirms the CIK, it is used.
  resetSecClientState();
  const r2 = await runLookup({ url: "brightloom.example", lookupId: "lk_3b", confirmedCiks: ["900020"] }, deps(sec, web));
  assert.equal(r2.issuers.verified[0].status, "user_confirmed");
  assert.equal(r2.status, "financing_found");
});

test("several verified legal entities per brand (parent and operating subsidiary)", async () => {
  const web = new FakeWeb()
    .page("https://tandem.example/", html({ title: "Tandem", body: `<a href="/legal/terms">Terms</a><footer>© 2026 Tandem Holdings, Inc.</footer>` }))
    .page("https://tandem.example/legal/terms", html({ body: `<p>The service is operated by Tandem Operating LLC, a Delaware limited liability company. Tandem Holdings, Inc., a Delaware corporation ("Company").</p>` }));
  const sec = new FakeSec()
    .entitySearch("Tandem Holdings, Inc.", [{ cik: "900031", name: "Tandem Holdings, Inc." }])
    .entitySearch("Tandem Operating LLC", [{ cik: "900032", name: "Tandem Operating LLC" }])
    .entitySearch("Tandem", [])
    .issuer({ cik: "900031", name: "Tandem Holdings, Inc.", filings: [{ acc: "0000900031-24-000001", date: "2024-02-01", firstSale: "2024-01-20", offering: "12000000", sold: "12000000", cik: "900031", name: "Tandem Holdings, Inc." }] })
    .issuer({ cik: "900032", name: "Tandem Operating LLC", filings: [{ acc: "0000900032-26-000001", date: "2026-06-10", firstSale: "2026-06-01", debt: true, equity: false, offering: "3000000", sold: "1000000", cik: "900032", name: "Tandem Operating LLC" }] });
  const r = await runLookup({ url: "tandem.example", lookupId: "lk_4" }, deps(sec, web));
  assert.deepEqual(r.issuers.verified.map((v) => v.cik).sort(), ["0000900031", "0000900032"]);
  assert.equal(r.lastKnownFinancing!.category, "debt", "debt is not labelled venture equity");
  assert.equal(r.lastKnownFinancing!.eventDate, "2026-06-01");
  assert.equal(r.offerings.length, 2);
});

test("finds financing older than 24 months by expanding into historical submissions", async () => {
  const web = new FakeWeb()
    .page("https://oldmill.example/", html({ title: "Old Mill", body: `<a href="/privacy">Privacy</a>` }))
    .page("https://oldmill.example/privacy", html({ body: `<p>Old Mill Software, Inc., a California corporation ("we"), respects your privacy.</p>` }));
  const sec = new FakeSec()
    .entitySearch("Old Mill Software, Inc.", [{ cik: "900040", name: "Old Mill Software, Inc." }])
    .entitySearch("Old Mill", [])
    .issuer({
      cik: "900040",
      name: "Old Mill Software, Inc.",
      state: "CA",
      filings: [{ acc: "0000900040-26-000001", date: "2026-03-01", form: "10-K" } as any],
      historyFiles: [{ name: "CIK0000900040-submissions-001.json", filings: [{ acc: "0000900040-21-000001", date: "2021-05-03", firstSale: "2021-04-22", offering: "Indefinite", sold: "2500000", remaining: "Indefinite", jurisdiction: "CALIFORNIA", cik: "900040", name: "Old Mill Software, Inc." }] }],
    });
  const r = await runLookup({ url: "oldmill.example", lookupId: "lk_5" }, deps(sec, web));
  assert.equal(r.status, "financing_found");
  assert.equal(r.lastKnownFinancing!.eventDate, "2021-04-22");
  assert.match(r.lastKnownFinancing!.statement, /\$2,500,000 reported sold toward an offering of indefinite size/);
  assert.ok(r.searched.some((s) => /CIK 0000900040/.test(s.source) && s.from === "2021-05-03"));
});

test("conflicting press dates and amounts are flagged, not blended", async () => {
  const web = quillworkSite({
    news: html({ body: `<a href="/news/quillwork-raises-seed">Quillwork raises</a> <a href="/news/funding-recap">Our funding story</a>` }),
  });
  web.page("https://quillwork.example/news/funding-recap", html({ title: "Funding recap", head: `<meta property="article:published_time" content="2025-06-15">`, body: `<p>Quillwork raised $9 million seed financing led by a fund.</p>` }));
  const r = await runLookup({ url: "quillwork.example", lookupId: "lk_6" }, deps(quillworkSec(), web));
  assert.ok(r.conflicts.some((c) => /amount differs from filed amounts; unresolved/.test(c)));
  assert.equal(r.lastKnownFinancing!.eventDate, "2025-06-15", "a later publication is its own candidate, by publication date");
  assert.equal(r.lastKnownFinancing!.dateType, "announcement_published");
  assert.match(r.lastKnownFinancing!.statement, /publication date is not the closing date and may describe an earlier round/);
});

test("SEC 403 makes the lookup partial with a disclosed coverage gap, never 'nothing found'", async () => {
  const web = quillworkSite();
  const sec = new FakeSec();
  sec.set("https://efts.sec.gov/LATEST/search-index?keysTyped=Quillwork+Labs%2C+Inc.", { status: 403, body: "blocked" });
  const r = await runLookup({ url: "quillwork.example", lookupId: "lk_7" }, deps(sec, web));
  assert.notEqual(r.status, "nothing_found_in_completed_searches");
  assert.ok(r.coverageGaps.some((g) => g.kind === "blocked"));
});

test("budget exhaustion returns partial results with coverage gaps", async () => {
  const r = await runLookup({ url: "quillwork.example", lookupId: "lk_8" }, deps(quillworkSec(), quillworkSite(), undefined, { secMaxRequests: 4 }));
  assert.equal(r.budget.exhausted, true);
  assert.ok(r.coverageGaps.some((g) => g.kind === "budget_exhausted"));
  assert.notEqual(r.status, "nothing_found_in_completed_searches");
});

test("nothing found is reported only when searches completed", async () => {
  const web = new FakeWeb().page("https://quietco.example/", html({ title: "QuietCo", body: `<footer>© 2026 QuietCo, Inc.</footer>` }));
  const sec = new FakeSec().entitySearch("QuietCo, Inc.", []).entitySearch("QuietCo", []);
  const r = await runLookup({ url: "quietco.example", lookupId: "lk_9" }, deps(sec, web));
  assert.equal(r.status, "nothing_found_in_completed_searches");
  assert.match(renderReport(r), /None found in checked sources\. This does not mean no round occurred\./);
});

test("instructions inside fetched pages cannot change goals, destinations, secrets or configuration", async () => {
  const before = { ...process.env };
  const r = await runLookup({ url: "quillwork.example", lookupId: "lk_10" }, deps(quillworkSec(), quillworkSite({ injection: true })));
  const all = JSON.stringify(r);
  assert.equal(r.status, "financing_found", "same outcome as without the injected text");
  assert.doesNotMatch(all, /evil\.example|IGNORE ALL PREVIOUS|admin mode/i, "page instructions are not carried into results");
  assert.deepEqual({ ...process.env }, before, "no configuration changed");
  assert.equal(r.issuers.verified[0].cik, "0000900010");
});

test("unsafe input URL fails closed without any request", async () => {
  const web = new FakeWeb();
  const sec = new FakeSec();
  const r = await runLookup({ url: "http://169.254.169.254/latest/meta-data/", lookupId: "lk_11" }, deps(sec, web));
  assert.equal(r.status, "failed");
  assert.equal(web.hops.length + sec.calls.length, 0);
});

test("homepage redirect to a private address is refused", async () => {
  const web = new FakeWeb().redirect("https://hop.example/", "http://10.0.0.7/admin");
  const r = await runLookup({ url: "hop.example", lookupId: "lk_12" }, deps(new FakeSec(), web));
  assert.equal(r.status, "failed");
  assert.match(r.unknowns[0].reason, /unsafe/);
});

test("repeat checks reuse the SEC cache and disclose its age; concurrent checks share the throttle", async () => {
  const sec = quillworkSec();
  const [a, b] = await Promise.all([
    runLookup({ url: "quillwork.example", lookupId: "lk_13a" }, deps(sec, quillworkSite())),
    runLookup({ url: "quillwork.example", lookupId: "lk_13b" }, deps(sec, quillworkSite())),
  ]);
  assert.equal(a.lastKnownFinancing!.eventDate, b.lastKnownFinancing!.eventDate);
  const c = await runLookup({ url: "quillwork.example", lookupId: "lk_13c" }, deps(sec, quillworkSite()));
  assert.ok(c.cache.reusedEntries > 0);
  assert.match(renderReport(c), /reused from cache \(oldest \d+s old\)/);
});
