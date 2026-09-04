-- End-to-end assertions for migration 0017 (runs after it).
-- Users: Alice = subscriber, Bob = first maintainer, Carol = later maintainer.
\set ON_ERROR_STOP on

-- Test helper: re-save a card through the real update_card RPC, overriding
-- selected fields and preserving the rest.
create or replace function public.__test_edit_card(
    p_card_id bigint, p_definition text default null, p_mnemonic text default null, p_answer text default null
) returns jsonb language plpgsql as $$
declare c public.cards%rowtype;
begin
    select * into c from public.cards where id = p_card_id;
    return public.update_card(
        p_card_id, c.l1_text, coalesce(p_answer, c.l2_text), c.section_name, c.part_of_speech,
        coalesce(p_definition, c.l2_definition),
        array(select jsonb_array_elements_text(coalesce(c.l1_translations, '[]'::jsonb))),
        array(select jsonb_array_elements_text(coalesce(c.collocations, '[]'::jsonb))),
        array(select jsonb_array_elements_text(coalesce(c.l2_synonyms, '[]'::jsonb))),
        c.example_sentence, c.example_l1, c.example_l2,
        coalesce(p_mnemonic, c.l2_mnemonic)
    );
end $$;

-- ---------------------------------------------------------------- T1 backfill
do $$
declare
    alice constant uuid := '11111111-1111-1111-1111-111111111111';
    v_deck bigint; v_n int;
begin
    select id into v_deck from public.decks where user_id = alice;
    assert v_deck is not null, 'alice clone exists';

    select count(*) into v_n from public.cards where deck_id = v_deck;
    assert v_n = 3, 'alice has 3 cards, got ' || v_n;

    select count(*) into v_n from public.cards where deck_id = v_deck and base_card_id is null;
    assert v_n = 0, 'backfill linked every alice card';

    select count(*) into v_n from public.cards c
    where c.deck_id = v_deck and c.base_version_hash is distinct from public._card_content_hash(c);
    assert v_n = 0, 'backfill hashed the USER content as baseline';

    select count(*) into v_n from public.cards where deck_id = v_deck and l2_mnemonic is not null;
    assert v_n = 0, 'legacy clone lost mnemonics (pre-0017 bug reproduced)';

    raise notice 'T1 backfill OK';
end $$;

-- ------------------------------------------- T2 update detection (badge+status)
do $$
declare
    alice constant uuid := '11111111-1111-1111-1111-111111111111';
    v jsonb; v_deck jsonb; v_status jsonb;
begin
    perform set_config('app.uid', alice::text, false);

    v := public.get_home_decks();
    select d.value into v_deck from jsonb_array_elements(v) d where d.value ->> 'title' = 'Animals';
    assert v_deck is not null, 'animals deck on home';
    assert (v_deck ->> 'updates_available')::int = 3,
        'expected 3 pending updates, got ' || (v_deck ->> 'updates_available');

    v_status := public.get_deck_sync_status((v_deck ->> 'id')::bigint);
    assert (v_status ->> 'linked')::boolean, 'deck linked';
    assert jsonb_array_length(v_status -> 'changed') = 3, 'all 3 cards changed (mnemonic loss + local edit)';
    assert jsonb_array_length(v_status -> 'added') = 0, 'nothing added yet';
    assert jsonb_array_length(v_status -> 'removed') = 0, 'nothing removed yet';
    assert v_status -> 'deck_meta' = 'null'::jsonb, 'deck meta identical';
    assert (v_status ->> 'total_updates')::int = 3, 'total matches';
    assert not exists (
        select 1 from jsonb_array_elements(v_status -> 'changed') e
        where (e.value ->> 'locally_modified')::boolean
    ), 'backfilled baseline = user content, so nothing counts as locally modified';

    -- outgoing (proposable) changes: none, for the same reason
    v := public.get_deck_outgoing_changes((v_deck ->> 'id')::bigint);
    assert jsonb_array_length(v -> 'changes') = 0, 'no outgoing changes after backfill';

    raise notice 'T2 update detection OK';
