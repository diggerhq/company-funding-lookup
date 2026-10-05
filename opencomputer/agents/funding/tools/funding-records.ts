import { defineTool } from "@opencomputer/agent";
import { data } from "../lib/types";
import { verifyOwner } from "../lib/owner";
import { companyId } from "../lib/persist";
import { readCode, writeCode } from "../lib/scripts";
import { canonicalDomain, normalizeInputUrl } from "../lib/url-safety";

// Owner-scoped statements for prior decisions, evidence inspection and candidate
// resolution. Every statement binds the verified owner id; none accepts an owner
// from the model.

export const fundingPrepare = defineTool({
  name: "funding_prepare",
  description: "Before a check without supplied decisions: returns code (pass unchanged to execute) that reads the owner's recorded candidate decisions and the previous lookup of this company.",
  input: {
    type: "object",
    properties: { url: { type: "string" }, owner_token: { type: "string" } },
    required: ["url", "owner_token"],
    additionalProperties: false,
  },
  async run({ input, sessionId }) {
    const owner = verifyOwner(input.owner_token, sessionId);
    if (!owner.ok) throw new Error(`Not authorized: ${owner.reason}`);
    const cid = companyId(canonicalDomain(normalizeInputUrl(String(input.url))));
    return data({
      code: readCode([
        { name: "decisions", statement: { sql: "SELECT cik, status FROM entity_candidates WHERE owner_id = ? AND company_id = ? AND status IN ('user_confirmed','user_rejected')", parameters: [owner.ownerId, cid] } },
        { name: "previous_lookup", statement: { sql: "SELECT id, status, checked_at FROM lookup_runs WHERE owner_id = ? AND company_id = ? ORDER BY checked_at DESC LIMIT 1", parameters: [owner.ownerId, cid] } },
      ]),
    });
  },
});

export const fundingInspectEvidence = defineTool({
  name: "funding_inspect_evidence",
  description: "Returns code (pass unchanged to execute) that reads one lookup's stored evidence, filings and offerings for this owner.",
  input: {
    type: "object",
    properties: { lookup_id: { type: "string", pattern: "^lk_[a-f0-9]{1,40}$" }, owner_token: { type: "string" } },
    required: ["lookup_id", "owner_token"],
    additionalProperties: false,
  },
  async run({ input, sessionId }) {
    const owner = verifyOwner(input.owner_token, sessionId);
    if (!owner.ok) throw new Error(`Not authorized: ${owner.reason}`);
    const id = String(input.lookup_id);
    return data({
      code: readCode([
        { name: "run", statement: { sql: "SELECT id, status, checked_at, submitted_url, canonical_url, report_sha256 FROM lookup_runs WHERE owner_id = ? AND id = ?", parameters: [owner.ownerId, id] } },
        { name: "evidence", statement: { sql: "SELECT kind, url, excerpt, source_date, retrieved_at, claims_json FROM evidence WHERE owner_id = ? AND lookup_id = ? ORDER BY kind, source_date DESC LIMIT 60", parameters: [owner.ownerId, id] } },
        { name: "filings", statement: { sql: "SELECT accession, form, filing_date, attribution, issuer_name, sold_amount_raw, offering_amount_raw, first_sale_status, first_sale_date, source_url, sha256 FROM filings WHERE owner_id = ? AND last_lookup_id = ? ORDER BY filing_date DESC LIMIT 40", parameters: [owner.ownerId, id] } },
        { name: "offerings", statement: { sql: "SELECT id, root_accession, latest_accession, link_status, category, first_sale_date, sold_amount_raw, offering_amount_raw, is_notice_only, changes_json FROM offerings WHERE owner_id = ? AND last_lookup_id = ? LIMIT 40", parameters: [owner.ownerId, id] } },
      ]),
    });
  },
});

export const fundingResolveCandidate = defineTool({
  name: "funding_resolve_candidate",
  description: "Record the owner's decision on an entity candidate (confirm or reject a CIK for a company URL). Only call when the owner explicitly decided. Returns code (pass unchanged to execute) and the cik list to use in the follow-up funding_lookup.",
  input: {
    type: "object",
    properties: {
      url: { type: "string" },
      cik: { type: "string", pattern: "^\\d{1,10}$" },
      decision: { type: "string", enum: ["confirm", "reject"] },
      owner_token: { type: "string" },
    },
    required: ["url", "cik", "decision", "owner_token"],
    additionalProperties: false,
  },
  async run({ input, sessionId }) {
    const owner = verifyOwner(input.owner_token, sessionId);
    if (!owner.ok) throw new Error(`Not authorized: ${owner.reason}`);
    const cid = companyId(canonicalDomain(normalizeInputUrl(String(input.url))));
    const cik = String(input.cik).padStart(10, "0");
    const status = input.decision === "confirm" ? "user_confirmed" : "user_rejected";
    const now = new Date().toISOString();
    return data({
      code: writeCode([
        {
          sql: "UPDATE entity_candidates SET status = ?, decided_by_user_at = ?, updated_at = ? WHERE owner_id = ? AND company_id = ? AND cik = ?",
          parameters: [status, now, now, owner.ownerId, cid, cik],
        },
      ]),
      next: input.decision === "confirm" ? { confirmed_ciks: [cik] } : { rejected_ciks: [cik] },
      note: "If the update affected 0 rows, the candidate was never recorded for this owner and company; run a check first.",
    });
  },
});
