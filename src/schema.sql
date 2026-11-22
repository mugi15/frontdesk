CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  email text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS holidays (
  holiday_date date PRIMARY KEY,
  label text NOT NULL
);

CREATE TABLE IF NOT EXISTS tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject text NOT NULL,
  customer_name text NOT NULL,
  customer_email text NOT NULL,
  priority text NOT NULL CHECK (priority IN ('urgent', 'medium', 'low')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'waiting_customer', 'resolved', 'closed')),
  assignee_id uuid REFERENCES agents(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  first_response_at timestamptz,
  first_response_due_at timestamptz NOT NULL,
  resolution_due_at timestamptz NOT NULL,
  first_response_breached boolean NOT NULL DEFAULT false,
  resolution_breached boolean NOT NULL DEFAULT false,
  first_reply_wait_minutes numeric NOT NULL DEFAULT 0,
  resolution_wait_minutes numeric NOT NULL DEFAULT 0,
  resolution_cycle_started_at timestamptz NOT NULL DEFAULT now(),
  paused_first_minutes numeric,
  paused_resolution_minutes numeric,
  waiting_since timestamptz,
  auto_close_at timestamptz,
  resolved_at timestamptz,
  reopen_until timestamptz,
  reopened_count integer NOT NULL DEFAULT 0,
  seed_key text UNIQUE
);

CREATE INDEX IF NOT EXISTS tickets_inbox_idx ON tickets (status, priority, created_at DESC);
CREATE INDEX IF NOT EXISTS tickets_assignee_idx ON tickets (assignee_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS tickets_autoclose_idx ON tickets (auto_close_at) WHERE status = 'waiting_customer';

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS first_reply_wait_minutes numeric NOT NULL DEFAULT 0;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS resolution_wait_minutes numeric NOT NULL DEFAULT 0;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS resolution_cycle_started_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS customer_session_id uuid;
CREATE INDEX IF NOT EXISTS tickets_customer_session_idx ON tickets (customer_session_id);

CREATE TABLE IF NOT EXISTS ticket_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  sender_type text NOT NULL CHECK (sender_type IN ('agent', 'customer', 'system')),
  sender_id uuid REFERENCES agents(id),
  sender_name text NOT NULL,
  visibility text NOT NULL CHECK (visibility IN ('public', 'internal')),
  body text NOT NULL CHECK (length(trim(body)) > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ticket_messages_order_idx ON ticket_messages (ticket_id, created_at, id);

CREATE TABLE IF NOT EXISTS ticket_resolutions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  cycle_number integer NOT NULL,
  resolved_at timestamptz NOT NULL,
  priority text NOT NULL CHECK (priority IN ('urgent', 'medium', 'low')),
  first_response_breached boolean NOT NULL,
  resolution_breached boolean NOT NULL,
  UNIQUE (ticket_id, cycle_number)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_order bigint GENERATED ALWAYS AS IDENTITY,
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  actor_type text NOT NULL CHECK (actor_type IN ('agent', 'customer', 'system')),
  actor_id uuid,
  actor_name text NOT NULL,
  action text NOT NULL,
  before_values jsonb NOT NULL DEFAULT '{}'::jsonb,
  after_values jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS event_order bigint GENERATED ALWAYS AS IDENTITY;
CREATE INDEX IF NOT EXISTS audit_events_ticket_sequence_idx ON audit_events (ticket_id, event_order);

-- The runtime connection may append audit rows but cannot rewrite or remove them.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'frontdesk_audit_writer') THEN
    CREATE ROLE frontdesk_audit_writer NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'frontdesk_runtime') THEN
    CREATE ROLE frontdesk_runtime NOLOGIN;
  END IF;
END $$;
GRANT INSERT, SELECT ON audit_events TO frontdesk_audit_writer;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM frontdesk_audit_writer;
GRANT frontdesk_audit_writer TO frontdesk_runtime;
GRANT frontdesk_runtime TO CURRENT_USER;
GRANT USAGE ON SCHEMA public TO frontdesk_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO frontdesk_runtime;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM frontdesk_runtime;

CREATE OR REPLACE FUNCTION prevent_audit_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events are append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_events_immutable ON audit_events;
CREATE TRIGGER audit_events_immutable
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();
