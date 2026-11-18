alter table public.campaign_posts add column refresh_requested_at timestamptz;

create function public.request_campaign_refresh(show_id uuid)
returns table (post_id uuid)
language sql security invoker set search_path = '' as $$
  update public.campaign_posts p set refresh_requested_at = now()
  from public.tracked_events e
  where e.id = show_id and p.tracked_event_id = e.id and p.removed_at is null
    and e.date_end + interval '3 hours' > now()
    and p.published_on <= (now() at time zone 'Australia/Sydney')::date
    and (p.refresh_requested_at is null or p.refresh_requested_at <=
      (select max(c.captured_at) from public.campaign_captures c where c.post_id=p.id))
  returning p.id
$$;
revoke all on function public.request_campaign_refresh(uuid) from public, anon, authenticated;
grant execute on function public.request_campaign_refresh(uuid) to service_role;

drop function public.claim_campaign_post(uuid);
create function public.claim_campaign_post(target uuid)
returns table (post_id uuid, attempt_at timestamptz)
language sql security invoker set search_path = '' as $$
  update public.campaign_posts p set last_attempt_at = now()
  from public.tracked_events e
  where p.id=target and p.tracked_event_id=e.id and p.removed_at is null
    and e.date_end + interval '3 hours' > now()
    and (p.last_attempt_at is null or p.last_attempt_at < now() - interval '50 minutes'
      or p.last_attempt_at <= (select max(c.captured_at) from public.campaign_captures c where c.post_id=p.id))
  returning p.id, p.last_attempt_at
$$;
revoke all on function public.claim_campaign_post(uuid) from public, anon, authenticated;
grant execute on function public.claim_campaign_post(uuid) to service_role;
