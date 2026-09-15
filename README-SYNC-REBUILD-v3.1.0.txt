Song Rider Suite v3.1.0 — BPM / CAPO / STEP transport rebuild

What changed
- CRP, Baby DAW and SRP now use one global same-origin transport record:
  song-rider-suite-transport-v6
- BPM / CAPO / STEP no longer depend on CRP↔SRP project IDs or the link-session record.
- Project linking still controls chords/lyrics/song data, but cannot block transport synchronization.
- Hidden SRP playback bridge is read-only and cannot overwrite transport.
- SRP writes the live number fields before navigating back to CRP/Baby DAW.
- CRP writes its live BPM/Capo/Octave before entering SRP.

Replace these files in the repo:
1. /app.js
2. /index.html
3. /service-worker.js
4. /song-rider/app.js
5. /song-rider/index.html
6. /song-rider/service-worker.js

Then open /force-refresh.html once.
