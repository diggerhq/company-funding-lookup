import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

// Fetching user-supplied URLs. Rules:
// - http/https only, default ports only, no userinfo
// - block private, loopback, link-local, CGNAT, multicast, reserved and cloud-metadata
//   addresses, both before connecting and at connect time (guarded DNS lookup), so a
//   DNS answer cannot change between the check and the connection
// - follow at most MAX_REDIRECTS redirects, re-validating each target
// - send no credentials, cookies or auth headers to user-supplied domains

export const MAX_REDIRECTS = 5;
export const MAX_BODY_BYTES = 1_500_000;
export const HOP_TIMEOUT_MS = 10_000;

export class UnsafeUrlError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

const BLOCKED_HOSTNAMES = [/^localhost$/i, /\.localhost$/i, /\.local$/i, /\.internal$/i, /^metadata$/i, /^instance-data$/i, /\.home\.arpa$/i];

export function normalizeInputUrl(input: string): URL {
  let text = String(input ?? "").trim();
  if (!text) throw new UnsafeUrlError("Empty URL", "empty");
  if (text.length > 2048) throw new UnsafeUrlError("URL too long", "too_long");
  // A bare domain ("example.com/about") is accepted and treated as https.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) text = "https://" + text;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new UnsafeUrlError("Not a valid URL", "invalid");
  }
  assertUrlShape(url);
  url.hash = "";
  return url;
}

export function assertUrlShape(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new UnsafeUrlError(`Scheme ${url.protocol} is not allowed`, "scheme");
  if (url.username || url.password) throw new UnsafeUrlError("URLs with embedded credentials are not allowed", "credentials");
  if (url.port && url.port !== "80" && url.port !== "443") throw new UnsafeUrlError("Only default web ports are allowed", "port");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new UnsafeUrlError("Missing host", "host");
  if (BLOCKED_HOSTNAMES.some((re) => re.test(host))) throw new UnsafeUrlError(`Host ${host} is not a public web host`, "host");
  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw new UnsafeUrlError(`Address ${host} is private or reserved`, "private_address");
  } else if (!host.includes(".")) {
    throw new UnsafeUrlError(`Host ${host} is not a public domain`, "host");
  }
}

function v4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}

const V4_BLOCKS: [string, number][] = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];

