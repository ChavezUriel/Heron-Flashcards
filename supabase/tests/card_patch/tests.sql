-- ===========================================================================
-- Scenario asserts for 0026: get_deck_cards_for_ai, apply_card_ai_patch,
-- and apply_card_ai_patches.
-- Driven by run.sh, which applies 0001..0026 in order on a throwaway cluster.
-- ===========================================================================
\set ON_ERROR_STOP on

insert into auth.users (id, email, raw_user_meta_data) values
    ('11111111-1111-1111-1111-111111111111', 'alice@test.dev', '{"full_name":"Alice"}'),
    ('22222222-2222-2222-2222-222222222222', 'bob@test.dev',   '{"full_name":"Bob"}'),
    ('33333333-3333-3333-3333-333333333333', 'carol@test.dev', '{"full_name":"Carol"}');

-- Alice's personal deck (2 cards)
insert into public.decks (slug, title, description, user_id)
values ('alice-deck', 'Alice Deck', 'Personal', '11111111-1111-1111-1111-111111111111');

insert into public.cards (
    deck_id, l1_text, l2_text, section_name, part_of_speech, l2_definition,
    l1_translations, collocations, l2_synonyms, example_sentence, example_l1,
    example_l2, l2_mnemonic, examples, l2_cloze_distractors, generation_metadata,
    generation_phase, is_enabled
)
select
    d.id,
    'perro',
    'dog',
    'Animals',
    'noun',
    'a domesticated carnivorous mammal',
    '["perro", "can"]'::jsonb,
    '["barking dog", "pet dog"]'::jsonb,
    '["hound", "canine"]'::jsonb,
    'The dog barks at night.',
    'El perro ladra por la noche.',
    'The dog barks at night.',
    'Remember dog sounds like dig.',
    '[{"l1":"El perro ladra por la noche.","l2":"The dog barks at night."}]'::jsonb,
    '["cat", "fox", "wolf"]'::jsonb,
    '{"_audits": {"example_quality": "pass"}, "custom_tag": "test_card"}'::jsonb,
    'refined',
    true
from public.decks d where d.slug = 'alice-deck';

insert into public.cards (
    deck_id, l1_text, l2_text, section_name, part_of_speech, l2_definition,
    l1_translations, collocations, l2_synonyms, example_sentence, example_l1,
    example_l2, l2_mnemonic, examples, l2_cloze_distractors, generation_metadata,
    generation_phase, is_enabled
)
select
    d.id,
    'gato',
    'cat',
    'Animals',
    'noun',
    'a small domesticated carnivorous mammal',
    '["gato"]'::jsonb,
    '["black cat"]'::jsonb,
    '["feline"]'::jsonb,
    'The cat sleeps on the mat.',
    'El gato duerme en la alfombra.',
    'The cat sleeps on the mat.',
    'Cat sounds like cut.',
    '[{"l1":"El gato duerme en la alfombra.","l2":"The cat sleeps on the mat."}]'::jsonb,
    '["dog", "mouse", "bird"]'::jsonb,
    '{"_audits": {"example_quality": "pass"}}'::jsonb,
    'refined',
    true
from public.decks d where d.slug = 'alice-deck';

-- Carol's maintained market deck (user_id null, owner_id = carol)
insert into public.decks (slug, title, description, user_id, owner_id)
values ('market-deck', 'Market Deck', 'Public Market Deck', null, '33333333-3333-3333-3333-333333333333');

insert into public.cards (
    deck_id, l1_text, l2_text, section_name, part_of_speech, l2_definition,
    l1_translations, collocations, l2_synonyms, example_sentence, example_l1,
    example_l2, l2_mnemonic, examples, l2_cloze_distractors, generation_metadata,
    generation_phase, is_enabled
)
select
    d.id,
    'caballo',
    'horse',
    'Farm',
    'noun',
    'a large plant-eating domesticated mammal',
    '["caballo"]'::jsonb,
    '["wild horse"]'::jsonb,
    '["steed", "stallion"]'::jsonb,
    'The horse runs fast.',
    'El caballo corre rapido.',
    'The horse runs fast.',
    null,
    '[{"l1":"El caballo corre rapido.","l2":"The horse runs fast."}]'::jsonb,
    '["donkey", "mule", "camel"]'::jsonb,
    '{}'::jsonb,
    'refined',
    true
