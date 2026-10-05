import type { RunContext } from "./run-context";

// Optional enrichment behind one interface. SEC discovery and direct page
// retrieval never depend on it. Provenance is kept in our own database; the
// provider is not a knowledge base.
//
// context.dev contract (docs.context.dev, read 2026-10-05), base https://api.context.dev/v1,
// Authorization: Bearer <key>:
//   POST /brand/retrieve {type:"by_domain", domain}           -> {status, brand:{domain,title,description,address{city,...}}}
//   POST /news/search {searchBy:{type:"entity",entity:{type:"domain",domain}}, sortBy:{type:"newest"}, limit}
//                                                                -> {data:[{url,title,description,published_at,type,source{...}}], has_more}
//   POST /web/search {query, numResults (10-100)}               -> {results:[{url,title,description}], partial}
//   POST /web/scrape {url, formats:{markdown:true}, sharedParams:{mainContentOnly:true}} -> {markdown:{data}}

export interface ProviderArticle {
  url: string;
  title: string | null;
  description: string | null;
  publishedAt: string | null;
  articleType: string | null;
  publisher: string | null;
}

export interface DomainProfile {
  title: string | null;
  description: string | null;
  city: string | null;
  stateOrCountry: string | null;
}

export type ProviderResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface ResearchProvider {
  readonly id: string;
  readonly unavailableReason: string | null;
  readonly capabilities: { domainProfile: boolean; newsSearch: boolean; webSearch: boolean; pageExtraction: boolean };
  domainProfile(domain: string, ctx: RunContext): Promise<ProviderResult<DomainProfile>>;
  newsSearch(domain: string, ctx: RunContext): Promise<ProviderResult<ProviderArticle[]>>;
  webSearch(query: string, ctx: RunContext): Promise<ProviderResult<ProviderArticle[]>>;
}

export class UnavailableProvider implements ResearchProvider {
  readonly id = "none";
  readonly capabilities = { domainProfile: false, newsSearch: false, webSearch: false, pageExtraction: false };
  constructor(readonly unavailableReason: string) {}
  async domainProfile() {
    return { ok: false as const, reason: this.unavailableReason };
  }
  async newsSearch() {
    return { ok: false as const, reason: this.unavailableReason };
  }
  async webSearch() {
    return { ok: false as const, reason: this.unavailableReason };
  }
}

export type PostFn = (path: string, body: unknown, signal: AbortSignal) => Promise<{ status: number; json(): Promise<any> }>;

export class ContextDevProvider implements ResearchProvider {
  readonly id = "context.dev";
  readonly unavailableReason = null;
  readonly capabilities = { domainProfile: true, newsSearch: true, webSearch: true, pageExtraction: true };
  constructor(private readonly post: PostFn) {}

  private async call(path: string, body: unknown, ctx: RunContext, source: string): Promise<ProviderResult<any>> {
    if (!ctx.take("research", source)) return { ok: false, reason: "research budget exhausted" };
    try {
      const res = await this.post(path, body, AbortSignal.timeout(Math.min(20_000, Math.max(ctx.timeLeftMs(), 1))));
      if (res.status === 401 || res.status === 403) {
        ctx.gap({ source, kind: "unavailable", detail: `context.dev rejected the credential (HTTP ${res.status})` });
        return { ok: false, reason: `HTTP ${res.status}` };
      }
      if (res.status === 402) {
        ctx.gap({ source, kind: "unavailable", detail: "context.dev reports insufficient credits; no purchase attempted" });
        return { ok: false, reason: "HTTP 402" };
      }
      if (res.status !== 200) {
        ctx.gap({ source, kind: "failed", detail: `context.dev HTTP ${res.status}` });
        return { ok: false, reason: `HTTP ${res.status}` };
      }
      return { ok: true, value: await res.json() };
    } catch (e) {
      ctx.gap({ source, kind: /timeout|abort/i.test(String(e)) ? "timeout" : "failed", detail: `context.dev request failed: ${String((e as Error)?.message ?? e).slice(0, 160)}` });
      return { ok: false, reason: String(e) };
    }
  }

  async domainProfile(domain: string, ctx: RunContext): Promise<ProviderResult<DomainProfile>> {
    const r = await this.call("/v1/brand/retrieve", { type: "by_domain", domain }, ctx, "context.dev:brand");
    if (!r.ok) return r;
    const b = r.value?.brand ?? {};
    return {
      ok: true,
      value: {
        title: str(b.title),
        description: str(b.description)?.slice(0, 300) ?? null,
        city: str(b.address?.city),
        stateOrCountry: str(b.address?.state_province) ?? str(b.address?.country),
      },
    };
  }

  async newsSearch(domain: string, ctx: RunContext): Promise<ProviderResult<ProviderArticle[]>> {
    const r = await this.call(
      "/v1/news/search",
      { searchBy: { type: "entity", entity: { type: "domain", domain } }, sortBy: { type: "newest" }, limit: 25 },
      ctx,
      "context.dev:news",
    );
    if (!r.ok) return r;
    if (!Array.isArray(r.value?.data)) {
      ctx.gap({ source: "context.dev:news", kind: "malformed", detail: "unexpected response shape" });
      return { ok: false, reason: "malformed" };
    }
    return {
      ok: true,
      value: r.value.data.map((a: any) => ({
        url: String(a.url),
        title: str(a.title),
        description: str(a.description),
        publishedAt: str(a.published_at)?.slice(0, 10) ?? null,
        articleType: str(a.type),
        publisher: str(a.source?.domain) ?? str(a.source?.name),
      })),
    };
  }

  async webSearch(query: string, ctx: RunContext): Promise<ProviderResult<ProviderArticle[]>> {
    const r = await this.call("/v1/web/search", { query, numResults: 10 }, ctx, "context.dev:search");
    if (!r.ok) return r;
    if (!Array.isArray(r.value?.results)) {
      ctx.gap({ source: "context.dev:search", kind: "malformed", detail: "unexpected response shape" });
      return { ok: false, reason: "malformed" };
    }
    return {
      ok: true,
      value: r.value.results.map((a: any) => ({ url: String(a.url), title: str(a.title), description: str(a.description), publishedAt: null, articleType: null, publisher: null })),
    };
  }
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
