# Build history (archived release notes)

These notes were previously scattered across ~100 UPDATE-*.txt / README-*.txt files in the repo root.
They are kept here, oldest version first, for reference. New changes go in CHANGELOG.md.

## FIX-v2.9.7.txt

```text
Song Rider Suite v2.9.7
- Restores the real CHORD RIDER PRO image wordmark.
- CHORD RIDER PRO title bar is shown only in Chord Rider, never Baby DAW.
- Makes the hidden SRP playback bridge fully read-only: no autosave, no navigation snapshot writes, no cloud refresh writes.
- Prevents the SRP playback bridge from overwriting Baby DAW parts during SRP navigation/return.
- Preserves existing BPM/capo/step linked sync behavior.

```

## INSTALL.txt

```text
CHORD RIDER PRO — BEAT MAKER ADD-ON
===================================

This package is designed to ADD the beat maker to the current Chord Rider Pro build without replacing app.js.
That is intentional: it preserves the cloud/login changes already made in your live GitHub build.

1) Upload these items into the ROOT of the Chord Rider Pro GitHub repo:
   - beat-maker.js
   - beat-maker.css
   - assets/drums/   (the whole drums folder)

2) Open index.html in GitHub. Near the bottom, add this ONE line immediately AFTER the existing app.js script line:

   <script src="beat-maker.js"></script>

   beat-maker.js automatically loads beat-maker.css.

3) Commit changes and let GitHub Pages redeploy.

WHAT IT DOES
------------
- Adds a "Beat" button and "Drums" checkbox beneath Play/BPM controls.
- 1–16 bars.
- 1/8, 1/16, 1/32 and 1/64 step grids.
- 3 kicks, 5 snares, closed/open hats, 3 toms, clap, rim, shaker, tambourine, cowbell and conga.
- One-bar-at-a-time mobile editor with bar tabs.
- Preview, Copy Bar, Paste Bar, Duplicate Bar, Clear Bar.
- Audio-clock scheduling for tight playback.
- Uses project BPM.
- Drum beat is injected into the saved project object under `beatMaker` when the normal Save button is used.
- Pattern starts/stops with the normal Play button.

IMPORTANT CLOUD NOTE
--------------------
The current September 11 file copy available to ChatGPT stores projects in localStorage (`crp-projects`).
This add-on stores the beat INSIDE those same project objects, so any cloud-sync layer that syncs the complete project object will carry `beatMaker` with it automatically.
If your live GitHub cloud code strips unknown project fields instead of syncing whole project objects, that cloud serializer will need one additional field added later.

SERVICE WORKER (recommended)
----------------------------
Your service-worker.js can continue working unchanged because fetched drum assets will be cached dynamically.
If a phone seems to show an old build after deployment, refresh once or close/reopen the installed web app.

```

## PARTS-UPDATE.txt

```text
Chord Rider Pro — Parts Foundation update

Built in this version:
- New + Add Part workflow.
- Chord / Note parts: each added part gets its own full existing Chord Rider editor, lines, instrument, sound, key, capo/transpose settings, etc.
- Lead / Bass parts: piano-roll style grid using real note/octave names, Piano/Guitar sound families, per-part volume, 1/8, 1/16, 1/32 and 1/64 resolution, 1–16 bars, and one-bar-at-a-time mobile editing.
- Vocal parts: project structure/UI is in place, but recording is deliberately NOT rushed into this build.
- Every part has a playback checkbox, rename, volume, and delete (the first chord part is protected).
- Parts are saved in the same local/cloud project JSON; older projects automatically become a Chords 1 part.
- Main playback now schedules all enabled Chord/Note and Lead/Bass parts against the same BPM clock.
- Existing drums remain global and are started/stopped from the master transport.
- Existing line-from-view playback behavior is retained when the selected active chord part starts playback.

Deliberately held for the next recording phase:
- High-quality vocal capture.
- Vocal effects.
- WAV/MP3 song mix export and stems.
- DAW export (planned after stems/MIDI export are solid).

Why vocals are held:
SRP had recording-quality concerns. The next phase should capture a clean dry high-quality master (preferably PCM/WAV style), use headphone backing playback without printing the music into the mic file, keep the original take untouched, and apply effects non-destructively. We should test this on the actual Android/Chrome device before calling it finished.

```

## README-BD-SETUP-v3.2.2.txt

```text
Song Rider Suite v3.2.2 — Baby DAW Chord Setup Independence

What changed:
- CRP Hide/Show now affects CRP only.
- Baby DAW remembers its own chord setup visibility.
- A compact Hide Setup / Show Setup control lives in the existing Parts row only while a Baby DAW chord part is active. No new button row was added.
- Adding a NEW Chord / Note part in Baby DAW automatically opens Piano/Guitar, Chord/Note, Sound, Octave, Capo, etc.
- Returning to CRP preserves exactly how CRP Hide/Show was left.

Replace in repo:
- app.js
- parts.js
- index.html
- styles.css
- service-worker.js

Then run force-refresh.html once.

```

## README-BD-SETUP-v3.2.3.txt

```text
Song Rider Suite — Baby DAW Setup Toggle v3.2.3

Change:
- Moved Baby DAW Show Setup / Hide Setup out of the Parts strip.
- The button now sits immediately to the right of Auto Scroll in the chord playback row.
- This restores horizontal space for more Baby DAW part tabs.
- CRP/Baby DAW independent setup visibility behavior is unchanged.
- BPM/Capo/Step sync logic is untouched.

Replace only these files in the repo root:
- index.html
- styles.css
- service-worker.js

Then run /force-refresh.html once.

```

## README-LEAD-HARMONY-v3.2.0.txt

```text
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

```

## README-SYNC-REBUILD-v3.1.0.txt

```text
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

```

## README-SYNC-ROOT-FIX.txt

```text
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

```

## README-v3.3.74.txt

```text
Song Rider Suite v3.3.74 — Celtic Gold refresh + Celtic Gold Dark

Upload these files/folders to your repo, preserving folders.

What changed:
1) Refreshed Celtic Gold (light) with lighter standard green accents.
2) Added Celtic Gold Dark skin.
3) Celtic mode buttons now use PNG knot art assets.
4) Added cream outline effect to CRP / BD / SRP button lettering.
5) Added new Celtic PNG assets for Chord Rider, Baby DAW, Song Rider, and Track Master.
6) Updated service worker cache so the new skin assets refresh cleanly.

```

## README-v3.3.75.txt

```text
Song Rider Suite v3.3.75 — Celtic Gold icon + trim refresh

Changes in this upload:
1) Celtic Gold Light + Celtic Gold Dark mode buttons now use transparent PNG 24-karat knot icons (no gold square behind the icons).
2) Track Master bar icon removed; Track Master restored to the standard 24-karat gold button look.
3) Added subtle Celtic-style corner line trim to buttons, windows, and framed spaces in both light and dark Celtic skins.
4) Celtic Gold Light updated with a lighter standard green accent.
5) CRP / BD / SRP mode-button text now has a thin cream outline treatment.
6) Celtic Gold Dark updated so the main controls, buttons, active cells, and steps use gold + cream styling instead of green.

Files in this upload-only package:
- skins.css
- skins.js
- assets/celtic-mode-chord.png
- assets/celtic-mode-daw.png
- assets/celtic-mode-song.png
- assets/celtic-mode-track.png

```

## UPDATE-v1.9.2.txt

```text
Chord Rider Pro v1.9.2
- Lead/Bass and Vocal parts now have per-part Repeat toggles (default ON).
- Repeating Lead/Bass events and active vocal takes are scheduled across the full song timeline.
- Lead/Bass active-part volume slider uses exact visual fill through 100%.
- PDF drum and Lead/Bass grids use aligned colgroups and musical subdivision headers.
- Speech-to-text is more resilient: accumulates final phrases correctly, restarts while recording when Chrome ends a recognition session, and shows status/errors instead of failing silently.
Note: live speech recognition depends on browser/OS support and may use the browser speech service; the dry WAV recording remains independent.

```

## UPDATE-v1.9.3.txt

```text
Chord Rider Pro v1.9.3 — Universal Cloud Transcription

- Server-side vocal transcription through Cloudflare Workers AI.
- Uses the dry WAV master stored in the private R2 AUDIO bucket.
- Works independently of browser speech-recognition support.
- New takes auto-upload/transcribe when signed in and the project is saved.
- Added Transcribe active take retry button.
- Transcript remains editable and is saved with the take/project.
- Word timing is retained when returned by the transcription model so PDF lyrics can be placed by song line.

Cloudflare setup required once: add a Workers AI binding named AI to the chord-rider-pro Worker. R2 AUDIO and D1 DB bindings remain unchanged.

```

## UPDATE-v1.9.4.txt

```text
Chord Rider Pro v1.9.4

PDF timeline alignment fix:
- Drum and Lead/Bass grids retain the shared 82px label gutter.
- Chord diagrams now use the same 82px gutter and are divided into equal musical slots, so their vertical boundaries line up with the beat/bar grid above.
- Cloud speech-to-text from v1.9.3 is preserved unchanged.
- Service-worker cache bumped to v1.9.4.

```

## UPDATE-v1.9.5.txt

```text
Chord Rider Pro v1.9.5 — Full Chord Audit

- Piano chord voicings are now canonical root-position voicings across playback, app diagrams, and PDF export.
- Basic triads ascend root → third → fifth (F = F-A-C, D = D-F#-A, Dm = D-F-A).
- 7th/9th/add9/6/sus/dim/half-diminished/augmented formulas audited.
- Existing guitar open-shape pitch content audited; generated guitar voicings continue to derive from the same chord formulas.
- Capo/transpose remains applied before voicing generation, keeping sounding notes and diagrams consistent.
- Service-worker cache bumped to v1.9.5.

```

## UPDATE-v1.9.6.txt

```text
Chord Rider Pro v1.9.6

Lead/Bass note audition
- Tapping any Lead/Bass grid cell now immediately previews that note using the currently selected sound.
- The tap still toggles the note on/off exactly as before.
- Preview respects the Part octave and the bass instrument octave behavior used during playback.
- Existing playback, repeat, cloud vocals, transcription, chord audit, PDF blueprint and DAW export are unchanged.

```

## UPDATE-v1.9.7.txt

```text
Chord Rider Pro v1.9.7 — Lead/Bass Sustain

- Added per-part Sustain notes toggle to every Lead/Bass part.
- Sustain OFF keeps notes tight to the selected grid step.
- Sustain ON lets each note ring for a full beat, including tap-to-audition.
- Sustain state saves with the project and carries into MIDI/DAW export note lengths.
- No asset changes.

```

## UPDATE-v1.9.8.txt

