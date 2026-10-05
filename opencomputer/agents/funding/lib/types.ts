import type { DataValue } from "@opencomputer/agent";

// Shared types for the funding lookup. Everything here is JSON-compatible so it
// can flow through tool results, the session result and the database.

export type Iso = string; // ISO-8601 timestamp or YYYY-MM-DD date

/** A filed amount, preserving the raw value and the absent/zero/indefinite distinction. */
export type FiledAmount =
  | { kind: "value"; raw: string; usd: string } // usd: integer dollars as a decimal string
  | { kind: "indefinite"; raw: string }
  | { kind: "absent"; raw: null }
  | { kind: "unparseable"; raw: string };

export type SecurityCategory = "equity" | "debt" | "convertible_or_hybrid" | "pooled_fund" | "other" | "unknown";

export interface RelatedPerson {
  name: string;
  roles: string[]; // as filed: Executive Officer, Director, Promoter
  clarification: string | null;
}

export interface FormDFiling {
  accession: string; // 0001234567-26-000001
  form: "D" | "D/A";
  cik: string; // 10-digit
  issuerName: string;
  filingDate: string | null; // from EDGAR metadata
  sourceUrl: string; // original XML URL
  indexUrl: string;
  sha256: string;
  fetchedAt: Iso;
  isAmendment: boolean;
  previousAccession: string | null;
  firstSale: { status: "date"; date: string } | { status: "yet_to_occur" } | { status: "absent" };
  securities: { equity: boolean; debt: boolean; option: boolean; securityToBeAcquired: boolean; pooledFund: boolean; other: boolean; otherDescription: string | null };
  category: SecurityCategory;
  exemptions: string[];
  offeringAmount: FiledAmount;
  soldAmount: FiledAmount;
  remainingAmount: FiledAmount;
  investorCount: { raw: string | null; value: number | null };
  nonAccreditedInvestors: boolean | null;
  moreThanOneYear: boolean | null;
  relatedPersons: RelatedPerson[];
  jurisdiction: string | null;
  issuerCity: string | null;
  issuerState: string | null;
  previousNames: string[];
  signatureDate: string | null;
  industryGroup: string | null;
}

export interface CoverageGap {
  source: string;
  kind: "failed" | "blocked" | "timeout" | "malformed" | "budget_exhausted" | "unavailable" | "not_searched" | "partial";
  detail: string;
}

export interface SearchedRange {
  source: string;
  from: string | null;
  to: string | null;
  note: string;
}

export interface EvidenceItem {
  id: string;
  kind: "entity_source" | "filed_fact" | "company_announcement" | "investor_announcement" | "reporting" | "aggregator" | "inference";
  url: string;
  excerpt: string; // short, untrusted text; never instructions
  sourceDate: string | null;
  retrievedAt: Iso;
  claims: string[];
}

export interface EntityCandidate {
  cik: string;
  name: string;
  status: "verified" | "review" | "rejected" | "user_confirmed" | "user_rejected";
  confidence: "high" | "medium" | "low";
  score: number;
  reasons: string[]; // why it matches
  conflicts: string[]; // why it may not
  evidenceUrls: string[];
  formerNames: string[];
  jurisdiction: string | null;
  isLikelyFund: boolean;
}

export interface SiteProfile {
  submittedUrl: string;
  canonicalUrl: string | null;
  canonicalDomain: string | null;
  redirectChain: string[];
  brandName: string | null;
  legalNames: { name: string; url: string }[];
  jurisdictions: { value: string; url: string }[];
  founders: { name: string; url: string }[];
  addresses: { value: string; url: string }[];
  pagesFetched: { url: string; status: number | null; retrievedAt: Iso; kind: string }[];
  newsPages: string[];
}

export interface Offering {
  id: string; // stable: owner-independent root accession
  cik: string;
  issuerName: string;
  rootAccession: string;
  filings: string[]; // accessions, oldest first
  latestAccession: string;
  linkStatus: "single" | "linked_by_previous_accession" | "uncertain_link";
  category: SecurityCategory;
  firstSale: FormDFiling["firstSale"];
  firstFilingDate: string | null;
  latestFilingDate: string | null;
  offeringAmount: FiledAmount;
  soldAmount: FiledAmount;
  remainingAmount: FiledAmount;
  investorCount: number | null;
  changes: string[]; // human-readable amendment deltas, never summed
  isNoticeOnly: boolean; // first sale yet to occur in the latest filing
}

export interface Announcement {
  id: string;
  url: string;
  title: string | null;
  publishedAt: string | null;
  sourceKind: "company_announcement" | "investor_announcement" | "reporting" | "aggregator";
  publisher: string | null;
  amountUsd: string | null; // integer dollars as decimal string
  amountText: string | null;
  stageText: string | null; // as stated by the source, never inferred
  excerpt: string;
  retrievedAt: Iso;
}

export type LookupStatus =
  | "financing_found"
  | "offering_only"
  | "nothing_found_in_completed_searches"
  | "entity_review_required"
  | "partial"
  | "failed";

export interface FinancingEvent {
  basis: "sec_filing" | "announcement" | "filing_and_announcement";
  offeringId: string | null;
  announcementIds: string[];
  eventDate: string | null;
  dateType: "first_sale" | "filing_date" | "announcement_published" | null;
  amountUsd: string | null;
  currency: "USD" | null;
  amountBasis: string | null; // e.g. "reported sold toward offering as of filing date"
  category: SecurityCategory;
  stage: { value: string; provenance: "company_stated" | "reporting" | "aggregator_reported" } | null;
  confidence: "high" | "medium" | "low";
  statement: string; // deterministic, careful wording
}

export interface LookupReport {
  lookupId: string;
  status: LookupStatus;
  checkedAt: Iso;
  input: { submittedUrl: string; canonicalUrl: string | null; canonicalDomain: string | null };
  issuers: { verified: EntityCandidate[]; review: EntityCandidate[] };
  lastKnownFinancing: FinancingEvent | null;
  competingCandidates: FinancingEvent[];
  latestSecNotice: { accession: string; form: string; filingDate: string | null; offeringId: string; isNewFinancing: boolean; note: string } | null;
  offerings: Offering[];
  filings: FormDFiling[];
  announcements: Announcement[];
  announcementCheck: { status: "complete" | "incomplete" | "not_run"; matched: boolean; statement: string; sourcesChecked: string[] };
  conflicts: string[];
  coverageGaps: CoverageGap[];
  searched: SearchedRange[];
  evidence: EvidenceItem[];
  unknowns: { field: string; reason: string }[];
  budget: { secRequests: number; webRequests: number; researchRequests: number; elapsedMs: number; exhausted: boolean };
  cache: { reusedEntries: number; oldestReusedAgeSeconds: number | null };
  disclaimer: string;
}

/** Check a tool result literal against DataValue without union widening. */
export const data = (v: DataValue): DataValue => v;
