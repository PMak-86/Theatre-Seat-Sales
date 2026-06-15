# Render Deployment Checklist

Use these steps when you are ready to publish the dashboard.

## 1. Publish this folder to GitHub

Git is not available in the current terminal, so the quickest option is GitHub Desktop.

1. Install or open GitHub Desktop.
2. Choose `File > Add local repository`.
3. Select this folder:

   ```text
   C:\Users\peter\OneDrive\Documents\Theatre Seat Sales
   ```

4. If GitHub Desktop asks to create a repository here, choose `create a repository`.
5. Commit all files.
6. Click `Publish repository`.
7. Choose whether the repository should be private or public.

## 2. Create the Render service

1. Go to `https://dashboard.render.com`.
2. Sign in or create an account.
3. Click `New +`.
4. Choose `Blueprint` if Render offers it, because this project includes `render.yaml`.
5. Connect the GitHub repository you published.
6. Confirm the service settings.

If you create a Web Service manually instead of using Blueprint, use:

- Runtime: `Python`
- Build command: `pip install -r requirements.txt`
- Start command: `python server.py`
- Plan: `Free`
- Health check path: `/`

## 3. After deployment

1. Wait for Render to finish the first deploy.
2. Open the public Render URL.
3. Test a TicketSearch event URL in the input box.
4. If the first request is slow, wait and retry. Free services can take a moment to wake up.

## 4. Supabase history setup

Add these environment variables in Render:

- `SUPABASE_URL`: `https://esmgxpncusfkinygdpja.supabase.co`
- `SUPABASE_SERVICE_ROLE_KEY`: copy this from Supabase project settings. Use the service role key, not the anon key.
- `SNAPSHOT_SECRET`: create any long random secret string.

Add these repository secrets in GitHub:

- `RENDER_APP_URL`: your Render app URL, for example `https://theatre-seat-sales.onrender.com`
- `SNAPSHOT_SECRET`: the same value used in Render.

The GitHub Actions workflow in `.github/workflows/daily-snapshot.yml` calls `/api/snapshot/daily` once per day.

## 5. Future updates

After editing the site locally:

1. Commit the changes in GitHub Desktop.
2. Push to GitHub.
3. Render will redeploy automatically.