```text
Chord Rider Pro v1.9.8 — Chord Rider / Baby DAW workspace modes

- Added two top-level workspace views over the SAME project data.
- Chord Rider: chords/notes + Beat Maker, transport, projects, save and all export functions.
- Baby DAW: full Parts workspace including Lead/Bass and Vocals.
- Mode buttons use a gold active glow and generated Baby DAW doll artwork.
- Mode preference is remembered on the device; it is not a separate project and never duplicates song data.
- Entering Chord Rider focuses the project’s chord part without deleting/hiding any saved production parts from the project.
- Exports remain identical in either view.

```

## UPDATE-v1.9.9.txt

```text
Chord Rider Pro v1.9.9

- Metallic gold CHORD RIDER PRO wordmark styling.
- Chord Rider mode selector now uses the supplied Standard Rider & Bones artwork as frameless sticker art.
- Baby DAW selector now uses the approved head-only artwork with sunglasses, cap, and gold chain as frameless sticker art.
- Removed the image-window treatment from both mode-selector characters.
- No project/data behavior changed.

```

## UPDATE-v1.9.10.txt

```text
Chord Rider Pro v1.9.10 — Blank Drum Start Fix

- New/blank projects now always start with an empty drum pattern.
- Beat Maker no longer falls back to the most recently saved project when there is no active project.
- Opening Beat Maker on a new project no longer reloads stale draft drums.
- Pressing New clears any stale unsaved drum draft.
- Saved projects still load their own saved drum pattern normally.
- Manual drum entry and Randomize Beat continue to work normally.

```

## UPDATE-v1.9.11.txt

```text
Chord Rider Pro v1.9.11

Playback timing + live sound audit
- Unified the startup lead-in for Parts and Drum playback so drums no longer launch about 90-100 ms ahead of the musical parts.
- Parts now use a rolling one-beat Web Audio scheduler instead of scheduling an entire song/cycle at once. Exact note timestamps remain Web Audio-timed, while the shorter look-ahead allows live instrument changes to take effect during playback.
- Piano/Electric Piano/Synth/Bass and Lead/Bass sound changes are warmed immediately during playback and take effect on upcoming notes without Stop/Play.
- Starting playback from a later song line now starts the drum pattern at the matching song beat instead of resetting drums to beat 1.
- Vocal takes remain scheduled as continuous audio rather than being chopped into the rolling instrument scheduler.
- Existing repeat, sustain, vocals, drums, exports, and project data are preserved.

```

## UPDATE-v2.0.0-SRP-MERGE.txt

```text
Chord Rider Pro v2.0.0 — SRP Merge Preview
- Adds Song Rider as a third workspace beside Chord Rider and Baby DAW.
- Chord Rider + Baby DAW remain the same CRP project.
- Song Rider is optional: a saved CRP project must be intentionally linked.
- Linking creates/reuses a dedicated SRP project and syncs CRP name, BPM, key metadata, beats/chord, and chord rows into SRP.
- SRP lyrics/flow remain SRP-owned; syncing chords preserves existing lyrics by row.
- Unlink removes the relationship without deleting either project.
- SRP drum/instrument selectors are hidden in embedded mode; CRP/Baby DAW owns music playback/production.
- Standalone Song Rider files remain bundled under /song-rider for isolation and rollback safety.

```

## UPDATE-v2.0.1-SRP-INTEGRATION-POLISH.txt

```text
Chord Rider Pro v2.0.1 — SRP Integration Polish

- Enlarged Song Rider mode artwork to match the visual weight of Chord Rider.
- Removed SRP nested lower-pane scrolling while embedded in CRP.
- SRP now expands naturally and uses the outer CRP page for vertical scrolling.
- Added automatic same-origin iframe height fitting with ResizeObserver/MutationObserver.
- Kept SRP standalone behavior unchanged.
- Test Worker name remains chord-rider-pro-srp-test for the srp-merge branch.

```

## UPDATE-v2.2.3-SRP-LAYOUT-FIX.txt

```text
Chord Rider Pro v2.2.3

- Song Rider header now uses the exact CRP/Baby DAW gold title + script tagline treatment.
- BPM, Capo/Step and Key are compactly grouped beside Save/Cloud.
- Link SRP moved into that same utility row.
- Capo/Step no longer overlaps the Key field.
- Full Song View section title pills are hard-forced to CRP gold with bold black text, including focus/edit state.
- Existing native scroll and typing-autoscroll behavior preserved.

```

## UPDATE-v2.2.4-SECTION-TITLE-FIX.txt

```text
Chord Rider Pro v2.2.4 — SRP section title fix

- Rebuilt the Full Song View section-title styling at element creation time.
- Gold/yellow gradient and bold black title text are now applied directly with inline !important rules.
- Removed the overlay row background that could visually cover/conflict with the gold pill on mobile Chromium.
- Applied the same hard styling to individual page heading title inputs.
- Service-worker cache bumped to v2.2.4.

```

## UPDATE-v2.2.5-ACTUAL-FULL-SONG-TITLE-FIX.txt

```text
Chord Rider Pro v2.2.5 — Actual Full Song View title fix

- Fixed the real visible Full Song View section-title element (.fullPerfPill).
- Forces CRP gold/yellow background and bold black title text directly when that element is created.
- Keeps all v2.2.4 layout and SRP behavior unchanged.

```

## UPDATE-v2.9.5-WORKDAY-FIXES.txt

```text
Song Rider Suite v2.9.5 workday fixes

- SRP Hide/Show state now persists across workspace changes, reloads, and reopening SRP.
- Baby DAW parts get a synchronous navigation snapshot before entering SRP and are recovered on return, protecting newly added parts from stale project payloads.
- Existing BPM / capo / step canonical sync logic is preserved.
- PDF export now loads a known-stable jsPDF UMD release (2.5.1) instead of the broken 2.5.3 CDN reference.
- PNG export now includes the full enabled Baby DAW arrangement plus drums by default.
- CRP title is larger and the CRP Hide/Show button is smaller; SRP Hide/Show sizing is matched.
- Service-worker cache version bumped so deployed devices fetch these updates.

```

## UPDATE-v2.9.6-PARTS-TITLE-HOTFIX.txt

```text
Chord Rider Pro v2.9.6 hotfix

1. Baby DAW parts are protected when entering SRP.
   - The hidden SRP playback bridge no longer performs a cloud-project refresh.
   - Cloud refresh now preserves a newer/richer local Baby DAW project instead of replacing it with a stale server copy.
   - Existing navigation snapshot protection remains in place.
2. CRP title no longer uses the cropped PNG wordmark (the source PNG itself cut off the final O).
   - Uses the scalable chrome text wordmark already built into the app.
   - Hide/Show button is slightly smaller to leave the title more room on mobile.
3. Service-worker cache bumped so deployed phones pull this hotfix.

```

## UPDATE-v2.9.13-CRP-TITLE-RESET.txt

```text
v2.9.13 CRP title reset
- Rebuilt CRP title row geometry to mirror Song Rider Pro.
- 56x38 Hide button, same font sizing/radius/padding as SRP.
- Real 10px gap between title and button; title cannot enter button space.
- Removed prior title transforms/overlap behavior via final CSS override.
- Baby DAW title suppression and working Baby DAW -> SRP parts persistence preserved.

```

## UPDATE-v3.2.8-SRP-PARSE-LINK-FIX.txt

```text
Song Rider Suite v3.2.8 — SRP parse/link/playback fixes

Fixed:
1. SRP project names no longer get overwritten by the linked CRP project name during refresh/sync.
2. A stale link session can no longer switch the loaded SRP project after refresh.
3. Link SRP now links the SRP project currently on screen to the CRP/Baby DAW project currently loaded.
4. Unlink SRP is a real unlink; unlinked SRP projects no longer use the hidden CRP/Baby DAW playback engine.
5. Linked playback now reloads the exact linked CRP project, not whichever CRP project happens to be active later.
6. Unlinked SRP Play now plays SRP's own parsed chord grid.
7. Web/PDF parsing recognizes common headings such as [Verse 1], Chorus, Bridge, Intro, Outro, Pre-Chorus, etc. and maps the first heading to PAGE 1.
8. Wrapped chord rows such as C/E + F6 on one copied line and C on the next are merged into one logical chord row instead of producing a blank chord-only card.
9. PDF/web text cleanup preserves horizontal spacing so chord placement survives parsing.
10. PDF import uses the local pdf.mjs/pdf.worker.mjs files when available, avoiding an unnecessary CDN dependency.
11. Pasting song text outside an editor imports it automatically; pasting inside Full Song View remains normal and auto-parses through the editor.
12. PDF import now opens PAGE 1 (the current page model) instead of the obsolete VERSE 1 key.

```

## UPDATE-v3.2.9-PROJECT-SCOPED-SRP-LINK.txt

```text
Song Rider Suite v3.2.9 — Project-scoped SRP linking

Fixes the Link SRP behavior shown in the supplied video.

1. Each SRP project now keeps its own CRP/Baby DAW link.
2. Switching SRP projects activates only that SRP project's saved pair; an unlinked SRP project no longer inherits the previous project's link session or Unlink SRP button state.
3. Linking an SRP project to a CRP/BD project remains one-to-one. If that CRP/BD project was linked to a different SRP project, the old SRP project is detached.
4. Existing valid links are migrated/repaired from legacy per-project link fields into the persistent link map. Stale conflicting fields are cleared.
5. Linked playback is stopped before switching SRP projects so audio cannot continue from the old pair.
6. Background CRP structure sync is pinned to the current SRP project's saved CRP partner instead of following whichever CRP/BD project was most recently open.
7. BPM / CAPO / STEP transport-sync code remains on the existing suite transport bus and was not replaced.

```

## UPDATE-v3.3.0-LINK-SCOPED-TRANSPORT.txt

```text
Song Rider Suite v3.3.0 — Link-Scoped BPM / CAPO / STEP

Fixed:
- An unlinked SRP project no longer consumes BPM, CAPO or STEP changes from CRP/Baby DAW.
- Editing BPM, CAPO or STEP in an unlinked SRP project no longer changes CRP/Baby DAW.
- The shared transport record is accepted only when its CRP project id matches the exact active SRP<->CRP link pair.
- Switching from a linked SRP project to an unlinked SRP project restores/keeps that SRP project's own saved transport values.
- Linked SRP projects still keep the existing two-way BPM/CAPO/STEP sync with their paired CRP/Baby DAW project.

Also bumped the service-worker cache so phones/PWAs fetch the corrected JavaScript.

```

## UPDATE-v3.3.1-MIDI-VIEW-PNG-CHOOSER.txt

