-- compute_leaderboard was recreated by the room-centric-rounds migration
-- without search_path pinning, unlike every other function in this schema
-- (see SCHEMA.md's Authorization model section on why that matters).
alter function public.compute_leaderboard(uuid) set search_path = public;
