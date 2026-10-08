-- UI revamp — chat's submission-activity entries (Epic 07, Story 5) move
-- from a colored text line to a distinct card (icon, problem title,
-- difficulty chip, confetti on a solve). Rendering that off the existing
-- `body` string would mean parsing "X solved Y (difficulty)" text at
-- render time — exactly the coupling-to-wording risk the original Story 5
-- decision (20260922090000_chat_submission_activity.sql) already chose
-- real columns to avoid. Same call here: structured columns, body stays
-- as a plain-text fallback/notification-style summary only.
alter table public.chat_messages
  add column problem_title text,
  add column problem_difficulty text check (problem_difficulty is null or problem_difficulty in ('easy', 'medium', 'hard')),
  add column is_solved boolean;

comment on column public.chat_messages.problem_title is
  'Only meaningful when kind = ''submission'' — the problem title at judge time, for the submission card (avoids parsing body text at render time).';
comment on column public.chat_messages.problem_difficulty is
  'Only meaningful when kind = ''submission'' — mirrors submissions.difficulty, drives the card''s difficulty chip color.';
comment on column public.chat_messages.is_solved is
  'Only meaningful when kind = ''submission'' — true for an accepted verdict, false for any other (drives the card''s icon/color and the confetti-on-solve treatment).';
