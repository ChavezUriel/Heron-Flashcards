-- ===========================================================================
-- 0026: AI deck completion — read enrichable card payload.
--
-- Exposes get_deck_cards_for_ai(p_deck_id bigint) returning jsonb for the
-- in-app AI deck completion workflow (docs/ai-deck-completion.md).
--
-- Returns the full enrichable card shape in ai/cards.js naming (spanish_text,
-- english_text, cloze_distractors_en, generation_metadata, examples, etc.)
-- for all refined cards in a deck. Authorization matches get_deck_preview:
-- the user's own deck (user_id = auth.uid()) or any market deck (user_id is null).
-- ===========================================================================

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
    where c.deck_id = p_deck_id and c.generation_phase = 'refined';

    return v_cards;
end;
$$;

revoke execute on function public.get_deck_cards_for_ai(bigint) from public, anon;
grant execute on function public.get_deck_cards_for_ai(bigint) to authenticated;

notify pgrst, 'reload schema';
