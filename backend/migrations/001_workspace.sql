-- Run once against an empty database. Future changes require new migrations.
BEGIN;
CREATE TABLE workspaces (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE collections (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  id uuid NOT NULL,
  feature_key text NOT NULL CHECK (length(feature_key) BETWEEN 1 AND 100),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  deleted_at timestamptz,
  PRIMARY KEY (workspace_id, id)
);
CREATE TABLE property_definitions (
  workspace_id uuid NOT NULL,
  collection_id uuid NOT NULL,
  id uuid NOT NULL,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  kind text NOT NULL CHECK (kind IN ('text', 'number', 'checkbox', 'date', 'select', 'multi_select', 'relation', 'rich_text', 'json')),
  configuration jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(configuration) = 'object'),
  deleted_at timestamptz,
  PRIMARY KEY (workspace_id, collection_id, id),
  FOREIGN KEY (workspace_id, collection_id) REFERENCES collections(workspace_id, id)
);
CREATE TABLE records (
  workspace_id uuid NOT NULL,
  collection_id uuid NOT NULL,
  id uuid NOT NULL,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  data jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(data) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  PRIMARY KEY (workspace_id, collection_id, id),
  FOREIGN KEY (workspace_id, collection_id) REFERENCES collections(workspace_id, id)
);
CREATE INDEX records_active_data_idx ON records USING gin(data) WHERE deleted_at IS NULL;
CREATE INDEX records_updated_idx ON records(workspace_id, updated_at, id);
CREATE TABLE relation_edges (
  workspace_id uuid NOT NULL,
  source_collection_id uuid NOT NULL,
  source_record_id uuid NOT NULL,
  property_id uuid NOT NULL,
  target_collection_id uuid NOT NULL,
  target_record_id uuid NOT NULL,
  deleted_at timestamptz,
  PRIMARY KEY (workspace_id, source_collection_id, source_record_id, property_id, target_collection_id, target_record_id),
  FOREIGN KEY (workspace_id, source_collection_id, source_record_id) REFERENCES records(workspace_id, collection_id, id),
  FOREIGN KEY (workspace_id, target_collection_id, target_record_id) REFERENCES records(workspace_id, collection_id, id),
  FOREIGN KEY (workspace_id, source_collection_id, property_id) REFERENCES property_definitions(workspace_id, collection_id, id)
);
CREATE INDEX relation_edges_target_idx ON relation_edges(workspace_id, target_collection_id, target_record_id);
CREATE TABLE work_sessions (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  id uuid NOT NULL,
  task_collection_id uuid,
  task_record_id uuid,
  task_title text NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'paused', 'completed')),
  started_at timestamptz NOT NULL,
  running_since timestamptz,
  ended_at timestamptz,
  target_ms bigint NOT NULL CHECK (target_ms > 0),
  -- Closed, disjoint half-open work intervals; pauses are gaps. Running time is derived.
  intervals tstzmultirange NOT NULL DEFAULT '{}',
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, task_collection_id, task_record_id) REFERENCES records(workspace_id, collection_id, id),
  CHECK ((task_collection_id IS NULL) = (task_record_id IS NULL)),
  CHECK ((status = 'running') = (running_since IS NOT NULL)),
  CHECK ((status = 'completed') = (ended_at IS NOT NULL)),
  CHECK (running_since IS NULL OR running_since >= started_at),
  CHECK (ended_at IS NULL OR ended_at >= started_at),
  CHECK (isempty(intervals) OR (NOT lower_inf(intervals) AND NOT upper_inf(intervals) AND lower(intervals) >= started_at)),
  CHECK (ended_at IS NULL OR isempty(intervals) OR upper(intervals) <= ended_at),
  CHECK (running_since IS NULL OR isempty(intervals) OR upper(intervals) <= running_since)
);
-- One workspace currently represents one person's focus timeline, across devices.
CREATE UNIQUE INDEX work_sessions_one_active_idx ON work_sessions(workspace_id)
  WHERE status <> 'completed' AND deleted_at IS NULL;
CREATE INDEX work_sessions_calendar_idx ON work_sessions(workspace_id, started_at DESC) WHERE deleted_at IS NULL;
CREATE FUNCTION increment_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.revision := OLD.revision + 1;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER records_revision BEFORE UPDATE ON records FOR EACH ROW EXECUTE FUNCTION increment_revision();
CREATE TRIGGER work_sessions_revision BEFORE UPDATE ON work_sessions FOR EACH ROW EXECUTE FUNCTION increment_revision();
COMMIT;