```text
Song Rider Suite v3.3.1

UPGRADES
1. Chord Rider Pro MIDI View
   - Added a MIDI View toggle beside Auto Scroll on the CRP chord page.
   - MIDI View replaces each chord/note diagram with a compact piano-roll-style note grid.
   - The grid is generated from the same notes/voicing used by playback.
   - Chords entered with Build or tapped from Chords that fit auto-populate their notes.
   - Note mode auto-populates the selected/typed note.
   - Capo, octave/step, instrument/voicing changes re-render the MIDI notes automatically.
   - Diagram View restores the existing chord diagrams.
   - The view preference is remembered on the device. Baby DAW remains on its existing diagram view.

2. PNG/Image export chooser
   - PNG Image now opens the same type of part-selection dialog as PDF export.
   - Choose individual Chord/Note, Lead/Bass, and Vocal parts.
   - Drums and Project Notes have independent checkboxes.
   - PNG generation now respects that selection instead of always forcing drums on / notes off.

Cache bumped to v3.3.1 so installed PWAs receive the updated app.js/styles.css.

```

## UPDATE-v3.3.2-EDITABLE-MIDI-ROLL.txt

```text
Song Rider Suite v3.3.2

CRP MIDI VIEW UPGRADE
- MIDI View is now one editable piano-roll/MIDI table per chord line instead of a read-only mini-grid inside each chord card.
- Chords and notes still auto-fill their sounding notes when typed with Build or tapped from Chords/Notes that fit.
- Tap any MIDI cell to add/remove that exact note; the edited notes become the card playback/MIDI-export notes and persist with the project.
- Each chord/note has a reset arrow to return its column to automatic chord/note filling.
- The MIDI table scrolls horizontally (and vertically when needed) with sticky pitch labels and chord/note headers.
- Auto Scroll follows the active chord/note horizontally during CRP/Baby DAW playback and highlights the current MIDI column.
- A manual horizontal swipe turns Auto Scroll off, matching the existing manual-scroll behavior.
- Mobile line-carousel behavior is suspended while MIDI View is open so horizontal gestures control the MIDI table rather than changing song lines.
- MIDI edits survive tapping another compatible chord/note; unchanged columns are preserved.
- Standard Diagram View remains unchanged, and Baby DAW continues to use its existing chord diagram view.

PNG/PDF export chooser behavior from v3.3.1 is unchanged.
PWA cache bumped to v3.3.2.

```

## UPDATE-v3.3.3-DRAWN-MIDI-DURATION.txt

```text
Song Rider Suite v3.3.3 — Drawn MIDI Duration

- CRP MIDI View: drag the gold right edge of any chord/note column to set its duration in 1/4-beat increments, up to 64 beats. The roll auto-scrolls while dragging near an edge.
- CRP playback: drawn durations are honored in MIDI View and Diagram View, including Baby DAW chord-part playback and Standard MIDI export.
- CRP Diagram View: cards with an explicit drawn duration show a duration badge.
- CRP MIDI repeat: added/fixed a per-chord/note repeat button; Line duplicate now deep-copies MIDI edits and durations.
- Lead/Bass: upgraded to a continuous horizontal multi-bar MIDI timeline. Notes are drawn as blocks with a right-edge duration handle; drag across beats/bars with edge auto-scroll.
- Lead/Bass playback, repeat cycles, copy/paste, PNG/PDF grid rendering, and Standard MIDI export now honor drawn note lengths.
- Lead/Bass Auto Scroll follows the playing note horizontally.
- PNG/PDF: when CRP is in MIDI View, chord/note parts export as a MIDI roll instead of chord diagrams. Diagram View still exports diagrams.
- Existing projects remain compatible: old chords use Beats/chord as their default duration; old Lead/Bass events use one grid step until stretched.

```

## UPDATE-v3.3.4-PRECISION-MIDI-DRAG.txt

```text
Song Rider Suite v3.3.4 — Precision MIDI Duration Drag

FIX
- Slowed CRP MIDI duration edge auto-scroll dramatically so a chord/note can be released on the intended beat.
- Slowed Baby DAW Lead/Bass duration edge auto-scroll to the same precision-oriented behavior.
- Edge scrolling is now time-based, so 60/90/120 Hz phones behave consistently instead of moving farther on high-refresh screens.
- Speed ramps gently from the edge zone toward the screen edge; direct finger dragging remains 1:1.
- Existing 1/4-beat CRP snap and Lead/Bass grid snap are unchanged.

CACHE
- Bumped service-worker cache to v3.3.4 so the updated drag behavior replaces the previous cached scripts.

```

## UPDATE-v3.3.5-PRECISION-PLAYBACK-LINK-TITLE.txt

```text
Song Rider Suite v3.3.5

Changes
- CRP MIDI duration dragging is substantially more precise on phones: wider beat spacing plus much slower left/right edge auto-scroll, with extra damping while shrinking left.
- Lead/Bass editor now has its own Play Part / Stop button. It previews only the active Lead/Bass part and honors drawn MIDI durations.
- Vocals now has a Play Mix / Stop Mix master playback button. It plays the active vocal take plus exactly the Chord/Note + Lead/Bass parts checked under Backing while recording, and honors the Drums checkbox and Playback level.
- Vocal backing checkbox choices now preserve an intentionally empty selection instead of silently rechecking all parts on reopen.
- Drum playback supports temporary mix gain for Vocal Play Mix without changing the saved drum volume.
- Linked SRP projects now show the exact linked CRP/Baby DAW project name directly beneath Unlink SRP.
- Service worker cache bumped to v3.3.5.

Existing project data format remains compatible.

```

## UPDATE-v3.3.6-CHECKED-PART-PLAYBACK.txt

```text
Song Rider Suite v3.3.6

Lead/Bass transport cleanup:
- “Play Part” is now “Play”.
- “Repeat this part” is now “Repeat”.
- “Sustain notes” is now “Sustain” so Play / Repeat / Sustain stay on one line on mobile.
- Lead/Bass Play now uses the Baby DAW master checked-part mix: every checked Chord/Note, Lead/Bass, and active Vocal part plays together, plus Drums when enabled.
- Repeat mirrors the project master Repeat toggle and loops the checked mix instead of acting as a current-part-only control.
- Existing Lead/Bass sustain behavior is unchanged.

```

## UPDATE-v3.3.7-CRP-SHOW-HIDE-LAYOUT.txt

```text
Song Rider Suite v3.3.7 — CRP Show/Hide + Layout Repair

- CRP Hide/Show now directly controls the real setup toolbar and cannot be overridden by stale Baby DAW part-editor classes.
- The Hide/Show state remains separate from Baby DAW and persists as before.
- Returning to CRP now restores the Chord editor mode even if a Lead/Bass or Vocal editor was previously active in Baby DAW.
- Collapsed CRP setup no longer reserves a large empty block; the chord input / transport area moves up cleanly.
- Cache version bumped so installed PWAs receive the repaired CSS/JS.

```

## UPDATE-v3.3.8-LAST-MIDI-DURATION-CAPO-ROW.txt

```text
Song Rider Suite v3.3.8

- CRP Capo, Chord Shape, and Capo mode now share one compact row.
- Fixed the final CRP MIDI chord/note duration handle racing through beats.
  The duration drag now ignores browser scrollLeft clamping caused by the final
  column changing the roll width, while preserving the existing edge-scroll feel.
- Bumped the PWA cache so phones receive the corrected JavaScript/CSS.

```

## UPDATE-v3.3.9-HQ-BRANDING-SRP-TITLE.txt

```text
Song Rider Suite v3.3.9 — HQ Branding + SRP Title Match

- CRP title rebuilt at 2x resolution; CHORD now uses the sharper source artwork and matches RIDER PRO more closely.
- Baby DAW mode button rebuilt from the original high-resolution skull/chain + microphone art with live HTML text, preserving the same design while making it crisp like CRP/SRP.
- SRP title on tablet/desktop now fills the available titlebar width up to the Hide/Show button, matching CRP. Mobile sizing is unchanged.
- PWA cache bumped to v3.3.9.

```

## UPDATE-v3.3.10-HQ-BRANDING-DESKTOP-LINE-DRAG.txt

```text
Song Rider Suite v3.3.10

- Rebuilt CRP wordmark from one uniform transparent source at 4x delivery resolution; removes the mixed-quality CHORD/RIDER PRO composite.
- Restored the complete Baby DAW button artwork (no cropped/blown-up skull); padded to the app button aspect ratio and delivered at 2x resolution.
- Added a 4x SRP title asset and made desktop/tablet SONG RIDER PRO fill the full title cell up to Hide/Show. Mobile sizing is unchanged.
- Fixed PC whole-line grab/drop: mouse drag begins immediately from the Line badge; mobile retains long-press behavior.
- Cache bumped to v3.3.10.

```

## UPDATE-v3.3.11-ASSET-SWAP.txt

```text
v3.3.11
- Replaced CRP title with user-provided high-quality wordmark.
- Replaced suite header with user-provided HD header art.
- Replaced Baby DAW button with user-provided image.
- Bumped cache/query versions so the new images refresh properly.

```

## UPDATE-v3.3.12-title-header-crop.txt

```text
v3.3.12
- Cropped SONG RIDER SUITE banner to remove the white bands above and below.
- Cropped CHORD RIDER PRO title art to remove excess empty space and better match SRP title layout.
- Kept Baby DAW button from v3.3.11.
- Bumped asset query strings and service worker cache version.

```

## UPDATE-v3.3.13-AUTOTUNE-AUDIO-POLISH.txt

```text
v3.3.13
- Desktop SRP BPM field widened so 3-digit BPM values are fully visible; mobile layout unchanged.
- Baby DAW Vocals adds key-linked Auto-Tune amount slider (0% natural/off to 100% hard robotic correction). Dry WAV masters remain untouched.
- Piano output raised moderately.
- Sustain extended for Piano, Electric Piano, and Acoustic Guitar in CRP and Baby DAW playback.
- Added same-origin AudioWorklet pitch-correction processor and bumped PWA cache.

```

## UPDATE-v3.3.14-PLAYBACK-LAYOUT-AUDIO-EXPORT.txt

```text
v3.3.14
- Playback scheduler now queues multiple beats ahead with a larger look-ahead and auto-resumes a suspended AudioContext while playback is active.
- CRP Sound / Octave / Sustain layout is locked to one authoritative grid so stale competing CSS cannot expand it into separate rows.
- Service worker installation no longer fails wholesale when an optional cached asset is missing.
- Export menu now includes Audio mix (WAV). Choose any Chord/Note, Lead/Bass, Vocal, and Drums combination and export one mixed WAV.

```

## UPDATE-v3.3.15-SONG-END-PRO-AUTOTUNE.txt

```text
v3.3.15
- Added Baby DAW Song End editor: play the song, tap Set End Here at the exact cutoff, fine-nudge +/-0.1 s, or reset to Full Song.
- Song End persists with the project and is honored by normal playback, repeat boundaries, Vocal Play Mix, and one-file WAV audio export.
- Rebuilt vocal pitch correction around YIN pitch detection, faster key-locked retune, larger correction range, and a smoother dual-grain pitch shifter. 100% is the hard/robotic end of the control; 0% is clean bypass.
- Rebuilt the Auto-Tune range styling so the control visually travels all the way from 0% to 100%.
- Bumped service-worker cache and worklet versions.

```

