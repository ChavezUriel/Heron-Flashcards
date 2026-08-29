-- ---------------------------------------------------------------------------
-- 0028_deck_publishing.sql
-- Enables users to publish their standalone personal and AI-generated decks
-- to the community Market after passing safety, ethics, and quality audits.
-- ---------------------------------------------------------------------------

-- 1. Schema additions on decks table
alter table public.decks
    add column if not exists publish_status text not null default 'private'
        check (publish_status in ('private', 'under_review', 'published', 'rejected')),
    add column if not exists safety_rating jsonb not null default '{}'::jsonb,
    add column if not exists published_at timestamptz;

create index if not exists decks_publish_status_idx on public.decks (publish_status);

-- 2. RPC to publish a personal deck to the public market
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

-- 3. Updated get_deck_preview to return publishing metadata
create or replace function public.get_deck_preview(p_deck_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_deck public.decks%rowtype;
    v_cards jsonb;
    v_is_market boolean;
    v_is_owner boolean;
    v_base_available boolean := false;
    v_updates int := 0;
    v_outgoing int := 0;
    v_open_proposals int := 0;
    v_user_copy_deck_id bigint := null;
begin
    if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;

    select * into v_deck
    from public.decks
    where id = p_deck_id and (user_id = v_uid or user_id is null);
    if not found then
        raise exception 'Deck not found or not on home';
    end if;

    v_is_market := v_deck.user_id is null;
    v_is_owner := v_is_market and coalesce(v_deck.owner_id = v_uid, false);

    if not v_is_market and v_deck.base_deck_id is not null then
        v_base_available := exists (
            select 1 from public.decks b where b.id = v_deck.base_deck_id and b.user_id is null
        );
        if v_base_available then
            v_updates := public._deck_pending_sync_count(v_deck.id);
            select
                (select count(*) from public.cards uc
                   join public.cards bc on bc.id = uc.base_card_id and bc.deck_id = v_deck.base_deck_id
                   where uc.deck_id = v_deck.id and uc.is_enabled and not uc.is_deleted
                     and bc.is_enabled and not bc.is_deleted and bc.generation_phase = 'refined'
                     and public._card_content_hash(uc.*) is distinct from uc.base_version_hash
                     and public._card_sync_content(uc.*) <> public._card_sync_content(bc.*))
              + (select count(*) from public.cards uc
                   where uc.deck_id = v_deck.id and uc.base_card_id is null
                     and uc.is_enabled and not uc.is_deleted and uc.generation_phase = 'refined')
              + (select count(*) from public.cards uc
                   join public.cards bc on bc.id = uc.base_card_id and bc.deck_id = v_deck.base_deck_id
                   where uc.deck_id = v_deck.id and (uc.is_deleted or not uc.is_enabled)
                     and bc.is_enabled and not bc.is_deleted and bc.generation_phase = 'refined')
            into v_outgoing;
        end if;
    end if;

    if v_is_owner then
        select count(*)::int into v_open_proposals
        from public.deck_change_proposals pr
        where pr.market_deck_id = v_deck.id and pr.status = 'open' and pr.proposer_id <> v_uid;
    end if;

    if v_is_market then
        select id into v_user_copy_deck_id
        from public.decks
        where user_id = v_uid and base_deck_id = v_deck.id
        order by id
        limit 1;
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
        'owner_id', v_deck.owner_id,
        'owner_name', (select coalesce(p.full_name, 'User') from public.profiles p where p.id = v_deck.owner_id),
        'can_edit', coalesce(v_deck.user_id = v_uid, false) or v_is_owner,
        'base_deck_id', v_deck.base_deck_id,
        'base_deck_available', v_base_available,
        'user_copy_deck_id', v_user_copy_deck_id,
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

-- 4. Updated get_market_decks to return publishing info
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

-- 5. Grants
revoke execute on function public.publish_user_deck(bigint, jsonb) from anon;
grant execute on function public.publish_user_deck(bigint, jsonb) to authenticated;
