-- ===========================================================================
-- Migration 0034: Role-named card columns and payloads (Phase P2)
-- ===========================================================================
--
-- 1. Schema renames on public.cards:
--      spanish_text         -> l1_text
--      english_text         -> l2_text
--      definition_en        -> l2_definition
--      main_translations_es -> l1_translations
--      synonyms_en          -> l2_synonyms
--      mnemonic_en          -> l2_mnemonic
--      cloze_distractors_en -> l2_cloze_distractors
--      example_es           -> example_l1
--      example_en           -> example_l2
--
-- 2. cards.examples jsonb array:
--      Convert {es, en} keys -> {l1, l2}
--
-- 3. base_version_hash re-baseline:
--      Re-baseline linked cards using new _card_content_hash
--
-- 4. cards_legacy view:
--      Compatibility view exposing old column names for unported scripts
--
-- 5. RPCs regenerated:
--      _card_sync_content
--      _card_content_hash
--      _touch_card_content_updated_at
--      _review_card_json
--      _preview_card_json
--      update_card
--      get_deck_cards_for_ai
--      apply_card_ai_patch
--      apply_deck_sync
--      create_deck_change_proposal
--      resolve_deck_change_proposal
--      get_minigame_distractors
--      _duplicate_base_deck_to_user
--      publish_user_deck
--      get_deck_preview
--      get_home_decks
--      get_market_decks
-- ===========================================================================

-- ===========================================================================
-- 1. Schema renames on public.cards
-- ===========================================================================

do $$
begin
    if exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'cards' and column_name = 'spanish_text'
    ) then
        alter table public.cards rename column spanish_text to l1_text;
    end if;

    if exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'cards' and column_name = 'english_text'
    ) then
        alter table public.cards rename column english_text to l2_text;
    end if;

    if exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'cards' and column_name = 'definition_en'
    ) then
        alter table public.cards rename column definition_en to l2_definition;
    end if;

    if exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'cards' and column_name = 'main_translations_es'
    ) then
        alter table public.cards rename column main_translations_es to l1_translations;
    end if;

    if exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'cards' and column_name = 'synonyms_en'
    ) then
        alter table public.cards rename column synonyms_en to l2_synonyms;
    end if;

    if exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'cards' and column_name = 'mnemonic_en'
    ) then
        alter table public.cards rename column mnemonic_en to l2_mnemonic;
    end if;

    if exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'cards' and column_name = 'cloze_distractors_en'
    ) then
        alter table public.cards rename column cloze_distractors_en to l2_cloze_distractors;
    end if;

    if exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'cards' and column_name = 'example_es'
    ) then
        alter table public.cards rename column example_es to example_l1;
    end if;

    if exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'cards' and column_name = 'example_en'
    ) then
        alter table public.cards rename column example_en to example_l2;
    end if;
end;
$$;

-- ===========================================================================
-- 1b. Repair the content-hash helpers BEFORE the first write to cards
-- ===========================================================================
--
-- public._card_sync_content(c public.cards) is defined in 0017 against the old
-- column names. Renaming the columns above changes the public.cards composite
-- type, so c.spanish_text no longer resolves as a field and Postgres rereads it
-- as a table reference, failing with "missing FROM-clause entry for table c".
--
-- Section 4 below already recreates these three functions with the role names,
-- but section 2's UPDATE fires the content trigger, which calls the still-stale
-- function — so on a database that HAS rows the migration aborted here. It
-- passed on an empty database because the UPDATE matched no rows and the
-- trigger never fired. Defining them here first makes the order correct; the
-- section 4 copies are then identical no-op replacements.

create or replace function public._card_sync_content(c public.cards)
returns jsonb
language sql
immutable
set search_path = ''
as $$
    select jsonb_build_object(
        'l1_text', c.l1_text,
        'l2_text', c.l2_text,
        'section_name', c.section_name,
        'part_of_speech', c.part_of_speech,
        'l2_definition', c.l2_definition,
        'l1_translations', coalesce(c.l1_translations, '[]'::jsonb),
        'collocations', coalesce(c.collocations, '[]'::jsonb),
        'l2_synonyms', coalesce(c.l2_synonyms, '[]'::jsonb),
        'example_sentence', c.example_sentence,
        'example_l1', c.example_l1,
        'example_l2', c.example_l2,
        'l2_mnemonic', c.l2_mnemonic
    )
$$;

create or replace function public._card_content_hash(c public.cards)
returns text
language sql
immutable
set search_path = ''
as $$
    select md5(public._card_sync_content(c)::text)
$$;

create or replace function public._touch_card_content_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    if public._card_sync_content(old) is distinct from public._card_sync_content(new) then
        new.content_updated_at := now();
    end if;
    return new;
end;
$$;

-- ===========================================================================
-- 2. cards.examples jsonb array migration {es, en} -> {l1, l2}
-- ===========================================================================

update public.cards
set examples = (
    select coalesce(jsonb_agg(
        case
            when jsonb_typeof(elem) = 'object' then
                jsonb_build_object(
                    'l1', coalesce(elem->>'l1', elem->>'es', ''),
                    'l2', coalesce(elem->>'l2', elem->>'en', '')
                )
            else elem
        end
    ), '[]'::jsonb)
    from jsonb_array_elements(coalesce(examples, '[]'::jsonb)) as elem
)
where examples is not null
  and jsonb_typeof(examples) = 'array'
  and jsonb_array_length(examples) > 0
  and exists (
      select 1
      from jsonb_array_elements(examples) as e
      where e ? 'es' or e ? 'en'
  );

-- ===========================================================================
-- 3. Compatibility view cards_legacy
-- ===========================================================================

drop view if exists public.cards_legacy cascade;

create view public.cards_legacy as
select
    id,
    deck_id,
    l1_text as spanish_text,
    l2_text as english_text,
    is_enabled,
    is_deleted,
    generation_phase,
    generation_metadata,
    section_name,
    part_of_speech,
    l2_definition as definition_en,
    l1_translations as main_translations_es,
    collocations,
    l2_synonyms as synonyms_en,
    example_sentence,
    example_l1 as example_es,
    example_l2 as example_en,
    l2_mnemonic as mnemonic_en,
    examples,
    l2_cloze_distractors as cloze_distractors_en,
    base_card_id,
    base_version_hash,
    content_updated_at
from public.cards;

grant select on public.cards_legacy to anon, authenticated;
do $$
begin
    if exists (select 1 from pg_roles where rolname = 'service_role') then
        grant select on public.cards_legacy to service_role;
    end if;
end $$;

-- ===========================================================================
-- 4. Synchronized card content & hash
-- ===========================================================================

create or replace function public._card_sync_content(c public.cards)
returns jsonb
language sql
immutable
set search_path = ''
as $$
    select jsonb_build_object(
        'l1_text', c.l1_text,
        'l2_text', c.l2_text,
        'section_name', c.section_name,
        'part_of_speech', c.part_of_speech,
        'l2_definition', c.l2_definition,
        'l1_translations', coalesce(c.l1_translations, '[]'::jsonb),
        'collocations', coalesce(c.collocations, '[]'::jsonb),
        'l2_synonyms', coalesce(c.l2_synonyms, '[]'::jsonb),
        'example_sentence', c.example_sentence,
        'example_l1', c.example_l1,
        'example_l2', c.example_l2,
        'l2_mnemonic', c.l2_mnemonic
    )
$$;

revoke execute on function public._card_sync_content(public.cards) from anon, authenticated, public;

create or replace function public._card_content_hash(c public.cards)
returns text
language sql
immutable
set search_path = ''
as $$
    select md5(public._card_sync_content(c)::text)
$$;

revoke execute on function public._card_content_hash(public.cards) from anon, authenticated, public;

create or replace function public._touch_card_content_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    if public._card_sync_content(old) is distinct from public._card_sync_content(new) then
        new.content_updated_at := now();
    end if;
    return new;
end;
$$;

-- ===========================================================================
-- 5. Re-baseline base_version_hash for linked cards
-- ===========================================================================

create or replace function public._card_content_hash_legacy(c public.cards)
returns text
language sql
immutable
set search_path = ''
as $$
    select md5(jsonb_build_object(
        'spanish_text', c.l1_text,
        'english_text', c.l2_text,
        'section_name', c.section_name,
        'part_of_speech', c.part_of_speech,
        'definition_en', c.l2_definition,
        'main_translations_es', coalesce(c.l1_translations, '[]'::jsonb),
        'collocations', coalesce(c.collocations, '[]'::jsonb),
        'synonyms_en', coalesce(c.l2_synonyms, '[]'::jsonb),
        'example_sentence', c.example_sentence,
        'example_es', c.example_l1,
        'example_en', c.example_l2,
        'mnemonic_en', c.l2_mnemonic
    )::text)
$$;