from public.decks d where d.slug = 'market-deck';

create or replace function pg_temp.alice_deck_id() returns bigint language sql as $$
    select id from public.decks where slug = 'alice-deck';
$$;

create or replace function pg_temp.market_deck_id() returns bigint language sql as $$
    select id from public.decks where slug = 'market-deck';
$$;

create or replace function pg_temp.alice_card_id(p_word text) returns bigint language sql as $$
    select c.id from public.cards c
    join public.decks d on d.id = c.deck_id
    where d.slug = 'alice-deck' and c.l1_text = p_word;
$$;

create or replace function pg_temp.market_card_id(p_word text) returns bigint language sql as $$
    select c.id from public.cards c
    join public.decks d on d.id = c.deck_id
    where d.slug = 'market-deck' and c.l1_text = p_word;
$$;

create or replace function pg_temp.ok(p_label text, p_cond boolean) returns void language plpgsql as $$
begin
    if p_cond then raise notice 'PASS %', p_label;
    else raise exception 'FAIL %', p_label; end if;
end $$;

-- =====================================================================
-- 1. get_deck_cards_for_ai tests
-- =====================================================================
do $$
declare
    v_cards jsonb;
    v_card jsonb;
begin
    -- 1a. Unauthenticated is rejected
    perform set_config('app.uid', '', false);
    begin
        perform public.get_deck_cards_for_ai(pg_temp.alice_deck_id());
        raise exception 'FAIL 1a: expected rejection for unauthenticated';
    exception when sqlstate '28000' then
        perform pg_temp.ok('1a get_deck_cards_for_ai unauthenticated rejected', true);
    end;

    -- 1b. Deck owner (Alice) reads her own deck
    perform set_config('app.uid', '11111111-1111-1111-1111-111111111111', false);
    v_cards := public.get_deck_cards_for_ai(pg_temp.alice_deck_id());
    perform pg_temp.ok('1b1 returned 2 cards', jsonb_array_length(v_cards) = 2);

    v_card := v_cards->0;
    perform pg_temp.ok('1b2 uses spanish_text key', v_card ? 'spanish_text');
    perform pg_temp.ok('1b3 uses english_text key', v_card ? 'english_text');
    perform pg_temp.ok('1b4 returns cloze_distractors_en', v_card ? 'cloze_distractors_en');
    perform pg_temp.ok('1b5 returns generation_metadata', v_card ? 'generation_metadata');
    perform pg_temp.ok('1b6 returns examples array', jsonb_typeof(v_card->'examples') = 'array');

    -- 1c. Unrelated user (Bob) cannot read Alice's personal deck
    perform set_config('app.uid', '22222222-2222-2222-2222-222222222222', false);
    begin
        perform public.get_deck_cards_for_ai(pg_temp.alice_deck_id());
        raise exception 'FAIL 1c: expected rejection for stranger on personal deck';
    exception when others then
        if sqlerrm not like '%Deck not found%' then raise; end if;
        perform pg_temp.ok('1c stranger cannot read private deck cards', true);
    end;

    -- 1d. Any authenticated user (Bob) can read public market deck cards
    v_cards := public.get_deck_cards_for_ai(pg_temp.market_deck_id());
    perform pg_temp.ok('1d authenticated user can read market deck cards', jsonb_array_length(v_cards) = 1);
end $$;

-- =====================================================================
-- 2. Authorization on apply_card_ai_patch
-- =====================================================================
do $$
declare
    v_alice_card bigint := pg_temp.alice_card_id('perro');
    v_market_card bigint := pg_temp.market_card_id('caballo');
    v_res jsonb;
