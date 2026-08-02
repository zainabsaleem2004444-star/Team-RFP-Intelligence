# Auto-Deploy Setup (Item 25)

New file: `.github/workflows/deploy.yml` — runs on every push to `main`, after your existing CI.

By default it deploys backend → **Render** and frontend → **Netlify**. Railway/Vercel jobs are included but disabled (`if: false`) — flip them on if you'd rather use those instead.

## Backend → Render
1. Render dashboard → your service → Settings → **Deploy Hook** → copy URL.
2. Repo → Settings → Secrets and variables → Actions → New secret:
   - `RENDER_DEPLOY_HOOK_URL` = the copied URL

## Frontend → Netlify
1. Netlify → User settings → Applications → **New access token** → copy it.
2. Netlify → your site → Site settings → **Site ID** → copy it.
3. Add repo secrets:
   - `NETLIFY_AUTH_TOKEN`
   - `NETLIFY_SITE_ID`

## If using Railway instead of Render
Set `deploy-backend-railway`'s `if: false` → `true`, and Render's job's `if:` to `false`.
Add secrets: `RAILWAY_TOKEN`, `RAILWAY_SERVICE_ID`.

## If using Vercel instead of Netlify
Set `deploy-frontend-vercel`'s `if: false` → `true`, and Netlify's job's `if:` to `false`.
Add secrets: `VERCEL_TOKEN` (and link the project once locally with `vercel link` to get `.vercel/project.json` committed, or pass `VERCEL_ORG_ID`/`VERCEL_PROJECT_ID` as env vars in the workflow).

No code changes needed beyond this — nothing in `server.js` or the frontend changes.
