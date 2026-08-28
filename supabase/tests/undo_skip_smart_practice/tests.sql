-- Scenario asserts for 0024's skip_smart_practice_card undo support.
\set ON_ERROR_STOP on

insert into auth.users (id, email, raw_user_meta_data) values
    ('11111111-1111-1111-1111-111111111111', 'alice@test.dev', '{"full_name":"Alice"}');

-- Alice's personal deck, 3 cards.
insert into public.decks (slug, title, description, user_id, is_selected_on_home, is_enabled_in_smart_practice)
values ('alice-deck', 'Alice Deck', 'Personal', '11111111-1111-1111-1111-111111111111', true, true);

insert into public.cards (deck_id, spanish_text, english_text, generation_phase, is_enabled)
select d.id, v.es, v.en, 'refined', true
from public.decks d,
(values ('uno','one'),('dos','two'),('tres','three')) as v(es,en)
where d.slug = 'alice-deck';

create or replace function pg_temp.alice_card_ids() returns bigint[] language sql as $$
    select array_agg(c.id order by c.id) from public.cards c
    join public.decks d on d.id = c.deck_id where d.slug = 'alice-deck';
$$;

create or replace function pg_temp.ok(p_label text, p_cond boolean) returns void language plpgsql as $$
begin
    if p_cond then raise notice 'PASS %', p_label;
    else raise exception 'FAIL %', p_label; end if;
end $$;

-- =====================================================================
do $$
declare
    v_session jsonb;
    v_session_id bigint;
    v_card_ids bigint[] := pg_temp.alice_card_ids();
    v_card1 bigint := v_card_ids[1];
    v_card2 bigint := v_card_ids[2];
    v_card3 bigint := v_card_ids[3];
    v_res jsonb;
    v_undone jsonb;
    v_cur_card_id bigint;
begin
    perform set_config('app.uid', '11111111-1111-1111-1111-111111111111', false);

    -- 1. Start smart practice session
    v_session := public.start_smart_practice_session(5, 10, 'auto');
    v_session_id := (v_session->'summary'->>'session_id')::bigint;
    perform pg_temp.ok('1a session started', v_session_id is not null);
    perform pg_temp.ok('1b initial can_undo is false', (v_session->'summary'->>'can_undo')::boolean = false);
    
    v_cur_card_id := (v_session->'current_card'->>'card_id')::bigint;
    perform pg_temp.ok('1c current_card is first card', v_cur_card_id is not null);
    perform pg_temp.ok('1d initial times_presented = 0', (v_session->'current_card'->>'times_presented')::int = 0);

    -- 2. Skip the first card (e.g. listening game on new card, or MC recognition win)
    v_res := public.skip_smart_practice_card(v_session_id, v_cur_card_id);
    perform pg_temp.ok('2a skip succeeded', v_res is not null);
    perform pg_temp.ok('2b can_undo is true after skip', (v_res->'summary'->>'can_undo')::boolean = true);
    perform pg_temp.ok('2c current_card moved to next card', (v_res->'current_card'->>'card_id')::bigint <> v_cur_card_id);

    -- 3. Undo the skip
    v_undone := public.undo_smart_practice_review(v_session_id);
    perform pg_temp.ok('3a undo succeeded', v_undone is not null);
    perform pg_temp.ok('3b restored current_card is first card', (v_undone->'current_card'->>'card_id')::bigint = v_cur_card_id);
    perform pg_temp.ok('3c restored times_presented is 0', (v_undone->'current_card'->>'times_presented')::int = 0);
    perform pg_temp.ok('3d can_undo is now false (1-step)', (v_undone->'summary'->>'can_undo')::boolean = false);

    -- 4. Graded review (known) on the restored card
    v_res := public.submit_smart_practice_review(v_session_id, v_cur_card_id, 'known');
    perform pg_temp.ok('4a submit review succeeded', v_res is not null);
    perform pg_temp.ok('4b can_undo is true after review', (v_res->'session'->'summary'->>'can_undo')::boolean = true);

    -- 5. Undo the graded review
    v_undone := public.undo_smart_practice_review(v_session_id);
    perform pg_temp.ok('5a undo review succeeded', v_undone is not null);
    perform pg_temp.ok('5b restored card is first card', (v_undone->'current_card'->>'card_id')::bigint = v_cur_card_id);
    perform pg_temp.ok('5c card_progress row restored (known_count = 0)',
        not exists (select 1 from public.card_progress where card_id = v_cur_card_id and known_count > 0));

    -- 6. Skip again, advance through card 2, then undo card 2
    v_res := public.skip_smart_practice_card(v_session_id, v_cur_card_id);
    declare
        v_next_card bigint := (v_res->'current_card'->>'card_id')::bigint;
    begin
        perform pg_temp.ok('6a skip card 1', (v_res->'summary'->>'can_undo')::boolean = true);
        v_res := public.skip_smart_practice_card(v_session_id, v_next_card);
        perform pg_temp.ok('6b skip card 2', (v_res->'summary'->>'can_undo')::boolean = true);
        
        v_undone := public.undo_smart_practice_review(v_session_id);
        perform pg_temp.ok('6c undo restores card 2', (v_undone->'current_card'->>'card_id')::bigint = v_next_card);
    end;
end $$;

select 'ALL UNDO SKIP TESTS PASSED' as result;
