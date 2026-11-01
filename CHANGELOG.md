# Changelog

## v3.4.1 — new look, Link SRP, dictation, drums

### New look
- **New Song Rider Suite logo** (gold rider and sound wave in a gold ring): app icon on phones,
  tablets and computers, the splash screen when the installed app opens, a short loading screen
  the first time the suite opens in a visit, Chord Rider PDF/PNG exports and the lock-screen
  media controls.
- **Gold module icons** on the Chord Rider, Baby DAW and Song Rider buttons in every skin.
- All the old skull art is gone (stickers, icons, Baby DAW button art, skeleton horses).
- On phones the Song Rider Suite banner spans the whole top line, and the Chord Rider Pro / Song
  Rider Pro titles fill their row up to the Hide button.

### Fixes
- **Link SRP works again in every situation.** With a Chord Rider project open it links at once;
  with none open it lists your Chord Rider projects to pick from (or explains how to make one);
  it asks before moving a link that belongs to another song; tapping it on a linked song unlinks.
- **Speech-to-text works when signed in on a phone.** The microphone permission prompt and cloud
  refreshes no longer silently end dictation, a silent microphone is reported, and the mic button
  no longer sits under the round "R" button.
- **Track Master drums stay in.** Editing a drum region during playback no longer stops the drums
  for good; drums no longer drift on every repeat when the song end isn't on the beat grid; drums
  switched on mid-song start on the beat; Stop, Pause and seeking silence drums already queued.
  (These problems existed in v3.3 too.)
