# Partner Mode — PWA + push notifications: deploy checklist

This is a real, working scaffold — installable on a phone, with real push notifications once deployed. Nothing here is faked: the VAPID keys below were generated locally on this machine with OpenSSL, not placeholders.

## 1. Push this repo to GitHub
This folder is already a git repo with an initial commit (see below). Create an empty repo on GitHub, then:
```
git remote add origin <your-new-repo-url>
git push -u origin main
```

## 2. Import into Vercel
On vercel.com: **Add New → Project → Import** the GitHub repo. Framework preset: **Other** (no build step — Vercel serves `index.html`/`manifest.json`/`sw.js`/`icons/` as static files and turns everything in `api/` into serverless functions automatically).

## 3. Add storage (Vercel KV)
In the new project: **Storage → Create Database → KV**. Connect it to this project. This auto-injects the `KV_REST_API_URL` / `KV_REST_API_TOKEN` env vars that `@vercel/kv` reads — no code changes needed.

## 4. Set these environment variables
Project → **Settings → Environment Variables**. The real values are in `.env.local` in this folder — generated locally with OpenSSL, gitignored, never committed, never pasted into this doc on purpose. Open that file and copy each `KEY=value` line into Vercel's dashboard as its own variable:

```
VAPID_PUBLIC_KEY=<from .env.local>
VAPID_PRIVATE_KEY=<from .env.local>
VAPID_SUBJECT=<from .env.local>
ADMIN_TOKEN=<from .env.local>
```

Notes on each:
- **VAPID_PUBLIC_KEY** is also hardcoded in `index.html` (that's intentional and safe — it's the *public* half, meant to be visible client-side). If you ever rotate keys, update it in both places.
- **VAPID_PRIVATE_KEY** must never appear in any committed file or client-side code — env var only.
- **VAPID_SUBJECT** is a contact the push service can reach if it needs to flag abuse — a `mailto:` is standard; change it to whatever address you want to own this.
- **ADMIN_TOKEN** gates `/api/send-push` (the real "a directive fired, notify everyone" endpoint) so a stranger who finds the URL can't use it as an open notification blaster. Whatever system eventually decides "a directive fired" needs to send this exact value as an `x-admin-token` header. Treat it like a password — rotate it if it ever leaks.

## 5. Deploy
Vercel deploys automatically once the repo is connected and env vars are set. Push to `main` to redeploy.

## 6. Test it for real, on an iPhone
1. Visit the deployed URL in Safari (not installed yet) → you should see the "Tap the Share icon, then Add to Home Screen" card.
2. Add to Home Screen, then **open the app from the home screen icon**, not Safari (push only works from the installed, standalone app on iOS — this isn't a limitation of this build, it's an iOS Safari platform restriction).
3. You should see "Turn on alerts" with the honest one-liner. Tap **Enable alerts** → iOS's real permission dialog appears → allow it.
4. You should now see "You're set" with a **Send me a test push** button. Tap it → a real system notification should arrive within a few seconds, delivered by Apple's push service through your Vercel function, not simulated.
5. Tap the notification itself → it should bring the app back to the foreground.

## What's deliberately NOT built yet
- No real trigger wired up for `/api/send-push` — right now nothing calls it automatically when a "directive" fires, because that logic doesn't exist yet. This is only the plumbing: store a subscription, send a push. Whatever decides *when* to push (the actual PMF-tracking logic) is a separate, later piece of work.
- No admin UI for `/api/send-push` — for now, trigger it with a POST + the `x-admin-token` header (e.g. from `curl`) while that later piece gets built.