update public.cards uc
set base_version_hash = case
    when uc.base_version_hash = public._card_content_hash_legacy(uc.*) then
        public._card_content_hash(uc.*)
    else
        public._card_content_hash(bc.*)
end
from public.cards bc
where bc.id = uc.base_card_id
  and uc.base_version_hash is not null;

drop function if exists public._card_content_hash_legacy(public.cards);

-- ===========================================================================
-- 6. Card JSON helpers: _review_card_json & _preview_card_json
-- ===========================================================================

create or replace function public._review_card_json(p_card_id bigint)
returns jsonb
language sql
stable
set search_path = ''
as $$
    select jsonb_build_object(
        'card_id', c.id,
        'deck_id', c.deck_id,
        'deck_title', d.title,
        'section_name', coalesce(c.section_name, d.title),
        'prompt_l1', c.l1_text,
        'answer_l2', c.l2_text,
        'prompt_es', c.l1_text,
        'answer_en', c.l2_text,
        'part_of_speech', c.part_of_speech,
        'l2_definition', c.l2_definition,
        'definition_en', c.l2_definition,
        'l1_translations', coalesce(c.l1_translations, '[]'::jsonb),
        'main_translations_es', coalesce(c.l1_translations, '[]'::jsonb),
        'collocations', coalesce(c.collocations, '[]'::jsonb),
        'l2_synonyms', coalesce(c.l2_synonyms, '[]'::jsonb),
        'synonyms_en', coalesce(c.l2_synonyms, '[]'::jsonb),
        'example_sentence', c.example_sentence,
        'example_l1', c.example_l1,
        'example_es', c.example_l1,
        'example_l2', c.example_l2,
        'example_en', c.example_l2,
        'l2_mnemonic', c.l2_mnemonic,
        'mnemonic_en', c.l2_mnemonic,
        'examples', coalesce(
            case when jsonb_array_length(coalesce(c.examples, '[]'::jsonb)) > 0
                 then c.examples
                 else (
                     select bc.examples
                     from public.cards bc
                     where bc.id = c.base_card_id
                       and lower(trim(bc.l2_text)) = lower(trim(c.l2_text))
                       and jsonb_array_length(coalesce(bc.examples, '[]'::jsonb)) > 0
                 )
            end, '[]'::jsonb),
        'language_from', d.language_from,
        'language_to', d.language_to
    )
    from public.cards c
    join public.decks d on d.id = c.deck_id
    where c.id = p_card_id;
$$;

revoke execute on function public._review_card_json(bigint) from anon, authenticated, public;

create or replace function public._preview_card_json(p_card_id bigint)
returns jsonb
language sql
stable
set search_path = ''
as $$
    select jsonb_build_object(
        'card_id', c.id,
        'deck_id', c.deck_id,
        'prompt_l1', c.l1_text,
        'answer_l2', c.l2_text,
        'prompt_es', c.l1_text,
        'answer_en', c.l2_text,
        'section_name', coalesce(c.section_name, d.title),
        'is_enabled', c.is_enabled,
        'is_deleted', c.is_deleted,
        'part_of_speech', c.part_of_speech,
        'l2_definition', c.l2_definition,
        'definition_en', c.l2_definition,
        'l1_translations', coalesce(c.l1_translations, '[]'::jsonb),
        'main_translations_es', coalesce(c.l1_translations, '[]'::jsonb),
        'collocations', coalesce(c.collocations, '[]'::jsonb),
        'l2_synonyms', coalesce(c.l2_synonyms, '[]'::jsonb),
        'synonyms_en', coalesce(c.l2_synonyms, '[]'::jsonb),
        'example_sentence', c.example_sentence,
        'example_l1', c.example_l1,
        'example_es', c.example_l1,
        'example_l2', c.example_l2,
        'example_en', c.example_l2,
        'l2_mnemonic', c.l2_mnemonic,
        'mnemonic_en', c.l2_mnemonic,
        'base_card_id', c.base_card_id,
        'examples', coalesce(
            case when jsonb_array_length(coalesce(c.examples, '[]'::jsonb)) > 0
                 then c.examples
                 else (
                     select bc.examples
                     from public.cards bc
                     where bc.id = c.base_card_id
                       and lower(trim(bc.l2_text)) = lower(trim(c.l2_text))
                       and jsonb_array_length(coalesce(bc.examples, '[]'::jsonb)) > 0
                 )
            end, '[]'::jsonb),
        'language_from', d.language_from,
        'language_to', d.language_to
    )
    from public.cards c
    join public.decks d on d.id = c.deck_id
    where c.id = p_card_id;
$$;

revoke execute on function public._preview_card_json(bigint) from anon, authenticated, public;

-- ===========================================================================
-- 7. update_card
-- ===========================================================================

drop function if exists public.update_card(bigint, text, text, text, text, text, text[], text[], text[], text, text, text, text, jsonb);
drop function if exists public.update_card(bigint, text, text, text, text, text, text[], text[], text, text, text, text);
drop function if exists public.update_card(bigint, text, text, text, text, text, text[], text[], text, text, text);

