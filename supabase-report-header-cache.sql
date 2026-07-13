alter table public.tracked_events
  add column if not exists report_header_url text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'report-headers',
  'report-headers',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;
