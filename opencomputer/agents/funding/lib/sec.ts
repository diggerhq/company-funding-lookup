import { FormDParseError, padCik, parseFormD } from "./formd";
import type { RunContext } from "./run-context";
import type { SecClient } from "./sec-http";
import type { FormDFiling } from "./types";

// EDGAR discovery. Contracts verified against live endpoints on 2026-10-05:
// - data.sec.gov/submissions/CIK##########.json: filings.recent is parallel arrays; filings.files lists older pages
// - www.sec.gov/Archives/edgar/data/<cik>/<acc-no-dashes>/index.json: directory listing
// - efts.sec.gov/LATEST/search-index?q=..&forms=D,D%2FA: full-text search. "D/A" MUST be
//   percent-encoded (an unencoded slash returns HTTP 500). Hits carry _source.adsh/ciks/form/file_date.
// - efts.sec.gov/LATEST/search-index?keysTyped=..: entity-name search. Spaces must be "+"
//   ("%20" returns HTTP 500). Hits carry _id (CIK) and _source.entity.
// - www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=..: official company list (HTML),
//   used as fallback when EFTS search fails.

export interface SubmissionRow {
  accessionNumber: string;
  filingDate: string;
  form: string;
  primaryDocument: string | null;
}

export interface IssuerRecord {
  cik: string;
  name: string;
  formerNames: { name: string; from: string | null; to: string | null }[];
  stateOfIncorporation: string | null;
  entityType: string | null;
  website: string | null;
  businessCity: string | null;
  businessState: string | null;
  sicDescription: string | null;
  tickers: string[];
  formDRows: SubmissionRow[];
  coverage: { from: string | null; to: string | null; complete: boolean; note: string };
  sourceUrl: string;
  fetchedAt: string;
}

/** Zip EDGAR's parallel arrays into rows. Arrays of unequal length are malformed. */
export function zipRecent(recent: Record<string, unknown[]>): SubmissionRow[] {
  const acc = recent?.accessionNumber;
  if (!Array.isArray(acc)) throw new Error("recent.accessionNumber missing");
  const keys = ["filingDate", "form", "primaryDocument"] as const;
  for (const k of keys) {
    if (!Array.isArray(recent[k]) || recent[k].length !== acc.length) throw new Error(`recent.${k} length mismatch`);
  }
  return acc.map((a, i) => ({
    accessionNumber: String(a),
    filingDate: String(recent.filingDate[i]),
    form: String(recent.form[i]),
    primaryDocument: recent.primaryDocument[i] ? String(recent.primaryDocument[i]) : null,
  }));
}

const isFormD = (form: string) => form === "D" || form === "D/A";

export async function fetchIssuer(sec: SecClient, cikIn: string, ctx: RunContext, opts: { includeHistory: boolean }): Promise<IssuerRecord | null> {
  const cik = padCik(cikIn);
  const url = `https://data.sec.gov/submissions/CIK${cik}.json`;
  const r = await sec.getJson<any>(url, ctx, `sec_submissions:${cik}`);
  if (!r.ok) {
    if (r.kind === "not_found") ctx.gap({ source: `sec_submissions:${cik}`, kind: "failed", detail: "CIK not found in EDGAR" });
    else ctx.gap({ source: `sec_submissions:${cik}`, kind: r.kind === "budget_exhausted" ? "budget_exhausted" : (r.kind as any), detail: r.detail });
    return null;
  }
  const d = r.data;
  let rows: SubmissionRow[];
  try {
    rows = zipRecent(d.filings.recent);
  } catch (e) {
    ctx.gap({ source: `sec_submissions:${cik}`, kind: "malformed", detail: (e as Error).message });
    return null;
  }
  const files: { name: string; filingFrom?: string; filingTo?: string }[] = Array.isArray(d.filings?.files) ? d.filings.files : [];
  const recentDates = rows.map((x) => x.filingDate).sort();
  let from = recentDates[0] ?? null;
  const to = recentDates.at(-1) ?? null;
  let complete = files.length === 0;
  let note = files.length === 0 ? "all filings are in the recent array" : `${files.length} historical submission file(s) referenced`;
  if (files.length && opts.includeHistory) {
    let read = 0;
    for (const f of files) {
      const hr = await sec.getJson<any>(`https://data.sec.gov/submissions/${f.name}`, ctx, `sec_submissions_history:${cik}`);
      if (!hr.ok) break;
      try {
        rows = rows.concat(zipRecent(hr.data));
        read++;
        if (f.filingFrom && (!from || f.filingFrom < from)) from = f.filingFrom;
      } catch (e) {
        ctx.gap({ source: `sec_submissions_history:${cik}`, kind: "malformed", detail: (e as Error).message });
        break;
      }
    }
    complete = read === files.length;
    note = `read ${read}/${files.length} historical submission file(s)`;
  }
  if (!complete) {
    const unread = files.map((f) => `${f.filingFrom ?? "?"}..${f.filingTo ?? "?"}`).join(", ");
    ctx.gap({ source: `sec_submissions_history:${cik}`, kind: opts.includeHistory ? "partial" : "not_searched", detail: `Older EDGAR filing pages not read (${unread})` });
  }
  ctx.searchedRange({ source: `EDGAR submissions CIK ${cik}`, from, to, note });
  const biz = d.addresses?.business ?? {};
  return {
    cik,
    name: String(d.name ?? ""),
    formerNames: (d.formerNames ?? []).map((f: any) => ({ name: String(f.name), from: f.from ?? null, to: f.to ?? null })),
    stateOfIncorporation: d.stateOfIncorporation || null,
    entityType: d.entityType || null,
    website: d.website || null,
    businessCity: biz.city ?? null,
    businessState: biz.stateOrCountry ?? null,
    sicDescription: d.sicDescription || null,
    tickers: Array.isArray(d.tickers) ? d.tickers.map(String) : [],
    formDRows: dedupeRows(rows.filter((x) => isFormD(x.form))),
    coverage: { from, to, complete, note },
    sourceUrl: url,
    fetchedAt: r.fetchedAt,
  };
}

