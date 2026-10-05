import type { RunContext } from "./run-context";

// All SEC traffic goes through this module:
// - one throttle per runtime process (module scope), shared by every concurrent lookup in it
// - descriptive User-Agent with a configured contact address (never invented)
// - bounded retry with exponential backoff + jitter, honoring Retry-After
// - 403/blocking opens a breaker and stops further SEC calls (no proxy rotation)
// - in-memory cache with recorded age
// Failures are returned as typed outcomes, never as "empty".

export const SEC_HOSTS = new Set(["www.sec.gov", "data.sec.gov", "efts.sec.gov"]);

export type SecOutcome =
  | { ok: true; status: number; body: string; url: string; fetchedAt: string; fromCacheAgeSeconds: number | null }
  | { ok: false; kind: "blocked" | "failed" | "timeout" | "malformed" | "budget_exhausted" | "unavailable" | "not_found"; status: number | null; detail: string; url: string };

export type SecFetchFn = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;

export interface SecClientOptions {
  userAgent: string | null;
  requestsPerSecond: number;
  fetchFn?: SecFetchFn;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  maxRetries?: number;
  timeoutMs?: number;
  cacheTtlSeconds?: number;
}

// Process-wide throttle state. Exported for tests only.
export const throttleState = { nextSlot: 0, blockedUntil: 0 };
const cache = new Map<string, { body: string; status: number; at: number }>();
export function resetSecClientState() {
  throttleState.nextSlot = 0;
  throttleState.blockedUntil = 0;
  cache.clear();
}

export class SecClient {
  private readonly fetchFn: SecFetchFn;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;
  constructor(private readonly opts: SecClientOptions) {
    this.fetchFn = opts.fetchFn ?? ((url, init) => fetch(url, { ...init, redirect: "error" }) as any);
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
  }

  get available() {
    return this.opts.userAgent !== null;
  }

  private async throttle() {
    const interval = Math.ceil(1000 / Math.min(this.opts.requestsPerSecond, 2));
    const now = this.now();
    const slot = Math.max(now, throttleState.nextSlot);
    throttleState.nextSlot = slot + interval;
    if (slot > now) await this.sleep(slot - now);
  }

