-- ---------------------------------------------------------------------------
-- 0029_fix_publish_user_deck.sql
-- Fixes type casting error in publish_user_deck by strongly typing v_card
-- to public.cards%rowtype and passing the composite row to _card_content_hash.
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

    -- Count active studiable cards
    select count(*) into v_card_count
    from public.cards
    where deck_id = v_user_deck.id and is_enabled and not is_deleted and generation_phase = 'refined';

    if v_card_count < 1 then
        raise exception 'Deck must have at least 1 enabled refined card to publish.';
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

    -- Copy all active cards to the market deck and link the personal cards
    for v_card in (
        select *
        from public.cards
        where deck_id = v_user_deck.id and is_enabled and not is_deleted and generation_phase = 'refined'
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