## UPDATE-v3.3.16-SHELL-LAYOUT-SONG-END.txt

```text
v3.3.16
- SRP now uses the exact same canonical suite header/mode-button CSS and root assets as CRP/Baby DAW.
- Removed the SRP legacy code that unregistered the suite service worker and deleted all caches on every SRP load.
- Added a final shared shell lock stylesheet so CRP/BD/SRP branding cannot drift between pages.
- Added a final CRP layout lock stylesheet so Sound / Octave / Sustain stay in the correct row even if older layout rules exist.
- Moved Song End below the parts editor and directly above Projects in Baby DAW.
- Song End is now collapsed behind a Song End button and remembers its expanded/collapsed state.

```

## UPDATE-v3.3.17-SONG-END-MEDIA-SESSION.txt

```text
v3.3.17
- Replaced Set End Here with a visual Song End slider.
- Added vertical bar markers, Snap to Bar toggle, +/-0.1s fine adjustment, and Restore Full Song.
- Song End changes apply live to playback and continue to control WAV export.
- Playback now hot-refreshes while editing instead of requiring a manual stop/restart.
- Added Android/Chrome Media Session support with project metadata, play/pause, seek +/- and seek-to-position controls for the notification/system media panel when supported.
- Added a silent media keepalive so the PWA has a real media session while WebAudio playback is running.
- Removed the forced playback stop when switching between Baby DAW parts.

```

## UPDATE-v3.3.18-LIVE-MEDIA-SESSION.txt

```text
v3.3.18
- Compact Song End fine controls: -0.1s, +0.1s, and Snap to Bar sit beside Cutoff/Playhead.
- Reworked Android/Chrome Media Session carrier as a long-form hidden HTML audio element so notification/lock-screen controls can publish reliably.
- Media Session supports play, pause, stop, seek backward/forward, seek-to, metadata, and live position state.
- Live editing no longer restarts the Baby DAW transport on autosave. Part volumes and vocal FX update in-place; musical changes roll into the scheduler without a pause.
- Scheduler now rolls one beat at a time so instrument/note changes appear quickly while playback continues.

```

## UPDATE-v3.3.19-LAYOUT-AUDIO-LEAD-TAP.txt

```text
Song Rider Suite v3.3.19 — Layout / live-audio / Lead tap stability
Date: 2026-09-18

1) CRP layout
- The compact CRP Sound + Octave + Sustain row is enforced by the lock stylesheet plus a tiny inline critical fallback in index.html.
- CRP CSS/JS URLs were version-bumped so Chrome cannot reuse the older stretched layout response.
- The service worker uses a new cache generation, clears prior Suite caches, and bypasses the browser HTTP cache for HTML/CSS/JS before offline fallback.

2) Static/crackle while live-editing playback
- Adding a Lead/Bass note during active playback no longer fires a second audition voice over the running arrangement.
- Live part-gain changes use a short WebAudio ramp instead of an abrupt gain jump.
- Lead/Vocal volume sliders no longer rebuild the entire Parts strip on every slider tick, reducing main-thread spikes while playback is scheduling.

3) Lead/Bass note delete tap
- A stationary tap on the note-duration handle now deletes the note; dragging still resizes it.
- One tap removes duplicate same-step/same-pitch events left by an older build.
- Loaded Lead/Bass events are deduplicated while preserving the longest drawn duration.

Existing v3.3.18 Song End, Media Session, Auto-Tune, SRP link/playback, and BPM/Capo/Step sync logic are preserved.

```

## UPDATE-v3.3.20-INLINE-TITLE-BD-VOX-BOX.txt

```text
Song Rider Suite v3.3.20 — Inline Title + Baby DAW Controls + Vox Box
2026-09-18

1. Song Rider Pro
- Full Song section titles now edit directly in the gold title pill.
- Removed the browser prompt/pop-up used by Full Song section titles.
- Enter finishes editing; changes save with the SRP project.

2. Baby DAW Lead/Bass controls
- Play + Repeat moved below the Bar navigation and immediately above Copy / Paste / Clear.
- Sustain moved onto the Grid octave / Resolution control row on phone layouts.

3. Baby DAW Vox Box
- Added a Vox Box button beside Vocal Effects.
- Full-screen DAW-style vocal timeline with real waveform clips from recorded takes.
- Non-destructive left/right crop handles.
- Split at playhead, Copy, Cut, Paste, Delete.
- Drag clips horizontally and between vocal tracks.
- Snap to Beat can be toggled on/off; grid choices: 1/4, 1/8, 1/16, 1/32, 1/64.
- Free positioning when Snap to Beat is off.
- Track-level and selected-event Vocal Effects, including volume, EQ, compression, reverb, delay and Auto-Tune.
- Vox Box events persist with Baby DAW project data and are used by playback/audio export.
- Original dry vocal takes remain intact when clips are cropped/split/moved.
- Studio export includes every dry vocal WAV referenced by the Vox Box arrangement.

Validation
- JavaScript syntax checked for root app, parts, both service workers, and SRP app.
- Root and SRP HTML checked for duplicate IDs.
- Lead control placement and Vox Box wiring checked against the final HTML.

```

## UPDATE-v3.3.21-VOX-BOX-PRO.txt

```text
Song Rider Suite v3.3.21 — Compact Lead Controls + Gold SRP Pill + Vox Box Pro

1. Baby DAW Lead/Bass controls
- Grid octave, Resolution, Bars, and Sustain now share one compact settings row.
- Numeric/select windows are intentionally compact instead of stretching across the editor.
- Responsive grid is sized to stay inside the Lead/Bass card on phone, tablet, and desktop without horizontal page scrolling.

2. Song Rider Pro Full Song section title
- Full Song section title remains directly editable.
- Added a final high-specificity gold pill treatment matching the editable card-page section-title pill.

3. Vox Box Pro
- Live crop preview: waveform content redraws while either crop edge is dragged, so the visible waveform shows the actual retained audio during the crop rather than stretching/compressing until release.
- Live beat-range readout updates while moving/cropping.
- Added + Vocal Track inside Vox Box for layering, doubles, harmonies, ad-libs, verse/chorus organization, etc.
- New vocal tracks are full Baby DAW vocal parts with their own volume/effects and persist with the project.
- Track names can be edited inline directly in the Vox Box track header.
- Clips may still be dragged/copied/pasted between vocal tracks; their dry source take is preserved.
- Track FX remain independent per vocal track; Selected Event FX remain independent per clip/event.
- Existing Snap to Beat 1/4, 1/8, 1/16, 1/32, 1/64 and free placement are preserved.
- Crop/split/move/copy remain non-destructive to the original dry WAV.

Cache generation bumped to v3.3.21 so updated layout/code is not mixed with the previous v3.3.20 files.

```

## UPDATE-v3.3.22-PRO-INSTRUMENTS.txt

```text
Song Rider Suite v3.3.22 — Pro Instrument Expansion

CRP + Baby DAW
- Added a third instrument family: Misc.
- Misc sounds: Sax, Alto Sax, Horn, Brass Section, Trumpet, Trombone, Tuba, Flute, Clavinet, Funky Worm, Funk Organ, Vibraphone, Marimba, G-Funk Whistle, Synth Brass.
- Piano sounds expanded with Bright Grand, Electric Grand, Vintage E-Piano, Warm Synth Pad, Poly Synth and Saw Synth while keeping the original Piano / Electric Piano / Synth / Bass choices.
- Guitar sounds expanded with Acoustic Nylon, Jazz Electric, Muted Electric, Crunch Electric, Drive Electric and Wah Wah Electric while keeping the original Acoustic / Electric / Bass choices.
- Standard sounds continue to use sampled SoundFont instruments. Wah Wah Electric and Funky Worm use sampled source instruments plus a smooth WebAudio filter sweep for character.
- Added MusyngKite -> FluidR3_GM fallback loading for patch compatibility.
- New instrument family and sound choices persist in saved CRP projects and Baby DAW Lead/Bass parts.
- Misc uses the keyboard/MIDI visualization instead of guitar fret diagrams; guitar-only capo/shape controls stay guitar-only.
- Live playback, linked SRP playback and WAV export all use the same expanded sound/preset routing.
- Cache generation bumped to v3.3.22.

```

## UPDATE-v3.3.23-LIVE-AUDIO-GRID-VIEW.txt

```text
Song Rider Suite v3.3.23 — Smooth Live Audio + Desktop/Tablet MIDI Grid View

1) Smooth live editing during playback
- Instrument/sound changes no longer force the rolling scheduler to wait for a new SoundFont to download/decode.
- The currently ready sound keeps playing while the new sound loads in the background.
- The new sound takes over cleanly on a scheduler boundary once it is fully ready.
- The playback scheduler now keeps roughly 0.65–0.70 seconds of audio queued, giving mobile devices enough render headroom during sample decoding/UI work.
- Live part-volume changes are smoothed on the active WebAudio bus.
- CRP octave/capo/transpose/shape/sustain edits are synced into Baby DAW playback live without transport restarts.
- Lead/Bass instrument-family switches use a lightweight control refresh instead of rebuilding the entire MIDI grid.

2) PC/tablet Lead/Bass MIDI grid view
- New Collapse Grid / Expand Grid button directly after Sustain.
- Only shown at widths above 720px; phone/mobile layout is untouched.
- Collapse Grid keeps the Baby DAW page fitted to the screen and makes the MIDI roll its own horizontal/vertical scroll window.
- Expand Grid restores the existing full-grid layout.
- The preference is remembered locally.

Files changed:
- index.html
- styles.css
- app.js
- parts.js
- service-worker.js

```

## UPDATE-v3.3.24-VOX-TRANSPORT-MULTI-AUTOSCROLL.txt

