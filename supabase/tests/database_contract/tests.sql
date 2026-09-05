-- ===========================================================================
-- Database Contract Tests (Area 6)
-- Verifies:
--   1. RPC payloads (get_deck_preview, get_deck_cards_for_ai, get_home_decks,
--      get_market_decks) carry language_from and language_to on decks and cards.
--   2. public.cards_legacy view is genuinely read-only (insert/update/delete fail).
-- ===========================================================================
\set ON_ERROR_STOP on

-- Create test users
insert into auth.users (id, email, raw_user_meta_data) values
    ('11111111-1111-1111-1111-111111111111', 'alice@test.dev', '{"full_name":"Alice"}'),
    ('22222222-2222-2222-2222-222222222222', 'bob@test.dev',   '{"full_name":"Bob"}');

-- ---------------------------------------------------------------------------
-- Seed: Alice's personal deck (es->en)
-- ---------------------------------------------------------------------------
insert into public.decks (slug, title, description, user_id, language_from, language_to, is_selected_on_home)
values ('alice-travel', 'Alice Travel', 'Travel deck', '11111111-1111-1111-1111-111111111111', 'es', 'en', true);

insert into public.cards (
    deck_id, l1_text, l2_text, section_name, part_of_speech, l2_definition,
    l1_translations, collocations, l2_synonyms, example_sentence, example_l1,
    example_l2, l2_mnemonic, examples, l2_cloze_distractors, generation_phase, is_enabled
)
select
    d.id, 'pasaporte', 'passport', 'Travel', 'noun', 'An official travel document',
    '["pasaporte"]'::jsonb, '["passport control"]'::jsonb, '["travel document"]'::jsonb,
    'I need my passport.', 'Necesito mi pasaporte.', 'I need my passport.',
    'Sounds like pass port', '[{"l1":"Necesito mi pasaporte.","l2":"I need my passport."}]'::jsonb,
    '["ticket", "visa"]'::jsonb, 'refined', true
from public.decks d where d.slug = 'alice-travel';

-- Seed: Bob's market deck (fr->en)
insert into public.decks (slug, title, description, user_id, owner_id, language_from, language_to, publish_status)
values ('market-french', 'French Gastronomy', 'Food terms', null, '22222222-2222-2222-2222-222222222222', 'fr', 'en', 'published');

insert into public.cards (
    deck_id, l1_text, l2_text, section_name, part_of_speech, l2_definition,
    l1_translations, collocations, l2_synonyms, example_sentence, example_l1,
    example_l2, l2_mnemonic, examples, l2_cloze_distractors, generation_phase, is_enabled
)
select
    d.id, 'la pomme', 'the apple', 'Food', 'noun', 'A round fruit',
    '["pomme"]'::jsonb, '["apple tree"]'::jsonb, '["fruit"]'::jsonb,
    'I like the apple.', 'J’aime la pomme.', 'I like the apple.',
    'Pome fruit', '[{"l1":"J’aime la pomme.","l2":"I like the apple."}]'::jsonb,
    '["pear", "banana"]'::jsonb, 'refined', true
from public.decks d where d.slug = 'market-french';

-- ---------------------------------------------------------------------------
-- T1: get_deck_preview carries language_from and language_to on deck and cards
-- ---------------------------------------------------------------------------
do $$
declare
    alice constant uuid := '11111111-1111-1111-1111-111111111111';
    v_deck_id bigint;
    v_preview jsonb;
    v_card jsonb;
begin
    select id into v_deck_id from public.decks where slug = 'alice-travel';
    perform set_config('app.uid', alice::text, false);
    v_preview := public.get_deck_preview(v_deck_id);

    assert v_preview is not null, 'T1: get_deck_preview returned null';
    assert v_preview ->> 'language_from' = 'es', 'T1: expected deck language_from = es, got ' || coalesce(v_preview ->> 'language_from', 'null');
    assert v_preview ->> 'language_to' = 'en', 'T1: expected deck language_to = en, got ' || coalesce(v_preview ->> 'language_to', 'null');
    assert jsonb_array_length(v_preview -> 'cards') = 1, 'T1: expected 1 card in preview';

    v_card := (v_preview -> 'cards') -> 0;
    assert v_card ->> 'language_from' = 'es', 'T1: expected card language_from = es, got ' || coalesce(v_card ->> 'language_from', 'null');
    assert v_card ->> 'language_to' = 'en', 'T1: expected card language_to = en, got ' || coalesce(v_card ->> 'language_to', 'null');

    raise notice 'PASS T1: get_deck_preview carries language_from and language_to on deck and cards';
end $$;

-- ---------------------------------------------------------------------------
-- T2: get_deck_cards_for_ai carries language_from and language_to on cards
-- ---------------------------------------------------------------------------
do $$
declare
    alice constant uuid := '11111111-1111-1111-1111-111111111111';
    v_deck_id bigint;
    v_cards jsonb;
    v_card jsonb;
