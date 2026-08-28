-- ===========================================================================
-- 0024: Enable undo / go back for skipped smart-practice cards.
--
-- Previously, skip_smart_practice_card (0013) cleared last_review_snapshot to
-- null, on the assumption that skips (e.g. listening aid on new words, multiple
-- choice / reverse MC / word-bank cloze recognition wins, and near-miss typos)
-- are not graded actions and therefore shouldn't be undoable.
--
-- However, learners frequently want to go back to review the card or word they
-- just saw/answered. Because a skip only moves the card to the back of the queue
-- and increments times_presented without changing FSRS memory state, undoing a
-- skip simply restores the card's previous queue position, times_presented,
-- last_presented_at, and last_result, bringing the card right back to the front
-- of the queue with can_undo properly reported.
-- ===========================================================================

create or replace function public.skip_smart_practice_card(p_session_id bigint, p_card_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_status text;
    v_entry_id bigint;
    v_entry_card_id bigint;
    v_prev_queue_pos int;
    v_prev_status text;
    v_prev_times int;
    v_prev_presented_at timestamptz;
    v_prev_result text;
    v_cp_before jsonb;
    v_now timestamptz := now();
    v_next_pos int;
begin
    if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;

    select status into v_status
    from public.practice_sessions where id = p_session_id and user_id = v_uid;
    if not found then raise exception 'Smart practice session not found'; end if;
    if v_status <> 'active' then raise exception 'Smart practice session is no longer active'; end if;

    -- The current pending card is the front of the queue; verify it matches.
    select id, card_id, queue_position, status, times_presented, last_presented_at, last_result
    into v_entry_id, v_entry_card_id, v_prev_queue_pos, v_prev_status, v_prev_times, v_prev_presented_at, v_prev_result
    from public.practice_session_cards
    where session_id = p_session_id and status = 'pending'
    order by queue_position asc limit 1;

    if not found then
        update public.practice_sessions set status = 'completed', completed_at = v_now, updated_at = v_now where id = p_session_id;
        raise exception 'Smart practice session is already complete';
    end if;
    if v_entry_card_id <> p_card_id then
        raise exception 'Submitted card does not match the active smart practice card';
    end if;

    -- Snapshot the pre-skip FSRS state alongside the queue state so undo can restore it.
    select to_jsonb(cp) into v_cp_before
    from public.card_progress cp where cp.card_id = p_card_id;

    -- Recycle to the back of the queue. Bump times_presented (it WAS shown), but
    -- never call _apply_card_progress and clear last_result. A skip always
    -- re-queues (never completes), so the pending count is unchanged and
    -- the session cannot finish here.
    select coalesce(max(queue_position), -1) + 1 into v_next_pos
    from public.practice_session_cards where session_id = p_session_id;

    update public.practice_session_cards
    set queue_position = v_next_pos,
        times_presented = times_presented + 1,
        last_presented_at = v_now,
        last_result = null
    where id = v_entry_id;

    -- Record the one-step undo snapshot so the learner can go back to this card.
    update public.practice_sessions
    set last_review_snapshot = jsonb_build_object(
        'card_id', p_card_id,
        'card_progress', v_cp_before,
        'session_card', jsonb_build_object(
            'queue_position', v_prev_queue_pos,
            'status', v_prev_status,
            'times_presented', v_prev_times,
            'last_presented_at', v_prev_presented_at,
            'last_result', v_prev_result
        )
    ),
    updated_at = v_now
    where id = p_session_id;

    return public._practice_session_snapshot(p_session_id, v_uid);
end;
$$;

revoke execute on function public.skip_smart_practice_card(bigint, bigint) from public, anon;
grant execute on function public.skip_smart_practice_card(bigint, bigint) to authenticated;

notify pgrst, 'reload schema';
