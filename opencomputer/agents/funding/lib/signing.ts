import { createHmac, timingSafeEqual } from "node:crypto";
import { sha256 } from "./formd";

// Tool calls in one session can run in different runtimes, so nothing is cached
// between calls. funding_lookup returns the compact result signed with the
// OWNER_SIGNING_KEY runtime variable; the result tool commits it only if the
// signature verifies, so the model cannot alter the typed result in transit.

export function signResult(json: string, env: Record<string, string | undefined> = process.env): string {
  const key = env.OWNER_SIGNING_KEY;
  if (!key) return "sha256:" + sha256(json); // integrity only (dev without a key)
  return "hmac:" + createHmac("sha256", key).update(json).digest("base64url");
}

export function verifyResult(json: string, signature: string, env: Record<string, string | undefined> = process.env): boolean {
  const expected = signResult(json, env);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