begin
    -- 2a. Unauthenticated is rejected
    perform set_config('app.uid', '', false);
    begin
        perform public.apply_card_ai_patch(v_alice_card, '{"definition_en":"canine"}'::jsonb);
        raise exception 'FAIL 2a: expected unauthenticated rejection';
    exception when sqlstate '28000' then
        perform pg_temp.ok('2a patch unauthenticated rejected', true);
    end;

    -- 2b. Stranger (Bob) rejected on Alice's card
    perform set_config('app.uid', '22222222-2222-2222-2222-222222222222', false);
    begin
        perform public.apply_card_ai_patch(v_alice_card, '{"definition_en":"canine"}'::jsonb);
        raise exception 'FAIL 2b: expected stranger rejection on personal card';
    exception when others then
        if sqlerrm not like '%Not authorized%' then raise; end if;
        perform pg_temp.ok('2b stranger cannot patch personal card', true);
    end;

    -- 2c. Stranger (Alice) rejected on Carol's market card
    perform set_config('app.uid', '11111111-1111-1111-1111-111111111111', false);
    begin
        perform public.apply_card_ai_patch(v_market_card, '{"definition_en":"steed"}'::jsonb);
        raise exception 'FAIL 2c: expected stranger rejection on market card';
    exception when others then
        if sqlerrm not like '%Not authorized%' then raise; end if;
        perform pg_temp.ok('2c stranger cannot patch market card', true);
    end;

    -- 2d. Deck owner (Alice) allowed on Alice's card
    perform set_config('app.uid', '11111111-1111-1111-1111-111111111111', false);
    v_res := public.apply_card_ai_patch(v_alice_card, '{"definition_en":"a loyal canine companion"}'::jsonb);
    perform pg_temp.ok('2d deck owner can patch personal card', (v_res->>'definition_en') = 'a loyal canine companion');

    -- 2e. Market deck maintainer (Carol) allowed on market card
    perform set_config('app.uid', '33333333-3333-3333-3333-333333333333', false);
    v_res := public.apply_card_ai_patch(v_market_card, '{"definition_en":"an equine mammal"}'::jsonb);
    perform pg_temp.ok('2e market maintainer can patch market card', (v_res->>'definition_en') = 'an equine mammal');
end $$;

-- =====================================================================
-- 3. Partial patch semantics & validation
-- =====================================================================
do $$
declare
    v_card_id bigint := pg_temp.alice_card_id('perro');
    v_card public.cards%rowtype;
    v_res jsonb;
begin
    perform set_config('app.uid', '11111111-1111-1111-1111-111111111111', false);

    -- 3a. Absent keys leave columns untouched
    perform public.apply_card_ai_patch(v_card_id, '{"part_of_speech":"noun (masculine)"}'::jsonb);
    select * into v_card from public.cards where id = v_card_id;

    perform pg_temp.ok('3a1 updated target column', v_card.part_of_speech = 'noun (masculine)');
    perform pg_temp.ok('3a2 untouched l1_text', v_card.l1_text = 'perro');
    perform pg_temp.ok('3a3 untouched l2_text', v_card.l2_text = 'dog');
    perform pg_temp.ok('3a4 untouched section_name', v_card.section_name = 'Animals');
    perform pg_temp.ok('3a5 untouched collocations', jsonb_array_length(v_card.collocations) = 2);
    perform pg_temp.ok('3a6 untouched l2_synonyms', jsonb_array_length(v_card.l2_synonyms) = 2);
    perform pg_temp.ok('3a7 untouched l2_cloze_distractors', jsonb_array_length(v_card.l2_cloze_distractors) = 3);
    perform pg_temp.ok('3a8 untouched l2_mnemonic', v_card.l2_mnemonic = 'Remember dog sounds like dig.');

    -- 3b. Explicit null in patch is rejected
    begin
        perform public.apply_card_ai_patch(v_card_id, '{"definition_en": null}'::jsonb);
        raise exception 'FAIL 3b: expected explicit null rejection';
    exception when others then
        if sqlerrm not like '%Explicit null values are not allowed%' then raise; end if;
        perform pg_temp.ok('3b explicit null rejected', true);
    end;

    -- 3c. Non-object patch is rejected
    begin
        perform public.apply_card_ai_patch(v_card_id, '"string_patch"'::jsonb);
        raise exception 'FAIL 3c: expected non-object patch rejection';
    exception when others then
        if sqlerrm not like '%Patch must be a jsonb object%' then raise; end if;
        perform pg_temp.ok('3c non-object patch rejected', true);
    end;

    -- 3d. Non-array for array fields is rejected
    begin
        perform public.apply_card_ai_patch(v_card_id, '{"collocations": "not_an_array"}'::jsonb);
        raise exception 'FAIL 3d: expected array type error for collocations';
    exception when others then
        if sqlerrm not like '%collocations must be a jsonb array%' then raise; end if;
        perform pg_temp.ok('3d non-array collocations rejected', true);
    end;

    begin
        perform public.apply_card_ai_patch(v_card_id, '{"cloze_distractors_en": "not_an_array"}'::jsonb);
        raise exception 'FAIL 3d2: expected array type error for cloze_distractors_en';
    exception when others then
        if sqlerrm not like '%cloze_distractors_en must be a jsonb array%' then raise; end if;
        perform pg_temp.ok('3d2 non-array cloze_distractors_en rejected', true);
    end;

    -- 3e. Empty/blank text is rejected
    begin
        perform public.apply_card_ai_patch(v_card_id, '{"spanish_text": "  "}'::jsonb);
        raise exception 'FAIL 3e: expected blank spanish_text rejection';
    exception when others then
        if sqlerrm not like '%spanish_text must be a non-empty string%' then raise; end if;
        perform pg_temp.ok('3e blank spanish_text rejected', true);
    end;
