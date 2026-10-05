#!/usr/bin/env -S npx tsx
// Local CLI wrapper.
//   npm run check -- <company-url>            run on the deployed agent (Development) and verify persistence
//   npm run check -- <company-url> --local    run the deterministic lookup in this process (no persistence)
//   npm run check -- <company-url> --json     print typed JSON only
// Options: --confirm-cik <cik> --reject-cik <cik> (remote: records the decision first), --owner <id> (with OWNER_SIGNING_KEY)
import { randomUUID } from "node:crypto";
import { loadConfig } from "../opencomputer/agents/funding/lib/config";
import { runLookup } from "../opencomputer/agents/funding/lib/lookup";
import { compactReport, renderReport } from "../opencomputer/agents/funding/lib/report";
import { ContextDevProvider, UnavailableProvider } from "../opencomputer/agents/funding/lib/research-provider";
import { SecClient } from "../opencomputer/agents/funding/lib/sec-http";
import { DEV_OWNER } from "../opencomputer/agents/funding/lib/owner";
import { FundingClient, loadClientConfig } from "./oc-client";

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const url = args.find((a, i) => !a.startsWith("--") && !["--confirm-cik", "--reject-cik", "--owner"].includes(args[i - 1] ?? ""));
if (!url) {
  console.error("usage: npm run check -- <company-url> [--local] [--json] [--confirm-cik <cik>] [--reject-cik <cik>]");
  process.exit(2);
}

if (flag("--local")) {
  const config = loadConfig();
  const sec = new SecClient({ userAgent: config.secUserAgent, requestsPerSecond: config.secRequestsPerSecond });
  const key = process.env.CONTEXT_DEV_API_KEY;
  const research =
    config.researchEnabled && key
      ? new ContextDevProvider(async (path, body, signal) => {
          const r = await fetch(`https://api.context.dev${path}`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body), signal, redirect: "error" });
          return { status: r.status, json: () => r.json() };
        })
      : new UnavailableProvider("context.dev not enabled (CONTEXT_DEV_ENABLED=1 and CONTEXT_DEV_API_KEY)");
  const report = await runLookup({ url, lookupId: "lk_local_" + randomUUID().slice(0, 8), confirmedCiks: opt("--confirm-cik") ? [opt("--confirm-cik")!] : [], rejectedCiks: opt("--reject-cik") ? [opt("--reject-cik")!] : [] }, { config, sec, research });
  if (flag("--json")) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(renderReport(report));
    console.log("\nPersistence: none (local dry run; the database is only written by deployed sessions)\n");
    console.log(JSON.stringify(compactReport(report, { planned: false, tables: [] }), null, 2));
  }
  process.exit(0);
}

const cfg = loadClientConfig();
const owner = opt("--owner") ?? DEV_OWNER;
if (owner !== DEV_OWNER && !cfg.ownerSigningKey) throw new Error("--owner needs OWNER_SIGNING_KEY (shared with the agent's runtime variable)");
const client = new FundingClient(cfg);
const cik = opt("--confirm-cik") ?? opt("--reject-cik");
const op = cik ? { op: "resolve" as const, url, cik, decision: (opt("--confirm-cik") ? "confirm" : "reject") as "confirm" | "reject" } : { op: "check" as const, url };
const sessionId = await client.start(owner, op);
if (!flag("--json")) console.error(`session ${sessionId} (${cfg.agent}@${cfg.environment}) started; waiting...`);
const tick = (s: string) => !flag("--json") && process.stderr.write(`  ${s}\n`);
let r = await client.wait(sessionId, owner, 420_000, tick);
let persistence: any = { status: "no_result" };
for (let attempt = 0; r.result && attempt < 3; attempt++) {
  const e = await client.ensurePersisted(sessionId, owner, r.result);
  persistence = e.persistence;
  if (!e.retrying) break;
  tick("persistence not verified; sent recovery turn");
  await new Promise((res) => setTimeout(res, 5000));
  r = { ...(await client.wait(sessionId, owner, 300_000, tick)), result: r.result, readableReport: r.readableReport };
}
if (flag("--json")) {
  console.log(JSON.stringify({ sessionId, turnStatus: r.turnStatus, result: r.result, persistence, failures: r.failures }, null, 2));
} else {
  console.log(r.readableReport ?? "(no readable report: funding_lookup did not complete)");
  console.log("\n--- agent reply ---\n" + (r.finalMessage ?? "(none)"));
  console.log("\n--- typed result ---\n" + JSON.stringify(r.result, null, 2));
  console.log(`\nturn: ${r.turnStatus}; execute runs: ${JSON.stringify(r.codeRuns).slice(0, 400)}\npersistence (verified by this client): ${JSON.stringify(persistence)}`);
  if (r.failures.length) console.log("failures: " + JSON.stringify(r.failures));
}
