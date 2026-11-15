# Theatre Seat Sales

TicketSearch seat-sales dashboard for theatre events.

## Run locally

```powershell
python server.py
```

Then open:

```text
http://127.0.0.1:8787/
```

## Deploy to Render

This project is configured for Render with `render.yaml`.

Render settings:

- Runtime: Python
- Build command: `pip install -r requirements.txt`
- Start command: `python server.py`
- Health check path: `/`

The server reads Render's `PORT` environment variable automatically.

## Sales history

The app stores a snapshot each time an event is analysed, then a GitHub Actions workflow calls the daily snapshot endpoint once per day for every tracked event.

A second workflow calls the final snapshot endpoint every 5 minutes. The app only stores a final snapshot when a tracked performance is within the pre-show window, so completed performances can keep their last pre-show figures even after the ticketing provider stops returning them.

Render environment variables:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SNAPSHOT_SECRET`

GitHub repository secrets:

- `RENDER_APP_URL`
- `SNAPSHOT_SECRET`

## Dashboard redesign

Responsive workspace with performance search, filters, sorting, CSV export, saved shows, history ranges and updated post-show reports. Local Funnel fonts and motion assets are included; no frontend build step is required. Existing Render settings and scheduled jobs are unchanged.

Validation: `python -m unittest discover -s tests`, `node --test tests/report.test.cjs`, `node --check app.js`, `node --check report.js`.

## Daily snapshot reliability

The primary Supabase cron remains at 18:15 UTC (05:15 Sydney during daylight saving). GitHub Actions checks again at 18:35, 19:15 and 21:15 UTC; schedules can be delayed by GitHub. Each run skips complete daily captures for the current Sydney date and retries missing events up to three times. A capture is complete only when its performance rows have also been stored. Captures retain their actual collection time; missing past dates are never fabricated.

Apply `supabase-daily-snapshot-reliability.sql` before deploying this backend. Service-only `daily_snapshot_attempts` records each attempt, outcome and sanitized error; a running record without a finish time indicates interruption. HTTP 503 and a failed Actions run signal incomplete capture. GitHub failure notifications follow your account/repository Actions notification preferences; no separate email service is configured. The workflow requires the existing `RENDER_APP_URL` and `SNAPSHOT_SECRET` secrets.

Manual recovery: run the **Daily sales snapshot** workflow. Completed events are skipped. If persistent failures remain, inspect the workflow summary and `daily_snapshot_attempts` before retrying. Overlap protection applies within one server process; this service currently runs one process.
