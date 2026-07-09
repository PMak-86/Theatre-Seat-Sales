create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

create or replace function public.configure_theatre_snapshot_cron_secret(secret_value text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if secret_value is null or length(secret_value) < 16 then
    raise exception 'Snapshot secret is missing or too short';
  end if;

  if exists (
    select 1
    from vault.decrypted_secrets
    where name = 'theatre_snapshot_secret'
  ) then
    perform vault.update_secret(
      (
        select id
        from vault.decrypted_secrets
        where name = 'theatre_snapshot_secret'
      ),
      secret_value,
      'theatre_snapshot_secret'
    );
  else
    perform vault.create_secret(secret_value, 'theatre_snapshot_secret');
  end if;

  return true;
end
$$;

revoke all on function public.configure_theatre_snapshot_cron_secret(text)
from public, anon, authenticated;
grant execute on function public.configure_theatre_snapshot_cron_secret(text)
to service_role;

select cron.schedule(
  'theatre-final-snapshots',
  '*/5 * * * *',
  $$
    select net.http_get(
      url := (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'theatre_render_url'
      ) || '/api/snapshot/finals',
      params := jsonb_build_object(
        'windowMinutes', '15',
        'lateGraceMinutes', '30'
      ),
      headers := jsonb_build_object(
        'X-Snapshot-Secret',
        (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'theatre_snapshot_secret'
        )
      ),
      timeout_milliseconds := 300000
    )
  $$
);

select cron.schedule(
  'theatre-daily-snapshot',
  '15 18 * * *',
  $$
    select net.http_get(
      url := (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'theatre_render_url'
      ) || '/api/snapshot/daily',
      headers := jsonb_build_object(
        'X-Snapshot-Secret',
        (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'theatre_snapshot_secret'
        )
      ),
      timeout_milliseconds := 300000
    )
  $$
);
