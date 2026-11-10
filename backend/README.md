# PostgreSQL foundation

This is a schema prototype for the future shared workspace. The app currently reads and writes **only its local SQLite database**. There is no deployed data API, authentication service, synchronization engine, or automatic SQLite-to-PostgreSQL mapping.

For local development, set `ZORID_POSTGRES_PASSWORD` in your shell to a private value, then from the repository root:

```sh
docker compose -f backend/compose.yaml up -d --wait
docker compose -f backend/compose.yaml exec -T postgres psql -U zorid -d zorid -v ON_ERROR_STOP=1 < backend/migrations/001_workspace.sql
docker compose -f backend/compose.yaml exec -T postgres psql -U zorid -d zorid -v ON_ERROR_STOP=1 < backend/tests/schema.sql
```

Apply the migration once to an empty database. It deliberately fails on reapplication. Tests run inside a rolled-back transaction. Compose binds only localhost port 54329; it creates a persistent named volume. Stop without deleting data using `docker compose -f backend/compose.yaml down`.

The schema supports collections, property definitions, versioned JSONB records, same-workspace relations, tombstones, and a shared focus timeline with disjoint work intervals. A record's JSON keys can reference stable property UUIDs so renaming a property need not rewrite every record. Property semantics and JSON type checking against definitions remain future application validation.

`schema_version` means payload format; `revision` means server row revision. Record/session updates increment revision automatically. A future write endpoint must compare expected revision in its `UPDATE ... WHERE revision = ...` predicate and handle zero updated rows. Revision alone does not implement conflict handling. Definitions and relation edges also need a change-capture strategy before synchronization.

Cross-workspace foreign keys protect relationship integrity, **not authorization**. No client should receive direct database access. Authentication, workspace membership, authorization/RLS, quotas, idempotent writes, audit/change capture, backups and restore tests are prerequisites to deploying a personal-data service. Tombstone retention and final deletion must account for offline clients.

A single active focus session per workspace is intentional for this initial personal model. Offline devices can independently start sessions; a future sync protocol must explicitly reconcile that conflict. PostgreSQL's normalized multiranges differ from the app's JSON interval array; the future adapter must map milliseconds to timestamps and preserve interval semantics. Rich-text CRDT documents, attachments, search and calculated properties are not implemented by this schema.
