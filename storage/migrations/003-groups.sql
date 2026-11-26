CREATE TABLE zoom.groups (
  meeting_id uuid NOT NULL REFERENCES zoom.meeting_fences,
  group_id uuid NOT NULL,
  name text NOT NULL CHECK (octet_length(name) BETWEEN 1 AND 200),
  seq bigint NOT NULL DEFAULT 0 CHECK (seq BETWEEN 0 AND 9007199254740990),
  PRIMARY KEY(meeting_id, group_id)
);
CREATE TABLE zoom.group_members (
  meeting_id uuid NOT NULL, group_id uuid NOT NULL, participant_id uuid NOT NULL,
  PRIMARY KEY(meeting_id, group_id, participant_id),
  FOREIGN KEY(meeting_id, group_id) REFERENCES zoom.groups,
  FOREIGN KEY(meeting_id, participant_id) REFERENCES zoom.participant_credentials
);
CREATE TABLE zoom.group_invitations (
  meeting_id uuid NOT NULL, group_id uuid NOT NULL, participant_id uuid NOT NULL, invitation_id uuid NOT NULL,
  PRIMARY KEY(meeting_id, group_id, participant_id),
  FOREIGN KEY(meeting_id, group_id) REFERENCES zoom.groups,
  FOREIGN KEY(meeting_id, participant_id) REFERENCES zoom.participant_credentials
);
CREATE INDEX group_members_participant ON zoom.group_members(meeting_id, participant_id, group_id);
CREATE INDEX group_invitations_participant ON zoom.group_invitations(meeting_id, participant_id, group_id);
CREATE TABLE zoom.group_events (
  meeting_id uuid NOT NULL, group_id uuid NOT NULL,
  seq bigint NOT NULL CHECK (seq>0 AND seq<9007199254740991),
  generation bigint NOT NULL, lamport bigint NOT NULL CHECK (lamport>0 AND lamport<9007199254740991),
  kind text NOT NULL, payload jsonb NOT NULL,
  PRIMARY KEY(meeting_id, group_id, seq),
  FOREIGN KEY(meeting_id, group_id) REFERENCES zoom.groups
);
GRANT SELECT, INSERT, UPDATE, DELETE ON zoom.groups, zoom.group_members, zoom.group_invitations, zoom.group_events TO zoom_runtime;
