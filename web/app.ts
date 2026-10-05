// Request handler shared by the local server (web/server.ts) and the Vercel
// function (api/index.js, bundled from web/vercel-entry.ts).
//
// Modes (APP_MODE):
//   public-try  No login. Each visitor gets PUBLIC_TRIES lookups (default 1), keyed by
//               a signed visitor cookie AND a salted IP hash; a daily global cap and a
//               concurrency cap bound spend. After that, the page points to the
//               "deploy your own" OpenComputer template.
//   users       APP_USERS="alice:passphrase,..." + signed HttpOnly cookie.
//   dev         APP_DEV_USER=local-dev, single user, local only.
// The OpenComputer API key and owner tokens never reach the browser.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { DEV_OWNER } from "../opencomputer/agents/funding/lib/owner";
import { companyId } from "../opencomputer/agents/funding/lib/persist";
import { canonicalDomain, normalizeInputUrl, UnsafeUrlError } from "../opencomputer/agents/funding/lib/url-safety";
import { FundingClient, loadClientConfig, type Op } from "../scripts/oc-client";

const env = process.env;
const MODE = (env.APP_MODE ?? (env.APP_DEV_USER ? "dev" : "users")) as "public-try" | "users" | "dev";
const SECRET = env.APP_SESSION_SECRET ?? "";
const USERS = new Map((env.APP_USERS ?? "").split(",").filter(Boolean).map((p) => p.split(":") as [string, string]));
const MAX_ACTIVE = Number(env.MAX_ACTIVE_LOOKUPS ?? 2); // aggregate SEC traffic <= 2 req/s (1 req/s per runtime)
const PUBLIC_TRIES = Number(env.PUBLIC_TRIES ?? 1);
const PUBLIC_DAILY_CAP = Number(env.PUBLIC_DAILY_CAP ?? 40);
const TEMPLATE_URL = env.TEMPLATE_URL ?? "";
const SECURE_COOKIE = env.VERCEL === "1" || env.COOKIE_SECURE === "1";

let client: FundingClient | null = null;
export function config() {
  if (!client) {
    if (MODE === "dev" && env.APP_DEV_USER !== DEV_OWNER) throw new Error(`APP_DEV_USER must be "${DEV_OWNER}"`);
    if (MODE !== "dev" && SECRET.length < 32) throw new Error("APP_SESSION_SECRET (32+ chars) is required");
    if (MODE === "users" && USERS.size === 0) throw new Error("APP_USERS is required in users mode");
    client = new FundingClient(loadClientConfig());
    if (MODE !== "dev" && !client.cfg.ownerSigningKey) throw new Error("OWNER_SIGNING_KEY is required (same value as the agent runtime variable)");
  }
  return { client, mode: MODE };
}

const sign = (v: string) => createHmac("sha256", SECRET).update(v).digest("base64url");
const safeEq = (a: string, b: string) => Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const cookie = (req: IncomingMessage, name: string) =>
  (req.headers.cookie ?? "")
    .split(/;\s*/)
    .map((c) => [c.slice(0, c.indexOf("=")), c.slice(c.indexOf("=") + 1)])
    .find(([k]) => k === name)?.[1];

function setCookie(res: ServerResponse, name: string, value: string, maxAge: number) {
  const prev = res.getHeader("set-cookie");
  const next = `${name}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${SECURE_COOKIE ? "; Secure" : ""}`;
  res.setHeader("set-cookie", prev ? ([] as string[]).concat(prev as any, next) : next);
}