end $$;

-- ----------------------------------------------------- T3 apply all sync items
do $$
declare
    alice constant uuid := '11111111-1111-1111-1111-111111111111';
    v_deck bigint; v_status jsonb; v_items jsonb; v_res jsonb; v_answer text; v_n int;
begin
    perform set_config('app.uid', alice::text, false);
    select id into v_deck from public.decks where user_id = alice;

    v_status := public.get_deck_sync_status(v_deck);
    select jsonb_agg(jsonb_build_object('type', 'update', 'base_card_id', (e.value -> 'base_card' ->> 'card_id')::bigint))
    into v_items from jsonb_array_elements(v_status -> 'changed') e;

    v_res := public.apply_deck_sync(v_deck, v_items);
    assert (v_res ->> 'applied')::int = 3, 'applied 3, got ' || (v_res ->> 'applied');
    assert jsonb_array_length(v_res -> 'skipped') = 0, 'nothing skipped';
    assert (v_res -> 'status' ->> 'total_updates')::int = 0, 'clean after apply';

    select count(*) into v_n from public.cards where deck_id = v_deck and l2_mnemonic is not null;
    assert v_n = 3, 'mnemonics pulled from market';

    select l2_text into v_answer from public.cards where deck_id = v_deck and l1_text = 'el gato';
    assert v_answer = 'cat', 'local edit reverted by full sync (visible+optional in UI)';

    raise notice 'T3 apply sync OK';
end $$;

-- ---------------------------------------------------------- T4 claim ownership
do $$
declare
    alice constant uuid := '11111111-1111-1111-1111-111111111111';
    bob   constant uuid := '22222222-2222-2222-2222-222222222222';
    v_market bigint; v jsonb; v_deck jsonb; v_failed boolean := false;
begin
    select id into v_market from public.decks where slug = 'animals';

    perform set_config('app.uid', bob::text, false);
    v := public.claim_market_deck(v_market);
    assert v ->> 'owner_name' = 'Bob', 'bob claimed the deck';

    -- second claim must fail
    perform set_config('app.uid', alice::text, false);
    begin
        perform public.claim_market_deck(v_market);
    exception when others then
        v_failed := true;
        assert sqlerrm like '%maintainer%', 'unexpected error: ' || sqlerrm;
    end;
    assert v_failed, 'claiming an owned deck must fail';

    v := public.get_market_decks();
    select d.value into v_deck from jsonb_array_elements(v) d where d.value ->> 'slug' = 'animals';
    assert v_deck ->> 'owner_name' = 'Bob', 'owner surfaced to other users';
    assert not (v_deck ->> 'is_owner')::boolean, 'alice is not owner';

    raise notice 'T4 claim ownership OK';
end $$;

-- --------------------------------- T5 maintainer edits market deck directly
do $$
declare
    alice constant uuid := '11111111-1111-1111-1111-111111111111';
    bob   constant uuid := '22222222-2222-2222-2222-222222222222';
    carol constant uuid := '33333333-3333-3333-3333-333333333333';
    v_market bigint; v_perro bigint; t0 timestamptz; t1 timestamptz; t2 timestamptz;
    v jsonb; v_deck jsonb; v_failed boolean := false;
