import type { CoverageGap, SearchedRange } from "./types";
import type { LookupBudget } from "./config";

/** Per-lookup budget, clock and coverage bookkeeping. */
export class RunContext {
  readonly started: number;
  secRequests = 0;
  webRequests = 0;
  researchRequests = 0;
  exhausted = false;
  readonly gaps: CoverageGap[] = [];
  readonly searched: SearchedRange[] = [];
  cacheReused = 0;
  oldestCacheAgeSeconds: number | null = null;

  constructor(readonly budget: LookupBudget, readonly now: () => number = Date.now) {
    this.started = now();
  }

  get elapsedMs() {
    return this.now() - this.started;
  }

  timeLeftMs() {
    return this.budget.deadlineMs - this.elapsedMs;
  }

  /** Reserve one request of a kind; false (and a gap) when the budget is spent. */
  take(kind: "sec" | "web" | "research", source: string): boolean {
    if (this.timeLeftMs() <= 0) return this.spent(source, "time budget exhausted");
    if (kind === "sec") {
      if (this.secRequests >= this.budget.secMaxRequests) return this.spent(source, `SEC request budget (${this.budget.secMaxRequests}) exhausted`);
      this.secRequests++;
    } else if (kind === "web") {
      if (this.webRequests >= this.budget.webMaxRequests) return this.spent(source, `web request budget (${this.budget.webMaxRequests}) exhausted`);
      this.webRequests++;
    } else {
      if (this.researchRequests >= this.budget.researchMaxRequests) return this.spent(source, `research request budget (${this.budget.researchMaxRequests}) exhausted`);
      this.researchRequests++;
    }
    return true;
  }

  private spent(source: string, detail: string): false {
    this.exhausted = true;
    this.gap({ source, kind: "budget_exhausted", detail });
    return false;
  }

  gap(g: CoverageGap) {
    if (!this.gaps.some((x) => x.source === g.source && x.kind === g.kind && x.detail === g.detail)) this.gaps.push(g);
  }

  searchedRange(r: SearchedRange) {
    this.searched.push(r);
  }

  noteCache(ageSeconds: number) {
    this.cacheReused++;
    this.oldestCacheAgeSeconds = Math.max(this.oldestCacheAgeSeconds ?? 0, Math.round(ageSeconds));
  }
}
