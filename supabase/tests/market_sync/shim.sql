-- Minimal Supabase-shaped shim so the app migrations run on vanilla Postgres.
do $$
begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then
        create role anon nologin;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then
        create role authenticated nologin;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then
        create role service_role nologin;
    end if;
end $$;

create schema if not exists auth;

create table if not exists auth.users (
    id uuid primary key default gen_random_uuid(),
    email text unique,
    encrypted_password text,
    raw_user_meta_data jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
);

create table if not exists auth.identities (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users (id) on delete cascade,
    provider_id text not null,
    provider text not null,
    identity_data jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    unique (provider_id, provider)
);

-- Test driver sets the acting user via: select set_config('app.uid', '<uuid>', false)
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
    select nullif(current_setting('app.uid', true), '')::uuid
$$;
