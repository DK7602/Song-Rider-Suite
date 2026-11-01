# Tests

Everything runs against the real Worker (`worker.js`) on your machine, with Cloudflare's local
simulation of D1 and R2. Nothing touches production.

```bash
cd tests
npm install            # wrangler + playwright (first time only)
npx playwright install chromium   # first time only, if Chromium is not already installed
npm test               # API contract tests + browser tests
```

- `api.test.mjs` checks the server contract in `docs/SYNC.md` (conflicts, deletes, account
  isolation, login throttling, media access).
- `e2e/*.test.mjs` drive the app in headless Chromium at phone and desktop sizes:
  - `smoke.test.mjs`: both apps load in all 15 skins without errors, overflow or page-weight
    regressions; suite navigation; both apps open offline after one visit.
  - `crp.test.mjs`: Chord Rider drafts, flats, slash chords, Scale Rider minor keys, undo/redo,
    two-device conflicts and deletes, touch target sizes.
  - `parts.test.mjs`: Baby DAW / Track Master takes, take recovery, recording not touching the
    mix, chord placement, repeats, audio-graph cleanup, offline WAV export (uses a fake mic and
    a synthetic SoundFont, so no network is needed).
  - `srp.test.mjs`: Song Rider Pro conflicts, deletes, Chord Rider link, full storage, XSS,
    typing cost, idle timers, dictation, paste confirmation.

Each browser test was checked to fail on the code before these fixes.

To run one file against a server you already started:

```bash
npx wrangler dev --config tests/wrangler.test.jsonc --persist-to /tmp/srs --port 8787   # from repo root
BASE_URL=http://127.0.0.1:8787 node tests/e2e/crp.test.mjs
```

Workers AI (dictation/transcription) is not available locally, so those endpoints return errors in
tests; the browser tests stub them where needed.
