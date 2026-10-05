import { createHash } from "node:crypto";
import { excerpt, htmlToText, pageTitle, publishedDate } from "./extract";
import { amountValue, parseAnnouncedAmount, withinPercent } from "./money";
import { eventDateOf } from "./offerings";
import type { Announcement, Offering } from "./types";

const FUNDING = /\b(rais(?:e|ed|es|ing)|closed? (?:a|its|our)|secur(?:ed|es)|announc(?:ed|es|ing)|(?:seed|series [a-h]|growth|bridge|venture|debt|equity) (?:round|financing|funding)|funding round|financing round|investment from|led by)\b/i;
const STAGE = /\b(pre-seed|seed|series [a-h](?:[- ]?\d| extension| prime)?|bridge|growth equity|venture debt)\b/i;
const AGGREGATORS = /(^|\.)(crunchbase\.com|pitchbook\.com|cbinsights\.com|tracxn\.com|dealroom\.co|growjo\.com|owler\.com)$/i;

export function announcementId(url: string): string {
  return "ann:" + createHash("sha256").update(url).digest("hex").slice(0, 16);
}

export function classifySource(url: string, companyDomain: string | null, articleType?: string | null): Announcement["sourceKind"] {
  const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  if (AGGREGATORS.test(host)) return "aggregator";
  if (companyDomain && (host === companyDomain || host.endsWith("." + companyDomain))) return "company_announcement";
  if (articleType === "press_release") return "company_announcement";
  return "reporting";
}

/** Extract a funding announcement from an article's HTML, or null when it has no funding statement. */
export function extractAnnouncement(html: string, url: string, retrievedAt: string, companyDomain: string | null): Announcement | null {
  const text = htmlToText(html);
  const title = pageTitle(html);
  return extractFromText({ text, title, url, publishedAt: publishedDate(html), retrievedAt, companyDomain, articleType: null, publisher: null });
}

export function extractFromText(a: { text: string; title: string | null; url: string; publishedAt: string | null; retrievedAt: string; companyDomain: string | null; articleType: string | null; publisher: string | null }): Announcement | null {
  const hay = `${a.title ?? ""}\n${a.text}`;
  const m = FUNDING.exec(hay);
  if (!m) return null;
  // Look for an amount and stage near the funding statement only.
  const windowText = hay.slice(Math.max(0, m.index - 200), m.index + 400);
  const amount = parseAnnouncedAmount(windowText);
  const stage = STAGE.exec(windowText)?.[1] ?? null;
  if (!amount && !stage) return null;
  return {
    id: announcementId(a.url),
    url: a.url,
    title: a.title,
    publishedAt: a.publishedAt,
    sourceKind: classifySource(a.url, a.companyDomain, a.articleType),
    publisher: a.publisher,
    amountUsd: amount?.usd ?? null,
    amountText: amount?.text ?? null,
    stageText: stage ? stage.replace(/\b\w/g, (c) => c.toUpperCase()) : null,
    excerpt: excerpt(hay, m.index),
    retrievedAt: a.retrievedAt,
  };
}

function days(a: string, b: string) {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000);
}

export interface MatchResult {
  matches: { announcementId: string; offeringId: string; strength: "matched" | "possible" }[];
  conflicts: string[];
}

/**
 * Match announcements to offerings using amount (within 15% of filed sold or
 * offering amount) and date plausibility (published between 45 days before the
 * first sale and 180 days after the latest filing). Publication date is not
 * the closing date; we never substitute it.
 */
export function matchAnnouncements(anns: Announcement[], offerings: Offering[]): MatchResult {
  const matches: MatchResult["matches"] = [];
  const conflicts: string[] = [];
  for (const a of anns) {
    let best: { o: Offering; strength: "matched" | "possible" } | null = null;
    for (const o of offerings) {
      if (o.isNoticeOnly && !a.amountUsd) continue;
      const start = eventDateOf(o);
      const end = o.latestFilingDate ?? start;
      const dateOk = a.publishedAt && start ? days(start, a.publishedAt) >= -45 && days(end, a.publishedAt) <= 180 : false;
      const amt = a.amountUsd ? BigInt(a.amountUsd) : null;
      const filed = [amountValue(o.soldAmount), amountValue(o.offeringAmount)].filter((x): x is bigint => x !== null && x > 0n);
      const amountOk = amt !== null && filed.some((f) => withinPercent(amt, f, 15));
      if (amountOk && dateOk) {
        best = { o, strength: "matched" };
        break;
      }
      if (amountOk && !dateOk && a.publishedAt) conflicts.push(`Announcement ${a.url} states ${a.amountText} matching offering ${o.rootAccession}, but its publication date ${a.publishedAt} is far from the filed dates; not linked`);
      if (dateOk && amt === null && !best) best = { o, strength: "possible" };
      if (dateOk && amt !== null && !amountOk && !best) {
        conflicts.push(`Announcement ${a.url} (${a.amountText}, published ${a.publishedAt}) is close in time to offering ${o.rootAccession} but the amount differs from filed amounts; unresolved`);
      }
    }
    if (best) matches.push({ announcementId: a.id, offeringId: best.o.id, strength: best.strength });
  }
  return { matches, conflicts };
}
