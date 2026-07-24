-- Adds a fourth role, 'super_admin', above the existing field_staff/control_center/admin.
-- super_admin has every capability admin has (see requireRole('admin', 'control_center', ...)
-- call sites in the routes/*.routes.js files), PLUS exclusive access to the "import an Excel
-- workbook and republish it as the live network" feature (POST /api/network/replace and the
-- corresponding client-side Import Excel / Save buttons in gridline.html) — that destructive,
-- whole-network-replacing action is no longer available to plain admin accounts.
--
-- Safe to re-run: this file must be idempotent, since migrate.js (see its header comment) replays
-- every migration file on every run rather than tracking which ones already applied.
--
-- The role column's CHECK constraint is an inline column constraint, so real Postgres names it
-- deterministically as "users_role_check" (table name + column name + "_check") — dropping it by
-- that name and re-adding a wider version works cleanly there. The in-memory Postgres stand-in
-- used by this project's test suite (pg-mem) does NOT reproduce that naming; empirically it names
-- inline CHECK constraints "<table>_constraint_<n>" instead (confirmed via a throwaway pg-mem
-- script: the very first and only CHECK constraint pg-mem sees on `users` in a fresh schema replay
-- comes out as "users_constraint_1", and this holds up across repeated fresh runs). Dropping both
-- candidate names (each guarded with "if exists", so whichever one doesn't apply to the engine
-- currently running this file is silently skipped) before adding the new constraint back under the
-- real-Postgres name makes this one file work unmodified against both engines.
alter table users drop constraint if exists users_role_check;
alter table users drop constraint if exists users_constraint_1;
alter table users add constraint users_role_check
  check (role in ('field_staff', 'control_center', 'admin', 'super_admin'));
