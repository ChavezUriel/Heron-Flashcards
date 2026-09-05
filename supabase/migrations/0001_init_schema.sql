-- Heron — initial Supabase schema
-- Ported from the original SQLite schema (the original FastAPI/SQLite backend, since removed).
-- Users now live in Supabase Auth (auth.users); app data references auth.users(id).

-- ---------------------------------------------------------------------------
-- profiles: 1:1 with auth.users, holds the display name shown in the app.
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
    id         uuid primary key references auth.users (id) on delete cascade,
    full_name  text not null default 'User',
    created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- decks: global starter decks have user_id IS NULL; per-user copies set
-- user_id + base_deck_id (cloned when a user adds a market deck to home).
-- ---------------------------------------------------------------------------
create table if not exists public.decks (
    id                           bigint generated always as identity primary key,
    slug                         text not null unique,
    title                        text not null,
    description                  text not null,
    is_selected_on_home          boolean not null default true,
    is_enabled_in_smart_practice boolean not null default true,
    language_from                text not null default 'es',
    language_to                  text not null default 'en',
    user_id                      uuid references auth.users (id) on delete cascade,
    base_deck_id                 bigint references public.decks (id) on delete set null,
    created_at                   timestamptz not null default now()
);
create index if not exists decks_user_id_idx on public.decks (user_id);
create index if not exists decks_base_deck_id_idx on public.decks (base_deck_id);

-- ---------------------------------------------------------------------------
-- cards
-- ---------------------------------------------------------------------------
create table if not exists public.cards (
    id                   bigint generated always as identity primary key,
    deck_id              bigint not null references public.decks (id) on delete cascade,
    spanish_text         text not null,
    english_text         text not null,
    is_enabled           boolean not null default true,
    generation_phase     text not null default 'refined' check (generation_phase in ('draft', 'refined')),
    generation_metadata  jsonb not null default '{}'::jsonb,
    section_name         text,
    part_of_speech       text,
    definition_en        text,
    main_translations_es jsonb not null default '[]'::jsonb,
    collocations         jsonb not null default '[]'::jsonb,
    example_sentence     text,
    example_es           text,
    example_en           text
);
create index if not exists cards_deck_id_idx on public.cards (deck_id);

-- ---------------------------------------------------------------------------
-- card_progress: one row per (user-owned) card.
-- ---------------------------------------------------------------------------
create table if not exists public.card_progress (
    card_id             bigint primary key references public.cards (id) on delete cascade,
    user_id             uuid not null references auth.users (id) on delete cascade,
    known_count         integer not null default 0,
    unknown_count       integer not null default 0,
    known_streak        integer not null default 0,
    last_result         text check (last_result in ('known', 'unknown')),
    last_reviewed_at    timestamptz,
    initial_mastered_at timestamptz
);
create index if not exists card_progress_user_id_idx on public.card_progress (user_id);

-- ---------------------------------------------------------------------------
-- practice_sessions / practice_session_cards (smart practice)
-- ---------------------------------------------------------------------------
create table if not exists public.practice_sessions (
    id                     bigint generated always as identity primary key,
    status                 text not null default 'active' check (status in ('active', 'completed', 'abandoned')),
    scope                  text not null default 'global' check (scope in ('global')),
    mode                   text not null check (mode in ('new_material', 'review')),
    focus_mode             text not null check (focus_mode in ('auto', 'new_material', 'review')),
    new_block_size         integer not null,
    review_batch_size      integer not null,
    interleaving_intensity text not null check (interleaving_intensity in ('low', 'medium', 'high')),
    user_id                uuid not null references auth.users (id) on delete cascade,
    created_at             timestamptz not null default now(),
    updated_at             timestamptz not null default now(),
    completed_at           timestamptz
);
create index if not exists practice_sessions_user_status_idx on public.practice_sessions (user_id, status);

create table if not exists public.practice_session_cards (
    id                bigint generated always as identity primary key,
    session_id        bigint not null references public.practice_sessions (id) on delete cascade,
    card_id           bigint not null references public.cards (id) on delete cascade,
    queue_position    integer not null,
    status            text not null default 'pending' check (status in ('pending', 'completed')),
    times_presented   integer not null default 0,
    last_presented_at timestamptz,
    last_result       text check (last_result in ('known', 'unknown')),
    unique (session_id, card_id),
    unique (session_id, queue_position)
);
create index if not exists practice_session_cards_session_idx on public.practice_session_cards (session_id, status, queue_position);

-- ---------------------------------------------------------------------------
-- Auto-create a profile row whenever a new auth user signs up.
-- full_name is passed in signUp options.data.full_name -> raw_user_meta_data.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    insert into public.profiles (id, full_name)
    values (
        new.id,
        coalesce(nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''), 'User')
    )
    on conflict (id) do nothing;
    return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
    after insert on auth.users
    for each row execute function public.handle_new_user();
