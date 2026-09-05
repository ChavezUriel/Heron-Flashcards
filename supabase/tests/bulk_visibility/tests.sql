-- Scenario asserts for 0023's update_cards_visibility. Driven by run.sh, which
-- applies 0001..0023 in order onto a throwaway cluster first.
--
-- The acting user is set through the shim's auth.uid() (app.uid GUC), so these
-- exercise the same authorization path PostgREST hits in production.
\set ON_ERROR_STOP on

insert into auth.users (id, email, raw_user_meta_data) values
    ('11111111-1111-1111-1111-111111111111', 'alice@test.dev', '{"full_name":"Alice"}'),
    ('22222222-2222-2222-2222-222222222222', 'bob@test.dev',   '{"full_name":"Bob"}'),
    ('33333333-3333-3333-3333-333333333333', 'carol@test.dev', '{"full_name":"Carol"}');

-- Alice's personal deck, 5 cards.
insert into public.decks (slug, title, description, user_id)
values ('alice-deck', 'Alice Deck', 'Personal', '11111111-1111-1111-1111-111111111111');

insert into public.cards (deck_id, l1_text, l2_text, generation_phase)
select d.id, v.es, v.en, 'refined'
from public.decks d,
(values ('uno','one'),('dos','two'),('tres','three'),('cuatro','four'),('cinco','five')) as v(es,en)
where d.slug = 'alice-deck';

-- Unowned market deck that Carol maintains (user_id null, owner_id = carol).
insert into public.decks (slug, title, description, user_id, owner_id)
values ('market-deck', 'Market Deck', 'Public', null, '33333333-3333-3333-3333-333333333333');

insert into public.cards (deck_id, l1_text, l2_text, generation_phase)
select d.id, v.es, v.en, 'refined'
from public.decks d,
(values ('rojo','red'),('azul','blue')) as v(es,en)
where d.slug = 'market-deck';

create or replace function pg_temp.alice_ids() returns bigint[] language sql as $$
    select array_agg(c.id order by c.id) from public.cards c
    join public.decks d on d.id = c.deck_id where d.slug = 'alice-deck';
$$;

create or replace function pg_temp.market_ids() returns bigint[] language sql as $$
    select array_agg(c.id order by c.id) from public.cards c
    join public.decks d on d.id = c.deck_id where d.slug = 'market-deck';
$$;

create or replace function pg_temp.enabled_count(p_slug text) returns int language sql as $$
    select count(*)::int from public.cards c join public.decks d on d.id = c.deck_id
    where d.slug = p_slug and c.is_enabled;
$$;

create or replace function pg_temp.ok(p_label text, p_cond boolean) returns void language plpgsql as $$
begin
    if p_cond then raise notice 'PASS %', p_label;
    else raise exception 'FAIL %', p_label; end if;
end $$;

-- =====================================================================
do $$
declare
    v_res jsonb;
    v_ids bigint[] := pg_temp.alice_ids();
begin
    -- 1. Unauthenticated is rejected.
    perform set_config('app.uid', '', false);
    begin
        perform public.update_cards_visibility(v_ids, false);
        raise exception 'FAIL unauth: expected rejection';
    exception when sqlstate '28000' then
        perform pg_temp.ok('1 unauthenticated rejected', true);
    end;

    perform set_config('app.uid', '11111111-1111-1111-1111-111111111111', false);

    -- 2. Empty / null id list is a no-op, not an error.
    v_res := public.update_cards_visibility('{}'::bigint[], false);
    perform pg_temp.ok('2a empty array no-op', (v_res->>'updated_count')::int = 0);
    v_res := public.update_cards_visibility(null, false);
    perform pg_temp.ok('2b null array no-op', (v_res->>'updated_count')::int = 0);
    perform pg_temp.ok('2c nothing hidden', pg_temp.enabled_count('alice-deck') = 5);

    -- 3. Owner bulk-hides her whole deck.
    v_res := public.update_cards_visibility(v_ids, false);
    perform pg_temp.ok('3a updated_count = 5', (v_res->>'updated_count')::int = 5);
    perform pg_temp.ok('3b all hidden', pg_temp.enabled_count('alice-deck') = 0);
    perform pg_temp.ok('3c is_enabled echoed', (v_res->>'is_enabled')::boolean = false);

    -- 4. Re-hiding an already-hidden set reports a zero delta.
    v_res := public.update_cards_visibility(v_ids, false);
    perform pg_temp.ok('4 idempotent hide reports 0', (v_res->>'updated_count')::int = 0);

    -- 5. Bulk show restores them.
    v_res := public.update_cards_visibility(v_ids, true);
    perform pg_temp.ok('5a updated_count = 5', (v_res->>'updated_count')::int = 5);
    perform pg_temp.ok('5b all visible', pg_temp.enabled_count('alice-deck') = 5);

    -- 6. Partial delta: hide 2 by hand, then bulk-hide all 5 -> only 3 change.
    perform public.update_card_visibility(v_ids[1], false);
    perform public.update_card_visibility(v_ids[2], false);
    v_res := public.update_cards_visibility(v_ids, false);
    perform pg_temp.ok('6a partial delta = 3', (v_res->>'updated_count')::int = 3);
    perform pg_temp.ok('6b all hidden', pg_temp.enabled_count('alice-deck') = 0);
    perform public.update_cards_visibility(v_ids, true);

    -- 7. Duplicate ids collapse (5 distinct despite 10 entries).
    v_res := public.update_cards_visibility(v_ids || v_ids, false);
    perform pg_temp.ok('7a dupes counted once', (v_res->>'updated_count')::int = 5);
    perform pg_temp.ok('7b card_ids deduped', jsonb_array_length(v_res->'card_ids') = 5);
    perform public.update_cards_visibility(v_ids, true);

    -- 8. A subset only touches the subset -- this is what a filtered table sends.
    v_res := public.update_cards_visibility(array[v_ids[1], v_ids[2]], false);
    perform pg_temp.ok('8a subset delta = 2', (v_res->>'updated_count')::int = 2);
    perform pg_temp.ok('8b 3 left visible', pg_temp.enabled_count('alice-deck') = 3);
    perform public.update_cards_visibility(v_ids, true);
