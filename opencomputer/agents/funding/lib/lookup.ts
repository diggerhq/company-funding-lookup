import { matchAnnouncements, extractAnnouncement, extractFromText } from "./announcements";
import type { LookupConfig } from "./config";
import { scoreCandidate, type CandidateInput } from "./entity";
import { classifyLink, coreName, excerpt, founderStatements, htmlToText, jsonLd, jurisdictionStatements, legalNamesInText, looksLikeFund, metaContent, normalizeName, pageTitle, sameSiteLinks } from "./extract";
import { padCik, sha256 } from "./formd";
import { describeAmount } from "./money";
import { groupOfferings, offeringStatement } from "./offerings";
import type { ResearchProvider } from "./research-provider";
import { RunContext } from "./run-context";
import { entitySearch, fetchFormD, fetchIssuer, formDFullTextSearch, monthsBefore, type IssuerRecord, type SearchHit } from "./sec";
import type { SecClient } from "./sec-http";
import type { Announcement, EntityCandidate, EvidenceItem, FinancingEvent, FormDFiling, LookupReport, LookupStatus, SiteProfile } from "./types";
import { UnsafeUrlError, canonicalDomain, normalizeInputUrl, safeGet, type HopFn, type ResolveFn } from "./url-safety";

export interface LookupInput {
  url: string;
  lookupId: string;
  confirmedCiks?: string[];
  rejectedCiks?: string[];
}

export interface LookupDeps {
  config: LookupConfig;
  sec: SecClient;
  research: ResearchProvider;
  hop?: HopFn;
  resolve?: ResolveFn;
  now?: () => number;
}

const DISCLAIMER =
  "Last known financing in checked public sources, not a guaranteed latest private transaction. Form D filings report offerings under SEC exemptions; they generally do not establish round names (Series A/B/C), valuation, lead investor or the full investor roster, and related persons are not investors. Non-US issuers, other exemptions, missing filings and entity ambiguity limit coverage.";

