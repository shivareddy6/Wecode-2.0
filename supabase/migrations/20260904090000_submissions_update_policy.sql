-- ============================================================================
-- public.submissions was missing an UPDATE policy — insert (the initial
-- 'pending' row) and select were covered, but nothing let the verdict get
-- written back once LeetCode resolves it (Epic 03, Story 2/3). RLS denies
-- by default when no policy matches an operation, so this was a real gap,
-- not an oversight caught by testing yet since nothing wrote verdicts
-- until now.
-- ============================================================================
create policy "users can update their own submissions"
  on public.submissions for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
