import { describeAmount, formatUsd } from "./money";
import { offeringStatement } from "./offerings";
import type { LookupReport } from "./types";

const STATUS_TEXT: Record<LookupReport["status"], string> = {
  financing_found: "Financing found",
  offering_only: "Offering notice only (no completed sale reported)",
  nothing_found_in_completed_searches: "Nothing found in completed searches",
  entity_review_required: "Entity review required",
  partial: "Partial lookup (coverage gaps)",
  failed: "Lookup failed",
};

/** Deterministic, concise human-readable report. */
export function renderReport(r: LookupReport): string {
  const L: string[] = [];
  L.push(`# Funding lookup: ${r.input.canonicalDomain ?? r.input.submittedUrl}`);
  L.push(`Status: ${STATUS_TEXT[r.status]}  |  Checked at: ${r.checkedAt}  |  Lookup: ${r.lookupId}`);
  L.push(`Input: ${r.input.submittedUrl}${r.input.canonicalUrl && r.input.canonicalUrl !== r.input.submittedUrl ? ` -> ${r.input.canonicalUrl}` : ""}`);
  L.push("");
  L.push("## Issuers");
  if (!r.issuers.verified.length) L.push("- No verified issuer.");
  for (const v of r.issuers.verified) L.push(`- ${v.name} (CIK ${v.cik}) ${v.status === "user_confirmed" ? "confirmed by user" : "verified"}, confidence ${v.confidence}: ${v.reasons.slice(0, 3).join("; ")}`);
  for (const c of r.issuers.review.slice(0, 5)) L.push(`- REVIEW: ${c.name} (CIK ${c.cik}), confidence ${c.confidence}. Why: ${c.reasons.slice(0, 2).join("; ")}${c.conflicts.length ? `. Concerns: ${c.conflicts.join("; ")}` : ""}`);
  L.push("");
  L.push("## Last known financing (in checked sources)");
  const f = r.lastKnownFinancing;
  if (!f) L.push("- None found in checked sources. This does not mean no round occurred.");
  else {
    L.push(`- ${f.statement}`);
    L.push(`- Event date: ${f.eventDate ?? "unknown"} (${f.dateType?.replace(/_/g, " ") ?? "no date"}); amount: ${f.amountUsd ? formatUsd(f.amountUsd) + " USD" : "unknown"}${f.amountBasis ? ` (${f.amountBasis})` : ""}; category: ${f.category}; confidence: ${f.confidence}`);
    L.push(`- Stage: ${f.stage ? `${f.stage.value} (${f.stage.provenance.replace(/_/g, " ")})` : "not established (Form D does not report round names)"}`);
    const o = r.offerings.find((x) => x.id === f.offeringId);
    if (o) {
      L.push(`- Filed: sold ${describeAmount(o.soldAmount)}, offering ${describeAmount(o.offeringAmount)}, remaining ${describeAmount(o.remainingAmount)}, first sale ${o.firstSale.status === "date" ? o.firstSale.date : o.firstSale.status.replace(/_/g, " ")}, filed ${o.firstFilingDate ?? "?"}${o.latestFilingDate !== o.firstFilingDate ? ` (latest update ${o.latestFilingDate})` : ""}, investors ${o.investorCount ?? "not reported"}`);
      if (o.changes.length) L.push(`- Amendments: ${o.changes.join(" | ")}`);
    }
  }
  for (const c of r.competingCandidates) L.push(`- Competing candidate: ${c.statement}`);
  if (r.latestSecNotice && (!f || f.offeringId !== r.latestSecNotice.offeringId || !r.latestSecNotice.isNewFinancing)) {
    L.push("");
    L.push(`## Latest SEC notice/update`);
    L.push(`- Form ${r.latestSecNotice.form} ${r.latestSecNotice.accession} filed ${r.latestSecNotice.filingDate}: ${r.latestSecNotice.note}`);
  }
  if (r.issuers.review.length && r.filings.some((x) => r.issuers.review.some((c) => c.cik === x.cik))) {
    L.push("");
    L.push("## Unverified candidate filings (not attributed to this company)");
    for (const x of r.filings.filter((x) => r.issuers.review.some((c) => c.cik === x.cik)).slice(0, 4)) L.push(`- UNVERIFIED ${x.issuerName} ${x.form} ${x.accession} filed ${x.filingDate}: sold ${describeAmount(x.soldAmount)} toward ${describeAmount(x.offeringAmount)}`);
  }
  L.push("");
  L.push("## Announcement check");
  L.push(`- ${r.announcementCheck.statement}`);
  for (const a of r.announcements.slice(0, 5)) L.push(`- ${a.sourceKind.replace(/_/g, " ")}: ${a.title ?? a.url} (${a.publishedAt ?? "date unknown"}) ${a.amountText ?? ""} ${a.url}`);
  if (r.conflicts.length) {
    L.push("");
    L.push("## Conflicts (unresolved)");
    for (const c of r.conflicts.slice(0, 8)) L.push(`- ${c}`);
  }
  L.push("");
  L.push("## Coverage");
  for (const s of r.searched.slice(0, 10)) L.push(`- Searched ${s.source}: ${s.from ?? "earliest available"} to ${s.to ?? "?"} (${s.note})`);
  for (const g of r.coverageGaps.slice(0, 10)) L.push(`- GAP [${g.kind}] ${g.source}: ${g.detail}`);
  if (r.cache.reusedEntries) L.push(`- ${r.cache.reusedEntries} SEC response(s) reused from cache (oldest ${r.cache.oldestReusedAgeSeconds}s old)`);
  L.push(`- Budget used: ${r.budget.secRequests} SEC, ${r.budget.webRequests} web, ${r.budget.researchRequests} research requests in ${Math.round(r.budget.elapsedMs / 1000)}s${r.budget.exhausted ? " (budget exhausted, results partial)" : ""}`);
  L.push("");
  L.push(`_${r.disclaimer}_`);
  return L.join("\n");
}

