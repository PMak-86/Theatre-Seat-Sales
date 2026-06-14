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