```text
Song Rider Suite v3.3.24 — Vox Box Transport / Multi-Edit / Instrumentals / AutoScroll
2026-09-18

Vox Box
- Added draggable floating transport, persistent position and viewport clamping.
- Transport order: beginning, rewind, fast-forward, end, stop, play, pause, record, AutoScroll, Lyrics.
- Responsive transport wraps on narrow phones so every control remains visible without horizontal scrolling.
- Added live record into the selected vocal track from the current Vox Box playhead position.
- Added click/drag playhead seeking. During live playback, seeking restarts the shared scheduler from the requested beat and publishes the new position immediately.
- Added Multi Select for vocal events. Copy/Cut/Paste/Delete and Event FX can operate on the selected group; grouped clips move together.
- Added Instrumentals checkbox. Vox Box can show/edit Beat events plus Chord/Note and Lead/Bass events in the timeline.
- Added Undo/Redo covering vocal edits, instrumental timing edits and beat edits.
- Added Vox Box AutoScroll. It follows playback/recording and disengages when the user manually navigates the timeline.
- Lyrics opens the existing Song Rider Pro full-song lyric overlay.
- Hidden underlying Baby DAW shell is removed from layout while Vox Box is open, preventing phantom tablet horizontal overflow.

Baby DAW
- Shared AutoScroll now follows Chord/Note cards and Lead/Bass MIDI playback.
- Manual pointer/wheel/touch navigation disengages AutoScroll for both Chord/Note and Lead/Bass views.

Verification
- Root and Song Rider JavaScript syntax checked with Node.
- Root and Song Rider HTML checked for duplicate IDs: none.
- CSS brace balance checked.
- Root service-worker precache paths checked: all present.
- Browser interaction test suite: 33/33 checks passed at 320, 360, 390, 768 and 1440 px, including multi-edit, FX, copy/paste, undo/redo, beat-event dragging, transport dragging, Lyrics link, live seek, manual AutoScroll disengage and horizontal-overflow checks.
- Browser automation environment has no physical microphone, so real microphone capture/audio quality must be verified on a device; the no-mic path was also verified to fail gracefully.

```

## UPDATE-v3.3.25-VOX-DEEP-DAW-EDITING.txt

```text
Song Rider Suite v3.3.25 — Vox Box Deep DAW Editing

- Added clickable Drum Map grid inside Vox Box.
- Added long-press track title reordering with persisted Vox Box track order.
- Added draggable left/right event edges for Lead/Bass and Chord/Note events.
- Added Cursor / Playhead mode switch in the track-title gutter.
- Improved Multi Select across vocal and instrument events; group move/copy/cut/paste/delete.
- Instrument edits persist immediately back to Baby DAW / Chord Rider state.
- Preserved Snap to Beat / free placement behavior for event moves and edge edits.

```

## UPDATE-v3.3.26-MOBILE-DRUM-MAP-FX-COLLAPSE.txt

```text
Song Rider Suite v3.3.26 — Mobile Drum Map + Instrument Focus

• Vox Box Drum Map now reserves the full vertical height of every drum row instead of using the old 180px track height. This prevents vocal clips/tracks from drawing over the lower drum rows on phones.
• Drum names remain pinned immediately to the right of the track-title gutter while the timeline scrolls horizontally.
• Selecting Beat, Chord/Note, Lead/Bass, a specific instrument event, or the Drum Map highlights that instrument track and collapses the Vocal Effects editor into a compact status strip.
• Selecting a vocal track or vocal event restores the full Vocal Effects editor.
• Drum Map focus is restored when Vox Box reopens with Drum Map persisted open.
• Desktop/tablet Vox Box behavior and existing DAW editing features are preserved.

```

## UPDATE-v3.3.27-TRACK-MASTER.txt

```text
Song Rider Suite v3.3.27 — Track Master

- Added a 24-karat-gold-style Track Master shortcut beneath the workspace selector in Chord Rider Pro, Baby DAW, and Song Rider Pro.
- Track Master opens the existing Vox Box/DAW track editor with instrument tracks enabled.
- Track Master can open even when no vocal part exists; instruments remain editable and a Vocal Track can be added from inside the editor.
- Song Rider Pro flushes linked BPM/capo/step state before navigating to Track Master.
- Track Master route is normalized for subpath deployments and auto-opens after returning to the main suite.
- Bumped suite cache/version to v3.3.27.

```

## UPDATE-v3.3.28-WIDE-TRACK-MASTER.txt

```text
Song Rider Suite v3.3.28 — Wide Track Master

- Track Master now spans the full shared navigation line in CRP, Baby DAW, and SRP.
- Side clearance matches the three workspace cards: 2.65vw on larger screens and 10px on mobile/tablet.
- Preserves the existing 24-karat-gold styling and all Track Master navigation behavior.
- Cache/version bumped so the layout update is picked up immediately after deployment.

```

## UPDATE-v3.3.29-VOX-FX-TOGGLE-TRACK-REORDER.txt

```text
Song Rider Suite v3.3.29

- Added Show/Hide control at the upper-right of the Vox Box Track Effects inspector.
- Instrument focus still auto-collapses the inspector; the Show button can temporarily reopen it.
- Fixed mobile/tablet track reordering: long-press a track title until it highlights, then drag vertically. Reordering now uses track-row midpoint geometry instead of hit-testing through the elevated sticky row.
- Track order continues to persist and sync back to Baby DAW part order.
- Cache/version bumped so the updated controls load after deployment.

```

## UPDATE-v3.3.30-VOX-CURSOR-DRUM-MAP-TRACK-MENU.txt

```text
Song Rider Suite v3.3.30

Vox Box DAW editing update
- Removed the Multi Select toggle. Cursor mode now uses normal-arrow marquee selection: drag a box over vocal, chord/note, or Lead/Bass events.
- Cursor and Playhead modes both keep events draggable; clicking the beat ruler relocates the playhead in either mode.
- Removed the old Beat event track and Drum Map launch button. Drum Map is the final Instrumentals track and has its own enable checkbox.
- Drum Map track header includes Beat Generator Style, Complexity, Randomize, and Fill Last Bar controls.
- Fixed event drag/drop and edge resizing. Snap-to-Beat follows the selected grid; free mode preserves precise placement.
- Multi-event copy/cut/paste preserves order and spacing; the earliest copied event begins at the playhead.
- Track-title right-click menu: Duplicate, Add Chord/Note, Add Lead/Bass, Add Vocal, and Delete. Add-track dialog supports mode/instrument/sound choices.
- Double-click Lead/Bass or Chord/Note events for inline note/chord editing and audition. Note octave is honored when typed; omitted octave follows the existing event/neighbor octave.
- Added Chords Used / Notes that fit guide beside Undo/Redo.
- Undo/Redo now preserves Vox Inspector hidden/focus state instead of unexpectedly reopening Vocal Effects.
- Vox timing edits are persisted into the shared project and reflected in Baby DAW / Chord Rider playback, MIDI/audio export, and save/load.

```

## UPDATE-v3.3.31-VOX-DRUM-TIMELINE-BPM.txt

```text
Song Rider Suite v3.3.31

Vox Box updates
- Removed the duplicate top Play button; the floating transport is now the only playback transport.
- Added a compact editable BPM field in the Vox Box header. BPM commits through the Suite canonical CRP/BD/SRP tempo sync.
- Rebuilt Drum Map alignment: drum title, generator controls, and drum names stay inside the sticky track-title column.
- Drum grid now starts exactly at timeline beat 1 with no extra name-column offset.
- Drum step width derives from the Vox Box pixels-per-beat scale, so every hit lines up with the ruler, chords, notes, leads and vocals on desktop/tablet/mobile.
- The Beat Maker pattern is repeated visually across the full song timeline, matching actual playback behavior. Editing any repeated occurrence updates the underlying pattern and therefore all repeated occurrences.

```

## UPDATE-v3.3.32-VOX-DRUM-RAIL-ALIGN.txt

```text
Song Rider Suite v3.3.32

Vox Box Drum Map repair
- Fixed the root cause of the drum title rail sliding/disappearing: overflow clipping on the drum row disabled sticky positioning.
- Drums, Style, Complexity, Randomize, Fill Last Bar and every drum name now live entirely in the same sticky left track-title rail as the other tracks.
- The drum title rail remains visible while horizontally scrolling the song timeline.
- Rebuilt drum cells with explicit song-time coordinates: left = absolute song beat × Vox Box pixels-per-beat.
- Drum cells no longer depend on CSS grid flow/implicit columns, eliminating horizontal offsets and cumulative rounding drift.
- The saved Beat Maker pattern repeats across the complete Vox Box song timeline. Editing any repeated hit updates the corresponding Beat Maker pattern step.
- Existing Vox BPM header and floating transport remain unchanged.

```

## UPDATE-v3.3.33-TRACK-MASTER-EVENT-MS.txt

```text
Song Rider Suite v3.3.33 — Track Master event creation + Mute/Solo + compact Vox tools

Changes
- Empty Chord/Note and Lead/Bass Track Master lanes can be double-clicked/double-tapped to create an event at that beat.
- The first event on an unconfigured track opens a setup dialog for Chord/Note, Instrument and Sound; later double-clicks use the saved track setup.
- New events open directly for inline typing. Note entries accept optional octave (for example F#, F#4, Bb3); no octave uses the track grid octave/default context.
- Added Mute (M) and Solo (S) controls to Chord/Note, Lead/Bass, Vocal and Drums track title boxes. Mix changes are live during playback.
- Removed the redundant + Active Take Vox Box button.
- Mobile Vox Box edit controls are packed into two action rows; Undo and Redo remain adjacent without horizontal scrolling.
- Blank Lead/Bass placeholder events are not played/exported until a real note is entered.

Cache generation: song-rider-suite-v3.3.33-track-master-event-ms

```

## UPDATE-v3.3.34-MOBILE-INLINE-EDIT-KEYBOARD.txt

```text
Song Rider Suite v3.3.34 — Vox Box mobile inline editor keyboard fix

Fixes the Track Master blank Chord/Note and Lead/Bass event editor on phones/tablets.

- Software-keyboard height-only resize no longer rebuilds Vox Box and destroys the focused inline input.
- Inline event input now focuses with preventScroll when supported and keeps selection stable.
- Genuine width/orientation changes still rebuild the Vox timeline after editing is complete.
- Enter commits the edit through blur; Escape cancels cleanly.

Cache generation: song-rider-suite-v3.3.34-mobile-inline-edit-keyboard

```

## UPDATE-v3.3.35-TRACK-MASTER-BLOCK-EDIT-FIX.txt

```text
Song Rider Suite v3.3.35 — Track Master block editing reliability

Fixes the mobile Track Master / Vox Box chord-note event problems shown in 1000097728.mp4:

1. Typed chord/note now becomes the real timeline block
   - Root cause: autosave capture called syncLoadedChord(), which replaced the loaded chord part's data object while the inline keyboard editor was open.
   - The editor then committed into an orphaned card object. Audition used that orphan (so the chord played) but the actual project card stayed blank.
   - While Vox Box / Track Master is open, its part data is now the editing authority. The core snapshot is captured immediately before opening instead of replacing live event objects during editing.
   - Inline commits also re-resolve the event by stable voxId before writing, then preserve explicit start/duration timeline fields.

2. Delete / Copy / Cut selection reliability
   - Instrument selection now re-resolves current chord/lead objects by stable IDs before an operation.
   - Tapping/selecting an event updates the Inspector/action toolbar immediately, so Delete/Copy/Cut are enabled on the same tap instead of waiting for another click.

3. Drag/drop and left/right resize reliability
   - Instrument drag/trim now uses window-level captured pointermove/pointerup listeners rather than relying only on the event element's pointer stream.
   - This is more reliable on Android Chrome inside the horizontally scrollable Track Master timeline.
   - Selection references are resolved against current project data before editing.
   - Touch trim handles are larger and have visible edge grips.

4. Persistence / app sync
   - Chord edits still apply to the loaded CRP chord core when committed.
   - Vox edits autosave without replacing live card identities.
   - Delete, move and trim persist back into the shared Song Rider Suite parts model.

Cache/version bumped to v3.3.35.

```

