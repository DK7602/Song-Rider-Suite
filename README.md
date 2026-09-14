# Chord Rider Pro

Chord Rider Pro is a responsive browser app for building, seeing, hearing, rearranging, and saving chord progressions.

## Current MVP features

- Guitar and piano chord diagrams
- Chord tones labeled directly on diagrams
- Click/tap any chord card to hear it
- Sampled sounds loaded through Soundfont Player
- Guitar: Acoustic, Electric, Bass
- Piano: Piano, Electric Piano, Synth, Bass
- Octave up/down
- Guitar capo and higher/lower neck voicing controls
- Compatible chord suggestions based on the first chord
- Click a suggested chord to append it
- Drag/reorder chord cards on desktop
- Long-press + tap reordering fallback on touch screens
- Start new visual rows
- Play/Stop full progression at adjustable BPM and beats/chord
- Repeat toggle
- Local project save/open/rename/delete
- Rich notes area
- Responsive phone/PC layout
- Installable PWA shell

## Run locally

Because service workers and some browser audio features prefer HTTP, use a simple local server instead of double-clicking the file.

### Python

```bash
python -m http.server 8000
```

Then open:

```text
http://localhost:8000
```

## GitHub Pages

1. Create a repo named `Chord-Rider-Pro`.
2. Upload every file/folder in this project.
3. Commit to `main`.
4. In GitHub, open **Settings → Pages**.
5. Under **Build and deployment**, select **Deploy from a branch**.
6. Choose branch **main**, folder **/(root)**, then **Save**.
7. GitHub will provide the public URL.

## Audio note

Instrument playback uses the `soundfont-player` browser library and MusyngKite sampled instruments. The first time a selected sound is used, the browser downloads sample data from the internet.

## Next good upgrades

- Full chord dictionary with more jazz/extended guitar voicings
- Slash chords and inversions
- Smarter key detection when several chords are entered
- Tempo patterns / strumming / arpeggiation
- Cloud sync instead of device-only localStorage
- User-selectable chord duration per card
- Export progression as MIDI or audio


## v2.1.1
- Mobile Full Song typing now follows the caret above the soft keyboard in integrated SRP mode.
- Keeps native single-page scrolling; no nested scroll containers reintroduced.

## v2.2.2 — Song Rider UI overhaul
- Restyled integrated Song Rider to match Chord Rider Pro's dark charcoal/gold interface.
- Standardized SRP buttons, fields, panels, song sections, and modals to CRP styling.
- Added a multicolor chrome treatment to the SONG RIDER PRO title.
- Preserved the native single-scroll and typing-caret autoscroll fixes from v2.1.1.


## v2.2.2 SRP layout polish
- SRP top header now matches CRP/Baby DAW with facing Rider & Bones, CRP title, and tagline.
- Header mascots animate during SRP audio playback or active autoscroll.
- Removed the parked mascot from the Song Rider Pro title bar.
- Undo/redo moved to the right side of the archive/action row.
- Mobile top-control layout reserves space for the key window.
- Section headers use the CRP/rhyme-button gold with bold black text.


## v2.2.6 SRP fixes
- Rebuilt Full Song View section title as a true CRP gold button.
- Song Rider header now uses the exact CRP title/tagline treatment.
- Repaired Link SRP with active-project recovery and visible link status.
- Removed obsolete update/install text files from this package.


## v2.2.7 SRP header/pill polish
- Section title pill reduced slightly for better balance.
- Song Rider top CHORD RIDER PRO wordmark now uses the same mobile title sizing/letter spacing as the CRP/Baby DAW header.


## v2.2.8 — CRP/SRP link + active-project persistence
- Removed stale calls to retired SRP iframe helpers that could throw while loading a CRP project.
- CRP now always remembers the active saved project ID.
- Opening Song Rider writes a fresh local project snapshot and handoff before navigation.
- Returning to CRP restores the same saved project instead of presenting it as a blank/new project.
- Link SRP now shows Linking/Linked feedback and explicitly persists the link record.
