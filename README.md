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

Render environment variables:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SNAPSHOT_SECRET`

GitHub repository secrets:

- `RENDER_APP_URL`
- `SNAPSHOT_SECRET`
