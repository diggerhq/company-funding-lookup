import { coreName, looksLikeFund, normalizeName } from "./extract";
import type { IssuerRecord } from "./sec";
import type { EntityCandidate, FormDFiling, SiteProfile } from "./types";

// Candidate scoring. Name similarity alone never verifies an issuer. Auto-accept
// requires a company-source signal (legal name stated on the company's own site,
// or the SEC record listing the company's domain) plus at least one independent
// corroborator (jurisdiction, founder as filed related person, address), and no
// conflicts.

const STATE_CODES: Record<string, string> = {
  DE: "delaware", CA: "california", NY: "new york", WA: "washington", TX: "texas", MA: "massachusetts", NV: "nevada", FL: "florida",
  IL: "illinois", CO: "colorado", GA: "georgia", NJ: "new jersey", PA: "pennsylvania", OR: "oregon", UT: "utah", VA: "virginia",
  NC: "north carolina", MI: "michigan", MN: "minnesota", OH: "ohio", AZ: "arizona", WY: "wyoming", MD: "maryland", CT: "connecticut",
  A6: "ontario", A1: "british columbia", X0: "united kingdom", E9: "cayman islands", U0: "singapore", L3: "israel", "2M": "germany", I0: "france", P7: "the netherlands",
};

export function jurisdictionName(v: string | null): string | null {
  if (!v) return null;
  const t = v.trim();
  return (STATE_CODES[t.toUpperCase()] ?? t).toLowerCase();
}

export interface CandidateInput {
  issuer: IssuerRecord;
  sampleFilings: FormDFiling[];
  discoveredVia: string[]; // e.g. "edgar_entity_search:Acme Labs, Inc."
  viaFounderSearchOnly: boolean;
}

export function scoreCandidate(site: SiteProfile, c: CandidateInput, decision?: "confirmed" | "rejected"): EntityCandidate {
  const reasons: string[] = [];
  const conflicts: string[] = [];
  const evidenceUrls = new Set<string>([c.issuer.sourceUrl]);
  let score = 0;
  let companySource = false;
  let corroborators = 0;

  const edgarNames = [c.issuer.name, ...c.issuer.formerNames.map((f) => f.name), ...c.sampleFilings.flatMap((f) => [f.issuerName, ...f.previousNames])].filter(Boolean);
  const edgarNorm = new Set(edgarNames.map(normalizeName));
  const edgarCore = new Set(edgarNames.map(coreName));

  for (const ln of site.legalNames) {
    if (edgarNorm.has(normalizeName(ln.name))) {
      const former = c.issuer.formerNames.some((f) => normalizeName(f.name) === normalizeName(ln.name));
      reasons.push(`${former ? "EDGAR former name" : "EDGAR name"} exactly matches legal name "${ln.name}" stated on ${ln.url}`);
      evidenceUrls.add(ln.url);
      score += former ? 40 : 50;
      companySource = true;
      break;
    }
  }
  if (!companySource && site.legalNames.some((ln) => edgarCore.has(coreName(ln.name)))) {
    reasons.push("EDGAR name matches a site legal name apart from the entity suffix (weak)");
    score += 15;
  }
  if (!companySource && site.brandName && edgarCore.has(coreName(site.brandName))) {
    reasons.push(`EDGAR name resembles brand "${site.brandName}" (name similarity only)`);
    score += 10;
  }

  if (c.issuer.website && site.canonicalDomain) {
    const w = c.issuer.website.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
    if (w === site.canonicalDomain) {
      reasons.push(`EDGAR record lists website ${c.issuer.website}`);
      score += 35;
      companySource = true;
      corroborators++;
    }
  }

  const siteJur = site.jurisdictions.map((j) => j.value.toLowerCase());
  const edgarJur = [jurisdictionName(c.issuer.stateOfIncorporation), ...c.sampleFilings.map((f) => jurisdictionName(f.jurisdiction))].filter(Boolean) as string[];
  if (siteJur.length && edgarJur.length) {
    if (siteJur.some((j) => edgarJur.includes(j))) {
      const src = site.jurisdictions.find((j) => edgarJur.includes(j.value.toLowerCase()))!;
      reasons.push(`Jurisdiction ${src.value} on ${src.url} matches EDGAR/Form D`);
      evidenceUrls.add(src.url);
      score += 15;
      corroborators++;
    } else {
      conflicts.push(`Site states ${siteJur.join("/")} but EDGAR/Form D shows ${[...new Set(edgarJur)].join("/")}`);
      score -= 25;
    }
  }

  const filedPeople = new Map<string, string>();
  for (const f of c.sampleFilings) for (const p of f.relatedPersons) filedPeople.set(personKey(p.name), `${p.name} (${p.roles.join(", ") || "role not stated"}) in ${f.accession}`);
  let founderHits = 0;
  for (const fo of site.founders) {
    const hit = filedPeople.get(personKey(fo.name));
    if (hit && founderHits < 2) {
      founderHits++;
      reasons.push(`Founder "${fo.name}" stated on ${fo.url} is a filed related person: ${hit}`);
      evidenceUrls.add(fo.url);
      score += 15;
    }
  }
  if (founderHits) corroborators++;

  const siteCities = site.addresses.map((a) => a.value.toLowerCase());
  const edgarCities = [c.issuer.businessCity, ...c.sampleFilings.map((f) => f.issuerCity)].filter(Boolean).map((x) => String(x).toLowerCase());
  if (edgarCities.some((city) => siteCities.some((a) => a.includes(city)))) {
    reasons.push("Business address city matches an address on the company site");
    score += 10;
    corroborators++;
  }

  const fund = looksLikeFund(c.issuer.name) || c.sampleFilings.some((f) => f.category === "pooled_fund");
  if (fund && !site.legalNames.some((ln) => normalizeName(ln.name) === normalizeName(c.issuer.name))) {
    conflicts.push("Looks like an investment fund/SPV rather than an operating company");
    score -= 40;
  }
  if (c.viaFounderSearchOnly) conflicts.push("Found only through a founder-name search (a clue, not identity proof)");
  if (c.issuer.tickers.length) reasons.push(`Public tickers on record: ${c.issuer.tickers.join(", ")}`);

  const autoAccept = companySource && corroborators >= 1 && conflicts.length === 0;
  let status: EntityCandidate["status"] = autoAccept ? "verified" : score < -10 ? "rejected" : "review";
  if (decision === "confirmed") status = "user_confirmed";
  if (decision === "rejected") status = "user_rejected";
  const confidence: EntityCandidate["confidence"] = status === "verified" && score >= 80 ? "high" : status === "verified" || status === "user_confirmed" || score >= 40 ? "medium" : "low";
  if (!reasons.length) reasons.push("No source-supported match signals");
  return {
    cik: c.issuer.cik,
    name: c.issuer.name,
    status,
    confidence,
    score,
    reasons: [...reasons, ...c.discoveredVia.map((v) => `discovered via ${v}`)].slice(0, 10),
    conflicts,
    evidenceUrls: [...evidenceUrls].slice(0, 8),
    formerNames: c.issuer.formerNames.map((f) => f.name),
    jurisdiction: c.issuer.stateOfIncorporation,
    isLikelyFund: fund,
  };
}

function personKey(name: string): string {
  const parts = name.toLowerCase().replace(/[^a-z\s-]/g, "").split(/\s+/).filter(Boolean);
  return parts.length >= 2 ? `${parts[0]} ${parts.at(-1)}` : parts.join(" ");
}
