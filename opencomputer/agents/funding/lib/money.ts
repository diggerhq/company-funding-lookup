import type { FiledAmount } from "./types";

// Financial values are handled as decimal strings and BigInt. Never floats.

export function parseFiledAmount(raw: unknown): FiledAmount {
  if (raw === undefined || raw === null) return { kind: "absent", raw: null };
  const text = String(raw).trim();
  if (text === "") return { kind: "absent", raw: null };
  if (/^indefinite$/i.test(text)) return { kind: "indefinite", raw: text };
  const cleaned = text.replace(/[$,\s]/g, "");
  const m = /^(\d+)(?:\.(\d+))?$/.exec(cleaned);
  if (!m) return { kind: "unparseable", raw: text };
  // Form D amounts are whole US dollars. Keep cents out of arithmetic; drop a
  // fractional part only if it is zero, otherwise keep it unparseable to avoid silent rounding.
  if (m[2] && /[1-9]/.test(m[2])) return { kind: "unparseable", raw: text };
  return { kind: "value", raw: text, usd: BigInt(m[1]).toString() };
}

export function amountValue(a: FiledAmount): bigint | null {
  return a.kind === "value" ? BigInt(a.usd) : null;
}

export function formatUsd(usd: string | bigint | null): string {
  if (usd === null) return "unknown";
  const s = BigInt(usd).toString();
  return "$" + s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function describeAmount(a: FiledAmount): string {
  switch (a.kind) {
    case "value":
      return formatUsd(a.usd);
    case "indefinite":
      return "indefinite (as filed)";
    case "absent":
      return "not reported";
    case "unparseable":
      return `unparsed value "${a.raw}"`;
  }
}

/**
 * Parse an announced amount like "$12.5 million", "$3M", "USD 40 million",
 * "$1.2B". Returns integer dollars as a decimal string using exact decimal math.
 */
export function parseAnnouncedAmount(text: string): { usd: string; text: string } | null {
  const re = /(?:US\$|USD\s?|\$)\s?(\d{1,4}(?:,\d{3})*(?:\.\d{1,3})?)\s?(million|mn|m|billion|bn|b|thousand|k)?\b/i;
  const m = re.exec(text);
  if (!m) return null;
  const num = m[1].replace(/,/g, "");
  const unit = (m[2] ?? "").toLowerCase();
  const scale = unit.startsWith("b") ? 9 : unit === "million" || unit === "mn" || unit === "m" ? 6 : unit === "thousand" || unit === "k" ? 3 : 0;
  const [whole, frac = ""] = num.split(".");
  if (frac.length > scale) return null;
  const digits = whole + frac.padEnd(scale, "0");
  const usd = BigInt(digits).toString();
  if (scale === 0 && BigInt(usd) < 10000n) return null; // "$5" is not a financing amount
  return { usd, text: m[0].trim() };
}

/** |a-b| <= pct% of max(a,b), integer math. */
export function withinPercent(a: bigint, b: bigint, pct: number): boolean {
  const max = a > b ? a : b;
  if (max === 0n) return a === b;
  const diff = a > b ? a - b : b - a;
  return diff * 100n <= max * BigInt(pct);
}
