import { createHash } from "node:crypto";
import { parseXml } from "./xml";
import { parseFiledAmount } from "./money";
import type { FormDFiling, SecurityCategory } from "./types";

// Deterministic Form D XML parsing. Values stay as filed strings; nothing is
// interpreted by a model.

const ARRAYS = new Set(["relatedPersonInfo", "relationship", "item", "signature", "value", "issuer"]);

export class FormDParseError extends Error {}

const s = (v: unknown): string | null => {
  if (v === undefined || v === null) return null;
  if (Array.isArray(v)) return v.length ? s(v[0]) : null;
  if (typeof v === "object") return null;
  const t = String(v).trim();
  return t === "" ? null : t;
};
const bool = (v: unknown): boolean | null => {
  const t = s(v);
  if (t === null) return null;
  return /^(true|y|yes|1)$/i.test(t) ? true : /^(false|n|no|0)$/i.test(t) ? false : null;
};

export function padCik(cik: string | number): string {
  const digits = String(cik).replace(/\D/g, "");
  if (!digits || digits.length > 10) throw new Error(`Invalid CIK ${cik}`);
  return digits.padStart(10, "0");
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function categorize(sec: FormDFiling["securities"]): SecurityCategory {
  const other = (sec.otherDescription ?? "").toLowerCase();
  if (sec.pooledFund) return "pooled_fund";
  const convertibleWords = /convertible|safe\b|simple agreement for future equity/.test(other);
  if (convertibleWords || (sec.debt && (sec.option || sec.securityToBeAcquired))) return "convertible_or_hybrid";
  if (sec.equity && !sec.debt) return "equity";
  if (sec.debt && !sec.equity) return "debt";
  if (sec.equity && sec.debt) return "convertible_or_hybrid";
  if (sec.other || sec.option || sec.securityToBeAcquired) return "other";
  return "unknown";
}

export function parseFormD(
  xml: string,
  meta: { accession: string; form?: string | null; filingDate: string | null; sourceUrl: string; indexUrl: string; fetchedAt: string },
): FormDFiling {
  let doc: any;
  try {
    doc = parseXml(xml, ARRAYS);
  } catch (e) {
    throw new FormDParseError(`Unparseable XML: ${(e as Error).message}`);
  }
  const sub = doc?.edgarSubmission;
  if (!sub || typeof sub !== "object") throw new FormDParseError("Not a Form D edgarSubmission document");
  const submissionType = s(sub.submissionType);
  if (submissionType !== "D" && submissionType !== "D/A") throw new FormDParseError(`Unexpected submissionType ${submissionType}`);
  const issuer = sub.primaryIssuer ?? {};
  const od = sub.offeringData ?? {};
  const tof = od.typeOfFiling ?? {};
  const noa = tof.newOrAmendment ?? {};
  const dfs = tof.dateOfFirstSale ?? {};
  const types = od.typesOfSecuritiesOffered ?? {};
  const amounts = od.offeringSalesAmounts ?? {};
  const investors = od.investors ?? {};

  const firstSaleDate = s(dfs.value);
  const yetToOccur = bool(dfs.yetToOccur);
  const firstSale: FormDFiling["firstSale"] = firstSaleDate && /^\d{4}-\d{2}-\d{2}$/.test(firstSaleDate)
    ? { status: "date", date: firstSaleDate }
    : yetToOccur
      ? { status: "yet_to_occur" }
      : { status: "absent" };

  const securities = {
    equity: bool(types.isEquityType) === true,
    debt: bool(types.isDebtType) === true,
    option: bool(types.isOptionToAcquireType) === true,
    securityToBeAcquired: bool(types.isSecurityToBeAcquiredType) === true,
    pooledFund: bool(types.isPooledInvestmentFundType) === true,
    other: bool(types.isOtherType) === true,
    otherDescription: s(types.descriptionOfOtherType),
  };

  const persons = (sub.relatedPersonsList?.relatedPersonInfo ?? []).map((p: any) => {
    const n = p.relatedPersonName ?? {};
    const name = [s(n.firstName), s(n.middleName), s(n.lastName)].filter(Boolean).join(" ");
    return {
      name,
      roles: (p.relatedPersonRelationshipList?.relationship ?? []).map((r: unknown) => s(r)).filter(Boolean) as string[],
      clarification: s(p.relationshipClarification),
    };
  });

  const prevNames = [...(issuer.issuerPreviousNameList?.value ?? []), ...(issuer.edgarPreviousNameList?.value ?? [])]
    .map((v: unknown) => s(v))
    .filter((v): v is string => !!v && !/^none$/i.test(v));

  const invRaw = s(investors.totalNumberAlreadyInvested);
  const isAmendment = bool(noa.isAmendment) === true;
  const sig = (od.signatureBlock?.signature ?? [])[0] ?? {};
  const form = (submissionType as "D" | "D/A") ?? (isAmendment ? "D/A" : "D");

  return {
    accession: meta.accession,
    form,
    cik: padCik(s(issuer.cik) ?? "0"),
    issuerName: s(issuer.entityName) ?? "",
    filingDate: meta.filingDate,
    sourceUrl: meta.sourceUrl,
    indexUrl: meta.indexUrl,
    sha256: sha256(xml),
    fetchedAt: meta.fetchedAt,
    isAmendment,
    previousAccession: s(noa.previousAccessionNumber),
    firstSale,
    securities,
    category: categorize(securities),
    exemptions: (od.federalExemptionsExclusions?.item ?? []).map((i: unknown) => s(i)).filter(Boolean) as string[],
    offeringAmount: parseFiledAmount(s(amounts.totalOfferingAmount)),
    soldAmount: parseFiledAmount(s(amounts.totalAmountSold)),
    remainingAmount: parseFiledAmount(s(amounts.totalRemaining)),
    investorCount: { raw: invRaw, value: invRaw !== null && /^\d+$/.test(invRaw) ? Number(invRaw) : null },
    nonAccreditedInvestors: bool(investors.hasNonAccreditedInvestors),
    moreThanOneYear: bool(od.durationOfOffering?.moreThanOneYear),
    relatedPersons: persons,
    jurisdiction: s(issuer.jurisdictionOfInc),
    issuerCity: s(issuer.issuerAddress?.city),
    issuerState: s(issuer.issuerAddress?.stateOrCountryDescription) ?? s(issuer.issuerAddress?.stateOrCountry),
    previousNames: prevNames,
    signatureDate: s(sig.signatureDate),
    industryGroup: s(od.industryGroup?.industryGroupType),
  };
}
