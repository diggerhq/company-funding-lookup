import { createRequire } from 'module'; const require = createRequire(import.meta.url);

// web/app.ts
import { createHash as createHash2, createHmac as createHmac2, randomBytes as randomBytes2, timingSafeEqual as timingSafeEqual2 } from "node:crypto";

// opencomputer/agents/funding/lib/owner.ts
import { createHmac, timingSafeEqual } from "node:crypto";
var DEV_OWNER = "local-dev";
var DEV_TOKEN = "dev.local-dev";
var OWNER_RE = /^[A-Za-z0-9_.:@-]{1,128}$/;
var mac = (key, ownerId, sessionId) => createHmac("sha256", key).update(`${ownerId}:${sessionId}`).digest("hex").slice(0, 40);
function signOwner(ownerId, sessionId, key) {
  if (!OWNER_RE.test(ownerId)) throw new Error("invalid owner id");
  return `v2:${ownerId}:${mac(key, ownerId, sessionId)}`;
}

// opencomputer/agents/funding/lib/formd.ts
import { createHash } from "node:crypto";
function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

// opencomputer/agents/funding/lib/persist.ts
function companyId(domain) {
  return "co:" + sha256(domain.toLowerCase()).slice(0, 16);
}
function verificationQuery(ownerId, lookupId) {
  return {
    sql: "SELECT r.report_sha256 AS report_sha256, r.report_json AS report_json, r.status AS status, (SELECT COUNT(*) FROM evidence e WHERE e.owner_id = r.owner_id AND e.lookup_id = r.id) AS evidence_rows, (SELECT COUNT(*) FROM filings f WHERE f.owner_id = r.owner_id AND f.last_lookup_id = r.id) AS filing_rows, (SELECT COUNT(*) FROM offerings o WHERE o.owner_id = r.owner_id AND o.last_lookup_id = r.id) AS offering_rows, (SELECT COUNT(*) FROM entity_candidates c WHERE c.owner_id = r.owner_id AND c.last_lookup_id = r.id) AS candidate_rows, length(r.report_json) AS report_bytes FROM lookup_runs r WHERE r.owner_id = ? AND r.id = ?",
    parameters: [ownerId, lookupId]
  };
}

