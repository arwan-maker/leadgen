-- LeadGEN phase 1 schema. Safe to run more than once.
CREATE TABLE IF NOT EXISTS leads (
  id            BIGSERIAL PRIMARY KEY,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  source        TEXT NOT NULL DEFAULT 'website',   -- 'website' | 'google_ads'
  external_id   TEXT,                              -- Google lead_id, used to drop duplicate deliveries
  name          TEXT,
  email         TEXT,
  phone         TEXT,
  intent        TEXT CHECK (intent IN ('buy', 'rent', 'sell')),
  location      TEXT,
  budget        TEXT,
  message       TEXT,
  search_query  TEXT,
  listing_id    TEXT,
  page_url      TEXT,
  consent       BOOLEAN NOT NULL DEFAULT false,
  is_test       BOOLEAN NOT NULL DEFAULT false,
  status        TEXT NOT NULL DEFAULT 'new',
  raw           JSONB,
  CHECK (email IS NOT NULL OR phone IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS leads_source_external_id ON leads (source, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS leads_created_at ON leads (created_at DESC);

-- ---------------------------------------------------------------------------
-- Phase 2 to 4 tables. Shared contract for all modules; change only with care.
-- ---------------------------------------------------------------------------

ALTER TABLE leads ADD COLUMN IF NOT EXISTS area TEXT;                 -- 'GTA' | 'Waterloo' | 'Cambridge' (lib/areas.js)
ALTER TABLE leads ADD COLUMN IF NOT EXISTS assigned_seller_id BIGINT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
-- leads.status values: new | contacted | qualified | closed | lost
-- CASL: 'express' (pop-up checkbox) or 'implied_inquiry' (Google lead form, valid 6 months from the inquiry).
ALTER TABLE leads ADD COLUMN IF NOT EXISTS consent_type TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS consent_expires_at TIMESTAMPTZ;   -- null = no expiry (express)
ALTER TABLE leads ADD COLUMN IF NOT EXISTS property_type TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS bedrooms TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS gcl_id TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS campaign_id TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS form_id TEXT;

-- Realtors/agents who receive leads.
CREATE TABLE IF NOT EXISTS sellers (
  id          BIGSERIAL PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  name        TEXT NOT NULL,
  email       TEXT,
  phone       TEXT,                                   -- E.164, e.g. +14165550100
  areas       TEXT[] NOT NULL DEFAULT '{}',           -- subset of lib/areas.js AREAS; empty = all areas
  notify_email BOOLEAN NOT NULL DEFAULT true,
  notify_sms   BOOLEAN NOT NULL DEFAULT true,
  active      BOOLEAN NOT NULL DEFAULT true
);

-- Listings pulled from feeds (CREA DDF now, PropTx later).
CREATE TABLE IF NOT EXISTS listings (
  id               BIGSERIAL PRIMARY KEY,
  source           TEXT NOT NULL,                     -- 'crea_ddf' | 'proptx'
  source_key       TEXT NOT NULL,                     -- the feed's ListingKey
  mls_number       TEXT,
  status           TEXT NOT NULL DEFAULT 'active',    -- 'active' | 'inactive'
  transaction_type TEXT,                              -- 'sale' | 'lease'
  property_type    TEXT,                              -- e.g. 'House', 'Condo', 'Townhouse', 'Land', 'Commercial'
  address          TEXT,
  city             TEXT,
  area             TEXT,                              -- 'GTA' | 'Waterloo' | 'Cambridge'
  postal_code      TEXT,
  latitude         DOUBLE PRECISION,
  longitude        DOUBLE PRECISION,
  price            NUMERIC(14, 2),                    -- sale price, or monthly rent for leases
  bedrooms         INTEGER,
  bathrooms        INTEGER,
  sqft             INTEGER,
  description      TEXT,
  photo_urls       JSONB NOT NULL DEFAULT '[]',
  listing_url      TEXT,                              -- e.g. the REALTOR.ca page (DDF display rules)
  office_name      TEXT,
  agent_name       TEXT,
  modified_at      TIMESTAMPTZ,                       -- feed's ModificationTimestamp
  last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw              JSONB,
  UNIQUE (source, source_key)
);
CREATE INDEX IF NOT EXISTS listings_search ON listings (status, area, transaction_type, price);
CREATE INDEX IF NOT EXISTS listings_city ON listings (lower(city));

CREATE TABLE IF NOT EXISTS sync_runs (
  id           BIGSERIAL PRIMARY KEY,
  source       TEXT NOT NULL,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ,
  fetched      INTEGER NOT NULL DEFAULT 0,
  upserted     INTEGER NOT NULL DEFAULT 0,
  deactivated  INTEGER NOT NULL DEFAULT 0,
  error        TEXT
);

-- A lead paired with a listing it fits.
CREATE TABLE IF NOT EXISTS matches (
  id          BIGSERIAL PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  lead_id     BIGINT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  listing_id  BIGINT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  score       NUMERIC(5, 2) NOT NULL,                 -- 0 to 100
  UNIQUE (lead_id, listing_id)
);

-- Every email/SMS sent (or skipped) about a lead.
CREATE TABLE IF NOT EXISTS notifications (
  id          BIGSERIAL PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  lead_id     BIGINT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  seller_id   BIGINT REFERENCES sellers(id) ON DELETE SET NULL,
  channel     TEXT NOT NULL,                          -- 'email' | 'sms'
  status      TEXT NOT NULL,                          -- 'sent' | 'failed' | 'skipped'
  error       TEXT
);

-- Fixed-window rate limiting for public endpoints.
CREATE TABLE IF NOT EXISTS rate_limits (
  key          TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);

CREATE INDEX IF NOT EXISTS notifications_lead ON notifications (lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS matches_lead ON matches (lead_id);
