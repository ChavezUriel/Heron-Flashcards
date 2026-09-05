-- ===========================================================================
-- Migration 0033: UI locale and language pair validation
-- ===========================================================================
--
-- 1. Add profiles.ui_locale text (nullable; null means "follow L1").
-- 2. Backfill assertion: verify that every existing deck is es -> en.
-- 3. Supported language pairs validation helper: public._is_supported_language_pair.
-- 4. Validate decks.language_from / language_to on write in the RPCs that
--    create or clone decks (_duplicate_base_deck_to_user, publish_user_deck),
--    rejecting unsupported pairs.
--

-- ---------------------------------------------------------------------------
-- 1. profiles.ui_locale
-- ---------------------------------------------------------------------------

alter table public.profiles
add column if not exists ui_locale text default null;

-- ---------------------------------------------------------------------------
-- 2. Backfill assertion: assert every existing deck is es -> en
-- ---------------------------------------------------------------------------

do $$
declare
    v_invalid_count int;
begin
    -- Ensure columns are populated if any were null
    update public.decks
    set language_from = 'es'
    where language_from is null;

    update public.decks
    set language_to = 'en'
    where language_to is null;

    select count(*) into v_invalid_count
    from public.decks
    where language_from <> 'es' or language_to <> 'en';

    if v_invalid_count > 0 then
        raise exception 'Assertion failed: expected every existing deck to be es -> en, but found % non-conforming deck(s)', v_invalid_count;
    end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Supported language pair validation helper
-- ---------------------------------------------------------------------------

create or replace function public._is_supported_language_pair(p_from text, p_to text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
    select (
        p_from is not null
        and p_to is not null
        and p_from <> p_to
        and p_from in ('en', 'es', 'fr', 'pt-BR', 'de', 'it')
        and p_to in ('en', 'es', 'fr')
    );
$$;

revoke execute on function public._is_supported_language_pair(text, text) from anon, authenticated, public;

-- ---------------------------------------------------------------------------
-- 4. Validate language pairs on deck clone: _duplicate_base_deck_to_user
-- ---------------------------------------------------------------------------

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
        deck_id, spanish_text, english_text, is_enabled, is_deleted, generation_phase,
        generation_metadata, section_name, part_of_speech, definition_en,
        main_translations_es, collocations, synonyms_en, example_sentence,
        example_es, example_en, mnemonic_en, examples, cloze_distractors_en, base_card_id, base_version_hash
    )
    select
        v_new_deck_id, c.spanish_text, c.english_text, c.is_enabled, false, c.generation_phase,
        c.generation_metadata, c.section_name, c.part_of_speech, c.definition_en,
        c.main_translations_es, c.collocations, c.synonyms_en, c.example_sentence,
        c.example_es, c.example_en, c.mnemonic_en, c.examples, c.cloze_distractors_en, c.id, public._card_content_hash(c)
    from public.cards c
    where c.deck_id = p_base_deck_id and not c.is_deleted;

    return v_new_deck_id;
end;
$$;

revoke execute on function public._duplicate_base_deck_to_user(bigint, uuid) from anon, authenticated, public;

-- ---------------------------------------------------------------------------
-- 5. Validate language pairs on deck creation/publishing: publish_user_deck
-- ---------------------------------------------------------------------------

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

    -- Fetch the personal deck
    select * into v_user_deck
    from public.decks
    where id = p_deck_id and user_id = v_uid;

    if not found then
        raise exception 'Deck not found or you are not the owner.';
    end if;

    if v_user_deck.base_deck_id is not null then
        raise exception 'Cannot publish a personal copy of an existing market deck.';
    end if;

    -- Validate language pair
    if not public._is_supported_language_pair(v_user_deck.language_from, v_user_deck.language_to) then
        raise exception 'Unsupported language pair: % -> %', v_user_deck.language_from, v_user_deck.language_to;
    end if;

    -- Count active refined cards (all non-deleted cards)
    select count(*) into v_card_count
    from public.cards
    where deck_id = v_user_deck.id and not is_deleted and generation_phase = 'refined';

    if v_card_count < 1 then
        raise exception 'Deck must have at least 1 refined card to publish.';
    end if;

    -- Generate a unique market slug
    v_market_slug := v_user_deck.slug;
    if exists (select 1 from public.decks where slug = v_market_slug) then
        v_market_slug := v_user_deck.slug || '-pub-' || substr(md5(random()::text), 1, 6);
    end if;

    -- Create the new public Market deck (user_id IS NULL, owner_id = v_uid)
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

    -- Copy all non-deleted cards to the market deck and link the personal cards
    for v_card in (
        select *
        from public.cards
        where deck_id = v_user_deck.id and not is_deleted and generation_phase = 'refined'
        order by id
    ) loop
        insert into public.cards (
            deck_id,
            spanish_text,
            english_text,
            is_enabled,
            generation_phase,
            generation_metadata,
            section_name,
            part_of_speech,
            definition_en,
            main_translations_es,
            collocations,
            example_sentence,
            example_es,
            example_en,
            synonyms_en,
            mnemonic_en,
            cloze_distractors_en,
            examples
        ) values (
            v_market_deck.id,
            v_card.spanish_text,
            v_card.english_text,
            true,
            'refined',
            '{}'::jsonb,
            v_card.section_name,
            v_card.part_of_speech,
            v_card.definition_en,
            v_card.main_translations_es,
            v_card.collocations,
            v_card.example_sentence,
            v_card.example_es,
            v_card.example_en,
            v_card.synonyms_en,
            v_card.mnemonic_en,
            v_card.cloze_distractors_en,
            v_card.examples
        )
        returning id into v_new_market_card_id;

        -- Link the user's card to the new market card as provenance
        update public.cards uc
        set base_card_id = v_new_market_card_id,
            base_version_hash = public._card_content_hash(uc.*)
        where uc.id = v_card.id;
    end loop;

    -- Link the user's personal deck to the new market deck
    update public.decks
    set base_deck_id = v_market_deck.id,
        publish_status = 'published',
        safety_rating = coalesce(p_safety_audit, '{}'::jsonb),
        published_at = now()
    where id = v_user_deck.id;

    return jsonb_build_object(
        'success', true,
        'market_deck_id', v_market_deck.id,
        'market_deck_slug', v_market_deck.slug,
        'cards_published', v_card_count
    );
end;
$$;

revoke execute on function public.publish_user_deck(bigint, jsonb) from anon;
grant execute on function public.publish_user_deck(bigint, jsonb) to authenticated;

notify pgrst, 'reload schema';