// opencomputer/agents/funding/lib/url-safety.ts
import net from "node:net";
var UnsafeUrlError = class extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
    this.name = "UnsafeUrlError";
  }
  code;
};
var BLOCKED_HOSTNAMES = [/^localhost$/i, /\.localhost$/i, /\.local$/i, /\.internal$/i, /^metadata$/i, /^instance-data$/i, /\.home\.arpa$/i];
function normalizeInputUrl(input) {
  let text = String(input ?? "").trim();
  if (!text) throw new UnsafeUrlError("Empty URL", "empty");
  if (text.length > 2048) throw new UnsafeUrlError("URL too long", "too_long");
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) text = "https://" + text;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new UnsafeUrlError("Not a valid URL", "invalid");
  }
  assertUrlShape(url);
  url.hash = "";
  return url;
}
function assertUrlShape(url) {
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
function v4ToInt(ip) {
  return ip.split(".").reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}
var V4_BLOCKS = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4]
];
function isBlockedIp(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) {
    const n = v4ToInt(ip);
    return V4_BLOCKS.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : ~0 << 32 - bits >>> 0;
      return (n & mask) === (v4ToInt(base) & mask);
    });
  }
  if (kind === 6) {
    const groups = expandV6(ip);
    if (!groups) return true;
    const [g0] = groups;
    if (groups.every((g) => g === 0)) return true;
    if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true;
    if ((g0 & 65024) === 64512) return true;
    if ((g0 & 65472) === 65152) return true;
    if ((g0 & 65280) === 65280) return true;
    if (g0 === 8193 && groups[1] === 3512) return true;
    const embedded = `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
    if (groups.slice(0, 5).every((g) => g === 0) && (groups[5] === 65535 || groups[5] === 0)) return isBlockedIp(embedded);
    if (g0 === 100 && groups[1] === 65435) return isBlockedIp(embedded);
    if (g0 === 8194) return isBlockedIp(`${groups[1] >> 8}.${groups[1] & 255}.${groups[2] >> 8}.${groups[2] & 255}`);
    return false;
  }
  return true;
}
function expandV6(ip) {
  let text = ip.split("%")[0];
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4) {
    const n = v4ToInt(v4[1]);
    text = text.slice(0, -v4[1].length) + (n >>> 16 & 65535).toString(16) + ":" + (n & 65535).toString(16);
  }
  const [head, tail] = text.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== void 0 ? tail ? tail.split(":") : [] : [];
  const fill = text.includes("::") ? 8 - h.length - t.length : 0;
  const parts = [...h, ...Array(Math.max(fill, 0)).fill("0"), ...t];
  if (parts.length !== 8) return null;
  const nums = parts.map((p) => parseInt(p || "0", 16));
  return nums.some((n) => Number.isNaN(n) || n < 0 || n > 65535) ? null : nums;
}
function canonicalDomain(url) {
  const u = typeof url === "string" ? new URL(url) : url;
  return u.hostname.toLowerCase().replace(/^www\./, "");
}

// scripts/oc-client.ts
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// node_modules/@opencomputer/sdk/dist/agents/errors.js
var CODE_BY_STATUS = {
  400: "invalid_request",
  401: "unauthorized",
  402: "insufficient_credits",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  429: "rate_limited"
};
var OpenComputerError = class extends Error {
  /** The API's stable error code, or one derived from the status when the body had none. */
  code;
  /** The HTTP status. */
  status;
  /** Seconds to wait before retrying, from `Retry-After`, when the API sent one. */
  retryAfter;
  /**
   * The session the failure concerns, when the API named one:
   * `session_publication_unconfirmed` carries the id of the session that
   * exists, or whose labels are recorded, but is not confirmed in the list
   * yet. The client does not retry; the caller repeats the same call.
   */
  sessionId;
  constructor(status, code, message, details = {}) {
    super(message || `OpenComputer request failed (${status})`);
    this.name = "OpenComputerError";
    this.status = status;
    this.code = code || CODE_BY_STATUS[status] || (status >= 500 ? "unavailable" : "request_failed");
    if (details.retryAfter !== void 0)
      this.retryAfter = details.retryAfter;
    if (details.sessionId !== void 0)
      this.sessionId = details.sessionId;
  }
};
function errorFromResponse(status, body2, headers) {
  const envelope = body2 && typeof body2 === "object" ? body2 : void 0;
  const error = envelope?.error;
  const fields = typeof error === "object" && error ? error : void 0;
  const message = typeof error === "string" ? error : fields?.message;
  const retryAfterHeader = headers?.get("retry-after");
  const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : Number.NaN;
  const details = {};
  if (Number.isFinite(retryAfter) && retryAfter > 0)
    details.retryAfter = retryAfter;
  if (typeof fields?.sessionId === "string" && fields.sessionId)
    details.sessionId = fields.sessionId;
  return new OpenComputerError(status, fields?.code, message, details);
}

// node_modules/@opencomputer/sdk/dist/agents/shapes.js
var ShapeError = class extends Error {
  path;
  expected;
  constructor(path, expected) {
    super(`${path}: expected ${expected}`);
    this.path = path;
    this.expected = expected;
    this.name = "ShapeError";
  }
};
var at = (path, key) => typeof key === "number" ? `${path}[${String(key)}]` : path === "body" ? key : `${path}.${key}`;
var string = (value, path) => {
  if (typeof value !== "string")
    throw new ShapeError(path, "a string");
  return value;
};
var nonEmptyString = (value, path) => {
  if (typeof value !== "string" || !value)
    throw new ShapeError(path, "a non-empty string");
  return value;
};
var number = (value, path) => {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new ShapeError(path, "a number");
  return value;
};
var boolean = (value, path) => {
  if (typeof value !== "boolean")
    throw new ShapeError(path, "a boolean");
  return value;
};
var stringAs = () => nonEmptyString;
function oneOf(...values) {
  return (value, path) => {
    if (typeof value !== "string" || !values.includes(value)) {
      throw new ShapeError(path, `one of ${values.map((v) => JSON.stringify(v)).join(", ")}`);
    }
    return value;
  };
}
function optional(shape) {
  return (value, path) => value === void 0 ? void 0 : shape(value, path);
}
function nullable(shape) {
  return (value, path) => value === null ? null : shape(value, path);
}
function array(item) {
  return (value, path) => {
    if (!Array.isArray(value))
      throw new ShapeError(path, "an array");
    return value.map((entry, index) => item(entry, at(path, index)));
  };
}
var isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var anyRecord = (value, path) => {
  if (!isRecord(value))
    throw new ShapeError(path, "an object");
  return value;
};
function record(item) {
  return (value, path) => {
    if (!isRecord(value))
      throw new ShapeError(path, "an object");
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, item(entry, at(path, key))]));
  };
}
function object(fields) {
  return (value, path) => {
    if (!isRecord(value))
      throw new ShapeError(path, "an object");
    const result = { ...value };
    for (const [key, shape] of Object.entries(fields)) {
      const checked = shape(value[key], at(path, key));
      if (checked === void 0)
        delete result[key];
      else
        result[key] = checked;
    }
    return result;
  };
}
var jsonValue = (value, path) => {
  checkJsonValue(value, path);
  return value;
};
function checkJsonValue(value, path) {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new ShapeError(path, "a JSON value");
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => checkJsonValue(entry, at(path, index)));
    return;
  }
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value))
      checkJsonValue(entry, at(path, key));
    return;
  }
  throw new ShapeError(path, "a JSON value");
}
var none = (value, path) => {
  if (value !== void 0)
    throw new ShapeError(path, "no body");
};
var environment = oneOf("development", "production");
var labels = record(string);
var sessionResult = object({
  turnId: string,
  callId: string,
  reportedAt: string,
  data: jsonValue
});
var outcomeEventType = oneOf("turn.completed", "turn.failed", "turn.cancelled");
var sessionDestination = object({ type: oneOf("session"), sessionId: string });
var turnOutcomeDelivery = object({
  id: string,
  subscriptionId: string,
  eventId: string,
  eventType: outcomeEventType,
  destination: sessionDestination,
  status: oneOf("pending", "delivered", "failed"),
  attempt: number,
  receipt: optional(object({ sessionId: string, turnId: string })),
  nextAttemptAt: optional(string),
  error: optional(oneOf("subscription_unavailable", "target_missing", "target_ended", "delivery_failed")),
  updatedAt: string
});
var sessionQuestion = object({
  id: string,
  text: string,
  options: array(object({ label: string, value: string })),
  askedAt: string
});
var turn = object({
  id: string,
  input: string,
  mode: oneOf("queue", "steer", "interrupt"),
  status: stringAs(),
  outcome: optional(stringAs()),
  reason: optional(string),
  questionId: optional(string),
  payload: optional(jsonValue),
  deliveries: optional(array(turnOutcomeDelivery)),
  createdAt: string,
  updatedAt: string
});
var sessionMemoryBinding = (value, path) => {
  const binding = object({
    resource: string,
    scope: oneOf("document", "collection"),
    id: optional(string),
    access: oneOf("read", "read-write"),
    writable: boolean
  })(value, path);
  if (binding.scope === "document") {
    if (binding.id === void 0)
      throw new ShapeError(at(path, "id"), "a string");
    return { ...binding, scope: "document", id: binding.id };
  }
  if (binding.access !== "read")
    throw new ShapeError(at(path, "access"), '"read"');
  return { resource: binding.resource, scope: "collection", access: "read", writable: binding.writable };
};
var session = object({
  id: string,
  projectId: optional(string),
  agentId: string,
  deploymentId: string,
  environment: optional(environment),
  status: stringAs(),
  source: optional(string),
  executionMode: optional(string),
  memory: optional(array(sessionMemoryBinding)),
  turns: array(turn),
  labels: optional(labels),
  labelsUpdatedAt: optional(string),
  externalReference: optional(string),
  revision: optional(number),
  result: optional(nullable(sessionResult)),
  question: optional(nullable(sessionQuestion)),
  createdAt: string,
  updatedAt: string
});
var sessionCreated = object({
  session: object({
    id: string,
    status: stringAs(),
    createdAt: string,
    executionMode: optional(string),
    externalReference: optional(string)
  }),
  deployment: optional((value, path) => deployment(value, path))
});
var sessionSummary = object({
  id: string,
  projectId: optional(string),
  agentId: string,
  deploymentId: string,
  environment: optional(nullable(environment)),
  source: optional(string),
  status: stringAs(),
  labels: optional(labels),
  externalReference: optional(string),
  createdAt: string,
  updatedAt: string,
  revision: optional(number),
  activity: optional(object({
    activeTurnId: nullable(string),
    queued: number,
    lastSettledTurn: nullable(object({ id: string, status: stringAs(), at: string }))
  })),
  result: optional(nullable(sessionResult))
});
var sessionPage = (value, path) => {
  const page = object({ sessions: array(sessionSummary), nextCursor: optional(nullable(string)) })(value, path);
  return { sessions: page.sessions, nextCursor: page.nextCursor ?? null };
};
var turnReceiptFields = object({
  turnId: optional(string),
  status: nonEmptyString,
  duplicate: optional(boolean),
  questionId: optional(string),
  heldId: optional(string)
});
var turnReceipt = (value, path) => {
  const receipt = turnReceiptFields(value, path);
  const held = (receipt.status === "held" || receipt.status === "discarded") && !!receipt.questionId && !!receipt.heldId;
  if (receipt.turnId === void 0 && !held) {
    throw new ShapeError(at(path, "turnId"), "a string, or a held receipt with questionId");
  }
  return receipt;
};
var sessionEvent = object({
  id: optional(string),
  seq: number,
  timestamp: optional(string),
  sessionId: optional(string),
  turnId: optional(string),
  type: string,
  data: anyRecord
});
var eventsPage = object({ events: array(sessionEvent) });
var projectEnvironment = object({
  name: environment,
  agentId: optional(string),
  activeDeploymentId: optional(string),
  updatedAt: optional(string)
});
var project = object({
  id: string,
  slug: string,
  name: string,
  environments: array(projectEnvironment),
  agents: array(object({ id: string, name: string })),
  createdAt: string,
  updatedAt: string
});
var projectsPage = object({ projects: array(project) });
var deployment = object({
  id: string,
  agentId: string,
  alias: string,
  memory: optional(array(object({ id: string, description: optional(string), provider: object({ kind: string }) }))),
  createdAt: string
});
var deploymentsPage = object({ deployments: array(deployment) });
var projectDetail = object({
  project,
  deployments: array(deployment),
  sessions: array(sessionSummary),
  connections: array(jsonValue),
  channels: array(jsonValue),
  schedules: array(jsonValue)
});
var agentSummary = object({
  id: string,
  name: string,
  activeAlias: optional(nullable(string)),
  activeDeploymentId: optional(nullable(string)),
  deploymentCount: optional(number),
  createdAt: optional(string),
  updatedAt: optional(string)
});
var agentsPage = object({ agents: array(agentSummary) });
var webhook = object({
  id: string,
  projectId: string,
  environment,
  agentId: string,
  name: string,
  enabled: boolean,
  identity: optional(string),
  invocationUrl: optional(string),
  token: optional(string),
  createdAt: string,
  updatedAt: string,
  lastInvokedAt: optional(string)
});
var webhooksPage = object({ webhooks: array(webhook) });
var webhookEnvelope = object({ webhook });
var webhookRequest = anyRecord;
var webhookRequestsPage = object({ requests: array(webhookRequest) });
var eventSubscription = object({
  id: string,
  projectId: string,
  agentId: optional(string),
  environment: optional(environment),
  events: array(outcomeEventType),
  destination: sessionDestination,
  createdAt: string
});
var eventSubscriptionsPage = object({ subscriptions: array(eventSubscription) });
var eventSubscriptionEnvelope = object({ subscription: eventSubscription });
var memoryWriter = (value, path) => {
  const writer = object({ kind: oneOf("owner", "agent"), sessionId: optional(string) })(value, path);
  if (writer.kind === "owner")
    return { kind: "owner" };
  if (writer.sessionId === void 0)
    throw new ShapeError(at(path, "sessionId"), "a string");
  return { kind: "agent", sessionId: writer.sessionId };
};
var memoryDocumentFields = {
  id: string,
  title: string,
  summary: string,
  agentWrites: oneOf("enabled", "disabled"),
  revision: string,
  bytes: number,
  maxBytes: number,
  updatedAt: string,
  writer: memoryWriter
};
var memoryDocumentMeta = object(memoryDocumentFields);
var memoryDocument = object({ ...memoryDocumentFields, text: string });
var memoryDocumentPage = (value, path) => {
  const page = object({ documents: array(memoryDocumentMeta), nextCursor: optional(nullable(string)) })(value, path);
  return { ...page, nextCursor: page.nextCursor ?? null };
};
var memoryResourceInventory = object({
  resources: array(object({
    id: string,
    provider: object({ kind: string, maxBytes: optional(number) }),
    declared: boolean,
    documents: number
  }))
});
var numberOrString = (value, path) => {
  if (typeof value === "number" || typeof value === "string")
    return value;
  throw new ShapeError(path, "a number or a string");
};
var repository = object({
  id: numberOrString,
  fullName: string,
  private: boolean,
  defaultBranch: string,
  archived: boolean
});
var repositoryPage = (value, path) => {
  const page = object({ repositories: array(repository), nextCursor: optional(nullable(string)) })(value, path);
  return { repositories: page.repositories, nextCursor: page.nextCursor ?? null };
};

// node_modules/@opencomputer/sdk/dist/agents/http.js
var DEFAULT_BASE_URL = "https://app.opencomputer.dev/api/managed-agents";
var Http = class {
  baseUrl;
  apiKey;
  doFetch;
  constructor(apiKey, options = {}) {
    if (!apiKey)
      throw new Error("An OpenComputer API key is required.");
    this.apiKey = apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const f = options.fetch ?? (typeof fetch === "function" ? fetch : void 0);
    if (!f)
      throw new Error("No global fetch is available; pass { fetch } to the client.");
    this.doFetch = (input, init) => f(input, init);
  }
  url(path, query) {
    const url = new URL(this.baseUrl + path);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== void 0 && value !== null)
          url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }
  /**
   * Sends a request and returns the body, checked against `shape`, with the
   * status. Throws `OpenComputerError` on a failed status, on a redirect, and
   * on a success whose body is not JSON or not the documented shape.
   */
  async send(method, path, shape, options = {}) {
    const headers = {
      "x-api-key": this.apiKey,
      accept: "application/json",
      ...options.headers
    };
    const init = { method, headers, signal: options.signal, redirect: "manual" };
    if (options.body !== void 0) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }
    const response = await this.doFetch(this.url(path, options.query), init);
    if (isRedirect(response)) {
      throw new OpenComputerError(response.status, "redirected", `${method} ${path} was answered with a redirect (${String(response.status)}); the client does not follow redirects with the API key. Check baseUrl.`);
    }
    const text = response.status === 204 ? "" : await response.text();
    if (!response.ok) {
      throw errorFromResponse(response.status, parseJson(text) ?? (text ? { error: text } : void 0), response.headers);
    }
    let body2;
    if (text) {
      body2 = parseJson(text);
      if (body2 === void 0) {
        throw new OpenComputerError(response.status, "invalid_response", `${method} ${path} returned a body that is not JSON`);
      }
    }
    try {
      return { status: response.status, body: shape(body2, "body"), headers: response.headers };
    } catch (cause) {
      if (!(cause instanceof ShapeError))
        throw cause;
      throw new OpenComputerError(response.status, "invalid_response", `${method} ${path} returned a body that is not the documented shape: ${cause.message}`);
    }
  }
  /** `send` for callers that need only the body. */
  async request(method, path, shape, options = {}) {
    return (await this.send(method, path, shape, options)).body;
  }
};
function isRedirect(response) {
  return response.type === "opaqueredirect" || response.status >= 300 && response.status < 400;
}
function parseJson(text) {
  if (!text)
    return void 0;
  try {
    return JSON.parse(text);
  } catch {
    return void 0;
  }
}
var segment = (value) => encodeURIComponent(value);

// node_modules/@opencomputer/sdk/dist/agents/start-on-document.js
async function sessionIdempotencyKey(idempotencyKey) {
  const bytes = new TextEncoder().encode(`opencomputer.memory.session\0${idempotencyKey}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let hex = "";
  for (const byte of digest)
    hex += byte.toString(16).padStart(2, "0");
  return hex;
}
async function startOnDocument(http, params) {
  const documentPath = `/projects/${segment(params.projectId)}/memory/${segment(params.resource)}/documents/${segment(params.documentId)}`;
  const query = { environment: params.environment };
  let document;
  let documentCreated;
  try {
    const created2 = await http.send("PUT", documentPath, memoryDocument, {
      query,
      headers: { "if-none-match": "*" },
      body: {
        title: params.document.title,
        text: params.document.text ?? "",
        ...params.document.summary !== void 0 ? { summary: params.document.summary } : {},
        ...params.document.agentWrites ? { agentWrites: params.document.agentWrites } : {}
      },
      signal: params.signal
    });
    document = created2.body;
    documentCreated = true;
  } catch (cause) {
    if (!(cause instanceof OpenComputerError) || cause.status !== 412)
      throw cause;
    try {
      document = await http.request("GET", documentPath, memoryDocument, { query, signal: params.signal });
    } catch (readCause) {
      if (readCause instanceof OpenComputerError && readCause.status === 404) {
        throw new OpenComputerError(404, "memory_document_deleted", `Document ${params.resource}/${params.documentId} was deleted and its id is reserved; a session cannot bind it. Use a new document id.`);
      }
      throw readCause;
    }
    documentCreated = false;
  }
  let created;
  try {
    created = await http.send("POST", "/sessions", sessionCreated, {
      headers: { "idempotency-key": await sessionIdempotencyKey(params.idempotencyKey) },
      body: {
        agentId: `${params.agent}@${params.environment}`,
        source: params.source ?? "api",
        memory: {
          ...params.memory,
          [params.resource]: { scope: "document", id: params.documentId, access: params.access ?? "read-write" }
        }
      },
      signal: params.signal
    });
  } catch (cause) {
    if (cause instanceof OpenComputerError && cause.status === 409) {
      throw new OpenComputerError(409, "idempotency_key_reused", `Idempotency key ${JSON.stringify(params.idempotencyKey)} already created a session with a different agent, environment or memory bindings. Use a new key to start another session; the document was left as it is.`);
    }
    throw cause;
  }
  const { session: session2 } = created.body;
  return {
    document: { id: document.id, created: documentCreated, revision: document.revision, title: document.title },
    session: {
      id: session2.id,
      created: created.status === 201,
      ...session2.status ? { status: session2.status } : {},
      ...session2.executionMode ? { executionMode: session2.executionMode } : {}
    }
  };
}