function dedupeRows(rows: SubmissionRow[]) {
  const seen = new Map<string, SubmissionRow>();
  for (const r of rows) if (!seen.has(r.accessionNumber)) seen.set(r.accessionNumber, r);
  return [...seen.values()].sort((a, b) => b.filingDate.localeCompare(a.filingDate));
}

/** Discover the Form D XML via the filing index and parse the original document. */
export async function fetchFormD(sec: SecClient, cik: string, row: { accessionNumber: string; filingDate: string | null; form?: string }, ctx: RunContext): Promise<FormDFiling | null> {
  const cikNum = String(Number(padCik(cik)));
  const accNo = row.accessionNumber.replace(/-/g, "");
  const base = `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accNo}`;
  const indexUrl = `${base}/index.json`;
  const source = `sec_filing:${row.accessionNumber}`;
  const idx = await sec.getJson<any>(indexUrl, ctx, source);
  if (!idx.ok) {
    ctx.gap({ source, kind: idx.kind === "not_found" ? "failed" : (idx.kind as any), detail: `filing index unavailable: ${idx.detail}` });
    return null;
  }
  const items: { name: string }[] = idx.data?.directory?.item ?? [];
  // The original XML is the .xml file that is not an XSL rendering; primary_doc.xml by convention.
  const xmlName = items.map((i) => i.name).find((n) => n === "primary_doc.xml") ?? items.map((i) => i.name).find((n) => /\.xml$/i.test(n) && !/index/i.test(n));
  if (!xmlName) {
    ctx.gap({ source, kind: "malformed", detail: "no Form D XML in filing index (paper-era or non-XML filing)" });
    return null;
  }
  const xmlUrl = `${base}/${xmlName}`;
  const x = await sec.get(xmlUrl, ctx, source, { accept: "application/xml, text/xml" });
  if (!x.ok) {
    ctx.gap({ source, kind: (x.kind === "not_found" ? "failed" : x.kind) as any, detail: `Form D XML unavailable: ${x.detail}` });
    return null;
  }
  try {
    return parseFormD(x.body, { accession: row.accessionNumber, filingDate: row.filingDate, sourceUrl: xmlUrl, indexUrl, fetchedAt: x.fetchedAt });
  } catch (e) {
    ctx.gap({ source, kind: "malformed", detail: e instanceof FormDParseError ? e.message : String(e) });
    return null;
  }
}

export interface SearchHit {
  cik: string;
  name: string;
  accession?: string;
  form?: string;
  fileDate?: string;
  via: "edgar_entity_search" | "edgar_full_text_search" | "edgar_company_list";
  query: string;
}

