// Synthetic test world: fake SEC endpoints and fake company websites.
// All companies, people, CIKs and domains here are invented (".example" TLD).

import type { HopFn, ResolveFn } from "../../opencomputer/agents/funding/lib/url-safety";
import type { SecFetchFn } from "../../opencomputer/agents/funding/lib/sec-http";
import { loadConfig, type LookupConfig } from "../../opencomputer/agents/funding/lib/config";

export interface FormDSpec {
  cik: string;
  name: string;
  form?: "D" | "D/A";
  prev?: string;
  firstSale?: string | "yet" | null;
  offering?: string | null;
  sold?: string | null;
  remaining?: string | null;
  investors?: string | null;
  persons?: [string, string, string[]][];
  jurisdiction?: string;
  city?: string;
  equity?: boolean;
  debt?: boolean;
  option?: boolean;
  pooled?: boolean;
}

const tag = (n: string, v: string | null | undefined) => (v === undefined || v === null ? "" : `<${n}>${v}</${n}>`);

export function formDXml(s: FormDSpec): string {
  const form = s.form ?? "D";
  const fs = s.firstSale === "yet" ? "<yetToOccur>true</yetToOccur>" : s.firstSale ? `<value>${s.firstSale}</value>` : "";
  const persons = (s.persons ?? [])
    .map(([f, l, roles]) => `<relatedPersonInfo><relatedPersonName><firstName>${f}</firstName><lastName>${l}</lastName></relatedPersonName><relatedPersonRelationshipList>${roles.map((r) => `<relationship>${r}</relationship>`).join("")}</relatedPersonRelationshipList><relationshipClarification></relationshipClarification></relatedPersonInfo>`)
    .join("");
  return `<?xml version="1.0"?>
<edgarSubmission><schemaVersion>X0708</schemaVersion><submissionType>${form}</submissionType><testOrLive>LIVE</testOrLive>
<primaryIssuer><cik>${s.cik}</cik><entityName>${s.name}</entityName><issuerAddress><city>${s.city ?? "Springfield"}</city><stateOrCountry>DE</stateOrCountry><stateOrCountryDescription>DELAWARE</stateOrCountryDescription></issuerAddress><jurisdictionOfInc>${s.jurisdiction ?? "DELAWARE"}</jurisdictionOfInc><issuerPreviousNameList><value>None</value></issuerPreviousNameList><entityType>Corporation</entityType></primaryIssuer>
<relatedPersonsList>${persons}</relatedPersonsList>
<offeringData><industryGroup><industryGroupType>Other Technology</industryGroupType></industryGroup><federalExemptionsExclusions><item>06b</item></federalExemptionsExclusions>
<typeOfFiling><newOrAmendment><isAmendment>${form === "D/A"}</isAmendment>${tag("previousAccessionNumber", s.prev)}</newOrAmendment><dateOfFirstSale>${fs}</dateOfFirstSale></typeOfFiling>
<durationOfOffering><moreThanOneYear>false</moreThanOneYear></durationOfOffering>
<typesOfSecuritiesOffered>${s.equity !== false && !s.debt && !s.pooled ? "<isEquityType>true</isEquityType>" : ""}${s.debt ? "<isDebtType>true</isDebtType>" : ""}${s.option ? "<isOptionToAcquireType>true</isOptionToAcquireType>" : ""}${s.pooled ? "<isPooledInvestmentFundType>true</isPooledInvestmentFundType>" : ""}</typesOfSecuritiesOffered>
<offeringSalesAmounts>${tag("totalOfferingAmount", s.offering === undefined ? "10000000" : s.offering)}${tag("totalAmountSold", s.sold === undefined ? "8000000" : s.sold)}${tag("totalRemaining", s.remaining === undefined ? "2000000" : s.remaining)}<clarificationOfResponse></clarificationOfResponse></offeringSalesAmounts>
<investors><hasNonAccreditedInvestors>false</hasNonAccreditedInvestors>${tag("totalNumberAlreadyInvested", s.investors === undefined ? "7" : s.investors)}</investors>
<signatureBlock><signature><issuerName>${s.name}</issuerName><signatureDate>2026-01-01</signatureDate></signature></signatureBlock></offeringData></edgarSubmission>`;
}

type Route = { status: number; body: string; headers?: Record<string, string> } | (() => { status: number; body: string; headers?: Record<string, string> } | Promise<never>);