## UPDATE-v3.3.36-TRACK-MASTER-MULTITRACK-SAVE-GUARD.txt

```text
Song Rider Suite v3.3.36 — Track Master Multitrack + Save Guard

FIXED
1. Mobile Track Master double-tap now creates exactly one block.
   - The duplicate-event guard survives timeline rerenders.
   - Android synthesized click/dblclick events are ignored after the real double-tap add.
   - Eliminates hidden/phantom blocks that previously required repeated Delete presses.

2. Track Master chord/note and Lead/Bass copy/paste is destination-track aware.
   - Copy a block, select another compatible track, then Paste to that track at the playhead.
   - Multi-track copied selections preserve relative track offsets where compatible tracks exist.
   - Mixed chord/note cards keep their own event type when moved between Chord/Note tracks.

3. Track Master drag-and-drop now works between compatible tracks.
   - Chord/note blocks can be dragged between Chord/Note tracks.
   - Lead/Bass note blocks can be dragged between Lead/Bass tracks.
   - Destination track becomes the active Track Master focus after a cross-track move.

4. Unsaved project exit protection.
   - Starting New, opening another project, or leaving for Song Rider Pro prompts when a new project contains unsaved work.
   - Choices: Save & Continue, Continue Without Saving, or Cancel.
   - Browser/PWA close/back/reload also uses the browser's native unsaved-changes warning as a fallback.

CACHE
- Bumped shell/service-worker cache to v3.3.36 so patched JS/CSS replaces v3.3.35 reliably.

```

## UPDATE-v3.3.37-PHANTOM-CHORD-FIX.txt

```text
Song Rider Suite v3.3.37 — Track Master Phantom Chord/Note Fix

ROOT CAUSE FIXED
- A Track Master double-tap was correctly firing one add action, but the chord/note row insertion routine stored the new card twice in the final row.
- Both stored entries shared the same voxId, so they rendered as stacked/phantom blocks and required repeated Delete presses.

CHANGES
1. Blank chord/note insertion now inserts the new card exactly once using the canonical destination-row insertion path.
2. Existing saved projects are repaired on load by removing duplicate chord/note entries that share the same voxId.
3. Track Master rendering also defensively removes any legacy duplicate voxId entries before building visible blocks.
4. Existing v3.3.36 multi-track copy/paste, cross-track drag/drop, and unsaved-project protection are preserved.

CACHE
- Shell/service-worker cache bumped to v3.3.37 so Android/PWA installs replace the v3.3.36 JavaScript.

```

## UPDATE-v3.3.50-CLOUDFLARE-SRP-CUTOVER.txt

```text
Song Rider Suite v3.3.50 — Cloudflare SRP Cutover

- Song Rider Pro now uses the existing Song Rider Suite / Chord Rider Pro Cloudflare account session.
- SRP project sync moved from Supabase srp_user_projects to Cloudflare D1 srp_projects.
- SRP audio and note-image sync moved from Supabase Storage to authenticated Cloudflare R2 routes.
- Migrated legacy Supabase media paths remain authorized through each SRP project legacy_user_id.
- New SRP media uses the current Song Rider Suite user ID path.
- Removed Supabase JS runtime dependency from Song Rider Pro.
- Preserved local-first sync, tombstones, audio manifests, note-image manifests, and current CRP/BD cloud behavior.

```

## UPDATE-v3.3.51-TRACK-MASTER-RANGE-SELECT.txt

```text
Song Rider Suite v3.3.51 — Track Master Range Select

- Replaces the obsolete Track Master Crop toolbar button with Select.
- Select is a Cubase-style time-range selector for vocal tracks.
- Desktop: turn Select on and drag across a vocal track/event to highlight a range.
- Mobile: turn Select on, tap the start point, tap the end point, then drag either blue end handle to adjust the range.
- Copy and Cut preserve only the vocal audio inside the highlighted range; Paste places it at the playhead.
- Delete removes only audio inside the selected time range and preserves the original dry takes.
- Partial-event Cut/Delete is non-destructive and splits/trims event references rather than altering source audio.
- Existing Multi Select, event move/long-press, event trim handles, Split, Paste, Undo/Redo, playback, effects, instrument editing, and cloud behavior remain unchanged outside Select mode.
- Service worker cache version bumped so preview installs receive the new Track Master code immediately.

```

## UPDATE-v3.3.52-TRACK-MASTER-POLISH-SRP-FASTLOAD.txt

```text
Song Rider Suite v3.3.52 — Track Master polish + SRP fast load

- Lead/Bass instrument-family buttons now browse sounds without changing the active instrument or sound. The change commits only after a specific sound is tapped.
- Track Master AutoScroll starts ON every time Track Master opens. Any direct timeline tap, mouse wheel/trackpad scroll, or horizontal/vertical touch swipe switches AutoScroll off.
- SRP Save icon is now a true square floppy-disk silhouette; Notes icon is wider without changing button sizes.
- SRP returning-user startup is now local-first after authentication: cached project UI mounts before the large Cloudflare project merge. New devices with no local cache still perform the full cloud restore first for data safety.
- Service-worker/cache versions bumped for reliable dev-preview testing.

Protected / intentionally unchanged:
- Cloudflare D1/R2 production bindings and APIs
- SRP Cloudflare cutover logic and authentication
- Track Master Select range, Multi Select, split/copy/cut/paste/delete
- Track effects, playback, drag/resize, recording, project persistence
- CRP/BD/SRP sync and production deployment configuration

```

## UPDATE-v3.3.53-INSTRUMENT-BROWSE-NONDESTRUCTIVE.txt

```text
Song Rider Suite v3.3.53 — Non-destructive instrument browsing

Fixed the remaining CRP/Track Master sound-popup behavior shown in 1000098519.mp4.

- Tapping Piano / Guitar / Misc now only opens that family's sound browser.
- Browsing a family no longer changes state.instrument, state.sound, the active player, the highlighted active family, or saved project data.
- The instrument family + sound commit together only after a specific sound is tapped.
- Closing the popup without choosing a sound leaves the current instrument/sound completely unchanged.
- The existing mobile click-through protection in the sound popup is preserved.
- Lead/Bass family browsing behavior from v3.3.52 remains unchanged and non-destructive.

Protected / intentionally unchanged:
- Track Master Select, Multi Select, copy/cut/paste/delete/split, drag/resize
- AutoScroll default-on + gesture-off behavior
- SRP fast-load and Cloudflare D1/R2 cutover
- SRP Save/Notes icon sizing
- CRP/BD/SRP sync, project persistence, playback, effects, recording
- Worker APIs and production bindings

```

## UPDATE-v3.3.54-GLITCH-FREE-LIVE-PLAYBACK.txt

```text
Song Rider Suite v3.3.54 — Glitch-Free Live Playback

- Reworked Baby DAW / Track Master playback scheduling to keep about one second of WebAudio safely queued in short ~0.22s slices. This prevents UI redraws, page navigation, scrolling, and SoundFont decode work from starving the audio timeline while preserving live-edit behavior.
- Live-added/newly enabled instruments never block the scheduler waiting for a SoundFont; they join the mix once the player is ready. Existing instruments continue through live sound changes using the prior ready player until the new one is decoded.
- Increased Beat Maker look-ahead from 100ms to 550ms so drum hits remain sample-accurate through heavy mobile UI/layout work.
- Track Master waveform envelopes are cached and down-sampled for drawing instead of rescanning every PCM sample on each rerender. During playback, waveform painting is deferred to browser idle time when available.
- Playback remains continuous; no transport restart was added for instrument changes, part/page navigation, scrolling, volume/FX edits, or Track Master interaction.
- No database, Cloudflare, project format, Select/Multi Select, export, recording, or synchronization logic was changed.

```

## UPDATE-v3.3.55-BD-BATCH-TRACK-MASTER-SELECT.txt

```text
Song Rider Suite v3.3.55 — Baby DAW batch edit + Track Master selection

- Lead/Bass Copy, Paste, and Clear now use a bar + octave-grid selector.
  - Copy one or multiple bars, including an Active bars shortcut.
  - Copy/clear one or multiple octave grids.
  - Paste at a chosen destination bar and either preserve original octave grids or transpose the phrase by whole octaves to a chosen grid.
- Beat Maker Copy, Paste, Duplicate, and Clear now use multi-bar + drum-track selectors with Active bars/tracks shortcuts.
- Baby DAW Beat Maker and the Track Master primary drum region now stay synchronized in both directions.
- Deleting a vocal track from Track Master now removes it from Baby DAW immediately and moves the Baby DAW editor to a valid remaining part when needed.
- Multi Select now exposes an All checkbox for the highlighted track. Select All can be applied to multiple tracks without losing earlier track selections.
- Track Master Select range now works on Chord/Note, Lead/Bass, Drum, and Vocal tracks. Copy/Cut/Delete preserve material outside the selected time range; Paste starts at the playhead.
- Track Master transport AutoScroll is shown as a compact right arrow next to Lyrics, with one-line mobile layout and no horizontal transport scrolling.
- Existing v3.3.54 glitch-free live playback and Cloudflare production bindings preserved.

```

## UPDATE-v3.3.56-BD-DESTINATION-RANGE-UNDO-VOCAL-SYNC.txt

```text
Song Rider Suite v3.3.56

Fixes:
- Beat Maker Paste/Duplicate now has independent Destination Bars checkboxes (one, several, or All 16). Copied multi-bar patterns repeat across selected destination bars.
- Beat Maker source selection trims empty leading/trailing bars so selecting All Bars around one active bar still duplicates the active pattern instead of a 16-bar mostly-empty phrase.
- Lead/Bass paste now exposes Grid 1–6 as real destination choices even when source-grid checkboxes are hidden. Copy from Grid 3 can paste/transposed to any other grid.
- Track Master Range Select Cut/Delete now uses the same deferred persistence path as Multi Select and stores/restores range state in Undo snapshots.
- Track Master track deletion now hard-syncs the Baby DAW part list/editor immediately and removes stale backing references.

```

## UPDATE-v3.3.58-SRP-UNDO-EXPORT-PRINT.txt