function clientIp(req: IncomingMessage): string {
  // Vercel sets x-forwarded-for / x-real-ip; locally fall back to the socket address.
  const fwd = String(req.headers["x-real-ip"] ?? req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
  return fwd || req.socket.remoteAddress || "unknown";
}

interface Identity {
  owner: string;
  visitor?: string;
  ipHash?: string;
}

function identify(req: IncomingMessage, res: ServerResponse): Identity | null {
  if (MODE === "dev") return { owner: env.APP_DEV_USER! };
  if (MODE === "users") {
    const c = cookie(req, "fl_session");
    if (!c) return null;
    const [user, exp, sig] = decodeURIComponent(c).split("|");
    if (!user || !exp || !sig || Number(exp) < Date.now() || !USERS.has(user) || !safeEq(sig, sign(`${user}|${exp}`))) return null;
    return { owner: user };
  }
  // public-try: anonymous visitor id in a signed cookie, plus a salted IP hash.
  let visitor: string | null = null;
  const c = cookie(req, "fl_visitor");
  if (c) {
    const [id, sig] = decodeURIComponent(c).split(".");
    if (id && sig && /^[a-f0-9]{16}$/.test(id) && safeEq(sig, sign(`visitor:${id}`))) visitor = id;
  }
  if (!visitor) {
    visitor = randomBytes(8).toString("hex");
    setCookie(res, "fl_visitor", `${visitor}.${sign(`visitor:${visitor}`)}`, 365 * 86400);
  }
  const ipHash = createHash("sha256").update(`${SECRET}|ip|${clientIp(req)}`).digest("hex").slice(0, 16);
  return { owner: `visitor_${visitor}`, visitor, ipHash };
}

/** Sessions this server already started for the visitor (or their IP), from labels it wrote. */
async function publicUsage(id: Identity) {
  const { client } = config();
  const byVisitor = await client.oc.sessions.list({ labels: { app: "public-try", visitor: id.visitor! }, limit: 10 } as any);
  const byIp = await client.oc.sessions.list({ labels: { app: "public-try", ip: id.ipHash! }, limit: 10 } as any);
  // A try counts when it produced a result or is still running; failed runs don't use up the
  // visitor's try, but at most 3 sessions per visitor/IP are ever started.
  const counts = (rows: any[]) => rows.filter((s) => s.result || s.activity?.activeTurnId || s.activity?.queued > 0 || !s.activity?.lastSettledTurn).length;
  const used = Math.max(counts(byVisitor.sessions), counts(byIp.sessions), byVisitor.sessions.length >= 3 || byIp.sessions.length >= 3 ? PUBLIC_TRIES : 0);
  return { used, remaining: Math.max(0, PUBLIC_TRIES - used), lastSessionId: byVisitor.sessions[0]?.id ?? null };
}

/** Sessions with these labels created after `since`; rows come newest first, so stop at the cutoff. */
async function recentSessions(labels: Record<string, string>, since: number, max: number) {
  const { client } = config();
  const out: any[] = [];
  // Note: the list API rejects createdAfter combined with label filters, so filter by createdAt here.
  for await (const s of client.oc.sessions.iterate({ labels, limit: 100 } as any)) {
    if (Date.parse((s as any).createdAt) < since || out.length >= max) break;
    out.push(s);
  }
  return out;
}

async function admit(publicMode: boolean) {
  const recent = await recentSessions({ app: publicMode ? "public-try" : "funding-app" }, Date.now() - 10 * 60_000, 100);
  const active = recent.filter((s: any) => s.activity?.activeTurnId || s.activity?.queued > 0 || s.activity?.lastSettledTurn == null).length;
  if (active >= MAX_ACTIVE) throw Object.assign(new Error(`${active} lookups are running right now; try again in a minute`), { status: 429 });
  if (publicMode) {
    const today = await recentSessions({ app: "public-try" }, Date.parse(new Date().toISOString().slice(0, 10) + "T00:00:00Z"), PUBLIC_DAILY_CAP);
    if (today.length >= PUBLIC_DAILY_CAP) throw Object.assign(new Error("Today's free lookups are used up. Deploy your own copy to keep going."), { status: 429, template: true });
  }
}

async function body(req: IncomingMessage): Promise<any> {
  if ((req as any).body !== undefined) return typeof (req as any).body === "string" ? JSON.parse((req as any).body || "{}") : (req as any).body; // Vercel pre-parses
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) throw Object.assign(new Error("body too large"), { status: 413 });
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw Object.assign(new Error("invalid JSON"), { status: 400 });
  }
}

function send(res: ServerResponse, status: number, data: unknown) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.end(JSON.stringify(data));
}

function validUrl(u: unknown): string {
  try {
    return normalizeInputUrl(String(u ?? "")).toString();
  } catch (e) {
    throw Object.assign(new Error(e instanceof UnsafeUrlError ? e.message : "invalid URL"), { status: 400 });
  }
}

