import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFormD } from "../opencomputer/agents/funding/lib/formd";
import { parseAnnouncedAmount, parseFiledAmount, withinPercent } from "../opencomputer/agents/funding/lib/money";
import { groupOfferings, offeringStatement } from "../opencomputer/agents/funding/lib/offerings";
import { formDXml, type FormDSpec } from "./fixtures/world";

const meta = (acc: string, date: string) => ({ accession: acc, filingDate: date, sourceUrl: `https://www.sec.gov/x/${acc}/primary_doc.xml`, indexUrl: `https://www.sec.gov/x/${acc}/index.json`, fetchedAt: "2026-10-01T00:00:00Z" });
const parse = (s: Partial<FormDSpec>, acc: string, date: string) => parseFormD(formDXml({ cik: "900001", name: "Synthetic Widgets, Inc.", ...s }), meta(acc, date));

test("preserves absent, zero, indefinite and unparseable amounts", () => {
  assert.deepEqual(parseFiledAmount("Indefinite"), { kind: "indefinite", raw: "Indefinite" });
  assert.deepEqual(parseFiledAmount("0"), { kind: "value", raw: "0", usd: "0" });
  assert.deepEqual(parseFiledAmount(undefined), { kind: "absent", raw: null });
  assert.deepEqual(parseFiledAmount(""), { kind: "absent", raw: null });
  assert.equal(parseFiledAmount("12,500,000").kind, "value");
  assert.equal((parseFiledAmount("12,500,000") as any).usd, "12500000");
  assert.equal(parseFiledAmount("about 5M").kind, "unparseable");
  const f = parse({ offering: "Indefinite", sold: "0", remaining: null, investors: null }, "0000900001-26-000001", "2026-03-01");
  assert.equal(f.offeringAmount.kind, "indefinite");
  assert.deepEqual(f.soldAmount, { kind: "value", raw: "0", usd: "0" });
  assert.equal(f.remainingAmount.kind, "absent");
  assert.deepEqual(f.investorCount, { raw: null, value: null });
});

test("parses yet-to-occur first sale and amendment links", () => {
  const notice = parse({ firstSale: "yet", sold: "0" }, "0000900001-26-000002", "2026-05-01");
  assert.deepEqual(notice.firstSale, { status: "yet_to_occur" });
  const amend = parse({ form: "D/A", prev: "0000900001-26-000002", firstSale: "2026-06-01" }, "0000900001-26-000003", "2026-07-01");
  assert.equal(amend.isAmendment, true);
  assert.equal(amend.previousAccession, "0000900001-26-000002");
  assert.equal(amend.form, "D/A");
});

test("categorizes securities without assuming venture equity", () => {
  assert.equal(parse({}, "a", "2026-01-01").category, "equity");
  assert.equal(parse({ debt: true, equity: false }, "b", "2026-01-01").category, "debt");
  assert.equal(parse({ debt: true, option: true, equity: false }, "c", "2026-01-01").category, "convertible_or_hybrid");
  assert.equal(parse({ pooled: true, equity: false }, "d", "2026-01-01").category, "pooled_fund");
});

test("related persons keep filed roles", () => {
  const f = parse({ persons: [["Ada", "Quill", ["Executive Officer", "Director"]], ["Bo", "Marsh", ["Director"]]] }, "e", "2026-01-01");
  assert.deepEqual(f.relatedPersons[0], { name: "Ada Quill", roles: ["Executive Officer", "Director"], clarification: null });
});

