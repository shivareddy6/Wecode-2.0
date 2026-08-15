-- ============================================================================
-- Cleanup pass after the v2 schema migration.
--
-- 1. Drop the v1 on_auth_user_created trigger + its two backing functions.
--    v2 deliberately does NOT auto-populate public.users on auth.users
--    insert — the app inserts the row itself, after LeetCode identity is
--    verified during sync (Epic 01, Story 1/6), with leetcode_id/username
--    the trigger never had. Left in place, it would fire on every new
--    Supabase Auth user and fail against the new NOT NULL columns.
-- 2. Revoke `anon` EXECUTE on the two RLS helper functions. `authenticated`
--    keeps EXECUTE — RLS policy evaluation for authenticated queries
--    depends on it — but a fully unauthenticated caller has no legitimate
--    reason to invoke these directly via the auto-generated RPC API.
-- ============================================================================

drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user();
drop function if exists public.update_updated_at_column();

revoke execute on function public.is_room_member(uuid) from anon;
revoke execute on function public.is_room_host(uuid) from anon;