begin
    select id into v_market from public.decks where slug = 'animals';
    select id into v_perro from public.cards where deck_id = v_market and l1_text = 'el perro';
    select content_updated_at into t0 from public.cards where id = v_perro;

    -- non-maintainer cannot edit a market card
    perform set_config('app.uid', carol::text, false);
    begin
        perform public.__test_edit_card(v_perro, p_definition := 'hacked');
    exception when others then
        v_failed := true;
        assert sqlerrm like '%Not authorized%', 'unexpected error: ' || sqlerrm;
    end;
    assert v_failed, 'non-maintainer market edit must fail';

    -- maintainer can
    perform set_config('app.uid', bob::text, false);
    perform public.__test_edit_card(v_perro, p_definition := 'A loyal domesticated canine');
    select content_updated_at into t1 from public.cards where id = v_perro;
    assert t1 > t0, 'content edit bumps content_updated_at';

    -- a no-op save must NOT bump it
    perform public.__test_edit_card(v_perro);
    select content_updated_at into t2 from public.cards where id = v_perro;
    assert t2 = t1, 'no-op save must not flag an update';

    -- subscriber sees exactly one pending update
    perform set_config('app.uid', alice::text, false);
    v := public.get_home_decks();
    select d.value into v_deck from jsonb_array_elements(v) d where d.value ->> 'title' = 'Animals';
    assert (v_deck ->> 'updates_available')::int = 1, 'one update after maintainer edit';

    raise notice 'T5 maintainer direct edit OK';
end $$;

-- -------------------- T6 add + disable in market, selective sync application
do $$
declare
    alice constant uuid := '11111111-1111-1111-1111-111111111111';
    bob   constant uuid := '22222222-2222-2222-2222-222222222222';
    v_market bigint; v_deck bigint; v_pajaro bigint; v_vaca bigint;
    v_status jsonb; v_res jsonb; v_uc public.cards%rowtype;
begin
    select id into v_market from public.decks where slug = 'animals';
    select id into v_deck from public.decks where user_id = alice;
    select id into v_pajaro from public.cards where deck_id = v_market and l1_text = 'el pajaro';

    -- market gains a card (seed-script style, superuser)
    perform set_config('app.uid', '', false);
    insert into public.cards (deck_id, l1_text, l2_text, section_name, part_of_speech,
        l2_definition, l2_mnemonic)
    values (v_market, 'la vaca', 'cow', 'Farm', 'noun', 'A large farm animal', 'VACA - a cow in a VACUUM.')
    returning id into v_vaca;

    -- maintainer hides a market card
    perform set_config('app.uid', bob::text, false);
    perform public.update_card_visibility(v_pajaro, false);

    -- subscriber sees add + change + removal
    perform set_config('app.uid', alice::text, false);
    v_status := public.get_deck_sync_status(v_deck);
    assert jsonb_array_length(v_status -> 'added') = 1, 'vaca offered as added';
    assert jsonb_array_length(v_status -> 'changed') = 1, 'perro offered as changed';
    assert jsonb_array_length(v_status -> 'removed') = 1, 'pajaro offered as removed';
    assert (v_status ->> 'total_updates')::int = 3, 'badge total 3';

    -- selective apply: only the addition
    v_res := public.apply_deck_sync(v_deck, jsonb_build_array(jsonb_build_object('type', 'add', 'base_card_id', v_vaca)));
    assert (v_res ->> 'applied')::int = 1, 'add applied';
    assert (v_res -> 'status' ->> 'total_updates')::int = 2, 'two updates left';

    select * into v_uc from public.cards where deck_id = v_deck and base_card_id = v_vaca;
    assert v_uc.id is not null and v_uc.l2_mnemonic is not null and v_uc.is_enabled, 'vaca cloned complete + enabled';
    assert v_uc.base_version_hash = (select public._card_content_hash(c) from public.cards c where c.id = v_vaca),
        'clone baseline = market content';

    -- duplicate add is skipped, not duplicated
    v_res := public.apply_deck_sync(v_deck, jsonb_build_array(jsonb_build_object('type', 'add', 'base_card_id', v_vaca)));
    assert (v_res ->> 'applied')::int = 0 and v_res -> 'skipped' -> 0 ->> 'reason' = 'already_present', 'dup add skipped';

    -- bogus removal (market card still live) is refused
    v_res := public.apply_deck_sync(v_deck, jsonb_build_array(jsonb_build_object('type', 'remove', 'card_id', v_uc.id)));
    assert v_res -> 'skipped' -> 0 ->> 'reason' = 'market_card_still_present', 'live card not removable';

    -- apply the rest: perro update + pajaro removal
    v_status := public.get_deck_sync_status(v_deck);
    v_res := public.apply_deck_sync(v_deck, jsonb_build_array(
        jsonb_build_object('type', 'update', 'base_card_id', (v_status -> 'changed' -> 0 -> 'base_card' ->> 'card_id')::bigint),
        jsonb_build_object('type', 'remove', 'card_id', (v_status -> 'removed' -> 0 -> 'user_card' ->> 'card_id')::bigint)
    ));
    assert (v_res ->> 'applied')::int = 2, 'rest applied';
    assert (v_res -> 'status' ->> 'total_updates')::int = 0, 'clean';

    select * into v_uc from public.cards where deck_id = v_deck and l1_text = 'el pajaro';
    assert not v_uc.is_enabled, 'removed = disabled locally';
    assert v_uc.base_card_id is not null, 'link kept for history';

    raise notice 'T6 add/disable + selective apply OK';
