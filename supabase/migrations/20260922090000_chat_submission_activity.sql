-- Epic 07, Story 5 — system-style chat entries for submission activity.
-- chat_messages needs a way to distinguish a system-generated "so-and-so
-- solved X" entry from a normal typed message, and to carry the
-- out-of-contest flag for distinct rendering — a submission event can't be
-- computed on the fly at render time instead, because submissions get
-- wiped on every start_room_round() while chat is meant to survive round
-- transitions (see docs/SCHEMA.md's "Chat spans rounds regardless" note).
-- Modeled directly on submissions.is_out_of_contest's own naming.
alter table public.chat_messages
  add column kind text not null default 'user'
    check (kind in ('user', 'submission')),
  add column is_out_of_contest boolean not null default false;

comment on column public.chat_messages.kind is
  'user: typed by a participant (Story 1-4). submission: system-generated submission-activity entry (Story 5) — attributed to the submitter via user_id, but not typed by them.';
comment on column public.chat_messages.is_out_of_contest is
  'Only meaningful when kind = ''submission'' — mirrors submissions.is_out_of_contest so a late/after-deadline submission is visibly marked distinct from a scoring one, per Story 5''s AC.';
