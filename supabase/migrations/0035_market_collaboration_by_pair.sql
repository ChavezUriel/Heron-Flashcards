-- ===========================================================================
-- Migration 0035: Market and collaboration by pair (P7)
-- ===========================================================================
--
-- 1. get_market_decks: takes optional pair filter (p_language_from, p_language_to)
--    and returns language_from and language_to on each row. Defaults to all when
--    unspecified, providing an explicit escape.
-- 2. create_deck_change_proposal: enforces language pair identity for collaboration;
--    rejects cross-pair proposals.
-- 3. apply_deck_sync: enforces language pair identity for collaboration; rejects
--    cross-pair deck sync.
-- 4. get_deck_sync_status & get_deck_outgoing_changes & _deck_pending_sync_count:
--    report unlinked / 0 when language pairs mismatch.
--

-- ===========================================================================
-- 1. get_market_decks
-- ===========================================================================

drop function if exists public.get_market_decks();

create or replace function public.get_market_decks(
    p_language_from text default null,
    p_language_to text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_result jsonb;
    v_from text := nullif(trim(coalesce(p_language_from, '')), '');
    v_to text := nullif(trim(coalesce(p_language_to, '')), '');
begin
    if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;

    -- Handle composite 'es->en' or 'es:en' passed in p_language_from
    if v_to is null and v_from is not null and v_from ~ '^(.*)(->|:)(.*)$' then
        v_to := nullif(trim(regexp_replace(v_from, '^(.*)(->|:)(.*)$', '\3')), '');
        v_from := nullif(trim(regexp_replace(v_from, '^(.*)(->|:)(.*)$', '\1')), '');
    end if;

    if v_from = 'all' or v_from = '*' then v_from := null; end if;
    if v_to = 'all' or v_to = '*' then v_to := null; end if;

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
          and (v_from is null or d.language_from = v_from)
          and (v_to is null or d.language_to = v_to)
        group by d.id, ud.is_selected_on_home, ud.is_enabled_in_smart_practice, d.is_enabled_in_smart_practice
    ) t;

    return v_result;
end;
$$;

revoke execute on function public.get_market_decks(text, text) from anon, public;
grant execute on function public.get_market_decks(text, text) to authenticated;

-- ===========================================================================
-- 2. create_deck_change_proposal
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
    v_ud public.decks%rowtype;
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

    -- Reject cross-pair proposal if user's linked copy has a different language pair
    select * into v_ud from public.decks
    where base_deck_id = p_market_deck_id and user_id = v_uid;
    if found and (v_ud.language_from <> v_base.language_from or v_ud.language_to <> v_base.language_to) then
        raise exception 'Cannot propose changes: language pair mismatch (% -> % vs % -> %)',
            v_ud.language_from, v_ud.language_to, v_base.language_from, v_base.language_to;
    end if;

    insert into public.deck_change_proposals (market_deck_id, proposer_id, message)
    values (p_market_deck_id, v_uid, nullif(trim(coalesce(p_message, '')), ''))
    returning id into v_proposal_id;

    select array_agg(distinct c) into v_card_ids from unnest(p_user_card_ids) c;

    foreach v_card_id in array v_card_ids loop
        -- Find the user deck and card
        select ud.* into v_ud
        from public.decks ud
        join public.cards uc on uc.deck_id = ud.id
        where uc.id = v_card_id and ud.user_id = v_uid;

        if not found then
            raise exception 'Card % is not part of your copy of this market deck', v_card_id;
        end if;

        -- Pair identity enforcement: reject cross-pair proposals
        if v_ud.language_from <> v_base.language_from or v_ud.language_to <> v_base.language_to then
            raise exception 'Cannot propose changes: language pair mismatch (% -> % vs % -> %)',
                v_ud.language_from, v_ud.language_to, v_base.language_from, v_base.language_to;
        end if;

        if v_ud.base_deck_id is distinct from p_market_deck_id then
            raise exception 'Card % is not part of your copy of this market deck', v_card_id;
        end if;

        select uc.* into v_uc from public.cards uc where uc.id = v_card_id;

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
-- 3. apply_deck_sync
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

    -- Pair identity enforcement: reject cross-pair sync operations
    if v_deck.language_from <> v_base.language_from or v_deck.language_to <> v_base.language_to then
        raise exception 'Cannot sync deck: language pair mismatch (% -> % vs % -> %)',
            v_deck.language_from, v_deck.language_to, v_base.language_from, v_base.language_to;
    end if;

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
-- 4. get_deck_sync_status & get_deck_outgoing_changes & _deck_pending_sync_count
-- ===========================================================================

drop function if exists public._deck_pending_sync_count(bigint);

create or replace function public._deck_pending_sync_count(p_user_deck_id bigint)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    v_deck public.decks%rowtype;
    v_base public.decks%rowtype;
    v_added int; v_changed int; v_removed int; v_meta int := 0;
