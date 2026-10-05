import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { OpenComputer } from "@opencomputer/sdk/agents";
import { DEV_TOKEN, signOwner } from "../opencomputer/agents/funding/lib/owner";
import { sha256 } from "../opencomputer/agents/funding/lib/formd";
import { companyId, verificationQuery } from "../opencomputer/agents/funding/lib/persist";
import { canonicalDomain, normalizeInputUrl } from "../opencomputer/agents/funding/lib/url-safety";

// Trusted server-side client shared by the CLI wrapper and the web app.
// Holds the OpenComputer API key; never ship this to a browser.

export interface ClientConfig {
  apiKey: string;
  apiUrl: string;
  projectId: string;
  environment: "development" | "production";
  agent: string;
  ownerSigningKey: string | null;
}

export function loadClientConfig(root = process.cwd()): ClientConfig {
  const binding = existsSync(join(root, ".opencomputer/project.json")) ? JSON.parse(readFileSync(join(root, ".opencomputer/project.json"), "utf8")) : {};
  let apiKey = process.env.OPENCOMPUTER_API_KEY ?? "";
  if (!apiKey && existsSync(join(homedir(), ".opencomputer/config.json"))) apiKey = JSON.parse(readFileSync(join(homedir(), ".opencomputer/config.json"), "utf8")).apiKey ?? ""; // local-dev convenience: the CLI login
  const environment = (process.env.FUNDING_ENVIRONMENT ?? "development") as ClientConfig["environment"];
  if (environment !== "development" && environment !== "production") throw new Error("FUNDING_ENVIRONMENT must be development or production");
  const projectId = process.env.OC_PROJECT_ID ?? binding.projectId;
  if (!apiKey) throw new Error("No OpenComputer API key: set OPENCOMPUTER_API_KEY or run `npx opencomputer login`");
  if (!projectId) throw new Error("No project: run `npx opencomputer link` or set OC_PROJECT_ID");
  return { apiKey, apiUrl: (process.env.OPENCOMPUTER_API_URL ?? binding.apiUrl ?? "https://app.opencomputer.dev").replace(/\/$/, ""), projectId, environment, agent: process.env.FUNDING_AGENT ?? binding.agentId ?? "funding", ownerSigningKey: process.env.OWNER_SIGNING_KEY ?? null };
}

export type Op = { op: "check"; url: string } | { op: "resolve"; url: string; cik: string; decision: "confirm" | "reject" } | { op: "watch"; url: string } | { op: "list-watches" } | { op: "disable-watch"; watch_id: string } | { op: "inspect"; lookup_id: string };

export class FundingClient {
  readonly oc: OpenComputer;
  constructor(readonly cfg: ClientConfig) {
    this.oc = new OpenComputer({ apiKey: cfg.apiKey, baseUrl: `${cfg.apiUrl}/api/managed-agents` });
  }

  /** Start a session for an authenticated owner. The owner never comes from request text. */
  async start(ownerId: string, op: Op, labels: Record<string, string> = { owner: ownerId.slice(0, 60) }) {
    const key = `funding/${ownerId}/${randomUUID()}`;
    const { session } = await this.oc.sessions.create(
      { agentId: `${this.cfg.agent}@${this.cfg.environment}`, labels: { ...labels, op: op.op } },
      { idempotencyKey: key },
    );
    const ownerToken = this.cfg.ownerSigningKey ? signOwner(ownerId, session.id, this.cfg.ownerSigningKey) : DEV_TOKEN;
    const text = op.op === "check" ? `check ${op.url}` : op.op;
    const context = op.op === "check" || op.op === "resolve" ? await this.priorContext(ownerId, op.url) : {};
    await this.oc.sessions.turns.send(session.id, { input: text, idempotencyKey: `${key}/start`, payload: { ...op, ...context, owner_token: ownerToken } });
    return session.id;
  }

  /** Owner-scoped prior decisions and last check time, read here (trusted, read-only) and passed in the payload. */
  async priorContext(ownerId: string, url: string) {
    const cid = companyId(canonicalDomain(normalizeInputUrl(url)));
    const decisions = await this.query("SELECT cik, status FROM entity_candidates WHERE owner_id = ? AND company_id = ? AND status IN ('user_confirmed','user_rejected')", [ownerId, cid]);
    const [prev] = await this.query("SELECT checked_at FROM lookup_runs WHERE owner_id = ? AND company_id = ? ORDER BY checked_at DESC LIMIT 1", [ownerId, cid]);
    return {
      confirmed_ciks: decisions.filter((d: any) => d.status === "user_confirmed").map((d: any) => String(d.cik)),
      rejected_ciks: decisions.filter((d: any) => d.status === "user_rejected").map((d: any) => String(d.cik)),
      ...(prev ? { previous_checked_at: String(prev.checked_at) } : {}),
    };
  }