export function efts(params: Record<string, string>): string {
  // Build the query by hand: "/" in forms must be %2F and spaces in keysTyped must be "+".
  const parts = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v).replace(/%20/g, "+")}`);
  return `https://efts.sec.gov/LATEST/search-index?${parts.join("&")}`;
}

export async function entitySearch(sec: SecClient, name: string, ctx: RunContext): Promise<{ ok: boolean; hits: SearchHit[] }> {
  const r = await sec.getJson<any>(efts({ keysTyped: name }), ctx, "edgar_entity_search");
  if (!r.ok || !Array.isArray(r.data?.hits?.hits)) {
    if (r.ok) ctx.gap({ source: "edgar_entity_search", kind: "malformed", detail: "unexpected response shape" });
    return companyListSearch(sec, name, ctx);
  }
  return {
    ok: true,
    hits: r.data.hits.hits.slice(0, 15).map((h: any) => ({ cik: padCik(h._id), name: String(h._source?.entity ?? ""), via: "edgar_entity_search" as const, query: name })),
  };
}

/** Official EDGAR company list (HTML). Fallback when EFTS entity search fails. */
export async function companyListSearch(sec: SecClient, name: string, ctx: RunContext): Promise<{ ok: boolean; hits: SearchHit[] }> {
  const url = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=${encodeURIComponent(name).replace(/%20/g, "+")}&type=D&dateb=&owner=include&count=40`;
  const r = await sec.get(url, ctx, "edgar_company_list", { accept: "text/html" });
  if (!r.ok) return { ok: false, hits: [] };
  return { ok: true, hits: parseCompanyList(r.body, name) };
}

export function parseCompanyList(html: string, query: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const re = /CIK=(\d{10})[^>]*>\d{10}<\/a><\/td>\s*<td[^>]*>([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) hits.push({ cik: m[1], name: decodeEntities(m[2].trim()), via: "edgar_company_list", query });
  // Single-company result pages show the company header instead of a list.
  if (!hits.length) {
    const one = /<span class="companyName">([^<]+?)\s*<acronym[^>]*>CIK<\/acronym>#:\s*<a[^>]*>(\d{10})/.exec(html);
    if (one) hits.push({ cik: one[2], name: decodeEntities(one[1].trim()), via: "edgar_company_list", query });
  }
  return hits.slice(0, 15);
}

function decodeEntities(t: string) {
  return t.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

/**
 * Form D full-text search for a phrase. Searches the recent window first and
 * expands to all available history when the recent window has no hits.
 */
export async function formDFullTextSearch(
  sec: SecClient,
  phrase: string,
  ctx: RunContext,
  opts: { today: string; recentMonths: number; label: string },
): Promise<{ ok: boolean; hits: SearchHit[]; ranges: { from: string; to: string }[] }> {
  const ranges: { from: string; to: string }[] = [];
  const recentFrom = monthsBefore(opts.today, opts.recentMonths);
  const run = async (from: string) => {
    const r = await sec.getJson<any>(efts({ q: `"${phrase.replace(/"/g, "")}"`, forms: "D,D/A", dateRange: "custom", startdt: from, enddt: opts.today }), ctx, `edgar_full_text_search:${opts.label}`);
    if (!r.ok) return null;
    if (!Array.isArray(r.data?.hits?.hits)) {
      ctx.gap({ source: `edgar_full_text_search:${opts.label}`, kind: "malformed", detail: "unexpected response shape" });
      return null;
    }
    ranges.push({ from, to: opts.today });
    return r.data.hits.hits.map((h: any) => ({
      cik: padCik(h._source?.ciks?.[0] ?? "0"),
      name: String(h._source?.display_names?.[0] ?? "").replace(/\s*\(CIK \d+\)\s*$/, ""),
      accession: String(h._source?.adsh ?? ""),
      form: String(h._source?.form ?? ""),
      fileDate: String(h._source?.file_date ?? ""),
      via: "edgar_full_text_search" as const,
      query: phrase,
    })) as SearchHit[];
  };
  const recent = await run(recentFrom);
  if (recent === null) return { ok: false, hits: [], ranges };
  if (recent.length) return { ok: true, hits: recent, ranges };
  // No recent hit: expand through all history EDGAR full-text search covers (2001+).
  const all = await run("2001-01-01");
  return { ok: all !== null, hits: all ?? [], ranges };
}

export function monthsBefore(isoDate: string, months: number): string {
  const d = new Date(isoDate + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}