end $$;

-- ------------------------------------------ T7 conflict flag (both sides edit)
do $$
declare
    alice constant uuid := '11111111-1111-1111-1111-111111111111';
    bob   constant uuid := '22222222-2222-2222-2222-222222222222';
    v_market bigint; v_deck bigint; v_perro_mkt bigint; v_perro_mine bigint;
    v_status jsonb; v jsonb;
begin
    select id into v_market from public.decks where slug = 'animals';
    select id into v_deck from public.decks where user_id = alice;
    select id into v_perro_mkt from public.cards where deck_id = v_market and l1_text = 'el perro';
    select id into v_perro_mine from public.cards where deck_id = v_deck and base_card_id = v_perro_mkt;

    perform set_config('app.uid', alice::text, false);
    perform public.__test_edit_card(v_perro_mine, p_mnemonic := 'My dog Rex says PERRO.');

    perform set_config('app.uid', bob::text, false);
    perform public.__test_edit_card(v_perro_mkt, p_definition := 'Mans best friend');

    perform set_config('app.uid', alice::text, false);
    v_status := public.get_deck_sync_status(v_deck);
    assert jsonb_array_length(v_status -> 'changed') = 1, 'perro changed';
    assert (v_status -> 'changed' -> 0 ->> 'locally_modified')::boolean, 'conflict flagged';

    v := public.get_deck_outgoing_changes(v_deck);
    assert jsonb_array_length(v -> 'changes') = 1, 'perro proposable';
    assert not (v -> 'changes' -> 0 ->> 'already_proposed')::boolean, 'not proposed yet';

    raise notice 'T7 conflict detection OK';
end $$;

-- ----------------------------------------------- T8 proposal: create + approve
do $$
declare
    alice constant uuid := '11111111-1111-1111-1111-111111111111';
    bob   constant uuid := '22222222-2222-2222-2222-222222222222';
    carol constant uuid := '33333333-3333-3333-3333-333333333333';
    v_market bigint; v_deck bigint; v_perro_mkt bigint; v_perro_mine bigint;
    v jsonb; v_prop bigint; v_failed boolean := false; v_failed2 boolean := false;