end $$;

-- =====================================================================
-- 9. Authorization: Bob cannot touch Alice's cards, and the batch is atomic.
do $$
declare
    v_ids bigint[] := pg_temp.alice_ids();
begin
    perform set_config('app.uid', '22222222-2222-2222-2222-222222222222', false);
    begin
        perform public.update_cards_visibility(v_ids, false);
        raise exception 'FAIL 9: expected authorization rejection';
    exception when others then
        if sqlerrm not like '%Not authorized%' then raise; end if;
        perform pg_temp.ok('9a stranger rejected', true);
    end;
    perform pg_temp.ok('9b nothing changed', pg_temp.enabled_count('alice-deck') = 5);
end $$;

-- =====================================================================
-- 10. A mixed batch (Alice's cards + a market card she does not maintain)
--     is rejected WHOLESALE -- no partial application.
do $$
declare
    v_mixed bigint[] := pg_temp.alice_ids() || pg_temp.market_ids();
begin
    perform set_config('app.uid', '11111111-1111-1111-1111-111111111111', false);
    begin
        perform public.update_cards_visibility(v_mixed, false);
        raise exception 'FAIL 10: expected authorization rejection';
    exception when others then
        if sqlerrm not like '%Not authorized%' then raise; end if;
        perform pg_temp.ok('10a mixed batch rejected', true);
    end;
    perform pg_temp.ok('10b alice untouched', pg_temp.enabled_count('alice-deck') = 5);
    perform pg_temp.ok('10c market untouched', pg_temp.enabled_count('market-deck') = 2);
end $$;

-- =====================================================================
-- 11. Missing id aborts the batch even when every real id is authorized.
do $$
declare
    v_ids bigint[] := pg_temp.alice_ids();
begin
    perform set_config('app.uid', '11111111-1111-1111-1111-111111111111', false);
    begin
        perform public.update_cards_visibility(v_ids || array[999999::bigint], false);
        raise exception 'FAIL 11: expected not-found rejection';
    exception when others then
        if sqlerrm not like '%Card not found%' then raise; end if;
        perform pg_temp.ok('11a missing id rejected', true);
    end;
    perform pg_temp.ok('11b nothing changed', pg_temp.enabled_count('alice-deck') = 5);
end $$;

-- =====================================================================
-- 12. Maintainer of an unowned market deck may bulk-hide it.
do $$
declare
    v_res jsonb;
begin
    perform set_config('app.uid', '33333333-3333-3333-3333-333333333333', false);
    v_res := public.update_cards_visibility(pg_temp.market_ids(), false);
    perform pg_temp.ok('12a maintainer allowed', (v_res->>'updated_count')::int = 2);
    perform pg_temp.ok('12b market hidden', pg_temp.enabled_count('market-deck') = 0);
    perform public.update_cards_visibility(pg_temp.market_ids(), true);
end $$;

-- =====================================================================
-- 13. Hiding drops the deck's pending practice queue, exactly like the
--     per-card function does.
do $$
declare
    v_deck bigint;
    v_session bigint;
    v_pending int;
begin
    perform set_config('app.uid', '11111111-1111-1111-1111-111111111111', false);
    select id into v_deck from public.decks where slug = 'alice-deck';

    insert into public.practice_sessions
        (user_id, status, mode, focus_mode, new_block_size, review_batch_size)
    values ('11111111-1111-1111-1111-111111111111', 'active', 'review', 'auto', 5, 10)
    returning id into v_session;

    insert into public.practice_session_cards (session_id, card_id, queue_position, status)
    select v_session, c.id, row_number() over (order by c.id), 'pending'
    from public.cards c where c.deck_id = v_deck;

    select count(*) into v_pending from public.practice_session_cards
    where session_id = v_session and status = 'pending';
    perform pg_temp.ok('13a queue seeded', v_pending = 5);

    perform public.update_cards_visibility(pg_temp.alice_ids(), false);

    select count(*) into v_pending from public.practice_session_cards
    where session_id = v_session and status = 'pending';
    perform pg_temp.ok('13b pending queue cleared', v_pending = 0);

    -- Emptying the queue must also close the session out, not strand it 'active'.
    perform pg_temp.ok('13c session completed',
        (select status from public.practice_sessions where id = v_session) = 'completed');

    perform public.update_cards_visibility(pg_temp.alice_ids(), true);
end $$;

-- =====================================================================
-- 14. Grants: authenticated only.
do $$
begin
    perform pg_temp.ok('14a anon has no execute',
        not has_function_privilege('anon', 'public.update_cards_visibility(bigint[], boolean)', 'execute'));
    perform pg_temp.ok('14b authenticated may execute',
        has_function_privilege('authenticated', 'public.update_cards_visibility(bigint[], boolean)', 'execute'));
end $$;

select 'ALL BULK VISIBILITY TESTS PASSED' as result;
