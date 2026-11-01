# Song Rider Suite

A songwriting studio that runs in the browser on phone, tablet and PC, and installs as an app.

| Module | What it does | Main files |
|---|---|---|
| **Chord Rider Pro** | Plan a song: type chords, arrange them in lines, see piano/guitar shapes, set key/BPM, play it back, export PDF/PNG/MIDI. | `index.html`, `app.js` |
| **Scale Rider** | Scale and progression ideas by genre (incl. Worship), applied to the song's key. | `scale-rider.js` |
| **Beat Maker** | Drum step sequencer that plays with the song. | `beat-maker.js` |
| **Baby DAW** | Lead, bass and vocal parts; record vocals with autotune and effects. | `parts.js`, `vocal-autotune-worklet.js` |
| **Track Master** | Multitrack timeline to arrange chords, parts, drums and vocal clips, and export a mix. | `parts.js` |
| **Song Rider Pro** | Write lyrics with chords, dictate lyrics by voice, attach recordings and notes, print/export. | `song-rider/index.html`, `song-rider/app.js` |

Skins live in `skins.js` / `skins.css`; the shared header/shell styles are `suite-*.css` and `branding-shell.css`.

## How it runs

- **No build step.** The files in this repo are served as-is.
- **Cloudflare Worker.** `wrangler.jsonc` deploys the folder as static assets plus `worker.js`, which
  handles `/api/*`: accounts (invite-only), cloud sync of songs (D1 database), vocal/media storage
  (R2), and speech-to-text (Workers AI).
- **Offline-friendly.** `service-worker.js` caches the app; songs are saved on the device first and
  synced when online. See [`docs/SYNC.md`](docs/SYNC.md) for how conflicts between devices are
  handled (nothing is silently overwritten; a "conflict copy" is kept instead).
- Third-party libraries are vendored in `vendor/` (and `song-rider/pdf*.mjs`, `song-rider/lame.min.js`).
- **Instruments.** `instruments.js` plays every Chord Rider / Baby DAW / Track Master sound: recorded
  sample sets in `assets/instruments/<id>/` (a `manifest.json` per set, listed in `index.json`), voices
  derived from them (EQ, amp, palm mute, layered brass) and synthesized voices. Every sound is levelled
  to the piano. If a set can't load, the General MIDI SoundFont is used instead. The recordings are free
  libraries (CC0, CC BY, University of Iowa free-use); their credits are in
  [`docs/SOUND-CREDITS.md`](docs/SOUND-CREDITS.md) and, for users, `sound-credits.html` (linked from the
  sound picker). CC BY sets require that attribution to stay reachable.

## Deploying

1. Database schema (safe to re-run, only creates what's missing):
   `npx wrangler d1 execute song-rider-suite-prod-db --remote --file=migrations/0001_init.sql`
2. The worker needs an `INVITE_CODE` secret: `npx wrangler secret put INVITE_CODE`
3. Deploy: `npx wrangler deploy`

When you change app files, bump the `?v=` on the changed `<script>`/`<link>` tags and the `CACHE`
name in `service-worker.js` so phones pick up the new version. `force-refresh.html` clears a stuck
cache on a device without touching saved songs.

## Testing

```bash
cd tests && npm install && npm test
```

This starts the real worker locally with a throwaway database and runs the API contract tests and
browser tests (phone + desktop, all 15 skins). GitHub Actions runs the same on every push
(`.github/workflows/ci.yml`). Details in [`tests/README.md`](tests/README.md).

## History

Release notes: [`CHANGELOG.md`](CHANGELOG.md). Notes from earlier builds (v1.8 → v3.3) are archived in
[`docs/HISTORY.md`](docs/HISTORY.md); your original phone screenshots are in `docs/screenshots/`.
