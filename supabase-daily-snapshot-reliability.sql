-- Service-only diagnostic records; no public client access.
create table public.daily_snapshot_attempts (
 id uuid primary key,
 tracked_event_id uuid not null references public.tracked_events(id),
 started_at timestamptz not null default now(),
 finished_at timestamptz,
 attempt integer not null check (attempt between 1 and 3),
 status text not null check (status in ('running','succeeded','failed')),
 snapshot_id uuid references public.event_snapshots(id),
 error text
);
create index daily_snapshot_attempts_started_idx on public.daily_snapshot_attempts(started_at desc);
alter table public.daily_snapshot_attempts enable row level security;
revoke all on public.daily_snapshot_attempts from anon, authenticated;
grant select, insert, update on public.daily_snapshot_attempts to service_role;

-- A parent row alone is insufficient: performance storage may have failed.
create or replace function public.theatre_daily_snapshot_coverage()
returns table(tracked_event_id uuid)
language sql stable security invoker set search_path = '' as $$
 select distinct s.tracked_event_id
 from public.event_snapshots s
 where s.source = 'daily'
 and s.captured_at >= ((now() at time zone 'Australia/Sydney')::date::timestamp at time zone 'Australia/Sydney')
 and s.captured_at < (((now() at time zone 'Australia/Sydney')::date + 1)::timestamp at time zone 'Australia/Sydney')
 and s.performances = (select count(*) from public.performance_snapshots p where p.event_snapshot_id=s.id)
$$;
revoke all on function public.theatre_daily_snapshot_coverage() from public, anon, authenticated;
grant execute on function public.theatre_daily_snapshot_coverage() to service_role;
