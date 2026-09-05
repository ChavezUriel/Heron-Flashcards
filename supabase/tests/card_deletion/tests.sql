-- ===========================================================================
-- Tests for migration 0027: Card Deletion & Proposals
-- ===========================================================================
\set ON_ERROR_STOP on

-- Create test users
insert into auth.users (id, email, raw_user_meta_data) values
    ('11111111-1111-1111-1111-111111111111', 'alice@test.dev', '{"full_name":"Alice"}'),
    ('22222222-2222-2222-2222-222222222222', 'bob@test.dev',   '{"full_name":"Bob"}'),
    ('33333333-3333-3333-3333-333333333333', 'carol@test.dev', '{"full_name":"Carol"}')
on conflict (id) do nothing;

insert into public.profiles (id, full_name) values
    ('11111111-1111-1111-1111-111111111111', 'Alice'),
    ('22222222-2222-2222-2222-222222222222', 'Bob'),
    ('33333333-3333-3333-3333-333333333333', 'Carol')
on conflict (id) do update set full_name = excluded.full_name;

-- ---------------------------------------------------------------------------
-- Setup Fixtures
-- ---------------------------------------------------------------------------

-- Alice's personal unlinked deck (5 cards)
insert into public.decks (slug, title, description, user_id, is_selected_on_home, is_enabled_in_smart_practice)
values ('alice-personal', 'Alice Personal Deck', 'Personal', '11111111-1111-1111-1111-111111111111', true, true);

insert into public.cards (deck_id, l1_text, l2_text, generation_phase)
select d.id, v.es, v.en, 'refined'
from public.decks d,
(values ('uno','one'),('dos','two'),('tres','three'),('cuatro','four'),('cinco','five')) as v(es,en)
where d.slug = 'alice-personal';

-- Market deck maintained by Carol (user_id null, owner_id Carol, 3 cards)
insert into public.decks (slug, title, description, user_id, owner_id)
values ('market-fruits', 'Market Fruits', 'Public fruits deck', null, '33333333-3333-3333-3333-333333333333');

insert into public.cards (deck_id, l1_text, l2_text, generation_phase)
select d.id, v.es, v.en, 'refined'
from public.decks d,
(values ('la manzana','apple'),('el platano','banana'),('la naranja','orange')) as v(es,en)
where d.slug = 'market-fruits';

-- Helper functions
create or replace function pg_temp.alice_personal_ids() returns bigint[] language sql as $$
    select array_agg(c.id order by c.id) from public.cards c
    join public.decks d on d.id = c.deck_id where d.slug = 'alice-personal';
$$;

create or replace function pg_temp.market_fruits_ids() returns bigint[] language sql as $$
    select array_agg(c.id order by c.id) from public.cards c
    join public.decks d on d.id = c.deck_id where d.slug = 'market-fruits';
$$;

create or replace function pg_temp.ok(p_label text, p_cond boolean) returns void language plpgsql as $$
begin
    if p_cond then raise notice 'PASS %', p_label;
    else raise exception 'FAIL %', p_label; end if;
end $$;

-- ===========================================================================
-- Test 1: Unauthenticated & Unauthorized Rejection
-- ===========================================================================
do $$
declare
    v_ids bigint[] := pg_temp.alice_personal_ids();
    v_card_id bigint := v_ids[1];
