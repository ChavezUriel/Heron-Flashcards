-- ===========================================================================
-- 0025: Support multiple example sentence pairs in update_card.
--
-- Cards carry `examples` (0019). update_card now accepts p_examples jsonb
-- so card edits from the metadata modal or explorer persist multiple
-- example sentence pairs cleanly while preserving backwards compatibility.
-- ===========================================================================

drop function if exists public.update_card(
    bigint, text, text, text, text, text, text[], text[], text[], text, text, text, text
);

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
    v_prompt text;
    v_answer text;
begin
    if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;

    select d.user_id, d.owner_id into v_owner, v_maintainer
    from public.cards c
    join public.decks d on d.id = c.deck_id
    where c.id = p_card_id;

    if not found then raise exception 'Card not found'; end if;
    if not (coalesce(v_owner = v_uid, false)
            or (v_owner is null and coalesce(v_maintainer = v_uid, false))) then
        raise exception 'Not authorized to modify this card';
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

revoke execute on function public.update_card(
    bigint, text, text, text, text, text, text[], text[], text[], text, text, text, text, jsonb
) from public, anon;

grant execute on function public.update_card(
    bigint, text, text, text, text, text, text[], text[], text[], text, text, text, text, jsonb
) to authenticated;

notify pgrst, 'reload schema';
