-- Assertions that run AFTER 0033-0036 have been applied on top of seeded data.
-- Every check here is about the migration surviving real rows, not about the
-- feature behaviour, which the other suites already cover.

-- 1: the renamed columns carry the seeded values across
do $$
declare
    v_l1 text;
    v_l2 text;
    v_def text;
begin
    select l1_text, l2_text, l2_definition into v_l1, v_l2, v_def
    from public.cards c
    join public.decks d on d.id = c.deck_id
    where d.slug = 'market-travel' and c.l1_text = 'pasaporte';

    assert v_l1 = 'pasaporte', 'T1: l1_text lost its value across the rename';
    assert v_l2 = 'passport', 'T1: l2_text lost its value across the rename';
    assert v_def = 'An official travel document.', 'T1: l2_definition lost its value';
    raise notice 'PASS T1: renamed columns preserved the seeded data';
end $$;

-- 2: examples jsonb was rewritten from {es,en} to {l1,l2} for existing rows
do $$
declare
    v_bad int;
    v_good int;
begin
    select count(*) into v_bad
    from public.cards c, jsonb_array_elements(coalesce(c.examples, '[]'::jsonb)) e
    where e ? 'es' or e ? 'en';

    select count(*) into v_good
    from public.cards c, jsonb_array_elements(coalesce(c.examples, '[]'::jsonb)) e
    where e ? 'l1' and e ? 'l2';

    assert v_bad = 0, format('T2: %s example pairs still use es/en keys', v_bad);
    assert v_good = 8, format('T2: expected 8 migrated example pairs, got %s', v_good);
    raise notice 'PASS T2: existing examples jsonb migrated to l1/l2 (% pairs)', v_good;
end $$;

-- 3: the content trigger works on migrated rows. This is the regression: the
-- trigger calls _card_sync_content, which referenced the pre-rename column
-- names, so any write to a seeded card aborted the whole migration.
do $$
declare
    v_card_id bigint;
    v_before timestamptz;
    v_after timestamptz;
    v_original_def text;
begin
    select c.id, c.content_updated_at, c.l2_definition
      into v_card_id, v_before, v_original_def
    from public.cards c
    join public.decks d on d.id = c.deck_id
    where d.slug = 'market-travel' and c.l1_text = 'pasaporte';

    update public.cards set l2_definition = 'A document permitting travel.' where id = v_card_id;

    select content_updated_at into v_after from public.cards where id = v_card_id;
    assert v_after is distinct from v_before,
        'T3: content trigger did not bump content_updated_at on a migrated row';

    -- Restore the original content: T4 compares this base card against the hash
    -- its clone was re-baselined to, so leaving it mutated would make T4 fail
    -- for a reason that has nothing to do with re-baselining.
    update public.cards set l2_definition = v_original_def where id = v_card_id;
    raise notice 'PASS T3: content trigger fires correctly on migrated rows';
end $$;

-- 4: base_version_hash was re-baselined into the new hash format, and local
-- edit state survived.
--
-- base_version_hash records which version of the BASE card the clone was last
-- synced against - it is not a fingerprint of the user's own content. So both
-- clones, edited or not, should hash-match their base here, because neither
-- base card changed during the migration. Whether the user has local edits is a
-- separate question answered by comparing content, and that is what must not be
-- lost: the migration rewrote every field these hashes are computed over.
do $$
declare
    v_unedited_in_sync boolean;
    v_edited_in_sync boolean;
    v_unedited_content_same boolean;
    v_edited_content_same boolean;
begin
    select public._card_content_hash(bc.*) = uc.base_version_hash,
           public._card_sync_content(uc.*) = public._card_sync_content(bc.*)
      into v_unedited_in_sync, v_unedited_content_same
    from public.cards uc
    join public.decks ud on ud.id = uc.deck_id and ud.slug = 'alice-travel'
    join public.cards bc on bc.id = uc.base_card_id
    where uc.l1_text = 'pasaporte';

    select public._card_content_hash(bc.*) = uc.base_version_hash,
           public._card_sync_content(uc.*) = public._card_sync_content(bc.*)
      into v_edited_in_sync, v_edited_content_same
    from public.cards uc
    join public.decks ud on ud.id = uc.deck_id and ud.slug = 'alice-travel'
    join public.cards bc on bc.id = uc.base_card_id
    where uc.l1_text = 'maleta';

    assert v_unedited_in_sync,
        'T4: untouched clone should be re-baselined to its base current hash';
    assert v_edited_in_sync,
        'T4: edited clone should also be re-baselined to its base current hash';
    assert v_unedited_content_same,
        'T4: untouched clone content should still equal its base after the rename';
    assert not v_edited_content_same,
        'T4: the local edit must survive the migration as a content difference';
    raise notice 'PASS T4: base_version_hash re-baselined and local edit state preserved';
end $$;

-- 5: the read path still returns rows for migrated data, with the pair attached
do $$
declare
    v_json jsonb;
    v_card_id bigint;
begin
    select c.id into v_card_id
    from public.cards c
    join public.decks d on d.id = c.deck_id
    where d.slug = 'market-travel' and c.l1_text = 'pasaporte';

    v_json := public._preview_card_json(v_card_id);
    assert v_json->>'prompt_l1' = 'pasaporte', 'T5: preview json missing prompt_l1';
    assert v_json->>'prompt_es' = 'pasaporte', 'T5: preview json lost the legacy prompt_es dual-emit';
    raise notice 'PASS T5: card json serves both role-named and legacy keys for migrated rows';
end $$;

-- 6: cards_legacy reads migrated rows under the old names
do $$
declare
    v_count int;
begin
    select count(*) into v_count from public.cards_legacy where spanish_text = 'pasaporte';
    assert v_count >= 1, 'T6: cards_legacy should expose migrated rows under the old column names';
    raise notice 'PASS T6: cards_legacy reads migrated rows';
end $$;

do $$ begin raise notice 'ALL MIGRATION-WITH-DATA TESTS PASSED'; end $$;
select 'ALL MIGRATION-WITH-DATA TESTS PASSED' as result;