export async function runLookup(input: LookupInput, deps: LookupDeps): Promise<LookupReport> {
  const now = deps.now ?? Date.now;
  const ctx = new RunContext(deps.config.budget, now);
  const checkedAt = new Date(now()).toISOString();
  const today = checkedAt.slice(0, 10);
  const evidence: EvidenceItem[] = [];
  const conflicts: string[] = [];
  const unknowns: { field: string; reason: string }[] = [];
  const addEvidence = (e: Omit<EvidenceItem, "id">) => {
    const id = "ev:" + sha256(`${e.kind}|${e.url}|${e.claims.join("|")}`).slice(0, 16);
    if (!evidence.some((x) => x.id === id)) evidence.push({ id, ...e });
  };

  // 1. URL normalization and safety.
  let start: URL;
  try {
    start = normalizeInputUrl(input.url);
  } catch (e) {
    return failedReport(input, checkedAt, e instanceof UnsafeUrlError ? `${e.code}: ${e.message}` : String(e), ctx);
  }

  const site: SiteProfile = {
    submittedUrl: input.url,
    canonicalUrl: null,
    canonicalDomain: canonicalDomain(start),
    redirectChain: [],
    brandName: null,
    legalNames: [],
    jurisdictions: [],
    founders: [],
    addresses: [],
    pagesFetched: [],
    newsPages: [],
  };

  // 2. Company pages (homepage, legal, about), fetched directly with SSRF guards.
  const fetchPage = async (url: string | URL, kind: string) => {
    if (!ctx.take("web", `company_site:${kind}`)) return null;
    const retrievedAt = new Date(now()).toISOString();
    try {
      const r = await safeGet(url, { hop: deps.hop, resolve: deps.resolve });
      site.pagesFetched.push({ url: r.finalUrl, status: r.status, retrievedAt, kind });
      if (r.status !== 200) {
        ctx.gap({ source: `company_site:${kind}`, kind: "failed", detail: `HTTP ${r.status} from ${r.finalUrl}` });
        return null;
      }
      return { ...r, retrievedAt };
    } catch (e) {
      const unsafe = e instanceof UnsafeUrlError;
      site.pagesFetched.push({ url: String(url), status: null, retrievedAt, kind });
      ctx.gap({ source: `company_site:${kind}`, kind: unsafe ? "blocked" : /timeout|abort/i.test(String(e)) ? "timeout" : "failed", detail: `${unsafe ? "Refused unsafe URL" : "Fetch failed"}: ${(e as Error).message}`.slice(0, 240) });
      if (unsafe && kind === "homepage") throw e;
      return null;
    }
  };

  let home: Awaited<ReturnType<typeof fetchPage>> = null;
  try {
    home = await fetchPage(start, "homepage");
  } catch (e) {
    return failedReport(input, checkedAt, `unsafe redirect or address: ${(e as Error).message}`, ctx);
  }
  if (home) {
    site.canonicalUrl = home.finalUrl;
    site.canonicalDomain = canonicalDomain(home.finalUrl);
    site.redirectChain = home.chain;
    analyzePage(home.body, home.finalUrl, home.retrievedAt, site, addEvidence, true);
    const links = sameSiteLinks(home.body, home.finalUrl);
    const pick = (k: string, n: number) => [...new Map(links.filter((l) => classifyLink(l) === k).map((l) => [l.url, l])).values()].slice(0, n);
    for (const l of [...pick("legal", 2), ...pick("about", 1)]) {
      const p = await fetchPage(l.url, classifyLink(l)!);
      if (p) analyzePage(p.body, p.finalUrl, p.retrievedAt, site, addEvidence, false);
    }
    site.newsPages = pick("news", 2).map((l) => l.url);
  } else {
    unknowns.push({ field: "canonicalUrl", reason: "homepage could not be retrieved" });
  }
  if (!site.brandName && site.canonicalDomain) site.brandName = site.canonicalDomain.split(".")[0];

  // Optional domain profile (context.dev). Not required for anything below.
  if (deps.research.capabilities.domainProfile && site.canonicalDomain) {
    const prof = await deps.research.domainProfile(site.canonicalDomain, ctx);
    if (prof.ok) {
      if (prof.value.city) site.addresses.push({ value: [prof.value.city, prof.value.stateOrCountry].filter(Boolean).join(", "), url: `context.dev brand profile for ${site.canonicalDomain}` });
      addEvidence({ kind: "entity_source", url: `https://api.context.dev/v1/brand/retrieve#${site.canonicalDomain}`, excerpt: (prof.value.title ?? "") + (prof.value.description ? ` — ${prof.value.description.slice(0, 200)}` : ""), sourceDate: null, retrievedAt: checkedAt, claims: ["domain profile (third-party enrichment, context.dev)"] });
    }
  }

  // 3. SEC candidate discovery.
  const candidateHits = new Map<string, { hits: SearchHit[] }>();
  const addHit = (h: SearchHit) => {
    if (input.rejectedCiks?.map(padCik).includes(h.cik)) return;
    const e = candidateHits.get(h.cik) ?? { hits: [] };
    e.hits.push(h);
    candidateHits.set(h.cik, e);
  };
  for (const c of input.confirmedCiks ?? []) addHit({ cik: padCik(c), name: "", via: "edgar_entity_search", query: "user-confirmed CIK" });

  const names = [...new Map(site.legalNames.map((l) => [normalizeName(l.name), l.name])).values()].slice(0, 3);
  const queries = names.length ? names : site.brandName ? [site.brandName] : [];
  let entitySearchOk = true;
  for (const q of queries.slice(0, 3)) {
    const r = await entitySearch(deps.sec, q, ctx);
    if (!r.ok) entitySearchOk = false;
    const qCore = coreName(q);
    for (const h of r.hits) if (coreName(h.name) === qCore || normalizeName(h.name).startsWith(normalizeName(q))) addHit(h);
  }
  if (site.brandName && names.length) {
    // Brand searches surface parents/subsidiaries with different legal names; low-signal.
    const r = await entitySearch(deps.sec, site.brandName, ctx);
    for (const h of r.hits) if (coreName(h.name) === coreName(site.brandName)) addHit(h);
  }
  ctx.searchedRange({ source: "EDGAR entity-name search", from: null, to: today, note: `queries: ${queries.concat(names.length && site.brandName ? [site.brandName] : []).join("; ") || "none"}${entitySearchOk ? "" : " (some searches failed; fallback used)"}` });

  // Full-text search for legal names finds Form D filers whose names differ slightly.
  for (const q of names.slice(0, 2)) {
    const r = await formDFullTextSearch(deps.sec, q, ctx, { today, recentMonths: deps.config.recentWindowMonths, label: "legal_name" });
    for (const range of r.ranges) ctx.searchedRange({ source: `EDGAR Form D full-text search "${q}"`, from: range.from, to: range.to, note: "phrase search, forms D and D/A" });
    for (const h of r.hits) if (coreName(h.name) === coreName(q)) addHit(h);
  }
  // Founder searches are clues only.
  const founderOnly = new Set<string>();
  if (site.founders.length) {
    const f = site.founders[0].name;
    const r = await formDFullTextSearch(deps.sec, f, ctx, { today, recentMonths: deps.config.recentWindowMonths, label: "founder" });
    for (const range of r.ranges) ctx.searchedRange({ source: `EDGAR Form D full-text search founder "${f}" (clue only)`, from: range.from, to: range.to, note: "not exhaustive; not identity proof" });
    for (const h of r.hits.slice(0, 5)) {
      if (!candidateHits.has(h.cik)) founderOnly.add(h.cik);
      addHit({ ...h, via: "edgar_full_text_search", query: `founder ${f}` });
    }
  }

  // 4. Score candidates using submissions + a sample Form D for each.
  const ranked = [...candidateHits.entries()]
    .map(([cik, v]) => ({ cik, v, prio: (input.confirmedCiks?.map(padCik).includes(cik) ? 100 : 0) + (founderOnly.has(cik) ? -10 : 0) + (v.hits.some((h) => queries.some((q) => normalizeName(h.name) === normalizeName(q))) ? 20 : 0) - (looksLikeFund(v.hits[0]?.name ?? "") ? 15 : 0) }))
    .sort((a, b) => b.prio - a.prio)
    .slice(0, deps.config.budget.maxCandidates);
  if (candidateHits.size > ranked.length) ctx.gap({ source: "entity_candidates", kind: "partial", detail: `${candidateHits.size - ranked.length} lower-ranked EDGAR candidate(s) not examined` });

  const issuers = new Map<string, IssuerRecord>();
  const filingsByAcc = new Map<string, FormDFiling>();
  const candidates: EntityCandidate[] = [];
  for (const { cik, v } of ranked) {
    const issuer = await fetchIssuer(deps.sec, cik, ctx, { includeHistory: false });
    if (!issuer) continue;
    issuers.set(cik, issuer);
    const sample: FormDFiling[] = [];
    if (issuer.formDRows[0]) {
      const f = await fetchFormD(deps.sec, cik, issuer.formDRows[0], ctx);
      if (f) {
        sample.push(f);
        filingsByAcc.set(f.accession, f);
      }
    }
    const decision = input.confirmedCiks?.map(padCik).includes(cik) ? "confirmed" : undefined;
    const ci: CandidateInput = { issuer, sampleFilings: sample, discoveredVia: [...new Set(v.hits.map((h) => `${h.via}: ${h.query}`))].slice(0, 3), viaFounderSearchOnly: founderOnly.has(cik) };
    candidates.push(scoreCandidate(site, ci, decision));
  }
  const verified = candidates.filter((c) => c.status === "verified" || c.status === "user_confirmed");
  const review = candidates.filter((c) => c.status === "review").sort((a, b) => b.score - a.score);

  // 5. Full Form D history for verified issuers: recent first, expand when no recent raise.
  const recentFrom = monthsBefore(today, deps.config.recentWindowMonths);
  let filingBudget = deps.config.budget.maxFilings;
  for (const v of verified) {
    let issuer = issuers.get(v.cik)!;
    const hasRecent = issuer.formDRows.some((r) => r.filingDate >= recentFrom);
    if (!hasRecent && !issuer.coverage.complete) {
      const full = await fetchIssuer(deps.sec, v.cik, ctx, { includeHistory: true });
      if (full) issuers.set(v.cik, (issuer = full));
    }
    const rows = issuer.formDRows; // newest first
    const wanted: typeof rows = [];
    for (const r of rows) {
      if (wanted.length >= filingBudget) break;
      wanted.push(r);
    }
    for (const r of wanted) {
      if (filingsByAcc.has(r.accessionNumber)) continue;
      const f = await fetchFormD(deps.sec, v.cik, r, ctx);
      if (f) filingsByAcc.set(f.accession, f);
    }
    // Make sure each amendment's referenced original is present when it exists in the list.
    for (const f of [...filingsByAcc.values()].filter((x) => x.cik === v.cik && x.previousAccession && !filingsByAcc.has(x.previousAccession))) {
      const row = rows.find((r) => r.accessionNumber === f.previousAccession);
      if (row) {
        const p = await fetchFormD(deps.sec, v.cik, row, ctx);
        if (p) filingsByAcc.set(p.accession, p);
      }
    }
    filingBudget = Math.max(0, filingBudget - wanted.length);
    const unparsed = rows.filter((r) => !filingsByAcc.has(r.accessionNumber));
    if (unparsed.length) ctx.gap({ source: `sec_filings:${v.cik}`, kind: "partial", detail: `${unparsed.length} Form D filing(s) not parsed (oldest ${unparsed.at(-1)!.filingDate}); budget limit` });
    const oldest = rows.at(-1)?.filingDate ?? null;
    ctx.searchedRange({ source: `Form D filings for CIK ${v.cik}`, from: oldest, to: today, note: `${rows.length} D/D/A filing(s) listed; ${rows.length - unparsed.length} parsed${issuer.coverage.complete ? "" : "; older EDGAR pages unread"}` });
  }

  const verifiedCiks = new Set(verified.map((v) => v.cik));
  const verifiedFilings = [...filingsByAcc.values()].filter((f) => verifiedCiks.has(f.cik));
  const unverifiedFilings = [...filingsByAcc.values()].filter((f) => !verifiedCiks.has(f.cik) && review.some((r) => r.cik === f.cik));
  const { offerings, conflicts: offeringConflicts } = groupOfferings(verifiedFilings);
  conflicts.push(...offeringConflicts);
  for (const f of verifiedFilings) {
    addEvidence({
      kind: "filed_fact",
      url: f.sourceUrl,
      excerpt: `Form ${f.form} ${f.accession} by ${f.issuerName}: offering ${describeAmount(f.offeringAmount)}, sold ${describeAmount(f.soldAmount)}, remaining ${describeAmount(f.remainingAmount)}, first sale ${f.firstSale.status === "date" ? f.firstSale.date : f.firstSale.status.replace(/_/g, " ")}, investors ${f.investorCount.raw ?? "not reported"}`,
      sourceDate: f.filingDate,
      retrievedAt: f.fetchedAt,
      claims: [`filed ${f.form} for CIK ${f.cik}`, `sha256 ${f.sha256}`],
    });
  }

  // 6. Announcement check: company newsroom/blog first, then optional provider news/search.
  const announcements: Announcement[] = [];
  const sourcesChecked: string[] = [];
  let announcementComplete = true;
  const incompleteReasons: string[] = [];
  if (!home) {
    announcementComplete = false;
    incompleteReasons.push("company site unavailable");
  }
  for (const newsUrl of site.newsPages) {
    const p = await fetchPage(newsUrl, "news");
    if (!p) {
      announcementComplete = false;
      incompleteReasons.push(`company news page ${newsUrl} not retrieved`);
      continue;
    }
    sourcesChecked.push(p.finalUrl);
    const direct = extractAnnouncement(p.body, p.finalUrl, p.retrievedAt, site.canonicalDomain);
    if (direct && /\/(press|news|blog)\/.+/.test(new URL(p.finalUrl).pathname)) announcements.push(direct);
    const articleLinks = sameSiteLinks(p.body, p.finalUrl).filter((l) => /rais|fund|series|seed|financ|invest/i.test(l.text + " " + l.url)).slice(0, 2);
    for (const l of articleLinks) {
      const a = await fetchPage(l.url, "news_article");
      if (!a) {
        announcementComplete = false;
        incompleteReasons.push(`article ${l.url} not retrieved`);
        continue;
      }
      sourcesChecked.push(a.finalUrl);
      const ann = extractAnnouncement(a.body, a.finalUrl, a.retrievedAt, site.canonicalDomain);
      if (ann) announcements.push(ann);
    }
  }
  if (home && site.newsPages.length === 0) incompleteReasons.push("no newsroom/blog link found on the homepage");

  if (deps.research.capabilities.newsSearch && site.canonicalDomain) {
    const n = await deps.research.newsSearch(site.canonicalDomain, ctx);
    if (n.ok) {
      sourcesChecked.push(`context.dev news search (domain ${site.canonicalDomain})`);
      for (const art of n.value) {
        const ann = extractFromText({ text: art.description ?? "", title: art.title, url: art.url, publishedAt: art.publishedAt, retrievedAt: checkedAt, companyDomain: site.canonicalDomain, articleType: art.articleType, publisher: art.publisher });
        if (ann) announcements.push(ann);
      }
    } else {
      announcementComplete = false;
      incompleteReasons.push(`third-party news search failed (${n.reason})`);
    }
    const name = verified[0]?.name ?? site.brandName;
    if (name && deps.research.capabilities.webSearch) {
      const w = await deps.research.webSearch(`"${name}" raises funding round`, ctx);
      if (w.ok) {
        sourcesChecked.push(`context.dev web search ("${name}" raises funding round)`);
        for (const art of w.value) {
          const ann = extractFromText({ text: art.description ?? "", title: art.title, url: art.url, publishedAt: art.publishedAt, retrievedAt: checkedAt, companyDomain: site.canonicalDomain, articleType: null, publisher: null });
          // Search snippets about a same-name company are common; keep only those naming the company.
          if (ann && (`${art.title} ${art.description}`.toLowerCase().includes(coreName(name)) || ann.sourceKind === "company_announcement")) announcements.push(ann);
        }
      }
    }
  } else {
    announcementComplete = false;
    incompleteReasons.push(`third-party news/search unavailable (${deps.research.unavailableReason ?? "provider lacks capability"})`);
  }
  const uniqAnns = [...new Map(announcements.map((a) => [a.id, a])).values()];
  for (const a of uniqAnns) {
    addEvidence({
      kind: a.sourceKind === "aggregator" ? "aggregator" : a.sourceKind,
      url: a.url,
      excerpt: a.excerpt,
      sourceDate: a.publishedAt,
      retrievedAt: a.retrievedAt,
      claims: [a.amountText ? `amount stated: ${a.amountText}` : "no amount stated", a.stageText ? `${a.sourceKind === "aggregator" ? "aggregator-reported" : a.sourceKind === "company_announcement" ? "company-stated" : "reported"} stage: ${a.stageText}` : "no stage stated", a.publishedAt ? `published ${a.publishedAt} (publication date, not closing date)` : "publication date unknown"],
    });
  }

  // 7. Reconcile and choose the last known financing.
  const match = matchAnnouncements(uniqAnns, offerings);
  conflicts.push(...match.conflicts);
  const events: FinancingEvent[] = [];
  for (const o of offerings.filter((o) => !o.isNoticeOnly)) {
    const linked = match.matches.filter((m) => m.offeringId === o.id);
    const anns = linked.map((m) => uniqAnns.find((a) => a.id === m.announcementId)!);
    const strong = linked.some((m) => m.strength === "matched");
    const stageAnn = anns.find((a) => a.stageText);
    const datePart = o.firstSale.status === "date" ? { eventDate: o.firstSale.date, dateType: "first_sale" as const } : { eventDate: o.firstFilingDate, dateType: "filing_date" as const };
    const ent = verified.find((v) => v.cik === o.cik)!;
    events.push({
      basis: strong ? "filing_and_announcement" : "sec_filing",
      offeringId: o.id,
      announcementIds: anns.map((a) => a.id),
      ...datePart,
      amountUsd: o.soldAmount.kind === "value" ? o.soldAmount.usd : null,
      currency: o.soldAmount.kind === "value" ? "USD" : null,
      amountBasis: o.soldAmount.kind === "value" ? "reported sold toward offering as of filing date (not necessarily final close)" : null,
      category: o.category,
      stage: stageAnn ? { value: stageAnn.stageText!, provenance: stageAnn.sourceKind === "aggregator" ? "aggregator_reported" : stageAnn.sourceKind === "company_announcement" ? "company_stated" : "reporting" } : null,
      confidence: ent.confidence === "high" && datePart.dateType === "first_sale" ? "high" : datePart.dateType === "first_sale" ? "medium" : "low",
      statement: `${ent.name} (CIK ${o.cik}): ${offeringStatement(o)}`,
    });
  }
  const matchedIds = new Set(match.matches.filter((m) => m.strength === "matched").map((m) => m.announcementId));
  for (const a of uniqAnns.filter((a) => !matchedIds.has(a.id) && a.publishedAt)) {
    events.push({
      basis: "announcement",
      offeringId: null,
      announcementIds: [a.id],
      eventDate: a.publishedAt,
      dateType: "announcement_published",
      amountUsd: a.amountUsd,
      currency: a.amountUsd ? "USD" : null,
      amountBasis: a.amountUsd ? `amount stated by ${a.sourceKind.replace(/_/g, " ")}` : null,
      category: "unknown",
      stage: a.stageText ? { value: a.stageText, provenance: a.sourceKind === "aggregator" ? "aggregator_reported" : a.sourceKind === "company_announcement" ? "company_stated" : "reporting" } : null,
      confidence: a.sourceKind === "company_announcement" ? "medium" : "low",
      statement: `${a.sourceKind === "company_announcement" ? "Company announcement" : a.sourceKind === "aggregator" ? "Aggregator report" : "Reporting"} published ${a.publishedAt}${a.amountText ? ` states ${a.amountText}` : ""}${a.stageText ? ` (${a.sourceKind === "aggregator" ? "aggregator-reported" : "stated"} stage: ${a.stageText})` : ""}; publication date is not the closing date and may describe an earlier round. Source: ${a.url}`,
    });
  }
  events.sort((a, b) => (b.eventDate ?? "").localeCompare(a.eventDate ?? ""));
  const last = events[0] ?? null;
  const competing = events.slice(1).filter((e) => last && e.eventDate && last.eventDate && Math.abs(Date.parse(last.eventDate) - Date.parse(e.eventDate)) <= 45 * 86_400_000 && e.offeringId !== last.offeringId);
  if (last && last.dateType !== events[1]?.dateType && competing.length) conflicts.push("Latest-event ordering is uncertain: competing candidates use different date types (first sale vs publication)");

  // Latest SEC notice/update, shown separately when it is not a new financing.
  const allFilingsSorted = verifiedFilings.slice().sort((a, b) => (b.filingDate ?? "").localeCompare(a.filingDate ?? "") || b.accession.localeCompare(a.accession));
  const lf = allFilingsSorted[0];
  const lfOffering = lf ? offerings.find((o) => o.filings.includes(lf.accession))! : null;
  const latestSecNotice = lf && lfOffering
    ? {
        accession: lf.accession,
        form: lf.form,
        filingDate: lf.filingDate,
        offeringId: lfOffering.id,
        isNewFinancing: lf.accession === lfOffering.rootAccession && !lfOffering.isNoticeOnly && lfOffering.linkStatus !== "uncertain_link",
        note: lf.form === "D/A"
          ? `Amendment to offering first filed ${lfOffering.firstFilingDate ?? "unknown"}${lfOffering.linkStatus === "uncertain_link" ? " (link to original uncertain)" : ""}; an amendment is an update, not a new round`
          : lf.firstSale.status === "yet_to_occur"
            ? "New offering notice; first sale had not yet occurred"
            : "Original Form D notice",
      }
    : null;

  // 8. Status and wording.
  const secFailures = ctx.gaps.filter((g) => /^(sec_|edgar_)/.test(g.source) && ["failed", "blocked", "timeout", "malformed", "unavailable", "budget_exhausted"].includes(g.kind));
  let status: LookupStatus;
  if (!verified.length && review.length) status = "entity_review_required";
  else if (last) status = "financing_found";
  else if (offerings.some((o) => o.isNoticeOnly)) status = "offering_only";
  else if (secFailures.length || (!home && !verified.length)) status = secFailures.length && !candidates.length && !home ? "failed" : "partial";
  else status = "nothing_found_in_completed_searches";

  const filingOnly = last && last.basis === "sec_filing";
  const annStatement = !announcementComplete
    ? `Announcement check incomplete as of ${checkedAt}: ${[...new Set(incompleteReasons)].join("; ")}. This does not mean the financing is unannounced.`
    : filingOnly
      ? `No matching announcement found in checked sources as of ${checkedAt}.`
      : `Checked ${sourcesChecked.length} source(s) as of ${checkedAt}.`;

  if (!last) unknowns.push({ field: "lastKnownFinancing", reason: verified.length ? "no completed financing found in checked sources" : "no verified issuer" });
  if (last && !last.amountUsd) unknowns.push({ field: "lastKnownFinancing.amountUsd", reason: "amount not reported in the supporting source" });
  if (last && !last.stage) unknowns.push({ field: "lastKnownFinancing.stage", reason: "Form D does not report round names; no source stated one" });
  if (!verified.length && !review.length) unknowns.push({ field: "issuers", reason: candidates.length ? "all EDGAR candidates were rejected" : "no EDGAR issuer candidates found for the legal names/brand found on the site" });
  if (!site.legalNames.length) unknowns.push({ field: "legalName", reason: "no legal entity name stated on the pages checked" });

  for (const ln of site.legalNames) addEvidence({ kind: "entity_source", url: ln.url, excerpt: `Legal name stated: ${ln.name}`, sourceDate: null, retrievedAt: site.pagesFetched.find((p) => p.url === ln.url)?.retrievedAt ?? checkedAt, claims: ["legal name on company site"] });

  return {
    lookupId: input.lookupId,
    status,
    checkedAt,
    input: { submittedUrl: input.url, canonicalUrl: site.canonicalUrl, canonicalDomain: site.canonicalDomain },
    issuers: { verified, review },
    lastKnownFinancing: last,
    competingCandidates: competing,
    latestSecNotice,
    offerings,
    filings: [...verifiedFilings, ...unverifiedFilings],
    announcements: uniqAnns,
    announcementCheck: { status: announcementComplete ? "complete" : "incomplete", matched: !!last && last.basis !== "sec_filing", statement: annStatement, sourcesChecked },
    conflicts,
    coverageGaps: ctx.gaps,
    searched: ctx.searched,
    evidence,
    unknowns,
    budget: { secRequests: ctx.secRequests, webRequests: ctx.webRequests, researchRequests: ctx.researchRequests, elapsedMs: ctx.elapsedMs, exhausted: ctx.exhausted },
    cache: { reusedEntries: ctx.cacheReused, oldestReusedAgeSeconds: ctx.oldestCacheAgeSeconds },
    disclaimer: DISCLAIMER,
  };
}

