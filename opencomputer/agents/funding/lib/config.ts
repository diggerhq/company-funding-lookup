// Runtime configuration. Values come from OpenComputer agent runtime variables
// (process.env). Nothing here is a secret: managed secrets (CONTEXT_DEV_API_KEY)
// are attached by the platform to declared connections and never read here.

export interface LookupBudget {
  secMaxRequests: number;
  webMaxRequests: number;
  researchMaxRequests: number;
  deadlineMs: number;
  maxCandidates: number;
  maxFilings: number;
}

export interface LookupConfig {
  secUserAgent: string | null; // null => SEC capability unavailable
  secRequestsPerSecond: number;
  researchEnabled: boolean;
  budget: LookupBudget;
  recentWindowMonths: number;
}

const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

export function loadConfig(env: Record<string, string | undefined> = process.env): LookupConfig {
  const contact = env.SEC_CONTACT_EMAIL?.trim();
  const app = (env.SEC_APP_NAME?.trim() || "company-funding-lookup").replace(/[^\w .-]/g, "");
  const rps = Number(env.SEC_REQUESTS_PER_SECOND ?? "1");
  return {
    // SEC asks for a descriptive User-Agent with a contact address. We never invent one.
    secUserAgent: contact && EMAIL.test(contact) ? `${app} (public-filings research) ${contact}` : null,
    // Per-runtime ceiling. Never above 2; the app layer caps concurrent lookups so the aggregate stays <= 2 rps.
    secRequestsPerSecond: Number.isFinite(rps) && rps > 0 ? Math.min(rps, 2) : 1,
    researchEnabled: env.CONTEXT_DEV_ENABLED === "1",
    budget: {
      secMaxRequests: int(env.LOOKUP_SEC_MAX_REQUESTS, 45),
      webMaxRequests: int(env.LOOKUP_WEB_MAX_REQUESTS, 12),
      researchMaxRequests: int(env.LOOKUP_RESEARCH_MAX_REQUESTS, 4),
      deadlineMs: int(env.LOOKUP_DEADLINE_MS, 110_000),
      maxCandidates: int(env.LOOKUP_MAX_CANDIDATES, 5),
      maxFilings: int(env.LOOKUP_MAX_FILINGS, 12),
    },
    recentWindowMonths: 24,
  };
}

function int(v: string | undefined, d: number): number {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : d;
}
