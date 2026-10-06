-- Run with a migration account on a dedicated Social Studio database.
CREATE TABLE IF NOT EXISTS rss_users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS rss_organizations (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS rss_memberships (
  user_id uuid NOT NULL REFERENCES rss_users(id),
  organization_id uuid NOT NULL REFERENCES rss_organizations(id),
  role text NOT NULL CHECK (role IN ('owner','editor','viewer')),
  PRIMARY KEY(user_id, organization_id)
);
CREATE INDEX IF NOT EXISTS rss_memberships_org_idx ON rss_memberships(organization_id);
CREATE TABLE IF NOT EXISTS rss_sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES rss_users(id),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rss_sessions_expiry_idx ON rss_sessions(expires_at);
CREATE TABLE IF NOT EXISTS rss_states (
  organization_id uuid PRIMARY KEY REFERENCES rss_organizations(id),
  version integer NOT NULL DEFAULT 0,
  data jsonb NOT NULL DEFAULT '{"content":[],"properties":[],"workflowStep":1}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