create or replace function public.update_card(
    p_card_id bigint,
    p_prompt_l1 text,
    p_answer_l2 text,
    p_section_name text default null,
    p_part_of_speech text default null,
    p_l2_definition text default null,
    p_l1_translations text[] default '{}',
    p_collocations text[] default '{}',
    p_l2_synonyms text[] default '{}',
    p_example_sentence text default null,
    p_example_l1 text default null,
    p_example_l2 text default null,
    p_l2_mnemonic text default null,
    p_examples jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_owner uuid;
    v_maintainer uuid;
    v_is_deleted boolean;
    v_prompt text;
    v_answer text;
begin
    if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;

    select c.is_deleted, d.user_id, d.owner_id into v_is_deleted, v_owner, v_maintainer
    from public.cards c
    join public.decks d on d.id = c.deck_id
    where c.id = p_card_id;

    if not found then raise exception 'Card not found'; end if;
    if not (coalesce(v_owner = v_uid, false)
            or (v_owner is null and coalesce(v_maintainer = v_uid, false))) then
        raise exception 'Not authorized to modify this card';
    end if;
    if v_is_deleted then
        raise exception 'Cannot modify a deleted card';
    end if;

    v_prompt := nullif(trim(p_prompt_l1), '');
    v_answer := nullif(trim(p_answer_l2), '');
    if v_prompt is null then raise exception 'prompt_l1 must be a non-empty string'; end if;
    if v_answer is null then raise exception 'answer_l2 must be a non-empty string'; end if;

    update public.cards set
        l1_text = v_prompt,
        l2_text = v_answer,
        section_name = nullif(trim(p_section_name), ''),
        part_of_speech = nullif(trim(p_part_of_speech), ''),
        l2_definition = nullif(trim(p_l2_definition), ''),
        l1_translations = public._norm_text_items(p_l1_translations),
        collocations = public._norm_text_items(p_collocations),
        l2_synonyms = public._norm_text_items(p_l2_synonyms),
        example_sentence = nullif(trim(p_example_sentence), ''),
        example_l1 = nullif(trim(p_example_l1), ''),
        example_l2 = nullif(trim(p_example_l2), ''),
        l2_mnemonic = nullif(trim(p_l2_mnemonic), ''),
        examples = case
            when p_examples is not null and jsonb_typeof(p_examples) = 'array' then p_examples
            else examples
        end
    where id = p_card_id;

    return public._preview_card_json(p_card_id);
end;
$$;

revoke execute on function public.update_card(bigint, text, text, text, text, text, text[], text[], text[], text, text, text, text, jsonb) from public, anon;
grant execute on function public.update_card(bigint, text, text, text, text, text, text[], text[], text[], text, text, text, text, jsonb) to authenticated;

-- ===========================================================================
-- 8. get_deck_cards_for_ai
-- ===========================================================================

create or replace function public.get_deck_cards_for_ai(p_deck_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_deck public.decks%rowtype;
    v_cards jsonb;
begin
    if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;

    select * into v_deck
    from public.decks
    where id = p_deck_id and (user_id = v_uid or user_id is null);
    if not found then
        raise exception 'Deck not found or not on home';
    end if;

    select coalesce(jsonb_agg(
        jsonb_build_object(
            'card_id', c.id,
            'base_card_id', c.base_card_id,
            'prompt_l1', c.l1_text,
            'answer_l2', c.l2_text,
            'l1_text', c.l1_text,
            'l2_text', c.l2_text,
            'spanish_text', c.l1_text,
            'english_text', c.l2_text,
            'section_name', coalesce(c.section_name, d.title),
            'is_enabled', c.is_enabled,
            'part_of_speech', c.part_of_speech,
            'l2_definition', c.l2_definition,
            'definition_en', c.l2_definition,
            'l1_translations', coalesce(c.l1_translations, '[]'::jsonb),
            'main_translations_es', coalesce(c.l1_translations, '[]'::jsonb),
            'collocations', coalesce(c.collocations, '[]'::jsonb),
            'l2_synonyms', coalesce(c.l2_synonyms, '[]'::jsonb),
            'synonyms_en', coalesce(c.l2_synonyms, '[]'::jsonb),
            'example_sentence', c.example_sentence,
            'example_l1', c.example_l1,
            'example_es', c.example_l1,
            'example_l2', c.example_l2,
            'example_en', c.example_l2,
            'l2_mnemonic', c.l2_mnemonic,
            'mnemonic_en', c.l2_mnemonic,
            'examples', coalesce(
                case when jsonb_array_length(coalesce(c.examples, '[]'::jsonb)) > 0
                     then c.examples
                     else (
                         select bc.examples
                         from public.cards bc
                         where bc.id = c.base_card_id
                           and lower(trim(bc.l2_text)) = lower(trim(c.l2_text))
                           and not bc.is_deleted
                           and jsonb_array_length(coalesce(bc.examples, '[]'::jsonb)) > 0
                     )
                end, '[]'::jsonb),
            'l2_cloze_distractors', coalesce(
                case when jsonb_array_length(coalesce(c.l2_cloze_distractors, '[]'::jsonb)) > 0
                     then c.l2_cloze_distractors
                     else (
                         select bc.l2_cloze_distractors
                         from public.cards bc
                         where bc.id = c.base_card_id
                           and lower(trim(bc.l2_text)) = lower(trim(c.l2_text))
                           and not bc.is_deleted
                           and jsonb_array_length(coalesce(bc.l2_cloze_distractors, '[]'::jsonb)) > 0
                     )
                end, '[]'::jsonb),
            'cloze_distractors_en', coalesce(
                case when jsonb_array_length(coalesce(c.l2_cloze_distractors, '[]'::jsonb)) > 0
                     then c.l2_cloze_distractors
                     else (
                         select bc.l2_cloze_distractors
                         from public.cards bc
                         where bc.id = c.base_card_id
                           and lower(trim(bc.l2_text)) = lower(trim(c.l2_text))
                           and not bc.is_deleted
                           and jsonb_array_length(coalesce(bc.l2_cloze_distractors, '[]'::jsonb)) > 0
                     )
                end, '[]'::jsonb),
            'generation_metadata', coalesce(c.generation_metadata, '{}'::jsonb),
            'language_from', d.language_from,
            'language_to', d.language_to
        )
        order by coalesce(c.section_name, d.title) asc, c.id asc
    ), '[]'::jsonb)
    into v_cards
    from public.cards c
    join public.decks d on d.id = c.deck_id
    where c.deck_id = p_deck_id and c.generation_phase = 'refined' and not c.is_deleted;

    return v_cards;
end;
$$;

revoke execute on function public.get_deck_cards_for_ai(bigint) from public, anon;
grant execute on function public.get_deck_cards_for_ai(bigint) to authenticated;

-- ===========================================================================
-- 9. apply_card_ai_patch
-- ===========================================================================

create or replace function public.apply_card_ai_patch(
    p_card_id bigint,
    p_patch jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_owner uuid;
    v_maintainer uuid;
    v_examples jsonb;
    v_first_ex jsonb;
    v_patch_examples boolean := false;
    v_ex_l1 text;
    v_ex_l2 text;
begin
    if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
    if p_patch is null or jsonb_typeof(p_patch) != 'object' then
        raise exception 'Patch must be a jsonb object';
    end if;

    select d.user_id, d.owner_id into v_owner, v_maintainer
    from public.cards c
    join public.decks d on d.id = c.deck_id
    where c.id = p_card_id;

    if not found then raise exception 'Card not found'; end if;
    if not (coalesce(v_owner = v_uid, false)
            or (v_owner is null and coalesce(v_maintainer = v_uid, false))) then
        raise exception 'Not authorized to modify this card';
    end if;

    if exists (select 1 from jsonb_each(p_patch) where jsonb_typeof(value) = 'null') then
        raise exception 'Explicit null values are not allowed in card patch';
    end if;

    if p_patch ? 'examples' then
        v_patch_examples := true;
        v_examples := p_patch->'examples';
        if jsonb_typeof(v_examples) != 'array' then
            raise exception 'examples must be a jsonb array';
        end if;
        -- Normalize any legacy {es, en} keys to {l1, l2}
        select coalesce(jsonb_agg(
            case
                when jsonb_typeof(elem) = 'object' then
                    jsonb_build_object(
                        'l1', coalesce(elem->>'l1', elem->>'es', elem->>'example_l1', elem->>'example_es', ''),
                        'l2', coalesce(elem->>'l2', elem->>'en', elem->>'example_l2', elem->>'example_en', ''),
                        'es', coalesce(elem->>'es', elem->>'l1', elem->>'example_es', elem->>'example_l1', ''),
                        'en', coalesce(elem->>'en', elem->>'l2', elem->>'example_en', elem->>'example_l2', '')
                    )
                else elem
            end
        ), '[]'::jsonb)
        into v_examples
        from jsonb_array_elements(v_examples) as elem;

        v_first_ex := v_examples->0;
        if v_first_ex is not null and jsonb_typeof(v_first_ex) = 'object' then
            v_ex_l1 := nullif(trim(coalesce(v_first_ex->>'l1', v_first_ex->>'es', v_first_ex->>'example_l1', v_first_ex->>'example_es')), '');
            v_ex_l2 := nullif(trim(coalesce(v_first_ex->>'l2', v_first_ex->>'en', v_first_ex->>'example_l2', v_first_ex->>'example_en')), '');
        else
            v_ex_l1 := null;
            v_ex_l2 := null;
        end if;
    end if;

    if p_patch ? 'l1_translations' and jsonb_typeof(p_patch->'l1_translations') != 'array' then
        raise exception 'l1_translations must be a jsonb array';
    end if;
    if p_patch ? 'main_translations_es' and jsonb_typeof(p_patch->'main_translations_es') != 'array' then
        raise exception 'main_translations_es must be a jsonb array';
    end if;
    if p_patch ? 'collocations' and jsonb_typeof(p_patch->'collocations') != 'array' then
        raise exception 'collocations must be a jsonb array';
    end if;
    if p_patch ? 'l2_synonyms' and jsonb_typeof(p_patch->'l2_synonyms') != 'array' then
        raise exception 'l2_synonyms must be a jsonb array';
    end if;
    if p_patch ? 'synonyms_en' and jsonb_typeof(p_patch->'synonyms_en') != 'array' then
        raise exception 'synonyms_en must be a jsonb array';
    end if;
    if p_patch ? 'l2_cloze_distractors' and jsonb_typeof(p_patch->'l2_cloze_distractors') != 'array' then
        raise exception 'l2_cloze_distractors must be a jsonb array';
    end if;
    if p_patch ? 'cloze_distractors_en' and jsonb_typeof(p_patch->'cloze_distractors_en') != 'array' then
        raise exception 'cloze_distractors_en must be a jsonb array';
    end if;

    if p_patch ? 'l1_text' and nullif(trim(p_patch->>'l1_text'), '') is null then
        raise exception 'l1_text must be a non-empty string';
    end if;
    if p_patch ? 'spanish_text' and nullif(trim(p_patch->>'spanish_text'), '') is null then
        raise exception 'spanish_text must be a non-empty string';
    end if;
    if p_patch ? 'l2_text' and nullif(trim(p_patch->>'l2_text'), '') is null then
        raise exception 'l2_text must be a non-empty string';
    end if;
    if p_patch ? 'english_text' and nullif(trim(p_patch->>'english_text'), '') is null then
        raise exception 'english_text must be a non-empty string';
    end if;

    update public.cards set
        l1_text = case
            when p_patch ? 'l1_text' then trim(p_patch->>'l1_text')
            when p_patch ? 'spanish_text' then trim(p_patch->>'spanish_text')
            else l1_text
        end,
        l2_text = case
            when p_patch ? 'l2_text' then trim(p_patch->>'l2_text')
            when p_patch ? 'english_text' then trim(p_patch->>'english_text')
            else l2_text
        end,
        section_name = case when p_patch ? 'section_name' then nullif(trim(p_patch->>'section_name'), '') else section_name end,
        part_of_speech = case when p_patch ? 'part_of_speech' then nullif(trim(p_patch->>'part_of_speech'), '') else part_of_speech end,
        l2_definition = case
            when p_patch ? 'l2_definition' then nullif(trim(p_patch->>'l2_definition'), '')
            when p_patch ? 'definition_en' then nullif(trim(p_patch->>'definition_en'), '')
            else l2_definition
        end,
        l1_translations = case
            when p_patch ? 'l1_translations' then p_patch->'l1_translations'
            when p_patch ? 'main_translations_es' then p_patch->'main_translations_es'
            else l1_translations
        end,
        collocations = case when p_patch ? 'collocations' then p_patch->'collocations' else collocations end,
        l2_synonyms = case
            when p_patch ? 'l2_synonyms' then p_patch->'l2_synonyms'
            when p_patch ? 'synonyms_en' then p_patch->'synonyms_en'
            else l2_synonyms
        end,
        examples = case when v_patch_examples then v_examples else examples end,
        example_l1 = case
            when v_patch_examples then v_ex_l1
            when p_patch ? 'example_l1' then nullif(trim(p_patch->>'example_l1'), '')
            when p_patch ? 'example_es' then nullif(trim(p_patch->>'example_es'), '')
            else example_l1
        end,
        example_l2 = case
            when v_patch_examples then v_ex_l2
            when p_patch ? 'example_l2' then nullif(trim(p_patch->>'example_l2'), '')
            when p_patch ? 'example_en' then nullif(trim(p_patch->>'example_en'), '')
            else example_l2
        end,
        example_sentence = case
            when v_patch_examples then v_ex_l2
            when p_patch ? 'example_sentence' then nullif(trim(p_patch->>'example_sentence'), '')
            when p_patch ? 'example_l2' then nullif(trim(p_patch->>'example_l2'), '')
            when p_patch ? 'example_en' then nullif(trim(p_patch->>'example_en'), '')
            else example_sentence
        end,
        l2_mnemonic = case
            when p_patch ? 'l2_mnemonic' then nullif(trim(p_patch->>'l2_mnemonic'), '')
            when p_patch ? 'mnemonic_en' then nullif(trim(p_patch->>'mnemonic_en'), '')
            else l2_mnemonic
        end,
        l2_cloze_distractors = case
            when p_patch ? 'l2_cloze_distractors' then p_patch->'l2_cloze_distractors'
            when p_patch ? 'cloze_distractors_en' then p_patch->'cloze_distractors_en'
            else l2_cloze_distractors
        end,
        generation_metadata = case when p_patch ? 'generation_metadata' then coalesce(generation_metadata, '{}'::jsonb) || (p_patch->'generation_metadata') else generation_metadata end,
        is_enabled = case when p_patch ? 'is_enabled' then (p_patch->>'is_enabled')::boolean else is_enabled end
    where id = p_card_id;

    return public._preview_card_json(p_card_id);
end;
$$;

revoke execute on function public.apply_card_ai_patch(bigint, jsonb) from public, anon;
grant execute on function public.apply_card_ai_patch(bigint, jsonb) to authenticated;

-- ===========================================================================
-- 10. apply_deck_sync
-- ===========================================================================

create or replace function public.apply_deck_sync(p_deck_id bigint, p_changes jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_deck public.decks%rowtype;
    v_base public.decks%rowtype;
    v_item jsonb;
    v_type text;
    v_bc public.cards%rowtype;
    v_uc public.cards%rowtype;
    v_applied int := 0;
    v_skipped jsonb := '[]'::jsonb;
    v_disabled_any boolean := false;
begin
    if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
    if p_changes is null or jsonb_typeof(p_changes) <> 'array' then
        raise exception 'p_changes must be a JSON array';
    end if;

    select * into v_deck from public.decks where id = p_deck_id and user_id = v_uid;
    if not found then raise exception 'Deck not found'; end if;
    if v_deck.base_deck_id is null then raise exception 'Deck is not linked to a market deck'; end if;

    select * into v_base from public.decks where id = v_deck.base_deck_id and user_id is null;
    if not found then raise exception 'Market deck no longer exists'; end if;

    for v_item in select * from jsonb_array_elements(p_changes) loop
        v_type := v_item ->> 'type';

        if v_type = 'add' then
            select * into v_bc from public.cards
            where id = (v_item ->> 'base_card_id')::bigint and deck_id = v_base.id
              and is_enabled and not is_deleted and generation_phase = 'refined';
            if not found then
                v_skipped := v_skipped || jsonb_build_object('item', v_item, 'reason', 'market_card_missing');
                continue;
            end if;
            if exists (select 1 from public.cards where deck_id = v_deck.id and base_card_id = v_bc.id) then
                v_skipped := v_skipped || jsonb_build_object('item', v_item, 'reason', 'already_present');
                continue;
            end if;
            insert into public.cards (
                deck_id, l1_text, l2_text, is_enabled, is_deleted, generation_phase,
                generation_metadata, section_name, part_of_speech, l2_definition,
                l1_translations, collocations, l2_synonyms, example_sentence,
                example_l1, example_l2, l2_mnemonic, examples, l2_cloze_distractors, base_card_id, base_version_hash
            )
            values (
                v_deck.id, v_bc.l1_text, v_bc.l2_text, true, false, v_bc.generation_phase,
                v_bc.generation_metadata, v_bc.section_name, v_bc.part_of_speech, v_bc.l2_definition,
                v_bc.l1_translations, v_bc.collocations, v_bc.l2_synonyms, v_bc.example_sentence,
                v_bc.example_l1, v_bc.example_l2, v_bc.l2_mnemonic, v_bc.examples, v_bc.l2_cloze_distractors, v_bc.id, public._card_content_hash(v_bc)
            );
            v_applied := v_applied + 1;

        elsif v_type = 'update' then
            select uc.* into v_uc from public.cards uc
            where uc.deck_id = v_deck.id
              and uc.base_card_id = (v_item ->> 'base_card_id')::bigint
              and not uc.is_deleted;
            if not found then
                v_skipped := v_skipped || jsonb_build_object('item', v_item, 'reason', 'card_not_linked');
                continue;
            end if;
            select * into v_bc from public.cards bc
            where bc.id = v_uc.base_card_id and bc.deck_id = v_base.id
              and bc.is_enabled and not bc.is_deleted and bc.generation_phase = 'refined';
            if not found then
                v_skipped := v_skipped || jsonb_build_object('item', v_item, 'reason', 'market_card_missing');
                continue;
            end if;
            update public.cards set
                l1_text = v_bc.l1_text,
                l2_text = v_bc.l2_text,
                section_name = v_bc.section_name,
                part_of_speech = v_bc.part_of_speech,
                l2_definition = v_bc.l2_definition,
                l1_translations = v_bc.l1_translations,
                collocations = v_bc.collocations,
                l2_synonyms = v_bc.l2_synonyms,
                example_sentence = v_bc.example_sentence,
                example_l1 = v_bc.example_l1,
                example_l2 = v_bc.example_l2,
                l2_mnemonic = v_bc.l2_mnemonic,
                examples = coalesce(v_bc.examples, examples),
                l2_cloze_distractors = coalesce(v_bc.l2_cloze_distractors, l2_cloze_distractors),
                base_version_hash = public._card_content_hash(v_bc)
            where id = v_uc.id;
            v_applied := v_applied + 1;

        elsif v_type = 'remove' then
            select uc.* into v_uc from public.cards uc
            where uc.id = (v_item ->> 'card_id')::bigint
              and uc.deck_id = v_deck.id and uc.base_card_id is not null;
            if not found then
                v_skipped := v_skipped || jsonb_build_object('item', v_item, 'reason', 'card_not_found');
                continue;
            end if;
            if exists (
                select 1 from public.cards bc
                where bc.id = v_uc.base_card_id and bc.deck_id = v_base.id
                  and bc.is_enabled and not bc.is_deleted and bc.generation_phase = 'refined'
            ) then
                v_skipped := v_skipped || jsonb_build_object('item', v_item, 'reason', 'market_card_still_present');
                continue;
            end if;
            if not v_uc.is_deleted or v_uc.is_enabled then
                update public.cards set is_deleted = true, is_enabled = false where id = v_uc.id;
                delete from public.review_undo where card_id = v_uc.id;
                v_disabled_any := true;
            end if;
            v_applied := v_applied + 1;

        elsif v_type = 'deck_meta' then
            update public.decks
            set title = v_base.title, description = v_base.description
            where id = v_deck.id;
            v_applied := v_applied + 1;

        else
            v_skipped := v_skipped || jsonb_build_object('item', v_item, 'reason', 'unknown_type');
        end if;
    end loop;

    if v_disabled_any then
        perform public._clear_pending_practice_cards_for_deck(v_deck.id);
    end if;

    return jsonb_build_object(
        'applied', v_applied,
        'skipped', v_skipped,
        'status', public.get_deck_sync_status(p_deck_id)
    );
end;
$$;

revoke execute on function public.apply_deck_sync(bigint, jsonb) from anon, public;
grant execute on function public.apply_deck_sync(bigint, jsonb) to authenticated;

-- ===========================================================================
-- 10b. get_deck_outgoing_changes
-- ===========================================================================

create or replace function public.get_deck_outgoing_changes(p_deck_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_deck public.decks%rowtype;
    v_base public.decks%rowtype;
    v_edits jsonb;
    v_adds jsonb;
    v_removes jsonb;
begin
    if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;

    select * into v_deck from public.decks where id = p_deck_id and user_id = v_uid;
    if not found then raise exception 'Deck not found'; end if;

    if v_deck.base_deck_id is null then
        return jsonb_build_object('linked', false);
    end if;

    select * into v_base from public.decks where id = v_deck.base_deck_id and user_id is null;
    if not found then
        return jsonb_build_object('linked', false);
    end if;

    -- Edits: a non-deleted card whose content diverged from its market original.
    select coalesce(jsonb_agg(jsonb_build_object(
        'kind', 'edit',
        'is_deleted', false,
        'user_card', public._preview_card_json(uc.id),
        'base_card', public._preview_card_json(bc.id),
        'already_proposed', exists (
            select 1
            from public.deck_change_proposals pr
            join public.deck_change_proposal_items pi on pi.proposal_id = pr.id
            where pr.market_deck_id = v_base.id and pr.proposer_id = v_uid
              and pr.status = 'open' and pi.change_type = 'edit_card' and pi.base_card_id = bc.id
        )
    ) order by uc.section_name nulls last, uc.id), '[]'::jsonb)
    into v_edits
    from public.cards uc
    join public.cards bc on bc.id = uc.base_card_id and bc.deck_id = v_base.id
    where uc.deck_id = v_deck.id
      and not uc.is_deleted
      and bc.is_enabled and not bc.is_deleted and bc.generation_phase = 'refined'
      and public._card_content_hash(uc.*) is distinct from uc.base_version_hash
      and public._card_sync_content(uc.*) <> public._card_sync_content(bc.*);

    -- Additions: a non-deleted card in this linked deck with no market counterpart.
    select coalesce(jsonb_agg(jsonb_build_object(
        'kind', 'add',
        'is_deleted', false,
        'user_card', public._preview_card_json(uc.id),
        'base_card', null,
        'already_proposed', exists (
            select 1
            from public.deck_change_proposals pr
            join public.deck_change_proposal_items pi on pi.proposal_id = pr.id
            where pr.market_deck_id = v_base.id and pr.proposer_id = v_uid
              and pr.status = 'open' and pi.change_type = 'add_card' and pi.source_card_id = uc.id
        )
    ) order by uc.section_name nulls last, uc.id), '[]'::jsonb)
    into v_adds
    from public.cards uc
    where uc.deck_id = v_deck.id
      and uc.base_card_id is null
      and not uc.is_deleted
      and uc.generation_phase = 'refined';

    -- Removals: a market card you deleted in your copy while it is still live in the market.
    select coalesce(jsonb_agg(jsonb_build_object(
        'kind', 'remove',
        'is_deleted', uc.is_deleted,
        'user_card', public._preview_card_json(uc.id),
        'base_card', public._preview_card_json(bc.id),
        'already_proposed', exists (
            select 1
            from public.deck_change_proposals pr
            join public.deck_change_proposal_items pi on pi.proposal_id = pr.id
            where pr.market_deck_id = v_base.id and pr.proposer_id = v_uid
              and pr.status = 'open' and pi.change_type = 'remove_card' and pi.base_card_id = bc.id
        )
    ) order by uc.section_name nulls last, uc.id), '[]'::jsonb)
    into v_removes
    from public.cards uc
    join public.cards bc on bc.id = uc.base_card_id and bc.deck_id = v_base.id
    where uc.deck_id = v_deck.id
      and uc.is_deleted
      and bc.is_enabled and not bc.is_deleted and bc.generation_phase = 'refined';

    return jsonb_build_object(
        'linked', true,
        'deck_id', v_deck.id,
        'market_deck_id', v_base.id,
        'market_deck_title', v_base.title,
        'changes', (v_edits || v_adds || v_removes)
    );
end;
$$;

revoke execute on function public.get_deck_outgoing_changes(bigint) from anon, public;
grant execute on function public.get_deck_outgoing_changes(bigint) to authenticated;

-- ===========================================================================
-- 11. create_deck_change_proposal
-- ===========================================================================

create or replace function public.create_deck_change_proposal(
    p_market_deck_id bigint,
    p_message text,
    p_user_card_ids bigint[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_base public.decks%rowtype;
    v_card_ids bigint[];
    v_card_id bigint;
    v_uc public.cards%rowtype;
    v_bc public.cards%rowtype;
    v_proposal_id bigint;
    v_items int := 0;
begin
    if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;

    select * into v_base from public.decks where id = p_market_deck_id and user_id is null;
    if not found then raise exception 'Market deck not found'; end if;

    if p_user_card_ids is null or array_length(p_user_card_ids, 1) is null then
        raise exception 'No cards selected';
    end if;
    if array_length(p_user_card_ids, 1) > 200 then
        raise exception 'Too many cards in one proposal (max 200)';
    end if;

    insert into public.deck_change_proposals (market_deck_id, proposer_id, message)
    values (p_market_deck_id, v_uid, nullif(trim(coalesce(p_message, '')), ''))
    returning id into v_proposal_id;

    select array_agg(distinct c) into v_card_ids from unnest(p_user_card_ids) c;

    foreach v_card_id in array v_card_ids loop
        select uc.* into v_uc
        from public.cards uc
        join public.decks ud on ud.id = uc.deck_id
        where uc.id = v_card_id and ud.user_id = v_uid and ud.base_deck_id = p_market_deck_id;
        if not found then
            raise exception 'Card % is not part of your copy of this market deck', v_card_id;
        end if;

        v_bc := null;
        if v_uc.base_card_id is not null then
            select * into v_bc from public.cards
            where id = v_uc.base_card_id and deck_id = p_market_deck_id;
        end if;

        if v_bc.id is not null then
            if v_uc.is_deleted then
                if not (not v_bc.is_deleted and v_bc.generation_phase = 'refined') then
                    continue;
                end if;
                insert into public.deck_change_proposal_items
                    (proposal_id, change_type, base_card_id, source_card_id, payload, base_snapshot)
                values
                    (v_proposal_id, 'remove_card', v_bc.id, v_uc.id,
                     null, public._card_sync_content(v_bc));
            elsif public._card_sync_content(v_uc) = public._card_sync_content(v_bc) then
                continue;
            else
                insert into public.deck_change_proposal_items
                    (proposal_id, change_type, base_card_id, source_card_id, payload, base_snapshot)
                values
                    (v_proposal_id, 'edit_card', v_bc.id, v_uc.id,
                     public._card_sync_content(v_uc), public._card_sync_content(v_bc));
            end if;
        else
            if v_uc.is_deleted then
                continue;
            end if;
            insert into public.deck_change_proposal_items
                (proposal_id, change_type, base_card_id, source_card_id, payload, base_snapshot)
            values
                (v_proposal_id, 'add_card', null, v_uc.id, public._card_sync_content(v_uc), null);
        end if;
        v_items := v_items + 1;
    end loop;

    if v_items = 0 then
        raise exception 'Selected cards do not differ from the market deck';
    end if;

    return public._deck_proposal_json(v_proposal_id);
end;
$$;

revoke execute on function public.create_deck_change_proposal(bigint, text, bigint[]) from anon, public;
grant execute on function public.create_deck_change_proposal(bigint, text, bigint[]) to authenticated;

-- ===========================================================================
-- 12. resolve_deck_change_proposal
-- ===========================================================================

create or replace function public.resolve_deck_change_proposal(
    p_proposal_id bigint,
    p_action text,
    p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_proposal public.deck_change_proposals%rowtype;
    v_owner uuid;
    v_item record;
    v_bc public.cards%rowtype;
    v_new_card_id bigint;
    v_applied int := 0;
    v_skipped jsonb := '[]'::jsonb;
    v_now timestamptz := now();
begin
    if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
    if p_action not in ('approve', 'reject') then raise exception 'Invalid action'; end if;

    select * into v_proposal from public.deck_change_proposals
    where id = p_proposal_id for update;
    if not found then raise exception 'Proposal not found'; end if;
    if v_proposal.status <> 'open' then raise exception 'Proposal is no longer open'; end if;

    select owner_id into v_owner from public.decks
    where id = v_proposal.market_deck_id and user_id is null;
    if not found then raise exception 'Market deck no longer exists'; end if;
    if v_owner is distinct from v_uid then
        raise exception 'Only the deck maintainer can review proposals';
    end if;

    if p_action = 'approve' then
        for v_item in
            select * from public.deck_change_proposal_items
            where proposal_id = v_proposal.id order by id
        loop
            if v_item.change_type = 'edit_card' then
                select * into v_bc from public.cards
                where id = v_item.base_card_id and deck_id = v_proposal.market_deck_id and not is_deleted;
                if not found then
                    v_skipped := v_skipped || jsonb_build_object('item_id', v_item.id, 'reason', 'market_card_missing');
                    continue;
                end if;
                update public.cards set
                    l1_text = coalesce(nullif(trim(coalesce(v_item.payload ->> 'l1_text', v_item.payload ->> 'spanish_text')), ''), l1_text),
                    l2_text = coalesce(nullif(trim(coalesce(v_item.payload ->> 'l2_text', v_item.payload ->> 'english_text')), ''), l2_text),
                    section_name = nullif(trim(coalesce(v_item.payload ->> 'section_name', '')), ''),
                    part_of_speech = nullif(trim(coalesce(v_item.payload ->> 'part_of_speech', '')), ''),
                    l2_definition = nullif(trim(coalesce(v_item.payload ->> 'l2_definition', v_item.payload ->> 'definition_en', '')), ''),
                    l1_translations = coalesce(v_item.payload -> 'l1_translations', v_item.payload -> 'main_translations_es', '[]'::jsonb),
                    collocations = coalesce(v_item.payload -> 'collocations', '[]'::jsonb),
                    l2_synonyms = coalesce(v_item.payload -> 'l2_synonyms', v_item.payload -> 'synonyms_en', '[]'::jsonb),
                    example_sentence = nullif(trim(coalesce(v_item.payload ->> 'example_sentence', '')), ''),
                    example_l1 = nullif(trim(coalesce(v_item.payload ->> 'example_l1', v_item.payload ->> 'example_es', '')), ''),
                    example_l2 = nullif(trim(coalesce(v_item.payload ->> 'example_l2', v_item.payload ->> 'example_en', '')), ''),
                    l2_mnemonic = nullif(trim(coalesce(v_item.payload ->> 'l2_mnemonic', v_item.payload ->> 'mnemonic_en', '')), '')
                where id = v_bc.id;
                v_applied := v_applied + 1;

            elsif v_item.change_type = 'add_card' then
                if nullif(trim(coalesce(v_item.payload ->> 'l1_text', v_item.payload ->> 'spanish_text', '')), '') is null
                   or nullif(trim(coalesce(v_item.payload ->> 'l2_text', v_item.payload ->> 'english_text', '')), '') is null then
                    v_skipped := v_skipped || jsonb_build_object('item_id', v_item.id, 'reason', 'invalid_payload');
                    continue;
                end if;
                insert into public.cards (
                    deck_id, l1_text, l2_text, is_enabled, is_deleted, generation_phase,
                    generation_metadata, section_name, part_of_speech, l2_definition,
                    l1_translations, collocations, l2_synonyms, example_sentence,
                    example_l1, example_l2, l2_mnemonic
                )
                values (
                    v_proposal.market_deck_id,
                    trim(coalesce(v_item.payload ->> 'l1_text', v_item.payload ->> 'spanish_text')),
                    trim(coalesce(v_item.payload ->> 'l2_text', v_item.payload ->> 'english_text')),
                    true, false, 'refined', '{}'::jsonb,
                    nullif(trim(coalesce(v_item.payload ->> 'section_name', '')), ''),
                    nullif(trim(coalesce(v_item.payload ->> 'part_of_speech', '')), ''),
                    nullif(trim(coalesce(v_item.payload ->> 'l2_definition', v_item.payload ->> 'definition_en', '')), ''),
                    coalesce(v_item.payload -> 'l1_translations', v_item.payload -> 'main_translations_es', '[]'::jsonb),
                    coalesce(v_item.payload -> 'collocations', '[]'::jsonb),
                    coalesce(v_item.payload -> 'l2_synonyms', v_item.payload -> 'synonyms_en', '[]'::jsonb),
                    nullif(trim(coalesce(v_item.payload ->> 'example_sentence', '')), ''),
                    nullif(trim(coalesce(v_item.payload ->> 'example_l1', v_item.payload ->> 'example_es', '')), ''),
                    nullif(trim(coalesce(v_item.payload ->> 'example_l2', v_item.payload ->> 'example_en', '')), ''),
                    nullif(trim(coalesce(v_item.payload ->> 'l2_mnemonic', v_item.payload ->> 'mnemonic_en', '')), '')
                )
                returning id into v_new_card_id;

                if v_item.source_card_id is not null then
                    update public.cards uc
                    set base_card_id = v_new_card_id,
                        base_version_hash = (
                            select public._card_content_hash(nc.*)
                            from public.cards nc where nc.id = v_new_card_id
                        )
                    from public.decks ud
                    where uc.id = v_item.source_card_id
                      and uc.base_card_id is null
                      and ud.id = uc.deck_id
                      and ud.user_id = v_proposal.proposer_id
                      and ud.base_deck_id = v_proposal.market_deck_id;
                end if;
                v_applied := v_applied + 1;

            elsif v_item.change_type = 'remove_card' then
                update public.cards set is_deleted = true, is_enabled = false
                where id = v_item.base_card_id and deck_id = v_proposal.market_deck_id;
                if found then
                    v_applied := v_applied + 1;
                else
                    v_skipped := v_skipped || jsonb_build_object('item_id', v_item.id, 'reason', 'market_card_missing');
                end if;
            end if;
        end loop;
    end if;

    update public.deck_change_proposals set
        status = case when p_action = 'approve' then 'approved' else 'rejected' end,
        resolved_at = v_now,
        resolved_by = v_uid,
        resolution_note = nullif(trim(coalesce(p_note, '')), '')
    where id = v_proposal.id;

    return jsonb_build_object(
        'proposal', public._deck_proposal_json(v_proposal.id),
        'applied', v_applied,
        'skipped', v_skipped
    );
end;
$$;

revoke execute on function public.resolve_deck_change_proposal(bigint, text, text) from anon, public;
grant execute on function public.resolve_deck_change_proposal(bigint, text, text) to authenticated;

-- ===========================================================================
-- 13. get_minigame_distractors
-- ===========================================================================

create or replace function public.get_minigame_distractors(
    p_card_id bigint,
    p_n int default 3,
    p_side text default 'l2'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_owner uuid;
    v_deck_id bigint;
    v_section text;
    v_pos text;
    v_side text;
    v_pool_side text;
    v_n int;
    v_excluded text[];
    v_curated jsonb;
    v_result jsonb;
begin
    if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;

    v_side := case
        when lower(coalesce(p_side, 'l2')) in ('l1', 'es') then 'l1'
        when lower(coalesce(p_side, 'l2')) = 'cloze' then 'cloze'
        else 'l2'
    end;
    v_pool_side := case when v_side = 'l1' then 'l1' else 'l2' end;

    v_n := least(greatest(coalesce(p_n, 3), 1), 8);

    select d.user_id, c.deck_id, coalesce(c.section_name, d.title), c.part_of_speech
    into v_owner, v_deck_id, v_section, v_pos
    from public.cards c
    join public.decks d on d.id = c.deck_id
    where c.id = p_card_id;

    if not found then raise exception 'Card not found'; end if;
    if v_owner is distinct from v_uid then raise exception 'Not authorized to use this card'; end if;

    select coalesce(array_agg(lower(trim(x))), '{}')
    into v_excluded
    from (
        select case when v_pool_side = 'l1' then c.l1_text else c.l2_text end as x
        from public.cards c where c.id = p_card_id
        union all
        select jsonb_array_elements_text(
            case when v_pool_side = 'l1'
                 then coalesce(c.l1_translations, '[]'::jsonb)
                 else coalesce(c.l2_synonyms, '[]'::jsonb)
            end)
        from public.cards c where c.id = p_card_id
    ) t
    where nullif(trim(x), '') is not null;

    if v_side = 'cloze' then
        select case
            when jsonb_array_length(coalesce(c.l2_cloze_distractors, '[]'::jsonb)) > 0
                then c.l2_cloze_distractors
            else (
                select bc.l2_cloze_distractors
                from public.cards bc
                where bc.id = c.base_card_id
                  and lower(trim(bc.l2_text)) = lower(trim(c.l2_text))
                  and jsonb_array_length(coalesce(bc.l2_cloze_distractors, '[]'::jsonb)) > 0
            )
        end
        into v_curated
        from public.cards c
        where c.id = p_card_id;

        select coalesce(jsonb_agg(opt), '[]'::jsonb)
        into v_result
        from (
            select opt
            from (
                select distinct on (lower(trim(opt))) opt
                from jsonb_array_elements_text(coalesce(v_curated, '[]'::jsonb)) as opt
                where nullif(trim(opt), '') is not null
                  and lower(trim(opt)) <> all (v_excluded)
                order by lower(trim(opt))
            ) uniq
            order by random()
            limit v_n
        ) chosen;

        if jsonb_array_length(v_result) >= 2 then
            return v_result;
        end if;
    end if;

    with pool as (
        select distinct on (lower(trim(v_text)))
               v_text as answer, section, pos
        from (
            select case when v_pool_side = 'l1' then c.l1_text else c.l2_text end as v_text,
                   coalesce(c.section_name, d.title) as section,
                   c.part_of_speech as pos
            from public.cards c
            join public.decks d on d.id = c.deck_id
            where c.deck_id = v_deck_id
              and c.id <> p_card_id
              and c.is_enabled and c.generation_phase = 'refined'
        ) s
        where nullif(trim(v_text), '') is not null
          and lower(trim(v_text)) <> all (v_excluded)
        order by lower(trim(v_text))
    )
    select coalesce(jsonb_agg(answer), '[]'::jsonb)
    into v_result
    from (
        select answer
        from pool
        order by
            (case when section is not distinct from v_section then 0 else 1 end),
            (case when pos is not distinct from v_pos then 0 else 1 end),
            random()
        limit v_n
    ) chosen;

    return v_result;
end;
$$;

revoke execute on function public.get_minigame_distractors(bigint, int, text) from public, anon;
grant execute on function public.get_minigame_distractors(bigint, int, text) to authenticated;

-- ===========================================================================
-- 14. _duplicate_base_deck_to_user
-- ===========================================================================

create or replace function public._duplicate_base_deck_to_user(p_base_deck_id bigint, p_user_id uuid)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_base public.decks%rowtype;
    v_new_deck_id bigint;
begin
    select * into v_base from public.decks where id = p_base_deck_id;
    if not found then
        raise exception 'Base deck not found';
    end if;

    if not public._is_supported_language_pair(v_base.language_from, v_base.language_to) then
        raise exception 'Unsupported language pair: % -> %', v_base.language_from, v_base.language_to;
    end if;

    insert into public.decks (
        slug, title, description, is_selected_on_home, is_enabled_in_smart_practice,
        language_from, language_to, user_id, base_deck_id
    )
    values (
        v_base.slug || '-user-' || p_user_id::text,
        v_base.title, v_base.description, false, false,
        v_base.language_from, v_base.language_to, p_user_id, p_base_deck_id
    )
    returning id into v_new_deck_id;

    insert into public.cards (
        deck_id, l1_text, l2_text, is_enabled, is_deleted, generation_phase,
        generation_metadata, section_name, part_of_speech, l2_definition,
        l1_translations, collocations, l2_synonyms, example_sentence,
        example_l1, example_l2, l2_mnemonic, examples, l2_cloze_distractors, base_card_id, base_version_hash
    )
    select
        v_new_deck_id, c.l1_text, c.l2_text, c.is_enabled, false, c.generation_phase,
        c.generation_metadata, c.section_name, c.part_of_speech, c.l2_definition,
        c.l1_translations, c.collocations, c.l2_synonyms, c.example_sentence,
        c.example_l1, c.example_l2, c.l2_mnemonic, c.examples, c.l2_cloze_distractors, c.id, public._card_content_hash(c)
    from public.cards c
    where c.deck_id = p_base_deck_id and not c.is_deleted;

    return v_new_deck_id;
end;
$$;

revoke execute on function public._duplicate_base_deck_to_user(bigint, uuid) from anon, authenticated, public;

-- ===========================================================================
-- 15. publish_user_deck
-- ===========================================================================

create or replace function public.publish_user_deck(
    p_deck_id bigint,
    p_safety_audit jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_user_deck public.decks%rowtype;
    v_market_deck public.decks%rowtype;
    v_market_slug text;
    v_card public.cards%rowtype;
    v_new_market_card_id bigint;
    v_card_count int := 0;
begin
    if v_uid is null then
        raise exception 'Not authenticated' using errcode = '28000';
    end if;

    select * into v_user_deck
    from public.decks
    where id = p_deck_id and user_id = v_uid;

    if not found then
        raise exception 'Deck not found or you are not the owner.';
    end if;

    if v_user_deck.base_deck_id is not null then
        raise exception 'Cannot publish a personal copy of an existing market deck.';
    end if;

    if not public._is_supported_language_pair(v_user_deck.language_from, v_user_deck.language_to) then
        raise exception 'Unsupported language pair: % -> %', v_user_deck.language_from, v_user_deck.language_to;
    end if;

    select count(*) into v_card_count
    from public.cards
    where deck_id = v_user_deck.id and not is_deleted and generation_phase = 'refined';

    if v_card_count < 1 then
        raise exception 'Deck must have at least 1 refined card to publish.';
    end if;

    v_market_slug := v_user_deck.slug;
    if exists (select 1 from public.decks where slug = v_market_slug) then
        v_market_slug := v_user_deck.slug || '-pub-' || substr(md5(random()::text), 1, 6);
    end if;

    insert into public.decks (
        slug,
        title,
        description,
        is_selected_on_home,
        is_enabled_in_smart_practice,
        language_from,
        language_to,
        user_id,
        base_deck_id,
        owner_id,
        publish_status,
        safety_rating,
        published_at
    ) values (
        v_market_slug,
        v_user_deck.title,
        v_user_deck.description,
        true,
        true,
        v_user_deck.language_from,
        v_user_deck.language_to,
        null,
        null,
        v_uid,
        'published',
        coalesce(p_safety_audit, '{}'::jsonb),
        now()
    )
    returning * into v_market_deck;

    for v_card in (
        select *
        from public.cards
        where deck_id = v_user_deck.id and not is_deleted and generation_phase = 'refined'
        order by id
    ) loop
        insert into public.cards (
            deck_id,
            l1_text,
            l2_text,
            is_enabled,
            generation_phase,
            generation_metadata,
            section_name,
            part_of_speech,
            l2_definition,
            l1_translations,
            collocations,
            example_sentence,
            example_l1,
            example_l2,
            l2_synonyms,
            l2_mnemonic,
            l2_cloze_distractors,
            examples
        ) values (
            v_market_deck.id,
            v_card.l1_text,
            v_card.l2_text,
            true,
            'refined',
            '{}'::jsonb,
            v_card.section_name,
            v_card.part_of_speech,
            v_card.l2_definition,
            v_card.l1_translations,
            v_card.collocations,
            v_card.example_sentence,
            v_card.example_l1,
            v_card.example_l2,
            v_card.l2_synonyms,
            v_card.l2_mnemonic,
            v_card.l2_cloze_distractors,
            v_card.examples
        )
        returning id into v_new_market_card_id;

        update public.cards uc
        set base_card_id = v_new_market_card_id,
            base_version_hash = public._card_content_hash(uc.*)
        where uc.id = v_card.id;
    end loop;

    update public.decks
    set base_deck_id = v_market_deck.id,
        publish_status = 'published',
        safety_rating = coalesce(p_safety_audit, '{}'::jsonb),
        published_at = now()
    where id = v_user_deck.id;

    return jsonb_build_object(
        'success', true,
        'market_deck_id', v_market_deck.id,
        'market_deck_slug', v_market_slug,
        'cards_published', v_card_count
    );
end;
$$;

revoke execute on function public.publish_user_deck(bigint, jsonb) from anon;
grant execute on function public.publish_user_deck(bigint, jsonb) to authenticated;

-- ===========================================================================
-- 16. get_deck_preview
-- ===========================================================================

create or replace function public.get_deck_preview(p_deck_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_deck public.decks%rowtype;
    v_base_deck public.decks%rowtype;
    v_cards jsonb;
    v_is_market boolean;
    v_is_owner boolean;
    v_deck_type text;
    v_base_available boolean := false;
    v_updates int := 0;
    v_outgoing int := 0;
    v_open_proposals int := 0;
    v_user_copy_deck_id bigint := null;
    v_is_selected_on_home boolean := false;
begin
    if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;

    select * into v_deck
    from public.decks
    where id = p_deck_id and (user_id = v_uid or user_id is null);
    if not found then
        raise exception 'Deck not found or not on home';
    end if;

    v_is_market := v_deck.user_id is null;

    if not v_is_market and v_deck.base_deck_id is not null then
        select * into v_base_deck from public.decks where id = v_deck.base_deck_id and user_id is null;
        v_base_available := (v_base_deck.id is not null);
    end if;

    v_is_owner := (v_is_market and coalesce(v_deck.owner_id = v_uid, false))
               or (not v_is_market and v_deck.base_deck_id is not null and coalesce(v_base_deck.owner_id = v_uid, false))
               or (not v_is_market and coalesce(v_deck.owner_id = v_uid, false));

    if v_deck.base_deck_id is null and not v_is_market then
        v_deck_type := 'personal';
    elsif v_is_owner then
        v_deck_type := 'managing';
    else
        v_deck_type := 'public';
    end if;

    if not v_is_market and v_base_available then
        v_updates := public._deck_pending_sync_count(v_deck.id);
        select
            (select count(*) from public.cards uc
               join public.cards bc on bc.id = uc.base_card_id and bc.deck_id = v_deck.base_deck_id
               where uc.deck_id = v_deck.id and not uc.is_deleted
                 and not bc.is_deleted and bc.generation_phase = 'refined'
                 and public._card_content_hash(uc.*) is distinct from uc.base_version_hash
                 and public._card_sync_content(uc.*) <> public._card_sync_content(bc.*))
          + (select count(*) from public.cards uc
               where uc.deck_id = v_deck.id and uc.base_card_id is null
                 and not uc.is_deleted and uc.generation_phase = 'refined')
          + (select count(*) from public.cards uc
               join public.cards bc on bc.id = uc.base_card_id and bc.deck_id = v_deck.base_deck_id
               where uc.deck_id = v_deck.id and uc.is_deleted
                 and not bc.is_deleted and bc.generation_phase = 'refined')
        into v_outgoing;
    end if;

    if v_is_owner and v_is_market then
        select count(*)::int into v_open_proposals
        from public.deck_change_proposals pr
        where pr.market_deck_id = v_deck.id and pr.status = 'open' and pr.proposer_id <> v_uid;
    end if;

    if v_is_market then
        select id, is_selected_on_home into v_user_copy_deck_id, v_is_selected_on_home
        from public.decks
        where user_id = v_uid and base_deck_id = v_deck.id
        order by id
        limit 1;
    else
        v_is_selected_on_home := coalesce(v_deck.is_selected_on_home, false);
    end if;

    select coalesce(jsonb_agg(public._preview_card_json(s.id) order by s.section_name asc, s.id asc), '[]'::jsonb)
    into v_cards
    from (
        select c.id, coalesce(c.section_name, d.title) as section_name
        from public.cards c
        join public.decks d on d.id = c.deck_id
        where c.deck_id = p_deck_id and c.generation_phase = 'refined' and not c.is_deleted
    ) s;

    return jsonb_build_object(
        'deck_id', v_deck.id,
        'deck_title', v_deck.title,
        'deck_description', v_deck.description,
        'language_from', v_deck.language_from,
        'language_to', v_deck.language_to,
        'total_cards', jsonb_array_length(v_cards),
        'cards', v_cards,
        'is_market', v_is_market,
        'is_owner', v_is_owner,
        'deck_type', v_deck_type,
        'owner_id', case when v_is_market then v_deck.owner_id else v_base_deck.owner_id end,
        'owner_name', (
            select coalesce(p.full_name, 'User')
            from public.profiles p
            where p.id = case when v_is_market then v_deck.owner_id else v_base_deck.owner_id end
        ),
        'can_edit', coalesce(v_deck.user_id = v_uid, false) or v_is_owner,
        'base_deck_id', v_deck.base_deck_id,
        'base_deck_available', v_base_available,
        'user_copy_deck_id', v_user_copy_deck_id,
        'is_selected_on_home', coalesce(v_is_selected_on_home, false),
        'updates_available', v_updates,
        'outgoing_changes', v_outgoing,
        'open_proposals', v_open_proposals,
        'publish_status', coalesce(v_deck.publish_status, 'private'),
        'published_at', v_deck.published_at,
        'safety_rating', coalesce(v_deck.safety_rating, '{}'::jsonb),
        'can_publish', (not v_is_market) and (v_deck.base_deck_id is null) and (coalesce(v_deck.user_id = v_uid, false))
    );
end;
$$;

revoke execute on function public.get_deck_preview(bigint) from anon, public;
grant execute on function public.get_deck_preview(bigint) to authenticated;

-- ===========================================================================
-- 17. get_home_decks
-- ===========================================================================

create or replace function public.get_home_decks()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_result jsonb;
begin
    if v_uid is null then
        raise exception 'Not authenticated' using errcode = '28000';
    end if;

    select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]'::jsonb)
    into v_result
    from (
        select
            d.id, d.slug, d.title, d.description,
            d.is_selected_on_home, d.is_enabled_in_smart_practice,
            d.language_from, d.language_to,
            d.base_deck_id,
            d.publish_status,
            coalesce(bd.owner_id = v_uid or d.owner_id = v_uid, false) as is_owner,
            case
                when d.base_deck_id is null then 'personal'
                when coalesce(bd.owner_id = v_uid or d.owner_id = v_uid, false) then 'managing'
                else 'public'
            end as deck_type,
            (case when d.base_deck_id is not null
                  then public._deck_pending_sync_count(d.id)
                  else 0 end) as updates_available,
            count(c.id)::int as total_cards,
            coalesce(sum(case when cp.last_result is not null then 1 else 0 end), 0)::int as reviewed_cards,
            coalesce(sum(case when cp.last_result = 'known' then 1 else 0 end), 0)::int as known_cards,
            coalesce(sum(case when cp.last_result = 'unknown' then 1 else 0 end), 0)::int as unknown_cards,
            case when count(c.id) > 0
                 then coalesce(sum(case when cp.last_result is not null then 1 else 0 end), 0)::float / count(c.id)
                 else 0 end as completion_ratio,
            (count(c.id) > 0 and coalesce(sum(case when cp.last_result = 'known' then 1 else 0 end), 0) = count(c.id)) as is_completed
        from public.decks d
        left join public.decks bd on bd.id = d.base_deck_id
        left join public.cards c on c.deck_id = d.id and c.is_enabled and not c.is_deleted and c.generation_phase = 'refined'
        left join public.card_progress cp on cp.card_id = c.id
        where d.is_selected_on_home and d.user_id = v_uid
        group by d.id, bd.owner_id
    ) t;

    return v_result;
end;
$$;

revoke execute on function public.get_home_decks() from anon, public;
grant execute on function public.get_home_decks() to authenticated;

-- ===========================================================================
-- 18. get_market_decks
-- ===========================================================================

create or replace function public.get_market_decks()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_result jsonb;
begin
    if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;

    select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]'::jsonb)
    into v_result
    from (
        select
            d.id, d.slug, d.title, d.description,
            d.language_from, d.language_to,
            coalesce(ud.is_selected_on_home, false) as is_selected_on_home,
            coalesce(ud.is_enabled_in_smart_practice, d.is_enabled_in_smart_practice) as is_enabled_in_smart_practice,
            d.owner_id,
            (select coalesce(p.full_name, 'User') from public.profiles p where p.id = d.owner_id) as owner_name,
            coalesce(d.owner_id = v_uid, false) as is_owner,
            coalesce(d.publish_status, 'published') as publish_status,
            d.published_at,
            (case when d.owner_id = v_uid then (
                select count(*)::int from public.deck_change_proposals pr
                where pr.market_deck_id = d.id and pr.status = 'open' and pr.proposer_id <> v_uid
            ) else 0 end) as open_proposals,
            (select count(*)::int from public.deck_change_proposals pr
             where pr.market_deck_id = d.id and pr.status = 'open' and pr.proposer_id = v_uid) as my_open_proposals,
            (select count(*) from public.cards bc where bc.deck_id = d.id and bc.is_enabled and not bc.is_deleted and bc.generation_phase = 'refined')::int as total_cards,
            coalesce(sum(case when cp.last_result is not null then 1 else 0 end), 0)::int as reviewed_cards,
            coalesce(sum(case when cp.last_result = 'known' then 1 else 0 end), 0)::int as known_cards,
            coalesce(sum(case when cp.last_result = 'unknown' then 1 else 0 end), 0)::int as unknown_cards,
            case when (select count(*) from public.cards bc where bc.deck_id = d.id and bc.is_enabled and not bc.is_deleted and bc.generation_phase = 'refined') > 0
                 then coalesce(sum(case when cp.last_result is not null then 1 else 0 end), 0)::float
                      / (select count(*) from public.cards bc where bc.deck_id = d.id and bc.is_enabled and not bc.is_deleted and bc.generation_phase = 'refined')
                 else 0 end as completion_ratio,
            ((select count(*) from public.cards bc where bc.deck_id = d.id and bc.is_enabled and not bc.is_deleted and bc.generation_phase = 'refined') > 0
                 and coalesce(sum(case when cp.last_result = 'known' then 1 else 0 end), 0)
                     = (select count(*) from public.cards bc where bc.deck_id = d.id and bc.is_enabled and not bc.is_deleted and bc.generation_phase = 'refined')) as is_completed
        from public.decks d
        left join public.decks ud on ud.base_deck_id = d.id and ud.user_id = v_uid
        left join public.cards uc on uc.deck_id = ud.id and uc.is_enabled and not uc.is_deleted and uc.generation_phase = 'refined'
        left join public.card_progress cp on cp.card_id = uc.id
        where d.user_id is null
        group by d.id, ud.is_selected_on_home, ud.is_enabled_in_smart_practice, d.is_enabled_in_smart_practice
    ) t;

    return v_result;
end;
$$;

revoke execute on function public.get_market_decks() from anon, public;
grant execute on function public.get_market_decks() to authenticated;

-- ===========================================================================
-- 19. Schema reload notification
-- ===========================================================================

notify pgrst, 'reload schema';