test("latest amendment to an old offering is not the latest new round; amounts are not summed", () => {
  const old = parse({ firstSale: "2023-02-01", offering: "20000000", sold: "5000000" }, "0000900001-23-000001", "2023-02-10");
  const oldAmend = parse({ form: "D/A", prev: "0000900001-23-000001", firstSale: "2023-02-01", offering: "20000000", sold: "18000000" }, "0000900001-26-000009", "2026-09-01");
  const newer = parse({ firstSale: "2025-04-01", offering: "8000000", sold: "8000000", remaining: "0" }, "0000900001-25-000004", "2025-04-12");
  const { offerings, conflicts } = groupOfferings([old, oldAmend, newer]);
  assert.equal(offerings.length, 2);
  assert.equal(conflicts.length, 0);
  // Ordered by event (first-sale) date, newest first: the 2025 offering, not the 2026 amendment.
  assert.equal(offerings[0].rootAccession, "0000900001-25-000004");
  const o = offerings.find((x) => x.rootAccession === "0000900001-23-000001")!;
  assert.equal(o.linkStatus, "linked_by_previous_accession");
  assert.equal((o.soldAmount as any).usd, "18000000", "cumulative latest value, not 5M+18M");
  assert.match(o.changes[0], /sold \$5,000,000 -> \$18,000,000 \(cumulative as filed, not summed\)/);
  assert.match(offeringStatement(offerings[0]), /^\$8,000,000 reported sold toward a \$8,000,000 offering as of filing date 2025-04-12/);
});

test("amendment without a retrievable original is an uncertain link needing review", () => {
  const orphan = parse({ form: "D/A", prev: "0000900001-20-000001", firstSale: "2020-01-05" }, "0000900001-26-000010", "2026-02-01");
  const { offerings, conflicts } = groupOfferings([orphan]);
  assert.equal(offerings[0].linkStatus, "uncertain_link");
  assert.match(conflicts[0], /could not be linked.*needs review/);
});

test("first sale yet to occur is an offering notice, not a completed raise", () => {
  const n = parse({ firstSale: "yet", sold: "0", offering: "3000000" }, "0000900001-26-000011", "2026-08-01");
  const { offerings } = groupOfferings([n]);
  assert.equal(offerings[0].isNoticeOnly, true);
  assert.match(offeringStatement(offerings[0]), /Offering notice only: first sale had not yet occurred.*not a completed raise/);
});

test("indefinite offering size wording", () => {
  const f = parse({ offering: "Indefinite", sold: "1500000", remaining: "Indefinite", firstSale: "2026-01-02" }, "x", "2026-01-10");
  assert.match(offeringStatement(groupOfferings([f]).offerings[0]), /\$1,500,000 reported sold toward an offering of indefinite size/);
});

test("announced amounts parse with exact decimal math", () => {
  assert.deepEqual(parseAnnouncedAmount("raised $12.5 million in"), { usd: "12500000", text: "$12.5 million" });
  assert.deepEqual(parseAnnouncedAmount("a US$1.25B round"), { usd: "1250000000", text: "US$1.25B" });
  assert.equal(parseAnnouncedAmount("costs $5"), null);
  assert.equal(withinPercent(12_500_000n, 12_000_000n, 15), true);
  assert.equal(withinPercent(20_000_000n, 12_000_000n, 15), false);
});

test("XML reader handles entities, CDATA, comments, self-closing tags and rejects malformed input", async () => {
  const { parseXml } = await import("../opencomputer/agents/funding/lib/xml");
  const doc: any = parseXml(`<?xml version="1.0"?><!-- c --><a><b>R&amp;D &#8212; &lt;x&gt;</b><c/><d><![CDATA[1 < 2]]></d><item>1</item><item>2</item><list><item>only</item></list></a>`, new Set(["item"]));
  assert.equal(doc.a.b, "R&D — <x>");
  assert.equal(doc.a.c, "");
  assert.equal(doc.a.d, "1 < 2");
  assert.deepEqual(doc.a.item, ["1", "2"]);
  assert.deepEqual(doc.a.list.item, ["only"]);
  assert.throws(() => parseXml("<a><b></a>", new Set()), /mismatched/);
  assert.throws(() => parseXml("<a>", new Set()), /unterminated/);
  assert.throws(() => parseFormD("<html><body>not form d</body></html>", meta("z", "2026-01-01")), /Not a Form D|Unparseable/);
});

test("parses a real-shaped EDGAR Form D document layout", () => {
  const f = parseFormD(formDXml({ cik: "900001", name: "Synthetic &amp; Sons, Inc.", persons: [["Ada", "Quill", ["Director"]]] }), meta("0000900001-26-000077", "2026-02-02"));
  assert.equal(f.issuerName, "Synthetic & Sons, Inc.");
  assert.equal(f.cik, "0000900001");
  assert.deepEqual(f.exemptions, ["06b"]);
});
