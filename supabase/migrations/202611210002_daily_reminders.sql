begin;

create table if not exists public.coach_push_subscriptions (
  user_id uuid not null references auth.users (id) on delete cascade,
  endpoint text not null,
  subscription jsonb not null,
  time_zone text not null,
  minute_of_day integer not null check (minute_of_day between 0 and 1439),
  last_sent_day date,
  attempted_at timestamptz,
  tested_at timestamptz,
  primary key (user_id, endpoint)
);

alter table public.coach_push_subscriptions enable row level security;
revoke all on public.coach_push_subscriptions from public, anon, authenticated;
grant select, insert, update, delete on public.coach_push_subscriptions to service_role;

create or replace function public.claim_coach_push_reminders()
returns table (user_id uuid, endpoint text, subscription jsonb, reminder_day date)
language sql
set search_path = ''
as $$
  with due as (
    select p.user_id, p.endpoint, (now() at time zone tz.name)::date as reminder_day
    from public.coach_push_subscriptions p
    join pg_catalog.pg_timezone_names tz on tz.name = p.time_zone
    cross join lateral (select (now() at time zone tz.name) as local_clock) clock
    cross join lateral (select extract(hour from clock.local_clock)::int * 60 + extract(minute from clock.local_clock)::int as minute) local_time
    where local_time.minute >= p.minute_of_day and local_time.minute < p.minute_of_day + 15
      and p.last_sent_day is distinct from clock.local_clock::date
      and (p.attempted_at is null or p.attempted_at < now() - interval '4 minutes')
    order by p.attempted_at nulls first
    limit 25
    for update of p skip locked
  )
  update public.coach_push_subscriptions p
  set attempted_at = now()
  from due
  where p.user_id = due.user_id and p.endpoint = due.endpoint
  returning p.user_id, p.endpoint, p.subscription, due.reminder_day;
$$;

revoke all on function public.claim_coach_push_reminders() from public, anon, authenticated;
grant execute on function public.claim_coach_push_reminders() to service_role;

create extension if not exists pg_cron;
create extension if not exists pg_net;

commit;