// node_modules/@opencomputer/sdk/dist/agents/client.js
var Turns = class {
  http;
  constructor(http) {
    this.http = http;
  }
  /**
   * `POST /sessions/<id>/turns`: admits a turn; follow it in the event log.
   * The key travels as the `Idempotency-Key` header, the one rule for both
   * create and send; the body field of the same name is the form a browser
   * send proxied through the application's own server uses.
   */
  async send(sessionId, params, options = {}) {
    const body2 = { input: params.input };
    if (params.mode !== void 0)
      body2.mode = params.mode;
    if (params.payload !== void 0)
      body2.payload = params.payload;
    if (params.answers !== void 0)
      body2.answers = params.answers;
    const answer = await this.http.send("POST", `/sessions/${segment(sessionId)}/turns`, turnReceipt, {
      body: body2,
      headers: params.idempotencyKey !== void 0 ? { "idempotency-key": params.idempotencyKey } : void 0,
      signal: options.signal
    });
    const duplicate = answer.body.duplicate ?? answer.status === 200;
    if (answer.body.turnId !== void 0) {
      return { turnId: answer.body.turnId, status: answer.body.status, duplicate };
    }
    return {
      status: answer.body.status,
      questionId: answer.body.questionId,
      heldId: answer.body.heldId,
      duplicate
    };
  }
};
var Events = class {
  http;
  constructor(http) {
    this.http = http;
  }
  /**
   * `GET /sessions/<id>/events?after=<seq>`: up to 500 events with a greater
   * `seq`, ascending. Repeat from the last `seq` until a page is empty.
   */
  async list(sessionId, query = {}, options = {}) {
    const page = await this.http.request("GET", `/sessions/${segment(sessionId)}/events`, eventsPage, {
      query: { after: query.after ?? 0 },
      signal: options.signal
    });
    return page.events;
  }
};
var Questions = class {
  http;
  constructor(http) {
    this.http = http;
  }
  /**
   * `POST /sessions/<id>/questions/<questionId>/dismiss`: closes the open
   * question without an answer (`question.closed` with reason `dismissed`);
   * inputs held behind it run as ordinary turns, in order. Repeating it is
   * harmless; naming a question that is not the open one is `409
   * question_stale`. Answers with the session.
   */
  dismiss(sessionId, questionId, options = {}) {
    return this.http.request("POST", `/sessions/${segment(sessionId)}/questions/${segment(questionId)}/dismiss`, session, { signal: options.signal });
  }
};
var Sessions = class {
  http;
  turns;
  events;
  questions;
  constructor(http) {
    this.http = http;
    this.turns = new Turns(http);
    this.events = new Events(http);
    this.questions = new Questions(http);
  }
  /** `POST /sessions`: creates a session without a turn. `created` is false when the key had already created it. */
  async create(params, options = {}) {
    const answer = await this.http.send("POST", "/sessions", sessionCreated, {
      body: params,
      headers: options.idempotencyKey !== void 0 ? { "idempotency-key": options.idempotencyKey } : void 0,
      signal: options.signal
    });
    return { session: answer.body.session, deployment: answer.body.deployment, created: answer.status === 201 };
  }
  /** `GET /sessions/<id>`. */
  get(sessionId, options = {}) {
    return this.http.request("GET", `/sessions/${segment(sessionId)}`, session, { signal: options.signal });
  }
  /**
   * `GET /sessions`: one page of rows matching the exact filters, ordered by
   * `createdAt` descending then `id` ascending, with `nextCursor` for the
   * next page and `null` on the last. A cursor is bound to the filters it
   * was issued with; sending it with different filters is `400
   * invalid_cursor`. Sort the pages you hold by `updatedAt` for recent
   * activity first, or use `iterate` to walk every page.
   */
  list(query = {}, options = {}) {
    const { labels: labels2, ...rest } = query;
    const q = { ...rest };
    for (const [key, value] of Object.entries(labels2 ?? {}))
      q[`label.${key}`] = value;
    return this.http.request("GET", "/sessions", sessionPage, { query: q, signal: options.signal });
  }
  /**
   * Every row matching the filters, page by page, until `nextCursor` is
   * `null`. `limit` is the page size; `cursor` is where to start. Paging is
   * live: a session created while you iterate appears only if it sorts
   * after your position.
   *
   * ```ts
   * for await (const row of oc.sessions.iterate({ status: "idle", limit: 100 })) {
   *   console.log(row.id, row.externalReference);
   * }
   * ```
   */
  async *iterate(query = {}, options = {}) {
    let cursor = query.cursor;
    do {
      const page = await this.list({ ...query, cursor }, options);
      yield* page.sessions;
      cursor = page.nextCursor ?? void 0;
    } while (cursor !== void 0);
  }
  /** `POST /sessions/<id>/end`: cancels queued and running turns and revokes memory writes. */
  end(sessionId, options = {}) {
    return this.http.request("POST", `/sessions/${segment(sessionId)}/end`, session, { signal: options.signal });
  }
  /** `POST /sessions/<id>/interrupt`: stops the running turn; the next queued turn starts. */
  interrupt(sessionId, options = {}) {
    return this.http.request("POST", `/sessions/${segment(sessionId)}/interrupt`, session, {
      signal: options.signal
    });
  }
  /** `PATCH /sessions/<id>/labels`: per-key last-write-wins. */
  setLabels(sessionId, params, options = {}) {
    return this.http.request("PATCH", `/sessions/${segment(sessionId)}/labels`, session, {
      body: params,
      signal: options.signal
    });
  }
  /** Creates a memory document if needed, then a session bound to it, under one key. */
  startOnDocument(params) {
    return startOnDocument(this.http, params);
  }
};
var MemoryDocuments = class {
  http;
  constructor(http) {
    this.http = http;
  }
  path(projectId, resource, documentId) {
    const base = `/projects/${segment(projectId)}/memory/${segment(resource)}/documents`;
    return documentId === void 0 ? base : `${base}/${segment(documentId)}`;
  }
  /** `GET .../documents`: metadata without `text`; follow `nextCursor`. */
  list(projectId, resource, options) {
    return this.http.request("GET", this.path(projectId, resource), memoryDocumentPage, {
      query: { environment: options.environment, cursor: options.cursor },
      signal: options.signal
    });
  }
  /** `GET .../documents/<id>`. */
  get(projectId, resource, documentId, options) {
    return this.http.request("GET", this.path(projectId, resource, documentId), memoryDocument, {
      query: { environment: options.environment },
      signal: options.signal
    });
  }
  /** `PUT .../documents/<id>` with `If-None-Match: *`; `412` when the id is already used. */
  create(projectId, resource, documentId, body2, options) {
    return this.http.request("PUT", this.path(projectId, resource, documentId), memoryDocument, {
      query: { environment: options.environment },
      headers: { "if-none-match": "*" },
      body: body2,
      signal: options.signal
    });
  }
  /** `PUT .../documents/<id>` with `If-Match`: replaces text, and summary when given. */
  replace(projectId, resource, documentId, body2, options) {
    return this.http.request("PUT", this.path(projectId, resource, documentId), memoryDocument, {
      query: { environment: options.environment },
      headers: { "if-match": quote(options.revision) },
      body: body2,
      signal: options.signal
    });
  }
  /** `PATCH .../documents/<id>` with `If-Match`: title or write policy. */
  patch(projectId, resource, documentId, body2, options) {
    return this.http.request("PATCH", this.path(projectId, resource, documentId), memoryDocument, {
      query: { environment: options.environment },
      headers: { "if-match": quote(options.revision) },
      body: body2,
      signal: options.signal
    });
  }
  /** `DELETE .../documents/<id>` with `If-Match`. The id stays reserved. */
  async delete(projectId, resource, documentId, options) {
    await this.http.request("DELETE", this.path(projectId, resource, documentId), none, {
      query: { environment: options.environment },
      headers: { "if-match": quote(options.revision) },
      signal: options.signal
    });
  }
};
var Memory = class {
  http;
  documents;
  constructor(http) {
    this.http = http;
    this.documents = new MemoryDocuments(http);
  }
  /** `GET /projects/<p>/memory`: the environment's resource inventory. */
  resources(projectId, options) {
    return this.http.request("GET", `/projects/${segment(projectId)}/memory`, memoryResourceInventory, {
      query: { environment: options.environment },
      signal: options.signal
    });
  }
};
var Webhooks = class {
  http;
  constructor(http) {
    this.http = http;
  }
  path(projectId, webhookId) {
    const base = `/projects/${segment(projectId)}/webhooks`;
    return webhookId === void 0 ? base : `${base}/${segment(webhookId)}`;
  }
  /** `GET /projects/<p>/webhooks`: URLs without tokens. */
  async list(projectId, query = {}, options = {}) {
    const page = await this.http.request("GET", this.path(projectId), webhooksPage, {
      query: { ...query },
      signal: options.signal
    });
    return page.webhooks;
  }
  /** `POST /projects/<p>/webhooks`: `token` and the full `invocationUrl` appear once. */
  async create(projectId, params, options = {}) {
    const answer = await this.http.request("POST", this.path(projectId), webhookEnvelope, {
      body: params,
      signal: options.signal
    });
    return answer.webhook;
  }
  /** `PATCH /projects/<p>/webhooks/<id>`. */
  async update(projectId, webhookId, params, options = {}) {
    const answer = await this.http.request("PATCH", this.path(projectId, webhookId), webhookEnvelope, {
      body: params,
      signal: options.signal
    });
    return answer.webhook;
  }
  /** `POST /projects/<p>/webhooks/<id>/rotate-token`: the webhook with its new token. */
  async rotateToken(projectId, webhookId, options = {}) {
    const answer = await this.http.request("POST", `${this.path(projectId, webhookId)}/rotate-token`, webhookEnvelope, { signal: options.signal });
    return answer.webhook;
  }
  /** `DELETE /projects/<p>/webhooks/<id>`. */
  async delete(projectId, webhookId, options = {}) {
    await this.http.request("DELETE", this.path(projectId, webhookId), none, { signal: options.signal });
  }
  /** `GET /projects/<p>/webhooks/<id>/requests`: the request ledger. */
  async requests(projectId, webhookId, options = {}) {
    const page = await this.http.request("GET", `${this.path(projectId, webhookId)}/requests`, webhookRequestsPage, { signal: options.signal });
    return page.requests;
  }
};
var EventSubscriptions = class {
  http;
  constructor(http) {
    this.http = http;
  }
  path(projectId, subscriptionId) {
    const base = `/projects/${segment(projectId)}/event-subscriptions`;
    return subscriptionId === void 0 ? base : `${base}/${segment(subscriptionId)}`;
  }
  /** `POST /projects/<p>/event-subscriptions`. */
  async create(projectId, params, options = {}) {
    const answer = await this.http.request("POST", this.path(projectId), eventSubscriptionEnvelope, {
      body: params,
      signal: options.signal
    });
    return answer.subscription;
  }
  /** `GET /projects/<p>/event-subscriptions`. */
  async list(projectId, options = {}) {
    const page = await this.http.request("GET", this.path(projectId), eventSubscriptionsPage, {
      signal: options.signal
    });
    return page.subscriptions;
  }
  /** `GET /projects/<p>/event-subscriptions/<id>`. */
  async get(projectId, subscriptionId, options = {}) {
    const answer = await this.http.request("GET", this.path(projectId, subscriptionId), eventSubscriptionEnvelope, { signal: options.signal });
    return answer.subscription;
  }
  /** `DELETE /projects/<p>/event-subscriptions/<id>`: pending deliveries stop. */
  async delete(projectId, subscriptionId, options = {}) {
    await this.http.request("DELETE", this.path(projectId, subscriptionId), none, { signal: options.signal });
  }
};
var GitHub = class {
  http;
  constructor(http) {
    this.http = http;
  }
  /**
   * `GET /projects/<p>/github/repositories?environment=`: the repositories
   * the environment's installation covers, read live from GitHub, at most
   * 100 per page. `404 github_connection_not_found` without an installation;
   * `502 github_unavailable` when GitHub fails.
   */
  repositories(projectId, query, options = {}) {
    return this.http.request("GET", `/projects/${segment(projectId)}/github/repositories`, repositoryPage, { query: { ...query }, signal: options.signal });
  }
};
var Projects = class {
  http;
  memory;
  webhooks;
  eventSubscriptions;
  github;
  constructor(http) {
    this.http = http;
    this.memory = new Memory(http);
    this.webhooks = new Webhooks(http);
    this.eventSubscriptions = new EventSubscriptions(http);
    this.github = new GitHub(http);
  }
  /** `GET /projects`. */
  async list(options = {}) {
    const page = await this.http.request("GET", "/projects", projectsPage, { signal: options.signal });
    return page.projects;
  }
  /** `GET /projects/<p>`: the project with its deployments, sessions, connections, channels and schedules. */
  get(projectId, options = {}) {
    return this.http.request("GET", `/projects/${segment(projectId)}`, projectDetail, {
      signal: options.signal
    });
  }
  /** `POST /projects`. */
  create(params, options = {}) {
    return this.http.request("POST", "/projects", project, { body: params, signal: options.signal });
  }
};
var Agents = class {
  http;
  constructor(http) {
    this.http = http;
  }
  /** `GET /agents`. */
  async list(options = {}) {
    const page = await this.http.request("GET", "/agents", agentsPage, { signal: options.signal });
    return page.agents;
  }
};
var Deployments = class {
  http;
  constructor(http) {
    this.http = http;
  }
  /** `GET /deployments/<id>`. */
  get(deploymentId, options = {}) {
    return this.http.request("GET", `/deployments/${segment(deploymentId)}`, deployment, {
      signal: options.signal
    });
  }
  /** `GET /deployments?agentId=`. */
  async list(query, options = {}) {
    const page = await this.http.request("GET", "/deployments", deploymentsPage, {
      query: { ...query },
      signal: options.signal
    });
    return page.deployments;
  }
};
var OpenComputer = class {
  sessions;
  projects;
  agents;
  deployments;
  constructor(options) {
    const http = new Http(options.apiKey, options);
    this.sessions = new Sessions(http);
    this.projects = new Projects(http);
    this.agents = new Agents(http);
    this.deployments = new Deployments(http);
  }
};
function quote(revision) {
  return revision.startsWith('"') ? revision : `"${revision}"`;
}

