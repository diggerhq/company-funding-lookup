import { amountValue, describeAmount } from "./money";
import type { FormDFiling, Offering } from "./types";

// Group filings into offerings. A D/A updates an offering; it is linked to its
// original only through the filed previousAccessionNumber. Amounts are never
// summed across filings: the latest filing's cumulative values stand.

export function groupOfferings(filings: FormDFiling[]): { offerings: Offering[]; conflicts: string[] } {
  const byAcc = new Map(filings.map((f) => [f.accession, f]));
  const conflicts: string[] = [];
  const rootOf = new Map<string, { root: string; status: Offering["linkStatus"] }>();

  const resolveRoot = (f: FormDFiling, seen = new Set<string>()): { root: string; status: Offering["linkStatus"] } => {
    if (rootOf.has(f.accession)) return rootOf.get(f.accession)!;
    let result: { root: string; status: Offering["linkStatus"] };
    if (!f.isAmendment) result = { root: f.accession, status: "single" };
    else if (!f.previousAccession) result = { root: f.accession, status: "uncertain_link" };
    else {
      const prev = byAcc.get(f.previousAccession);
      if (!prev || seen.has(prev.accession) || prev.cik !== f.cik) {
        result = { root: f.accession, status: "uncertain_link" };
      } else {
        seen.add(f.accession);
        const r = resolveRoot(prev, seen);
        result = { root: r.root, status: r.status === "uncertain_link" ? "uncertain_link" : "linked_by_previous_accession" };
      }
    }
    rootOf.set(f.accession, result);
    return result;
  };

  const groups = new Map<string, FormDFiling[]>();
  const statusByRoot = new Map<string, Offering["linkStatus"]>();
  for (const f of filings) {
    const { root, status } = resolveRoot(f);
    groups.set(root, [...(groups.get(root) ?? []), f]);
    const prev = statusByRoot.get(root);
    if (prev !== "uncertain_link") statusByRoot.set(root, status === "single" && prev ? prev : status);
  }

  const offerings: Offering[] = [];
  for (const [root, list] of groups) {
    list.sort((a, b) => (a.filingDate ?? "").localeCompare(b.filingDate ?? "") || a.accession.localeCompare(b.accession));
    const latest = list.at(-1)!;
    const first = list[0];
    const dated = [...list].reverse().find((f) => f.firstSale.status === "date");
    const firstSale = dated ? dated.firstSale : latest.firstSale;
    const distinctDates = new Set(list.filter((f) => f.firstSale.status === "date").map((f) => (f.firstSale as any).date));
    if (distinctDates.size > 1) conflicts.push(`Offering ${root}: filings report different first-sale dates (${[...distinctDates].join(", ")}); using the latest filing's value`);
    const changes: string[] = [];
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1];
      const b = list[i];
      const diffs: string[] = [];
      if (describeAmount(a.soldAmount) !== describeAmount(b.soldAmount)) diffs.push(`sold ${describeAmount(a.soldAmount)} -> ${describeAmount(b.soldAmount)}`);
      if (describeAmount(a.offeringAmount) !== describeAmount(b.offeringAmount)) diffs.push(`offering ${describeAmount(a.offeringAmount)} -> ${describeAmount(b.offeringAmount)}`);
      if ((a.investorCount.raw ?? "") !== (b.investorCount.raw ?? "")) diffs.push(`investors ${a.investorCount.raw ?? "not reported"} -> ${b.investorCount.raw ?? "not reported"}`);
      if (JSON.stringify(a.firstSale) !== JSON.stringify(b.firstSale)) diffs.push(`first sale ${fs(a)} -> ${fs(b)}`);
      changes.push(`${b.form} ${b.accession} (filed ${b.filingDate ?? "date unknown"}): ${diffs.length ? diffs.join("; ") : "no change in reported amounts"} (cumulative as filed, not summed)`);
      const av = amountValue(a.soldAmount);
      const bv = amountValue(b.soldAmount);
      if (av !== null && bv !== null && bv < av) conflicts.push(`Offering ${root}: amount sold decreased in ${b.accession} (${describeAmount(a.soldAmount)} -> ${describeAmount(b.soldAmount)})`);
    }
    const status = statusByRoot.get(root) ?? "single";
    offerings.push({
      id: `offering:${root}`,
      cik: latest.cik,
      issuerName: latest.issuerName,
      rootAccession: root,
      filings: list.map((f) => f.accession),
      latestAccession: latest.accession,
      linkStatus: list.length === 1 && status !== "uncertain_link" ? "single" : status,
      category: latest.category,
      firstSale,
      firstFilingDate: first.filingDate,
      latestFilingDate: latest.filingDate,
      offeringAmount: latest.offeringAmount,
      soldAmount: latest.soldAmount,
      remainingAmount: latest.remainingAmount,
      investorCount: latest.investorCount.value,
      changes,
      isNoticeOnly: latest.firstSale.status === "yet_to_occur",
    });
    if (status === "uncertain_link") {
      const missing = first.previousAccession && !byAcc.has(first.previousAccession) ? ` (references ${first.previousAccession}, not retrieved)` : "";
      conflicts.push(`Amendment ${first.accession} could not be linked to an original filing from source evidence${missing}; needs review`);
    }
  }
  offerings.sort((a, b) => eventDateOf(b).localeCompare(eventDateOf(a)));
  return { offerings, conflicts };
}

function fs(f: FormDFiling) {
  return f.firstSale.status === "date" ? f.firstSale.date : f.firstSale.status === "yet_to_occur" ? "yet to occur" : "not reported";
}

export function eventDateOf(o: Offering): string {
  return o.firstSale.status === "date" ? o.firstSale.date : o.firstFilingDate ?? "";
}

/** Careful wording for an offering's filed amounts. */
export function offeringStatement(o: Offering): string {
  const sold = describeAmount(o.soldAmount);
  const target = o.offeringAmount.kind === "indefinite" ? "an offering of indefinite size" : o.offeringAmount.kind === "value" ? `a ${describeAmount(o.offeringAmount)} offering` : "an offering whose total was not reported";
  const asOf = `as of filing date ${o.latestFilingDate ?? "unknown"} (Form ${o.latestAccession === o.rootAccession ? "D" : "D/A"} ${o.latestAccession})`;
  if (o.isNoticeOnly) return `Offering notice only: first sale had not yet occurred ${asOf}; ${target}. This is not a completed raise.`;
  const first = o.firstSale.status === "date" ? `first sale ${o.firstSale.date}` : "first-sale date not reported";
  const soldPart = o.soldAmount.kind === "value" ? `${sold} reported sold toward ${target}` : `Amount sold ${sold} for ${target}`;
  return `${soldPart} ${asOf}; ${first}.`;
}
