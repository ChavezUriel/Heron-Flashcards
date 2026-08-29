-- ===========================================================================
-- 0030: Personal Deck Deletion & Origin Classification
--
-- Exposes:
--   1. delete_personal_deck(p_deck_id bigint) -> jsonb
--      Deletes a personal deck (standalone personal deck or user copy of a market deck).
--      Clears practice queue, cleans up review_undo, and deletes the deck (cards and progress cascade).
--
-- Updates:
--   2. get_home_decks()
--      Returns deck_type ('personal' | 'public' | 'managing') and is_owner for each home deck.
--   3. get_deck_preview(p_deck_id bigint)
--      Returns deck_type ('personal' | 'public' | 'managing') and is_owner for personal copies too.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. RPC: delete_personal_deck
-- ---------------------------------------------------------------------------

create or replace function public.delete_personal_deck(p_deck_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_deck public.decks%rowtype;
begin
    if v_uid is null then
        raise exception 'Not authenticated' using errcode = '28000';
    end if;

    select * into v_deck
    from public.decks
    where id = p_deck_id and user_id = v_uid;

    if not found then
        raise exception 'Deck not found or not authorized';
    end if;

    -- Clear pending practice cards from smart practice sessions
    perform public._clear_pending_practice_cards_for_deck(p_deck_id);

    -- Clear review undo records for cards in this deck
    delete from public.review_undo
    where card_id in (select id from public.cards where deck_id = p_deck_id);

    -- Delete the deck itself (cards, card_progress, practice_session_cards cascade delete)
    delete from public.decks
    where id = p_deck_id and user_id = v_uid;

    return jsonb_build_object(
        'success', true,
        'deck_id', p_deck_id
    );
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Updated get_home_decks (surfacing deck_type: personal, public, managing)
-- ---------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------
-- 3. Updated get_deck_preview (surfacing deck_type: personal, public, managing)
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

    if v_is_owner and v_is_market then
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
-- 4. Permissions
-- ---------------------------------------------------------------------------

revoke execute on function public.delete_personal_deck(bigint) from anon, public;
grant execute on function public.delete_personal_deck(bigint) to authenticated;

notify pgrst, 'reload schema';
