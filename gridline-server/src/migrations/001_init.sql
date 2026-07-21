-- GRIDLINE backend — initial schema
-- Matches GRIDLINE-Data-Model-and-API-Spec.md section 1.

create extension if not exists pgcrypto;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null unique,
  password_hash text not null,
  role text not null check (role in ('field_staff', 'control_center', 'admin')),
  assigned_section_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists sections (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  details jsonb not null default '{}'::jsonb
);

create table if not exists feeders (
  id uuid primary key default gen_random_uuid(),
  section_id uuid references sections(id) on delete set null,
  name text not null,
  kv numeric,
  location text,
  poc text,
  state text not null default 'On' check (state in ('On', 'Off')),
  last_tripped timestamptz,
  risks text,
  version integer not null default 1,
  updated_at timestamptz not null default now(),
  updated_by uuid references users(id)
);

create table if not exists nodes (
  id uuid primary key default gen_random_uuid(),
  feeder_id uuid not null references feeders(id) on delete cascade,
  kind text not null check (kind in ('source', 'breaker')),
  breaker_type text check (breaker_type is null or breaker_type in ('AB', 'RMU', 'Split', 'Tap')),
  label text not null,
  state text check (state is null or state in ('Open', 'Closed')),
  version integer not null default 1,
  updated_at timestamptz not null default now(),
  updated_by uuid references users(id),
  check ((kind = 'source' and breaker_type is null) or (kind = 'breaker' and breaker_type is not null))
);

create table if not exists lines (
  id uuid primary key default gen_random_uuid(),
  feeder_id uuid not null references feeders(id) on delete cascade,
  from_node_id uuid not null references nodes(id) on delete cascade,
  to_node_id uuid not null references nodes(id) on delete cascade,
  name text not null,
  breaker_state text not null default 'Closed' check (breaker_state in ('Open', 'Closed')),
  version integer not null default 1,
  updated_at timestamptz not null default now(),
  updated_by uuid references users(id)
);

create table if not exists transformers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  capacity_kva numeric,
  pole_name text,
  load_r numeric,
  load_y numeric,
  load_b numeric,
  load_captured_at timestamptz,
  last_fault_date timestamptz,
  last_fault_reason text,
  node_id uuid references nodes(id) on delete cascade,
  line_id uuid references lines(id) on delete cascade,
  updated_at timestamptz not null default now(),
  updated_by uuid references users(id),
  check (
    (node_id is not null and line_id is null) or
    (node_id is null and line_id is not null)
  )
);

create table if not exists interlinks (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  node_a_id uuid not null references nodes(id) on delete cascade,
  node_b_id uuid not null references nodes(id) on delete cascade,
  breaker_type text not null check (breaker_type in ('AB', 'RMU')),
  switchable boolean not null default false,
  switch_state text not null default 'NC' check (switch_state in ('NC', 'NO')),
  version integer not null default 1,
  updated_at timestamptz not null default now(),
  updated_by uuid references users(id)
);

create table if not exists audit_log (
  id bigserial primary key,
  entity_type text not null check (entity_type in ('feeder', 'node', 'line', 'interlink', 'transformer')),
  entity_id uuid not null,
  action text not null check (action in ('create', 'update', 'delete')),
  field_changed text,
  old_value jsonb,
  new_value jsonb,
  performed_by uuid references users(id),
  performed_via text not null check (performed_via in ('mobile', 'web')),
  performed_at timestamptz not null default now()
);

create index if not exists idx_nodes_feeder on nodes(feeder_id);
create index if not exists idx_lines_feeder on lines(feeder_id);
create index if not exists idx_lines_from_node on lines(from_node_id);
create index if not exists idx_lines_to_node on lines(to_node_id);
create index if not exists idx_interlinks_node_a on interlinks(node_a_id);
create index if not exists idx_interlinks_node_b on interlinks(node_b_id);
create index if not exists idx_audit_entity on audit_log(entity_type, entity_id);