export function isBlockedIp(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) {
    const n = v4ToInt(ip);
    return V4_BLOCKS.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (n & mask) === (v4ToInt(base) & mask);
    });
  }
  if (kind === 6) {
    const groups = expandV6(ip);
    if (!groups) return true;
    const [g0] = groups;
    if (groups.every((g) => g === 0)) return true; // ::
    if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true; // ::1
    if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local (incl. fd00:ec2::254 metadata)
    if ((g0 & 0xffc0) === 0xfe80) return true; // link-local
    if ((g0 & 0xff00) === 0xff00) return true; // multicast
    if (g0 === 0x2001 && groups[1] === 0x0db8) return true; // documentation
    // IPv4-mapped / translated forms: check the embedded IPv4 address.
    const embedded = `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
    if (groups.slice(0, 5).every((g) => g === 0) && (groups[5] === 0xffff || groups[5] === 0)) return isBlockedIp(embedded);
    if (g0 === 0x64 && groups[1] === 0xff9b) return isBlockedIp(embedded); // 64:ff9b::/96
    if (g0 === 0x2002) return isBlockedIp(`${groups[1] >> 8}.${groups[1] & 255}.${groups[2] >> 8}.${groups[2] & 255}`); // 6to4
    return false;
  }
  return true; // not an IP: treat as unsafe in this context
}

function expandV6(ip: string): number[] | null {
  let text = ip.split("%")[0];
  // Trailing dotted IPv4
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4) {
    const n = v4ToInt(v4[1]);
    text = text.slice(0, -v4[1].length) + ((n >>> 16) & 0xffff).toString(16) + ":" + (n & 0xffff).toString(16);
  }
  const [head, tail] = text.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined ? (tail ? tail.split(":") : []) : [];
  const fill = text.includes("::") ? 8 - h.length - t.length : 0;
  const parts = [...h, ...Array(Math.max(fill, 0)).fill("0"), ...t];
  if (parts.length !== 8) return null;
  const nums = parts.map((p) => parseInt(p || "0", 16));
  return nums.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff) ? null : nums;
}

export interface HopResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
}
export type HopFn = (url: URL, signal: AbortSignal) => Promise<HopResponse>;
export type ResolveFn = (hostname: string) => Promise<string[]>;

export const defaultResolve: ResolveFn = async (hostname) => {
  const addrs = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return addrs.map((a) => a.address);
};

// The lookup used for the actual socket: rejects blocked answers at connect time.
function guardedLookup(hostname: string, options: dns.LookupOptions, callback: (...args: any[]) => void) {
  dns.lookup(hostname, { ...options, all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = addresses as dns.LookupAddress[];
    const blocked = list.find((a) => isBlockedIp(a.address));
    if (blocked || list.length === 0) {
      return callback(new UnsafeUrlError(`Host ${hostname} resolved to a private or reserved address`, "private_address"));
    }
    if (options.all) return callback(null, list);
    callback(null, list[0].address, list[0].family);
  });
}

/** One HTTP hop with no redirect following, no cookies and a bounded body. */
export const defaultHop: HopFn = (url, signal) =>
  new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      url,
      {
        method: "GET",
        lookup: guardedLookup as any,
        signal,
        timeout: HOP_TIMEOUT_MS,
        headers: {
          "user-agent": "Mozilla/5.0 (compatible; company-funding-lookup/1.0; public-source research)",
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5",
          "accept-encoding": "identity",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        res.on("data", (c: Buffer) => {
          if (size >= MAX_BODY_BYTES) {
            truncated = true;
            res.destroy();
            return;
          }
          size += c.length;
          chunks.push(c);
        });
        const finish = () => {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(", ") : v;
          resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks).toString("utf8").slice(0, MAX_BODY_BYTES), truncated });
        };
        res.on("end", finish);
        res.on("close", finish);
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });

export interface SafeGetResult {
  requestedUrl: string;
  finalUrl: string;
  chain: string[];
  status: number;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
}

export async function safeGet(
  input: string | URL,
  opts: { hop?: HopFn; resolve?: ResolveFn; signal?: AbortSignal; maxRedirects?: number } = {},
): Promise<SafeGetResult> {
  const hop = opts.hop ?? defaultHop;
  const resolve = opts.resolve ?? defaultResolve;
  let url = typeof input === "string" ? normalizeInputUrl(input) : input;
  const chain: string[] = [];
  const max = opts.maxRedirects ?? MAX_REDIRECTS;
  for (let i = 0; ; i++) {
    assertUrlShape(url);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (!net.isIP(host)) {
      const addrs = await resolve(host);
      if (addrs.length === 0 || addrs.some(isBlockedIp)) throw new UnsafeUrlError(`Host ${host} resolves to a private or reserved address`, "private_address");
    }
    chain.push(url.toString());
    const signal = opts.signal ?? AbortSignal.timeout(HOP_TIMEOUT_MS);
    const res = await hop(url, signal);
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      if (i >= max) throw new UnsafeUrlError(`Too many redirects (>${max})`, "redirects");
      let next: URL;
      try {
        next = new URL(res.headers.location, url);
      } catch {
        throw new UnsafeUrlError("Invalid redirect target", "redirect_invalid");
      }
      try {
        assertUrlShape(next);
      } catch (e) {
        throw new UnsafeUrlError(`Unsafe redirect target: ${(e as Error).message}`, "redirect_unsafe");
      }
      next.hash = "";
      url = next;
      continue;
    }
    return { requestedUrl: chain[0], finalUrl: url.toString(), chain, status: res.status, headers: res.headers, body: res.body, truncated: res.truncated };
  }
}

/** Registrable-ish domain for display/matching: strips "www." only (no PSL dependency). */
export function canonicalDomain(url: string | URL): string {
  const u = typeof url === "string" ? new URL(url) : url;
  return u.hostname.toLowerCase().replace(/^www\./, "");
}

export function sameSite(a: string, b: string): boolean {
  const da = canonicalDomain(a);
  const db = canonicalDomain(b);
  return da === db || da.endsWith("." + db) || db.endsWith("." + da);
}
