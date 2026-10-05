import { defineTool } from "@opencomputer/agent";
import { data } from "../lib/types";
import { contextDevPost } from "../lib/context-dev";
import { verifyOwner } from "../lib/owner";
import { renderReport } from "../lib/report";
import { lookupAndPlan } from "../lib/runtime";
import { readCode, writeCode } from "../lib/scripts";
import { createWatch, disableWatch, dueWatches, listWatches, watchRunStatements } from "../lib/watch";

export const fundingWatch = defineTool({
  name: "funding_watch",
  description:
    "Manage the owner's optional daily watches. action=create requires the owner's explicit opt-in in this request; list and disable are read/clean-up. Notifications stay disabled; no destination can be set here. Returns code to pass unchanged to execute.",
  input: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["create", "list", "disable"] },
      url: { type: "string" },
      watch_id: { type: "string", pattern: "^w:[a-f0-9]{16}$" },
      opt_in_confirmed: { type: "boolean", description: "true only if the owner explicitly asked to watch this URL" },
      owner_token: { type: "string" },
    },
    required: ["action", "owner_token"],
    additionalProperties: false,
  },
  async run({ input, sessionId }) {
    const owner = verifyOwner(input.owner_token, sessionId);
    if (!owner.ok) throw new Error(`Not authorized: ${owner.reason}`);
    const now = new Date().toISOString();
    if (input.action === "create") {
      if (input.opt_in_confirmed !== true) throw new Error("A watch needs the owner's explicit opt-in.");
      if (typeof input.url !== "string") throw new Error("url is required");
      const w = createWatch(owner.ownerId, input.url, now);
      return data({ code: writeCode([w.statement]), watch_id: w.watchId, cadence: "daily", notifications: "disabled until a destination is approved", note: "The first scheduled run records a baseline; existing findings are not alerts. A daily scan is not real-time detection." });
    }
    if (input.action === "list") return data({ code: readCode([{ name: "watches", statement: listWatches(owner.ownerId) }]) });
    if (typeof input.watch_id !== "string") throw new Error("watch_id is required");
    return data({ code: writeCode([disableWatch(owner.ownerId, input.watch_id, now)]) });
  },
});

// The two tools below are attached only to sessions whose input source is the
// platform-attested "schedule" (see agent.ts); user sessions never see them.

export const watchDue = defineTool({
  name: "watch_dispatch_due",
  description: "Scheduled dispatcher: returns code (pass unchanged to execute) listing due watches (at most 5).",
  input: { type: "object", properties: {}, additionalProperties: false },
  async run() {
    return data({ code: readCode([{ name: "due", statement: dueWatches(new Date().toISOString(), 5) }]) });
  },
});

export const watchRun = defineTool({
  name: "watch_dispatch_run",
  description: "Scheduled dispatcher: run the lookup for one due watch row (owner_id, id, company_url exactly as returned by the due query) and return code (pass unchanged to execute) that persists the lookup and its watch events.",
  input: {
    type: "object",
    properties: {
      owner_id: { type: "string", pattern: "^[A-Za-z0-9_.:@-]{1,128}$" },
      watch_id: { type: "string", pattern: "^w:[a-f0-9]{16}$" },
      company_url: { type: "string" },
    },
    required: ["owner_id", "watch_id", "company_url"],
    additionalProperties: false,
  },
  async run({ input, sessionId, toolCallId }) {
    const ownerId = String(input.owner_id);
    const { report, plan: p } = await lookupAndPlan({ url: String(input.company_url), ownerId, sessionId, toolCallId, post: contextDevPost, trigger: "watch" });
    return data({
      lookup_id: report.lookupId,
      status: report.status,
      summary: renderReport(report).split("\n").slice(0, 12).join("\n"),
      code: writeCode([...p.statements, ...watchRunStatements(ownerId, String(input.watch_id), report)]),
    });
  },
});
