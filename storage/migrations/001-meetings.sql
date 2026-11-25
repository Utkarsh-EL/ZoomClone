CREATE SCHEMA zoom;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA zoom FROM PUBLIC;
CREATE TABLE zoom.cluster_identity (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  cluster_id uuid NOT NULL UNIQUE
);
CREATE TABLE zoom.meeting_fences (
  meeting_id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9][a-z0-9-]{0,31}$'),
  generation bigint NOT NULL DEFAULT 0 CHECK (generation BETWEEN 0 AND 9007199254740991),
  runtime_id uuid, incarnation uuid, attempt_id uuid,
  phase text NOT NULL DEFAULT 'INITIALIZING' CHECK (phase IN ('INITIALIZING','RECOVERING','ACTIVE','CLOSED')),
  seq bigint NOT NULL DEFAULT 0 CHECK (seq BETWEEN 0 AND 9007199254740991),
  CHECK ((generation=0 AND phase='INITIALIZING' AND runtime_id IS NULL AND incarnation IS NULL AND attempt_id IS NULL)
    OR (generation>0 AND phase<>'INITIALIZING' AND runtime_id IS NOT NULL AND incarnation IS NOT NULL AND attempt_id IS NOT NULL))
);
CREATE TABLE zoom.meeting_state (
  meeting_id uuid PRIMARY KEY REFERENCES zoom.meeting_fences,
  state jsonb NOT NULL
);
CREATE TABLE zoom.participant_credentials (
  meeting_id uuid NOT NULL REFERENCES zoom.meeting_fences,
  participant_id uuid NOT NULL,
  verifier text NOT NULL CHECK (verifier ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY(meeting_id, participant_id)
);
CREATE TABLE zoom.events (
  meeting_id uuid NOT NULL REFERENCES zoom.meeting_fences,
  seq bigint NOT NULL CHECK (seq>0),
  generation bigint NOT NULL,
  participant_id uuid NOT NULL,
  command_id uuid NOT NULL,
  lamport bigint NOT NULL CHECK (lamport>0 AND lamport<9007199254740991),
  kind text NOT NULL,
  payload jsonb NOT NULL,
  committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(meeting_id, seq)
);
CREATE TABLE zoom.command_outcomes (
  meeting_id uuid NOT NULL REFERENCES zoom.meeting_fences,
  participant_id uuid NOT NULL,
  command_id uuid NOT NULL,
  digest text NOT NULL,
  outcome jsonb NOT NULL,
  PRIMARY KEY(meeting_id, participant_id, command_id)
);
CREATE TABLE zoom.media_intentions (
  meeting_id uuid NOT NULL REFERENCES zoom.meeting_fences,
  seq bigint NOT NULL,
  generation bigint NOT NULL,
  desired jsonb NOT NULL,
  PRIMARY KEY(meeting_id, seq),
  FOREIGN KEY(meeting_id, seq) REFERENCES zoom.events
);
CREATE VIEW zoom.inspect_ownership AS SELECT * FROM zoom.meeting_fences;
CREATE VIEW zoom.inspect_state AS SELECT * FROM zoom.meeting_state;
CREATE VIEW zoom.inspect_events AS SELECT * FROM zoom.events;
CREATE VIEW zoom.inspect_outcomes AS SELECT * FROM zoom.command_outcomes;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='zoom_runtime') THEN CREATE ROLE zoom_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='zoom_inspector') THEN CREATE ROLE zoom_inspector NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE; END IF;
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO zoom_runtime, zoom_inspector', current_database());
END $$;
GRANT USAGE ON SCHEMA zoom TO zoom_runtime, zoom_inspector;
GRANT SELECT ON zoom.cluster_identity, zoom.meeting_fences TO zoom_runtime;
GRANT UPDATE(seq) ON zoom.meeting_fences TO zoom_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON zoom.meeting_state, zoom.participant_credentials, zoom.events, zoom.command_outcomes, zoom.media_intentions TO zoom_runtime;
GRANT SELECT ON zoom.inspect_ownership, zoom.inspect_state, zoom.inspect_events, zoom.inspect_outcomes TO zoom_inspector;
ALTER ROLE zoom_inspector SET default_transaction_read_only=on;
ALTER ROLE zoom_inspector SET statement_timeout='1000ms';
ALTER ROLE zoom_inspector SET idle_in_transaction_session_timeout='1500ms';
ALTER ROLE zoom_inspector SET transaction_timeout='3000ms';
