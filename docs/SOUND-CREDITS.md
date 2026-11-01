# Sound credits

Song Rider Suite's recorded instruments (`assets/instruments/<id>/`) are built from the free sample
libraries below. Every set was checked against the license published by its original author. Two
licenses (CC BY 3.0 and CC BY 4.0) require visible attribution, so this list, or a link to it, should be
reachable from the app (for example from an About or Credits screen).

The same processing was applied to every set unless an entry says otherwise:

- chose one velocity layer and samples about every 3 semitones;
- removed DC and trimmed leading silence so the attack starts within ~5 ms;
- cut the natural decay to a fixed length with a fade-out;
- checked the pitch and retuned to A440 equal temperament (by resampling) any note more than 6-8 cents
  off. The piano is the exception: only notes more than 20 cents off were retuned;
- loudness-matched the notes within the set, then normalized the set so its loudest peak is at -1 dBFS;
- converted to mono, except for the piano and vibraphone;
- resampled to 44.1 kHz where needed and encoded to MP3 with LAME (VBR V2; VBR V3 for the piano);
- for the winds and brass, found a seamless sustain loop, baked in a crossfade, and stored the loop points
  in `manifest.json`. A few notes had a slow level drift of at most 6 dB flattened so that they could loop.

| Set (`id`) | Library | Author | License |
|---|---|---|---|
| `acoustic_grand_piano` | Salamander Grand Piano V3 | Alexander Holm | CC BY 3.0 |
| `electric_grand_piano` | Yamaha CP80 Electric Grand | Greg Sullivan | CC BY 4.0 |
| `electric_piano_1` | jRhodes (Discord SFZ GM Bank version) | Jeff Learman | CC0 1.0 |
| `acoustic_guitar_steel` | Martin HD-28 (Discord SFZ GM Bank) | Jeff Learman | CC0 1.0 |
| `acoustic_guitar_nylon` | University of Iowa MIS – Guitar | Univ. of Iowa EMS / Lawrence Fritts | Free for any use, without restrictions |
| `electric_bass_finger` | Fashionbass | Karoryfer Samples (D. Smolken) | CC0 1.0 |
| `electric_guitar_clean` | FSBS Electric Guitar (direct) | FreePats | CC0 1.0 |
| `tenor_sax` | VCSL Tenor Saxophone | Versilian Studios | CC0 1.0 |
| `alto_sax` | Weresax | Karoryfer Samples | CC0 1.0 |
| `trumpet`, `trombone`, `tuba`, `flute` | VSCO-2 Community Edition | Versilian Studios (Sam Gossner, Simon Dalzell) | CC0 1.0 |
| `french_horn` | VSCO-2 CE (C2-C4) + University of Iowa MIS (D#4-F5) | Versilian Studios; Univ. of Iowa EMS | CC0 1.0 + free-use statement |
| `vibraphone` | VCSL Vibraphone | Versilian Studios | CC0 1.0 |
| `marimba` | University of Iowa MIS – Marimba | Univ. of Iowa EMS / Lawrence Fritts | Free for any use, without restrictions |

---

## acoustic_grand_piano: Salamander Grand Piano V3

- **Author:** Alexander Holm. The per-note tuning data comes from the "Retuned" SFZ by Markus Fiedler that
  ships with V3.
- **License:** Creative Commons Attribution 3.0. See <https://creativecommons.org/licenses/by/3.0/>. The
  license is stated in the archive.org item metadata and in the README inside the download.
- **Source:** <https://archive.org/details/SalamanderGrandPianoV3> (`SalamanderGrandPianoV3_44.1khz16bit.tar.bz2`).
  FreePats mirrors it at <https://freepats.zenvoid.org/Piano/acoustic-grand-piano.html>.
- **Attribution line:** "Salamander Grand Piano V3 by Alexander Holm, licensed under CC BY 3.0."
- **Changes:**
  - Kept 30 notes, A0-C8 every minor third, from two of the 16 velocity layers: v6 (soft) and v12
    (medium-loud).
  - Applied the Retuned-SFZ corrections. F#7 (+27 cents) and C8 (+61 cents) were still sharp afterwards and
    were retuned to A440.
  - Trimmed the decay to 6 s in the bass and 2 s at the top, with a fade.
  - Loudness-matched both layers to each other and across the range.
  - Normalized and encoded to stereo MP3.

## electric_grand_piano: Yamaha CP80 Electric Grand

- **Author:** Greg Sullivan (<http://www.sullivang.net/>). kinwie made the SFZ/FLAC conversion that was
  used here.
- **License:** Creative Commons Attribution 4.0 International. See
  <https://creativecommons.org/licenses/by/4.0/>. The author's homepage says: "Licensing (updated
  21-Oct-2026): All these instruments I host here now have Creative Commons Attribution 4.0 International
  licensing. (CC BY 4.0)". The SFZ conversion carries CC BY 3.0, which was granted earlier with the author's
  permission.
- **Source:** <http://www.sullivang.net/yamaha-cp80-electric-grand-instrument-for-gigasamplergigastudio>.
  The FLAC files came from <https://github.com/sfzinstruments/GregSullivan.E-Pianos> (commit 8c3e581).
- **Attribution line:** "Yamaha CP80 Electric Grand samples by Greg Sullivan (sullivang.net), licensed
  under CC BY 4.0."
- **Changes:**
  - Kept the forte layer: 22 notes, D#1-B7.
  - Retuned the two lowest notes (12-18 cents flat) and the top six notes (10-41 cents sharp).
  - Trimmed the decay to 6-3 s.
  - Loudness-matched, normalized and encoded to mono MP3.

## electric_piano_1: jRhodes, GM version (1977 Rhodes Mark I Stage 73)

- **Author:** Jeff Learman (<https://github.com/jlearman>), via kinwie's Discord SFZ GM Bank.
- **License:** CC0 1.0. See <https://creativecommons.org/publicdomain/zero/1.0/>. The GM-bank instrument
  file states "License: Creative Commons CC0, Jeff Learman". The author also wrote on the KVR forum on
  14 Nov 2022: "The Rhodes and acoustic guitar are CC0 for sure because I released them".
  - The author's separate, larger jRhodes3c and jRhodes3d releases are licensed CC BY-NC(-SA). They were
    not used. Only the GM-bank files were used.
- **Source:**
  <https://github.com/sfzinstruments/Discord-SFZ-GM-Bank/tree/master/Discord%20GM/Melodic/005-Electric%20Piano%201>
  (commit 7a9c478).
- **Changes:**
  - Kept 15 notes, F1-C7.
  - The GM files end at the author's sustain loop. Notes shorter than their target length (3-6 s) were
    extended by repeating that loop with a matched exponential decay.
  - Retuned F1, which was 9 cents sharp.
  - Loudness-matched, normalized and encoded to mono MP3.

## acoustic_guitar_steel: Martin HD-28 (GM version)

- **Author:** Jeff Learman, recorded for the Discord SFZ GM Bank. The instrument is a 2017 Martin HD-28
  Vintage Series.
- **License:** CC0 1.0, stated in the instrument file and by the author (see the entry above).
- **Source:**
  <https://github.com/sfzinstruments/Discord-SFZ-GM-Bank/tree/master/Discord%20GM/Melodic/026-Acoustic%20Guitar%20(steel)>
  (commit 7a9c478).
- **Changes:**
  - Kept 15 notes, E2-B5.
  - Retuned most notes, which were 8-16 cents flat.
  - Extended short notes to 3-4 s by repeating the author's loop with a matched decay.
  - Loudness-matched, normalized and encoded to mono MP3.

## acoustic_guitar_nylon: University of Iowa Musical Instrument Samples, Guitar

- **Author:** University of Iowa Electronic Music Studios, created by Lawrence Fritts. The guitar is a
  Raimundo 118 classical guitar played by Brian Penkrot, recorded on 11 Dec 2011.
- **License:** the usage statement at <https://theremin.music.uiowa.edu/MIS.html> says: "Since 1997, these
  recordings have been freely available on this website and may be downloaded and used for any projects,
  without restrictions."
- **Source:** <https://theremin.music.uiowa.edu/MISguitar.html> (`Guitar.mono.1644.1.zip`, mezzo-forte files).
- **Changes:**
  - Cut single notes out of the chromatic-scale recordings. Each note comes from the lowest-position string.
  - Kept 15 notes, E2-A#5.
  - Retuned every note: the recording was 9-41 cents flat.
  - Trimmed to 4 s.
  - Loudness-matched, normalized and encoded to mono MP3.

## electric_bass_finger: Karoryfer Fashionbass

- **Author:** Karoryfer Samples. The Killer KB-Simmony bass was played and mapped by D. Smolken.
- **License:** CC0 1.0. The official download includes a `LICENSE` file with the CC0 legal code, and its
  readme says "Royalty-free for all commercial and non-commercial use. Copyright 2014 Karoryfer Lecolds."
- **Source:** <https://github.com/sfzinstruments/karoryfer.fashionbass> (commit 0703973). Karoryfer's free
  libraries are distributed from these repositories. The page
  <https://shop.karoryfer.com/pages/free-fashionbass> was behind a bot check and could not be read.
- **Changes:**
  - Kept the mezzo-forte layer, round-robin 1: 15 notes, D1-G#4.
  - Retuned D1 (+22 cents) and B1 (+9 cents).
  - Trimmed to 4 s.
  - Loudness-matched, normalized and encoded to mono MP3.

## electric_guitar_clean: FreePats FSBS Electric Guitar (direct)

- **Author:** FreePats project (Roberto, <roberto@zenvoid.org>). The guitar is a basic-model Fender
  electric, bridge pickup, recorded direct.
- **License:** CC0 1.0. The license is stated on the FreePats page and in the README and `LICENSE.txt` in
  the download.
- **Source:** <https://freepats.zenvoid.org/ElectricGuitar/clean-electric-guitar.html>, release
  `EGuitarFSBS-direct-SFZ+FLAC-20220911` from <https://github.com/freepats/electric-guitar-FSBS-direct>.
- **Changes:**
  - Kept the normal-strength first round-robin: 19 notes, C2-C#6.
  - Converted from 48 kHz to 44.1 kHz.
  - Trimmed to 5 s.
  - Loudness-matched, normalized and encoded to mono MP3.
  - No amp or effects were added: the files are deliberately dry.

## tenor_sax: VCSL Tenor Saxophone

- **Author:** Versilian Studios LLC, Versilian Community Sample Library. The player is credited as "Brett".
- **License:** CC0 1.0. See the `LICENSE` file at <https://github.com/sgossner/VCSL>. The README says "Essentially
  it's Public Domain- you can do whatever you want with these sounds (even make commercial software)".
- **Source:**
  <https://github.com/sgossner/VCSL/tree/master/Aerophones/Reed%20Aerophones/Tenor%20Saxophone>
  (commit c1ea7bc).
- **Changes:**
  - Kept the non-vibrato samples, velocity layer 2: 23 notes, G#2-E6.
  - VCSL names octaves one lower than scientific pitch, so all notes were relabeled.
  - Converted stereo 48 kHz to mono 44.1 kHz.
  - Trimmed to 5 s.
  - Added sustain loops.
  - Loudness-matched, normalized and encoded to MP3.

## alto_sax: Karoryfer Weresax

- **Author:** Karoryfer Samples.
- **License:** CC0 1.0. The official download includes a `LICENSE` file with the CC0 legal code, and its
  readme says "This instrument is open source, and you can do whatever you want with it".
- **Source:** <https://github.com/sfzinstruments/karoryfer.weresax> (commit a4d756b).
- **Changes:**
  - Kept the forte layer, condenser mic: 12 notes, C#3-G#5. A#3 uses round-robin 2.
  - Relabeled the octaves, which Karoryfer names one lower.
  - Trimmed to 5.5 s.
  - Added sustain loops.
  - Loudness-matched, normalized and encoded to mono MP3.

## trumpet, trombone, tuba, flute, and french_horn C2-C4: VSCO-2 Community Edition

- **Author:** Versilian Studios LLC. Recorded by Sam Gossner and Simon Dalzell, sample cutting by Elan
  Hickler (Soundemote). Homepage: <http://vis.versilstudios.net/vsco-community.html>.
- **License:** CC0 1.0. See the `LICENSE` file at <https://github.com/sgossner/VSCO-2-CE>. The bundled
  readme adds two requests: do not sell the samples directly, and credit Versilian Studios / Sam Gossner
  and Ivy Audio / Simon Dalzell. This file meets the credit request, and the samples are not sold on their
  own.
- **Source:** <https://github.com/sgossner/VSCO-2-CE> (commit 4403009). Folders used: `Brass/Trumpet/sus`
  (v3), `Brass/Tenor Trombone/sus` (v2), `Brass/Tuba/sus` (v2, plus v1 for F1 and D4),
  `Woodwinds/Flute/susvib` (v1) and `Brass/F Horn/sus` (v2).
- **Changes:**
  - VSCO-2 names octaves one lower than scientific pitch, so all notes were relabeled.
  - Mixed down to mono and trimmed to 6 s.
  - Added sustain loops.
  - Loudness-matched, normalized and encoded to MP3.

## french_horn D#4-F5: University of Iowa Musical Instrument Samples, Horn

- **Author:** University of Iowa Electronic Music Studios (Lawrence Fritts). Played by Jessica Wiskus,
  recorded on 27 July 1997.
- **License:** the same University of Iowa free-use statement as above.
- **Source:** <https://theremin.music.uiowa.edu/MISFrenchhorn.html> (`Horn.mf.zip`).
- **Changes:**
  - Cut 6 single notes out of the chromatic-scale recordings: D#4, F#4, A4, C5, D#5 and F5.
  - Added sustain loops.
  - Loudness-matched to the VSCO-2 CE notes of the same set, normalized and encoded to mono MP3.
  - These notes fill the range above C4, where VSCO-2 CE has no horn sustain samples.

## vibraphone: VCSL Vibraphone

- **Author:** Versilian Studios LLC (VCSL).
- **License:** CC0 1.0 (see the tenor saxophone entry).
- **Source:**
  <https://github.com/sgossner/VCSL/tree/master/Idiophones/Struck%20Idiophones/Vibraphone>
  (`Soft Mallets`, layer v2, commit c1ea7bc).
- **Changes:**
  - Kept 11 notes, F3-E6, relabeled to scientific octaves.
  - Trimmed to 6 s.
  - Loudness-matched, normalized and encoded to stereo MP3.

## marimba: University of Iowa Musical Instrument Samples, Marimba

- **Author:** University of Iowa Electronic Music Studios (Lawrence Fritts). Played by Andrew Thierauf,
  recorded on 20 March 2013.
- **License:** the same University of Iowa free-use statement as above.
- **Source:** <https://theremin.music.uiowa.edu/Mismarimba.html> (yarn mallets, `Marimba.yarn.mf.zip`).
- **Changes:**
  - Cut single notes out of the chromatic-scale recordings: 21 notes, C2-C7.
  - Retuned most notes to A440: the instrument is tuned about 10-24 cents sharp.
  - Mixed down to mono and trimmed to 4 s.
  - Loudness-matched, normalized and encoded to MP3.

---

Instruments the app synthesizes, or derives from the sets above, use no third-party recordings and need no
credit. That covers `brass_section`, `clavinet`, `bright_acoustic_piano`, the electric-guitar variants and
the synth patches; see `assets/instruments/index.json`.
