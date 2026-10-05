import { defineTool } from "@opencomputer/agent";
import { compactOutputSchema } from "../lib/report";
import { verifyResult } from "../lib/signing";

export const fundingReportResult = defineTool({
  name: "funding_report_result",
  description: "Commit the typed lookup result. Pass result_json and result_signature exactly as funding_lookup returned them; a modified value is rejected.",
  input: {
    type: "object",
    properties: { result_json: { type: "string", maxLength: 8000 }, result_signature: { type: "string" } },
    required: ["result_json", "result_signature"],
    additionalProperties: false,
  },
  output: compactOutputSchema,
  result: true,
  async run({ input }) {
    const json = String(input.result_json);
    if (!verifyResult(json, String(input.result_signature))) throw new Error("Result signature does not match; pass the values from funding_lookup unchanged.");
    return JSON.parse(json);
  },
});