begin
    -- 1.1 Unauthenticated delete_card rejected
    perform set_config('app.uid', '', false);
    begin
        perform public.delete_card(v_card_id);
        raise exception 'FAIL 1.1: expected unauth rejection';
    exception when sqlstate '28000' then
        perform pg_temp.ok('1.1 unauth delete_card rejected', true);
    end;

    -- 1.2 Unauthenticated delete_cards rejected
    begin
        perform public.delete_cards(v_ids);
        raise exception 'FAIL 1.2: expected unauth rejection';
    exception when sqlstate '28000' then
        perform pg_temp.ok('1.2 unauth delete_cards rejected', true);
    end;

    -- 1.3 Bob (unauthorized) cannot delete Alice's card
    perform set_config('app.uid', '22222222-2222-2222-2222-222222222222', false);
    begin
        perform public.delete_card(v_card_id);
        raise exception 'FAIL 1.3: expected unauthorized rejection';
    exception when others then
        if sqlerrm not like '%Not authorized%' then raise; end if;
        perform pg_temp.ok('1.3 unauthorized delete_card rejected', true);
    end;

    -- 1.4 Bob cannot bulk delete Alice's cards
    begin
        perform public.delete_cards(v_ids);
        raise exception 'FAIL 1.4: expected unauthorized rejection';
    exception when others then
        if sqlerrm not like '%Not authorized%' then raise; end if;
        perform pg_temp.ok('1.4 unauthorized delete_cards rejected', true);
    end;

    -- 1.5 Mixed batch (Alice's card + Market card Bob does not maintain) fails wholesale
    begin
        perform public.delete_cards(v_ids || pg_temp.market_fruits_ids());
        raise exception 'FAIL 1.5: expected unauthorized rejection on mixed batch';
    exception when others then
        if sqlerrm not like '%Not authorized%' then raise; end if;
        perform pg_temp.ok('1.5 unauthorized mixed batch rejected', true);
    end;

    -- 1.6 Missing card ID fails
    perform set_config('app.uid', '11111111-1111-1111-1111-111111111111', false);
    begin
        perform public.delete_card(999999999);
        raise exception 'FAIL 1.6: expected not found';
    exception when others then
        if sqlerrm not like '%Card not found%' then raise; end if;
        perform pg_temp.ok('1.6 missing card rejected', true);
    end;
end $$;

-- ===========================================================================
-- Test 2: Single Card Deletion on Personal Deck
-- ===========================================================================
do $$
declare
    v_ids bigint[] := pg_temp.alice_personal_ids();
    v_card_id bigint := v_ids[1];
    v_deck_id bigint;
    v_res jsonb;
    v_card public.cards%rowtype;
    v_preview jsonb;
    v_home jsonb;
    v_deck_entry jsonb;
begin
    perform set_config('app.uid', '11111111-1111-1111-1111-111111111111', false);
    select deck_id into v_deck_id from public.cards where id = v_card_id;

    -- Add review_undo entry for this card
    insert into public.review_undo (user_id, card_id, card_progress_before, created_at)
    values ('11111111-1111-1111-1111-111111111111', v_card_id, '{}'::jsonb, now())
    on conflict (user_id) do update set card_id = excluded.card_id;

    -- Perform single delete
    v_res := public.delete_card(v_card_id);
    perform pg_temp.ok('2.1 delete_card returns is_deleted true', (v_res->>'is_deleted')::boolean = true);
    perform pg_temp.ok('2.2 delete_card returns correct card_id', (v_res->>'card_id')::bigint = v_card_id);

    -- Verify cards table state
    select * into v_card from public.cards where id = v_card_id;
    perform pg_temp.ok('2.3 is_deleted column is true', v_card.is_deleted = true);
    perform pg_temp.ok('2.4 is_enabled column is false', v_card.is_enabled = false);

    -- Verify review_undo entry cleared
    perform pg_temp.ok('2.5 review_undo cleared for deleted card',
        not exists (select 1 from public.review_undo where card_id = v_card_id));

    -- Verify get_deck_preview excludes deleted card
    v_preview := public.get_deck_preview(v_deck_id);
    perform pg_temp.ok('2.6 total_cards in preview is 4', (v_preview->>'total_cards')::int = 4);
    perform pg_temp.ok('2.7 preview cards array length is 4', jsonb_array_length(v_preview->'cards') = 4);
    perform pg_temp.ok('2.8 deleted card not in preview cards array',
        not exists (
            select 1 from jsonb_array_elements(v_preview->'cards') elem
            where (elem->>'card_id')::bigint = v_card_id
        ));

    -- Verify get_home_decks reports total_cards = 4
    v_home := public.get_home_decks();
    select d.value into v_deck_entry from jsonb_array_elements(v_home) d where (d.value->>'id')::bigint = v_deck_id;
    perform pg_temp.ok('2.9 home decks total_cards is 4', (v_deck_entry->>'total_cards')::int = 4);

    -- Verify cannot edit deleted card with update_card
    begin
        perform public.update_card(v_card_id, 'uno editado', 'one edited');
        raise exception 'FAIL 2.10: expected rejection editing deleted card';
    exception when others then
        if sqlerrm not like '%Cannot modify a deleted card%' then raise; end if;
        perform pg_temp.ok('2.10 update_card on deleted card rejected', true);
    end;

    -- Verify cannot modify visibility of deleted card
    begin
        perform public.update_card_visibility(v_card_id, true);
        raise exception 'FAIL 2.11: expected rejection modifying visibility of deleted card';
    exception when others then
        if sqlerrm not like '%Cannot modify a deleted card%' then raise; end if;
        perform pg_temp.ok('2.11 update_card_visibility on deleted card rejected', true);
    end;
end $$;

-- ===========================================================================
-- Test 3: Bulk Card Deletion on Personal Deck
-- ===========================================================================
do $$
declare
    v_ids bigint[] := pg_temp.alice_personal_ids();
    v_to_delete bigint[] := array[v_ids[2], v_ids[3]]; -- delete 2 cards
    v_res jsonb;
    v_deck_id bigint;
    v_session bigint;
    v_pending int;
begin
    perform set_config('app.uid', '11111111-1111-1111-1111-111111111111', false);
    select id into v_deck_id from public.decks where slug = 'alice-personal';

    -- Seed practice session with pending cards
    insert into public.practice_sessions
        (user_id, status, mode, focus_mode, new_block_size, review_batch_size)
    values ('11111111-1111-1111-1111-111111111111', 'active', 'review', 'auto', 5, 10)
    returning id into v_session;

    insert into public.practice_session_cards (session_id, card_id, queue_position, status)
    select v_session, c.id, row_number() over (order by c.id), 'pending'
    from public.cards c where c.deck_id = v_deck_id and not c.is_deleted;

    select count(*) into v_pending from public.practice_session_cards
    where session_id = v_session and status = 'pending';
    perform pg_temp.ok('3.1 queue seeded before bulk delete', v_pending = 4);

    -- Perform bulk delete of 2 cards (including duplicates in array to test deduping)
    v_res := public.delete_cards(v_to_delete || v_to_delete);
    perform pg_temp.ok('3.2 bulk delete deleted_count = 2', (v_res->>'deleted_count')::int = 2);
    perform pg_temp.ok('3.3 bulk delete card_ids deduplicated to length 2', jsonb_array_length(v_res->'card_ids') = 2);
    perform pg_temp.ok('3.4 bulk delete is_deleted echoed', (v_res->>'is_deleted')::boolean = true);

    -- Practice queue cleared for affected deck
    select count(*) into v_pending from public.practice_session_cards
    where session_id = v_session and status = 'pending';
    perform pg_temp.ok('3.5 pending practice queue cleared', v_pending = 0);
    perform pg_temp.ok('3.6 session marked completed',
        (select status from public.practice_sessions where id = v_session) = 'completed');

    -- Remaining active cards count in deck is 2
    perform pg_temp.ok('3.7 active cards remaining is 2',
        (select count(*) from public.cards where deck_id = v_deck_id and not is_deleted) = 2);

    -- Empty array no-op
    v_res := public.delete_cards('{}'::bigint[]);
    perform pg_temp.ok('3.8 empty array no-op', (v_res->>'deleted_count')::int = 0);
end $$;

-- ===========================================================================
-- Test 4: Cloned/Linked Deck Deletion & Outgoing Changes
-- ===========================================================================
do $$
declare
    alice constant uuid := '11111111-1111-1111-1111-111111111111';
    carol constant uuid := '33333333-3333-3333-3333-333333333333';
    v_market_id bigint;
    v_alice_deck_id bigint;
    v_manzana_user_id bigint;
    v_platano_user_id bigint;
    v_naranja_user_id bigint;
    v_outgoing jsonb;
    v_remove_item jsonb;
    v_preview jsonb;
begin
    select id into v_market_id from public.decks where slug = 'market-fruits';

    -- Alice subscribes to Market Fruits (clones the deck)
    perform set_config('app.uid', alice::text, false);
    perform public.update_deck_home_selection(v_market_id, true);

    select id into v_alice_deck_id from public.decks
    where user_id = alice and base_deck_id = v_market_id;
    perform pg_temp.ok('4.1 Alice cloned market deck', v_alice_deck_id is not null);

    -- Alice has 3 cards in her copy
    select id into v_manzana_user_id from public.cards where deck_id = v_alice_deck_id and l1_text = 'la manzana';
    select id into v_platano_user_id from public.cards where deck_id = v_alice_deck_id and l1_text = 'el platano';
    select id into v_naranja_user_id from public.cards where deck_id = v_alice_deck_id and l1_text = 'la naranja';

    -- Initially no outgoing changes
    v_outgoing := public.get_deck_outgoing_changes(v_alice_deck_id);
    perform pg_temp.ok('4.2 initial outgoing changes is 0', jsonb_array_length(v_outgoing->'changes') = 0);

    -- Alice deletes 'la manzana' in her copy
    perform public.delete_card(v_manzana_user_id);

    -- Check get_deck_outgoing_changes: should surface as kind = 'remove' with is_deleted = true
    v_outgoing := public.get_deck_outgoing_changes(v_alice_deck_id);
    perform pg_temp.ok('4.3 outgoing changes has 1 item', jsonb_array_length(v_outgoing->'changes') = 1);
    v_remove_item := v_outgoing->'changes'->0;
    perform pg_temp.ok('4.4 change kind is remove', v_remove_item->>'kind' = 'remove');
    perform pg_temp.ok('4.5 change is_deleted is true', (v_remove_item->>'is_deleted')::boolean = true);
    perform pg_temp.ok('4.6 user_card preview is present', v_remove_item->'user_card' is not null);
    perform pg_temp.ok('4.7 base_card preview is present', v_remove_item->'base_card' is not null);

    -- Alice also disables (hides) 'el platano'
    perform public.update_card_visibility(v_platano_user_id, false);

    -- Under 0032, hiding a card is not proposable, so outgoing changes remains 1
    v_outgoing := public.get_deck_outgoing_changes(v_alice_deck_id);
    perform pg_temp.ok('4.8 outgoing changes has 1 item', jsonb_array_length(v_outgoing->'changes') = 1);

    -- Deck preview counts outgoing changes as 1
    v_preview := public.get_deck_preview(v_alice_deck_id);
    perform pg_temp.ok('4.9 preview outgoing_changes is 1', (v_preview->>'outgoing_changes')::int = 1);
    perform pg_temp.ok('4.10 preview total_cards is 2 (excluding deleted card)', (v_preview->>'total_cards')::int = 2);
end $$;

-- ===========================================================================
-- Test 5: Proposal with Deleted Card (remove_card) & Approval
-- ===========================================================================
do $$
declare
    alice constant uuid := '11111111-1111-1111-1111-111111111111';
    carol constant uuid := '33333333-3333-3333-3333-333333333333';
    v_market_id bigint;
    v_alice_deck_id bigint;
    v_manzana_user_id bigint;
    v_manzana_market_id bigint;
    v_proposal_res jsonb;
    v_proposal_id bigint;
    v_resolve_res jsonb;
    v_market_card public.cards%rowtype;
    v_market_preview jsonb;
begin
    select id into v_market_id from public.decks where slug = 'market-fruits';
    select id into v_alice_deck_id from public.decks where user_id = alice and base_deck_id = v_market_id;
    select id into v_manzana_user_id from public.cards where deck_id = v_alice_deck_id and l1_text = 'la manzana';
    select id into v_manzana_market_id from public.cards where deck_id = v_market_id and l1_text = 'la manzana';

    -- Alice proposes removal of 'la manzana'
    perform set_config('app.uid', alice::text, false);
    v_proposal_res := public.create_deck_change_proposal(
        v_market_id,
        'Remove apple from market fruits',
        array[v_manzana_user_id]
    );
    v_proposal_id := (v_proposal_res->>'proposal_id')::bigint;
    perform pg_temp.ok('5.1 proposal created', v_proposal_id is not null);
    perform pg_temp.ok('5.2 proposal item is remove_card',
        v_proposal_res->'items'->0->>'change_type' = 'remove_card');

    -- Carol (market deck maintainer) resolves and approves the proposal
    perform set_config('app.uid', carol::text, false);
    v_resolve_res := public.resolve_deck_change_proposal(v_proposal_id, 'approve', 'Agreed, removing apple.');
    perform pg_temp.ok('5.3 proposal approved', (v_resolve_res->'proposal'->>'status') = 'approved');
    perform pg_temp.ok('5.4 1 item applied', (v_resolve_res->>'applied')::int = 1);

    -- Market card is now soft-deleted (is_deleted = true, is_enabled = false)
    select * into v_market_card from public.cards where id = v_manzana_market_id;
    perform pg_temp.ok('5.5 market card is_deleted = true', v_market_card.is_deleted = true);
    perform pg_temp.ok('5.6 market card is_enabled = false', v_market_card.is_enabled = false);

    -- Market deck preview excludes the deleted card (total_cards = 2)
    v_market_preview := public.get_deck_preview(v_market_id);
    perform pg_temp.ok('5.7 market deck preview total_cards is 2', (v_market_preview->>'total_cards')::int = 2);
end $$;

-- ===========================================================================
-- Test 6: Subscriber Sync Status & Apply Removal & No Ghost Card Bug
-- ===========================================================================
do $$
declare
    bob constant uuid := '22222222-2222-2222-2222-222222222222';
    alice constant uuid := '11111111-1111-1111-1111-111111111111';
    v_market_id bigint;
    v_bob_deck_id bigint;
    v_alice_deck_id bigint;
    v_manzana_bob_id bigint;
    v_sync_status jsonb;
    v_apply_res jsonb;
    v_bob_manzana public.cards%rowtype;
begin
    select id into v_market_id from public.decks where slug = 'market-fruits';

    -- Bob subscribes to Market Fruits (already has apple deleted in market, but let's test fresh clone first)
    -- In market: manzana is deleted, platano is live, naranja is live.
    -- When Bob clones now, fresh clone only gets platano and naranja (2 cards).
    perform set_config('app.uid', bob::text, false);
    perform public.update_deck_home_selection(v_market_id, true);
    select id into v_bob_deck_id from public.decks where user_id = bob and base_deck_id = v_market_id;
    perform pg_temp.ok('6.1 fresh clone for Bob has 2 cards',
        (select count(*) from public.cards where deck_id = v_bob_deck_id and not is_deleted) = 2);

    -- Now let's test a subscriber who ALREADY had the card before market deleted it:
    -- Alice's deck: she had deleted it locally, so her copy is already is_deleted = true.
    -- Let's check Alice's sync status:
    -- 'la manzana' is deleted in market AND deleted in Alice's copy.
    -- It must NOT appear in 'added' (no resurrection / ghost card bug).
    perform set_config('app.uid', alice::text, false);
    select id into v_alice_deck_id from public.decks where user_id = alice and base_deck_id = v_market_id;
    v_sync_status := public.get_deck_sync_status(v_alice_deck_id);
    perform pg_temp.ok('6.2 Alice added cards array is empty (no ghost card)',
        jsonb_array_length(v_sync_status->'added') = 0);

    -- Now create a third subscriber (e.g. Bob's second copy or manually insert a live card linked to manzana in Bob's deck)
    -- to test apply_deck_sync applying 'remove'
    insert into public.cards (deck_id, l1_text, l2_text, is_enabled, is_deleted, generation_phase, base_card_id)
    values (v_bob_deck_id, 'la manzana', 'apple', true, false, 'refined',
            (select id from public.cards where deck_id = v_market_id and l1_text = 'la manzana'))
    returning id into v_manzana_bob_id;

    perform set_config('app.uid', bob::text, false);
    v_sync_status := public.get_deck_sync_status(v_bob_deck_id);
    perform pg_temp.ok('6.3 Bob sees removed card in sync status',
        jsonb_array_length(v_sync_status->'removed') = 1);
    perform pg_temp.ok('6.4 removed card id matches Bob manzana',
        (v_sync_status->'removed'->0->'user_card'->>'card_id')::bigint = v_manzana_bob_id);

    -- Bob applies the removal sync
    v_apply_res := public.apply_deck_sync(v_bob_deck_id, jsonb_build_array(
        jsonb_build_object('type', 'remove', 'card_id', v_manzana_bob_id)
    ));
    perform pg_temp.ok('6.5 apply_deck_sync applied 1 removal', (v_apply_res->>'applied')::int = 1);

    select * into v_bob_manzana from public.cards where id = v_manzana_bob_id;
    perform pg_temp.ok('6.6 Bob card is marked is_deleted = true', v_bob_manzana.is_deleted = true);
    perform pg_temp.ok('6.7 Bob card is marked is_enabled = false', v_bob_manzana.is_enabled = false);

    -- Verify sync status is now clean and manzana is NOT resurrected in added
    v_sync_status := public.get_deck_sync_status(v_bob_deck_id);
    perform pg_temp.ok('6.8 total updates is 0 after sync apply', (v_sync_status->>'total_updates')::int = 0);
    perform pg_temp.ok('6.9 added array remains 0 (no ghost card)', jsonb_array_length(v_sync_status->'added') = 0);
end $$;

-- ===========================================================================
-- Test 7: Function Permissions (Grants)
-- ===========================================================================
do $$
begin
    perform pg_temp.ok('7.1 anon has no execute on delete_card',
        not has_function_privilege('anon', 'public.delete_card(bigint)', 'execute'));
    perform pg_temp.ok('7.2 authenticated has execute on delete_card',
        has_function_privilege('authenticated', 'public.delete_card(bigint)', 'execute'));

    perform pg_temp.ok('7.3 anon has no execute on delete_cards',
        not has_function_privilege('anon', 'public.delete_cards(bigint[])', 'execute'));
    perform pg_temp.ok('7.4 authenticated has execute on delete_cards',
        has_function_privilege('authenticated', 'public.delete_cards(bigint[])', 'execute'));
end $$;

select 'ALL CARD DELETION TESTS PASSED' as result;
