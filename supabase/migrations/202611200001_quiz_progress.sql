begin;

create table public.coach_quiz_progress (
  user_id uuid not null references auth.users (id) on delete cascade,
  quiz_id text not null check (length(quiz_id) between 1 and 128),
  choices text[] not null check (cardinality(choices) <= 2 and choices <@ array['a', 'b', 'c']::text[]),
  version integer not null check (version > 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, quiz_id)
);

alter table public.coach_quiz_progress enable row level security;
revoke all privileges on table public.coach_quiz_progress from public, anon, authenticated;
grant select on table public.coach_quiz_progress to authenticated;

create policy coach_quiz_progress_read on public.coach_quiz_progress
  for select to authenticated using ((select auth.uid()) = user_id);

create function public.save_coach_quiz(p_quiz_id text, p_version integer, p_choices text[])
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner_id uuid := auth.uid();
  saved_version integer;
begin
  if owner_id is null or p_quiz_id is distinct from 'success-mastery-level-1-teachability-v1' or p_version is null or p_version < 0 then
    raise exception 'Invalid quiz save' using errcode = '22023';
  end if;

  if p_version = 0 then
    insert into public.coach_quiz_progress (user_id, quiz_id, choices, version)
    values (owner_id, p_quiz_id, p_choices, 1)
    on conflict (user_id, quiz_id) do nothing
    returning version into saved_version;
  else
    update public.coach_quiz_progress
       set choices = p_choices, version = version + 1, updated_at = now()
     where user_id = owner_id and quiz_id = p_quiz_id and version = p_version
    returning version into saved_version;
  end if;

  return saved_version;
end;
$$;

revoke all on function public.save_coach_quiz(text, integer, text[]) from public, anon, authenticated;
grant execute on function public.save_coach_quiz(text, integer, text[]) to authenticated;

commit;
