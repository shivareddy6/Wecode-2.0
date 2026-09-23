-- ============================================================================
-- Epic 04, Story 8 (spike, picked up for real) — transfer host powers to
-- another participant. Cheap specifically because the host already holds a
-- real room_participants row (see host_is_a_participant migration): the
-- outgoing host's leaderboard standing/chat presence need no changes at
-- all, this is purely rooms.host_user_id moving to a different existing
-- member.
--
-- "hosts manage their own rooms" (v2_schema migration) only ever had an
-- implicit WITH CHECK (defaults to the USING clause when none is given),
-- which required the post-update row's host_user_id to still equal
-- auth.uid() — i.e. it physically could not permit host_user_id changing
-- to someone else. USING stays as-is (only the current host may update the
-- row at all); WITH CHECK is now widened to also allow the new
-- host_user_id to be any other active participant of the same room. A
-- direct table update, no new RPC — same "no new SQL function" shape as
-- endRound/closeRoom/removeParticipant.
-- ============================================================================
alter policy "hosts manage their own rooms"
  on public.rooms
  with check (
    host_user_id = auth.uid()
    or exists (
      select 1 from public.room_participants rp
      where rp.room_id = id
        and rp.user_id = host_user_id
        and rp.removed_at is null
    )
  );
