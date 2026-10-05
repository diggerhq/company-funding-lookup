-- Company funding lookup schema. Every row carries owner_id; every query filters on it.
-- Amounts are stored as filed text plus integer-dollar decimal strings (never REAL).

CREATE TABLE companies (
  owner_id TEXT NOT NULL,
  id TEXT NOT NULL,
  canonical_domain TEXT NOT NULL,
  submitted_url TEXT NOT NULL,
  canonical_url TEXT,
  display_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, id)
);
CREATE UNIQUE INDEX companies_owner_domain ON companies (owner_id, canonical_domain);

CREATE TABLE lookup_runs (
  owner_id TEXT NOT NULL,
  id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  submitted_url TEXT NOT NULL,
  canonical_url TEXT,
  status TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  trigger TEXT NOT NULL DEFAULT 'check',
  report_json TEXT NOT NULL,
  report_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, id)
);
CREATE INDEX lookup_runs_owner_company ON lookup_runs (owner_id, company_id, checked_at);

CREATE TABLE entity_candidates (
  owner_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  cik TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('verified','review','rejected','user_confirmed','user_rejected')),
  confidence TEXT NOT NULL,
  score INTEGER NOT NULL,
  reasons_json TEXT NOT NULL,
  conflicts_json TEXT NOT NULL,
  evidence_urls_json TEXT NOT NULL,
  last_lookup_id TEXT NOT NULL,
  decided_by_user_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, company_id, cik)
);

CREATE TABLE offerings (
  owner_id TEXT NOT NULL,
  id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  cik TEXT NOT NULL,
  root_accession TEXT NOT NULL,
  latest_accession TEXT NOT NULL,
  accessions_json TEXT NOT NULL,
  link_status TEXT NOT NULL,
  category TEXT NOT NULL,
  first_sale_status TEXT NOT NULL,
  first_sale_date TEXT,
  first_filing_date TEXT,
  latest_filing_date TEXT,
  offering_amount_kind TEXT NOT NULL,
  offering_amount_raw TEXT,
  offering_amount_usd TEXT,
  sold_amount_kind TEXT NOT NULL,
  sold_amount_raw TEXT,
  sold_amount_usd TEXT,
  remaining_amount_kind TEXT NOT NULL,
  remaining_amount_raw TEXT,
  investor_count INTEGER,
  is_notice_only INTEGER NOT NULL,
  changes_json TEXT NOT NULL,
  last_lookup_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, id)
);

CREATE TABLE filings (
  owner_id TEXT NOT NULL,
  accession TEXT NOT NULL,
  company_id TEXT NOT NULL,
  cik TEXT NOT NULL,
  issuer_name TEXT NOT NULL,
  form TEXT NOT NULL,
  filing_date TEXT,
  attribution TEXT NOT NULL CHECK (attribution IN ('verified','unverified_candidate')),
  source_url TEXT NOT NULL,
  index_url TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  is_amendment INTEGER NOT NULL,
  previous_accession TEXT,
  first_sale_status TEXT NOT NULL,
  first_sale_date TEXT,
  category TEXT NOT NULL,
  securities_json TEXT NOT NULL,
  exemptions_json TEXT NOT NULL,
  offering_amount_raw TEXT,
  offering_amount_kind TEXT NOT NULL,
  sold_amount_raw TEXT,
  sold_amount_kind TEXT NOT NULL,
  remaining_amount_raw TEXT,
  remaining_amount_kind TEXT NOT NULL,
  investor_count_raw TEXT,
  related_persons_json TEXT NOT NULL,
  jurisdiction TEXT,
  last_lookup_id TEXT NOT NULL,
  PRIMARY KEY (owner_id, accession)
);
CREATE INDEX filings_owner_company ON filings (owner_id, company_id, filing_date);

CREATE TABLE evidence (
  owner_id TEXT NOT NULL,
  id TEXT NOT NULL,
  lookup_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('entity_source','filed_fact','company_announcement','investor_announcement','reporting','aggregator','inference')),
  url TEXT NOT NULL,
  excerpt TEXT NOT NULL,
  source_date TEXT,
  retrieved_at TEXT NOT NULL,
  claims_json TEXT NOT NULL,
  PRIMARY KEY (owner_id, lookup_id, id)
);

CREATE TABLE watches (
  owner_id TEXT NOT NULL,
  id TEXT NOT NULL,
  company_url TEXT NOT NULL,
  canonical_domain TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  cadence TEXT NOT NULL DEFAULT 'daily' CHECK (cadence IN ('daily')),
  notifications_enabled INTEGER NOT NULL DEFAULT 0,
  destination TEXT,
  baseline_lookup_id TEXT,
  last_run_at TEXT,
  last_lookup_id TEXT,
  created_at TEXT NOT NULL,
  disabled_at TEXT,
  PRIMARY KEY (owner_id, id)
);
CREATE UNIQUE INDEX watches_owner_domain ON watches (owner_id, canonical_domain);

-- Stable finding events derived from lookups. event_key is deterministic
-- (e.g. filing accession or announcement URL hash), so re-runs converge.
CREATE TABLE watch_events (
  owner_id TEXT NOT NULL,
  id TEXT NOT NULL,
  watch_id TEXT NOT NULL,
  event_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  is_baseline INTEGER NOT NULL,
  lookup_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, id)
);
CREATE UNIQUE INDEX watch_events_key ON watch_events (owner_id, watch_id, event_key);

-- Outbox: one row per (event, destination). Rows stay 'held' while notifications
-- are disabled or no destination is approved. 'delivered' is only set from a receipt.
CREATE TABLE outbox (
  owner_id TEXT NOT NULL,
  id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  destination TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('held','pending','delivered','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, id)
);
CREATE UNIQUE INDEX outbox_event_destination ON outbox (owner_id, event_id, destination);

CREATE TABLE delivery_receipts (
  owner_id TEXT NOT NULL,
  outbox_id TEXT NOT NULL,
  provider_message_id TEXT NOT NULL,
  delivered_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, outbox_id)
);