end $$;

-- =====================================================================
-- 4. Server-side examples -> example_es/example_en/example_sentence mirror
-- =====================================================================
do $$
declare
    v_card_id bigint := pg_temp.alice_card_id('perro');
    v_card public.cards%rowtype;
    v_patch jsonb;
begin
    perform set_config('app.uid', '11111111-1111-1111-1111-111111111111', false);

    -- 4a. Patching examples with {es, en} shape rebuilds mirrors from examples[0]
    v_patch := jsonb_build_object(
        'examples', jsonb_build_array(
            jsonb_build_object('es', 'El perro guardián vigila.', 'en', 'The guard dog watches.'),
            jsonb_build_object('es', 'El perro corre en el parque.', 'en', 'The dog runs in the park.')
        )
    );
    perform public.apply_card_ai_patch(v_card_id, v_patch);
    select * into v_card from public.cards where id = v_card_id;

    perform pg_temp.ok('4a1 examples array updated', jsonb_array_length(v_card.examples) = 2);
    perform pg_temp.ok('4a2 example_l1 mirrored from examples[0]', v_card.example_l1 = 'El perro guardián vigila.');
    perform pg_temp.ok('4a3 example_l2 mirrored from examples[0]', v_card.example_l2 = 'The guard dog watches.');
    perform pg_temp.ok('4a4 example_sentence mirrored from examples[0]', v_card.example_sentence = 'The guard dog watches.');

    -- 4b. Patching examples with {example_es, example_en} legacy key names
    v_patch := jsonb_build_object(
        'examples', jsonb_build_array(
            jsonb_build_object('example_es', 'El can duerme.', 'example_en', 'The hound sleeps.')
        )
    );
    perform public.apply_card_ai_patch(v_card_id, v_patch);
    select * into v_card from public.cards where id = v_card_id;

    perform pg_temp.ok('4b1 example_l1 handles example_es key', v_card.example_l1 = 'El can duerme.');
    perform pg_temp.ok('4b2 example_l2 handles example_en key', v_card.example_l2 = 'The hound sleeps.');

    -- 4c. Patching examples with empty array nulls out the legacy mirror columns
    v_patch := jsonb_build_object('examples', '[]'::jsonb);
    perform public.apply_card_ai_patch(v_card_id, v_patch);
    select * into v_card from public.cards where id = v_card_id;

    perform pg_temp.ok('4c1 empty examples array stored', jsonb_array_length(v_card.examples) = 0);
    perform pg_temp.ok('4c2 example_l1 set to null', v_card.example_l1 is null);
    perform pg_temp.ok('4c3 example_l2 set to null', v_card.example_l2 is null);
    perform pg_temp.ok('4c4 example_sentence set to null', v_card.example_sentence is null);
end $$;

