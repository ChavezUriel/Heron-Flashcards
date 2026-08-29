-- ===========================================================================
-- Migration 0032: Visibility status is user-only, not proposable or publishable
-- ===========================================================================
--
-- Card visibility (is_enabled) is an individual user's personal study choice.
-- It should not trigger outgoing changes, cannot be proposed as a card removal
-- to the market, and does not restrict deck publishing.
--

-- ---------------------------------------------------------------------------
-- 1. get_deck_outgoing_changes
-- ---------------------------------------------------------------------------

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
      and not bc.is_deleted and bc.generation_phase = 'refined'
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
      and not bc.is_deleted and bc.generation_phase = 'refined';

    return jsonb_build_object(
        'linked', true,
        'deck_id', v_deck.id,
        'market_deck_id', v_base.id,
        'market_deck_title', v_base.title,
        'changes', (v_edits || v_adds || v_removes)
    );
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. create_deck_change_proposal
-- ---------------------------------------------------------------------------

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
                -- You deleted a market card: propose removing it. Skip when the
                -- market card is already deleted.
                if not (not v_bc.is_deleted and v_bc.generation_phase = 'refined') then
                    continue;
                end if;
                insert into public.deck_change_proposal_items
                    (proposal_id, change_type, base_card_id, source_card_id, payload, base_snapshot)
                values
                    (v_proposal_id, 'remove_card', v_bc.id, v_uc.id,
                     null, public._card_sync_content(v_bc));
            elsif public._card_sync_content(v_uc) = public._card_sync_content(v_bc) then
                -- Not deleted, and identical content to the market card: nothing to propose.
                continue;
            else
                insert into public.deck_change_proposal_items
                    (proposal_id, change_type, base_card_id, source_card_id, payload, base_snapshot)
                values
                    (v_proposal_id, 'edit_card', v_bc.id, v_uc.id,
                     public._card_sync_content(v_uc), public._card_sync_content(v_bc));
            end if;
        else
            -- No market counterpart. A deleted personal card has nothing to add.
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

-- ---------------------------------------------------------------------------
-- 3. get_deck_preview
-- ---------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------
-- 4. publish_user_deck
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

notify pgrst, 'reload schema';
