-- ===========================================================================
-- 0026: AI deck completion — read enrichable card payload and apply partial patches.
--
-- Exposes:
--   1. get_deck_cards_for_ai(p_deck_id bigint) -> jsonb
--      Returns the full enrichable card shape in ai/cards.js naming (spanish_text,
--      english_text, cloze_distractors_en, generation_metadata, examples, etc.)
--      for all refined cards in a deck.
--   2. apply_card_ai_patch(p_card_id bigint, p_patch jsonb) -> jsonb
--      Applies a partial patch to a single card row. Only keys present in p_patch
--      are updated; explicit null values are rejected. When examples is patched,
--      the legacy example_es / example_en / example_sentence columns are re-mirrored
--      from examples[0] server-side. generation_metadata is merged with ||.
--   3. apply_card_ai_patches(p_patches jsonb) -> jsonb
--      Batch applicator taking an array of {card_id, patch}. Atomic per call.
--
-- Authorization:
--   - Reading: Deck owner (user_id = auth.uid()) or any market deck (user_id is null).
--   - Patching: Deck owner (user_id = auth.uid()) or market deck maintainer
--     (user_id is null and owner_id = auth.uid()).
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

create or replace function public.apply_card_ai_patch(
    p_card_id bigint,
    p_patch jsonb
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
    v_examples jsonb;
    v_first_ex jsonb;
    v_patch_examples boolean := false;
    v_ex_es text;
    v_ex_en text;
begin
    if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
    if p_patch is null or jsonb_typeof(p_patch) != 'object' then
        raise exception 'Patch must be a jsonb object';
    end if;

    select d.user_id, d.owner_id into v_owner, v_maintainer
    from public.cards c
    join public.decks d on d.id = c.deck_id
    where c.id = p_card_id;

    if not found then raise exception 'Card not found'; end if;
    if not (coalesce(v_owner = v_uid, false)
            or (v_owner is null and coalesce(v_maintainer = v_uid, false))) then
        raise exception 'Not authorized to modify this card';
    end if;

    if exists (select 1 from jsonb_each(p_patch) where jsonb_typeof(value) = 'null') then
        raise exception 'Explicit null values are not allowed in card patch';
    end if;

    if p_patch ? 'examples' then
        v_patch_examples := true;
        v_examples := p_patch->'examples';
        if jsonb_typeof(v_examples) != 'array' then
            raise exception 'examples must be a jsonb array';
        end if;
        v_first_ex := v_examples->0;
        if v_first_ex is not null and jsonb_typeof(v_first_ex) = 'object' then
            v_ex_es := nullif(trim(coalesce(v_first_ex->>'es', v_first_ex->>'example_es')), '');
            v_ex_en := nullif(trim(coalesce(v_first_ex->>'en', v_first_ex->>'example_en')), '');
        else
            v_ex_es := null;
            v_ex_en := null;
        end if;
    end if;

    if p_patch ? 'main_translations_es' and jsonb_typeof(p_patch->'main_translations_es') != 'array' then
        raise exception 'main_translations_es must be a jsonb array';
    end if;
    if p_patch ? 'collocations' and jsonb_typeof(p_patch->'collocations') != 'array' then
        raise exception 'collocations must be a jsonb array';
    end if;
    if p_patch ? 'synonyms_en' and jsonb_typeof(p_patch->'synonyms_en') != 'array' then
        raise exception 'synonyms_en must be a jsonb array';
    end if;
    if p_patch ? 'cloze_distractors_en' and jsonb_typeof(p_patch->'cloze_distractors_en') != 'array' then
        raise exception 'cloze_distractors_en must be a jsonb array';
    end if;

    if p_patch ? 'spanish_text' and nullif(trim(p_patch->>'spanish_text'), '') is null then
        raise exception 'spanish_text must be a non-empty string';
    end if;
    if p_patch ? 'english_text' and nullif(trim(p_patch->>'english_text'), '') is null then
        raise exception 'english_text must be a non-empty string';
    end if;

    update public.cards set
        spanish_text = case when p_patch ? 'spanish_text' then trim(p_patch->>'spanish_text') else spanish_text end,
        english_text = case when p_patch ? 'english_text' then trim(p_patch->>'english_text') else english_text end,
        section_name = case when p_patch ? 'section_name' then nullif(trim(p_patch->>'section_name'), '') else section_name end,
        part_of_speech = case when p_patch ? 'part_of_speech' then nullif(trim(p_patch->>'part_of_speech'), '') else part_of_speech end,
        definition_en = case when p_patch ? 'definition_en' then nullif(trim(p_patch->>'definition_en'), '') else definition_en end,
        main_translations_es = case when p_patch ? 'main_translations_es' then p_patch->'main_translations_es' else main_translations_es end,
        collocations = case when p_patch ? 'collocations' then p_patch->'collocations' else collocations end,
        synonyms_en = case when p_patch ? 'synonyms_en' then p_patch->'synonyms_en' else synonyms_en end,
        examples = case when v_patch_examples then v_examples else examples end,
        example_es = case when v_patch_examples then v_ex_es when p_patch ? 'example_es' then nullif(trim(p_patch->>'example_es'), '') else example_es end,
        example_en = case when v_patch_examples then v_ex_en when p_patch ? 'example_en' then nullif(trim(p_patch->>'example_en'), '') else example_en end,
        example_sentence = case when v_patch_examples then v_ex_en when p_patch ? 'example_sentence' then nullif(trim(p_patch->>'example_sentence'), '') else example_sentence end,
        mnemonic_en = case when p_patch ? 'mnemonic_en' then nullif(trim(p_patch->>'mnemonic_en'), '') else mnemonic_en end,
        cloze_distractors_en = case when p_patch ? 'cloze_distractors_en' then p_patch->'cloze_distractors_en' else cloze_distractors_en end,
        generation_metadata = case when p_patch ? 'generation_metadata' then coalesce(generation_metadata, '{}'::jsonb) || (p_patch->'generation_metadata') else generation_metadata end,
        is_enabled = case when p_patch ? 'is_enabled' then (p_patch->>'is_enabled')::boolean else is_enabled end
    where id = p_card_id;

    return public._preview_card_json(p_card_id);
end;
$$;

create or replace function public.apply_card_ai_patches(p_patches jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_elem jsonb;
    v_card_id bigint;
    v_patch jsonb;
    v_count int := 0;
    v_updated_ids bigint[] := '{}';
begin
    if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
    if p_patches is null or jsonb_typeof(p_patches) != 'array' then
        raise exception 'Patches must be a jsonb array';
    end if;

    for v_elem in select * from jsonb_array_elements(p_patches) loop
        v_card_id := (v_elem->>'card_id')::bigint;
        v_patch := v_elem->'patch';
        if v_card_id is null then
            raise exception 'card_id is required for each patch item';
        end if;
        if v_patch is null or jsonb_typeof(v_patch) != 'object' then
            raise exception 'patch object is required for card %', v_card_id;
        end if;

        perform public.apply_card_ai_patch(v_card_id, v_patch);
        v_count := v_count + 1;
        v_updated_ids := array_append(v_updated_ids, v_card_id);
    end loop;

    return jsonb_build_object(
        'updated_count', v_count,
        'card_ids', to_jsonb(v_updated_ids)
    );
end;
$$;

revoke execute on function public.get_deck_cards_for_ai(bigint) from public, anon;
grant execute on function public.get_deck_cards_for_ai(bigint) to authenticated;

revoke execute on function public.apply_card_ai_patch(bigint, jsonb) from public, anon;
grant execute on function public.apply_card_ai_patch(bigint, jsonb) to authenticated;

revoke execute on function public.apply_card_ai_patches(jsonb) from public, anon;
grant execute on function public.apply_card_ai_patches(jsonb) to authenticated;

notify pgrst, 'reload schema';
