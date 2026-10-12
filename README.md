# YT Jam POC

A React + TypeScript proof of concept with shareable listening rooms, a collaborative video queue, and synchronized YouTube playback using Firebase Realtime Database.

## Firebase setup

1. Create a Firebase project at [console.firebase.google.com](https://console.firebase.google.com/).
2. Add a Web app to the project and copy its Firebase configuration values.
3. Open **Build → Authentication → Sign-in method** and enable **Anonymous**.
4. Open **Build → Realtime Database**, create a database, then replace its rules with the contents of `database.rules.json` and publish them.
5. Copy `.env.example` to `.env.local` and replace every placeholder with the matching value from your Firebase web app. Use the exact Realtime Database URL shown in the Firebase console.

Firebase's web configuration identifies the project; access is protected by Authentication and Realtime Database Security Rules. Never place service-account credentials or private keys in this frontend project.

The rules grant authenticated anonymous users read/write access only to valid room playback paths. After changing `database.rules.json`, publish it in the Firebase console or deploy it from an authenticated Firebase CLI:

```bash
npx firebase-tools deploy --only database
```

## Run locally

```bash
pnpm install
pnpm dev
```

Open the local URL, create a room, and copy its invite link into a second independent browser session. Paste a YouTube URL or video ID to play it immediately or add it to the collaborative queue. Click **Enable synced playback** once in each browser, then Play, Pause, Seek to 30 seconds, or select a queued video in either browser.

Room IDs are stored in the `?room=` query parameter and contain 4–32 lowercase letters, numbers, or dashes. Creating or joining a room does not write to Firebase; its playback record is created by the first playback control command.

## Verification

```bash
pnpm test
pnpm build
```

Synchronization is best-effort. YouTube ads, buffering, device latency, and browser autoplay rules can temporarily introduce drift.
