-- Rows that exist BEFORE the language-agnostic migrations run, written with the
-- pre-0034 column names. The point is to migrate a database that HAS DATA:
-- 0034 was originally authored so that its examples-jsonb UPDATE fired the
-- content trigger before the trigger's helper functions had been repaired, and
-- an empty cards table hides that completely because the UPDATE matches no rows.

insert into auth.users (id, email, raw_user_meta_data)
values
    ('11111111-1111-1111-1111-111111111111', 'alice@test.dev', '{"full_name":"Alice"}'),
    ('22222222-2222-2222-2222-222222222222', 'bob@test.dev', '{"full_name":"Bob"}')
on conflict (id) do nothing;

-- A published market deck plus a personal clone, so the base_version_hash
-- re-baselining in section 5 of 0034 has linked cards to work on.
insert into public.decks (slug, title, description, user_id, language_from, language_to, is_selected_on_home)
values ('market-travel', 'Market Travel', 'Published travel deck', null, 'es', 'en', true);

insert into public.decks (slug, title, description, user_id, language_from, language_to, is_selected_on_home)
values ('alice-travel', 'Alice Travel', 'Cloned travel deck', '11111111-1111-1111-1111-111111111111', 'es', 'en', true);

-- Market cards. examples uses the OLD {es, en} key shape on purpose.
insert into public.cards (
    deck_id, spanish_text, english_text, section_name, part_of_speech,
    definition_en, main_translations_es, collocations, synonyms_en,
    example_sentence, example_es, example_en, mnemonic_en, examples
)
select
    d.id, v.es, v.en, 'Aeropuerto', 'noun',
    v.def, to_jsonb(array[v.es]), to_jsonb(array[v.coll]), to_jsonb(array[v.syn]),
    v.ex_en, v.ex_es, v.ex_en, v.mnem,
    jsonb_build_array(
        jsonb_build_object('es', v.ex_es, 'en', v.ex_en),
        jsonb_build_object('es', v.ex_es2, 'en', v.ex_en2)
    )
from public.decks d
cross join (values
    ('pasaporte', 'passport', 'An official travel document.', 'renew a passport', 'travel document',
     'Necesito mi pasaporte.', 'I need my passport at the gate.',
     'Perdi mi pasaporte.', 'I lost my passport in the taxi.', 'pass-port'),
    ('maleta', 'suitcase', 'A case for carrying clothes.', 'pack a suitcase', 'luggage',
     'Mi maleta es pesada.', 'My suitcase is heavy today.',
     'Abri la maleta.', 'I opened the suitcase at customs.', 'mall-eta')
) as v(es, en, def, coll, syn, ex_es, ex_en, ex_es2, ex_en2, mnem)
where d.slug = 'market-travel';

-- Alice's clone, linked back to the market cards so base_version_hash is set.
insert into public.cards (
    deck_id, spanish_text, english_text, section_name, part_of_speech,
    definition_en, main_translations_es, collocations, synonyms_en,
    example_sentence, example_es, example_en, mnemonic_en, examples,
    base_card_id, base_version_hash
)
select
    ad.id, bc.spanish_text, bc.english_text, bc.section_name, bc.part_of_speech,
    bc.definition_en, bc.main_translations_es, bc.collocations, bc.synonyms_en,
    bc.example_sentence, bc.example_es, bc.example_en, bc.mnemonic_en, bc.examples,
    bc.id, public._card_content_hash(bc.*)
from public.cards bc
join public.decks bd on bd.id = bc.deck_id and bd.slug = 'market-travel'
cross join public.decks ad
where ad.slug = 'alice-travel';

-- One card the user has since edited, so its hash no longer matches its base.
update public.cards uc
set english_text = 'suitcase (edited)'
from public.decks d
where d.id = uc.deck_id and d.slug = 'alice-travel' and uc.spanish_text = 'maleta';

do $$
declare
    v_cards int;
begin
    select count(*) into v_cards from public.cards;
    assert v_cards = 4, format('seed expected 4 cards, got %s', v_cards);
    raise notice 'SEEDED % cards before 0033', v_cards;
end $$;