-- =====================================================================
-- 5. generation_metadata merge semantics (||)
-- =====================================================================
do $$
declare
    v_card_id bigint := pg_temp.alice_card_id('perro');
    v_card public.cards%rowtype;
begin
    perform set_config('app.uid', '11111111-1111-1111-1111-111111111111', false);

    -- Pre-set metadata with an existing custom key and an audit
    update public.cards
    set generation_metadata = '{"_audits":{"example_quality":"pass"},"custom_tag":"alpha"}'::jsonb
    where id = v_card_id;

    -- Patch in field_quality audit and a new metadata key
    perform public.apply_card_ai_patch(
        v_card_id,
        '{"generation_metadata":{"_audits":{"field_quality":"pass"},"run_id":"run_xyz"}}'::jsonb
    );
    select * into v_card from public.cards where id = v_card_id;

    perform pg_temp.ok('5a custom_tag preserved', (v_card.generation_metadata->>'custom_tag') = 'alpha');
    perform pg_temp.ok('5b new metadata key added', (v_card.generation_metadata->>'run_id') = 'run_xyz');
    perform pg_temp.ok('5c _audits key merged in', v_card.generation_metadata ? '_audits');
end $$;

-- =====================================================================
-- 6. content_updated_at trigger behavior (0017 sync trigger)
-- =====================================================================
do $$
declare
    v_card_id bigint := pg_temp.alice_card_id('perro');
    v_card public.cards%rowtype;
    v_baseline timestamptz := '2020-01-01 00:00:00+00'::timestamptz;
begin
    perform set_config('app.uid', '11111111-1111-1111-1111-111111111111', false);

    -- 6a. Setting only un-synced fields (cloze_distractors_en) does NOT bump content_updated_at
    update public.cards set content_updated_at = v_baseline where id = v_card_id;
    perform public.apply_card_ai_patch(
        v_card_id,
        '{"cloze_distractors_en":["puppy","corgi","beagle"]}'::jsonb
    );
    select * into v_card from public.cards where id = v_card_id;
    perform pg_temp.ok('6a cloze_distractors_en does not bump content_updated_at', v_card.content_updated_at = v_baseline);

    -- 6b. Setting only generation_metadata does NOT bump content_updated_at
    perform public.apply_card_ai_patch(
        v_card_id,
        '{"generation_metadata":{"updated_now":true}}'::jsonb
    );
    select * into v_card from public.cards where id = v_card_id;
    perform pg_temp.ok('6b generation_metadata does not bump content_updated_at', v_card.content_updated_at = v_baseline);

    -- 6c. Setting is_enabled does NOT bump content_updated_at
    perform public.apply_card_ai_patch(
        v_card_id,
        '{"is_enabled":false}'::jsonb
    );
    select * into v_card from public.cards where id = v_card_id;
    perform pg_temp.ok('6c is_enabled does not bump content_updated_at', v_card.content_updated_at = v_baseline);
    perform public.apply_card_ai_patch(v_card_id, '{"is_enabled":true}'::jsonb);

    -- 6d. Setting a synced field (definition_en) DOES bump content_updated_at
    perform public.apply_card_ai_patch(
        v_card_id,
        '{"definition_en":"a loyal four-legged pet"}'::jsonb
    );
    select * into v_card from public.cards where id = v_card_id;
    perform pg_temp.ok('6d synced field definition_en bumps content_updated_at', v_card.content_updated_at > v_baseline);

    -- 6e. Setting examples that alters example_es/example_en mirror DOES bump content_updated_at
    update public.cards set content_updated_at = v_baseline where id = v_card_id;
    perform public.apply_card_ai_patch(
        v_card_id,
        '{"examples":[{"es":"El perro come carne.","en":"The dog eats meat."}]}'::jsonb
    );
    select * into v_card from public.cards where id = v_card_id;
    perform pg_temp.ok('6e examples mirror change bumps content_updated_at', v_card.content_updated_at > v_baseline);
end $$;