export async function handle(req: IncomingMessage, res: ServerResponse) {
  try {
    const { client, mode } = config();
    const url = new URL(req.url ?? "/", "http://local");
    const path = url.pathname;
    if (req.method === "POST" && req.headers["content-type"]?.includes("application/json") !== true) return send(res, 415, { error: "JSON required" });

    if (req.method === "POST" && path === "/api/login") {
      if (mode !== "users") return send(res, 400, { error: "login not used in this mode" });
      const { user, passphrase } = await body(req);
      const expected = USERS.get(String(user));
      if (!expected || !safeEq(expected, String(passphrase ?? ""))) return send(res, 401, { error: "invalid credentials" });
      const exp = Date.now() + 12 * 3600_000;
      setCookie(res, "fl_session", `${user}|${exp}|${sign(`${user}|${exp}`)}`, 43200);
      return send(res, 200, { user });
    }

    const id = identify(req, res);
    if (path === "/api/me") {
      const usage = id && mode === "public-try" ? await publicUsage(id) : null;
      return send(res, 200, { mode, user: id && mode !== "public-try" ? id.owner : null, environment: client.cfg.environment, templateUrl: TEMPLATE_URL || null, tries: usage ? { limit: PUBLIC_TRIES, used: usage.used, remaining: usage.remaining, lastSessionId: usage.lastSessionId } : null });
    }
    if (!id) return send(res, 401, { error: "sign in first" });
    const publicMode = mode === "public-try";
    const labels: Record<string, string> = publicMode ? { app: "public-try", visitor: id.visitor!, ip: id.ipHash! } : { app: "funding-app", owner: id.owner.slice(0, 60) };

    const startOp = async (op: Op) => {
      if (publicMode) {
        const usage = await publicUsage(id);
        if (usage.remaining <= 0) return send(res, 402, { error: "You've used your free lookup. Deploy your own copy to run more.", template: TEMPLATE_URL || null });
      }
      await admit(publicMode);
      const sessionId = await client.start(id.owner, op, labels);
      return send(res, 202, { sessionId });
    };

    if (req.method === "POST" && path === "/api/check") return await startOp({ op: "check", url: validUrl((await body(req)).url) });
    if (publicMode && (path.startsWith("/api/resolve") || path.startsWith("/api/watches"))) {
      return send(res, 403, { error: "Confirming candidates and daily watches are available in your own deployment.", template: TEMPLATE_URL || null });
    }
    if (req.method === "POST" && path === "/api/resolve") {
      const b = await body(req);
      if (!/^\d{1,10}$/.test(String(b.cik)) || !["confirm", "reject"].includes(b.decision)) return send(res, 400, { error: "cik and decision required" });
      return await startOp({ op: "resolve", url: validUrl(b.url), cik: String(b.cik), decision: b.decision });
    }
    if (req.method === "GET" && path.startsWith("/api/sessions/")) {
      const sid = path.split("/")[3];
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(sid)) return send(res, 400, { error: "bad id" });
      const r = await client.read(sid, publicMode ? { visitor: id.visitor! } : { owner: id.owner.slice(0, 60) });
      // The first turn's result is the lookup; later turns are persistence recovery.
      const first = r.result;
      if (r.settled && first) {
        const e = await client.ensurePersisted(sid, id.owner, first);
        return send(res, 200, { ...r, settled: !e.retrying, status: e.retrying ? "saving" : r.status, persistence: e.persistence });
      }
      return send(res, 200, { ...r, persistence: null });
    }
    if (req.method === "GET" && path.startsWith("/api/lookups/")) {
      const lid = path.split("/")[3];
      if (!/^lk_[a-f0-9]{1,40}$/.test(lid)) return send(res, 400, { error: "bad id" });
      const [run] = await client.query("SELECT id, status, checked_at, submitted_url, canonical_url, company_id, report_sha256 FROM lookup_runs WHERE owner_id = ? AND id = ?", [id.owner, lid]);
      if (!run) return send(res, 404, { error: "not found" });
      const evidence = await client.query("SELECT kind, url, excerpt, source_date, retrieved_at, claims_json FROM evidence WHERE owner_id = ? AND lookup_id = ? ORDER BY kind LIMIT 100", [id.owner, lid]);
      const filings = await client.query("SELECT accession, form, filing_date, attribution, issuer_name, sold_amount_raw, offering_amount_raw, first_sale_status, first_sale_date, source_url FROM filings WHERE owner_id = ? AND company_id = ? ORDER BY filing_date DESC LIMIT 50", [id.owner, run.company_id]);
      return send(res, 200, { run, evidence, filings });
    }
    if (req.method === "GET" && path === "/api/watches") {
      return send(res, 200, { watches: await client.query("SELECT id, company_url, enabled, cadence, notifications_enabled, last_run_at FROM watches WHERE owner_id = ? ORDER BY created_at DESC LIMIT 100", [id.owner]) });
    }
    if (req.method === "POST" && path === "/api/watches") {
      const b = await body(req);
      if (b.optIn !== true) return send(res, 400, { error: "explicit opt-in required" });
      return await startOp({ op: "watch", url: validUrl(b.url) });
    }
    if (req.method === "POST" && /^\/api\/watches\/w:[a-f0-9]{16}\/disable$/.test(path)) return await startOp({ op: "disable-watch", watch_id: path.split("/")[3] });
    if (req.method === "GET" && path === "/api/company") {
      const cid = companyId(canonicalDomain(normalizeInputUrl(validUrl(url.searchParams.get("url")))));
      return send(res, 200, { candidates: await client.query("SELECT cik, name, status, confidence, reasons_json FROM entity_candidates WHERE owner_id = ? AND company_id = ? LIMIT 20", [id.owner, cid]) });
    }
    send(res, 404, { error: "not found" });
  } catch (e: any) {
    const status = e?.status && Number.isInteger(e.status) ? e.status : 500;
    if (status === 500) console.error(e);
    send(res, status, { error: status === 500 ? "internal error" : String(e.message), ...(e?.template ? { template: TEMPLATE_URL || null } : {}) });
  }
}
