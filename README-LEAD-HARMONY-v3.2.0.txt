Song Rider Suite — Baby DAW Lead/Bass Harmony Helper v3.2.0

Built on the known-good v6 transport-sync baseline.

What changed:
- Lead/Bass editor now shows "Chords Used" for the CURRENT Baby DAW bar.
- It maps the current 4-beat Baby DAW bar against the active CRP chord part using the CRP Beats/chord value.
  Examples: 4 beats/chord = one chord per bar; 2 beats/chord = two chords per bar; 8 beats/chord = one chord spans two bars.
- "Notes that fit" appears directly underneath.
- Notes are based on the CRP key/scale plus the chord tones sounding in the current bar.
- Chord roots are highlighted strongest; other chord tones are gold-accented.
- Capo/transposed guitar playback is reflected in the suggested sounding notes.
- The helper updates when changing Baby DAW bars, CRP Beats/chord, or live CRP core settings.

Files to replace:
- index.html
- parts.js
- styles.css
- service-worker.js

IMPORTANT:
- app.js was NOT changed, preserving the working CRP / Baby DAW / SRP BPM-Capo-Step v6 sync.
- song-rider files were NOT changed.