```text
Song Rider Suite v3.3.58 — SRP Undo + Export/Print polish

Changes
- Fixed SRP Undo/Redo in Full Song editing so the first Undo visibly restores the prior lyric/chord edit rather than consuming an invisible derived-section sync step.
- Fixed legacy Full textarea history by capturing the pre-edit snapshot before live text mutation.
- Fixed chord/note and beat-field history paths that previously mutated state before the history snapshot.
- Reset SRP history when changing projects so Undo/Redo never crosses into another song.
- Fixed export section-title capture for the current Full Song section-title input.
- Exported chord lines are now bold red.
- Exported lyric lines are now bolder for easier reading.
- Section titles are included, bold, and underlined.
- Print CSS uses break-inside/page-break-inside avoidance so a section moves to the next page when it fits there as a whole; sections taller than a page may still split as required by the browser.

Files changed
- song-rider/app.js
- song-rider/index.html
- song-rider/service-worker.js

```

## UPDATE-v3.3.59-MIDI-DURATION-SYNC.txt

```text
Song Rider Suite v3.3.59 — MIDI Duration Sync

- Fixed CRP MIDI chord/note resizing when Track Master timing metadata already existed.
- MIDI duration edits now keep CRP durationBeats and Track Master voxDurationBeats synchronized.
- Baby DAW / Track Master playback now treats the CRP/MIDI duration as canonical when legacy data contains conflicting duration values.
- Project load repairs previously-saved chord cards whose two duration fields disagree, preventing Lines 2–4 (or any later line) from snapping back to an older 4-beat value after save/refresh.
- Unchanged cards rebuilt from the chord text bar retain Track Master identity/start/duration metadata.
- Service-worker cache bumped so mobile receives the corrected code immediately.

```

## UPDATE-v3.3.60-SONG-KEY-LOCK.txt

```text
Song Rider Suite v3.3.60 — Song Key Lock

Fixes CRP/Baby DAW project-key behavior:
- The key is now song/project-level metadata, not per-line metadata.
- Creating/typing a new line no longer changes the established song key from that line's first chord/note.
- 'Chords that fit' / 'Notes that fit' stay based on the song key across all lines.
- New Baby DAW and Track Master Chord/Note parts inherit the current song key instead of starting with a blank independent key.
- Existing Baby DAW chord parts with stale/mismatched keys are normalized to the saved project key on load.
- Switching among Baby DAW chord parts cannot overwrite the project key.
- During a brand-new song's first-line composition, auto key detection can still refine the initial key as the progression is entered.

Files changed: app.js, parts.js, service-worker.js.

```

## UPDATE-v3.3.73-CELTIC-GOLD-SKIN.txt

```text
Song Rider Suite v3.3.73 — Celtic Gold skin

Files included for upload:
- index.html
- service-worker.js
- skins.css
- skins.js
- song-rider/index.html

What this adds:
- New Appearance skin: Celtic Gold
- Emerald green + 24K gold + white/cream palette
- Celtic-knot mode button art (3-leaf clover + two knot variants)
- Tasteful green/gold framing and soft decorative treatment
- Cream/light editor canvases with green/gold active cells
- Track Master, Beat Maker, MIDI and Lead/Bass styled to match the Celtic palette
- Cache/version bump for clean refresh

```

## UPDATE-v3.3.76-CELTIC-GOLD-BEAUTY-REFRESH.txt

```text
Song Rider Suite v3.3.76 - Celtic Gold Beauty Refresh

Included in this upload-only package:
- skins.css
- skins.js
- assets/celtic-frame-light.svg
- assets/celtic-frame-dark.svg

What changed:
- Celtic Gold and Celtic Gold Dark mode buttons now use true icon-only 24-karat PNG knot icons (no gold tile behind them).
- Track Master button remains a clean 24-karat gold bar with no icon.
- Workspace mode text styling cleaned up for CRP / BD / SRP buttons.
- Straight corner lines replaced with Celtic knot frame overlays for panels, buttons, windows, and blank spaces.
- Dark Celtic Gold refreshed so buttons, chord/note cells, and step cells use gold/cream styling.

```

## UPDATE-v3.3.78-CELTIC-GOLD-FRAME-FIX.txt

```text
Song Rider Suite v3.3.78 — Celtic Gold frame fix

Upload these files into your repo, replacing the old ones:
- skins.css
- skins.js
- assets/celtic-mode-chord.png
- assets/celtic-mode-daw.png
- assets/celtic-corner-gold.png
- assets/celtic-corner-gold-bl.png
- assets/celtic-corner-gold-br.png
- assets/celtic-side-gold.png

Fixes:
- moved Celtic border/corner trim out of the control area so it no longer crosses buttons, inputs, or windows
- kept Track Master launcher clean with no decorative overlay
- set Song Rider icon to the same 3-leaf clover family as requested
- kept Baby DAW on the trinity knot and padded it so the edge is no longer clipped
- pushed the Celtic gold icons and trim closer to the Track Master gold tone

```

## UPDATE-v3.3.79-CELTIC-GOLD-ICON-CORNER-GEAR-FIX.txt

```text
Song Rider Suite v3.3.79 - Celtic Gold icon / corner / gear fix

Includes:
- Swapped Celtic mode icon mapping so Baby DAW uses the circular knot and Song Rider uses the triquetra.
- Added missing celtic-mode-song.png and celtic-mode-track.png to the upload package.
- Padded the triquetra icon so it no longer clips on the edge.
- Restored the Appearance settings gear to the top-right of the Log in box.
- Kept Celtic corner trim subtle and out of the way.

```

## UPDATE-v3.3.80-PRE-CELTIC-ROLLBACK.txt

```text
Song Rider Suite v3.3.80 — Pre-Celtic rollback

Purpose:
- Remove Celtic Gold and Celtic Gold Dark from the Appearance menu.
- Restore the skin system to the last pre-Celtic version while preserving all newer app functionality in the current dev repo.
- Restore the settings gear to the top-right of the Cloud Account panel / collapsed Cloud Account bar.
- Refresh service-worker caches so the rollback appears immediately.

Upload/overwrite these files:
- index.html
- skins.css
- skins.js
- service-worker.js
- song-rider/index.html
- song-rider/service-worker.js

Celtic image files already in the repo may be left in place. They are no longer referenced by the app and will not appear in the Appearance menu.

```

## UPDATE-v3.3.81-TWO-SKINS.txt

```text
Song Rider Suite v3.3.81 — Two New Skins

Added two skull-free appearance skins using the same polished icon approach as Studio Pastel / Black Label / Black Label Light.

New skins:
- Royal Wave — royal blue, baby blue, orange, cream
- Candy Pop — pink, teal, yellow, cream

Also refreshed cache/version strings so the new skins appear after upload and refresh.

Presentation-only update. No playback, project, cloud, or editor logic changed.

```

## UPDATE-v3.3.82-SKIN-PALETTE-FIX.txt

```text
Song Rider Suite v3.3.82 — Royal Wave + Candy Pop palette fix

Exact palette colors sampled from the user's references:
Royal Wave: #005CF7, #98D6FF, #FF9700, #EEE8C6
Candy Pop: #FFB2F6, #87FFF5, #FFF600, #EFEAD7

Fixes:
- Royal Wave CRP title surround now matches SRP black title band.
- Royal Wave uses visibly brighter royal blue plus baby blue, orange and cream.
- Royal Wave MIDI notes, lead notes and drum steps now have strong highlighted/off-state contrast.
- Candy Pop now uses unmistakable pink, teal, yellow and cream throughout the skin.
- Cache/query versions bumped so the corrected skins load immediately after deploy/refresh.

Presentation-only. No playback, save, sync, project or timing logic changed.

```

## UPDATE-v3.3.83-LIGHT-SRP-RIDER-BLOOD-LIGHT.txt

```text
Song Rider Suite v3.3.83

Fixes:
- Full Song View and Card View lyric windows now follow Studio Pastel, Black Label Light, Royal Wave, Candy Pop, Rider Light and Rider Blood Light instead of staying black.
- Rider Blood Light redesigned with red, patterned white, cream and polished gold from the supplied palette.
- Added rider-blood-light-pattern.png from the supplied pattern sample for light windows.
- Presentation only; playback, save/sync, project and timing logic unchanged.

```

## UPDATE-v3.3.84-ACTIVE-FILLS-RIDER-BLOOD-PATTERN.txt

```text
Song Rider Suite v3.3.84 — Active Fills + Rider Blood Light Pattern

Fixes:
- Royal Wave selected chord/note cells, beat/drum steps, and Lead/Bass notes now fill solid orange.
- Candy Pop selected chord/note cells, beat/drum steps, and Lead/Bass notes now fill solid yellow.
- Rider Blood Light uses the provided cream/gold geometric pattern across window surfaces.
- Rider Blood Light selected controls such as Piano and Chord now fill blood red.
- Presentation only; no playback, sync, save, timing, or project logic changed.

```

## UPDATE-v3.3.86-VERIFIED-SKIN-FIXES.txt

```text
Song Rider Suite v3.3.86 — verified skin fixes

This package was audited after v3.3.85 and closes the gaps found in that audit.

Rider Blood Light
- Includes the pattern PNG in this upload package.
- Extends the cream/gold pattern to CRP, Baby DAW and SRP window containers.
- Restores red primary/action buttons.
- Makes the selected Baby DAW top tile visibly red even though it uses a full-card image.

Royal Wave
- Active chord/note MIDI cells fill solid orange.
- Active Lead/Bass notes fill solid orange.
- Active Beat Maker / drum steps fill solid orange.

Candy Pop
- Active chord/note MIDI cells fill solid yellow.
- Active Lead/Bass notes fill solid yellow.
- Active Beat Maker / drum steps fill solid yellow.

No playback, sync, project, timing, or audio logic is changed.

```

## UPDATE-v3.3.87-ROYAL-WAVE-ONLY.txt

```text
Song Rider Suite v3.3.87 — Royal Wave only

Exact supplied palette:
- Royal blue #005CF7
- Baby blue #98D6FF
- Orange #FF9700
- Cream #EEE8C6

Fixes:
1. Active CRP MIDI chord/note cells now fill completely orange.
2. Active Lead/Bass notes/blocks now fill completely orange.
3. Active Beat Maker steps now fill completely orange.
4. Track Master drum on-cells are orange as well.
5. Ordinary Royal Wave buttons now use the supplied royal blue instead of baby blue.
6. Selected/toggled buttons remain royal blue with an orange state ring.
7. Added a new CSS cache-buster in both root and SRP pages plus a new service-worker cache name.

No playback, save, sync, timing, MIDI-duration, or project logic changed.

```

## UPDATE-v3.3.89-RIDER-LIGHT-SOLID-RED.txt

```text
v3.3.89

Rider Blood Light / Rider Light targeted fixes:
- Active beat, note, and chord cells now fill solid red.
- Baby DAW selected tile now uses a red background state rather than a red overlay.
- CSS version query and service-worker cache names updated.

```

## UPDATE-v3.3.90-ROYAL-CANDY-REBUILD.txt