begin
    select id into v_market from public.decks where slug = 'animals';
    select id into v_deck from public.decks where user_id = alice;
    select id into v_perro_mkt from public.cards where deck_id = v_market and l1_text = 'el perro';
    select id into v_perro_mine from public.cards where deck_id = v_deck and base_card_id = v_perro_mkt;

    perform set_config('app.uid', alice::text, false);
    v := public.create_deck_change_proposal(v_market, '  Better mnemonic!  ', array[v_perro_mine]);
    v_prop := (v ->> 'proposal_id')::bigint;
    assert v ->> 'status' = 'open', 'proposal open';
    assert v ->> 'message' = 'Better mnemonic!', 'message trimmed';
    assert jsonb_array_length(v -> 'items') = 1, 'one item';
    assert v -> 'items' -> 0 ->> 'change_type' = 'edit_card', 'edit item';
    assert v -> 'items' -> 0 -> 'payload' ->> 'l2_mnemonic' = 'My dog Rex says PERRO.', 'payload from my card';
    assert not (v -> 'items' -> 0 ->> 'is_stale')::boolean, 'fresh right after create';

    v := public.get_deck_outgoing_changes(v_deck);
    assert (v -> 'changes' -> 0 ->> 'already_proposed')::boolean, 'flagged as already proposed';

    -- visibility: carol sees nothing, bob reviews, alice tracks her own
    perform set_config('app.uid', carol::text, false);
    v := public.list_deck_proposals();
    assert jsonb_array_length(v -> 'to_review') = 0 and jsonb_array_length(v -> 'mine') = 0, 'carol sees nothing';

    perform set_config('app.uid', bob::text, false);
    v := public.list_deck_proposals();
    assert jsonb_array_length(v -> 'to_review') = 1, 'bob has one to review';
    assert v -> 'to_review' -> 0 ->> 'proposer_name' = 'Alice', 'proposer named';

    perform set_config('app.uid', alice::text, false);
    v := public.list_deck_proposals();
    assert jsonb_array_length(v -> 'mine') = 1, 'alice tracks hers';

    -- only the maintainer may resolve
    begin
        perform public.resolve_deck_change_proposal(v_prop, 'approve');
    exception when others then
        v_failed := true;
        assert sqlerrm like '%maintainer%', 'unexpected: ' || sqlerrm;
    end;
    assert v_failed, 'proposer cannot approve';

    perform set_config('app.uid', carol::text, false);
    begin
        perform public.resolve_deck_change_proposal(v_prop, 'approve');
    exception when others then
        v_failed2 := true;
    end;
    assert v_failed2, 'random user cannot approve';

    -- maintainer approves; market absorbs the payload
    perform set_config('app.uid', bob::text, false);
    v := public.resolve_deck_change_proposal(v_prop, 'approve', 'Nice one, thanks!');
    assert v -> 'proposal' ->> 'status' = 'approved', 'approved';
    assert (v ->> 'applied')::int = 1, 'one item applied';
    assert (select l2_mnemonic from public.cards where id = v_perro_mkt) = 'My dog Rex says PERRO.', 'market updated';

    -- proposer is clean: content now equals market; fast-forward reconciles
    perform set_config('app.uid', alice::text, false);
    v := public.get_deck_sync_status(v_deck);
    assert (v ->> 'total_updates')::int = 0, 'proposer needs no sync after approval';

    -- resolving again must fail
    perform set_config('app.uid', bob::text, false);
    v_failed := false;
    begin
        perform public.resolve_deck_change_proposal(v_prop, 'reject');
    exception when others then
        v_failed := true;
        assert sqlerrm like '%no longer open%', 'unexpected: ' || sqlerrm;
    end;
    assert v_failed, 'double resolve must fail';

    raise notice 'T8 proposal approve OK';
end $$;

-- ------------------------------------------ T9 proposal: withdraw and reject
do $$
declare
    alice constant uuid := '11111111-1111-1111-1111-111111111111';
    bob   constant uuid := '22222222-2222-2222-2222-222222222222';
    v_market bigint; v_deck bigint; v_gato_mkt bigint; v_gato_mine bigint;
    v jsonb; v_prop bigint; v_failed boolean := false;
