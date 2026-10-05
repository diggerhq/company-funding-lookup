import { createHmac, timingSafeEqual } from "node:crypto";

// Owner identity comes from the authenticated application, never from message
// text or a model-chosen value. The app server signs `owner_id:session_id` with
// OWNER_SIGNING_KEY (an agent runtime variable shared with the app) and sends the
// token in the turn payload. Tools verify it against the session they run in, so
// a token cannot be forged by the model or replayed into another session.
//
// Single-owner mode: the fixed owner "local-dev" (token "dev.local-dev") is
// allowed when DEV_SINGLE_USER=1, or when no OWNER_SIGNING_KEY is configured at
// all (a personal deployment, e.g. from the template, has exactly one owner).
// Any deployment that sets OWNER_SIGNING_KEY to serve several users requires
// signed tokens unless DEV_SINGLE_USER=1 is set explicitly.

export const DEV_OWNER = "local-dev";
export const DEV_TOKEN = "dev.local-dev";
const OWNER_RE = /^[A-Za-z0-9_.:@-]{1,128}$/;

const mac = (key: string, ownerId: string, sessionId: string) => createHmac("sha256", key).update(`${ownerId}:${sessionId}`).digest("hex").slice(0, 40);

/** Plain-text token ("v2:<owner>:<40 hex>") so a model passing it along copies it reliably. */
export function signOwner(ownerId: string, sessionId: string, key: string): string {
  if (!OWNER_RE.test(ownerId)) throw new Error("invalid owner id");
  return `v2:${ownerId}:${mac(key, ownerId, sessionId)}`;
}

export type OwnerCheck = { ok: true; ownerId: string } | { ok: false; reason: string };

export function verifyOwner(token: unknown, sessionId: string, env: Record<string, string | undefined> = process.env): OwnerCheck {
  if (typeof token !== "string" || !token) return { ok: false, reason: "missing owner token" };
  if (token === DEV_TOKEN) {
    return env.DEV_SINGLE_USER === "1" || !env.OWNER_SIGNING_KEY
      ? { ok: true, ownerId: DEV_OWNER }
      : { ok: false, reason: "single-owner token not allowed: this deployment serves multiple users (OWNER_SIGNING_KEY is set)" };
  }
  const key = env.OWNER_SIGNING_KEY;
  if (!key) return { ok: false, reason: "OWNER_SIGNING_KEY not configured" };
  const m = /^v2:(.+):([a-f0-9]{40})$/.exec(token.trim());
  if (!m) return { ok: false, reason: "malformed owner token: pass owner_token exactly as given in the instructions" };
  const [, ownerId, sig] = m;
  if (!OWNER_RE.test(ownerId)) return { ok: false, reason: "malformed owner id" };
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(mac(key, ownerId, sessionId)))) return { ok: false, reason: "owner token signature invalid for this session" };
  return { ok: true, ownerId };
}
