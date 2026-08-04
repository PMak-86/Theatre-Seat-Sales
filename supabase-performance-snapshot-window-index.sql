-- Supports the frequent final-snapshot eligibility checks by event and show time.
create index if not exists performance_snapshots_event_show_datetime_idx
    on public.performance_snapshots (tracked_event_id, show_datetime);
