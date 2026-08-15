-- ============================================================================
-- Second hardening pass, from the post-migration security advisor output.
--
-- 1. Pin search_path on our three functions. All are SECURITY DEFINER or
--    read sensitive predicate/scoring logic; an unset search_path lets a
--    role with schema-creation rights shadow an unqualified object name.
--    We already fully-qualify every reference with `public.`, so pinning
--    search_path to just `public` is a pure hardening step, not a behavior
--    change.
-- 2. Revoke every privilege from `anon` on all nine app tables. No policy
--    anywhere grants `anon` access — every policy is `to authenticated` —
--    so `anon` currently holds default table-level grants it can never
--    actually use through RLS, but revoking them removes even the
--    GraphQL-introspection-level discoverability, matching the "no public
--    browsing" design goal for rooms. The anonymous demo/guest and
--    invite-code-preview flows (Epics 10, 04) both go through service-role
--    Route Handlers, not the anon-key client, so this revoke changes
--    nothing about how either of those features work.
--
-- Not fixed: the `auth_leaked_password_protection` advisory. It's a
-- Supabase Auth default about password-based signup, and v2 has no
-- passwords at all (LeetCode-only identity) — not applicable to this app.
-- ============================================================================

alter function public.is_room_member(uuid) set search_path = public;
alter function public.is_room_host(uuid) set search_path = public;
alter function public.compute_leaderboard(uuid) set search_path = public;

revoke all on public.users from anon;
revoke all on public.user_credentials from anon;
revoke all on public.rooms from anon;
revoke all on public.room_participants from anon;
revoke all on public.sessions from anon;
revoke all on public.session_problems from anon;
revoke all on public.submissions from anon;
revoke all on public.chat_messages from anon;
revoke all on public.scoring_config from anon;
