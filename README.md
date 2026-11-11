# BoloAds MVP

An interactive, server-backed case study prototype. Campaign creation, inspection, repair, approval, simulated launch, inventory and event audits, outcomes, scenarios, and exports work without third-party credentials. AI chat and transcription require `GROQ_API_KEY` on the server.

## Run

```powershell
npm start
```

Open `http://localhost:3000`. The Groq test key is hardcoded in the tracked `lib/groq-key.js`; no environment setup is needed for chat or transcription. Anyone with access to the repository can read and use this key. Set `PORT` and `DATA_DIR` only if needed. Node.js 20 or newer is required. No package install is needed.

The app keeps one private JSON file per anonymous browser session in `data/`. It does not publish ads or charge money. Demo metrics are labelled simulated. Public deployment needs persistent disk storage (or a replacement database), HTTPS, a Groq key for live AI and transcription, and a host URL supplied by the deployer. Do not deploy the local JSON store on ephemeral serverless storage.

The floating Guide suggests the next step in the six-step demo path. It starts open on desktop and compact on mobile; all settings and optional tools remain accessible at any time. Chat follow-ups use prior answers and avoid repeating questions already asked.

Run `npm test` for deterministic rule and state gate checks.

## Vercel deployment

The repository includes a Vercel Function at `api/index.js` and a rewrite for `/api/*`; deploy with the Framework Preset set to **Other**. Static files are served from `public/`. On Vercel, session data is stored in `/tmp/boloads-data`, so it can disappear after a cold start or deployment. Use a database before relying on retained campaign sessions.