```text
Song Rider Suite v3.3.90 — Royal Wave + Candy Pop rebuild

Rebuilt from the current dev repo using the exact supplied palettes.

Royal Wave
- Royal blue #005CF7
- Baby blue #98D6FF
- Orange #FF9700
- Cream #EEE8C6
- Cream inactive MIDI/lead/beat cells; solid orange active cells.
- Skull-free Studio/Black Label icon set.

Candy Pop
- Pink #FFB2F6
- Teal #87FFF5
- Yellow #FFF600
- Cream #EFEAD7
- Cream inactive MIDI/lead/beat cells; solid yellow active cells.
- Skull-free Studio/Black Label icon set.

No playback, project, sync, or cloud logic changed.

```

## UPDATE-v3.3.91-ACTIVE-CELL-ROOT-FIX.txt

```text
Song Rider Suite v3.3.91 — Royal Wave + Candy Pop Active Cell Root Fix

ROOT CAUSE FIXED
- The global Royal Wave/Candy Pop button skin rule was also matching MIDI, Lead/Bass, Beat Maker, and Track Master drum cells because those editor cells are buttons.
- That rule had higher CSS specificity plus !important, so it was overriding the intended orange/yellow active fills.

ROYAL WAVE
- Inactive editor cells: cream.
- Active chord/note, Lead/Bass, Beat Maker and Track Master drum cells: SOLID ORANGE (#FF9700).

CANDY POP
- Inactive editor cells: cream.
- Active chord/note, Lead/Bass, Beat Maker and Track Master drum cells: SOLID YELLOW (#FFF600).

No playback, project, cloud, timing, or editor logic was changed.

```

## UPDATE-v3.3.116-SAPPHIRE-PAISLEY.txt

```text
Song Rider Suite v3.3.116 — Sapphire Paisley Skin Set

Added two new appearance-only skins:
- Sapphire Paisley — supplied dark black/blue/gold paisley background with sapphire blue, baby blue, vivid yellow and polished gold.
- Sapphire Paisley Light — supplied light blue/gold paisley background with white, sapphire blue, baby blue, vivid yellow and polished gold.

Both skins:
- Apply across CRP, Baby DAW, SRP, Full Song/Card surfaces and Track Master presentation surfaces.
- Preserve app behavior, playback, project data, sync, layout, timing and editor geometry.
- Use strong active-cell contrast for CRP MIDI/chord-note cells, Baby DAW lead/bass notes and Beat Maker steps.
- Are supported by cloud skin preference saving.

Default skin remains Black Label Plain.

```

## UPLOAD-v1.8.1.txt

```text
Chord Rider Pro v1.8.1 FIXED

Replace these ROOT files in GitHub:
index.html
styles.css
app.js
parts.js
beat-maker.js
worker.js
service-worker.js
wrangler.jsonc

No asset replacement is needed.

Cloud vocals require Cloudflare R2:
1. Create bucket chord-rider-pro-audio
2. Bind that bucket to this Worker as AUDIO
3. Redeploy

This build forces the new service worker to activate immediately and cache-busts the main JS/CSS, so the phone should no longer stay on the old build.

```

## UPLOAD-v3.3.110.txt

```text
Rider Blood Light OG v3.3.110 — full-window background fix

Upload these files to the same paths in the dev repo:
- skins.css
- index.html
- service-worker.js
- song-rider/index.html
- song-rider/service-worker.js

Fix:
The Rider Blood Light base rules had higher CSS specificity than the Rider Blood Light OG background override on CRP and Baby DAW outer panels. The OG selector now matches that specificity, so the red/silver paisley fills the complete CRP, Baby DAW, and SRP window surfaces.

No artwork, button colors, active-cell behavior, or other skins were changed.

```

## UPLOAD-v3.3.111.txt

```text
Song Rider Suite v3.3.111 — Light Rider Fine-Text Readability

Applies ONLY to:
- Rider Light OG
- Rider Blood Light
- Rider Blood Light OG

Changes:
- Makes the small/fine secondary text black, bold and fully opaque on the light/patterned work surfaces in CRP, Baby DAW and SRP.
- Includes Octave, Sustain, BPM, Beats/chord, key-family hint, Drums/Vol/% labels, active-part volume labels, Repeat, Baby DAW grid setting labels, SRP BPM and Full Song View metadata.
- Keeps backgrounds, skin artwork, selected-cell colors, button palettes, and all other skins unchanged.

Upload these files preserving folders:
- skins.css
- index.html
- service-worker.js
- song-rider/index.html
- song-rider/service-worker.js

```

## UPLOAD-v3.3.112.txt

```text
Rider Blood Light OG v3.3.112 — lighter background refresh

What changed
- Replaced assets/rider-blood-light-og-pattern.jpg with the new lighter red/silver paisley background supplied by the user.
- Kept the v3.3.111 readability styling intact so secondary/fine text stays black, bold, and fully opaque.
- Bumped both service-worker cache names so the new background asset refreshes cleanly in CRP, Baby DAW, and SRP.

Files included
- assets/rider-blood-light-og-pattern.jpg
- service-worker.js
- song-rider/service-worker.js
- UPLOAD-v3.3.112.txt

```

## UPLOAD-v3.3.113.txt

```text
v3.3.113 — Playback resilience + live Lead/Bass tap + Line label readability

Playback audit / fixes
- Lead/Bass note placement now auditions while transport is already playing (previous code explicitly blocked audition during playback).
- Live audition uses an already-ready sample player during transport and will not block playback waiting for a network/sample decode.
- WebAudio resume handling now covers any non-running active context, not only the suspended state.
- Rolling scheduler buffer was modestly strengthened (1.20 s horizon, 0.20 s chunks, 45 ms tick).
- Scheduler now catches transient context/decode errors and continues instead of allowing a one-off async error to break the rolling playback loop.

Skin readability
- Line 1 / Line 2 badges and the mobile Line x / y indicator now use each skin's panel/text/border variables with bold, fully opaque text across every skin.

Files to upload
- parts.js
- skins.css
- service-worker.js
- song-rider/service-worker.js

```

## UPLOAD-v3.3.114.txt

```text
Song Rider Suite v3.3.114 — Black Label Plain + cloud skin preference

Changes
- Adds Black Label Plain: the clean Black Label look before the patterned background.
- Black Label Plain is the default skin for a fresh install/device with no saved preference.
- Logged-in users save their selected skin to D1 user_preferences.
- On app open/login, the cloud skin preference is restored across CRP, Baby DAW and SRP.
- Existing logged-in users with no cloud skin row are seeded from their current local skin so their present choice is preserved.

No project/audio/playback data is changed.

```

## UPLOAD-v3.3.115.txt

```text
Song Rider Suite v3.3.115 — repair + Black Label Plain

This build starts from the last known-good v3.3.113 repo and reapplies the v3.3.114 request safely.

Fixes:
- Restores the correct root index.html and CRP/Baby DAW app.js (the broken upload had accidentally replaced them with Song Rider Pro files).
- Restores the production Worker SRP project/media routes.
- Restores the stable root service worker asset list/cache behavior.
- Adds Black Label Plain as a separate no-pattern skin and makes it the fresh-install default.
- Adds authenticated cloud persistence for the selected skin without touching project/audio data.

Upload these changed files preserving paths:
- index.html
- app.js
- skins.js
- skins.css
- worker.js
- service-worker.js
- song-rider/index.html

No asset files are required for this repair.

```

## UPLOAD-v3.3.116.txt

```text
Upload these files to the SAME paths in your srs-dev repo, replacing the existing files where applicable:

/index.html
/skins.css
/skins.js
/worker.js
/service-worker.js
/song-rider/index.html
/assets/sapphire-paisley-dark.jpg
/assets/sapphire-paisley-light.png

This adds:
- Sapphire Paisley
- Sapphire Paisley Light

Black Label Plain remains the default skin for a new/local user with no saved skin preference.
Cloud skin persistence supports both new skin IDs.

```

## VOCAL-PLAYBACK-FIX.txt

```text
Chord Rider Pro v1.7.2

Fix: enabled Vocal parts now participate in the main Play transport.
- The selected/active take ("Using") starts with the song from bar 1.
- Vocal part volume and preview FX are applied during main playback.
- Vocal audio stops immediately with the master Stop control.
- Repeat loops include the vocal take.
- Playback length expands to include the active vocal take when needed.
- Vocal takes remain dry WAV masters in IndexedDB; effects remain non-destructive.

```

## VOCAL-RECORDER-UPDATE.txt

```text
Chord Rider Pro — Serious Vocal Recorder Update

What changed
- + Add Part is now stacked as Add / Part and no longer uses the plus symbol.
- Part-volume sliders use a custom track/thumb so 100% visually reaches the end.
- Removed duplicate visible volume controls inside Lead/Vocal editors; the Part volume row is the single control.
- Vocals now record a clean dry mono PCM WAV master instead of browser-compressed MP3/WebM.
- Mic request asks the browser for 48 kHz, mono, with echo cancellation, noise suppression and auto-gain disabled when supported.
- Live input meter + mic device/sample-rate info.
- Choose which Chord/Lead parts and drums play in headphones during recording.
- Separate backing playback level while recording; original part/drum levels restore after stopping.
- Multiple vocal takes stored locally in IndexedDB, with Use / Preview / Download WAV / Delete.
- Vocal effects (EQ, compression, reverb, delay) are non-destructive preview effects; the stored take remains dry.
- Project/cloud data stores vocal take metadata and settings. Actual WAV audio stays on the recording device for now to avoid bloating D1/cloud project data.

Important
- Use headphones while recording. The app records only the mic, but phone speakers can acoustically bleed into the mic.
- Browser/device audio constraints are requests; Android/Chrome may override some hardware processing.
- This phase intentionally stores WAV audio locally. Cloud audio sync and song/stem/DAW export are the next audio architecture phase.

```

## song-rider/UPDATE-v3.3.59-SRP-GDOCS-PRINT-LAYOUT.txt

```text
Song Rider Suite v3.3.59 — SRP Google Docs / Print Layout

- Preserves chord/lyric alignment when exported HTML is opened with Google Docs.
- Encodes spacing explicitly instead of relying on white-space CSS that Google Docs collapses.
- Uses borderless one-cell tables for each song section so Google Docs/print keeps section headings and bodies grouped more reliably across pages.
- Keeps bold black lyrics, bold red chords, and bold underlined section titles.
- Browser export preview remains visually unchanged.

```

## song-rider/UPDATE-v3.3.60-SRP-GDOCS-TABLE-GRID.txt

```text
v3.3.60 — SRP Google Docs table-grid export

- Replaces space-based chord positioning with borderless fixed-width HTML tables.
- Chord token positions are encoded as explicit table-cell widths, so Google Docs cannot collapse them.
- Lyrics use explicit leading-indent cells and inline Courier New styling.
- Chords remain bold red; lyrics remain bold black.
- Section titles remain bold + underlined.
- Each section stays inside a one-cell outer table to improve page-break grouping.
- Export styling is inline so Google Docs does not depend on preserving class-based CSS.

```