begin
    select id into v_market from public.decks where slug = 'animals';
    select id into v_deck from public.decks where user_id = alice;
    select id into v_gato_mkt from public.cards where deck_id = v_market and l1_text = 'el gato';
    select id into v_gato_mine from public.cards where deck_id = v_deck and base_card_id = v_gato_mkt;

    perform set_config('app.uid', alice::text, false);
    perform public.__test_edit_card(v_gato_mine, p_mnemonic := 'GATO opens the garden gate.');

    v := public.create_deck_change_proposal(v_market, null, array[v_gato_mine]);
    v_prop := (v ->> 'proposal_id')::bigint;
    v := public.withdraw_deck_change_proposal(v_prop);
    assert v ->> 'status' = 'withdrawn', 'withdrawn';

    begin
        perform public.withdraw_deck_change_proposal(v_prop);
    exception when others then
        v_failed := true;
    end;
    assert v_failed, 'double withdraw must fail';

    -- proposing again after withdrawal is allowed; maintainer rejects it
    v := public.create_deck_change_proposal(v_market, 'try again', array[v_gato_mine]);
    v_prop := (v ->> 'proposal_id')::bigint;

    perform set_config('app.uid', bob::text, false);
    v := public.resolve_deck_change_proposal(v_prop, 'reject', 'Prefer the original.');
    assert v -> 'proposal' ->> 'status' = 'rejected', 'rejected';
    assert v -> 'proposal' ->> 'resolution_note' = 'Prefer the original.', 'note kept';
    assert (select l2_mnemonic from public.cards where id = v_gato_mkt) = 'GATO - a cat at the GATE-oh.', 'market untouched';

    -- rejection frees the card for a future proposal
    perform set_config('app.uid', alice::text, false);
    v := public.get_deck_outgoing_changes(v_deck);
    assert jsonb_array_length(v -> 'changes') = 1
       and not (v -> 'changes' -> 0 ->> 'already_proposed')::boolean, 'gato proposable again';

    raise notice 'T9 withdraw/reject OK';
end $$;

-- ----------------------- T10 add_card proposal + back-link of proposer's card
do $$
declare
    alice constant uuid := '11111111-1111-1111-1111-111111111111';
    bob   constant uuid := '22222222-2222-2222-2222-222222222222';
    v_market bigint; v_deck bigint; v_tortuga bigint; v_mkt_tortuga bigint;
    v jsonb; v_prop bigint;
begin
    select id into v_market from public.decks where slug = 'animals';
    select id into v_deck from public.decks where user_id = alice;

    -- personal, unlinked card in alice's copy (as if user-authored)
    perform set_config('app.uid', '', false);
    insert into public.cards (deck_id, l1_text, l2_text, section_name, part_of_speech, l2_definition)
    values (v_deck, 'la tortuga', 'turtle', 'Wild', 'noun', 'A slow reptile with a shell')
    returning id into v_tortuga;

    perform set_config('app.uid', alice::text, false);
    v := public.create_deck_change_proposal(v_market, 'New card: turtle', array[v_tortuga]);
    v_prop := (v ->> 'proposal_id')::bigint;
    assert v -> 'items' -> 0 ->> 'change_type' = 'add_card', 'add item';

    perform set_config('app.uid', bob::text, false);
    v := public.resolve_deck_change_proposal(v_prop, 'approve');
    assert (v ->> 'applied')::int = 1, 'added to market';

    select id into v_mkt_tortuga from public.cards
    where deck_id = v_market and l1_text = 'la tortuga' and is_enabled and generation_phase = 'refined';
    assert v_mkt_tortuga is not null, 'market card created';

    -- proposer's card got linked, so it does not bounce back as "added"
    assert (select base_card_id from public.cards where id = v_tortuga) = v_mkt_tortuga, 'source card linked';
    perform set_config('app.uid', alice::text, false);
    v := public.get_deck_sync_status(v_deck);
    assert (v ->> 'total_updates')::int = 0, 'no echo updates for proposer';

    raise notice 'T10 add_card proposal OK';
end $$;

-- ------------------------------------------------------- T11 deck meta sync
do $$
declare
    alice constant uuid := '11111111-1111-1111-1111-111111111111';
    v_market bigint; v_deck bigint; v jsonb; v_res jsonb;
