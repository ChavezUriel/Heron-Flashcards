-- ===========================================================================
-- 0027: Card Deletion & Proposals (Phase 1)
--
-- Adds soft deletion support (cards.is_deleted boolean not null default false).
--
-- Exposes:
--   1. delete_card(p_card_id bigint) -> jsonb
--      Soft-deletes a single card (is_deleted = true, is_enabled = false).
--      Clears practice queue for the deck and removes any review_undo entry.
--   2. delete_cards(p_card_ids bigint[]) -> jsonb
--      Bulk version of delete_card. Deduplicates IDs, validates authorization
--      wholesale, soft-deletes and disables all cards, clears practice queues
--      for affected decks, and cleans up review_undo.
--
-- Updates:
--   - get_deck_preview: Excludes deleted cards from the preview list,
--     counts outgoing removals for both disabled and soft-deleted cards.
--   - get_deck_outgoing_changes: Surfaces deleted or disabled cards in linked
--     decks as kind = 'remove' with is_deleted flag.
--   - create_deck_change_proposal: Allows proposing remove_card for deleted
--     or disabled linked cards; ignores deleted cards without market counterparts.
--   - resolve_deck_change_proposal: On approving remove_card, sets is_deleted = true
--     and is_enabled = false on the market card.
--   - get_deck_sync_status & _deck_pending_sync_count:
--       * added: only includes active live market cards with no counterpart
--         (soft-deleted local card prevents resurrection / ghost cards).
--       * changed: only checks active non-deleted cards.
--       * removed: detects market cards that were deleted, disabled, or removed.
--   - apply_deck_sync: When applying 'remove', sets is_deleted = true and
--     is_enabled = false on the local card.
--   - get_home_decks & get_market_decks & get_deck_cards_for_ai & _duplicate_base_deck_to_user:
--     Filter out deleted cards (and not is_deleted).
--   - update_card & update_card_visibility & update_cards_visibility:
--     Guard against modifying deleted cards without un-deleting.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Schema & Index
-- ---------------------------------------------------------------------------

alter table public.cards
    add column if not exists is_deleted boolean not null default false;

create index if not exists cards_deck_id_not_deleted_idx
    on public.cards (deck_id) where not is_deleted;

-- ---------------------------------------------------------------------------
-- 2. Card Preview JSON (include is_deleted)
-- ---------------------------------------------------------------------------

create or replace function public._preview_card_json(p_card_id bigint)
returns jsonb
language sql
stable
set search_path = ''
as $$
    select jsonb_build_object(
        'card_id', c.id,
        'prompt_es', c.spanish_text,
        'answer_en', c.english_text,
        'section_name', coalesce(c.section_name, d.title),
        'is_enabled', c.is_enabled,
        'is_deleted', c.is_deleted,
        'part_of_speech', c.part_of_speech,
        'definition_en', c.definition_en,
        'main_translations_es', coalesce(c.main_translations_es, '[]'::jsonb),
        'collocations', coalesce(c.collocations, '[]'::jsonb),
        'synonyms_en', coalesce(c.synonyms_en, '[]'::jsonb),
        'example_sentence', c.example_sentence,
        'example_es', c.example_es,
        'example_en', c.example_en,
        'mnemonic_en', c.mnemonic_en,
        'base_card_id', c.base_card_id
    )
    from public.cards c
    join public.decks d on d.id = c.deck_id
    where c.id = p_card_id;
$$;

-- ---------------------------------------------------------------------------
-- 3. Card Deletion Mutations (Single & Bulk)
-- ---------------------------------------------------------------------------