begin
    select * into v_deck from public.decks where id = p_user_deck_id;
    if not found or v_deck.base_deck_id is null then return 0; end if;

    select * into v_base from public.decks where id = v_deck.base_deck_id and user_id is null;
    if not found then return 0; end if;

    -- Pair mismatch: no pending sync count across different language pairs
    if v_deck.language_from <> v_base.language_from or v_deck.language_to <> v_base.language_to then
        return 0;
    end if;

    select count(*)::int into v_added
    from public.cards bc
    where bc.deck_id = v_base.id and bc.is_enabled and not bc.is_deleted and bc.generation_phase = 'refined'
      and not exists (
          select 1 from public.cards uc
          where uc.deck_id = v_deck.id and uc.base_card_id = bc.id
      );

    select count(*)::int into v_changed
    from public.cards uc
    join public.cards bc on bc.id = uc.base_card_id and bc.deck_id = v_base.id
    where uc.deck_id = v_deck.id
      and uc.is_enabled and not uc.is_deleted
      and bc.is_enabled and not bc.is_deleted and bc.generation_phase = 'refined'
      and public._card_content_hash(bc.*) is distinct from uc.base_version_hash
      and public._card_sync_content(bc.*) <> public._card_sync_content(uc.*);

    select count(*)::int into v_removed
    from public.cards uc
    where uc.deck_id = v_deck.id and uc.base_card_id is not null and uc.is_enabled and not uc.is_deleted
      and not exists (
          select 1 from public.cards bc
          where bc.id = uc.base_card_id and bc.deck_id = v_base.id
            and bc.is_enabled and not bc.is_deleted and bc.generation_phase = 'refined'
      );

    if v_deck.title is distinct from v_base.title
       or v_deck.description is distinct from v_base.description then
        v_meta := 1;
    end if;

    return v_added + v_changed + v_removed + v_meta;
end;
$$;

revoke execute on function public._deck_pending_sync_count(bigint) from anon, authenticated, public;

create or replace function public.get_deck_sync_status(p_deck_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_deck public.decks%rowtype;
    v_base public.decks%rowtype;
    v_added jsonb; v_changed jsonb; v_removed jsonb; v_meta jsonb := null;
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

    -- Pair mismatch guard
    if v_deck.language_from <> v_base.language_from or v_deck.language_to <> v_base.language_to then
        return jsonb_build_object('linked', false, 'pair_mismatch', true);
    end if;

    -- Fast-forward: user and market ended up with identical content but the
    -- stored baseline drifted. Re-baseline silently.
    update public.cards uc
    set base_version_hash = public._card_content_hash(bc.*)
    from public.cards bc
    where uc.deck_id = v_deck.id
      and bc.id = uc.base_card_id and bc.deck_id = v_base.id
      and not uc.is_deleted and not bc.is_deleted
      and public._card_sync_content(uc.*) = public._card_sync_content(bc.*)
      and uc.base_version_hash is distinct from public._card_content_hash(bc.*);

    select coalesce(jsonb_agg(jsonb_build_object(
        'base_card', public._preview_card_json(bc.id),
        'base_updated_at', bc.content_updated_at
    ) order by bc.section_name nulls last, bc.id), '[]'::jsonb)
    into v_added
    from public.cards bc
    where bc.deck_id = v_base.id and bc.is_enabled and not bc.is_deleted and bc.generation_phase = 'refined'
      and not exists (
          select 1 from public.cards uc
          where uc.deck_id = v_deck.id and uc.base_card_id = bc.id
      );

    select coalesce(jsonb_agg(jsonb_build_object(
        'base_card', public._preview_card_json(bc.id),
        'user_card', public._preview_card_json(uc.id),
        'locally_modified', public._card_content_hash(uc.*) is distinct from uc.base_version_hash,
        'base_updated_at', bc.content_updated_at
    ) order by bc.section_name nulls last, bc.id), '[]'::jsonb)
    into v_changed
    from public.cards uc
    join public.cards bc on bc.id = uc.base_card_id and bc.deck_id = v_base.id
    where uc.deck_id = v_deck.id
      and uc.is_enabled and not uc.is_deleted
      and bc.is_enabled and not bc.is_deleted and bc.generation_phase = 'refined'
      and public._card_content_hash(bc.*) is distinct from uc.base_version_hash;

    select coalesce(jsonb_agg(jsonb_build_object(
        'user_card', public._preview_card_json(uc.id)
    ) order by uc.section_name nulls last, uc.id), '[]'::jsonb)
    into v_removed
    from public.cards uc
    where uc.deck_id = v_deck.id and uc.base_card_id is not null and uc.is_enabled and not uc.is_deleted
      and not exists (
          select 1 from public.cards bc
          where bc.id = uc.base_card_id and bc.deck_id = v_base.id
            and bc.is_enabled and not bc.is_deleted and bc.generation_phase = 'refined'
      );

    if v_deck.title is distinct from v_base.title
       or v_deck.description is distinct from v_base.description then
        v_meta := jsonb_build_object(
            'mine',   jsonb_build_object('title', v_deck.title, 'description', v_deck.description),
            'market', jsonb_build_object('title', v_base.title, 'description', v_base.description)
        );
    end if;

    return jsonb_build_object(
        'linked', true,
        'deck_id', v_deck.id,
        'base_deck_id', v_base.id,
        'base_deck_title', v_base.title,
        'added', v_added,
        'changed', v_changed,
        'removed', v_removed,
        'deck_meta', v_meta,
        'total_updates', jsonb_array_length(v_added) + jsonb_array_length(v_changed)
            + jsonb_array_length(v_removed) + (case when v_meta is null then 0 else 1 end)
    );
end;
$$;

revoke execute on function public.get_deck_sync_status(bigint) from anon, public;
grant execute on function public.get_deck_sync_status(bigint) to authenticated;

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

    -- Reject cross-pair outgoing changes
    if v_deck.language_from <> v_base.language_from or v_deck.language_to <> v_base.language_to then
        return jsonb_build_object('linked', false, 'pair_mismatch', true);
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
-- 5. Schema reload notification
-- ===========================================================================

notify pgrst, 'reload schema';