/**
 * Compact, typed summary for the session result (<= 8 KiB JSON). The full
 * report lives in lookup_runs.report_json.
 */
export function compactReport(r: LookupReport, persistence: { planned: boolean; tables: string[] }) {
  const f = r.lastKnownFinancing;
  const o = f?.offeringId ? r.offerings.find((x) => x.id === f.offeringId) : undefined;
  const base = {
    lookup_id: r.lookupId,
    status: r.status,
    checked_at: r.checkedAt,
    submitted_url: r.input.submittedUrl,
    canonical_url: r.input.canonicalUrl,
    canonical_domain: r.input.canonicalDomain,
    verified_issuers: r.issuers.verified.slice(0, 4).map((v) => ({ cik: v.cik, name: v.name, confidence: v.confidence, status: v.status })),
    review_candidates: r.issuers.review.slice(0, 4).map((c) => ({ cik: c.cik, name: c.name, confidence: c.confidence, reason: (c.reasons[0] ?? "").slice(0, 160) })),
    last_known_financing: f
      ? {
          statement: f.statement.slice(0, 400),
          basis: f.basis,
          event_date: f.eventDate,
          date_type: f.dateType,
          amount_usd: f.amountUsd,
          currency: f.currency,
          amount_basis: f.amountBasis,
          category: f.category,
          stage: f.stage ? `${f.stage.value} (${f.stage.provenance})` : null,
          confidence: f.confidence,
          filed: o
            ? {
                sold: describeAmount(o.soldAmount),
                offering: describeAmount(o.offeringAmount),
                remaining: describeAmount(o.remainingAmount),
                first_sale: o.firstSale.status === "date" ? o.firstSale.date : o.firstSale.status,
                first_filing_date: o.firstFilingDate,
                latest_filing_date: o.latestFilingDate,
                investor_count: o.investorCount,
                accessions: o.filings.slice(-3),
              }
            : null,
        }
      : null,
    latest_sec_notice: r.latestSecNotice ? { accession: r.latestSecNotice.accession, form: r.latestSecNotice.form, filing_date: r.latestSecNotice.filingDate, is_new_financing: r.latestSecNotice.isNewFinancing, note: r.latestSecNotice.note.slice(0, 200) } : null,
    announcement_check: { status: r.announcementCheck.status, statement: r.announcementCheck.statement.slice(0, 300) },
    source_urls: [...new Set([...(o ? r.filings.filter((x) => o.filings.includes(x.accession)).map((x) => x.sourceUrl) : []), ...r.announcements.map((a) => a.url)])].slice(0, 6),
    conflicts: r.conflicts.slice(0, 3).map((c) => c.slice(0, 200)),
    coverage_gaps: r.coverageGaps.slice(0, 6).map((g) => `[${g.kind}] ${g.source}: ${g.detail}`.slice(0, 200)),
    searched: r.searched.slice(0, 5).map((s) => `${s.source}: ${s.from ?? "earliest"}..${s.to ?? "?"}`.slice(0, 160)),
    unknowns: r.unknowns.slice(0, 4).map((u) => `${u.field}: ${u.reason}`.slice(0, 160)),
    persistence_planned: persistence.planned,
    disclaimer: "Last known in checked sources; not a guaranteed latest private transaction.",
  };
  // Hard cap: drop optional detail until it fits.
  let json = JSON.stringify(base);
  const trims: (() => void)[] = [
    () => (base.searched = base.searched.slice(0, 2)),
    () => (base.coverage_gaps = base.coverage_gaps.slice(0, 3)),
    () => (base.source_urls = base.source_urls.slice(0, 3)),
    () => (base.review_candidates = base.review_candidates.slice(0, 2)),
    () => (base.unknowns = base.unknowns.slice(0, 1)),
  ];
  for (const t of trims) {
    if (Buffer.byteLength(json) <= 7600) break;
    t();
    json = JSON.stringify(base);
  }
  return base;
}

export const compactOutputSchema = {
  type: "object",
  properties: {
    lookup_id: { type: "string" },
    status: { type: "string", enum: ["financing_found", "offering_only", "nothing_found_in_completed_searches", "entity_review_required", "partial", "failed"] },
    checked_at: { type: "string" },
  },
  required: ["lookup_id", "status", "checked_at"],
} as const;

export { offeringStatement };