// scripts/oc-client.ts
function loadClientConfig(root = process.cwd()) {
  const binding = existsSync(join(root, ".opencomputer/project.json")) ? JSON.parse(readFileSync(join(root, ".opencomputer/project.json"), "utf8")) : {};
  let apiKey = process.env.OPENCOMPUTER_API_KEY ?? "";
  if (!apiKey && existsSync(join(homedir(), ".opencomputer/config.json"))) apiKey = JSON.parse(readFileSync(join(homedir(), ".opencomputer/config.json"), "utf8")).apiKey ?? "";
  const environment2 = process.env.FUNDING_ENVIRONMENT ?? "development";
  if (environment2 !== "development" && environment2 !== "production") throw new Error("FUNDING_ENVIRONMENT must be development or production");
  const projectId = process.env.OC_PROJECT_ID ?? binding.projectId;
  if (!apiKey) throw new Error("No OpenComputer API key: set OPENCOMPUTER_API_KEY or run `npx opencomputer login`");
  if (!projectId) throw new Error("No project: run `npx opencomputer link` or set OC_PROJECT_ID");
  return { apiKey, apiUrl: (process.env.OPENCOMPUTER_API_URL ?? binding.apiUrl ?? "https://app.opencomputer.dev").replace(/\/$/, ""), projectId, environment: environment2, agent: process.env.FUNDING_AGENT ?? binding.agentId ?? "funding", ownerSigningKey: process.env.OWNER_SIGNING_KEY ?? null };
}
var FundingClient = class {
  constructor(cfg) {
    this.cfg = cfg;
    this.oc = new OpenComputer({ apiKey: cfg.apiKey, baseUrl: `${cfg.apiUrl}/api/managed-agents` });
  }
  cfg;
  oc;
  /** Start a session for an authenticated owner. The owner never comes from request text. */
  async start(ownerId, op, labels2 = { owner: ownerId.slice(0, 60) }) {
    const key = `funding/${ownerId}/${randomUUID()}`;
    const { session: session2 } = await this.oc.sessions.create(
      { agentId: `${this.cfg.agent}@${this.cfg.environment}`, labels: { ...labels2, op: op.op } },
      { idempotencyKey: key }
    );
    const ownerToken = this.cfg.ownerSigningKey ? signOwner(ownerId, session2.id, this.cfg.ownerSigningKey) : DEV_TOKEN;
    const text = op.op === "check" ? `check ${op.url}` : op.op;
    const context = op.op === "check" || op.op === "resolve" ? await this.priorContext(ownerId, op.url) : {};
    await this.oc.sessions.turns.send(session2.id, { input: text, idempotencyKey: `${key}/start`, payload: { ...op, ...context, owner_token: ownerToken } });
    return session2.id;
  }
  /** Owner-scoped prior decisions and last check time, read here (trusted, read-only) and passed in the payload. */
  async priorContext(ownerId, url) {
    const cid = companyId(canonicalDomain(normalizeInputUrl(url)));
    const decisions = await this.query("SELECT cik, status FROM entity_candidates WHERE owner_id = ? AND company_id = ? AND status IN ('user_confirmed','user_rejected')", [ownerId, cid]);
    const [prev] = await this.query("SELECT checked_at FROM lookup_runs WHERE owner_id = ? AND company_id = ? ORDER BY checked_at DESC LIMIT 1", [ownerId, cid]);
    return {
      confirmed_ciks: decisions.filter((d) => d.status === "user_confirmed").map((d) => String(d.cik)),
      rejected_ciks: decisions.filter((d) => d.status === "user_rejected").map((d) => String(d.cik)),
      ...prev ? { previous_checked_at: String(prev.checked_at) } : {}
    };
  }
  /** Read the session; ownership is checked against the label this server wrote. */
  async read(sessionId, match) {
    const s = await this.oc.sessions.get(sessionId);
    const want = typeof match === "string" ? { owner: match.slice(0, 60) } : match;
    if (!Object.entries(want).every(([k, v]) => s.labels?.[k] === v)) throw Object.assign(new Error("not found"), { status: 404 });
    const events = [];
    let after = 0;
    for (; ; ) {
      const page = await this.oc.sessions.events.list(sessionId, { after });
      events.push(...page);
      if (page.length < 500) break;
      after = page.at(-1).seq;
    }
    const lastTurn = s.turns?.at(-1);
    const settled = lastTurn && ["completed", "failed", "cancelled"].includes(lastTurn.status);
    const outputs = (tool) => events.filter((e) => e.type === "tool.completed" && e.data?.tool === tool).map((e) => e.data.output);
    const failures = events.filter((e) => e.type === "turn.failed" || e.type === "tool.failed" || e.type === "session.failed").map((e) => ({ type: e.type, ...e.data }));
    const parse = (v) => {
      try {
        return typeof v === "string" ? JSON.parse(v) : v;
      } catch {
        return null;
      }
    };
    const details = outputs("funding_lookup").map(parse).at(-1) ?? null;
    const finalMessage = events.filter((e) => e.type === "message.completed").at(-1)?.data?.text ?? null;
    return {
      sessionId,
      status: s.status,
      turnStatus: lastTurn?.status ?? null,
      settled: !!settled,
      result: s.result?.data ?? null,
      readableReport: details?.readable_report ?? null,
      finalMessage,
      failures,
      codeRuns: outputs("execute").map(parse)
    };
  }
  async wait(sessionId, ownerId, timeoutMs = 3e5, onTick) {
    const end = Date.now() + timeoutMs;
    for (; ; ) {
      const r = await this.read(sessionId, ownerId);
      if (r.settled) return r;
      onTick?.(r.status);
      if (Date.now() > end) return r;
      await new Promise((res) => setTimeout(res, 3e3));
    }
  }
  /**
   * If a settled lookup's writes cannot be verified, send one recovery turn (at most
   * two per session) asking the agent to re-run its persist_code. Idempotent per turn count.
   */
  async ensurePersisted(sessionId, ownerId, result) {
    const p = await this.verifyPersistence(ownerId, result).catch((e) => ({ status: "verification_failed", detail: String(e.message) }));
    if (p.status === "verified" || p.status === "not_applicable") return { persistence: p, retrying: false };
    const s = await this.oc.sessions.get(sessionId);
    const turns = s.turns?.length ?? 0;
    if (turns >= 3) return { persistence: p, retrying: false };
    await this.oc.sessions.turns.send(sessionId, { input: "persist-retry", idempotencyKey: `${sessionId}/persist-retry/${turns}`, payload: { op: "persist-retry" } });
    return { persistence: p, retrying: true };
  }
  /** Read-only, owner-scoped SQL through the management API. */
  async query(sql, parameters) {
    const res = await fetch(`${this.cfg.apiUrl}/api/managed-agents/projects/${encodeURIComponent(this.cfg.projectId)}/database/query`, {
      method: "POST",
      headers: { "x-api-key": this.cfg.apiKey, "content-type": "application/json", "user-agent": "company-funding-app/1.0" },
      body: JSON.stringify({ environment: this.cfg.environment, sql, parameters }),
      redirect: "error"
    });
    const body2 = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`database query failed: HTTP ${res.status} ${JSON.stringify(body2).slice(0, 200)}`);
    const r = body2.result ?? body2;
    const cols = r.columns ?? [];
    return (r.rows ?? []).map((row) => Array.isArray(row) ? Object.fromEntries(cols.map((c, i) => [c, row[i]])) : row);
  }
  /** Independent check that the model wrote what the tools planned. */
  async verifyPersistence(ownerId, result) {
    if (!result?.lookup_id) return { status: "not_applicable" };
    const q = verificationQuery(ownerId, result.lookup_id);
    const rows = await this.query(q.sql, q.parameters);
    if (!rows.length) return { status: "missing", detail: "no lookup_runs row for this owner and lookup" };
    const row = rows[0];
    const storedHash = typeof row.report_json === "string" ? sha256(row.report_json) : null;
    const ok = storedHash === result.report_sha256 && row.report_sha256 === result.report_sha256;
    const { report_json: _omit, ...summary } = row;
    return { status: ok ? "verified" : "hash_mismatch", row: { ...summary, stored_hash: storedHash } };
  }
};

