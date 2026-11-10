\set ON_ERROR_STOP on
BEGIN;
INSERT INTO workspaces VALUES ('00000000-0000-0000-0000-000000000001', 'Personal', now()), ('00000000-0000-0000-0000-000000000002', 'Other', now());
INSERT INTO collections(workspace_id,id,feature_key,name) VALUES
 ('00000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','tasks','Tasks'),
 ('00000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000002','tasks','Other tasks');
INSERT INTO records(workspace_id,collection_id,id,data) VALUES ('00000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','{"title":"Plan the day","custom":42}');
UPDATE records SET data = data || '{"custom":43}';
DO $$ BEGIN
 IF (SELECT revision FROM records LIMIT 1) <> 2 THEN RAISE EXCEPTION 'Revision did not advance'; END IF;
 BEGIN
  INSERT INTO records(workspace_id,collection_id,id) VALUES ('00000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000002');
  RAISE EXCEPTION 'Cross-workspace record accepted';
 EXCEPTION WHEN foreign_key_violation THEN NULL; END;
 BEGIN
  UPDATE records SET data = '[]';
  RAISE EXCEPTION 'Non-object record accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
INSERT INTO work_sessions(workspace_id,id,task_title,status,started_at,running_since,target_ms)
 VALUES ('00000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','Plan','running','2026-01-01 10:00Z','2026-01-01 10:00Z',1500000);
DO $$ BEGIN
 BEGIN
  INSERT INTO work_sessions(workspace_id,id,task_title,status,started_at,running_since,target_ms)
   VALUES ('00000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000002','Duplicate','running',now(),now(),1500000);
  RAISE EXCEPTION 'Concurrent focus accepted';
 EXCEPTION WHEN unique_violation THEN NULL; END;
 BEGIN
  UPDATE work_sessions SET status = 'paused';
  RAISE EXCEPTION 'Paused session retained running timestamp';
 EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
UPDATE work_sessions SET status='completed',running_since=NULL,ended_at='2026-01-01 10:30Z',intervals='{["2026-01-01 10:00Z","2026-01-01 10:10Z"),["2026-01-01 10:20Z","2026-01-01 10:30Z")}';
DO $$ BEGIN
 IF (SELECT count(*) FROM work_sessions, unnest(intervals)) <> 2 THEN RAISE EXCEPTION 'Work intervals lost'; END IF;
 BEGIN
  UPDATE work_sessions SET ended_at='2026-01-01 10:05Z';
  RAISE EXCEPTION 'Interval after completion accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
ROLLBACK;
\echo 'Schema constraints passed'