  /** Read the session; ownership is checked against the label this server wrote. */
  async read(sessionId: string, match: string | Record<string, string>) {
    const s: any = await this.oc.sessions.get(sessionId);
    const want = typeof match === "string" ? { owner: match.slice(0, 60) } : match;
    if (!Object.entries(want).every(([k, v]) => s.labels?.[k] === v)) throw Object.assign(new Error("not found"), { status: 404 });
    const events: any[] = [];
    let after = 0;
    for (;;) {
      const page: any[] = await this.oc.sessions.events.list(sessionId, { after });
      events.push(...page);
      if (page.length < 500) break;
      after = page.at(-1).seq;
    }
    const lastTurn = s.turns?.at(-1);
    const settled = lastTurn && ["completed", "failed", "cancelled"].includes(lastTurn.status);
    const outputs = (tool: string) => events.filter((e) => e.type === "tool.completed" && e.data?.tool === tool).map((e) => e.data.output);
    const failures = events.filter((e) => e.type === "turn.failed" || e.type === "tool.failed" || e.type === "session.failed").map((e) => ({ type: e.type, ...e.data }));
    const parse = (v: any) => {
      try {
        return typeof v === "string" ? JSON.parse(v) : v;
      } catch {
        return null;
      }
    };
    // The deterministic report comes straight from the funding_lookup tool output, not the model's restatement.
    const details = outputs("funding_lookup").map(parse).at(-1) ?? null;
    const finalMessage = events.filter((e) => e.type === "message.completed").at(-1)?.data?.text ?? null;
    return {
      sessionId,
      status: s.status,
      turnStatus: lastTurn?.status ?? null,
      settled: !!settled,
      result: s.result?.data ?? null,
      readableReport: details?.readable_report ?? null,
      finalMessage,
      failures,
      codeRuns: outputs("execute").map(parse),
    };
  }

  async wait(sessionId: string, ownerId: string | Record<string, string>, timeoutMs = 300_000, onTick?: (s: string) => void) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const r = await this.read(sessionId, ownerId);
      if (r.settled) return r;
      onTick?.(r.status);
      if (Date.now() > end) return r;
      await new Promise((res) => setTimeout(res, 3000));
    }
  }

  /**
   * If a settled lookup's writes cannot be verified, send one recovery turn (at most
   * two per session) asking the agent to re-run its persist_code. Idempotent per turn count.
   */
  async ensurePersisted(sessionId: string, ownerId: string, result: any) {
    const p = await this.verifyPersistence(ownerId, result).catch((e) => ({ status: "verification_failed" as const, detail: String(e.message) }));
    if (p.status === "verified" || p.status === "not_applicable") return { persistence: p, retrying: false };
    const s: any = await this.oc.sessions.get(sessionId);
    const turns = s.turns?.length ?? 0;
    if (turns >= 3) return { persistence: p, retrying: false };
    await this.oc.sessions.turns.send(sessionId, { input: "persist-retry", idempotencyKey: `${sessionId}/persist-retry/${turns}`, payload: { op: "persist-retry" } });
    return { persistence: p, retrying: true };
  }

  /** Read-only, owner-scoped SQL through the management API. */
  async query(sql: string, parameters: (string | number | null)[]) {
    const res = await fetch(`${this.cfg.apiUrl}/api/managed-agents/projects/${encodeURIComponent(this.cfg.projectId)}/database/query`, {
      method: "POST",
      headers: { "x-api-key": this.cfg.apiKey, "content-type": "application/json", "user-agent": "company-funding-app/1.0" },
      body: JSON.stringify({ environment: this.cfg.environment, sql, parameters }),
      redirect: "error",
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`database query failed: HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
    const r = body.result ?? body;
    const cols: string[] = r.columns ?? [];
    return (r.rows ?? []).map((row: any) => (Array.isArray(row) ? Object.fromEntries(cols.map((c, i) => [c, row[i]])) : row));
  }

  /** Independent check that the model wrote what the tools planned. */
  async verifyPersistence(ownerId: string, result: any) {
    if (!result?.lookup_id) return { status: "not_applicable" as const };
    const q = verificationQuery(ownerId, result.lookup_id);
    const rows = await this.query(q.sql, q.parameters);
    if (!rows.length) return { status: "missing" as const, detail: "no lookup_runs row for this owner and lookup" };
    const row = rows[0];
    // Recompute the hash of what was actually stored; compare with the signed result's hash.
    const storedHash = typeof row.report_json === "string" ? sha256(row.report_json) : null;
    const ok = storedHash === result.report_sha256 && row.report_sha256 === result.report_sha256;
    const { report_json: _omit, ...summary } = row;
    return { status: ok ? ("verified" as const) : ("hash_mismatch" as const), row: { ...summary, stored_hash: storedHash } };
  }
}

export const newSigningKey = () => randomBytes(32).toString("base64url");
