SONG RIDER SUITE — BPM / CAPO / STEP ROOT FIX v3.0.0

This is a root synchronization rebuild, not another transport patch.

REPLACE THESE FILES IN YOUR REPO:
1. /app.js
2. /index.html
3. /service-worker.js
4. /song-rider/app.js
5. /song-rider/index.html
6. /song-rider/service-worker.js

No assets/images need to be replaced.

WHAT WAS ACTUALLY WRONG
- SRP's leave-page flush listener was looking for links that started with ../index.html, but the real header buttons use /index.html. The listener therefore matched nothing, so SRP could navigate away before its BPM/CAPO/STEP values were committed.
- Several different transport records were competing (handoff, live meta, canonical, and the v4 global bus). A later project restore could put stale values back after a newer value had already been marked as applied.
- SRP's old final CAPO handler always committed the field as CAPO even when the control was in STEP mode.

WHAT THIS BUILD DOES
- Removes the v4 external transport bus/adapters.
- Uses one authoritative project-scoped transport record for BPM/CAPO/STEP.
- Both CRP/Baby DAW and SRP read/write the exact same transport record.
- Legacy link/handoff records are kept only as mirrors for the rest of the CRP/SRP project-link features.
- SRP commits the live fields synchronously on pointer-down before navigating to CRP or Baby DAW.
- CAPO/STEP uses one mode-aware commit path.
- App script query versions and service-worker cache versions were bumped so the browser actually receives this build.

VALIDATION
- app.js: node --check PASS
- song-rider/app.js: node --check PASS
- Old v4 bus/adapters removed
- Old broken ../index.html navigation selector removed
- Shared v5 transport key verified in both apps
