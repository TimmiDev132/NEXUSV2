# NEXUS BOT V3.3.1 — Koyeb (Free 24/7)

## 0) What you need
- GitHub account (free)
- Discord bot token + client id

## 1) Upload to GitHub (from phone works)
- Create a new repo on https://github.com/new (name: `nexus-bot`)
- Upload all files of this folder (incl. `Dockerfile`, `package.json`, `src/`, `data/`)

## 2) Deploy on Koyeb (free)
1. Go to https://app.koyeb.com/
2. Create Service → **GitHub** → choose your repo
3. Build preset: **Dockerfile** (auto-detected)
4. **Environment variables** (add):
   - `BOT_TOKEN` = your discord bot token
   - `CLIENT_ID` = your application client id
   - (optional) `SERVER_NAME`, `BRAND_COLOR`, `BANNER_URL`, `LOGO_URL`, `ANTISPAM_ENABLED`, `BLOCK_LINKS`
5. Health check: HTTP → Path `/health` (our app serves it)
6. Deploy → the bot goes online and stays 24/7.

## Notes
- The bot spins an HTTP server for keep-alive and health checks.
- First start will auto-create roles, channels and permissions on your Discord server.
- Auto-update announcements use `CHANGELOG.md`.
