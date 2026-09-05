-- ===========================================================================
-- Migration 0036: accept the pre-0034 update_card parameter names
-- ===========================================================================
--
-- Deploy-ordering fix. Migration 0034 dropped the old update_card overloads
-- and renamed its parameters to the role names (p_prompt_l1, p_answer_l2, …).
-- PostgREST resolves an RPC by PARAMETER NAME, so between applying 0034 and
-- deploying the matching frontend, the already-deployed client still sends
-- p_prompt_es / p_answer_en / p_definition_en / … and its card edits fail
-- with "function not found". Reads survive that window because the RPCs
-- deliberately dual-emit prompt_es alongside prompt_l1; this was the one
-- write path left unprotected.
--
-- A second function with the legacy names is not possible: PostgreSQL
-- overloads on argument TYPES, and both signatures are
-- (bigint, text, text, text, text, text, text[], text[], text[],
--  text, text, text, text, jsonb) — identical. So instead this replaces
-- update_card with ONE function carrying both parameter sets. Every
-- parameter is optional and the body coalesces role name over legacy name,
-- which lets a single function serve both call shapes: PostgREST matches on
-- whichever names the caller sends and the rest fall back to their defaults.
--
-- Retire this together with public.cards_legacy and the RPC dual-emit, once
-- every client is past the 0034 deploy. Dropping it restores 0034's
-- signature exactly.

drop function if exists public.update_card(bigint, text, text, text, text, text, text[], text[], text[], text, text, text, text, jsonb);

create function public.update_card(
    p_card_id bigint,
    -- role-named parameters (0034 onwards)
    p_prompt_l1 text default null,
    p_answer_l2 text default null,
    p_section_name text default null,
    p_part_of_speech text default null,
    p_l2_definition text default null,
    p_l1_translations text[] default null,
    p_collocations text[] default null,
    p_l2_synonyms text[] default null,
    p_example_sentence text default null,
    p_example_l1 text default null,
    p_example_l2 text default null,
    p_l2_mnemonic text default null,
    p_examples jsonb default null,
    -- legacy parameters (pre-0034 clients), accepted during the deploy window
    p_prompt_es text default null,
    p_answer_en text default null,
    p_definition_en text default null,
    p_main_translations_es text[] default null,
    p_synonyms_en text[] default null,
    p_example_es text default null,
    p_example_en text default null,
    p_mnemonic_en text default null
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
    v_is_deleted boolean;
    v_prompt text;
    v_answer text;
    v_definition text;
    v_translations text[];
    v_synonyms text[];
    v_example_l1 text;
    v_example_l2 text;
    v_mnemonic text;
begin
    if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;

    select c.is_deleted, d.user_id, d.owner_id into v_is_deleted, v_owner, v_maintainer
    from public.cards c
    join public.decks d on d.id = c.deck_id
    where c.id = p_card_id;

    if not found then raise exception 'Card not found'; end if;
    if not (coalesce(v_owner = v_uid, false)
            or (v_owner is null and coalesce(v_maintainer = v_uid, false))) then
        raise exception 'Not authorized to modify this card';
    end if;
    if v_is_deleted then
        raise exception 'Cannot modify a deleted card';
    end if;

    -- Role name wins; the legacy name is the fallback for pre-0034 clients.
    v_prompt      := nullif(trim(coalesce(p_prompt_l1, p_prompt_es)), '');
    v_answer      := nullif(trim(coalesce(p_answer_l2, p_answer_en)), '');
    v_definition  := nullif(trim(coalesce(p_l2_definition, p_definition_en)), '');
    v_translations := coalesce(p_l1_translations, p_main_translations_es, '{}');
    v_synonyms    := coalesce(p_l2_synonyms, p_synonyms_en, '{}');
    v_example_l1  := nullif(trim(coalesce(p_example_l1, p_example_es)), '');
    v_example_l2  := nullif(trim(coalesce(p_example_l2, p_example_en)), '');
    v_mnemonic    := nullif(trim(coalesce(p_l2_mnemonic, p_mnemonic_en)), '');

    if v_prompt is null then raise exception 'prompt_l1 must be a non-empty string'; end if;
    if v_answer is null then raise exception 'answer_l2 must be a non-empty string'; end if;

    update public.cards set
        l1_text = v_prompt,
        l2_text = v_answer,
        section_name = nullif(trim(p_section_name), ''),
        part_of_speech = nullif(trim(p_part_of_speech), ''),
        l2_definition = v_definition,
        l1_translations = public._norm_text_items(v_translations),
        collocations = public._norm_text_items(coalesce(p_collocations, '{}')),
        l2_synonyms = public._norm_text_items(v_synonyms),
        example_sentence = nullif(trim(p_example_sentence), ''),
        example_l1 = v_example_l1,
        example_l2 = v_example_l2,
        l2_mnemonic = v_mnemonic,
        examples = case
            when p_examples is not null and jsonb_typeof(p_examples) = 'array' then p_examples
            else examples
        end
    where id = p_card_id;

    return public._preview_card_json(p_card_id);
end;
$$;

revoke execute on function public.update_card(bigint, text, text, text, text, text, text[], text[], text[], text, text, text, text, jsonb, text, text, text, text[], text[], text, text, text) from public, anon;
grant execute on function public.update_card(bigint, text, text, text, text, text, text[], text[], text[], text, text, text, text, jsonb, text, text, text, text[], text[], text, text, text) to authenticated;

notify pgrst, 'reload schema';
