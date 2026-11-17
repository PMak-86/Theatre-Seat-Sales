-- Campaign data is only accessed by the server's service role.
create table public.campaign_posts (
  id uuid primary key default gen_random_uuid(),
  tracked_event_id uuid not null references public.tracked_events(id),
  published_on date not null,
  platform text not null check (platform in ('facebook', 'instagram', 'tiktok')),
  post_type text not null check (post_type in ('photo', 'video', 'reel', 'carousel', 'story', 'link', 'text', 'other')),
  url text not null,
  notes text not null default '' check (char_length(notes) <= 1000),
  source_key text not null,
  added_at timestamptz not null default now(),
  preview jsonb,
  preview_image text,
  last_attempt_at timestamptz,
  capture_status text,
  unique (tracked_event_id, platform, source_key)
);

create table public.campaign_captures (
  post_id uuid not null references public.campaign_posts(id),
  capture_day date not null,
  captured_at timestamptz not null,
  cadence text not null check (cadence in ('weekly', 'daily')),
  views bigint check (views >= 0),
  clicks bigint check (clicks >= 0),
  engagements bigint check (engagements >= 0),
  likes bigint check (likes >= 0),
  comments bigint check (comments >= 0),
  shares bigint check (shares >= 0),
  primary key (post_id, capture_day)
);

create table public.campaign_access (
  id boolean primary key default true check (id),
  key_digest text not null check (key_digest ~ '^[0-9a-f]{64}$')
);
alter table public.campaign_access enable row level security;
revoke all on public.campaign_access from public, anon, authenticated;
grant select on public.campaign_access to service_role;

alter table public.campaign_posts enable row level security;
alter table public.campaign_captures enable row level security;
revoke all on public.campaign_posts, public.campaign_captures from public, anon, authenticated;
grant select, insert, update on public.campaign_posts, public.campaign_captures to service_role;

-- Claim a post with the database clock so overlapping workers and restarts
-- cannot re-query a provider on the same attempt.
create function public.claim_campaign_post(target uuid)
returns table (post_id uuid)
language sql security invoker set search_path = '' as $$
  update public.campaign_posts p
  set last_attempt_at = now()
  from public.tracked_events e
  where p.id = target and p.tracked_event_id = e.id
    and e.date_end + interval '3 hours' > now()
    and (p.last_attempt_at is null or p.last_attempt_at < now() - interval '50 minutes')
  returning p.id
$$;
revoke all on function public.claim_campaign_post(uuid) from public, anon, authenticated;
grant execute on function public.claim_campaign_post(uuid) to service_role;
