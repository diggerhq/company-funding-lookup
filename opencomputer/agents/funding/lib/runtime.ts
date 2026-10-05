import { createHash } from "node:crypto";
import { loadConfig } from "./config";
import { runLookup } from "./lookup";
import { buildPersistencePlan } from "./persist";
import { ContextDevProvider, UnavailableProvider, type PostFn, type ResearchProvider } from "./research-provider";
import { SecClient } from "./sec-http";

// Glue used by the OpenComputer tools. Tool calls may run in different runtime
// processes, so nothing here is relied on across calls. The per-session lookup
// counter is best-effort (per process); the hard limits are the per-lookup
// request/time budgets in config.

const sessionCalls = new Map<string, number>();
export const MAX_LOOKUPS_PER_SESSION = 3;

export function takeSessionLookup(sessionId: string): boolean {
  const n = sessionCalls.get(sessionId) ?? 0;
  if (n >= MAX_LOOKUPS_PER_SESSION) return false;
  sessionCalls.set(sessionId, n + 1);
  return true;
}

/**
 * Lookup ids derive from the session and tool call (unique within a session).
 * Randomness is not used: the agent runtime returned the same randomUUID() in
 * two different sessions during the Development smoke test.
 */
export function lookupIdFor(sessionId: string, toolCallId: string): string {
  return "lk_" + createHash("sha256").update(`${sessionId}:${toolCallId}`).digest("hex").slice(0, 20);
}

export function makeResearchProvider(post: PostFn | null, env = process.env): ResearchProvider {
  if (env.CONTEXT_DEV_ENABLED !== "1") return new UnavailableProvider("context.dev not enabled (set the CONTEXT_DEV_API_KEY secret and CONTEXT_DEV_ENABLED=1)");
  if (!post) return new UnavailableProvider("context.dev connection unavailable");
  return new ContextDevProvider(post);
}

export async function lookupAndPlan(args: { url: string; ownerId: string; sessionId: string; toolCallId: string; confirmedCiks?: string[]; rejectedCiks?: string[]; post: PostFn | null; trigger?: "check" | "watch" }) {
  const config = loadConfig();
  const sec = new SecClient({ userAgent: config.secUserAgent, requestsPerSecond: config.secRequestsPerSecond });
  const report = await runLookup(
    { url: args.url, lookupId: lookupIdFor(args.sessionId, args.toolCallId), confirmedCiks: args.confirmedCiks, rejectedCiks: args.rejectedCiks },
    { config, sec, research: makeResearchProvider(args.post) },
  );
  return { report, plan: buildPersistencePlan(report, args.ownerId, args.sessionId, args.trigger ?? "check") };
}
