import { defineTool } from "@opencomputer/agent";
import { contextDevPost } from "../lib/context-dev";
import { verifyOwner } from "../lib/owner";
import { verificationQuery } from "../lib/persist";
import { compactReport, renderReport } from "../lib/report";
import { lookupAndPlan, takeSessionLookup, MAX_LOOKUPS_PER_SESSION } from "../lib/runtime";
import { writeCode } from "../lib/scripts";
import { signResult } from "../lib/signing";
import { data } from "../lib/types";

const ciks = { type: "array", items: { type: "string", pattern: "^\\d{1,10}$" }, maxItems: 5 } as const;

export const fundingLookup = defineTool({
  name: "funding_lookup",
  description:
    "Run the deterministic company-funding lookup for one company URL (URL safety, company pages, SEC EDGAR issuer resolution, Form D/D-A history, offering grouping, announcement cross-check). Returns result_json + result_signature (pass both unchanged to funding_report_result), readable_report, and persist_code (pass unchanged as the code argument of execute).",
  input: {
    type: "object",
    properties: {
      url: { type: "string" },
      owner_token: { type: "string" },
      confirmed_ciks: ciks,
      rejected_ciks: ciks,
      trigger: { type: "string", enum: ["check", "resolve"] },
    },
    required: ["url", "owner_token"],
    additionalProperties: false,
  },
  async run({ input, sessionId, toolCallId, reportProgress }) {
    const owner = verifyOwner(input.owner_token, sessionId);
    if (!owner.ok) throw new Error(`Not authorized: ${owner.reason}`);
    if (!takeSessionLookup(sessionId)) throw new Error(`Lookup budget for this session reached (${MAX_LOOKUPS_PER_SESSION}); start a new check.`);
    await reportProgress({ phase: "looking up" });
    const { report, plan } = await lookupAndPlan({
      url: String(input.url),
      ownerId: owner.ownerId,
      sessionId,
      toolCallId,
      confirmedCiks: (input.confirmed_ciks as string[] | undefined) ?? [],
      rejectedCiks: (input.rejected_ciks as string[] | undefined) ?? [],
      post: contextDevPost,
    });
    const compact = { ...compactReport(report, { planned: plan.statements.length > 0, tables: Object.keys(plan.expected) }), report_sha256: plan.reportSha256 };
    const resultJson = JSON.stringify(compact);
    return data({
      lookup_id: report.lookupId,
      status: report.status,
      result_json: resultJson,
      result_signature: signResult(resultJson),
      readable_report: renderReport(report),
      persist_code: plan.statements.length ? writeCode(plan.statements, verificationQuery(owner.ownerId, report.lookupId)) : null,
      expected: { report_sha256: plan.reportSha256, ...plan.expected },
    });
  },
});
