# Company funding lookup

Give it a company URL. It resolves the legal issuer(s) and reports the **last known financing in checked public sources**: SEC Form D / D/A filings (including filings with no matching announcement) cross-checked against company announcements and, optionally, third-party news. This is public-source research. It does not access confidential funding data and cannot prove that a round is unannounced or that no later private transaction exists.

Built on OpenComputer Serverless Agents (`@opencomputer/agent` 0.8, CLI 0.7). There is no persistent VM or daemon.

```
check https://company.example        -> readable report + typed JSON (session result)
inspect <lookup-id>                  -> stored evidence for one lookup
resolve <url> <cik> confirm|reject   -> owner decision on an entity candidate, then re-check
watch <url> | list-watches | disable-watch <id>   -> optional daily watches (explicit opt-in)
```

## Try it / deploy your own

- **Hosted demo:** https://company-funding-lookup.vercel.app. No sign-in; one free lookup per visitor.
- **Deploy your own** (unlimited lookups, confirm entity candidates, daily watches, your own database): [one-click OpenComputer template](https://app.opencomputer.dev/new?repository-url=https%3A%2F%2Fgithub.com%2Fdiggerhq%2Fcompany-funding-lookup). The only required setting is `SEC_CONTACT_EMAIL`, the contact address SEC requires in every EDGAR request's User-Agent. A deployment without `OWNER_SIGNING_KEY` is single-owner: the dashboard playground and `npm run check` act as that owner.

### Hosted demo mode (`APP_MODE=public-try`)

`web/app.ts` serves three modes: `public-try` (hosted demo), `users` (passphrase logins) and `dev` (local single user). In `public-try`:
- Each visitor gets `PUBLIC_TRIES` lookups (default 1), keyed by a signed visitor cookie **and** a salted IP hash. The ledger is the session labels this server writes (`app`, `visitor`, `ip`), so no extra store is needed.
- Only lookups that produced a result or are still running count, so a failed run doesn't use up a visitor's try. At most 3 sessions are ever started per visitor or IP.
- `PUBLIC_DAILY_CAP` (default 40) caps total demo lookups per UTC day. `MAX_ACTIVE_LOOKUPS` (default 2) caps concurrency, which keeps aggregate SEC traffic within 2 req/s.
- Visitors can only read their own session and evidence. Resolve and watches return a "deploy your own" response.

Vercel: `npm run bundle:vercel` bundles `web/vercel-entry.ts` to `api/index.js`. Vercel's per-file TS compile can't resolve this repo's extensionless ESM imports, so the bundle is committed. The page is `public/index.html`. Env vars:
- `APP_MODE=public-try`, `APP_SESSION_SECRET`
- `OPENCOMPUTER_API_KEY`, `OC_PROJECT_ID`
- `FUNDING_ENVIRONMENT=production`, `FUNDING_AGENT=company-funding`
- `OWNER_SIGNING_KEY` (same value as the Production runtime variable)
- `TEMPLATE_URL`

## Layout

```
opencomputer/
  project.ts
  database/migrations/001_initial.sql      durable project SQL schema (Development/Production are separate)
  agents/funding/
    agent.ts                               render: parses the request, selects tools, model = claude-haiku-4.5
    schedules/watch-dispatch.ts            shared daily dispatcher (production only, overlap: skip)
    tools/                                 funding_lookup, funding_report_result (result tool), funding_prepare,
                                           funding_inspect_evidence, funding_resolve_candidate, funding_watch,
                                           watch_dispatch_due / watch_dispatch_run (schedule sessions only)
    lib/                                   deterministic code: url-safety, sec-http, sec, formd, xml, entity,
                                           offerings, announcements, lookup, report, persist, scripts, owner,
                                           signing, watch, research-provider, context-dev
scripts/check.ts                           CLI wrapper (remote or --local)
scripts/oc-client.ts                       trusted server-side client (sessions, owner tokens, verification)
web/server.ts, web/index.html              web app: enter a URL, see the result, review candidates, evidence, watches
test/                                      node:test suites with synthetic fixtures (no real companies)
examples/dry-run-report.md                 generic example report (synthetic company)
```

## How a check works

1. **URL safety** (`lib/url-safety.ts`). Accepts http(s) on default ports only, with no credentials in the URL. Private, loopback, link-local, CGNAT, multicast, reserved and cloud-metadata addresses are blocked. This holds for IPv4, IPv6 and mapped forms, both before connecting and at connect time through a guarded DNS lookup, so DNS rebinding cannot slip past. At most 5 redirects are followed, each re-validated. The submitted URL, the canonical domain and the redirect chain are all kept. No cookies or auth headers are ever sent to user-supplied domains.
2. **Company pages.** The homepage plus up to 2 legal pages and 1 about page. Extraction uses only high-precision patterns: JSON-LD `legalName`/`founder`/`address`, copyright lines, `X, a Delaware corporation`, `X ("Company", "we")`, `operated by X`, and founder statements. Generic suffix matches in privacy policies (payment processors and the like) are ignored. Page text is untrusted data. Only short sanitized excerpts leave the extractor, so page instructions can't reach goals, owners, destinations, secrets or configuration (tested).
3. **SEC discovery** (`lib/sec.ts`):
   - EDGAR entity search (`efts.sec.gov/LATEST/search-index?keysTyped=`), with the official EDGAR company list (`cgi-bin/browse-edgar`) as fallback.
   - Form D full-text search (`q=…&forms=D,D%2FA`) over the recent 24 months first, expanding to all history (2001+) when the recent window is empty.
   - Founder full-text searches are recorded as clues only.
   - Live contract details found while building: `D/A` must be percent-encoded and entity-search spaces must be `+`. Otherwise EFTS returns HTTP 500.
4. **Entity resolution** (`lib/entity.ts`). Auto-accept requires a company-source signal (the legal name stated on the company's own site, or the SEC record listing the company's domain) plus an independent corroborator (jurisdiction, founder appearing as a filed related person, or address), and no conflicts. Name similarity alone never verifies. Funds/SPVs and jurisdiction mismatches are flagged. Several legal entities per brand are supported (parent and operating subsidiary). Everything else goes to a **review queue**. Candidate filings are shown as UNVERIFIED and never attributed.
5. **History.** For verified CIKs, `data.sec.gov/submissions/CIK##########.json`:
   - The parallel `filings.recent` arrays are zipped, with length checks.
   - Historical `filings.files` pages are read when there is no recent raise.
   - Each filing's `index.json` locates the original Form D XML, which is parsed deterministically (`lib/formd.ts`, `lib/xml.ts`).
   - Searched ranges and unread history are recorded.
6. **Filed facts** are kept as filed:
   - Amounts are decimal strings, never floats, with `absent` / `0` / `Indefinite` / unparseable kept distinct.
   - First sale is a date, "yet to occur" or absent.
   - Also kept: securities type and category (equity, debt, convertible/hybrid, pooled fund, other, unknown), exemptions, investor count, related persons with filed roles, and the source URL, sha256 and fetch time.
7. **Offerings** (`lib/offerings.ts`):
   - D/A filings link to their original only through the filed `previousAccessionNumber`. Unlinkable amendments are `uncertain_link` and need review.
   - Amendment deltas are shown and never summed.
   - A recent amendment to an old offering is never treated as the latest new raise.
   - "Yet to occur" means an offering notice, not a completed raise.
8. **Announcements** (`lib/announcements.ts`):
   - Sources: the company newsroom/blog, plus optional context.dev news and web search.
   - Matching needs the amount within 15% of the filed sold/offering amount AND a plausible publication date.
   - Contradictions are listed as conflicts, never blended.
   - Publication date is never treated as the closing date. Aggregator-reported stage is labelled as such.
9. **Selection.** The latest event goes by evidenced event date (first sale, filing date or publication date, with the date type shown). The latest SEC notice/update is shown separately when it is not a new financing. Competing candidates appear when ordering is uncertain.

Statuses: `financing_found`, `offering_only`, `nothing_found_in_completed_searches`, `entity_review_required`, `partial`, `failed`. A 403, 429, timeout, malformed response or exhausted budget is a **coverage gap**, never an empty result. "Nothing found" requires completed searches.

Wording rules enforced in code and instructions:
- "$X reported sold toward a $Y offering as of filing date"
- "No matching announcement found in checked sources as of TIME" when the check completed, and "announcement check incomplete" otherwise. Never "unannounced".
- No inferred Series, valuation, lead investor or investor roster.
- Related persons are not investors.

## Budgets

Defaults are set in `lib/config.ts` and can be overridden with runtime variables:

| Variable | Default | |
| - | - | - |
| `LOOKUP_SEC_MAX_REQUESTS` | 45 | SEC requests per lookup |
| `LOOKUP_WEB_MAX_REQUESTS` | 12 | company-site requests per lookup |
| `LOOKUP_RESEARCH_MAX_REQUESTS` | 4 | context.dev calls per lookup |
| `LOOKUP_DEADLINE_MS` | 110000 | wall-clock budget |
| `LOOKUP_MAX_CANDIDATES` / `LOOKUP_MAX_FILINGS` | 5 / 12 | |

Exhausted budgets return partial results with gaps. The model is `anthropic/claude-haiku-4.5`. It only sequences tools, passes generated code to `execute`, and writes a summary of at most 3 sentences. Retrieval, XML parsing, ordering, money comparisons, dedupe and SQL are all deterministic code.

## SEC access

The SEC asks for a descriptive User-Agent with a contact address. **`SEC_CONTACT_EMAIL` is required, and this project never invents one.** Without it, every SEC capability reports `unavailable`. No API key is needed.

Throttling sits in one module-level throttle per runtime process, at `SEC_REQUESTS_PER_SECOND` (default 1, hard cap 2). The web app admits at most `MAX_ACTIVE_LOOKUPS` = 2 concurrent lookups, so aggregate traffic from the app stays at or below 2 req/s, under the SEC's published limit.

> **Limitation:** OpenComputer tool calls can run in separate runtime processes and tools have no shared store, so the throttle cannot be global across sessions started outside the app (dashboard playground, raw API). Keep those manual and infrequent.

Other behaviour:
- Bounded retries with exponential backoff and jitter.
- `Retry-After` is honored. A wait of more than 30s stops SEC calls for the run.
- A 403 opens a 10-minute breaker. No proxy rotation.
- Responses are cached in memory for 10 minutes, and the cache age is disclosed in the report.

## context.dev (optional)

The `ResearchProvider` interface (`lib/research-provider.ts`) has two implementations: `ContextDevProvider` and `UnavailableProvider`. The endpoints used were verified against docs.context.dev on 2026-10-05:
- `POST /v1/brand/retrieve` (by_domain)
- `POST /v1/news/search` (entity by domain)
- `POST /v1/web/search`

The key is a **managed secret** behind a `defineConnection` (origin `https://api.context.dev`, prefix `/v1/`, POST only), so it never enters the runtime, prompts or logs. Provenance stays in our database. SEC discovery and page retrieval never depend on context.dev. When it is off, the report says "announcement check incomplete: third-party news/search unavailable".

```bash
printf %s "$CONTEXT_DEV_API_KEY" | npx opencomputer secrets set CONTEXT_DEV_API_KEY --value-stdin --environment development
printf 1 | npx opencomputer env set CONTEXT_DEV_ENABLED --value-stdin --environment development
```

## Persistence

The project SQL database is defined by versioned migrations in `opencomputer/database/migrations`. It holds companies, entity candidates, offerings, filings, evidence, lookup runs, watches, watch events, outbox and delivery receipts. Every row carries `owner_id`, and every statement binds it. Development and Production databases are separate.

**How writes happen.** Tool code has no database API in `@opencomputer/agent` 0.8. The database is reachable only through the runtime's Code Mode (`tools.database.execute/query` inside the built-in `execute` tool), and code-defined tools are not callable from Code Mode. So:

1. `funding_lookup` returns `persist_code`: deterministic, idempotent `INSERT … SELECT FROM json_each(…)` / UPSERT statements generated by `lib/persist.ts` + `lib/scripts.ts`.
2. The model passes `persist_code` to `execute` unchanged. It never writes SQL.
3. `funding_lookup` also returns the compact typed result, HMAC-signed with `OWNER_SIGNING_KEY`. The result tool `funding_report_result` commits it only if the signature verifies.
4. The trusted client (CLI or web app) then independently reads `lookup_runs.report_json` through the read-only management query API and recomputes its sha256. The status is `verified` only if that matches the signed result's `report_sha256`. A copy error shows up as `hash_mismatch` and is reported, never hidden.

Local JSON is used only for test fixtures.

## Identity and tenancy

The owner comes from the authenticated application, never from message text. The app signs `owner_id:session_id` with `OWNER_SIGNING_KEY`, a runtime variable shared with the agent, and every tool verifies the token against its own session. That means the model can't forge an owner, and a token can't be replayed into another session.

The web app authenticates users with `APP_USERS` plus a signed HttpOnly cookie, or runs single-user locally with `APP_DEV_USER=local-dev`. It checks session ownership via the label it wrote, and all of its DB reads are owner-filtered. For development without an app, `DEV_SINGLE_USER=1` allows the fixed owner `local-dev`. **Never set it in production.**

## Watches (optional, off by default)

A lookup never subscribes anyone.
- `watch <url>` creates a per-owner row (`cadence = daily`, notifications disabled, no destination) only on explicit opt-in.
- The code-defined schedule `watch-dispatch` runs daily at 14:00 UTC in **production only** with `overlap: "skip"`. Development shows it as "Manual only". There is no runtime cron creation.
- The first run records a baseline (`is_baseline = 1`, no alerts). New findings get stable event ids and unique `(owner, watch, event_key)` keys, plus `outbox` rows with status `held` and destination `unapproved`.
- **Delivery is not implemented**, by design, until a destination is approved. Nothing is ever marked delivered without a receipt.
- Daily scans are not real-time detection.

## Setup

```bash
npm install
npx opencomputer login
npx opencomputer link --project <id|slug>      # or --create-project company-funding

# Required: SEC contact address (yours; used in the SEC User-Agent)
printf %s "you@yourdomain.example" | npx opencomputer env set SEC_CONTACT_EMAIL --value-stdin --environment development
# Owner-token signing key, shared with the web app / CLI
KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
printf %s "$KEY" | npx opencomputer env set OWNER_SIGNING_KEY --value-stdin --environment development
printf %s "$KEY" > .opencomputer/owner-signing-key.dev    # git-ignored
# Development only: allow the single local owner
printf 1 | npx opencomputer env set DEV_SINGLE_USER --value-stdin --environment development

npm run deploy -- --alias development
```

## Run

```bash
npm run typecheck && npm test
OWNER_SIGNING_KEY=$(cat .opencomputer/owner-signing-key.dev) npm run check -- https://company.example           # remote, Development
SEC_CONTACT_EMAIL=you@yourdomain.example npm run check -- https://company.example --local                         # in-process, no persistence
APP_DEV_USER=local-dev OWNER_SIGNING_KEY=$(cat .opencomputer/owner-signing-key.dev) npm run web                   # http://127.0.0.1:8787
npx tsx scripts/example-report.ts                                                                                  # regenerate examples/
```

For multi-user use: `APP_USERS="alice:…,bob:…" APP_SESSION_SECRET=<32+ chars> OWNER_SIGNING_KEY=… HOST=0.0.0.0 npm run web`, served behind TLS.

## Deployment and rollback

- `npm run deploy -- --alias development` builds an immutable deployment and applies pending migrations before activation. A failing migration blocks activation.
- Production: set the same runtime variables with `--environment production` (**without** `DEV_SINGLE_USER`), then `npm run deploy -- --alias production`. That also activates the daily watch schedule, so do it only on purpose.
- Rollback: redeploy the previous git commit to the alias. Existing sessions stay on their deployment. Migrations are additive and immutable: never edit an applied file, add `002_….sql` instead. Code rollback does not undo schema changes, so keep migrations backward compatible.

## Known limitations

- Writes are model-mediated (see Persistence). They are verified by hash, but a run can fail to persist, and when it does the run says so.
- The project database sometimes attaches to Code Mode late, or not at all, within a session. Observed in Production on 2026-10-05: about 13–20 s after session start in some sessions, never within one turn in others. The agent waits and retries through `funding_wait`. If the writes still can't be verified, the trusted client sends up to two `persist-retry` turns to the same session, and the agent re-runs its `persist_code` there.
- The SEC throttle is per runtime process. Global ≤2 req/s holds only for traffic admitted through the app.
- The per-session lookup cap is best-effort, because tool calls may land in different processes. The hard limits are the per-lookup budgets.
- Entity extraction is pattern-based. Sites that never state a legal name produce a review queue, not a guess.
- Form D coverage excludes non-US issuers, other exemptions (Reg CF and Reg A are not parsed) and late or missing filings.
