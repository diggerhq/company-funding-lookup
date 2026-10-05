// Deterministic extraction from fetched pages. Page content is untrusted data:
// we only pull structured fields with fixed patterns and short excerpts. Nothing
// from a page is ever treated as an instruction, destination, secret or setting.

export function htmlToText(html: string): string {
  return decode(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr|\/section|\/article)\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

export function decode(t: string): string {
  return t
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&copy;/g, "©")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;|&rsquo;|&lsquo;/g, "'")
    .replace(/&ndash;|&mdash;/g, "-")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

/** Short, single-line excerpt safe to show; control characters and markup removed. */
export function excerpt(text: string, at: number, radius = 160): string {
  const start = Math.max(0, at - radius);
  return text
    .slice(start, at + radius)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/[<>`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 320);
}

export function metaContent(html: string, key: string): string | null {
  const re = new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${key.replace(/[.:]/g, "\\$&")}["'][^>]*>`, "i");
  const tag = re.exec(html)?.[0];
  const content = tag && /content=["']([^"']*)["']/i.exec(tag)?.[1];
  return content ? decode(content).trim() : null;
}

export function pageTitle(html: string): string | null {
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  return t ? decode(t).replace(/\s+/g, " ").trim().slice(0, 200) : null;
}

export function jsonLd(html: string): any[] {
  const out: any[] = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    try {
      const v = JSON.parse(m[1].trim());
      const flat = (x: any): any[] => (Array.isArray(x) ? x.flatMap(flat) : x && typeof x === "object" ? [x, ...(x["@graph"] ? flat(x["@graph"]) : [])] : []);
      out.push(...flat(v));
    } catch {
      /* malformed JSON-LD is ignored */
    }
  }
  return out;
}

const SUFFIX = String.raw`(?:Inc\.?|Incorporated|LLC|L\.L\.C\.|Corp\.?|Corporation|Ltd\.?|Limited|GmbH|PBC|P\.B\.C\.|L\.P\.|LP|S\.A\.|B\.V\.|AG|SAS|Pty\.? Ltd\.?|Co\.)`;
const NAME = String.raw`([A-Z0-9][A-Za-z0-9&'’.\-]*(?:[ ,][A-Za-z0-9&'’.\-]+){0,6}?,? ${SUFFIX})`;

export function legalNamesInText(text: string): { name: string; index: number }[] {
  const out: { name: string; index: number }[] = [];
  const re = new RegExp(String.raw`(?:^|[\s(“"'©])` + NAME + String.raw`(?=[\s,.;:)”"']|$)`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let name = m[1].replace(/\s+/g, " ").replace(/^(?:The|By|And|Of|From|With|Between|Copyright|All|Rights|Reserved)\s+/i, "").trim();
    name = name.replace(/^\d{4}(?:\s*[-–]\s*\d{4})?\s+/, ""); // copyright years
    if (name.split(" ").length > 8 || name.length < 4) continue;
    if (/^(?:Apple|Google|Amazon|Microsoft|Stripe|Meta|Cloudflare|Twilio|Salesforce|HubSpot|Intercom|Zendesk|Segment|Mailchimp|Okta|Atlassian)\b/i.test(name)) continue; // common processors named in privacy policies
    out.push({ name, index: m.index });
  }
  return out;
}

const STATES = "Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming|Ontario|British Columbia|England and Wales|England|Ireland|Cayman Islands|Singapore|Israel|Germany|France|the Netherlands|Canada|United Kingdom";