function analyzePage(html: string, url: string, retrievedAt: string, site: SiteProfile, addEvidence: (e: Omit<EvidenceItem, "id">) => void, isHome: boolean) {
  const text = htmlToText(html);
  const add = <T extends { url: string }>(list: T[], item: T, key: (t: T) => string) => {
    if (!list.some((x) => key(x) === key(item))) list.push(item);
  };
  if (isHome) site.brandName = metaContent(html, "og:site_name") ?? pageTitle(html)?.split(/\s[|\-–—:]\s/)[0]?.trim() ?? null;
  for (const o of jsonLd(html)) {
    const types = ([] as string[]).concat(o["@type"] ?? []);
    if (!types.some((t) => /Organization|Corporation/.test(t))) continue;
    if (typeof o.legalName === "string") add(site.legalNames, { name: o.legalName.trim(), url }, (x) => normalizeName(x.name));
    if (isHome && !site.brandName && typeof o.name === "string") site.brandName = o.name;
    for (const f of [].concat(o.founder ?? [], o.founders ?? []) as any[]) {
      const n = typeof f === "string" ? f : f?.name;
      if (typeof n === "string") add(site.founders, { name: n.trim(), url }, (x) => x.name.toLowerCase());
    }
    const addr = o.address;
    if (addr && typeof addr === "object" && addr.addressLocality) add(site.addresses, { value: [addr.addressLocality, addr.addressRegion, addr.addressCountry].filter((x) => typeof x === "string").join(", "), url }, (x) => x.value);
  }
  // High-precision legal-name contexts only: copyright lines, "X, a Delaware corporation",
  // 'X ("Company", "we")' and "operated by X". Generic suffix matches in privacy policies
  // (processors, vendors) are ignored.
  for (const m of text.matchAll(/(?:©|\(c\)|copyright)\s*(?:\d{4}(?:\s*[-–]\s*\d{4})?\s*)?([^\n|]{3,90})/gi)) {
    for (const n of legalNamesInText(" " + m[1])) add(site.legalNames, { name: n.name, url }, (x) => normalizeName(x.name));
  }
  for (const j of jurisdictionStatements(text)) {
    add(site.jurisdictions, { value: j.jurisdiction, url }, (x) => x.value.toLowerCase());
    if (j.name) for (const n of legalNamesInText(" " + j.name)) add(site.legalNames, { name: n.name, url }, (x) => normalizeName(x.name));
  }
  for (const m of text.matchAll(/(?:operated by|provided by|owned by)\s+([^\n.;]{3,90}?(?:Inc\.?|LLC|Corp\.?|Corporation|Ltd\.?|Limited|GmbH|PBC))/gi)) {
    for (const n of legalNamesInText(" " + m[1])) add(site.legalNames, { name: n.name, url }, (x) => normalizeName(x.name));
  }
  for (const m of text.matchAll(/([^\n.;:]{3,90}?)\s*\((?:the\s+)?["“](?:Company|we|us|our)["”]/gi)) {
    for (const n of legalNamesInText(" " + m[1])) add(site.legalNames, { name: n.name, url }, (x) => normalizeName(x.name));
  }
  for (const f of founderStatements(text).slice(0, 4)) {
    add(site.founders, { name: f.name, url }, (x) => x.name.toLowerCase());
    addEvidence({ kind: "entity_source", url, excerpt: excerpt(text, f.index), sourceDate: null, retrievedAt, claims: [`founder stated: ${f.name}`] });
  }
  site.legalNames.splice(6);
}

function failedReport(input: LookupInput, checkedAt: string, reason: string, ctx: RunContext): LookupReport {
  ctx.gap({ source: "input_url", kind: "blocked", detail: reason });
  return {
    lookupId: input.lookupId,
    status: "failed",
    checkedAt,
    input: { submittedUrl: input.url, canonicalUrl: null, canonicalDomain: null },
    issuers: { verified: [], review: [] },
    lastKnownFinancing: null,
    competingCandidates: [],
    latestSecNotice: null,
    offerings: [],
    filings: [],
    announcements: [],
    announcementCheck: { status: "not_run", matched: false, statement: "Announcement check not run.", sourcesChecked: [] },
    conflicts: [],
    coverageGaps: ctx.gaps,
    searched: [],
    evidence: [],
    unknowns: [{ field: "all", reason }],
    budget: { secRequests: 0, webRequests: 0, researchRequests: 0, elapsedMs: ctx.elapsedMs, exhausted: false },
    cache: { reusedEntries: 0, oldestReusedAgeSeconds: null },
    disclaimer: DISCLAIMER,
  };
}