begin
    select id into v_market from public.decks where slug = 'animals';
    select id into v_deck from public.decks where user_id = alice;

    perform set_config('app.uid', '', false);
    update public.decks set title = 'Animals & Friends' where id = v_market;

    perform set_config('app.uid', alice::text, false);
    v := public.get_deck_sync_status(v_deck);
    assert v -> 'deck_meta' <> 'null'::jsonb, 'meta change detected';
    assert v -> 'deck_meta' -> 'market' ->> 'title' = 'Animals & Friends', 'market meta shown';
    assert (v ->> 'total_updates')::int = 1, 'meta counts once';

    v_res := public.apply_deck_sync(v_deck, jsonb_build_array(jsonb_build_object('type', 'deck_meta')));
    assert (v_res ->> 'applied')::int = 1, 'meta applied';
    assert (select title from public.decks where id = v_deck) = 'Animals & Friends', 'title copied';
    assert (v_res -> 'status' ->> 'total_updates')::int = 0, 'clean';

    raise notice 'T11 deck meta sync OK';
end $$;

-- ------------------------------------------------------------ T12 guard rails
do $$
declare
    alice constant uuid := '11111111-1111-1111-1111-111111111111';
    carol constant uuid := '33333333-3333-3333-3333-333333333333';
    v_market bigint; v_deck bigint; v_perro_mine bigint;
    v_failed boolean; v jsonb;
begin
    select id into v_market from public.decks where slug = 'animals';
    select id into v_deck from public.decks where user_id = alice;
    select c.id into v_perro_mine from public.cards c
    join public.cards b on b.id = c.base_card_id
    where c.deck_id = v_deck and c.l1_text = 'el perro';

    -- unauthenticated
    perform set_config('app.uid', '', false);
    v_failed := false;
    begin
        perform public.get_home_decks();
    exception when others then
        v_failed := true;
        assert sqlstate = '28000', 'expected 28000, got ' || sqlstate;
    end;
    assert v_failed, 'anon blocked';

    -- someone else's deck is invisible to sync
    perform set_config('app.uid', carol::text, false);
    v_failed := false;
    begin
        perform public.get_deck_sync_status(v_deck);
    exception when others then
        v_failed := true;
        assert sqlerrm like '%Deck not found%', 'unexpected: ' || sqlerrm;
    end;
    assert v_failed, 'foreign deck hidden';

    -- proposal with someone else's card
    v_failed := false;
    begin
        perform public.create_deck_change_proposal(v_market, null, array[v_perro_mine]);
    exception when others then
        v_failed := true;
        assert sqlerrm like '%not part of your copy%', 'unexpected: ' || sqlerrm;
    end;
    assert v_failed, 'foreign card rejected';

    -- empty selection
    perform set_config('app.uid', alice::text, false);
    v_failed := false;
    begin
        perform public.create_deck_change_proposal(v_market, null, array[]::bigint[]);
    exception when others then
        v_failed := true;
        assert sqlerrm like '%No cards selected%', 'unexpected: ' || sqlerrm;
    end;
    assert v_failed, 'empty proposal rejected';

    -- no-diff proposal (perro currently equals market)
    v_failed := false;
    begin
        perform public.create_deck_change_proposal(v_market, null, array[v_perro_mine]);
    exception when others then
        v_failed := true;
        assert sqlerrm like '%do not differ%', 'unexpected: ' || sqlerrm;
    end;
    assert v_failed, 'no-op proposal rejected';

    raise notice 'T12 guard rails OK';
end $$;

-- ------------------------------------------------------ T13 ownership transfer
do $$
declare
    bob   constant uuid := '22222222-2222-2222-2222-222222222222';
    carol constant uuid := '33333333-3333-3333-3333-333333333333';
    v_market bigint; v_perro bigint; v jsonb; v_failed boolean;