begin
    select id into v_deck_id from public.decks where slug = 'alice-travel';
    perform set_config('app.uid', alice::text, false);
    v_cards := public.get_deck_cards_for_ai(v_deck_id);

    assert v_cards is not null, 'T2: get_deck_cards_for_ai returned null';
    assert jsonb_array_length(v_cards) = 1, 'T2: expected 1 card';

    v_card := v_cards -> 0;
    assert v_card ->> 'language_from' = 'es', 'T2: expected card language_from = es, got ' || coalesce(v_card ->> 'language_from', 'null');
    assert v_card ->> 'language_to' = 'en', 'T2: expected card language_to = en, got ' || coalesce(v_card ->> 'language_to', 'null');

    raise notice 'PASS T2: get_deck_cards_for_ai carries language_from and language_to on cards';
end $$;

-- ---------------------------------------------------------------------------
-- T3: get_home_decks carries language_from and language_to
-- ---------------------------------------------------------------------------
do $$
declare
    alice constant uuid := '11111111-1111-1111-1111-111111111111';
    v_home jsonb;
    v_deck jsonb;
begin
    perform set_config('app.uid', alice::text, false);
    v_home := public.get_home_decks();

    assert v_home is not null, 'T3: get_home_decks returned null';
    assert jsonb_array_length(v_home) >= 1, 'T3: expected at least 1 home deck';

    select d into v_deck
    from jsonb_array_elements(v_home) d
    where d ->> 'slug' = 'alice-travel';

    assert v_deck is not null, 'T3: alice deck not found in home decks';
    assert v_deck ->> 'language_from' = 'es', 'T3: expected home deck language_from = es, got ' || coalesce(v_deck ->> 'language_from', 'null');
    assert v_deck ->> 'language_to' = 'en', 'T3: expected home deck language_to = en, got ' || coalesce(v_deck ->> 'language_to', 'null');

    raise notice 'PASS T3: get_home_decks carries language_from and language_to';
end $$;

-- ---------------------------------------------------------------------------
-- T4: get_market_decks carries language_from and language_to
-- ---------------------------------------------------------------------------
do $$
declare
    alice constant uuid := '11111111-1111-1111-1111-111111111111';
    v_market jsonb;
    v_deck jsonb;
begin
    perform set_config('app.uid', alice::text, false);
    v_market := public.get_market_decks();

    assert v_market is not null, 'T4: get_market_decks returned null';
    assert jsonb_array_length(v_market) >= 1, 'T4: expected at least 1 market deck';

    select d into v_deck
    from jsonb_array_elements(v_market) d
    where d ->> 'slug' = 'market-french';

    assert v_deck is not null, 'T4: market deck not found in market decks';
    assert v_deck ->> 'language_from' = 'fr', 'T4: expected market deck language_from = fr, got ' || coalesce(v_deck ->> 'language_from', 'null');
    assert v_deck ->> 'language_to' = 'en', 'T4: expected market deck language_to = en, got ' || coalesce(v_deck ->> 'language_to', 'null');

    raise notice 'PASS T4: get_market_decks carries language_from and language_to';
end $$;

-- ---------------------------------------------------------------------------
-- T5: public.cards_legacy SELECT works as expected
-- ---------------------------------------------------------------------------
do $$
declare
    v_count int;
    v_row record;
begin
    select count(*) into v_count from public.cards_legacy;
    assert v_count >= 2, 'T5: cards_legacy should have at least 2 cards, got ' || v_count;

    select * into v_row from public.cards_legacy where spanish_text = 'pasaporte';
    assert v_row.spanish_text = 'pasaporte', 'T5: spanish_text alias failed, got ' || coalesce(v_row.spanish_text, 'null');
    assert v_row.english_text = 'passport', 'T5: english_text alias failed, got ' || coalesce(v_row.english_text, 'null');
    assert v_row.definition_en = 'An official travel document', 'T5: definition_en alias failed';

    raise notice 'PASS T5: public.cards_legacy select reads legacy column aliases';
end $$;

-- ---------------------------------------------------------------------------
-- T6: public.cards_legacy is read-only (INSERT, UPDATE, DELETE fail)
-- ---------------------------------------------------------------------------

-- 6a: authenticated role cannot INSERT into cards_legacy
do $$
declare
    v_failed boolean := false;
    v_deck_id bigint;
begin
    select id into v_deck_id from public.decks where slug = 'alice-travel';
    execute 'set role authenticated';
    begin
        execute 'insert into public.cards_legacy (deck_id, spanish_text, english_text) values ($1, ''nuevo'', ''new'')' using v_deck_id;
    exception when others then
        v_failed := true;
    end;
    execute 'reset role';
    assert v_failed, 'T6a: INSERT into cards_legacy by authenticated must fail';
    raise notice 'PASS T6a: authenticated cannot INSERT into cards_legacy';
end $$;

-- 6b: authenticated role cannot UPDATE cards_legacy
do $$
declare
    v_failed boolean := false;
begin
    execute 'set role authenticated';
    begin
        execute 'update public.cards_legacy set spanish_text = ''cambiado'' where spanish_text = ''pasaporte''';
    exception when others then
        v_failed := true;
    end;
    execute 'reset role';
    assert v_failed, 'T6b: UPDATE on cards_legacy by authenticated must fail';
    raise notice 'PASS T6b: authenticated cannot UPDATE cards_legacy';
