alter table public.campaign_posts add column removed_at timestamptz;
alter table public.campaign_posts drop constraint campaign_posts_tracked_event_id_platform_source_key_key;
create unique index campaign_posts_active_source_key
  on public.campaign_posts (tracked_event_id, platform, source_key)
  where removed_at is null;

create or replace function public.claim_campaign_post(target uuid)
returns table (post_id uuid)
language sql security invoker set search_path = '' as $$
  update public.campaign_posts p
  set last_attempt_at = now()
  from public.tracked_events e
  where p.id = target and p.tracked_event_id = e.id and p.removed_at is null
    and e.date_end + interval '3 hours' > now()
    and (p.last_attempt_at is null or p.last_attempt_at < now() - interval '50 minutes')
  returning p.id
$$;
revoke all on function public.claim_campaign_post(uuid) from public, anon, authenticated;
grant execute on function public.claim_campaign_post(uuid) to service_role;