begin
    select id into v_market from public.decks where slug = 'animals';
    select id into v_perro from public.cards where deck_id = v_market and l1_text = 'el perro';

    perform set_config('app.uid', bob::text, false);
    v_failed := false;
    begin
        perform public.transfer_market_deck_ownership(v_market, 'nobody@nowhere.dev');
    exception when others then
        v_failed := true;
        assert sqlerrm like '%No account%', 'unexpected: ' || sqlerrm;
    end;
    assert v_failed, 'unknown email rejected';

    v := public.transfer_market_deck_ownership(v_market, 'Carol@Test.Dev');
    assert v ->> 'owner_name' = 'Carol', 'case-insensitive email transfer';

    -- bob lost his powers
    v_failed := false;
    begin
        perform public.__test_edit_card(v_perro, p_definition := 'bob was here');
    exception when others then
        v_failed := true;
    end;
    assert v_failed, 'ex-maintainer cannot edit';

    v_failed := false;
    begin
        perform public.transfer_market_deck_ownership(v_market, 'bob@test.dev');
    exception when others then
        v_failed := true;
        assert sqlerrm like '%current maintainer%', 'unexpected: ' || sqlerrm;
    end;
    assert v_failed, 'ex-maintainer cannot transfer';

    -- carol gained them
    perform set_config('app.uid', carol::text, false);
    perform public.__test_edit_card(v_perro, p_definition := 'Best friend of humans');

    raise notice 'T13 ownership transfer OK';
end $$;

-- ---------------------------- T14 fresh clone + hard delete + preview flags
do $$
declare
    alice constant uuid := '11111111-1111-1111-1111-111111111111';
    carol constant uuid := '33333333-3333-3333-3333-333333333333';
    v_market bigint; v_deck_c bigint; v_deck_a bigint; v_vaca_mkt bigint;
    v jsonb; v_deck jsonb; v_n int;
begin
    select id into v_market from public.decks where slug = 'animals';
    select id into v_deck_a from public.decks where user_id = alice;

    -- carol subscribes now: clone must be complete and clean
    perform set_config('app.uid', carol::text, false);
    perform public.update_deck_home_selection(v_market, true);
    select id into v_deck_c from public.decks where user_id = carol;

    select count(*) into v_n from public.cards where deck_id = v_deck_c and base_card_id is null;
    assert v_n = 0, 'fresh clone fully linked';
    select count(*) into v_n from public.cards where deck_id = v_deck_c and l2_mnemonic is not null;
    assert v_n >= 3, 'fresh clone keeps mnemonics (old bug fixed)';

    v := public.get_home_decks();
    select d.value into v_deck from jsonb_array_elements(v) d where (d.value ->> 'id')::bigint = v_deck_c;
    assert (v_deck ->> 'updates_available')::int = 0, 'fresh clone clean, got ' || (v_deck ->> 'updates_available');

    -- market card hard-deleted (seed maintenance): both subscribers see removal
    perform set_config('app.uid', '', false);
    select id into v_vaca_mkt from public.cards where deck_id = v_market and l1_text = 'la vaca';
    delete from public.cards where id = v_vaca_mkt;

    perform set_config('app.uid', alice::text, false);
    v := public.get_deck_sync_status(v_deck_a);
    assert jsonb_array_length(v -> 'removed') = 1, 'hard delete detected';
    perform public.apply_deck_sync(v_deck_a, jsonb_build_array(jsonb_build_object(
        'type', 'remove', 'card_id', (v -> 'removed' -> 0 -> 'user_card' ->> 'card_id')::bigint)));
    assert exists (select 1 from public.cards where deck_id = v_deck_a and l1_text = 'la vaca' and not is_enabled),
        'removal disables, never deletes';

    -- deck preview flags for each role
    v := public.get_deck_preview(v_deck_a);
    assert (v ->> 'can_edit')::boolean and not (v ->> 'is_market')::boolean
       and (v ->> 'base_deck_available')::boolean, 'personal preview flags';

    v := public.get_deck_preview(v_market);
    assert (v ->> 'is_market')::boolean and not (v ->> 'can_edit')::boolean
       and v ->> 'owner_name' = 'Carol', 'market preview flags for non-owner';

    perform set_config('app.uid', carol::text, false);
    v := public.get_deck_preview(v_market);
    assert (v ->> 'is_owner')::boolean and (v ->> 'can_edit')::boolean, 'owner preview flags';

    raise notice 'T14 fresh clone + delete + preview OK';
end $$;

drop function public.__test_edit_card(bigint, text, text, text);

do $$ begin raise notice 'ALL 0017 TESTS PASSED'; end $$;