create or replace function public.delete_card(p_card_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_deck_id bigint;
    v_owner uuid;
    v_maintainer uuid;
begin
    if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;

    select c.deck_id, d.user_id, d.owner_id into v_deck_id, v_owner, v_maintainer
    from public.cards c
    join public.decks d on d.id = c.deck_id
    where c.id = p_card_id;

    if not found then raise exception 'Card not found'; end if;
    if not (coalesce(v_owner = v_uid, false)
            or (v_owner is null and coalesce(v_maintainer = v_uid, false))) then
        raise exception 'Not authorized to modify this card';
    end if;

    update public.cards
    set is_deleted = true, is_enabled = false
    where id = p_card_id;

    perform public._clear_pending_practice_cards_for_deck(v_deck_id);
    delete from public.review_undo where card_id = p_card_id;

    return jsonb_build_object(
        'card_id', p_card_id,
        'deck_id', v_deck_id,
        'is_deleted', true
    );
end;
$$;

create or replace function public.delete_cards(p_card_ids bigint[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_ids bigint[];
    v_found int;
    v_authorized int;
    v_deleted int;
    v_deck_id bigint;
begin
    if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;

    select coalesce(array_agg(distinct id), '{}'::bigint[])
    into v_ids
    from unnest(coalesce(p_card_ids, '{}'::bigint[])) as t(id);

    if cardinality(v_ids) = 0 then
        return jsonb_build_object('deleted_count', 0, 'is_deleted', true, 'card_ids', '[]'::jsonb);
    end if;

    select
        count(*),
        count(*) filter (
            where coalesce(d.user_id = v_uid, false)
               or (d.user_id is null and coalesce(d.owner_id = v_uid, false))
        )
    into v_found, v_authorized
    from public.cards c
    join public.decks d on d.id = c.deck_id
    where c.id = any(v_ids);

    if v_found <> cardinality(v_ids) then raise exception 'Card not found'; end if;
    if v_authorized <> v_found then raise exception 'Not authorized to modify this card'; end if;

    update public.cards
    set is_deleted = true, is_enabled = false
    where id = any(v_ids) and (not is_deleted or is_enabled);
    get diagnostics v_deleted = row_count;

    for v_deck_id in
        select distinct c.deck_id from public.cards c where c.id = any(v_ids)
    loop
        perform public._clear_pending_practice_cards_for_deck(v_deck_id);
    end loop;

    delete from public.review_undo where card_id = any(v_ids);

    return jsonb_build_object(
        'deleted_count', v_deleted,
        'is_deleted', true,
        'card_ids', to_jsonb(v_ids)
    );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Update Card & Visibility Guards
-- ---------------------------------------------------------------------------

create or replace function public.update_card_visibility(p_card_id bigint, p_is_enabled boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_deck_id bigint;
    v_owner uuid;
    v_maintainer uuid;
    v_is_deleted boolean;
begin
    if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;

    select c.deck_id, c.is_deleted, d.user_id, d.owner_id into v_deck_id, v_is_deleted, v_owner, v_maintainer
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

    update public.cards set is_enabled = p_is_enabled where id = p_card_id;

    if not p_is_enabled then
        perform public._clear_pending_practice_cards_for_deck(v_deck_id);
    end if;

    return jsonb_build_object('card_id', p_card_id, 'deck_id', v_deck_id, 'is_enabled', p_is_enabled);
end;
$$;

create or replace function public.update_cards_visibility(p_card_ids bigint[], p_is_enabled boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_ids bigint[];
    v_found int;
    v_authorized int;
    v_updated int;
    v_deck_id bigint;
begin
    if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;

    select coalesce(array_agg(distinct id), '{}'::bigint[])
    into v_ids
    from unnest(coalesce(p_card_ids, '{}'::bigint[])) as t(id);

    if cardinality(v_ids) = 0 then
        return jsonb_build_object('updated_count', 0, 'is_enabled', p_is_enabled, 'card_ids', '[]'::jsonb);
    end if;

    select
        count(*),
        count(*) filter (
            where coalesce(d.user_id = v_uid, false)
               or (d.user_id is null and coalesce(d.owner_id = v_uid, false))
        )
    into v_found, v_authorized
    from public.cards c
    join public.decks d on d.id = c.deck_id
    where c.id = any(v_ids);

    if v_found <> cardinality(v_ids) then raise exception 'Card not found'; end if;
    if v_authorized <> v_found then raise exception 'Not authorized to modify this card'; end if;

    if exists (select 1 from public.cards where id = any(v_ids) and is_deleted) then
        raise exception 'Cannot modify a deleted card';
    end if;

    update public.cards
    set is_enabled = p_is_enabled
    where id = any(v_ids) and is_enabled is distinct from p_is_enabled;
    get diagnostics v_updated = row_count;

    if not p_is_enabled and v_updated > 0 then
        for v_deck_id in
            select distinct c.deck_id from public.cards c where c.id = any(v_ids)
        loop
            perform public._clear_pending_practice_cards_for_deck(v_deck_id);
        end loop;
    end if;

    return jsonb_build_object(
        'updated_count', v_updated,
        'is_enabled', p_is_enabled,
        'card_ids', to_jsonb(v_ids)
    );
end;
$$;

create or replace function public.update_card(
    p_card_id bigint,
    p_prompt_es text,
    p_answer_en text,
    p_section_name text default null,
    p_part_of_speech text default null,
    p_definition_en text default null,
    p_main_translations_es text[] default '{}',
    p_collocations text[] default '{}',
    p_synonyms_en text[] default '{}',
    p_example_sentence text default null,
    p_example_es text default null,
    p_example_en text default null,
    p_mnemonic_en text default null,
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

    v_prompt := nullif(trim(p_prompt_es), '');
    v_answer := nullif(trim(p_answer_en), '');
    if v_prompt is null then raise exception 'prompt_es must be a non-empty string'; end if;
    if v_answer is null then raise exception 'answer_en must be a non-empty string'; end if;

    update public.cards set
        spanish_text = v_prompt,
        english_text = v_answer,
        section_name = nullif(trim(p_section_name), ''),
        part_of_speech = nullif(trim(p_part_of_speech), ''),
        definition_en = nullif(trim(p_definition_en), ''),
        main_translations_es = public._norm_text_items(p_main_translations_es),
        collocations = public._norm_text_items(p_collocations),
        synonyms_en = public._norm_text_items(p_synonyms_en),
        example_sentence = nullif(trim(p_example_sentence), ''),
        example_es = nullif(trim(p_example_es), ''),
        example_en = nullif(trim(p_example_en), ''),
        mnemonic_en = nullif(trim(p_mnemonic_en), ''),
        examples = case
            when p_examples is not null and jsonb_typeof(p_examples) = 'array' then p_examples
            else examples
        end
    where id = p_card_id;

    return public._preview_card_json(p_card_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Deck Preview & Outgoing Changes
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
        'open_proposals', v_open_proposals
    );
end;
$$;

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

    -- Edits: an enabled, non-deleted card whose content diverged from its market original.
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
      and uc.is_enabled and not uc.is_deleted
      and bc.is_enabled and not bc.is_deleted and bc.generation_phase = 'refined'
      and public._card_content_hash(uc.*) is distinct from uc.base_version_hash
      and public._card_sync_content(uc.*) <> public._card_sync_content(bc.*);

    -- Additions: an enabled, non-deleted card in this linked deck with no market counterpart.
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
      and uc.is_enabled and not uc.is_deleted
      and uc.generation_phase = 'refined';

    -- Removals: a market card you hid or deleted in your copy while it is still live in the market.
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
      and (uc.is_deleted or not uc.is_enabled)
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

-- ---------------------------------------------------------------------------
-- 6. Proposal Creation & Resolution
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
            if v_uc.is_deleted or not v_uc.is_enabled then
                -- You hid or deleted a market card: propose removing it. Skip when the
                -- market card is already gone/disabled/deleted.
                if not (v_bc.is_enabled and not v_bc.is_deleted and v_bc.generation_phase = 'refined') then
                    continue;
                end if;
                insert into public.deck_change_proposal_items
                    (proposal_id, change_type, base_card_id, source_card_id, payload, base_snapshot)
                values
                    (v_proposal_id, 'remove_card', v_bc.id, v_uc.id,
                     null, public._card_sync_content(v_bc));
            elsif public._card_sync_content(v_uc) = public._card_sync_content(v_bc) then
                -- Enabled, not deleted, and identical to the market card: nothing to propose.
                continue;
            else
                insert into public.deck_change_proposal_items
                    (proposal_id, change_type, base_card_id, source_card_id, payload, base_snapshot)
                values
                    (v_proposal_id, 'edit_card', v_bc.id, v_uc.id,
                     public._card_sync_content(v_uc), public._card_sync_content(v_bc));
            end if;
        else
            -- No market counterpart. A hidden or deleted personal card has nothing to add.
            if v_uc.is_deleted or not v_uc.is_enabled then
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
                    spanish_text = coalesce(nullif(trim(v_item.payload ->> 'spanish_text'), ''), spanish_text),
                    english_text = coalesce(nullif(trim(v_item.payload ->> 'english_text'), ''), english_text),
                    section_name = nullif(trim(coalesce(v_item.payload ->> 'section_name', '')), ''),
                    part_of_speech = nullif(trim(coalesce(v_item.payload ->> 'part_of_speech', '')), ''),
                    definition_en = nullif(trim(coalesce(v_item.payload ->> 'definition_en', '')), ''),
                    main_translations_es = coalesce(v_item.payload -> 'main_translations_es', '[]'::jsonb),
                    collocations = coalesce(v_item.payload -> 'collocations', '[]'::jsonb),
                    synonyms_en = coalesce(v_item.payload -> 'synonyms_en', '[]'::jsonb),
                    example_sentence = nullif(trim(coalesce(v_item.payload ->> 'example_sentence', '')), ''),
                    example_es = nullif(trim(coalesce(v_item.payload ->> 'example_es', '')), ''),
                    example_en = nullif(trim(coalesce(v_item.payload ->> 'example_en', '')), ''),
                    mnemonic_en = nullif(trim(coalesce(v_item.payload ->> 'mnemonic_en', '')), '')
                where id = v_bc.id;
                v_applied := v_applied + 1;

            elsif v_item.change_type = 'add_card' then
                if nullif(trim(coalesce(v_item.payload ->> 'spanish_text', '')), '') is null
                   or nullif(trim(coalesce(v_item.payload ->> 'english_text', '')), '') is null then
                    v_skipped := v_skipped || jsonb_build_object('item_id', v_item.id, 'reason', 'invalid_payload');
                    continue;
                end if;
                insert into public.cards (
                    deck_id, spanish_text, english_text, is_enabled, is_deleted, generation_phase,
                    generation_metadata, section_name, part_of_speech, definition_en,
                    main_translations_es, collocations, synonyms_en, example_sentence,
                    example_es, example_en, mnemonic_en
                )
                values (
                    v_proposal.market_deck_id,
                    trim(v_item.payload ->> 'spanish_text'),
                    trim(v_item.payload ->> 'english_text'),
                    true, false, 'refined', '{}'::jsonb,
                    nullif(trim(coalesce(v_item.payload ->> 'section_name', '')), ''),
                    nullif(trim(coalesce(v_item.payload ->> 'part_of_speech', '')), ''),
                    nullif(trim(coalesce(v_item.payload ->> 'definition_en', '')), ''),
                    coalesce(v_item.payload -> 'main_translations_es', '[]'::jsonb),
                    coalesce(v_item.payload -> 'collocations', '[]'::jsonb),
                    coalesce(v_item.payload -> 'synonyms_en', '[]'::jsonb),
                    nullif(trim(coalesce(v_item.payload ->> 'example_sentence', '')), ''),
                    nullif(trim(coalesce(v_item.payload ->> 'example_es', '')), ''),
                    nullif(trim(coalesce(v_item.payload ->> 'example_en', '')), ''),
                    nullif(trim(coalesce(v_item.payload ->> 'mnemonic_en', '')), '')
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

-- ---------------------------------------------------------------------------
-- 7. Sync Status & Apply
-- ---------------------------------------------------------------------------

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
                deck_id, spanish_text, english_text, is_enabled, is_deleted, generation_phase,
                generation_metadata, section_name, part_of_speech, definition_en,
                main_translations_es, collocations, synonyms_en, example_sentence,
                example_es, example_en, mnemonic_en, examples, cloze_distractors_en, base_card_id, base_version_hash
            )
            values (
                v_deck.id, v_bc.spanish_text, v_bc.english_text, true, false, v_bc.generation_phase,
                v_bc.generation_metadata, v_bc.section_name, v_bc.part_of_speech, v_bc.definition_en,
                v_bc.main_translations_es, v_bc.collocations, v_bc.synonyms_en, v_bc.example_sentence,
                v_bc.example_es, v_bc.example_en, v_bc.mnemonic_en, v_bc.examples, v_bc.cloze_distractors_en, v_bc.id, public._card_content_hash(v_bc)
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
            select * into v_bc from public.cards
            where id = v_uc.base_card_id and deck_id = v_base.id
              and is_enabled and not is_deleted and generation_phase = 'refined';
            if not found then
                v_skipped := v_skipped || jsonb_build_object('item', v_item, 'reason', 'market_card_missing');
                continue;
            end if;
            update public.cards set
                spanish_text = v_bc.spanish_text,
                english_text = v_bc.english_text,
                section_name = v_bc.section_name,
                part_of_speech = v_bc.part_of_speech,
                definition_en = v_bc.definition_en,
                main_translations_es = v_bc.main_translations_es,
                collocations = v_bc.collocations,
                synonyms_en = v_bc.synonyms_en,
                example_sentence = v_bc.example_sentence,
                example_es = v_bc.example_es,
                example_en = v_bc.example_en,
                mnemonic_en = v_bc.mnemonic_en,
                examples = coalesce(v_bc.examples, examples),
                cloze_distractors_en = coalesce(v_bc.cloze_distractors_en, cloze_distractors_en),
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

-- ---------------------------------------------------------------------------
-- 8. Deck Queries & AI Cards & Base Cloning (filter is_deleted)
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
    if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;

    select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]'::jsonb)
    into v_result
    from (
        select
            d.id, d.slug, d.title, d.description,
            d.is_selected_on_home, d.is_enabled_in_smart_practice,
            d.base_deck_id,
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
        left join public.cards c on c.deck_id = d.id and c.is_enabled and not c.is_deleted and c.generation_phase = 'refined'
        left join public.card_progress cp on cp.card_id = c.id
        where d.is_selected_on_home and d.user_id = v_uid
        group by d.id
    ) t;

    return v_result;
end;
$$;

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

create or replace function public.get_deck_progress(p_deck_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_total int; v_reviewed int; v_known int; v_unknown int;
begin
    if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;

    if not exists (
        select 1 from public.decks
        where id = p_deck_id and is_selected_on_home and user_id = v_uid
    ) then
        raise exception 'Deck not found or not on home';
    end if;

    select
        count(c.id)::int,
        coalesce(sum(case when cp.last_result is not null then 1 else 0 end), 0)::int,
        coalesce(sum(case when cp.last_result = 'known' then 1 else 0 end), 0)::int,
        coalesce(sum(case when cp.last_result = 'unknown' then 1 else 0 end), 0)::int
    into v_total, v_reviewed, v_known, v_unknown
    from public.cards c
    left join public.card_progress cp on cp.card_id = c.id
    where c.deck_id = p_deck_id and c.is_enabled and not c.is_deleted and c.generation_phase = 'refined';

    return jsonb_build_object(
        'deck_id', p_deck_id,
        'total_cards', v_total,
        'reviewed_cards', v_reviewed,
        'known_cards', v_known,
        'unknown_cards', v_unknown,
        'completion_ratio', case when v_total > 0 then v_reviewed::float / v_total else 0 end,
        'is_completed', (v_total > 0 and v_known = v_total)
    );
end;
$$;

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
            'spanish_text', c.spanish_text,
            'english_text', c.english_text,
            'section_name', coalesce(c.section_name, d.title),
            'is_enabled', c.is_enabled,
            'part_of_speech', c.part_of_speech,
            'definition_en', c.definition_en,
            'main_translations_es', coalesce(c.main_translations_es, '[]'::jsonb),
            'collocations', coalesce(c.collocations, '[]'::jsonb),
            'synonyms_en', coalesce(c.synonyms_en, '[]'::jsonb),
            'example_sentence', c.example_sentence,
            'example_es', c.example_es,
            'example_en', c.example_en,
            'mnemonic_en', c.mnemonic_en,
            'examples', coalesce(
                case when jsonb_array_length(coalesce(c.examples, '[]'::jsonb)) > 0
                     then c.examples
                     else (
                         select bc.examples
                         from public.cards bc
                         where bc.id = c.base_card_id
                           and lower(trim(bc.english_text)) = lower(trim(c.english_text))
                           and not bc.is_deleted
                           and jsonb_array_length(coalesce(bc.examples, '[]'::jsonb)) > 0
                     )
                end, '[]'::jsonb),
            'cloze_distractors_en', coalesce(
                case when jsonb_array_length(coalesce(c.cloze_distractors_en, '[]'::jsonb)) > 0
                     then c.cloze_distractors_en
                     else (
                         select bc.cloze_distractors_en
                         from public.cards bc
                         where bc.id = c.base_card_id
                           and lower(trim(bc.english_text)) = lower(trim(c.english_text))
                           and not bc.is_deleted
                           and jsonb_array_length(coalesce(bc.cloze_distractors_en, '[]'::jsonb)) > 0
                     )
                end, '[]'::jsonb),
            'generation_metadata', coalesce(c.generation_metadata, '{}'::jsonb)
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

-- ---------------------------------------------------------------------------
-- 9. Grants
-- ---------------------------------------------------------------------------

revoke execute on function public.delete_card(bigint) from public, anon;
grant execute on function public.delete_card(bigint) to authenticated;

revoke execute on function public.delete_cards(bigint[]) from public, anon;
grant execute on function public.delete_cards(bigint[]) to authenticated;

notify pgrst, 'reload schema';