// web/app.ts
var env = process.env;
var MODE = env.APP_MODE ?? (env.APP_DEV_USER ? "dev" : "users");
var SECRET = env.APP_SESSION_SECRET ?? "";
var USERS = new Map((env.APP_USERS ?? "").split(",").filter(Boolean).map((p) => p.split(":")));
var MAX_ACTIVE = Number(env.MAX_ACTIVE_LOOKUPS ?? 2);
var PUBLIC_TRIES = Number(env.PUBLIC_TRIES ?? 1);
var PUBLIC_DAILY_CAP = Number(env.PUBLIC_DAILY_CAP ?? 40);
var TEMPLATE_URL = env.TEMPLATE_URL ?? "";
var SECURE_COOKIE = env.VERCEL === "1" || env.COOKIE_SECURE === "1";
var client = null;
function config() {
  if (!client) {
    if (MODE === "dev" && env.APP_DEV_USER !== DEV_OWNER) throw new Error(`APP_DEV_USER must be "${DEV_OWNER}"`);
    if (MODE !== "dev" && SECRET.length < 32) throw new Error("APP_SESSION_SECRET (32+ chars) is required");
    if (MODE === "users" && USERS.size === 0) throw new Error("APP_USERS is required in users mode");
    client = new FundingClient(loadClientConfig());
    if (MODE !== "dev" && !client.cfg.ownerSigningKey) throw new Error("OWNER_SIGNING_KEY is required (same value as the agent runtime variable)");
  }
  return { client, mode: MODE };
}
var sign = (v) => createHmac2("sha256", SECRET).update(v).digest("base64url");
var safeEq = (a, b) => Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual2(Buffer.from(a), Buffer.from(b));
var cookie = (req, name) => (req.headers.cookie ?? "").split(/;\s*/).map((c) => [c.slice(0, c.indexOf("=")), c.slice(c.indexOf("=") + 1)]).find(([k]) => k === name)?.[1];
function setCookie(res, name, value, maxAge) {
  const prev = res.getHeader("set-cookie");
  const next = `${name}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${SECURE_COOKIE ? "; Secure" : ""}`;
  res.setHeader("set-cookie", prev ? [].concat(prev, next) : next);
}
function clientIp(req) {
  const fwd = String(req.headers["x-real-ip"] ?? req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
  return fwd || req.socket.remoteAddress || "unknown";
}
function identify(req, res) {
  if (MODE === "dev") return { owner: env.APP_DEV_USER };
  if (MODE === "users") {
    const c2 = cookie(req, "fl_session");
    if (!c2) return null;
    const [user, exp, sig] = decodeURIComponent(c2).split("|");
    if (!user || !exp || !sig || Number(exp) < Date.now() || !USERS.has(user) || !safeEq(sig, sign(`${user}|${exp}`))) return null;
    return { owner: user };
  }
  let visitor = null;
  const c = cookie(req, "fl_visitor");
  if (c) {
    const [id, sig] = decodeURIComponent(c).split(".");
    if (id && sig && /^[a-f0-9]{16}$/.test(id) && safeEq(sig, sign(`visitor:${id}`))) visitor = id;
  }
  if (!visitor) {
    visitor = randomBytes2(8).toString("hex");
    setCookie(res, "fl_visitor", `${visitor}.${sign(`visitor:${visitor}`)}`, 365 * 86400);
  }
  const ipHash = createHash2("sha256").update(`${SECRET}|ip|${clientIp(req)}`).digest("hex").slice(0, 16);
  return { owner: `visitor_${visitor}`, visitor, ipHash };
}
async function publicUsage(id) {
  const { client: client2 } = config();
  const byVisitor = await client2.oc.sessions.list({ labels: { app: "public-try", visitor: id.visitor }, limit: 10 });
  const byIp = await client2.oc.sessions.list({ labels: { app: "public-try", ip: id.ipHash }, limit: 10 });
  const counts = (rows) => rows.filter((s) => s.result || s.activity?.activeTurnId || s.activity?.queued > 0 || !s.activity?.lastSettledTurn).length;
  const used = Math.max(counts(byVisitor.sessions), counts(byIp.sessions), byVisitor.sessions.length >= 3 || byIp.sessions.length >= 3 ? PUBLIC_TRIES : 0);
  return { used, remaining: Math.max(0, PUBLIC_TRIES - used), lastSessionId: byVisitor.sessions[0]?.id ?? null };
}
async function recentSessions(labels2, since, max) {
  const { client: client2 } = config();
  const out = [];
  for await (const s of client2.oc.sessions.iterate({ labels: labels2, limit: 100 })) {
    if (Date.parse(s.createdAt) < since || out.length >= max) break;
    out.push(s);
  }
  return out;
}
async function admit(publicMode) {
  const recent = await recentSessions({ app: publicMode ? "public-try" : "funding-app" }, Date.now() - 10 * 6e4, 100);
  const active = recent.filter((s) => s.activity?.activeTurnId || s.activity?.queued > 0 || s.activity?.lastSettledTurn == null).length;
  if (active >= MAX_ACTIVE) throw Object.assign(new Error(`${active} lookups are running right now; try again in a minute`), { status: 429 });
  if (publicMode) {
    const today = await recentSessions({ app: "public-try" }, Date.parse((/* @__PURE__ */ new Date()).toISOString().slice(0, 10) + "T00:00:00Z"), PUBLIC_DAILY_CAP);
    if (today.length >= PUBLIC_DAILY_CAP) throw Object.assign(new Error("Today's free lookups are used up. Deploy your own copy to keep going."), { status: 429, template: true });
  }
}
async function body(req) {
  if (req.body !== void 0) return typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body;
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1e4) throw Object.assign(new Error("body too large"), { status: 413 });
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw Object.assign(new Error("invalid JSON"), { status: 400 });
  }
}
function send(res, status, data) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.end(JSON.stringify(data));
}
function validUrl(u) {
  try {
    return normalizeInputUrl(String(u ?? "")).toString();
  } catch (e) {
    throw Object.assign(new Error(e instanceof UnsafeUrlError ? e.message : "invalid URL"), { status: 400 });
  }
}
async function handle(req, res) {
  try {
    const { client: client2, mode } = config();
    const url = new URL(req.url ?? "/", "http://local");
    const path = url.pathname;
    if (req.method === "POST" && req.headers["content-type"]?.includes("application/json") !== true) return send(res, 415, { error: "JSON required" });
    if (req.method === "POST" && path === "/api/login") {
      if (mode !== "users") return send(res, 400, { error: "login not used in this mode" });
      const { user, passphrase } = await body(req);
      const expected = USERS.get(String(user));
      if (!expected || !safeEq(expected, String(passphrase ?? ""))) return send(res, 401, { error: "invalid credentials" });
      const exp = Date.now() + 12 * 36e5;
      setCookie(res, "fl_session", `${user}|${exp}|${sign(`${user}|${exp}`)}`, 43200);
      return send(res, 200, { user });
    }
    const id = identify(req, res);
    if (path === "/api/me") {
      const usage = id && mode === "public-try" ? await publicUsage(id) : null;
      return send(res, 200, { mode, user: id && mode !== "public-try" ? id.owner : null, environment: client2.cfg.environment, templateUrl: TEMPLATE_URL || null, tries: usage ? { limit: PUBLIC_TRIES, used: usage.used, remaining: usage.remaining, lastSessionId: usage.lastSessionId } : null });
    }
    if (!id) return send(res, 401, { error: "sign in first" });
    const publicMode = mode === "public-try";
    const labels2 = publicMode ? { app: "public-try", visitor: id.visitor, ip: id.ipHash } : { app: "funding-app", owner: id.owner.slice(0, 60) };
    const startOp = async (op) => {
      if (publicMode) {
        const usage = await publicUsage(id);
        if (usage.remaining <= 0) return send(res, 402, { error: "You've used your free lookup. Deploy your own copy to run more.", template: TEMPLATE_URL || null });
      }
      await admit(publicMode);
      const sessionId = await client2.start(id.owner, op, labels2);
      return send(res, 202, { sessionId });
    };
    if (req.method === "POST" && path === "/api/check") return await startOp({ op: "check", url: validUrl((await body(req)).url) });
    if (publicMode && (path.startsWith("/api/resolve") || path.startsWith("/api/watches"))) {
      return send(res, 403, { error: "Confirming candidates and daily watches are available in your own deployment.", template: TEMPLATE_URL || null });
    }
    if (req.method === "POST" && path === "/api/resolve") {
      const b = await body(req);
      if (!/^\d{1,10}$/.test(String(b.cik)) || !["confirm", "reject"].includes(b.decision)) return send(res, 400, { error: "cik and decision required" });
      return await startOp({ op: "resolve", url: validUrl(b.url), cik: String(b.cik), decision: b.decision });
    }
    if (req.method === "GET" && path.startsWith("/api/sessions/")) {
      const sid = path.split("/")[3];
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(sid)) return send(res, 400, { error: "bad id" });
      const r = await client2.read(sid, publicMode ? { visitor: id.visitor } : { owner: id.owner.slice(0, 60) });
      const first = r.result;
      if (r.settled && first) {
        const e = await client2.ensurePersisted(sid, id.owner, first);
        return send(res, 200, { ...r, settled: !e.retrying, status: e.retrying ? "saving" : r.status, persistence: e.persistence });
      }
      return send(res, 200, { ...r, persistence: null });
    }
    if (req.method === "GET" && path.startsWith("/api/lookups/")) {
      const lid = path.split("/")[3];
      if (!/^lk_[a-f0-9]{1,40}$/.test(lid)) return send(res, 400, { error: "bad id" });
      const [run] = await client2.query("SELECT id, status, checked_at, submitted_url, canonical_url, company_id, report_sha256 FROM lookup_runs WHERE owner_id = ? AND id = ?", [id.owner, lid]);
      if (!run) return send(res, 404, { error: "not found" });
      const evidence = await client2.query("SELECT kind, url, excerpt, source_date, retrieved_at, claims_json FROM evidence WHERE owner_id = ? AND lookup_id = ? ORDER BY kind LIMIT 100", [id.owner, lid]);
      const filings = await client2.query("SELECT accession, form, filing_date, attribution, issuer_name, sold_amount_raw, offering_amount_raw, first_sale_status, first_sale_date, source_url FROM filings WHERE owner_id = ? AND company_id = ? ORDER BY filing_date DESC LIMIT 50", [id.owner, run.company_id]);
      return send(res, 200, { run, evidence, filings });
    }
    if (req.method === "GET" && path === "/api/watches") {
      return send(res, 200, { watches: await client2.query("SELECT id, company_url, enabled, cadence, notifications_enabled, last_run_at FROM watches WHERE owner_id = ? ORDER BY created_at DESC LIMIT 100", [id.owner]) });
    }
    if (req.method === "POST" && path === "/api/watches") {
      const b = await body(req);
      if (b.optIn !== true) return send(res, 400, { error: "explicit opt-in required" });
      return await startOp({ op: "watch", url: validUrl(b.url) });
    }
    if (req.method === "POST" && /^\/api\/watches\/w:[a-f0-9]{16}\/disable$/.test(path)) return await startOp({ op: "disable-watch", watch_id: path.split("/")[3] });
    if (req.method === "GET" && path === "/api/company") {
      const cid = companyId(canonicalDomain(normalizeInputUrl(validUrl(url.searchParams.get("url")))));
      return send(res, 200, { candidates: await client2.query("SELECT cik, name, status, confidence, reasons_json FROM entity_candidates WHERE owner_id = ? AND company_id = ? LIMIT 20", [id.owner, cid]) });
    }
    send(res, 404, { error: "not found" });
  } catch (e) {
    const status = e?.status && Number.isInteger(e.status) ? e.status : 500;
    if (status === 500) console.error(e);
    send(res, status, { error: status === 500 ? "internal error" : String(e.message), ...e?.template ? { template: TEMPLATE_URL || null } : {} });
  }
}

// web/vercel-entry.ts
function handler(req, res) {
  return handle(req, res);
}
export {
  handler as default
};