  async get(url: string, ctx: RunContext, source: string, opts: { allowCacheSeconds?: number; accept?: string } = {}): Promise<SecOutcome> {
    const u = new URL(url);
    if (!SEC_HOSTS.has(u.hostname) || u.protocol !== "https:") return { ok: false, kind: "failed", status: null, detail: "not an SEC host", url };
    if (!this.opts.userAgent) {
      ctx.gap({ source, kind: "unavailable", detail: "SEC_CONTACT_EMAIL is not configured; SEC requests need a descriptive User-Agent with a real contact address" });
      return { ok: false, kind: "unavailable", status: null, detail: "SEC contact address not configured", url };
    }
    const ttl = opts.allowCacheSeconds ?? this.opts.cacheTtlSeconds ?? 600;
    const hit = cache.get(url);
    if (hit && (this.now() - hit.at) / 1000 <= ttl) {
      const age = (this.now() - hit.at) / 1000;
      ctx.noteCache(age);
      return { ok: true, status: hit.status, body: hit.body, url, fetchedAt: new Date(hit.at).toISOString(), fromCacheAgeSeconds: Math.round(age) };
    }
    if (throttleState.blockedUntil > this.now()) {
      ctx.gap({ source, kind: "blocked", detail: "SEC requests paused after a block/rate-limit response" });
      return { ok: false, kind: "blocked", status: null, detail: "SEC breaker open", url };
    }
    const maxRetries = this.opts.maxRetries ?? 2;
    let last: SecOutcome = { ok: false, kind: "failed", status: null, detail: "not attempted", url };
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (!ctx.take("sec", source)) return { ok: false, kind: "budget_exhausted", status: null, detail: "budget", url };
      await this.throttle();
      let res: Awaited<ReturnType<SecFetchFn>>;
      try {
        res = await this.fetchFn(url, {
          headers: { "User-Agent": this.opts.userAgent, Accept: opts.accept ?? "application/json, application/xml, text/plain, */*", "Accept-Encoding": "gzip, deflate" },
          signal: AbortSignal.timeout(Math.min(this.opts.timeoutMs ?? 15_000, Math.max(ctx.timeLeftMs(), 1))),
        });
      } catch (e) {
        const isTimeout = /timeout|abort/i.test(String((e as Error)?.name) + String((e as Error)?.message));
        last = { ok: false, kind: isTimeout ? "timeout" : "failed", status: null, detail: String((e as Error)?.message ?? e).slice(0, 200), url };
        if (attempt < maxRetries) await this.backoff(attempt, null);
        continue;
      }
      if (res.status === 200) {
        const body = await res.text();
        cache.set(url, { body, status: 200, at: this.now() });
        return { ok: true, status: 200, body, url, fetchedAt: new Date(this.now()).toISOString(), fromCacheAgeSeconds: null };
      }
      if (res.status === 404) return { ok: false, kind: "not_found", status: 404, detail: "not found", url };
      if (res.status === 403) {
        // SEC answers excessive or undeclared traffic with 403. Stop, don't rotate anything.
        throttleState.blockedUntil = this.now() + 10 * 60_000;
        ctx.gap({ source, kind: "blocked", detail: "SEC returned 403; further SEC requests paused for 10 minutes" });
        return { ok: false, kind: "blocked", status: 403, detail: "403 from SEC", url };
      }
      const retryAfter = parseRetryAfter(res.headers.get("retry-after"), this.now());
      if (res.status === 429 || res.status >= 500) {
        last = { ok: false, kind: res.status === 429 ? "blocked" : "failed", status: res.status, detail: `HTTP ${res.status}`, url };
        if (retryAfter !== null && retryAfter > 30_000) {
          throttleState.blockedUntil = this.now() + retryAfter;
          ctx.gap({ source, kind: "blocked", detail: `SEC asked to wait ${Math.round(retryAfter / 1000)}s; stopping SEC requests for this run` });
          return last;
        }
        if (res.status === 429) throttleState.nextSlot = Math.max(throttleState.nextSlot, this.now() + (retryAfter ?? 2000)); // slow every caller
        if (attempt < maxRetries) await this.backoff(attempt, retryAfter);
        continue;
      }
      return { ok: false, kind: "failed", status: res.status, detail: `HTTP ${res.status}`, url };
    }
    ctx.gap({ source, kind: last.ok ? "failed" : (last.kind as any), detail: `${last.ok ? "" : last.detail} after ${maxRetries + 1} attempts: ${url}` });
    return last;
  }

  async getJson<T>(url: string, ctx: RunContext, source: string): Promise<{ ok: true; data: T; fetchedAt: string } | Extract<SecOutcome, { ok: false }>> {
    const r = await this.get(url, ctx, source);
    if (!r.ok) return r;
    try {
      return { ok: true, data: JSON.parse(r.body) as T, fetchedAt: r.fetchedAt };
    } catch {
      ctx.gap({ source, kind: "malformed", detail: `Malformed JSON from ${url}` });
      return { ok: false, kind: "malformed", status: r.status, detail: "malformed JSON", url };
    }
  }

  private async backoff(attempt: number, retryAfterMs: number | null) {
    const base = retryAfterMs ?? 1000 * 2 ** attempt;
    const jitter = Math.floor(this.random() * 400);
    await this.sleep(Math.min(base + jitter, 30_000));
  }
}

export function parseRetryAfter(value: string | null, now: number): number | null {
  if (!value) return null;
  const s = Number(value);
  if (Number.isFinite(s) && s >= 0) return s * 1000;
  const d = Date.parse(value);
  return Number.isFinite(d) ? Math.max(d - now, 0) : null;
}