- **Changing drum volume can no longer erase drums.** The Track Master drum volume, Mute/Solo and
  Drums switch (and Chord Rider's drum Vol slider and Drums box) used to rewrite the whole drum
  pattern from Beat Maker's copy; on songs where that copy was blank or different, one volume
  drag wiped the drums and saved it to the cloud. They now change only volume/mute/solo. Two other
  drum-erasing paths (an unrelated Track Master edit, Chord Rider Undo) are fixed too.
- **Much louder playback.** The sounds are recorded quietly and nothing boosted them (a full mix
  averaged about -32 dBFS). A loudness stage (drive, gentle compression, limiter) now brings the
  whole suite and WAV exports to normal music loudness (about -15 dBFS) without distortion.
- **Dictation in noisy rooms.** Phone microphones boost background noise, so dictation never
  found a pause and sent nothing while you talked. Pause detection now follows the room's noise
  level, a live level meter shows the mic is hearing you, and a blocked microphone explains how
  to allow it.
- **Dictation works every time, not just the first.** A second or third dictation session lost
  its status line after the screen refreshed, and on some Android phones the microphone opened
  but no sound arrived. Dictation now records through an audio engine opened after the
  microphone, and rebuilds it once by itself if no sound comes through.
- **No more crackling.** Loud peaks were hitting the very top of the output and clicking on
  phone speakers. Playback now keeps 3 dB of headroom, uses the browser's smooth playback mode
  (fewer audio dropouts on Android), and removes inaudible deep bass that only made speakers
  strain.

## v3.4.0 — reliability release

The theme of this release: **your work is never silently lost**, plus the musical fixes musicians
notice first. Earlier notes (v1.8 → v3.3) are in [`docs/HISTORY.md`](docs/HISTORY.md).

### Before you deploy

1. Update the database schema. It is safe to re-run and only adds what is missing:
   `npx wrangler d1 execute song-rider-suite-prod-db --remote --file=migrations/0001_init.sql`
2. Make sure the `INVITE_CODE` secret is set: `npx wrangler secret put INVITE_CODE`
3. `npx wrangler deploy`

Old cached copies of the app keep working against the new server; they just don't get the new
conflict protection until they update.

### Saving and sync (all modules)

- **No more silent overwrites between devices.** Every song carries a revision number. If your
  phone and PC both edited the same song, the second save no longer replaces the first; the app
  keeps both and adds a "(conflict copy …)" song with a notice.
- **Deleted songs stay deleted.** Deleting a song on one device removes it everywhere, even if
  another device was offline at the time. A song deleted on one device but edited on another is
  kept as a copy instead of vanishing.
- **New songs are saved before you name them.** An unsaved Chord Rider song (with its beat) is
  restored after a reload or crash.
- **You are told when saving fails.** A "Not saved" banner appears when the device is full or
  offline and clears itself once the save succeeds. Song Rider Pro keeps syncing from memory
  even when the device's storage is full.
- **Accounts don't mix.** Signing in with a different account on the same device parks the first
  account's songs instead of uploading them to the second account.
- Songs refresh when you come back to the app (focus, unlock, back online).
- The server refuses saves to a song id owned by another account, and limits repeated wrong
  passwords (per email and per network).

### Chord Rider Pro

- **Flats are spelled as flats.** "Bb Eb F Bb" is in **Bb** (not A#), F major suggests Bb, minor
  keys use their proper key signature, and chords you type keep your spelling. Baby DAW and
  Track Master note names follow the key too.
- **Slash chords** (G/B, D/F#, Am7/G) are accepted, play the bass note underneath on piano and
  guitar, export to PNG/PDF, and carry over to Song Rider Pro.
- **Undo / Redo** for builds, deletes, MIDI edits and Randomize Beat.
- Bigger, separated line Duplicate/Delete buttons (44 px), and tapping a label such as "Sustain"
  or the octave readout no longer presses the button next to it.
- BPM is kept between 40 and 240 everywhere.
- Chord cards work from the keyboard (Enter plays, Delete removes, arrows move); every drum step
  is labelled for screen readers; chord names are readable on the light skins.
- **Compact phone header**: on phones the editor now starts in the top quarter of the screen.
- PDF/PNG export libraries now load only when you export (faster startup).

### Scale Rider

- Minor keys work: in A minor, I–V–vi–IV gives C G Am F ("relative of A minor").
- The dialog can be closed with Escape and keeps keyboard focus inside while open.

### Beat Maker

- Two songs with the same name no longer share (or swap) their drums; the beat is saved with
  the song.

### Baby DAW and Track Master

- **The take you pick is the take you hear.** Take 2 replaces Take 1 on the timeline, and "Use"
  switches back.
- **Takes survive reloads.** If a project was never saved, a "Recover takes" banner offers the
  recordings back. Failed saves of a take are retried and shown as "Not saved".
- **Vocals line up.** Recordings are shifted by the delay your device reports, and a new
  **Recording offset (ms)** setting lets you fine-tune it (useful with Bluetooth headphones).
  Auto-Tune no longer shifts the vocal in time when you change its amount.
- **What you see is what you hear.** New vocal parts start with Repeat off, repeats show as faded
  clips in Track Master, and chords you place in Track Master stay put when you press Play or
  Save in Chord Rider.
- Deleting a track only removes its own clips; audio is only deleted when nothing uses it.
- Recording no longer changes your saved mix (part on/off, volumes, drums).
- Chords, drums and parts share one audio engine with a limiter, so loud mixes don't clip. Baby
  DAW is about 6 dB quieter overall to leave headroom.
- Export renders offline (a 5-second song in under a second), starts at the song's Start
  marker, and matches playback.
- Track Master undo covers drum patterns, tempo and renames; loading a project clears the
  history. The ⋮ track menu opens on phone taps, and the empty effects panel no longer covers
  the timeline on phones.
- No more audio slowdowns over long sessions (audio nodes and decoded instruments are reused
  instead of piling up).

### Song Rider Pro

- **Linking to Chord Rider no longer destroys lyrics.** All cards and lyrics are kept, long
  chord rows continue on the next card, and the import is a single Undo step.
- Pasting or importing over a song that already has lyrics asks first.
- **Dictation follows the song's style**: choose Hip-hop/Rap, Worship, Country, Pop, R&B or
  General next to each mic. Dictation keeps the last phrase when you leave the page, keeps
  phrases in order after a failure, and starts reliably on iPhone.
- Typing stays fast with a large library (about 6× less work per keystroke with 60 songs, and
  almost no network requests while typing). Background timers that ran several times a second
  are gone, which also helps battery life.
- Pasted or imported content is cleaned so it can't run scripts.
- Opening Song Rider directly shows the same layout as opening it from Chord Rider.
- PDF import and MP3 export libraries load only when used, and work offline.

### Offline, speed and housekeeping

- **Song Rider Pro opens offline** after one visit (previously only Chord Rider did).
- First load is much lighter: Chord Rider **6.2 → 2.6 MB**, Song Rider **10.7 → 3.4 MB** (WebP
  logos, resized images; nothing looks different).
- Third-party libraries are served from the app itself (`vendor/`) instead of outside sites.
- Speech-to-text uses Whisper large-v3-turbo and handles long recordings without running out of
  memory.
- ~100 old update notes were collected into `docs/HISTORY.md`; unused files and images removed.
- Automated tests (server contract plus phone/desktop browser tests for every module) run on
  every push via GitHub Actions. See [`tests/README.md`](tests/README.md).

### Things users may notice after updating

- The first sync after updating can turn a song into a "(conflict copy …)" when the device's
  copy is newer than the cloud's and different from it. Nothing is lost; delete whichever
  copy you don't want.
- The browser's "Leave page?" prompt is gone, because unsaved work is now kept automatically.
- Baby DAW playback is a little quieter (headroom for the limiter).
- Pasting over existing lyrics in Song Rider Pro asks for confirmation.
