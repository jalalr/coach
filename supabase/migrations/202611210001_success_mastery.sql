begin;

create table if not exists public.coach_course_documents (
  revision text not null,
  document_id text not null,
  payload jsonb not null,
  primary key (revision, document_id)
);

create table if not exists public.coach_course_activity (
  user_id uuid not null references auth.users (id) on delete cascade,
  revision text not null,
  section text not null,
  item_id text not null,
  response text not null check (length(response) <= 3000),
  correct boolean,
  topic text,
  updated_at timestamptz not null default now(),
  primary key (user_id, revision, section, item_id)
);

alter table public.coach_course_documents enable row level security;
alter table public.coach_course_activity enable row level security;
revoke all on public.coach_course_documents, public.coach_course_activity from public, anon, authenticated;
grant select on public.coach_course_documents to service_role;
grant select, insert, update on public.coach_course_activity to service_role;

commit;
