(() => {
  const $ = (id) => document.getElementById(id);
  const state = {
    instrument: 'guitar',
    sound: 'acoustic_guitar_steel',
    octave: 0,
    capo: 0,
    neck: 'open',
    chords: [],
    rowBreaks: new Set(),
    playing: false,
    loopTimer: null,
    audioCtx: null,
    player: null,
    playerName: '',
    currentProjectId: null,
    dragIndex: null,
    playIndex: 0,
    currentChordStartedAt: 0
  };

  const SOUNDSETS = {
    guitar: [
      ['acoustic_guitar_steel', 'Acoustic'],
      ['electric_guitar_clean', 'Electric'],
      ['electric_bass_finger', 'Bass']
    ],
    piano: [
      ['acoustic_grand_piano', 'Piano'],
      ['electric_piano_1', 'Electric Piano'],
      ['synth_strings_1', 'Synth'],
      ['electric_bass_finger', 'Bass']
    ]
  };

  const NOTE_INDEX = {C:0,'C#':1,Db:1,D:2,'D#':3,Eb:3,E:4,F:5,'F#':6,Gb:6,G:7,'G#':8,Ab:8,A:9,'A#':10,Bb:10,B:11};
  const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  const FLAT_NAMES = ['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B'];

  const GUITAR_SHAPES = {
    C:  {frets:[null,3,2,0,1,0], fingers:['','3','2','','1',''], start:1},
    Cm: {frets:[null,3,5,5,4,3], start:3},
    C7: {frets:[null,3,2,3,1,0], start:1},
    Cmaj7:{frets:[null,3,2,0,0,0], start:1},
    D:  {frets:[null,null,0,2,3,2], start:1},
    Dm: {frets:[null,null,0,2,3,1], start:1},
    D7: {frets:[null,null,0,2,1,2], start:1},
    Dmaj7:{frets:[null,null,0,2,2,2], start:1},
    E:  {frets:[0,2,2,1,0,0], start:1},
    Em: {frets:[0,2,2,0,0,0], start:1},
    E7: {frets:[0,2,0,1,0,0], start:1},
    Emaj7:{frets:[0,2,1,1,0,0], start:1},
    F:  {frets:[1,3,3,2,1,1], start:1},
    Fm: {frets:[1,3,3,1,1,1], start:1},
    F7: {frets:[1,3,1,2,1,1], start:1},
    Fmaj7:{frets:[null,null,3,2,1,0], start:1},
    G:  {frets:[3,2,0,0,0,3], start:1},
    Gm: {frets:[3,5,5,3,3,3], start:3},
    G7: {frets:[3,2,0,0,0,1], start:1},
    Gmaj7:{frets:[3,2,0,0,0,2], start:1},
    A:  {frets:[null,0,2,2,2,0], start:1},
    Am: {frets:[null,0,2,2,1,0], start:1},
    A7: {frets:[null,0,2,0,2,0], start:1},
    Amaj7:{frets:[null,0,2,1,2,0], start:1},
    B:  {frets:[null,2,4,4,4,2], start:2},
    Bm: {frets:[null,2,4,4,3,2], start:2},
    B7: {frets:[null,2,1,2,0,2], start:1},
    Bmaj7:{frets:[null,2,4,3,4,2], start:2}
  };

  const CHORD_QUALITY_INTERVALS = {
    '': [0,4,7],
    'm':[0,3,7],
    '7':[0,4,7,10],
    'maj7':[0,4,7,11],
    'm7':[0,3,7,10],
    'sus2':[0,2,7],
    'sus4':[0,5,7],
    'dim':[0,3,6],
    'aug':[0,4,8],
    '6':[0,4,7,9],
    'm6':[0,3,7,9],
    'add9':[0,4,7,14],
    'm9':[0,3,7,10,14],
    '9':[0,4,7,10,14]
  };

  function parseChord(raw) {
    raw = raw.trim().replace(/♭/g,'b').replace(/♯/g,'#');
    const m = raw.match(/^([A-Ga-g])([#b]?)(.*)$/);
    if (!m) return null;
    let root = m[1].toUpperCase() + m[2];
    let quality = m[3].trim();
    quality = quality
      .replace(/^min(?!aj)/i,'m')
      .replace(/^major7$/i,'maj7')
      .replace(/^M7$/,'maj7')
      .replace(/^minor7$/i,'m7')
      .replace(/^minor$/i,'m');
    if (!(root in NOTE_INDEX)) return null;
    if (!(quality in CHORD_QUALITY_INTERVALS)) {
      // Keep recognizable extended names playable by reducing to a close base quality.
      if (/^m.*7/i.test(quality)) quality = 'm7';
      else if (/maj.*7/i.test(quality)) quality = 'maj7';
      else if (/7/.test(quality)) quality = '7';
      else if (/^m/i.test(quality)) quality = 'm';
      else quality = '';
    }
    return {raw, root, quality, display: root + quality};
  }

  function tokenizeInput(text) {
    return text.split(/[\s,|]+/).map(s => s.trim()).filter(Boolean);
  }

  function normalizeChordList(text) {
    const parsed = tokenizeInput(text).map(parseChord);
    return parsed.filter(Boolean).map(c => c.display);
  }

  function chordNotes(chord, baseOctave=4) {
    const c = parseChord(chord);
    if (!c) return [];
    const root = NOTE_INDEX[c.root];
    return CHORD_QUALITY_INTERVALS[c.quality].map(iv => {
      const idx = root + iv;
      const octave = baseOctave + Math.floor(idx / 12);
      return `${NOTE_NAMES[idx % 12]}${octave}`;
    });
  }

  function ensureAudio() {
    if (!state.audioCtx) state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (state.audioCtx.state === 'suspended') state.audioCtx.resume();
    if (!window.Soundfont) return Promise.reject(new Error('Sound engine unavailable'));
    if (state.player && state.playerName === state.sound) return Promise.resolve(state.player);
    $('status').textContent = 'Loading instrument samples…';
    return Soundfont.instrument(state.audioCtx, state.sound, {
      format: 'mp3',
      soundfont: 'MusyngKite'
    }).then(player => {
      state.player = player;
      state.playerName = state.sound;
      $('status').textContent = '';
      return player;
    }).catch(err => {
      console.error(err);
      $('status').textContent = 'Could not load sampled instrument. Check your internet connection.';
      throw err;
    });
  }

  async function playChord(chord, seconds=1.8) {
    const player = await ensureAudio();
    let octave = state.instrument === 'piano' ? 4 : 3;
    octave += state.octave;
    let notes = chordNotes(chord, octave);
    if (state.instrument === 'guitar') {
      if (state.sound === 'electric_bass_finger') notes = notes.slice(0, Math.min(3, notes.length)).map(n => transposeNote(n, -12));
      const now = state.audioCtx.currentTime;
      notes.forEach((note, i) => player.play(note, now + i * 0.035, {duration:seconds, gain:0.72}));
    } else {
      if (state.sound === 'electric_bass_finger') notes = notes.slice(0, Math.min(3, notes.length)).map(n => transposeNote(n, -12));
      const now = state.audioCtx.currentTime;
      notes.forEach(note => player.play(note, now, {duration:seconds, gain:0.7}));
    }
  }

  function transposeNote(note, semitones) {
    const m = note.match(/^([A-G])(#?)(-?\d+)$/);
    if (!m) return note;
    let midi = (Number(m[3]) + 1) * 12 + NOTE_INDEX[m[1]+m[2]] + semitones;
    const oct = Math.floor(midi / 12) - 1;
    return NOTE_NAMES[(midi % 12 + 12)%12] + oct;
  }

  function getCompatibleChords() {
    const first = state.chords[0];
    if (!first) return ['C','Dm','Em','F','G','Am','Bdim'];
    const fc = parseChord(first);
    const root = NOTE_INDEX[fc.root];
    const isMinor = fc.quality.startsWith('m') && fc.quality !== 'maj7';
    const intervals = isMinor ? [0,2,3,5,7,8,10] : [0,2,4,5,7,9,11];
    const qualities = isMinor ? ['m','dim','','m','m','',''] : ['','m','m','','','m','dim'];
    return intervals.map((iv,i) => NOTE_NAMES[(root+iv)%12] + qualities[i]);
  }

  function guessedKeyLabel() {
    if (!state.chords.length) return '';
    const c = parseChord(state.chords[0]);
    return `Based on ${c.display}: ${c.root} ${c.quality.startsWith('m') && c.quality !== 'maj7' ? 'minor' : 'major'} family`;
  }

  function renderSoundSelect() {
    const sel = $('soundSelect');
    sel.innerHTML = '';
    SOUNDSETS[state.instrument].forEach(([value,label]) => {
      const o = document.createElement('option');
      o.value = value; o.textContent = label;
      sel.appendChild(o);
    });
    if (!SOUNDSETS[state.instrument].some(x => x[0] === state.sound)) state.sound = SOUNDSETS[state.instrument][0][0];
    sel.value = state.sound;
  }

  function renderCompatible() {
    $('compatibleChords').innerHTML = '';
    getCompatibleChords().forEach(ch => {
      const b = document.createElement('button');
      b.className = 'chip'; b.textContent = ch;
      b.onclick = () => {
        state.chords.push(ch);
        $('chordInput').value = state.chords.join(' ');
        renderAll();
      };
      $('compatibleChords').appendChild(b);
    });
    $('keyHint').textContent = guessedKeyLabel();
  }

  function createPianoSvg(chord) {
    // Compact, dynamic keyboard: show only the range needed for the selected
    // voicing, plus a little musical context on each side.
    const baseOctave = 4 + state.octave;
    const noteNames = chordNotes(chord, baseOctave);

    function noteToMidi(note) {
      const m = note.match(/^([A-G])(#?)(-?\d+)$/);
      if (!m) return null;
      return (Number(m[3]) + 1) * 12 + NOTE_INDEX[m[1] + m[2]];
    }

    const chordMidis = noteNames.map(noteToMidi).filter(n => n != null);
    const targetMidis = new Set(chordMidis);

    // Pad the voicing by a few semitones, then snap the visible edges to
    // natural (white) keys so the keyboard looks intentional.
    let startMidi = Math.min(...chordMidis) - 4;
    let endMidi = Math.max(...chordMidis) + 5; // exclusive-ish upper padding

    const isBlack = midi => NOTE_NAMES[((midi % 12) + 12) % 12].includes('#');
    while (isBlack(startMidi)) startMidi--;
    while (isBlack(endMidi - 1)) endMidi++;

    // Guarantee enough context for a simple triad, while allowing 7ths,
    // 9ths, add chords, etc. to expand naturally when their voicing spans farther.
    while (endMidi - startMidi < 13) {
      startMidi--;
      if (isBlack(startMidi)) startMidi--;
      if (endMidi - startMidi >= 13) break;
      endMidi++;
      if (isBlack(endMidi - 1)) endMidi++;
    }

    const visibleWhites = [];
    for (let midi = startMidi; midi < endMidi; midi++) {
      if (!isBlack(midi)) visibleWhites.push(midi);
    }

    const whiteW = 46;
    const width = visibleWhites.length * whiteW;
    const height = 164;
    let whites = '';
    let blacks = '';
    const whiteXByMidi = new Map();

    visibleWhites.forEach((midi, i) => {
      const pc = NOTE_NAMES[((midi % 12) + 12) % 12];
      const x = i * whiteW;
      whiteXByMidi.set(midi, x);
      const hit = targetMidis.has(midi);

      whites += `<rect x="${x}" y="18" width="${whiteW}" height="132" rx="2" fill="${hit ? '#e9c46a' : '#f6f2e7'}" stroke="#171717" stroke-width="2"/>`;
      if (hit) {
        whites += `<text x="${x + whiteW / 2}" y="136" text-anchor="middle" font-size="16" font-weight="800" fill="#161616">${pc}</text>`;
      }
    });

    // Draw only black keys whose surrounding white-key position is visible.
    for (let midi = startMidi; midi < endMidi; midi++) {
      if (!isBlack(midi)) continue;
      const prevWhiteMidi = midi - 1;
      const prevX = whiteXByMidi.get(prevWhiteMidi);
      if (prevX == null) continue;

      const pc = NOTE_NAMES[((midi % 12) + 12) % 12];
      const hit = targetMidis.has(midi);
      const bx = prevX + whiteW - 14;

      blacks += `<rect x="${bx}" y="18" width="28" height="82" rx="2" fill="${hit ? '#f4a261' : '#1a1a1a'}" stroke="#080808" stroke-width="1.5"/>`;
      if (hit) {
        blacks += `<text x="${bx + 14}" y="78" text-anchor="middle" font-size="11" font-weight="800" fill="#fff">${pc}</text>`;
      }
    }

    const octaveText = state.octave === 0 ? 'Octave 0' : `Octave ${state.octave > 0 ? '+' : ''}${state.octave}`;

    return `<svg viewBox="0 0 ${width} ${height}" aria-label="${chord} piano diagram">
      <text x="4" y="12" fill="#9aa3ad" font-size="11">${octaveText}</text>
      ${whites}${blacks}
    </svg>`;
  }

  function baseGuitarShape(chord) {
    if (GUITAR_SHAPES[chord]) return JSON.parse(JSON.stringify(GUITAR_SHAPES[chord]));
    const c = parseChord(chord);
    // Use common barre E/A family for unsupported roots/qualities.
    const root = NOTE_INDEX[c.root];
    const majorLike = !c.quality.startsWith('m') || c.quality === 'maj7';
    // E-root barre relative to E
    let fret = (root - NOTE_INDEX.E + 12) % 12;
    if (fret === 0) fret = 12;
    const minor = c.quality.startsWith('m') && c.quality !== 'maj7';
    return {
      frets: minor ? [fret, fret+2, fret+2, fret, fret, fret] : [fret, fret+2, fret+2, fret+1, fret, fret],
      start: Math.max(1, fret)
    };
  }

  function createGuitarSvg(chord) {
    const shape = baseGuitarShape(chord);
    let frets = shape.frets.slice();
    let start = shape.start || 1;
    if (state.neck === 'higher') { frets = frets.map(f => f == null || f===0 ? f : f+12); start += 12; }
    if (state.neck === 'lower' && start > 5) { frets = frets.map(f => f == null || f===0 ? f : Math.max(1,f-5)); start = Math.max(1,start-5); }
    const capo = state.capo;
    if (capo) frets = frets.map(f => f == null ? null : f + capo);

    const width=360, height=245, left=55, top=36, stringGap=48, fretGap=35, displayFrets=5;
    const tuning = ['E','A','D','G','B','E'];
    let svg = `<svg viewBox="0 0 ${width} ${height}" aria-label="${chord} guitar diagram">`;
    svg += `<text x="10" y="18" fill="#9aa3ad" font-size="12">${capo ? `Capo ${capo}` : `Fret ${start}`}</text>`;
    for (let s=0;s<6;s++) {
      const x=left+s*stringGap;
      svg += `<line x1="${x}" y1="${top}" x2="${x}" y2="${top+displayFrets*fretGap}" stroke="#d8dde4" stroke-width="${1 + s*0.12}"/>`;
      svg += `<text x="${x}" y="${top+displayFrets*fretGap+24}" text-anchor="middle" fill="#8f99a5" font-size="12">${tuning[s]}</text>`;
    }
    for (let f=0;f<=displayFrets;f++) {
      const y=top+f*fretGap;
      svg += `<line x1="${left}" y1="${y}" x2="${left+5*stringGap}" y2="${y}" stroke="${f===0 ? '#f3f4f6':'#737d89'}" stroke-width="${f===0 ? 4:1.4}"/>`;
    }
    // build chord pitch classes for labels
    const c = parseChord(chord);
    const pcs = CHORD_QUALITY_INTERVALS[c.quality].map(iv => NOTE_NAMES[(NOTE_INDEX[c.root]+iv)%12]);
    frets.forEach((f,s) => {
      const x=left+s*stringGap;
      if (f == null) {
        svg += `<text x="${x}" y="29" text-anchor="middle" fill="#e76f51" font-size="15">×</text>`;
      } else if (f === 0 || f === capo) {
        svg += `<circle cx="${x}" cy="24" r="8" fill="none" stroke="#e9c46a" stroke-width="2"/>`;
      } else {
        let rel = f - start;
        if (rel < 0 || rel >= displayFrets) rel = Math.max(0, Math.min(displayFrets-1, (f % displayFrets)));
        const y=top + (rel+.5)*fretGap;
        const openMidi = [40,45,50,55,59,64][s];
        const pc = NOTE_NAMES[(openMidi + f) % 12];
        svg += `<circle cx="${x}" cy="${y}" r="14" fill="#e9c46a" stroke="#201b0e" stroke-width="2"/>`;
        svg += `<text x="${x}" y="${y+4.5}" text-anchor="middle" fill="#16120a" font-size="11" font-weight="900">${pc}</text>`;
      }
    });
    svg += `</svg>`;
    return svg;
  }

  function renderProgression() {
    const wrap = $('progression');
    wrap.innerHTML = '';
    state.chords.forEach((chord, index) => {
      if (state.rowBreaks.has(index)) {
        const br = document.createElement('div');
        br.className = 'row-break';
        wrap.appendChild(br);
      }
      const card = document.createElement('div');
      card.className = 'chord-card';
      card.draggable = true;
      card.dataset.index = index;
      card.innerHTML = `
        <div class="card-top">
          <span class="chord-name">${chord}</span>
          <button class="remove" title="Remove chord">×</button>
        </div>
        <div class="diagram">${state.instrument === 'piano' ? createPianoSvg(chord) : createGuitarSvg(chord)}</div>
        <div class="hint">Tap to play • hold & drag to move</div>`;
      card.querySelector('.remove').onclick = (e) => {
        e.stopPropagation();
        state.chords.splice(index,1);
        state.rowBreaks = new Set([...state.rowBreaks].filter(v => v !== index).map(v => v > index ? v-1 : v));
        $('chordInput').value = state.chords.join(' ');
        renderAll();
      };
      card.addEventListener('click', (e) => {
        if (!e.target.closest('.remove')) playChord(chord);
      });
      card.addEventListener('dragstart', (e) => {
        state.dragIndex = index;
        card.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
      });
      card.addEventListener('dragend', () => {
        card.classList.remove('dragging');
        state.dragIndex = null;
      });
      card.addEventListener('dragover', e => e.preventDefault());
      card.addEventListener('drop', e => {
        e.preventDefault();
        const from = state.dragIndex, to = index;
        if (from == null || from === to) return;
        const [moved] = state.chords.splice(from,1);
        state.chords.splice(to,0,moved);
        state.rowBreaks.clear(); // safest deterministic behavior after reorder
        $('chordInput').value = state.chords.join(' ');
        renderAll();
      });

      // Mobile long-press drag fallback: long press selects, then tap destination.
      let pressTimer = null;
      card.addEventListener('pointerdown', (e) => {
        if (e.target.closest('button')) return;
        pressTimer = setTimeout(() => {
          state.dragIndex = index;
          card.classList.add('dragging');
          $('status').textContent = `Moving ${chord}: tap another chord or “new line”.`;
          if (navigator.vibrate) navigator.vibrate(25);
        }, 480);
      });
      ['pointerup','pointercancel','pointerleave'].forEach(ev => card.addEventListener(ev, () => clearTimeout(pressTimer)));
      card.addEventListener('pointerup', (e) => {
        if (state.dragIndex != null && state.dragIndex !== index && !e.target.closest('button')) {
          const from = state.dragIndex, to = index;
          const [moved] = state.chords.splice(from,1);
          state.chords.splice(to,0,moved);
          state.rowBreaks.clear();
          state.dragIndex = null;
          $('chordInput').value = state.chords.join(' ');
          $('status').textContent = '';
          renderAll();
        }
      });
      wrap.appendChild(card);
    });
  }

  function renderAll() {
    renderSoundSelect();
    $('octaveValue').textContent = state.octave > 0 ? `+${state.octave}` : state.octave;
    $('capoWrap').style.display = state.instrument === 'guitar' ? '' : 'none';
    $('neckWrap').style.display = state.instrument === 'guitar' ? '' : 'none';
    document.querySelectorAll('#instrumentTabs .seg').forEach(b => b.classList.toggle('active', b.dataset.instrument === state.instrument));
    renderCompatible();
    renderProgression();
  }

  function getChordDurationMs() {
    const bpm = Math.max(40, Math.min(240, Number($('bpmInput').value) || 92));
    const beats = Number($('beatsSelect').value) || 4;
    return 60000 / bpm * beats;
  }

  function rescheduleForTempoChange() {
    if (!state.playing) return;
    if (state.loopTimer) clearTimeout(state.loopTimer);
    const chordMs = getChordDurationMs();
    state.loopTimer = setTimeout(runProgressionStep, chordMs);
    $('status').textContent = `Tempo: ${Math.round(60000 * Number($('beatsSelect').value || 4) / chordMs)} BPM`;
    setTimeout(() => { if ($('status').textContent.startsWith('Tempo:')) $('status').textContent = ''; }, 900);
  }

  async function runProgressionStep() {
    if (!state.playing || !state.chords.length) return;
    const chordMs = getChordDurationMs();
    const i = state.playIndex;
    state.currentChordStartedAt = performance.now();
    await playChord(state.chords[i], Math.max(.5, chordMs/1000*.88));
    if (!state.playing) return;

    const cards = [...document.querySelectorAll('.chord-card')];
    cards.forEach((c,idx) => c.style.outline = idx === i ? '2px solid var(--accent)' : '');

    state.playIndex += 1;
    if (state.playIndex >= state.chords.length) {
      if ($('loopToggle').checked) state.playIndex = 0;
      else return stopProgression();
    }
    state.loopTimer = setTimeout(runProgressionStep, chordMs);
  }


  function setRiderBonesRiding(isRiding) {
    ['riderBonesLeft', 'riderBonesRight'].forEach(id => {
      const img = $(id);
      if (!img) return;
      const nextSrc = isRiding ? img.dataset.animated : img.dataset.still;
      if (nextSrc && !img.src.endsWith(nextSrc)) img.src = nextSrc;
    });
  }

  async function playProgression() {
    if (state.playing) return stopProgression();
    if (!state.chords.length) {
      $('status').textContent = 'Add at least one chord first.';
      return;
    }
    state.playing = true;
    state.playIndex = 0;
    setRiderBonesRiding(true);
    $('playAllBtn').textContent = '■ Stop';
    await ensureAudio();
    runProgressionStep();
  }

  function stopProgression() {
    state.playing = false;
    setRiderBonesRiding(false);
    if (state.loopTimer) clearTimeout(state.loopTimer);
    state.loopTimer = null;
    state.playIndex = 0;
    $('playAllBtn').textContent = '▶ Play';
    document.querySelectorAll('.chord-card').forEach(c => c.style.outline = '');
  }

  function getProjects() {
    try { return JSON.parse(localStorage.getItem('crp-projects') || '[]'); }
    catch { return []; }
  }

  function setProjects(projects) {
    localStorage.setItem('crp-projects', JSON.stringify(projects));
  }

  function captureProject(id, name) {
    return {
      id: id || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())),
      name: name || 'Untitled',
      updatedAt: Date.now(),
      instrument: state.instrument,
      sound: state.sound,
      octave: state.octave,
      capo: state.capo,
      neck: state.neck,
      chords: [...state.chords],
      rowBreaks: [...state.rowBreaks],
      bpm: Number($('bpmInput').value) || 92,
      beats: Number($('beatsSelect').value) || 4,
      loop: $('loopToggle').checked,
      notes: $('notesEditor').innerHTML
    };
  }

  function saveProject() {
    const name = $('projectName').value.trim() || `Chord Project ${new Date().toLocaleDateString()}`;
    const projects = getProjects();
    let id = state.currentProjectId;
    if (id) {
      const idx = projects.findIndex(p => p.id === id);
      const p = captureProject(id, name);
      if (idx >= 0) projects[idx] = p; else projects.unshift(p);
    } else {
      const p = captureProject(null, name);
      id = p.id;
      projects.unshift(p);
      state.currentProjectId = id;
    }
    setProjects(projects);
    $('status').textContent = `Saved “${name}”.`;
    renderProjects();
  }

  function loadProject(id) {
    const p = getProjects().find(x => x.id === id);
    if (!p) return;
    state.currentProjectId = p.id;
    state.instrument = p.instrument || 'guitar';
    state.sound = p.sound || SOUNDSETS[state.instrument][0][0];
    state.octave = p.octave || 0;
    state.capo = p.capo || 0;
    state.neck = p.neck || 'open';
    state.chords = p.chords || [];
    state.rowBreaks = new Set(p.rowBreaks || []);
    $('projectName').value = p.name;
    $('chordInput').value = state.chords.join(' ');
    $('bpmInput').value = p.bpm || 92;
    $('beatsSelect').value = p.beats || 4;
    $('loopToggle').checked = p.loop !== false;
    $('notesEditor').innerHTML = p.notes || '';
    $('capoSelect').value = state.capo;
    $('neckSelect').value = state.neck;
    renderAll();
  }

  function deleteProject(id) {
    const p = getProjects().find(x => x.id === id);
    if (!p) return;
    if (!confirm(`Delete “${p.name}”?`)) return;
    setProjects(getProjects().filter(x => x.id !== id));
    if (state.currentProjectId === id) state.currentProjectId = null;
    renderProjects();
  }

  function renderProjects() {
    const wrap = $('projectList');
    const ps = getProjects().sort((a,b) => b.updatedAt - a.updatedAt);
    wrap.innerHTML = ps.length ? '' : '<div class="subtle">No saved projects yet.</div>';
    ps.forEach(p => {
      const el = document.createElement('div');
      el.className = 'project-item';
      el.innerHTML = `
        <div class="name">${escapeHtml(p.name)}</div>
        <div class="meta">${(p.chords||[]).length} chords</div>
        <button class="open">Open</button>
        <button class="rename">Rename</button>
        <button class="delete">Delete</button>`;
      el.querySelector('.open').onclick = () => loadProject(p.id);
      el.querySelector('.rename').onclick = () => {
        const name = prompt('New project name:', p.name);
        if (!name || !name.trim()) return;
        const projects = getProjects();
        const idx = projects.findIndex(x => x.id === p.id);
        projects[idx].name = name.trim();
        projects[idx].updatedAt = Date.now();
        setProjects(projects);
        if (state.currentProjectId === p.id) $('projectName').value = name.trim();
        renderProjects();
      };
      el.querySelector('.delete').onclick = () => deleteProject(p.id);
      wrap.appendChild(el);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
  }

  function init() {
    for (let i=0;i<=12;i++) {
      const o = document.createElement('option'); o.value=i; o.textContent = i === 0 ? 'None' : i;
      $('capoSelect').appendChild(o);
    }

    $('buildBtn').onclick = () => {
      const raw = tokenizeInput($('chordInput').value);
      const parsed = raw.map(parseChord);
      const bad = raw.filter((x,i) => !parsed[i]);
      state.chords = parsed.filter(Boolean).map(c => c.display);
      state.rowBreaks.clear();
      $('chordInput').value = state.chords.join(' ');
      $('status').textContent = bad.length ? `Skipped unrecognized: ${bad.join(', ')}` : '';
      renderAll();
    };
    $('chordInput').addEventListener('keydown', e => {
      if (e.key === 'Enter') $('buildBtn').click();
    });

    document.querySelectorAll('#instrumentTabs .seg').forEach(b => b.onclick = () => {
      state.instrument = b.dataset.instrument;
      state.sound = SOUNDSETS[state.instrument][0][0];
      state.player = null; state.playerName = '';
      renderAll();
    });

    $('soundSelect').onchange = e => { state.sound = e.target.value; state.player = null; state.playerName=''; };
    $('octaveDown').onclick = () => { state.octave = Math.max(-2, state.octave-1); renderAll(); };
    $('octaveUp').onclick = () => { state.octave = Math.min(3, state.octave+1); renderAll(); };
    $('capoSelect').onchange = e => { state.capo = Number(e.target.value); renderAll(); };
    $('neckSelect').onchange = e => { state.neck = e.target.value; renderAll(); };
    $('playAllBtn').onclick = playProgression;
    $('bpmInput').addEventListener('input', rescheduleForTempoChange);
    $('bpmInput').addEventListener('change', rescheduleForTempoChange);
    $('beatsSelect').addEventListener('change', rescheduleForTempoChange);

    $('newLineDrop').onclick = () => {
      if (state.dragIndex != null) {
        const idx = state.dragIndex;
        state.rowBreaks.add(idx);
        state.dragIndex = null;
        $('status').textContent = '';
      } else if (state.chords.length) {
        state.rowBreaks.add(state.chords.length-1);
      }
      renderAll();
    };
    $('newLineDrop').addEventListener('dragover', e => { e.preventDefault(); $('newLineDrop').classList.add('drop-active'); });
    $('newLineDrop').addEventListener('dragleave', () => $('newLineDrop').classList.remove('drop-active'));
    $('newLineDrop').addEventListener('drop', e => {
      e.preventDefault();
      $('newLineDrop').classList.remove('drop-active');
      if (state.dragIndex != null) {
        const idx = state.dragIndex;
        state.rowBreaks.add(idx);
        state.dragIndex = null;
        renderAll();
      }
    });

    $('saveProjectBtn').onclick = saveProject;
    document.querySelectorAll('.notes-toolbar [data-cmd]').forEach(b => b.onclick = () => document.execCommand(b.dataset.cmd, false, null));
    $('clearNotesBtn').onclick = () => { if (confirm('Clear notes?')) $('notesEditor').innerHTML=''; };

    renderProjects();
    renderAll();
    setRiderBonesRiding(false);

    if ('serviceWorker' in navigator) navigator.serviceWorker.register('service-worker.js').catch(()=>{});
  }

  init();
})();