-- =====================================================================
-- 7. apply_card_ai_patches batch applicator
-- =====================================================================
do $$
declare
    v_alice_1 bigint := pg_temp.alice_card_id('perro');
    v_alice_2 bigint := pg_temp.alice_card_id('gato');
    v_market_card bigint := pg_temp.market_card_id('caballo');
    v_batch jsonb;
    v_res jsonb;
    v_card1 public.cards%rowtype;
    v_card2 public.cards%rowtype;
begin
    perform set_config('app.uid', '11111111-1111-1111-1111-111111111111', false);

    -- 7a. Batch update succeeds atomically for authorized cards
    v_batch := jsonb_build_array(
        jsonb_build_object('card_id', v_alice_1, 'patch', jsonb_build_object('definition_en', 'Batch def 1')),
        jsonb_build_object('card_id', v_alice_2, 'patch', jsonb_build_object('definition_en', 'Batch def 2'))
    );
    v_res := public.apply_card_ai_patches(v_batch);

    perform pg_temp.ok('7a1 updated_count = 2', (v_res->>'updated_count')::int = 2);
    perform pg_temp.ok('7a2 card_ids returned', jsonb_array_length(v_res->'card_ids') = 2);

    select * into v_card1 from public.cards where id = v_alice_1;
    select * into v_card2 from public.cards where id = v_alice_2;
    perform pg_temp.ok('7a3 card 1 applied', v_card1.l2_definition = 'Batch def 1');
    perform pg_temp.ok('7a4 card 2 applied', v_card2.l2_definition = 'Batch def 2');

    -- 7b. Mixed batch containing an unauthorized card aborts the whole batch
    v_batch := jsonb_build_array(
        jsonb_build_object('card_id', v_alice_1, 'patch', jsonb_build_object('definition_en', 'Should rollback 1')),
        jsonb_build_object('card_id', v_market_card, 'patch', jsonb_build_object('definition_en', 'Unauthorized'))
    );
    begin
        perform public.apply_card_ai_patches(v_batch);
        raise exception 'FAIL 7b: expected mixed batch rejection';
    exception when others then
        if sqlerrm not like '%Not authorized%' then raise; end if;
        perform pg_temp.ok('7b mixed batch rejected atomically', true);
    end;

    -- Assert card 1 was rolled back and not modified
    select * into v_card1 from public.cards where id = v_alice_1;
    perform pg_temp.ok('7b2 card 1 rolled back', v_card1.l2_definition = 'Batch def 1');

    -- 7c. Missing card_id is rejected
    v_batch := jsonb_build_array(
        jsonb_build_object('patch', jsonb_build_object('definition_en', 'Missing ID'))
    );
    begin
        perform public.apply_card_ai_patches(v_batch);
        raise exception 'FAIL 7c: expected missing card_id error';
    exception when others then
        if sqlerrm not like '%card_id is required%' then raise; end if;
        perform pg_temp.ok('7c missing card_id rejected', true);
    end;
end $$;

-- =====================================================================
-- 8. Privileges / grants: authenticated only
-- =====================================================================
do $$
begin
    perform pg_temp.ok('8a anon cannot execute get_deck_cards_for_ai',
        not has_function_privilege('anon', 'public.get_deck_cards_for_ai(bigint)', 'execute'));
    perform pg_temp.ok('8b authenticated can execute get_deck_cards_for_ai',
        has_function_privilege('authenticated', 'public.get_deck_cards_for_ai(bigint)', 'execute'));

    perform pg_temp.ok('8c anon cannot execute apply_card_ai_patch',
        not has_function_privilege('anon', 'public.apply_card_ai_patch(bigint, jsonb)', 'execute'));
    perform pg_temp.ok('8d authenticated can execute apply_card_ai_patch',
        has_function_privilege('authenticated', 'public.apply_card_ai_patch(bigint, jsonb)', 'execute'));

    perform pg_temp.ok('8e anon cannot execute apply_card_ai_patches',
        not has_function_privilege('anon', 'public.apply_card_ai_patches(jsonb)', 'execute'));
    perform pg_temp.ok('8f authenticated can execute apply_card_ai_patches',
        has_function_privilege('authenticated', 'public.apply_card_ai_patches(jsonb)', 'execute'));
end $$;

select 'ALL CARD PATCH TESTS PASSED' as result;