export class FakeSec {
  routes = new Map<string, Route>();
  calls: { url: string; at: number; ua: string }[] = [];
  clock = { now: 0 };
  realTime = false;
  set(url: string, r: Route) {
    this.routes.set(url, r);
    return this;
  }
  json(url: string, body: unknown) {
    return this.set(url, { status: 200, body: JSON.stringify(body) });
  }
  /** Register an issuer with Form D filings (newest first in `filings`). */
  issuer(o: { cik: string; name: string; website?: string; state?: string; city?: string; formerNames?: string[]; filings: (FormDSpec & { acc: string; date: string })[]; historyFiles?: { name: string; filings: (FormDSpec & { acc: string; date: string })[] }[] }) {
    const cik10 = o.cik.padStart(10, "0");
    const arrays = (fs: { acc: string; date: string; form?: string }[]) => ({
      accessionNumber: fs.map((f) => f.acc),
      filingDate: fs.map((f) => f.date),
      form: fs.map((f) => f.form ?? "D"),
      primaryDocument: fs.map(() => "xslFormDX01/primary_doc.xml"),
    });
    this.json(`https://data.sec.gov/submissions/CIK${cik10}.json`, {
      cik: o.cik,
      name: o.name,
      website: o.website ?? "",
      stateOfIncorporation: o.state ?? "DE",
      entityType: "operating",
      tickers: [],
      formerNames: (o.formerNames ?? []).map((n) => ({ name: n, from: "2015-01-01", to: "2019-01-01" })),
      addresses: { business: { city: (o.city ?? "Springfield").toUpperCase(), stateOrCountry: "DE" } },
      filings: { recent: arrays(o.filings), files: (o.historyFiles ?? []).map((h) => ({ name: h.name, filingCount: h.filings.length, filingFrom: h.filings.at(-1)?.date, filingTo: h.filings[0]?.date })) },
    });
    for (const h of o.historyFiles ?? []) this.json(`https://data.sec.gov/submissions/${h.name}`, arrays(h.filings));
    for (const f of [...o.filings, ...(o.historyFiles ?? []).flatMap((h) => h.filings)]) {
      const base = `https://www.sec.gov/Archives/edgar/data/${Number(o.cik)}/${f.acc.replace(/-/g, "")}`;
      this.json(`${base}/index.json`, { directory: { item: [{ name: `${f.acc}-index.html` }, { name: "primary_doc.xml" }] } });
      this.set(`${base}/primary_doc.xml`, { status: 200, body: formDXml({ ...f, cik: o.cik, name: f.name ?? o.name }) });
    }
    return this;
  }
  entitySearch(query: string, hits: { cik: string; name: string }[]) {
    return this.json(`https://efts.sec.gov/LATEST/search-index?keysTyped=${encodeURIComponent(query).replace(/%20/g, "+")}`, { hits: { hits: hits.map((h) => ({ _id: h.cik, _source: { entity: h.name } })) } });
  }
  fetchFn: SecFetchFn = async (url, init) => {
    this.calls.push({ url, at: this.realTime ? Date.now() : this.clock.now, ua: init.headers["User-Agent"] });
    let r = this.routes.get(url);
    if (!r && url.startsWith("https://efts.sec.gov/LATEST/search-index?q=")) r = { status: 200, body: JSON.stringify({ hits: { hits: [] } }) };
    if (!r) r = { status: 404, body: "not found" };
    const v = typeof r === "function" ? await r() : r;
    return { status: v.status, headers: { get: (n: string) => v.headers?.[n.toLowerCase()] ?? null }, text: async () => v.body };
  };
}

export class FakeWeb {
  pages = new Map<string, { status: number; body: string; headers?: Record<string, string> }>();
  dns = new Map<string, string[]>();
  hops: string[] = [];
  page(url: string, body: string, status = 200, headers: Record<string, string> = {}) {
    this.pages.set(url, { status, body, headers });
    const host = new URL(url).hostname;
    if (!this.dns.has(host)) this.dns.set(host, ["93.184.216.34"]);
    return this;
  }
  redirect(from: string, to: string, status = 301) {
    return this.page(from, "", status, { location: to });
  }
  hop: HopFn = async (url) => {
    this.hops.push(url.toString());
    const p = this.pages.get(url.toString());
    if (!p) return { status: 404, headers: {}, body: "", truncated: false };
    return { status: p.status, headers: p.headers ?? {}, body: p.body, truncated: false };
  };
  resolve: ResolveFn = async (host) => this.dns.get(host) ?? ["93.184.216.34"];
}

export function testConfig(over: Partial<LookupConfig["budget"]> = {}, env: Record<string, string> = {}): LookupConfig {
  const c = loadConfig({ SEC_CONTACT_EMAIL: "ops@research.example", ...env });
  c.budget = { ...c.budget, deadlineMs: 600_000, ...over };
  return c;
}

export const html = (o: { title?: string; head?: string; body: string }) => `<!doctype html><html><head><title>${o.title ?? ""}</title>${o.head ?? ""}</head><body>${o.body}</body></html>`;
