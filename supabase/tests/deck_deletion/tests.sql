-- ===========================================================================
-- Tests for migration 0030: Personal Deck Deletion & Origin Classification
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

-- Alice's personal standalone deck
insert into public.decks (slug, title, description, user_id, is_selected_on_home, is_enabled_in_smart_practice)
values ('alice-deck-delete-test', 'Alice Deck To Delete', 'Personal Deck to be deleted', '11111111-1111-1111-1111-111111111111', true, true);

insert into public.cards (deck_id, spanish_text, english_text, generation_phase)
select d.id, v.es, v.en, 'refined'
from public.decks d,
(values ('cero','zero'),('uno','one'),('dos','two')) as v(es,en)
where d.slug = 'alice-deck-delete-test';

-- Public Market Deck maintained by Carol
insert into public.decks (slug, title, description, user_id, owner_id)
values ('market-colors', 'Market Colors', 'Public colors deck', null, '33333333-3333-3333-3333-333333333333');

insert into public.cards (deck_id, spanish_text, english_text, generation_phase)
select d.id, v.es, v.en, 'refined'
from public.decks d,
(values ('rojo','red'),('azul','blue'),('verde','green')) as v(es,en)
where d.slug = 'market-colors';

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
    v_alice_deck_id bigint;
    v_market_deck_id bigint;
begin
    select id into v_alice_deck_id from public.decks where slug = 'alice-deck-delete-test';
    select id into v_market_deck_id from public.decks where slug = 'market-colors';

    -- 1.1 Unauthenticated delete rejected
    perform set_config('app.uid', '', false);
    begin
        perform public.delete_personal_deck(v_alice_deck_id);
        raise exception 'FAIL 1.1: expected unauth rejection';
    exception when sqlstate '28000' then
        perform pg_temp.ok('1.1 unauth delete_personal_deck rejected', true);
    end;

    -- 1.2 Bob cannot delete Alice's deck
    perform set_config('app.uid', '22222222-2222-2222-2222-222222222222', false);
    begin
        perform public.delete_personal_deck(v_alice_deck_id);
        raise exception 'FAIL 1.2: expected unauthorized rejection';
    exception when others then
        if sqlerrm not like '%Deck not found or not authorized%' then raise; end if;
        perform pg_temp.ok('1.2 unauthorized delete_personal_deck rejected', true);
    end;

    -- 1.3 Cannot delete a public market deck directly with delete_personal_deck
    perform set_config('app.uid', '33333333-3333-3333-3333-333333333333', false);
    begin
        perform public.delete_personal_deck(v_market_deck_id);
        raise exception 'FAIL 1.3: expected rejection deleting market deck with delete_personal_deck';
    exception when others then
        if sqlerrm not like '%Deck not found or not authorized%' then raise; end if;
        perform pg_temp.ok('1.3 market deck delete rejected', true);
    end;
end $$;

-- ===========================================================================
-- Test 2: Alice deletes her personal deck
-- ===========================================================================
do $$
declare
    v_alice_deck_id bigint;
    v_card_ids bigint[];
    v_res jsonb;
    v_home jsonb;
begin
    perform set_config('app.uid', '11111111-1111-1111-1111-111111111111', false);
    select id into v_alice_deck_id from public.decks where slug = 'alice-deck-delete-test';
    select array_agg(id) into v_card_ids from public.cards where deck_id = v_alice_deck_id;

    -- Seed a practice session
    insert into public.practice_sessions (user_id, status, mode, focus_mode, new_block_size, review_batch_size)
    values ('11111111-1111-1111-1111-111111111111', 'active', 'new_material', 'auto', 5, 10);

    -- Delete personal deck
    v_res := public.delete_personal_deck(v_alice_deck_id);
    perform pg_temp.ok('2.1 delete_personal_deck returns success', (v_res->>'success')::boolean = true);
    perform pg_temp.ok('2.2 delete_personal_deck returns deck_id', (v_res->>'deck_id')::bigint = v_alice_deck_id);

    -- Verify deck row is removed
    perform pg_temp.ok('2.3 deck row deleted from public.decks',
        not exists (select 1 from public.decks where id = v_alice_deck_id));

    -- Verify cards are deleted
    perform pg_temp.ok('2.4 cards deleted from public.cards',
        not exists (select 1 from public.cards where id = any(v_card_ids)));

    -- Verify deck no longer in get_home_decks()
    v_home := public.get_home_decks();
    perform pg_temp.ok('2.5 deck no longer in home decks',
        not exists (select 1 from jsonb_array_elements(v_home) elem where (elem->>'id')::bigint = v_alice_deck_id));
end $$;

-- ===========================================================================
-- Test 3: Deck Origin Classification (personal, public, managing) in get_home_decks
-- ===========================================================================
do $$
declare
    alice constant uuid := '11111111-1111-1111-1111-111111111111';
    carol constant uuid := '33333333-3333-3333-3333-333333333333';
    v_personal_deck_id bigint;
    v_market_id bigint;
    v_alice_copy_id bigint;
    v_carol_copy_id bigint;
    v_home jsonb;
    v_deck_entry jsonb;
begin
    -- 3.1 Create standalone personal deck for Alice
    insert into public.decks (slug, title, description, user_id, is_selected_on_home, is_enabled_in_smart_practice)
    values ('alice-standalone-class-test', 'Alice Standalone Deck', 'Personal', alice, true, true)
    returning id into v_personal_deck_id;

    insert into public.cards (deck_id, spanish_text, english_text, generation_phase)
    values (v_personal_deck_id, 'hola', 'hello', 'refined');

    -- 3.2 Alice subscribes to Carol's market deck ('market-colors') -> Public deck
    select id into v_market_id from public.decks where slug = 'market-colors';
    perform set_config('app.uid', alice::text, false);
    perform public.update_deck_home_selection(v_market_id, true);

    -- Check Alice's home decks classification
    v_home := public.get_home_decks();

    -- Check personal deck
    select elem into v_deck_entry from jsonb_array_elements(v_home) elem where (elem->>'id')::bigint = v_personal_deck_id;
    perform pg_temp.ok('3.1 standalone deck is classified as personal', v_deck_entry->>'deck_type' = 'personal');
    perform pg_temp.ok('3.2 standalone deck is_owner is false (not public owner)', (v_deck_entry->>'is_owner')::boolean = false);

    -- Check public market copy
    select elem into v_deck_entry from jsonb_array_elements(v_home) elem where (elem->>'base_deck_id')::bigint = v_market_id;
    perform pg_temp.ok('3.3 market copy is classified as public for subscriber', v_deck_entry->>'deck_type' = 'public');
    perform pg_temp.ok('3.4 market copy is_owner is false for subscriber', (v_deck_entry->>'is_owner')::boolean = false);

    -- 3.3 Carol (owner of 'market-colors') adds her market deck to her home -> Managing deck
    perform set_config('app.uid', carol::text, false);
    perform public.update_deck_home_selection(v_market_id, true);

    v_home := public.get_home_decks();
    select elem into v_deck_entry from jsonb_array_elements(v_home) elem where (elem->>'base_deck_id')::bigint = v_market_id;
    perform pg_temp.ok('3.5 market copy is classified as managing for owner', v_deck_entry->>'deck_type' = 'managing');
    perform pg_temp.ok('3.6 market copy is_owner is true for maintainer', (v_deck_entry->>'is_owner')::boolean = true);
end $$;

select 'ALL DECK DELETION & ORIGIN TESTS PASSED' as result;
