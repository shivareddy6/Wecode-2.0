-- ============================================================================
-- Fixes a mistake in v2_schema_hardening: EXECUTE on is_room_member/
-- is_room_host was granted to PUBLIC by default at CREATE FUNCTION time, so
-- `revoke ... from anon` there had no effect — anon still inherited access
-- via PUBLIC, since a revoke from one named role never overrides a broader
-- PUBLIC-level grant. Confirmed directly with has_function_privilege(),
-- not just the advisor report (which appears to cache/lag).
--
-- Correct fix: revoke from PUBLIC outright, then grant back explicitly to
-- authenticated only, which is the sole role that legitimately needs it
-- (RLS policy evaluation for authenticated queries depends on it).
-- ============================================================================

revoke execute on function public.is_room_member(uuid) from public;
revoke execute on function public.is_room_host(uuid) from public;

grant execute on function public.is_room_member(uuid) to authenticated;
grant execute on function public.is_room_host(uuid) to authenticated;