/** "Acme Labs, Inc., a Delaware corporation" -> {name, jurisdiction} */
export function jurisdictionStatements(text: string): { name: string | null; jurisdiction: string; index: number }[] {
  const out: { name: string | null; jurisdiction: string; index: number }[] = [];
  const re = new RegExp(String.raw`(?:` + NAME + String.raw`[,]?\s*\(?)?\b(?:a|an)\s+(${STATES})\s+(?:public benefit corporation|corporation|limited liability company|limited partnership|company|private limited company)`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push({ name: m[1] ? m[1].trim() : null, jurisdiction: m[2], index: m.index });
  return out;
}

export function founderStatements(text: string): { name: string; index: number }[] {
  const out: { name: string; index: number }[] = [];
  const person = String.raw`([A-Z][a-z]+(?:[ -][A-Z][a-z]+){1,2})`;
  const res = [
    new RegExp(String.raw`(?:co-?founded|founded)\s+(?:in \d{4}\s+)?by\s+` + person + String.raw`(?:,?\s+(?:and\s+)?` + person + String.raw`)?(?:,?\s+(?:and\s+)?` + person + ")?", "g"),
    new RegExp(person + String.raw`,?\s*(?:\(|–|-|—)?\s*(?:Co-?[Ff]ounder|Founder)`, "g"),
    new RegExp(String.raw`(?:Co-?[Ff]ounder|Founder)(?: and CEO| & CEO|,? CEO)?[,:]?\s+` + person, "g"),
  ];
  for (const re of res) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      for (const g of m.slice(1)) if (g && !/^(The|Our|We|Founded|Founder|Company|Team)\b/.test(g)) out.push({ name: g.trim(), index: m.index });
    }
  }
  return out;
}

export function sameSiteLinks(html: string, baseUrl: string): { url: string; text: string }[] {
  const out: { url: string; text: string }[] = [];
  const base = new URL(baseUrl);
  const re = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    try {
      const u = new URL(decode(m[1]), base);
      if (u.protocol !== "https:" && u.protocol !== "http:") continue;
      const h = u.hostname.replace(/^www\./, "");
      const b = base.hostname.replace(/^www\./, "");
      if (h !== b && !h.endsWith("." + b)) continue;
      u.hash = "";
      out.push({ url: u.toString(), text: htmlToText(m[2]).slice(0, 80) });
    } catch {
      /* ignore */
    }
  }
  return out;
}

export function classifyLink(l: { url: string; text: string }): "legal" | "about" | "news" | null {
  const p = new URL(l.url).pathname.toLowerCase();
  const t = l.text.toLowerCase();
  if (/terms|privacy|legal|tos\b|imprint|impressum/.test(p) || /^(terms|privacy|legal|imprint)/.test(t)) return "legal";
  if (/\/(press|news|newsroom|blog|announcements?|media)(\/|$)/.test(p) || /^(press|news|newsroom|blog)$/.test(t)) return "news";
  if (/\/(about|company|team|about-us)(\/|$)/.test(p) || /^(about|company|about us|team)$/.test(t)) return "about";
  return null;
}

/** Article publication date from common markup, else null (never guessed). */
export function publishedDate(html: string): string | null {
  const candidates = [
    metaContent(html, "article:published_time"),
    metaContent(html, "datePublished"),
    metaContent(html, "og:published_time"),
    /<time[^>]+datetime=["']([^"']+)["']/i.exec(html)?.[1] ?? null,
    ...jsonLd(html).map((o) => (typeof o.datePublished === "string" ? o.datePublished : null)),
  ];
  for (const c of candidates) {
    const d = c && /^(\d{4}-\d{2}-\d{2})/.exec(c.trim());
    if (d) return d[1];
  }
  return null;
}

export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[’'.,()"]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const SUFFIX_WORDS = /\b(inc|incorporated|llc|l l c|corp|corporation|ltd|limited|gmbh|pbc|p b c|lp|l p|co|company|sa|bv|ag|sas|pty)\b/g;
export function coreName(name: string): string {
  return normalizeName(name).replace(SUFFIX_WORDS, "").replace(/\s+/g, " ").trim();
}

export function looksLikeFund(name: string): boolean {
  return /\b(fund|funds|l\.?p\.?|partners|capital|ventures|spv|series [a-z0-9]+ of|investors?|holdings? lp|feeder|master|opportunit(y|ies)|a series of)\b/i.test(name);
}
