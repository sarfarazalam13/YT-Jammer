# YT Jam POC

A React + TypeScript proof of concept with YouTube discovery, shareable listening rooms, live participant presence, a collaborative queue, and synchronized full-featured playback using Firebase Realtime Database.

## Firebase setup

1. Create a Firebase project at [console.firebase.google.com](https://console.firebase.google.com/).
2. Add a Web app to the project and copy its Firebase configuration values.
3. Open **Build → Authentication → Sign-in method** and enable **Anonymous**.
4. Open **Build → Realtime Database**, create a database, then replace its rules with the contents of `database.rules.json` and publish them.
5. Copy `.env.example` to `.env.local` and replace every placeholder with the matching value from your Firebase web app. Use the exact Realtime Database URL shown in the Firebase console.

### Optional App Check

For production, register the deployed domain with Firebase App Check using a reCAPTCHA v3 provider, add its public site key as `VITE_FIREBASE_APP_CHECK_SITE_KEY`, verify traffic in the Firebase console, and only then enable enforcement for Authentication and Realtime Database. Leave the variable empty during initial setup if App Check is not configured; playback continues without it.

Firebase's web configuration identifies the project; access is protected by Authentication and Realtime Database Security Rules. Never place service-account credentials or private keys in this frontend project.

The rules grant authenticated anonymous users scoped access to playback, queue, presence, and host-election data for valid rooms. After changing `database.rules.json`, publish it in the Firebase console or deploy it from an authenticated Firebase CLI:

```bash
npx firebase-tools deploy --only database
```

## YouTube Surf setup

1. In the Google Cloud project, enable **YouTube Data API v3**.
2. Create an API key under **APIs & Services → Credentials**.
3. Restrict the key to **YouTube Data API v3** and restrict websites to the exact development and production referrers that may use it, such as `http://localhost:5173/*`.
4. Add the key as `VITE_YOUTUBE_API_KEY` in `.env.local`, then restart Vite.

The browser key is visible to visitors by design, so referrer and API restrictions are required. Surf searches automatically after a 1.5-second pause once at least three characters are present. Results are cached locally for 24 hours, each browser is limited to 15 uncached searches per Pacific day, and pagination is capped at three pages per query. HTTP 429 responses start a persisted cooldown instead of a retry loop. Popular music, direct video links, and public playlist imports use official non-search endpoints and remain available when only the search allowance is exhausted.

When the shared queue ends, YT Jam uses cached related results, the app-wide most-played chart, and region-aware Popular music before spending another search. It publishes the winner through the same Firebase advance claim used by the queue. The global chart counts each confirmed shared track start once and stores only video IDs plus YT Jam play counters; display metadata is refreshed through `videos.list`.

## Run locally

```bash
pnpm install
pnpm dev
```

Open the local URL, create a room, and copy its invite link into a second independent browser session. Each connected browser appears in the participant strip; the first participant becomes host, and another participant takes over automatically when the host disconnects. Open **Surf YouTube** to browse Popular music, search, or paste a YouTube video/public-playlist link, then play a result or add it to the queue. Click **Join the JAM** once in each browser to enable sound and use the shared timeline, ±10 second skips, speed, Next, and play/pause. Volume, mute, fullscreen, and Video/Mini player display mode remain local to each browser and persist across reloads.

Mini player mode is an audio-style layout, but the YouTube player remains visible at 200×200 or larger to comply with YouTube API policies. The app does not separate audio from video or provide hidden background playback.

## Production deployment

Build and deploy the static app to the Firebase project selected in `.firebaserc`:

```bash
pnpm build
npx firebase-tools deploy --only hosting,database
```

`firebase.json` includes SPA routing, immutable caching for fingerprinted assets, and baseline browser security headers. Before deploying, add the production origin to the YouTube API key's referrer restrictions and the Firebase Authentication authorized domains list.

Room IDs are stored in the `?room=` query parameter and contain 4–32 lowercase letters, numbers, or dashes. Creating or joining a room does not write to Firebase; its playback record is created by the first playback control command.

## Verification

```bash
pnpm test
pnpm build
pnpm test:e2e
```

The Playwright suite runs the production build in desktop and mobile Chromium. On a new machine, install its browser once with `pnpm exec playwright install chromium`, or run `pnpm verify` after the browser is available.

Synchronization is best-effort. YouTube ads, buffering, device latency, and browser autoplay rules can temporarily introduce drift.
