-- Adds a point-in-time human-readable label to every audit_log row (e.g. "Medical College AB",
-- "11kV Feeder-3", "TX-14") so the activity log stays meaningful even after the entity itself is
-- later renamed or deleted — the label is captured at the moment of the change, not looked up live.
-- Idempotent: src/migrate.js replays every file in this folder on every run, so this must be safe
-- to execute against a database that already has the column.
alter table audit_log add column if not exists entity_label text;