end $$;

-- 6c: authenticated role cannot DELETE from cards_legacy
do $$
declare
    v_failed boolean := false;
begin
    execute 'set role authenticated';
    begin
        execute 'delete from public.cards_legacy where spanish_text = ''pasaporte''';
    exception when others then
        v_failed := true;
    end;
    execute 'reset role';
    assert v_failed, 'T6c: DELETE from cards_legacy by authenticated must fail';
    raise notice 'PASS T6c: authenticated cannot DELETE from cards_legacy';
end $$;

-- 6d: anon role cannot INSERT into cards_legacy
do $$
declare
    v_failed boolean := false;
    v_deck_id bigint;
begin
    select id into v_deck_id from public.decks where slug = 'alice-travel';
    execute 'set role anon';
    begin
        execute 'insert into public.cards_legacy (deck_id, spanish_text, english_text) values ($1, ''anon'', ''anon'')' using v_deck_id;
    exception when others then
        v_failed := true;
    end;
    execute 'reset role';
    assert v_failed, 'T6d: INSERT into cards_legacy by anon must fail';
    raise notice 'PASS T6d: anon cannot INSERT into cards_legacy';
end $$;

-- 6e: anon role cannot UPDATE cards_legacy
do $$
declare
    v_failed boolean := false;
begin
    execute 'set role anon';
    begin
        execute 'update public.cards_legacy set spanish_text = ''anon'' where spanish_text = ''pasaporte''';
    exception when others then
        v_failed := true;
    end;
    execute 'reset role';
    assert v_failed, 'T6e: UPDATE on cards_legacy by anon must fail';
    raise notice 'PASS T6e: anon cannot UPDATE cards_legacy';
end $$;

-- 7: update_card accepts BOTH the role-named and the pre-0034 legacy parameter
-- names (migration 0036). This is the deploy window: after 0034 is applied the
-- already-deployed frontend still sends p_prompt_es / p_answer_en, and its card
-- edits must keep working until the new frontend ships.
do $$
declare
    alice constant uuid := '11111111-1111-1111-1111-111111111111';
    v_card_id bigint;
    v_result jsonb;
begin
    perform set_config('app.uid', alice::text, false);
    select c.id into v_card_id
    from public.cards c
    join public.decks d on d.id = c.deck_id
    where d.slug = 'alice-travel'
    limit 1;

    -- legacy call shape, exactly what the pre-0034 client sends
    v_result := public.update_card(
        p_card_id := v_card_id,
        p_prompt_es := 'pasaporte legacy',
        p_answer_en := 'passport legacy',
        p_definition_en := 'A travel document.',
        p_main_translations_es := array['pasaporte'],
        p_synonyms_en := array['travel document'],
        p_example_es := 'Necesito mi pasaporte.',
        p_example_en := 'I need my passport.',
        p_mnemonic_en := 'pass-port'
    );
    assert (select l1_text from public.cards where id = v_card_id) = 'pasaporte legacy',
        'T7a: legacy p_prompt_es must write l1_text';
    assert (select l2_definition from public.cards where id = v_card_id) = 'A travel document.',
        'T7a: legacy p_definition_en must write l2_definition';
    assert (select example_l1 from public.cards where id = v_card_id) = 'Necesito mi pasaporte.',
        'T7a: legacy p_example_es must write example_l1';
    raise notice 'PASS T7a: update_card accepts the pre-0034 legacy parameter names';

    -- role-named call shape, what the post-0034 client sends
    v_result := public.update_card(
        p_card_id := v_card_id,
        p_prompt_l1 := 'pasaporte',
        p_answer_l2 := 'passport',
        p_l2_definition := 'An official travel document.',
        p_l1_translations := array['pasaporte'],
        p_l2_synonyms := array['travel papers'],
        p_example_l1 := 'Renove mi pasaporte.',
        p_example_l2 := 'I renewed my passport.',
        p_l2_mnemonic := 'port of passage'
    );
    assert (select l1_text from public.cards where id = v_card_id) = 'pasaporte',
        'T7b: role-named p_prompt_l1 must write l1_text';
    assert (select l2_definition from public.cards where id = v_card_id) = 'An official travel document.',
        'T7b: role-named p_l2_definition must write l2_definition';
    assert (select example_l2 from public.cards where id = v_card_id) = 'I renewed my passport.',
        'T7b: role-named p_example_l2 must write example_l2';
    raise notice 'PASS T7b: update_card accepts the role-named parameters';

    -- a call carrying neither name still fails loudly rather than writing null
    begin
        v_result := public.update_card(p_card_id := v_card_id, p_section_name := 'x');
        raise exception 'T7c: update_card with no prompt should have failed';
    exception when others then
        if sqlerrm like 'T7c:%' then raise; end if;
    end;
    raise notice 'PASS T7c: update_card still rejects a call with no prompt or answer';
end $$;

-- Final success line
do $$ begin raise notice 'ALL DATABASE CONTRACT TESTS PASSED'; end $$;
select 'ALL DATABASE CONTRACT TESTS PASSED' as result;
