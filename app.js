(() => {
  const $ = id => document.getElementById(id);
  const NOTES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  const NOTE_INDEX = {C:0,'C#':1,Db:1,Cb:11,'B#':0,D:2,'D#':3,Eb:3,E:4,'E#':5,Fb:4,F:5,'F#':6,Gb:6,G:7,'G#':8,Ab:8,A:9,'A#':10,Bb:10,B:11};

  // Chord vocabulary shared by typed CRP chords, Scale Rider insertion,
  // audition playback, diagrams and Baby DAW harmony. Keep this table as the
  // single source of pitch truth so a chord cannot be accepted by one feature
  // and rejected by another.
  const QUALITY = {
    '':[0,4,7], m:[0,3,7], '5':[0,7],
    '6':[0,4,7,9], m6:[0,3,7,9],
    '7':[0,4,7,10], maj7:[0,4,7,11], m7:[0,3,7,10], mMaj7:[0,3,7,11],
    '9':[0,4,7,10,14], maj9:[0,4,7,11,14], m9:[0,3,7,10,14],
    add9:[0,4,7,14], madd9:[0,3,7,14], add11:[0,4,7,17], madd11:[0,3,7,17],
    sus2:[0,2,7], sus4:[0,5,7], '7sus2':[0,2,7,10], '7sus4':[0,5,7,10],
    dim:[0,3,6], dim7:[0,3,6,9], m7b5:[0,3,6,10], aug:[0,4,8],
    '7b5':[0,4,6,10], '7#5':[0,4,8,10], '7b9':[0,4,7,10,13], '7#9':[0,4,7,10,15],
    'maj7#11':[0,4,7,11,18]
  };

  // v3.3.23 — expanded pro instrument palette + smooth live switching. All standard entries use the same
  // sampled General-MIDI SoundFont engine as the original Piano/Guitar sounds.
  // The two virtual presets (Wah Wah Electric + Funky Worm) keep sampled sources
  // and add a light WebAudio filter sweep instead of replacing them with oscillators.
  const SOUNDS = {
    piano:[
      ['acoustic_grand_piano','Piano'],
      ['bright_acoustic_piano','Bright Grand'],
      ['electric_grand_piano','Electric Grand'],
      ['electric_piano_1','Electric Piano'],
      ['electric_piano_2','Vintage E-Piano'],
      ['synth_strings_1','Synth'],
      ['pad_2_warm','Warm Synth Pad'],
      ['pad_3_polysynth','Poly Synth'],
      ['lead_2_sawtooth','Saw Synth'],
      ['electric_bass_finger','Bass']
    ],
    guitar:[
      ['acoustic_guitar_steel','Acoustic'],
      ['acoustic_guitar_nylon','Acoustic Nylon'],
      ['electric_guitar_clean','Electric'],
      ['electric_guitar_jazz','Jazz Electric'],
      ['electric_guitar_muted','Muted Electric'],
      ['overdriven_guitar','Crunch Electric'],
      ['distortion_guitar','Drive Electric'],
      ['wah_wah_guitar','Wah Wah Electric'],
      ['electric_bass_finger','Bass']
    ],
    misc:[
      ['tenor_sax','Sax'],
      ['alto_sax','Alto Sax'],
      ['french_horn','Horn'],
      ['brass_section','Brass Section'],
      ['trumpet','Trumpet'],
      ['trombone','Trombone'],
      ['tuba','Tuba'],
      ['flute','Flute'],
      ['clavinet','Clavinet'],
      ['funky_worm','Funky Worm'],
      ['drawbar_organ','Funk Organ'],
      ['vibraphone','Vibraphone'],
      ['marimba','Marimba'],
      ['whistle','G-Funk Whistle'],
      ['synth_brass_1','Synth Brass']
    ]
  };

  const VALID_INSTRUMENTS=new Set(Object.keys(SOUNDS));
  const SOUND_PRESETS={
    wah_wah_guitar:{source:'overdriven_guitar',fx:'wah'},
    funky_worm:{source:'lead_5_charang',fx:'worm'}
  };
  const SOUND_OUTPUT_GAIN={
    acoustic_grand_piano:3.15,bright_acoustic_piano:3.00,electric_grand_piano:2.85,electric_piano_1:2.75,electric_piano_2:2.55,
    synth_strings_1:1.10,pad_2_warm:1.18,pad_3_polysynth:1.20,lead_2_sawtooth:1.18,electric_bass_finger:1.10,
    acoustic_guitar_steel:2.95,acoustic_guitar_nylon:2.95,electric_guitar_clean:2.85,electric_guitar_jazz:2.75,electric_guitar_muted:2.85,
    overdriven_guitar:2.10,distortion_guitar:1.85,wah_wah_guitar:2.05,
    tenor_sax:2.05,alto_sax:2.00,french_horn:1.95,brass_section:1.55,trumpet:1.85,trombone:1.90,tuba:2.00,flute:2.10,
    clavinet:2.35,funky_worm:1.35,drawbar_organ:1.55,vibraphone:1.90,marimba:1.90,whistle:1.90,synth_brass_1:1.45
  };
  function normalizeInstrument(value){return VALID_INSTRUMENTS.has(value)?value:'piano';}
  function soundPreset(sound){const base=SOUND_PRESETS[sound]||{};return {id:sound,source:base.source||sound,fx:base.fx||'none'};}
  function soundOutputGain(sound){return SOUND_OUTPUT_GAIN[sound]||SOUND_OUTPUT_GAIN[soundPreset(sound).source]||1.0;}
  function isBassSound(sound){return /(?:^|_)bass(?:_|$)/.test(String(sound||''))||String(sound||'')==='electric_bass_finger';}
  async function loadSoundfontInstrument(ctx,sound,destination){
    if(!window.Soundfont)throw new Error('Sound engine unavailable');
    const preset=soundPreset(sound),opts={format:'mp3',soundfont:'MusyngKite',destination};
    try{return await Soundfont.instrument(ctx,preset.source,opts);}
    catch(firstError){
      // A few GM patches differ between the MusyngKite and FluidR3 manifests.
      // FluidR3 is a transparent fallback so every menu choice remains playable.
      console.warn(`MusyngKite could not load ${preset.source}; trying FluidR3_GM.`,firstError);
      return Soundfont.instrument(ctx,preset.source,{...opts,soundfont:'FluidR3_GM'});
    }
  }
  function createInstrumentFxChain(ctx,destination){
    const input=ctx.createGain(),dry=ctx.createGain(),filter=ctx.createBiquadFilter(),wet=ctx.createGain();
    input.connect(dry);dry.connect(destination);input.connect(filter);filter.connect(wet);wet.connect(destination);
    filter.type='lowpass';filter.frequency.value=19000;filter.Q.value=.7;dry.gain.value=1;wet.gain.value=0;
    let lfo=null,depth=null,currentFx='none';
    function ensureLfo(){
      if(lfo)return;
      lfo=ctx.createOscillator();depth=ctx.createGain();lfo.type='sine';lfo.frequency.value=1.8;depth.gain.value=0;lfo.connect(depth);depth.connect(filter.frequency);lfo.start();
    }
    function smooth(param,value,time=.025){const now=ctx.currentTime;try{param.cancelScheduledValues(now);param.setTargetAtTime(value,now,time);}catch{param.value=value;}}
    function setSound(sound){
      const fx=soundPreset(sound).fx;if(fx===currentFx&&fx==='none')return;currentFx=fx;
      if(fx==='wah'){
        ensureLfo();smooth(dry.gain,.58);smooth(wet.gain,.74);smooth(filter.frequency,1550);smooth(filter.Q,8,.04);smooth(lfo.frequency,1.65,.04);smooth(depth.gain,1050,.04);
      }else if(fx==='worm'){
        ensureLfo();smooth(dry.gain,.32);smooth(wet.gain,.92);smooth(filter.frequency,1325);smooth(filter.Q,10,.04);smooth(lfo.frequency,2.25,.04);smooth(depth.gain,950,.04);
      }else{
        if(depth)smooth(depth.gain,0,.025);smooth(filter.frequency,19000);smooth(filter.Q,.7,.03);smooth(dry.gain,1);smooth(wet.gain,0);
      }
    }
    function disconnect(){try{lfo?.stop();}catch{}for(const n of [input,dry,filter,wet,depth,lfo])try{n?.disconnect();}catch{}}
    return {input,setSound,disconnect};
  }

  const GUITAR_SHAPES = {
    C:[null,3,2,0,1,0], Cm:[null,3,5,5,4,3], C7:[null,3,2,3,1,0], Cmaj7:[null,3,2,0,0,0],
    D:[null,null,0,2,3,2], Dm:[null,null,0,2,3,1], D7:[null,null,0,2,1,2], Dmaj7:[null,null,0,2,2,2],
    E:[0,2,2,1,0,0], Em:[0,2,2,0,0,0], E7:[0,2,0,1,0,0], Emaj7:[0,2,1,1,0,0],
    F:[1,3,3,2,1,1], Fm:[1,3,3,1,1,1], F7:[1,3,1,2,1,1], Fmaj7:[null,null,3,2,1,0],
    G:[3,2,0,0,0,3], Gm:[3,5,5,3,3,3], G7:[3,2,0,0,0,1], Gmaj7:[3,2,0,0,0,2],
    A:[null,0,2,2,2,0], Am:[null,0,2,2,1,0], A7:[null,0,2,0,2,0], Amaj7:[null,0,2,1,2,0],
    B:[null,2,4,4,4,2], Bm:[null,2,4,4,3,2], B7:[null,2,1,2,0,2], Bmaj7:[null,2,4,3,4,2]
  };

  const savedInstrument = localStorage.getItem('crp-last-instrument');
  const state = {
    instrument: normalizeInstrument(savedInstrument),
    mode: localStorage.getItem('crp-last-mode') === 'note' ? 'note' : 'chord',
    sound:'', octave:0, capo:0, neck:'open', transpose:false,
    instrumentBus:null, instrumentFxChain:null,
    rows:[[]], selectedRow:0, playing:false, timer:null,
    audioCtx:null, player:null, playerName:'', currentProjectId:null, draftId:null, drag:null, lineDrag:null,
    autoScroll:localStorage.getItem('crp-auto-scroll')==='1',
    sustain:localStorage.getItem('crp-sustain')==='1',
    cardView:localStorage.getItem('crp-card-view')==='midi'?'midi':'diagram'
  };
  state.sound = SOUNDS[state.instrument][0][0];

  function parseRoot(raw) {
    const m=String(raw).trim().replace(/♭/g,'b').replace(/♯/g,'#').match(/^([A-Ga-g])([#b]?)/);
    return m ? m[1].toUpperCase()+m[2] : null;
  }
  function normalizeChordQuality(raw=''){
    let q=String(raw).trim().replace(/\s+/g,'');
    const exact={
      major:'',maj:'',minor:'m',min:'m','-':'m',
      major6:'6',maj6:'6',minor6:'m6',min6:'m6',
      major7:'maj7',M7:'maj7',minor7:'m7',min7:'m7',
      major9:'maj9',M9:'maj9',minor9:'m9',min9:'m9',
      minorMajor7:'mMaj7',minMaj7:'mMaj7',mM7:'mMaj7',
      halfdim7:'m7b5','ø7':'m7b5',o:'dim','°':'dim','o7':'dim7','°7':'dim7','+':'aug'
    };
    if(Object.prototype.hasOwnProperty.call(exact,q))q=exact[q];
    else q=q.replace(/^minor/i,'m').replace(/^min/i,'m').replace(/^major/i,'maj');
    return q;
  }
  // Accepts slash chords ("G/B", "D/F#", "Am7/G"): `base` is the chord without
  // the bass note, `bass` the note played underneath. The display keeps the
  // user's own spelling.
  function parseChord(raw) {
    raw=String(raw).trim().replace(/♭/g,'b').replace(/♯/g,'#');
    const slash=raw.match(/^(.+?)\/([A-Ga-g][#b]?)$/);
    const m=(slash?slash[1]:raw).match(/^([A-Ga-g])([#b]?)(.*)$/); if(!m)return null;
    const root=m[1].toUpperCase()+m[2]; if(!(root in NOTE_INDEX))return null;
    const q=normalizeChordQuality(m[3]);
    if(!(q in QUALITY))return null;
    const bass=slash?slash[2][0].toUpperCase()+slash[2].slice(1):null;
    if(bass&&!(bass in NOTE_INDEX))return null;
    const base=root+q;
    return {root,quality:q,bass,base,display:bass?`${base}/${bass}`:base};
  }
  function baseChordName(name){return parseChord(name)?.base||name;}

  // --- Note spelling --------------------------------------------------------
  // Pitch math uses pitch classes (0-11); names are for display only. Keys are
  // spelled the way they are written (Bb major, never A# major), chords we suggest
  // follow the key signature, and nothing the user typed is ever respelled.
  const FLAT_NOTES=['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B'];
  const LETTERS=['C','D','E','F','G','A','B'],NATURAL_PC={C:0,D:2,E:4,F:5,G:7,A:9,B:11};
  const MAJOR_TONICS=['C','Db','D','Eb','E','F','F#','G','Ab','A','Bb','B'],MINOR_TONICS=['C','C#','D','Eb','E','F','F#','G','G#','A','Bb','B'];
  // Enharmonic tonics that are also normal key signatures (chosen when the user writes them).
  const MAJOR_ALT_TONICS={1:'C#',6:'Gb',11:'Cb'},MINOR_ALT_TONICS={3:'D#',8:'Ab',10:'A#'};
  // Scale degree used to spell each semitone above a tonic (b2, 2, b3, 3, 4, #4, 5, b6, 6, b7, 7).
  const INTERVAL_DEGREE=[1,2,2,3,3,4,4,5,6,6,7,7];
  // keyTonicName(pc, minor, prefer): prefer is the tonic the user typed, or 'flat'/'sharp'.
  function keyTonicName(rootPc,minor,prefer=null){
    const pcn=((rootPc%12)+12)%12,def=(minor?MINOR_TONICS:MAJOR_TONICS)[pcn],alt=(minor?MINOR_ALT_TONICS:MAJOR_ALT_TONICS)[pcn];
    if(!alt)return def;
    if(prefer===def||prefer===alt)return prefer;
    if(prefer==='flat')return [def,alt].find(n=>n.includes('b'))||def;
    if(prefer==='sharp')return [def,alt].find(n=>n.includes('#'))||def;
    return def;
  }
  function keyTonic(key){return keyTonicName(NOTE_INDEX[key.root],key.minor,key.root);}
  function spellDegree(tonic,degree,pitch){
    const start=LETTERS.indexOf(String(tonic)[0]);if(start<0)return null;
    const letter=LETTERS[(start+degree-1)%7],diff=((pitch-NATURAL_PC[letter]+18)%12)-6;
    return diff===0?letter:diff===1?letter+'#':diff===-1?letter+'b':null; // null: would need a double accidental
  }
  function keyPrefersFlats(key){
    const t=keyTonic(key);
    return t.includes('b')||(!t.includes('#')&&(key.minor?['D','G','C','F'].includes(t):t==='F'));
  }
  // Spell a pitch class relative to a tonic name (diatonic notes by scale degree).
  function spellFromTonic(tonic,pitch,flats=tonic.includes('b')){
    const p=((pitch%12)+12)%12,iv=(p-NOTE_INDEX[tonic]+12)%12;
    return spellDegree(tonic,INTERVAL_DEGREE[iv],p)||(flats?FLAT_NOTES:NOTES)[p];
  }
  function spellInKey(pitch,key){return spellFromTonic(keyTonic(key),pitch,keyPrefersFlats(key));}
  // Chord tones spelled from the chord root (Bb chord = Bb D F, never A# D F).
  const CHORD_TONE_DEGREE={0:1,1:2,2:2,3:3,4:3,5:4,6:5,7:5,8:5,9:6,10:7,11:7,13:2,14:2,15:2,17:4,18:4};
  function chordToneNames(name){
    const c=parseChord(name);if(!c)return new Map();
    const rootPc=NOTE_INDEX[c.root],flats=c.root.includes('b')||(c.root.length===1&&keyPrefersFlats(enteredKey()||{root:'C',minor:false})),names=new Map();
    for(const iv of QUALITY[c.quality]){const p=(rootPc+iv)%12;names.set(p,spellDegree(c.root,CHORD_TONE_DEGREE[iv]??1,p)||(flats?FLAT_NOTES:NOTES)[p]);}
    if(c.bass)names.set(NOTE_INDEX[c.bass],c.bass);
    return names;
  }
  function normalizeChordSequence(chords){
    const raw=Array.isArray(chords)?chords:[],values=[],invalid=[];
    raw.forEach(v=>{const c=parseChord(v);if(c)values.push(c.display);else invalid.push(String(v??''));});
    return {values,invalid,valid:raw.length>0&&values.length===raw.length};
  }
  function parseNote(raw){const r=parseRoot(raw);return r&&r in NOTE_INDEX?r:null;}
  function tokens(text){return text.split(/[\s,|]+/).map(x=>x.trim()).filter(Boolean);}
  // Transposed names keep the source's accidental style (Bb up 2 = C, D/F# up 2 = E/G#).
  function transposeRoot(root,semi){
    const n=NOTE_INDEX[root];if(n==null)return root;
    const flats=root.includes('b')||(root.length===1&&keyPrefersFlats(enteredKey()||{root:'C',minor:false}));
    return (flats?FLAT_NOTES:NOTES)[(n+semi+120)%12];
  }
  function transposeChord(name,semi){const c=parseChord(name);return c?transposeRoot(c.root,semi)+c.quality+(c.bass?'/'+transposeRoot(c.bass,semi):''):name;}
  function chordNotes(name,baseOct=4){
    const c=parseChord(name);if(!c)return[];
    const notes=QUALITY[c.quality].map(iv=>{const n=NOTE_INDEX[c.root]+iv;return NOTES[n%12]+(baseOct+Math.floor(n/12));});
    if(c.bass)notes.unshift(NOTES[NOTE_INDEX[c.bass]]+(baseOct-1));
    return notes;
  }
  function midiOf(note){const m=String(note).match(/^([A-G])([#b]?)(-?\d+)$/);return m?(Number(m[3])+1)*12+NOTE_INDEX[m[1]+m[2]]:null;}
  function noteAtMidi(m){return NOTES[(m%12+12)%12]+(Math.floor(m/12)-1);}
  function clampBpm(value){const n=Math.round(Number(value));return Number.isFinite(n)&&n>0?Math.max(40,Math.min(240,n)):92;}
  const MIDI_BEAT_PX=44; // wider beat spacing gives phone drags much finer duration control
  function cardDurationBeats(card,fallback=+$('beatsSelect')?.value||4){
    const n=Number(card?.durationBeats);
    return Number.isFinite(n)&&n>0?Math.max(.25,Math.min(64,Math.round(n*4)/4)):Math.max(.25,Number(fallback)||4);
  }
  // v3.3.59 — CRP MIDI and Track Master share one chord duration. Track Master
  // stores an explicit voxDurationBeats on timeline-aware cards, while CRP MIDI
  // historically changed only durationBeats. That left two conflicting lengths:
  // the MIDI grid showed the edit, but Baby DAW/Track Master playback could keep
  // using the old (often 4-beat) value and restore it after reload. Keep both
  // representations synchronized whenever a MIDI duration is edited.
  function setCardDurationBeats(card,beats){
    const n=Math.max(.25,Math.min(64,Math.round((Number(beats)||.25)*4)/4));
    card.durationBeats=n;
    if(Number.isFinite(Number(card?.voxDurationBeats))||Number.isFinite(Number(card?.voxStartBeat))||card?.voxId)card.voxDurationBeats=n;
    return n;
  }
  function cardColumnWidth(card){return Math.max(62,Math.round(cardDurationBeats(card)*MIDI_BEAT_PX));}
  // v3.3.63 — MIDI view is a sequential progression editor. Do NOT write
  // absolute voxStartBeat positions here. Those positions belong to Track Master
  // and can outlive a later MIDI resize, causing playback/save/reload to fall back
  // to an older pattern. A MIDI duration edit deliberately returns the loaded
  // chord progression to sequential timing: each card starts after the duration
  // of the card before it. Playback derives those starts fresh from the current
  // durations, so the 2nd/3rd/etc. edit cannot reuse stale absolute positions.
  function storedCardDurationBeats(card,fallback=+$('beatsSelect')?.value||4){
    const drawn=Number(card?.durationBeats);
    if(Number.isFinite(drawn)&&drawn>0)return Math.max(.03,Math.min(64,drawn));
    const exact=Number(card?.voxDurationBeats);
    if(Number.isFinite(exact)&&exact>0)return Math.max(.03,Math.min(64,exact));
    return Math.max(.03,Number(fallback)||4);
  }
  function reflowMidiTimingFrom(){
    let found=false;
    for(const row of state.rows||[]){
      for(const card of row||[]){
        if(!card||typeof card!=='object')continue;
        const dur=storedCardDurationBeats(card);
        // MIDI timing is sequential. Remove Track Master's old absolute start so
        // chordFlatItems() must derive the next start from the CURRENT durations.
        delete card.voxStartBeat;
        card.durationBeats=dur;
        card.voxDurationBeats=dur;
        found=true;
      }
    }
    return found;
  }

  // Canonical piano voicing: always spell chords upward from the root.
  // This is the single source used by playback, on-screen diagrams and PDF export.
  // Example: F = F-A-C (never silently C-F-A); extended chords continue upward.
  // A slash chord adds its bass note in the octave below the chord.
  function canonicalPianoMidis(name,octaveShift=0){
    const c=parseChord(name);if(!c)return[];
    const rootPc=NOTE_INDEX[c.root],baseOct=4+octaveShift;
    const midis=QUALITY[c.quality].map(iv=>midiOf(NOTES[(rootPc+iv)%12]+(baseOct+Math.floor((rootPc+iv)/12))));
    if(c.bass)midis.unshift(midiOf(NOTES[NOTE_INDEX[c.bass]]+(baseOct-1)));
    return midis;
  }
  function projectPianoVoicings(){
    const map=new Map();
    state.rows.forEach(row=>row.forEach(card=>{
      if(card.type==='chord')map.set(card,canonicalPianoMidis(displayedValue(card),state.octave));
    }));
    return map;
  }
  function pianoMidisForCard(card){
    if(card.type==='note')return[midiOf(displayedValue(card)+(4+state.octave))].filter(x=>x!=null);
    return canonicalPianoMidis(displayedValue(card),state.octave).filter(x=>x!=null);
  }

  const allCards=()=>state.rows.flat();
  // v3.3.60 — the key is song/project metadata, never line metadata. When a
  // saved/manual key exists it is authoritative for every CRP line and Baby DAW
  // chord part. This fallback is used only before a song key has been established,
  // and it considers the whole committed progression instead of the first card.
  function inferredKey(){return inferKeyFromCards(allCards())||{root:'C',minor:false};}
  function enteredKey(){
    const el=$('keyInput');if(!el)return null;
    const raw=el.value.trim().replace(/♭/g,'b').replace(/♯/g,'#');if(!raw)return null;
    const m=raw.match(/^([A-Ga-g])([#b]?)(?:\s*(m|minor|maj|major))?$/i);if(!m)return null;
    const root=m[1].toUpperCase()+m[2];if(!(root in NOTE_INDEX))return null;
    const quality=(m[3]||'').toLowerCase();return{root,minor:quality==='m'||quality==='minor'};
  }
  function activeKey(){return enteredKey()||inferredKey();}
  function selectedRow(){while(state.rows.length<=state.selectedRow)state.rows.push([]);return state.rows[state.selectedRow];}
  function syncBuildInput(){
    const input=$('chordInput');if(!input)return;
    input.value=selectedRow().filter(c=>c.type===state.mode).map(c=>c.value).join(' ');
  }
  function parseBuildInput(){
    const vals=[],bad=[];
    tokens($('chordInput')?.value||'').forEach(x=>{
      const v=state.mode==='chord'?parseChord(x)?.display:parseNote(x);
      v?vals.push({type:state.mode,value:v}):bad.push(x);
    });
    return {vals,bad};
  }
  function commitBuildInput(){
    const {vals,bad}=parseBuildInput();
    const previous=state.rows[state.selectedRow]||[];
    // Preserve MIDI edits AND drawn durations for unchanged cards. Building or
    // switching views must never collapse a stretched chord/note back to the
    // default beats-per-chord value.
    vals.forEach((card,i)=>{
      const prior=previous[i];
      if(prior&&prior.type===card.type&&prior.value===card.value){
        if(Array.isArray(prior.midiNotes))card.midiNotes=[...prior.midiNotes];
        if(Number.isFinite(+prior.durationBeats)&&+prior.durationBeats>0)card.durationBeats=+prior.durationBeats;
        // Preserve Track Master identity/timing for an unchanged card. Dropping
        // these fields while rebuilding the text row can otherwise resurrect an
        // older 4-beat timeline value on the next parts sync / project reload.
        if(prior.voxId)card.voxId=prior.voxId;
        if(Number.isFinite(+prior.voxStartBeat)&&+prior.voxStartBeat>=0)card.voxStartBeat=+prior.voxStartBeat;
        if(Number.isFinite(+prior.voxDurationBeats)&&+prior.voxDurationBeats>0)card.voxDurationBeats=+prior.voxDurationBeats;
        if(prior.voxBlank===true)card.voxBlank=true;
      }
    });
    state.rows[state.selectedRow]=vals;
    return bad;
  }

  function inferKeyFromCards(cards){
    if(!cards.length)return null;
    const first=cards[0];
    // Name the detected key in the same accidental style the user typed (Bb, not A#).
    let flatCount=0,sharpCount=0;
    for(const card of cards){const r=card.type==='chord'?parseChord(card.value)?.root:card.value;if(/b$/.test(r||''))flatCount++;else if(/#$/.test(r||''))sharpCount++;}
    const style=flatCount>sharpCount?'flat':sharpCount>flatCount?'sharp':null;
    let best=null;
    for(let rootIndex=0;rootIndex<12;rootIndex++){
      for(const minor of [false,true]){
        const ints=minor?[0,2,3,5,7,8,10]:[0,2,4,5,7,9,11];
        const triQ=minor?['m','dim','','m','m','','']:['','m','m','','','m','dim'];
        const sevQ=minor?['m7','m7b5','maj7','m7','m7','maj7','7']:['maj7','m7','m7','maj7','7','m7','m7b5'];
        // Compare pitch classes, not names, so Bb and A# count as the same chord.
        const scalePcs=new Set(ints.map(i=>(rootIndex+i)%12));
        const family=new Set();
        ints.forEach((iv,j)=>{
          const r=(rootIndex+iv)%12;
          family.add(r+':'+triQ[j]);
          family.add(r+':'+sevQ[j]);
        });
        let score=0;
        for(const card of cards){
          if(card.type==='note'){
            score+=scalePcs.has(NOTE_INDEX[card.value])?3:-5;
            continue;
          }
          const c=parseChord(card.value);if(!c)continue;
          if(family.has(NOTE_INDEX[c.root]+':'+c.quality))score+=6;
          else if(scalePcs.has(NOTE_INDEX[c.root]))score+=1;
          else score-=6;
        }
        const tonic=NOTES[rootIndex];
        if(first.type==='chord'){
          const c=parseChord(first.value);
          if(c&&NOTE_INDEX[c.root]===rootIndex){
            const firstMinor=c.quality.startsWith('m')&&!c.quality.startsWith('maj');
            score+=firstMinor===minor?4:1;
          }
        }else if(first.type==='note'&&NOTE_INDEX[first.value]===rootIndex)score+=2;
        // When relative major/minor keys are otherwise tied, prefer major unless
        // the progression begins on the minor tonic.
        if(!minor)score+=0.15;
        if(!best||score>best.score)best={root:tonic,minor,score};
      }
    }
    return best?{root:keyTonicName(NOTE_INDEX[best.root],best.minor,style),minor:best.minor}:null;
  }
  function cardsFromEntry(){
    return tokens($('chordInput')?.value||'').map(x=>{
      if(state.mode==='chord'){
        const c=parseChord(x);return c?{type:'chord',value:c.display}:null;
      }
      const n=parseNote(x);return n?{type:'note',value:n}:null;
    }).filter(Boolean);
  }
  function cardsForSongKeyInference(){
    // While composing the very first line, use the live Build text in place of
    // that row so the initial key can improve as the progression is entered.
    // Once another line exists, the established song key is locked and a later
    // line can never re-key the project from its first chord/note.
    const live=cardsFromEntry();
    return state.rows.flatMap((row,ri)=>ri===state.selectedRow?live:(Array.isArray(row)?row:[])).filter(Boolean);
  }
  function lockAutoSongKey(){
    const key=$('keyInput');if(key?.value.trim())key.dataset.autoKey='0';
  }
  function autoPopulateKeyFromEntry(){
    const key=$('keyInput');if(!key)return;
    const hasKey=!!key.value.trim(),auto=key.dataset.autoKey==='1';
    if(hasKey&&!auto)return;
    // A second line means the first-line inference phase is over. From this point
    // forward the key belongs to the song, not whichever line is selected/typed.
    if(hasKey&&state.rows.length>1){lockAutoSongKey();return;}
    const inferred=inferKeyFromCards(cardsForSongKeyInference());if(!inferred)return;
    key.value=inferred.root+(inferred.minor?'m':'');
    key.dataset.autoKey='1';
    renderFits();
  }

  function fitItems(){
    const k=activeKey(),r=NOTE_INDEX[k.root],ints=k.minor?[0,2,3,5,7,8,10]:[0,2,4,5,7,9,11];
    const names=ints.map(i=>spellInKey(r+i,k));
    if(state.mode==='note')return names;
    const triQ=k.minor?['m','dim','','m','m','','']:['','m','m','','','m','dim'];
    const sevQ=k.minor?['m7','m7b5','maj7','m7','m7','maj7','7']:['maj7','m7','m7','maj7','7','m7','m7b5'];
    const tri=names.map((n,j)=>n+triQ[j]);
    const sev=names.map((n,j)=>n+sevQ[j]);
    const tonic=names[0],fifth=names[4];
    const extra=k.minor?[tonic+'m9',tonic+'madd9',tonic+'m6',tonic+'sus2',fifth+'7',fifth+'9']:[tonic+'maj9',tonic+'add9',tonic+'6',tonic+'sus2',tonic+'sus4',fifth+'9'];
    return [...new Set([...tri,...sev,...extra])];
  }

  function displayedValue(card){
    if(state.instrument!=='guitar'||!state.capo||!state.transpose)return card.value;
    return card.type==='chord'?transposeChord(card.value,state.capo):transposeRoot(card.value,state.capo);
  }
  function shapeValue(card){
    if(state.instrument!=='guitar'||!state.capo||state.transpose)return card.value;
    return card.type==='chord'?transposeChord(card.value,-state.capo):transposeRoot(card.value,-state.capo);
  }

  const LONG_SUSTAIN_SOUNDS=new Set(['acoustic_grand_piano','bright_acoustic_piano','electric_grand_piano','electric_piano_1','electric_piano_2','acoustic_guitar_steel','acoustic_guitar_nylon','pad_2_warm','pad_3_polysynth','synth_strings_1','drawbar_organ']);
  function sustainedNoteSeconds(stepSeconds,sound=state.sound){
    const seconds=Math.max(.05,Number(stepSeconds)||.05);
    return LONG_SUSTAIN_SOUNDS.has(sound)?Math.max(.78,seconds*1.38+.18):Math.max(.45,seconds*1.08);
  }

  // One audio clock for the suite. Everything that makes sound (chords here, drums in
  // beat-maker.js, Baby DAW parts when parts.js opts in) connects to CRPAudio.master(),
  // which runs through a peak limiter and a gentle safety clip before the speakers.
  const CRPAudio=(()=>{
    let ctx=null,input=null;
    function context(){
      if(!ctx)ctx=new (window.AudioContext||window.webkitAudioContext)();
      if(ctx.state==='suspended')ctx.resume().catch(()=>{});
      return ctx;
    }
    function safetyClipCurve(){
      // Unity gain up to 0.8, then a smooth knee that never exceeds full scale.
      const n=2048,curve=new Float32Array(n);
      for(let i=0;i<n;i++){const x=i/(n-1)*2-1,a=Math.abs(x);curve[i]=Math.sign(x)*(a<=.8?a:.8+.2*Math.tanh((a-.8)/.2));}
      return curve;
    }
    function master(){
      if(input)return input;
      const c=context();
      input=c.createGain();
      const limiter=c.createDynamicsCompressor();
      limiter.threshold.value=-3;limiter.knee.value=0;limiter.ratio.value=20;limiter.attack.value=.003;limiter.release.value=.12;
      const clip=c.createWaveShaper();clip.curve=safetyClipCurve();clip.oversample='2x';
      input.connect(limiter);limiter.connect(clip);clip.connect(c.destination);
      return input;
    }
    return {context,master};
  })();
  window.CRPAudio=CRPAudio;

  function instrumentOutputGain(){return soundOutputGain(state.sound);}
  function ensureInstrumentBus(){
    if(state.instrumentBus&&state.instrumentFxChain)return;
    const bus=state.audioCtx.createGain();
    const fx=createInstrumentFxChain(state.audioCtx,CRPAudio.master());bus.connect(fx.input);
    state.instrumentBus=bus;state.instrumentFxChain=fx;
  }
  function ensureAudio(){
    state.audioCtx=CRPAudio.context();
    ensureInstrumentBus();
    state.instrumentFxChain?.setSound(state.sound);
    const now=state.audioCtx.currentTime,target=instrumentOutputGain();
    try{if(typeof state.instrumentBus.gain.cancelAndHoldAtTime==='function')state.instrumentBus.gain.cancelAndHoldAtTime(now);else state.instrumentBus.gain.cancelScheduledValues(now);state.instrumentBus.gain.setTargetAtTime(target,now,.018);}catch{state.instrumentBus.gain.value=target;}
    if(state.player&&state.playerName===state.sound)return Promise.resolve(state.player);
    if(!window.Soundfont)return Promise.reject(new Error('Sound engine unavailable'));
    $('status').textContent='Loading instrument samples…';
    return loadSoundfontInstrument(state.audioCtx,state.sound,state.instrumentBus).then(p=>{state.player=p;state.playerName=state.sound;$('status').textContent='';return p;}).catch(err=>{$('status').textContent='Could not load that instrument.';throw err;});
  }
  function automaticMidiNotesForCard(card){
    const val=displayedValue(card);let notes;
    if(card.type==='note'){
      const oct=(state.instrument==='guitar'?3:4)+state.octave;
      notes=[midiOf(val+oct)].filter(x=>x!=null);
    }else if(state.instrument==='guitar'){
      const frets=guitarShapeForCard(card),opens=[40,45,50,55,59,64];
      notes=frets.map((f,i)=>f==null?null:opens[i]+f+state.capo+state.octave*12).filter(x=>x!=null);
      if(!notes.length)notes=chordNotes(val,3+state.octave).map(midiOf).filter(x=>x!=null);
      // Slash chord: the guitar plays the base shape with the bass note underneath.
      const bass=parseChord(val)?.bass;
      if(bass&&notes.length){const low=Math.min(...notes),drop=(low-NOTE_INDEX[bass]+120)%12;if(drop)notes.push(low-drop);}
    }else notes=pianoMidisForCard(card);
    if(isBassSound(state.sound))notes=notes.slice(0,card.type==='note'?1:3).map(m=>m-12);
    return [...new Set(notes.map(Number).filter(Number.isFinite))].sort((a,b)=>a-b);
  }
  function midiNotesForCard(card){
    // Once the user edits a MIDI column, the exact note numbers become the
    // playback source for that card. Until then the table remains truly
    // auto-filled from the chord/note, instrument, capo and step settings.
    if(Array.isArray(card?.midiNotes))return [...new Set(card.midiNotes.map(Number).filter(Number.isFinite))].sort((a,b)=>a-b);
    return automaticMidiNotesForCard(card);
  }
  async function auditionMidiNote(midi){
    try{const p=await ensureAudio(),now=state.audioCtx.currentTime;p.play(noteAtMidi(midi),now,{duration:.55,gain:.9});}catch(_){ }
  }
  async function playCard(card,seconds=1.5){
    const p=await ensureAudio(),notes=midiNotesForCard(card).map(noteAtMidi);
    // Keep note gain near unity; overall instrument loudness is handled by
    // the normalized instrument bus above, followed by a peak limiter.
    const now=state.audioCtx.currentTime;notes.forEach((n,i)=>p.play(n,now+(state.instrument==='guitar'?i*.035:0),{duration:seconds,gain:.95}));
  }
  function setRiderBonesRiding(on){['riderBonesLeft','riderBonesRight'].forEach(id=>{const img=$(id);if(img)img.src=on?img.dataset.animated:img.dataset.still;});}

  function pianoSvg(card){
    const val=displayedValue(card),mids=pianoMidisForCard(card),targets=new Set(mids);
    const names=card.type==='chord'?chordToneNames(val):new Map([[NOTE_INDEX[val],val]]),label=m=>names.get(((m%12)+12)%12)||NOTES[((m%12)+12)%12];
    let start=Math.min(...mids)-2,end=Math.max(...mids)+3;const black=m=>NOTES[(m%12+12)%12].includes('#');
    while(black(start))start--;while(black(end-1))end++;while(end-start<10){start--;if(black(start))start--;if(end-start>=10)break;end++;if(black(end-1))end++;}
    const whites=[];for(let m=start;m<end;m++)if(!black(m))whites.push(m);
    const ww=46,w=whites.length*ww,h=164,xmap=new Map();let ws='',bs='';
    whites.forEach((m,i)=>{const x=i*ww,pc=label(m),hit=targets.has(m);xmap.set(m,x);ws+=`<rect x="${x}" y="18" width="${ww}" height="132" rx="2" fill="${hit?'#e9c46a':'#f6f2e7'}" stroke="#171717" stroke-width="2"/>`;if(hit)ws+=`<text x="${x+ww/2}" y="136" text-anchor="middle" font-size="16" font-weight="800" fill="#161616">${pc}</text>`;});
    for(let m=start;m<end;m++){if(!black(m))continue;const px=xmap.get(m-1);if(px==null)continue;const hit=targets.has(m),pc=label(m),bx=px+ww-14;bs+=`<rect x="${bx}" y="18" width="28" height="82" rx="2" fill="${hit?'#f4a261':'#1a1a1a'}" stroke="#080808" stroke-width="1.5"/>`;if(hit)bs+=`<text x="${bx+14}" y="78" text-anchor="middle" font-size="11" font-weight="800" fill="#fff">${pc}</text>`;}
    return `<svg viewBox="0 0 ${w} ${h}"><text x="4" y="12" fill="#9aa3ad" font-size="11">Octave ${state.octave>0?'+':''}${state.octave}</text>${ws}${bs}</svg>`;
  }

  function chordCoreIntervals(c){
    const q=c.quality;
    if(q==='5')return[0,7,7];
    if(q==='dim'||q==='dim7'||q==='m7b5')return[0,3,6];
    if(q==='aug'||q==='7#5')return[0,4,8];
    if(q==='7b5')return[0,4,6];
    if(q==='sus2'||q==='7sus2')return[0,2,7];
    if(q==='sus4'||q==='7sus4')return[0,5,7];
    return q.startsWith('m')&&!q.startsWith('maj')?[0,3,7]:[0,4,7];
  }
  function seventhInterval(c){
    if(['7','9','m7','m9','m7b5','7sus2','7sus4','7b5','7#5','7b9','7#9'].includes(c.quality))return 10;
    if(['maj7','maj9','mMaj7','maj7#11'].includes(c.quality))return 11;
    if(c.quality==='dim7')return 9;
    return null;
  }
  function extensionInterval(c){
    if(['9','maj9','m9','add9','madd9'].includes(c.quality))return 2;
    if(c.quality==='7b9')return 1;
    if(c.quality==='7#9')return 3;
    if(['add11','madd11'].includes(c.quality))return 5;
    if(c.quality==='maj7#11')return 6;
    if(['6','m6'].includes(c.quality))return 9;
    return null;
  }
  function fretCandidates(stringMidi,pc,maxFret=15){
    const out=[];for(let f=0;f<=maxFret;f++)if((stringMidi+f)%12===pc)out.push(f);return out;
  }
  function permutations(a){
    if(a.length<=1)return[a.slice()];const out=[];
    a.forEach((v,i)=>permutations(a.slice(0,i).concat(a.slice(i+1))).forEach(p=>out.push([v,...p])));return out;
  }
  function compactVoicing(pcs,strings,inversionPc=null){
    const opens=[40,45,50,55,59,64],choices=[];
    permutations(pcs).forEach(order=>{
      const lists=order.map((pc,i)=>fretCandidates(opens[strings[i]],pc));
      const walk=(i,frets)=>{if(i===lists.length){
        const abs=frets.map((f,j)=>opens[strings[j]]+f),min=Math.min(...frets),max=Math.max(...frets),span=max-min;
        const lowestPc=abs[abs.indexOf(Math.min(...abs))]%12;
        let score=span*7+frets.reduce((a,b)=>a+b,0)/frets.length+(max>12?6:0)+(min===0?-.5:0);
        if(inversionPc!=null&&lowestPc!==inversionPc)score+=35;
        choices.push({frets,score});return;
      };
      lists[i].forEach(f=>walk(i+1,[...frets,f]));};walk(0,[]);
    });
    if(!choices.length)return null;choices.sort((a,b)=>a.score-b.score);const full=Array(6).fill(null);choices[0].frets.forEach((f,i)=>full[strings[i]]=f);return full;
  }
  function generatedChordShape(name){
    const c=parseChord(name);if(!c)return[null,null,null,null,null,null];
    const root=NOTE_INDEX[c.root];
    const pcs=[...new Set(QUALITY[c.quality].map(iv=>(root+iv)%12))];
    const stringSets=pcs.length>=5?[[1,2,3,4,5],[0,1,2,3,4]]:pcs.length===4?[[2,3,4,5],[1,2,3,4],[0,1,2,3]]:[[3,4,5],[2,3,4],[1,2,3]];
    for(const strings of stringSets){
      const shape=compactVoicing(pcs,strings,root);
      if(shape)return shape;
    }
    return[null,null,null,null,null,null];
  }
  function barreShape(name){
    const c=parseChord(name);if(!c)return[null,null,null,null,null,null];
    const f=(NOTE_INDEX[c.root]-NOTE_INDEX.E+12)%12,q=c.quality;
    if(q==='m'||q==='m7')return q==='m7'?[f,f+2,f,f,f,f]:[f,f+2,f+2,f,f,f];
    if(q==='7')return[f,f+2,f,f+1,f,f];
    if(q==='maj7')return[f,f+2,f+1,f+1,f,f];
    if(q==='sus4')return[f,f+2,f+2,f+2,f,f];
    if(q==='')return[f,f+2,f+2,f+1,f,f];
    // Special qualities (sus2, diminished, augmented, half-diminished, add9,
    // etc.) must not fall through to a major chord shape. Generate a voicing
    // from the actual chord pitch classes instead.
    return generatedChordShape(name);
  }
  function powerShape(name){
    const c=parseChord(name);if(!c)return[null,null,null,null,null,null];
    const e=(NOTE_INDEX[c.root]-NOTE_INDEX.E+12)%12;
    if(e<=8)return[e,e+2,e+2,null,null,null];
    const a=(NOTE_INDEX[c.root]-NOTE_INDEX.A+12)%12;
    return[null,a,a+2,a+2,null,null];
  }
  function triadShape(name,inversion=false){
    const c=parseChord(name);if(!c)return[null,null,null,null,null,null];
    const pcs=chordCoreIntervals(c).map(i=>(NOTE_INDEX[c.root]+i)%12),inv=inversion?pcs[1]:pcs[0];
    return compactVoicing(pcs,[3,4,5],inv)||compactVoicing(pcs,[2,3,4],inv)||barreShape(name);
  }
  function shellShape(name){
    const c=parseChord(name);if(!c)return[null,null,null,null,null,null];const root=NOTE_INDEX[c.root],core=chordCoreIntervals(c),sev=seventhInterval(c);
    const ints=sev==null?[0,core[1],core[2]]:[0,core[1],sev],pcs=ints.map(i=>(root+i)%12);
    return compactVoicing(pcs,[2,3,4],pcs[0])||compactVoicing(pcs,[1,2,3],pcs[0])||triadShape(name,false);
  }
  function colorShape(name){
    const c=parseChord(name);if(!c)return[null,null,null,null,null,null];const root=NOTE_INDEX[c.root],core=chordCoreIntervals(c),sev=seventhInterval(c),ext=extensionInterval(c);
    let ints;
    if(ext!=null)ints=[0,core[1],sev==null?core[2]:sev,ext];
    else if(sev!=null)ints=[0,core[1],core[2],sev];
    else if(c.quality==='sus2'||c.quality==='sus4')ints=[0,core[1],core[2],12+core[1]];
    else ints=[0,core[1],core[2],14];
    const pcs=ints.map(i=>(root+i)%12);return compactVoicing(pcs,[2,3,4,5],pcs[0])||barreShape(name);
  }
  function genericGuitarShape(name){
    if(GUITAR_SHAPES[name])return GUITAR_SHAPES[name].slice();
    return barreShape(name);
  }
  // Slash chords show the diagram of their base chord; the bass note is named in the subtitle.
  function guitarShapeForName(name){
    name=baseChordName(name);
    switch(state.neck){
      case'triad':return triadShape(name,false);
      case'barre':return barreShape(name);
      case'power':return powerShape(name);
      case'shell':return shellShape(name);
      case'inversion':return triadShape(name,true);
      case'color':return colorShape(name);
      default:return genericGuitarShape(name);
    }
  }
  function guitarShapeForCard(card){
    if(card.type==='note'){const p=guitarNotePosition(shapeValue(card)),a=Array(6).fill(null);if(p)a[p.s]=p.f;return a;}
    return guitarShapeForName(shapeValue(card));
  }
  function guitarNotePosition(note){const target=NOTE_INDEX[note],opens=[40,45,50,55,59,64];let best=null;for(let s=0;s<6;s++)for(let f=0;f<=12;f++)if((opens[s]+f)%12===target){const score=f+(s<2?0:2);if(!best||score<best.score)best={s,f,score};}return best;}
  function guitarSvg(card){
    const shape=shapeValue(card),shown=displayedValue(card),W=360,H=245,L=55,T=36,sg=48,fg=35,nf=5,tuning=['E','A','D','G','B','E'];let frets,start=1;
    if(card.type==='note'){const p=guitarNotePosition(shape);start=Math.max(1,p?.f>4?p.f-1:1);frets=Array(6).fill(null);if(p)frets[p.s]=p.f;}
    else{frets=guitarShapeForName(shape);const pos=frets.filter(f=>f>0);start=frets.includes(0)?1:(pos.length?Math.max(1,Math.min(...pos)):1);}
    const toneNames=card.type==='chord'?chordToneNames(shown):null;
    let svg=`<svg viewBox="0 0 ${W} ${H}"><text x="10" y="18" fill="#9aa3ad" font-size="12">${state.capo?`Capo ${state.capo}${state.transpose?' • transpose view':''}`:`Fret ${start}`}</text>`;
    for(let s=0;s<6;s++){const x=L+s*sg;svg+=`<line x1="${x}" y1="${T}" x2="${x}" y2="${T+nf*fg}" stroke="#d8dde4" stroke-width="${1+s*.12}"/><text x="${x}" y="${T+nf*fg+24}" text-anchor="middle" fill="#8f99a5" font-size="12">${tuning[s]}</text>`;}
    for(let f=0;f<=nf;f++){const y=T+f*fg;svg+=`<line x1="${L}" y1="${y}" x2="${L+5*sg}" y2="${y}" stroke="${f===0?'#f3f4f6':'#737d89'}" stroke-width="${f===0?4:1.4}"/>`;}
    frets.forEach((f,s)=>{const x=L+s*sg;if(f==null){if(card.type==='chord')svg+=`<text x="${x}" y="29" text-anchor="middle" fill="#e76f51" font-size="15">×</text>`;return;}if(f===0){svg+=`<circle cx="${x}" cy="24" r="8" fill="none" stroke="#e9c46a" stroke-width="2"/>`;return;}let rel=f-start;if(rel<0||rel>=nf)rel=Math.max(0,Math.min(nf-1,f%nf));const y=T+(rel+.5)*fg,pc=card.type==='note'?shown:(toneNames.get(([40,45,50,55,59,64][s]+f)%12)||NOTES[([40,45,50,55,59,64][s]+f)%12]);svg+=`<circle cx="${x}" cy="${y}" r="14" fill="#e9c46a" stroke="#201b0e" stroke-width="2"/><text x="${x}" y="${y+4.5}" text-anchor="middle" fill="#16120a" font-size="11" font-weight="900">${pc}</text>`;});
    return svg+'</svg>';
  }

  function subtitle(card){
    if(state.instrument!=='guitar')return'';
    const labels={open:'Open / Easy',triad:'Triad',barre:'Barre Chord',power:'Power Chord',shell:'Shell Voicing',inversion:'1st Inversion',color:'Color / Extended'};
    const shape=shapeValue(card),sound=displayedValue(card),kind=card.type==='chord'?labels[state.neck]||labels.open:'';
    const bass=card.type==='chord'?parseChord(sound)?.bass:null,bassText=bass?`bass note ${bass}`:'';
    if(!state.capo)return [kind,bassText].filter(Boolean).join(' • ');
    const capoText=state.transpose?`${card.value} shape → sounds ${sound}`:(shape===card.value?`Capo ${state.capo}`:`Play ${shape} shape → sounds ${card.value}`);
    return [kind,bassText,capoText].filter(Boolean).join(' • ');
  }

  function isMidiRollActive(){return state.cardView==='midi'&&document.body.classList.contains('workspace-chord-rider');}
  function isMobileCarousel(){return window.matchMedia('(max-width:700px)').matches&&!isMidiRollActive();}
  function realCarouselLines(){return [...document.querySelectorAll('#progression .progression-line:not(.carousel-clone)')];}
  function lineScrollLeft(wrap,line){
    const wr=wrap.getBoundingClientRect(),lr=line.getBoundingClientRect();
    return wrap.scrollLeft+(lr.left-wr.left);
  }
  function updateMobileLineIndicator(ri=state.selectedRow){
    const el=$('mobileLineIndicator');if(!el)return;
    if(!isMobileCarousel()){el.hidden=true;return;}
    el.hidden=false;
    const total=Math.max(1,state.rows.length),n=Math.max(0,Math.min(total-1,ri));
    el.textContent=`Line ${n+1} / ${total}`;
  }
  function setCarouselSelectedRow(ri){
    ri=Math.max(0,Math.min(state.rows.length-1,+ri||0));
    if(state.selectedRow!==ri){state.selectedRow=ri;syncBuildInput();renderFits();}
    realCarouselLines().forEach(el=>el.classList.toggle('selected',+el.dataset.row===ri));
    updateMobileLineIndicator(ri);
  }
  function scrollMobileLineTo(ri,smooth=true){
    if(!isMobileCarousel())return;
    const wrap=$('progression');if(!wrap)return;
    const line=wrap.querySelector(`.progression-line:not(.carousel-clone)[data-row="${ri}"]`);if(!line)return;
    wrap.scrollTo({left:lineScrollLeft(wrap,line),behavior:smooth?'smooth':'auto'});
    updateMobileLineIndicator(ri);
  }
  function applyProgressionEditLock(){
    const wrap=$('progression');if(!wrap)return;
    wrap.classList.toggle('edit-locked',state.autoScroll);
    wrap.querySelectorAll('.progression-line:not(.carousel-clone) .chord-card').forEach(el=>el.draggable=!state.autoScroll);
  }
  function setupMobileCarousel(wrap){
    const indicator=$('mobileLineIndicator');
    if(!isMobileCarousel()){
      if(indicator)indicator.hidden=true;
      wrap.classList.remove('mobile-carousel');
      return;
    }
    wrap.classList.add('mobile-carousel');
    const real=[...wrap.querySelectorAll(':scope > .progression-line')];
    if(!real.length){updateMobileLineIndicator(0);return;}

    // DOM-only edge clones create the infinite feel without duplicating project data.
    if(real.length>1){
      const lead=real[real.length-1].cloneNode(true),tail=real[0].cloneNode(true);
      lead.classList.add('carousel-clone');tail.classList.add('carousel-clone');
      lead.dataset.cloneTarget=String(real.length-1);tail.dataset.cloneTarget='0';
      lead.setAttribute('aria-hidden','true');tail.setAttribute('aria-hidden','true');
      wrap.prepend(lead);wrap.append(tail);
    }

    requestAnimationFrame(()=>scrollMobileLineTo(state.selectedRow,false));
    updateMobileLineIndicator(state.selectedRow);
  }
  // The carousel's scroll/touch listeners live on the #progression container, which
  // survives re-renders, so they are attached once (renderRows only rebuilds lines).
  let carouselSettleTimer=null,carouselTeleporting=false;
  function instantCarouselJump(wrap,target){
    if(!target)return;
    carouselTeleporting=true;
    const oldBehavior=wrap.style.scrollBehavior,oldSnap=wrap.style.scrollSnapType;
    // The edge clone and its real line look identical. Temporarily disabling
    // smooth scrolling + snapping makes the wrap-around jump invisible.
    wrap.style.scrollBehavior='auto';
    wrap.style.scrollSnapType='none';
    wrap.scrollLeft=lineScrollLeft(wrap,target);
    void wrap.offsetWidth;
    requestAnimationFrame(()=>{
      wrap.style.scrollBehavior=oldBehavior;
      wrap.style.scrollSnapType=oldSnap;
      requestAnimationFrame(()=>{carouselTeleporting=false;});
    });
  }
  function settleCarousel(wrap){
    if(carouselTeleporting||!wrap.classList.contains('mobile-carousel'))return;
    const items=[...wrap.querySelectorAll(':scope > .progression-line')];if(!items.length)return;
    const wr=wrap.getBoundingClientRect(),cx=wr.left+wr.width/2;
    let nearest=items[0],dist=Infinity;
    items.forEach(el=>{const r=el.getBoundingClientRect(),d=Math.abs((r.left+r.width/2)-cx);if(d<dist){dist=d;nearest=el;}});
    if(nearest.classList.contains('carousel-clone')){
      const ri=+nearest.dataset.cloneTarget||0;
      instantCarouselJump(wrap,wrap.querySelector(`.progression-line:not(.carousel-clone)[data-row="${ri}"]`));
      setCarouselSelectedRow(ri);
    }else setCarouselSelectedRow(+nearest.dataset.row||0);
  }
  function initCarouselListeners(){
    const wrap=$('progression');if(!wrap)return;
    wrap.addEventListener('scroll',()=>{
      if(carouselTeleporting||!wrap.classList.contains('mobile-carousel'))return;
      clearTimeout(carouselSettleTimer);carouselSettleTimer=setTimeout(()=>settleCarousel(wrap),90);
    },{passive:true});
    // A deliberate horizontal swipe takes control away from playback-follow mode.
    let tx=null,ty=null;
    wrap.addEventListener('touchstart',e=>{if(!e.touches?.length||!wrap.classList.contains('mobile-carousel'))return;tx=e.touches[0].clientX;ty=e.touches[0].clientY;},{passive:true});
    wrap.addEventListener('touchmove',e=>{
      if(tx==null||!e.touches?.length)return;
      const dx=e.touches[0].clientX-tx,dy=e.touches[0].clientY-ty;
      if(Math.abs(dx)>12&&Math.abs(dx)>Math.abs(dy)){tx=ty=null;if(state.autoScroll)disableAutoScrollForManualScroll();}
    },{passive:true});
    wrap.addEventListener('touchend',()=>{tx=ty=null;},{passive:true});
  }

  function moveDragged(toRow,toIndex){
    if(state.autoScroll){state.drag=null;$('status').textContent='Turn Auto Scroll off to reorder cards.';return;}
    if(!state.drag)return;const {row:fr,index:fi}=state.drag,card=state.rows[fr][fi];if(!card)return;
    recordUndo();state.rows[fr].splice(fi,1);if(fr===toRow&&fi<toIndex)toIndex--;state.rows[toRow].splice(Math.max(0,toIndex),0,card);state.selectedRow=toRow;state.drag=null;$('status').textContent='';renderRows();syncBuildInput();scheduleAutoSave();
  }
  function clearLineDropMarkers(){
    document.querySelectorAll('.progression-line').forEach(el=>el.classList.remove('line-moving','line-drop-before','line-drop-after'));
  }
  function moveWholeLine(from,insertionIndex){
    if(from<0||from>=state.rows.length)return;
    insertionIndex=Math.max(0,Math.min(state.rows.length,insertionIndex));
    const selected=state.rows[state.selectedRow];
    recordUndo();
    const [moved]=state.rows.splice(from,1);
    if(from<insertionIndex)insertionIndex--;
    insertionIndex=Math.max(0,Math.min(state.rows.length,insertionIndex));
    state.rows.splice(insertionIndex,0,moved);
    state.selectedRow=Math.max(0,state.rows.indexOf(selected));
    state.lineDrag=null;
    clearLineDropMarkers();
    $('status').textContent='Line moved.';
    renderRows();syncBuildInput();renderFits();scheduleAutoSave();
  }
  function midiRollRange(row){
    const notes=row.flatMap(card=>midiNotesForCard(card));
    if(!notes.length){const base=(4+state.octave+1)*12;return{low:base,high:base+11};}
    let low=Math.min(...notes)-2,high=Math.max(...notes)+2;
    // Give the table at least one complete octave of room for editing, but
    // avoid an excessively tall roll for normal chord voicings.
    while(high-low<11){low--;high++;}
    if(high-low>27){const mid=Math.round((low+high)/2);low=mid-13;high=mid+14;}
    low=Math.max(24,low);high=Math.min(108,high);
    return{low,high};
  }
  function midiColumnScrollIntoView(ri,ci,smooth=true){
    const line=document.querySelector(`.progression-line:not(.carousel-clone)[data-row="${ri}"]`);
    const wrap=line?.querySelector('.crp-midi-roll-wrap');
    const head=wrap?.querySelector(`.crp-midi-step[data-card-index="${ci}"]`);
    if(!wrap||!head)return;
    const sticky=64,target=head.offsetLeft-sticky-(wrap.clientWidth-head.offsetWidth-sticky)/2;
    wrap.scrollTo({left:Math.max(0,target),behavior:smooth?'smooth':'auto'});
  }
  function clearPlaybackHighlights(){
    document.querySelectorAll('.chord-card').forEach(c=>c.style.outline='');
    document.querySelectorAll('.crp-midi-step.playing,.crp-midi-cell.playing').forEach(el=>el.classList.remove('playing'));
  }
  function highlightMidiColumn(ri,ci){
    clearPlaybackHighlights();
    const line=document.querySelector(`.progression-line:not(.carousel-clone)[data-row="${ri}"]`);
    line?.querySelector(`.crp-midi-step[data-card-index="${ci}"]`)?.classList.add('playing');
    line?.querySelectorAll(`.crp-midi-cell[data-card-index="${ci}"]`).forEach(el=>el.classList.add('playing'));
  }
  function restoreMidiScroll(ri,left,top=0){
    requestAnimationFrame(()=>{const w=document.querySelector(`.progression-line:not(.carousel-clone)[data-row="${ri}"] .crp-midi-roll-wrap`);if(w){w.scrollLeft=left;w.scrollTop=top;}});
  }
  function formatBeatDuration(beats){
    const n=Math.round(Number(beats||0)*4)/4;
    return Number.isInteger(n)?String(n):String(n).replace(/0+$/,'').replace(/\.$/,'');
  }
  function midiGridColumns(row){
    return `64px ${row.map(card=>`${cardColumnWidth(card)}px`).join(' ')}`;
  }
  function bindMidiDurationDrag(handle,{card,row,ri,ci,grid,wrap,label}){
    handle.addEventListener('pointerdown',e=>{
      if(e.button!=null&&e.button!==0)return;
      e.preventDefault();e.stopPropagation();
      state.selectedRow=ri;syncBuildInput();
      const pointerId=e.pointerId,startX=e.clientX,startDur=cardDurationBeats(card);
      // Track only scroll movement that WE deliberately cause while the pointer is
      // parked at an edge. The final MIDI column changes the roll's total width as
      // it is resized, so the browser can clamp wrap.scrollLeft on its own. Feeding
      // that clamp back into the duration calculation made the last chord/note race
      // through beats while every earlier column felt normal.
      let dragScrollDelta=0;
      let moved=false,lastDur=startDur,autoRaf=0,lastClientX=e.clientX;
      handle.classList.add('dragging');
      try{handle.setPointerCapture?.(pointerId);}catch(_){ }
      const apply=clientX=>{
        lastClientX=clientX;
        const dx=clientX-startX+dragScrollDelta;
        const next=Math.max(.25,Math.min(64,Math.round((startDur+dx/MIDI_BEAT_PX)*4)/4));
        if(next===lastDur)return;
        if(!moved)recordUndo();
        moved=true;lastDur=next;setCardDurationBeats(card,next);
        reflowMidiTimingFrom();
        grid.style.gridTemplateColumns=midiGridColumns(row);
        label.textContent=`${formatBeatDuration(next)}b`;
        label.title=`${formatBeatDuration(next)} beats`;
        $('status').textContent=`${displayedValue(card)} duration: ${formatBeatDuration(next)} beat${next===1?'':'s'}`;
      };
      // v3.3.5: phone precision pass. Wider beat spacing above handles normal finger
      // movement; edge-scroll is intentionally very slow and slightly slower while
      // shrinking left, which was the direction most likely to overshoot.
      let autoLastTs=0;
      const autoScroll=ts=>{
        autoRaf=0;
        const r=wrap.getBoundingClientRect();
        const edgeRight=52,edgeLeft=96;
        let direction=0,depth=0;
        if(lastClientX>r.right-edgeRight){direction=1;depth=Math.min(1,Math.max(0,(lastClientX-(r.right-edgeRight))/edgeRight));}
        else if(lastClientX<r.left+edgeLeft){direction=-1;depth=Math.min(1,Math.max(0,((r.left+edgeLeft)-lastClientX)/edgeLeft));}
        if(direction){
          const dt=autoLastTs?Math.min(40,Math.max(8,ts-autoLastTs)):16.67;
          const minSpeed=direction<0?7:10;
          const maxExtra=direction<0?13:16;
          const pxPerSecond=minSpeed+(maxExtra*depth);
          const before=wrap.scrollLeft;
          wrap.scrollLeft=Math.max(0,Math.min(wrap.scrollWidth-wrap.clientWidth,before+direction*pxPerSecond*(dt/1000)));
          const deliberateDelta=wrap.scrollLeft-before;
          if(Math.abs(deliberateDelta)>.01){dragScrollDelta+=deliberateDelta;apply(lastClientX);}
          autoLastTs=ts;
          autoRaf=requestAnimationFrame(autoScroll);
        }else autoLastTs=0;
      };
      const onMove=ev=>{
        if(ev.pointerId!==pointerId)return;
        ev.preventDefault();lastClientX=ev.clientX;apply(ev.clientX);
        if(!autoRaf){autoLastTs=0;autoRaf=requestAnimationFrame(autoScroll);}
      };
      const finish=ev=>{
        if(ev.pointerId!==pointerId)return;
        ev.preventDefault();ev.stopPropagation();
        document.removeEventListener('pointermove',onMove,true);document.removeEventListener('pointerup',finish,true);document.removeEventListener('pointercancel',finish,true);
        if(autoRaf)cancelAnimationFrame(autoRaf);handle.classList.remove('dragging');
        try{handle.releasePointerCapture?.(pointerId);}catch(_){ }
        if(moved){
          // Push the reflowed starts into the loaded Baby DAW chord part before a
          // user can immediately press Play or Save. Playback and persistence now
          // consume the exact same post-resize timeline.
          // A MIDI duration edit is a full timeline edit, not just a visual card
          // change. Force the canonical sequence into Baby DAW immediately so a
          // second resize cannot replay the first resize's cached absolute starts.
          if(!window.CRPParts?.syncMidiTimelineFromCore?.())window.CRPParts?.syncCoreLive?.();
          scheduleAutoSave();
          $('status').textContent=`${displayedValue(card)} set to ${formatBeatDuration(cardDurationBeats(card))} beat${cardDurationBeats(card)===1?'':'s'}.`;
        }
      };
      document.addEventListener('pointermove',onMove,{capture:true,passive:false});
      document.addEventListener('pointerup',finish,{capture:true,passive:false});
      document.addEventListener('pointercancel',finish,{capture:true,passive:false});
    });
    handle.onclick=e=>{e.preventDefault();e.stopPropagation();};
  }
  function renderMidiRoll(line,row,ri){
    line.classList.add('midi-roll-line');
    if(!row.length){const empty=document.createElement('div');empty.className='empty-line';empty.textContent='Empty line — type or tap a chord/note to auto-fill the MIDI table';line.appendChild(empty);return;}
    const shell=document.createElement('div');shell.className='crp-midi-roll-shell';
    const hint=document.createElement('div');hint.className='crp-midi-roll-hint';hint.textContent='Tap cells to edit notes • drag the gold right edge to stretch a chord/note • swipe sideways through the timeline';shell.appendChild(hint);
    const wrap=document.createElement('div');wrap.className='crp-midi-roll-wrap';
    const grid=document.createElement('div');grid.className='crp-midi-roll';grid.style.gridTemplateColumns=midiGridColumns(row);grid.style.setProperty('--midi-beat-px',`${MIDI_BEAT_PX}px`);
    const corner=document.createElement('div');corner.className='crp-midi-corner';corner.textContent='Note';grid.appendChild(corner);
    row.forEach((card,ci)=>{
      const head=document.createElement('div');head.className='crp-midi-step';head.dataset.cardIndex=String(ci);head.title='Tap name to audition • drag gold edge to change duration';
      const top=document.createElement('div');top.className='crp-midi-step-top';
      const name=document.createElement('button');name.type='button';name.className='crp-midi-step-name';name.textContent=displayedValue(card);name.onclick=e=>{e.stopPropagation();state.selectedRow=ri;syncBuildInput();const bpm=Math.max(40,Math.min(240,+$('bpmInput').value||92)),secs=60/bpm*cardDurationBeats(card);playCard(card,state.sustain?sustainedNoteSeconds(secs,state.sound):Math.max(.35,secs*.92));};
      const dur=document.createElement('span');dur.className='crp-midi-duration-label';dur.textContent=`${formatBeatDuration(cardDurationBeats(card))}b`;dur.title=`${formatBeatDuration(cardDurationBeats(card))} beats`;
      top.append(name,dur);
      const actions=document.createElement('span');actions.className='crp-midi-step-actions';
      const repeat=document.createElement('button');repeat.type='button';repeat.className='crp-midi-repeat';repeat.textContent='⧉';repeat.title='Repeat this chord/note';repeat.onclick=e=>{e.stopPropagation();recordUndo();const left=wrap.scrollLeft,copy=JSON.parse(JSON.stringify(card));row.splice(ci+1,0,copy);renderRows();syncBuildInput();renderFits();restoreMidiScroll(ri,left+Math.min(cardColumnWidth(card),90),wrap.scrollTop);scheduleAutoSave();$('status').textContent=`${displayedValue(card)} repeated.`;};
      const reset=document.createElement('button');reset.type='button';reset.className='crp-midi-reset';reset.textContent='↺';reset.title='Reset the MIDI notes to the automatic chord/note fill';reset.hidden=!Array.isArray(card.midiNotes);reset.onclick=e=>{e.stopPropagation();recordUndo();const left=wrap.scrollLeft,top=wrap.scrollTop;delete card.midiNotes;renderRows();restoreMidiScroll(ri,left,top);scheduleAutoSave();$('status').textContent=`${displayedValue(card)} MIDI notes reset to automatic.`;};
      const remove=document.createElement('button');remove.type='button';remove.className='crp-midi-remove';remove.textContent='×';remove.title='Remove chord/note';remove.onclick=e=>{e.stopPropagation();recordUndo();const left=wrap.scrollLeft,top=wrap.scrollTop;row.splice(ci,1);renderRows();restoreMidiScroll(ri,left,top);syncBuildInput();renderFits();scheduleAutoSave();};
      actions.append(repeat,reset,remove);head.append(top,actions);
      const drag=document.createElement('span');drag.className='crp-midi-duration-handle';drag.title='Drag to change chord/note duration';drag.setAttribute('aria-label','Drag duration');head.appendChild(drag);
      bindMidiDurationDrag(drag,{card,row,ri,ci,grid,wrap,label:dur});
      grid.appendChild(head);
    });
    const {low,high}=midiRollRange(row);
    const onByCard=row.map(card=>new Set(midiNotesForCard(card)));
    for(let midi=high;midi>=low;midi--){
      const label=document.createElement('div');label.className='crp-midi-note'+(NOTES[(midi%12+12)%12].includes('#')?' black-key':'');label.textContent=noteAtMidi(midi);grid.appendChild(label);
      row.forEach((card,ci)=>{
        const cell=document.createElement('button');cell.type='button';cell.className='crp-midi-cell'+(NOTES[(midi%12+12)%12].includes('#')?' black-key':'')+(onByCard[ci].has(midi)?' on':'');cell.dataset.cardIndex=String(ci);cell.dataset.midi=String(midi);cell.title=`${noteAtMidi(midi)} • ${displayedValue(card)} • ${formatBeatDuration(cardDurationBeats(card))} beats`;
        cell.onclick=e=>{e.stopPropagation();recordUndo();state.selectedRow=ri;syncBuildInput();const notes=new Set(midiNotesForCard(card));if(notes.has(midi))notes.delete(midi);else notes.add(midi);card.midiNotes=[...notes].sort((a,b)=>a-b);cell.classList.toggle('on',notes.has(midi));const head=grid.querySelector(`.crp-midi-step[data-card-index="${ci}"]`),reset=head?.querySelector('.crp-midi-reset');if(reset)reset.hidden=false;auditionMidiNote(midi);scheduleAutoSave();};
        grid.appendChild(cell);
      });
    }
    wrap.appendChild(grid);shell.appendChild(wrap);line.appendChild(shell);
    // Match the existing Auto Scroll rule: a deliberate horizontal swipe takes
    // control away from playback-follow mode, while simple taps keep it on.
    let tx=null,ty=null;
    wrap.addEventListener('touchstart',e=>{if(!e.touches?.length||e.target.closest('.crp-midi-duration-handle'))return;tx=e.touches[0].clientX;ty=e.touches[0].clientY;},{passive:true});
    wrap.addEventListener('touchmove',e=>{if(tx==null||!e.touches?.length)return;const dx=e.touches[0].clientX-tx,dy=e.touches[0].clientY-ty;if(Math.abs(dx)>14&&Math.abs(dx)>Math.abs(dy)){tx=ty=null;if(state.autoScroll)disableAutoScrollForManualScroll();}},{passive:true});
    wrap.addEventListener('touchend',()=>{tx=ty=null;},{passive:true});
  }


  function renderRows(){
    const wrap=$('progression');wrap.innerHTML='';
    state.rows.forEach((row,ri)=>{
      const locked=state.autoScroll;
      const line=document.createElement('div');line.className='progression-line'+(ri===state.selectedRow?' selected':'');line.dataset.row=ri;
      line.innerHTML=`<span class="line-badge" title="${locked?'Turn Auto Scroll off to reorder lines':'Long press and drag to move this line'}">Line ${ri+1}</span><button class="duplicate-line" type="button" aria-label="Duplicate line ${ri+1}" title="Duplicate line">⧉</button><button class="delete-line" type="button" aria-label="Delete line ${ri+1}" title="Delete line">×</button>`;
      const badge=line.querySelector('.line-badge');
      let lineHold=null,lineMoveActive=false,suppressBadgeClick=false;
      const stopLineMove=cancel=>{
        clearTimeout(lineHold);lineHold=null;
        if(!lineMoveActive)return;
        const drag=state.lineDrag;lineMoveActive=false;suppressBadgeClick=true;
        document.body.classList.remove('moving-line');
        if(cancel){state.lineDrag=null;clearLineDropMarkers();$('status').textContent='';}
        else if(drag)moveWholeLine(drag.from,drag.insert);
      };
      badge.addEventListener('pointerdown',e=>{
        if(state.autoScroll){$('status').textContent='Turn Auto Scroll off to reorder lines.';return;}
        if(e.button!=null&&e.button!==0)return;
        clearTimeout(lineHold);
        const pointerId=e.pointerId,startX=e.clientX,startY=e.clientY;
        let lastX=startX,lastY=startY;

        const updateLineDestination=(clientX,clientY)=>{
          if(!lineMoveActive||!state.lineDrag)return;
          const mobile=isMobileCarousel(),lines=realCarouselLines();
          let insert=lines.length;
          if(mobile){
            const carousel=$('progression'),cr=carousel.getBoundingClientRect();
            if(clientX<cr.left+62)carousel.scrollBy({left:-20,behavior:'auto'});
            else if(clientX>cr.right-62)carousel.scrollBy({left:20,behavior:'auto'});
            for(let i=0;i<lines.length;i++){const r=lines[i].getBoundingClientRect();if(clientX<r.left+r.width/2){insert=i;break;}}
          }else{
            if(clientY<80)window.scrollBy(0,-18);else if(clientY>window.innerHeight-80)window.scrollBy(0,18);
            for(let i=0;i<lines.length;i++){const r=lines[i].getBoundingClientRect();if(clientY<r.top+r.height/2){insert=i;break;}}
          }
          state.lineDrag.insert=insert;
          clearLineDropMarkers();line.classList.add('line-moving');
          if(lines.length){if(insert>=lines.length)lines[lines.length-1].classList.add('line-drop-after');else lines[insert].classList.add('line-drop-before');}
        };

        const onDocMove=ev=>{
          if(ev.pointerId!==pointerId)return;
          lastX=ev.clientX;lastY=ev.clientY;
          if(!lineMoveActive){if(Math.hypot(lastX-startX,lastY-startY)>18){clearTimeout(lineHold);lineHold=null;}return;}
          ev.preventDefault();updateLineDestination(lastX,lastY);
        };
        const finishDocMove=(ev,cancel=false)=>{
          if(ev.pointerId!==pointerId)return;
          document.removeEventListener('pointermove',onDocMove,true);document.removeEventListener('pointerup',onDocUp,true);document.removeEventListener('pointercancel',onDocCancel,true);
          if(lineMoveActive){ev.preventDefault();stopLineMove(cancel);}else{clearTimeout(lineHold);lineHold=null;}
        };
        const onDocUp=ev=>finishDocMove(ev,false),onDocCancel=ev=>finishDocMove(ev,true);
        document.addEventListener('pointermove',onDocMove,{capture:true,passive:false});document.addEventListener('pointerup',onDocUp,{capture:true,passive:false});document.addEventListener('pointercancel',onDocCancel,{capture:true,passive:false});

        const beginLineMove=()=>{
          if(state.autoScroll||lineMoveActive)return;
          lineMoveActive=true;state.lineDrag={from:ri,insert:ri};
          try{badge.setPointerCapture?.(pointerId);}catch(_){}
          line.classList.add('line-moving');document.body.classList.add('moving-line');
          $('status').textContent=isMobileCarousel()?'Move the line left or right, then release.':'Drag the line up or down, then release.';
          if(e.pointerType!=='mouse')navigator.vibrate?.(20);
          updateLineDestination(lastX,lastY);
        };
        // Desktop mouse users expect a normal grab-and-drop interaction. Start
        // immediately on the line badge; touch keeps the deliberate long press
        // so vertical page scrolling is not stolen accidentally.
        const desktopGrab=e.pointerType==='mouse'||(e.pointerType==='pen'&&window.matchMedia('(hover:hover) and (pointer:fine)').matches);
        if(desktopGrab){
          e.preventDefault();
          beginLineMove();
        }else{
          lineHold=setTimeout(beginLineMove,450);
        }
      });
      badge.addEventListener('pointerleave',()=>{if(!lineMoveActive){/* document listeners keep tracking until release */}});
      badge.addEventListener('click',e=>{if(suppressBadgeClick){e.preventDefault();e.stopPropagation();suppressBadgeClick=false;}});
      line.querySelector('.duplicate-line').onclick=e=>{
        e.stopPropagation();
        recordUndo();
        lockAutoSongKey();
        const copy=JSON.parse(JSON.stringify(row));
        state.rows.splice(ri+1,0,copy);
        state.selectedRow=ri+1;
        renderRows();
        syncBuildInput();
        renderFits();
        scheduleAutoSave();
        $('status').textContent=`Line ${ri+1} duplicated.`;
        if(isMobileCarousel())requestAnimationFrame(()=>scrollMobileLineTo(ri+1,true));
      };
      line.querySelector('.delete-line').onclick=e=>{e.stopPropagation();recordUndo();if(state.rows.length===1){state.rows[0]=[];state.selectedRow=0;}else{state.rows.splice(ri,1);if(state.selectedRow>ri)state.selectedRow--;else if(state.selectedRow===ri)state.selectedRow=Math.min(ri,state.rows.length-1);}renderRows();syncBuildInput();renderFits();scheduleAutoSave();};
      line.onclick=e=>{if(!e.target.closest('.chord-card')){state.selectedRow=ri;realCarouselLines().forEach(x=>x.classList.toggle('selected',+x.dataset.row===ri));syncBuildInput();updateMobileLineIndicator(ri);}};
      line.addEventListener('dragover',e=>{if(state.autoScroll)return;e.preventDefault();line.classList.add('drop-target');});
      line.addEventListener('dragleave',()=>line.classList.remove('drop-target'));
      line.addEventListener('drop',e=>{if(state.autoScroll)return;e.preventDefault();line.classList.remove('drop-target');moveDragged(ri,row.length);});
      if(isMidiRollActive()){
        renderMidiRoll(line,row,ri);
        wrap.appendChild(line);
        return;
      }
      if(!row.length){const empty=document.createElement('div');empty.className='empty-line';empty.textContent='Empty line — tap to select or drop a card here';line.appendChild(empty);}
      row.forEach((card,ci)=>{
        const el=document.createElement('div');el.className='chord-card'+(card.type==='note'?' note-card':'');el.draggable=!state.autoScroll;
        const shown=displayedValue(card),sub=subtitle(card),hint=state.autoScroll?'Tap to play • Auto Scroll locks reordering':'Tap to play • hold & drag to move';
        const visual=`<div class="diagram" aria-hidden="true">${state.instrument==='guitar'?guitarSvg(card):pianoSvg(card)}</div>`;
        const explicitDur=Number.isFinite(+card.durationBeats)&&+card.durationBeats>0?cardDurationBeats(card):null,durBadge=explicitDur?`<div class="card-duration">${formatBeatDuration(explicitDur)} beat${explicitDur===1?'':'s'}</div>`:'';
        el.innerHTML=`<div class="card-top"><span class="chord-name">${esc(shown)}</span><button class="remove" type="button" aria-label="Remove ${esc(shown)}">×</button></div>${sub?`<div class="card-subtitle">${esc(sub)}</div>`:''}${durBadge}${visual}<div class="hint" aria-hidden="true">${hint}</div>`;
        // Keyboard: Tab to a card, Enter/Space plays it, Delete removes it, arrows move between cards.
        el.tabIndex=0;el.setAttribute('role','group');
        el.setAttribute('aria-label',`${card.type==='note'?'Note':'Chord'} ${shown}, line ${ri+1}, card ${ci+1} of ${row.length}. Enter to play, Delete to remove.`);
        const removeCard=()=>{recordUndo();row.splice(ci,1);renderRows();syncBuildInput();renderFits();scheduleAutoSave();focusCard(ri,Math.min(ci,row.length-1));};
        const playThis=()=>{state.selectedRow=ri;const stepSeconds=60/clampBpm($('bpmInput').value)*cardDurationBeats(card);playCard(card,state.sustain?sustainedNoteSeconds(stepSeconds,state.sound):Math.max(.35,stepSeconds*.92));};
        el.querySelector('.remove').onclick=e=>{e.stopPropagation();removeCard();};
        el.onclick=e=>{e.stopPropagation();if(!e.target.closest('.remove'))playThis();};
        el.addEventListener('keydown',e=>{
          if(e.target!==el)return;
          if(e.key==='Enter'||e.key===' '){e.preventDefault();playThis();}
          else if(e.key==='Delete'||e.key==='Backspace'){e.preventDefault();removeCard();}
          else if(e.key==='ArrowRight'||e.key==='ArrowLeft'){e.preventDefault();focusCard(ri,ci+(e.key==='ArrowRight'?1:-1));}
        });
        el.addEventListener('dragstart',e=>{if(state.autoScroll){e.preventDefault();$('status').textContent='Turn Auto Scroll off to reorder cards.';return;}state.drag={row:ri,index:ci};e.dataTransfer.effectAllowed='move';el.classList.add('dragging');});
        el.addEventListener('dragend',()=>{el.classList.remove('dragging');state.drag=null;});
        el.addEventListener('dragover',e=>{if(!state.autoScroll)e.preventDefault();});
        el.addEventListener('drop',e=>{if(state.autoScroll)return;e.preventDefault();e.stopPropagation();moveDragged(ri,ci);});
        let t=null;el.addEventListener('pointerdown',e=>{if(e.target.closest('button')||state.autoScroll)return;t=setTimeout(()=>{if(state.autoScroll)return;state.drag={row:ri,index:ci};el.classList.add('dragging');$('status').textContent='Card selected to move. Tap another card or line.';navigator.vibrate?.(20);},450);});
        ['pointerup','pointercancel','pointerleave'].forEach(ev=>el.addEventListener(ev,()=>clearTimeout(t)));
        el.addEventListener('pointerup',e=>{if(!state.autoScroll&&state.drag&&(state.drag.row!==ri||state.drag.index!==ci)&&!e.target.closest('button'))moveDragged(ri,ci);});
        line.appendChild(el);
      });
      line.addEventListener('pointerup',e=>{if(!state.autoScroll&&state.drag&&!e.target.closest('.chord-card'))moveDragged(ri,row.length);});
      wrap.appendChild(line);
    });
    setupMobileCarousel(wrap);applyProgressionEditLock();
  }

  function focusCard(ri,ci){
    const cards=document.querySelectorAll(`#progression .progression-line:not(.carousel-clone)[data-row="${ri}"] .chord-card`);
    cards[Math.max(0,Math.min(cards.length-1,ci))]?.focus();
  }
  function appendFitValue(v,type=state.mode){
    const targetType=type==='note'?'note':'chord';
    const parsed=targetType==='note'?parseNote(v):parseChord(v)?.display;
    if(!parsed)return false;
    // Treat whatever is currently typed in the Build field as the source of truth
    // before appending a chip. This preserves manually typed chords/notes and
    // prevents stale row state from wiping or duplicating the entry.
    recordUndo();
    const bad=commitBuildInput();
    selectedRow().push({type:targetType,value:parsed});
    $('status').textContent=bad.length?`Skipped unrecognized: ${bad.join(', ')}`:'';
    syncBuildInput();autoPopulateKeyFromEntry();renderAll();scheduleAutoSave();
    return true;
  }
  function renderFits(){
    $('fitHeading').textContent=state.mode==='chord'?'Chords that fit':'Notes that fit';const k=activeKey();
    $('keyHint').innerHTML=`<span>Based on the</span><span>${esc(keyTonic(k))}${k.minor?' minor':' major'}</span><span>chord family</span>`;
    const w=$('compatibleChords');w.innerHTML='';fitItems().forEach(v=>{const b=document.createElement('button');b.className='chip';b.textContent=v;b.onclick=()=>appendFitValue(v,state.mode);w.appendChild(b);});
    // Scale Rider loads after app.js, so this optional hook keeps its active
    // scale row in sync when Chord/Note mode changes without coupling startup.
    window.ScaleRider?.renderActive?.();
  }
  function renderSound(){const s=$('soundSelect');s.innerHTML='';SOUNDS[state.instrument].forEach(([v,l])=>{const o=document.createElement('option');o.value=v;o.textContent=l;s.appendChild(o);});if(!SOUNDS[state.instrument].some(x=>x[0]===state.sound))state.sound=SOUNDS[state.instrument][0][0];s.value=state.sound;}
  let instrumentSoundTapGuardUntil=0;
  function armInstrumentSoundTapGuard(ms=700){
    instrumentSoundTapGuardUntil=Math.max(instrumentSoundTapGuardUntil,performance.now()+Math.max(0,Number(ms)||0));
  }
  // v3.3.120 — Android can emit one delayed compatibility click after a touch
  // sound choice even after the popup itself has been hidden. Capture that one
  // trailing click at document level so it cannot land on Play/Stop, Build,
  // Repeat, or any other control underneath the former popup.
  document.addEventListener('click',e=>{
    if(performance.now()>=instrumentSoundTapGuardUntil)return;
    if(e.target?.closest?.('#crpInstrumentSoundPickerLayer'))return;
    e.preventDefault?.();e.stopPropagation?.();e.stopImmediatePropagation?.();
  },true);
  function closeInstrumentSoundPicker(){
    document.getElementById('crpInstrumentSoundPickerLayer')?.remove();
    document.getElementById('crpInstrumentSoundPicker')?.remove();
  }
  function showInstrumentSoundPicker(anchor,instrument,current,onChoose){
    closeInstrumentSoundPicker();
    const options=SOUNDS[instrument]||SOUNDS.piano;if(!anchor||!options?.length)return;
    // The full-screen transparent layer is intentional. On Android Chrome a touch
    // selection can emit a compatibility click *after* pointerup. If the menu is
    // removed on pointerup, that trailing click lands on whatever control is behind
    // the menu (Build, Note, etc.). Keep the layer alive just long enough to consume
    // that click, while hiding the menu immediately after the sound is chosen.
    const layer=document.createElement('div');layer.id='crpInstrumentSoundPickerLayer';layer.className='instrument-sound-picker-layer';layer.setAttribute('aria-hidden','false');
    const pop=document.createElement('div');pop.id='crpInstrumentSoundPicker';pop.className='instrument-sound-picker';pop.setAttribute('role','menu');pop.setAttribute('aria-label',`${instrument} sounds`);
    const title=document.createElement('strong');title.textContent=`${instrument.charAt(0).toUpperCase()+instrument.slice(1)} Sounds`;pop.appendChild(title);
    let guardTimer=0;
    const guardedClose=()=>{clearTimeout(guardTimer);armInstrumentSoundTapGuard(700);pop.style.visibility='hidden';layer.classList.add('is-consuming-tap');guardTimer=setTimeout(closeInstrumentSoundPicker,700);};
    for(const [value,label] of options){
      const b=document.createElement('button');b.type='button';b.textContent=label;b.dataset.sound=value;b.classList.toggle('is-current',String(value)===String(current));b.setAttribute('role','menuitemradio');b.setAttribute('aria-checked',String(String(value)===String(current)));
      let down=null,chosen=false;
      const choose=(e,{guardTouch=false}={})=>{
        // Always consume the event, including the synthetic click that may follow a
        // handled touch pointerup. This is what prevents click-through on mobile.
        e?.preventDefault?.();e?.stopPropagation?.();e?.stopImmediatePropagation?.();
        if(chosen)return;chosen=true;onChoose?.(value,label);if(guardTouch)guardedClose();else closeInstrumentSoundPicker();
      };
      b.addEventListener('pointerdown',e=>{down={id:e.pointerId,x:e.clientX,y:e.clientY,type:e.pointerType};},{passive:true});
      b.addEventListener('pointerup',e=>{if(!down||down.id!==e.pointerId)return;const moved=Math.hypot(e.clientX-down.x,e.clientY-down.y);const touchLike=down.type==='touch'||down.type==='pen';down=null;if(touchLike&&moved<14)choose(e,{guardTouch:true});});
      b.addEventListener('pointercancel',()=>{down=null;});
      b.onclick=e=>choose(e);
      pop.appendChild(b);
    }
    layer.appendChild(pop);document.body.appendChild(layer);const ar=anchor.getBoundingClientRect(),pr=pop.getBoundingClientRect(),left=Math.max(6,Math.min(window.innerWidth-pr.width-6,ar.left)),top=Math.max(6,Math.min(window.innerHeight-pr.height-6,ar.bottom+6));pop.style.left=`${left}px`;pop.style.top=`${top}px`;
    // Taps outside the menu are captured by the layer, so they close the picker
    // without ever reaching the page underneath it.
    layer.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();if(e.target===layer)closeInstrumentSoundPicker();});
    layer.addEventListener('pointerdown',e=>{if(e.target===layer)e.stopPropagation();},true);
    pop.onkeydown=e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closeInstrumentSoundPicker();anchor.focus?.();}};
  }
  window.CRPShowSoundPicker=(anchor,instrument,current,onChoose)=>showInstrumentSoundPicker(anchor,instrument,current,onChoose);
  function updateCardViewButton(){
    const b=$('midiViewBtn');if(!b)return;
    const midi=state.cardView==='midi';
    b.textContent=midi?'Diagram View':'MIDI View';
    b.classList.toggle('on',midi);
    b.setAttribute('aria-pressed',String(midi));
    b.setAttribute('title',midi?'Switch back to chord diagrams':'Open the editable horizontal MIDI table');
  }

  // Undo/redo for the chord editor: whole-editor snapshots (lines, song key, drum
  // beat), 50 steps deep, cleared whenever a project is loaded. Call recordUndo()
  // right before any edit you want to be undoable.
  const UNDO_LIMIT=50;
  const undoHistory={
    undo:[],redo:[],
    snapshot(){return JSON.stringify({rows:state.rows,selectedRow:state.selectedRow,key:$('keyInput')?.value||'',autoKey:$('keyInput')?.dataset.autoKey||'1',beat:window.CRPBeatMaker?.getBeat?.()||null});},
    record(){const s=this.snapshot();if(this.undo[this.undo.length-1]!==s){this.undo.push(s);if(this.undo.length>UNDO_LIMIT)this.undo.shift();}this.redo=[];updateUndoButtons();},
    reset(){this.undo=[];this.redo=[];updateUndoButtons();}
  };
  function recordUndo(){undoHistory.record();}
  function updateUndoButtons(){
    const u=$('undoBtn'),r=$('redoBtn');
    if(u)u.disabled=!undoHistory.undo.length;
    if(r)r.disabled=!undoHistory.redo.length;
    window.CRPBeatMaker?.refreshUndoButton?.(undoHistory.undo.length>0);
  }
  function restoreUndoSnapshot(json){
    const s=JSON.parse(json);
    state.rows=Array.isArray(s.rows)&&s.rows.length?s.rows:[[]];
    state.selectedRow=Math.max(0,Math.min(state.rows.length-1,Number(s.selectedRow)||0));
    const key=$('keyInput');if(key){key.value=s.key||'';key.dataset.autoKey=s.autoKey||'1';}
    const beat=window.CRPBeatMaker?.getBeat?.();
    if(s.beat&&JSON.stringify(beat)!==JSON.stringify(s.beat))window.CRPBeatMaker?.setBeat?.(s.beat);
    renderAll();syncBuildInput();window.CRPParts?.syncCoreLive?.();scheduleAutoSave();
  }
  function stepHistory(from,to,message){
    if(!from.length)return false;
    to.push(undoHistory.snapshot());restoreUndoSnapshot(from.pop());updateUndoButtons();
    $('status').textContent=message;return true;
  }
  function undoEdit(){return stepHistory(undoHistory.undo,undoHistory.redo,'Undone.');}
  function redoEdit(){return stepHistory(undoHistory.redo,undoHistory.undo,'Redone.');}

  function renderAll(){
    renderSound();document.querySelectorAll('#instrumentTabs .seg').forEach(b=>b.classList.toggle('active',b.dataset.instrument===state.instrument));document.querySelectorAll('#modeTabs .seg').forEach(b=>b.classList.toggle('active',b.dataset.mode===state.mode));
    $('octaveValue').textContent=state.octave>0?'+'+state.octave:state.octave;$('capoWrap').style.display=$('transposeWrap').style.display=state.instrument==='guitar'?'':'none';$('neckWrap').style.display=state.instrument==='guitar'&&state.mode==='chord'?'':'none';$('neckSelect').value=state.neck;
    $('transposeBtn').textContent=state.transpose?'Transpose ON':'Transpose OFF';$('transposeBtn').classList.toggle('on',state.transpose);$('transposeBtn').setAttribute('aria-pressed',String(state.transpose));
    $('chordInput').placeholder=state.mode==='chord'?'Enter chords, e.g. Em A7 Cmaj7 B7':'Enter notes, e.g. E F# A B';updateCardViewButton();renderFits();renderRows();
  }

  function updateAutoScrollButton(){
    const b=$('autoScrollBtn');
    if(b){
      b.classList.toggle('on',state.autoScroll);
      b.setAttribute('aria-pressed',String(state.autoScroll));
      b.setAttribute('title',state.autoScroll?'Auto scroll on':'Auto scroll off');
      b.setAttribute('aria-label',state.autoScroll?'Auto scroll on':'Auto scroll off');
      b.textContent='↕';
    }
    const lead=$('leadAutoScrollBtn');
    if(lead){
      lead.classList.toggle('on',state.autoScroll);
      lead.setAttribute('aria-pressed',String(state.autoScroll));
      lead.setAttribute('title',state.autoScroll?'Lead/Bass auto scroll on':'Follow the playing Lead/Bass note');
      lead.textContent=state.autoScroll?'↕ Auto On':'↕ Auto';
    }
    applyProgressionEditLock();
  }

  function setAutoScroll(on,{manual=false}={}){
    state.autoScroll=!!on;
    localStorage.setItem('crp-auto-scroll',state.autoScroll?'1':'0');
    updateAutoScrollButton();
    if(manual&&!state.autoScroll&&$('status'))$('status').textContent='Auto scroll off — manual navigation detected.';
    return state.autoScroll;
  }

  function disableAutoScrollForManualScroll(){
    if(!state.autoScroll)return;
    setAutoScroll(false,{manual:true});
  }

  function updateSustainButton(){
    const b=$('sustainBtn'); if(!b)return;
    b.classList.toggle('on',state.sustain);
    b.setAttribute('aria-pressed',String(state.sustain));
    b.textContent=state.sustain?'ON':'OFF';
    b.title=state.sustain?'Sustain on — piano, electric piano, and acoustic guitar ring longer':'Sustain off';
  }

  function playbackStartRow(){
    if(!isMobileCarousel())return Math.max(0,Math.min(state.rows.length-1,state.selectedRow));

    const wrap=$('progression');
    if(!wrap)return Math.max(0,Math.min(state.rows.length-1,state.selectedRow));

    const wr=wrap.getBoundingClientRect(),center=wr.left+wr.width/2;
    const lines=[...wrap.querySelectorAll(':scope > .progression-line')];
    let best=null,bestDistance=Infinity;

    lines.forEach(line=>{
      const r=line.getBoundingClientRect();
      if(r.right<wr.left||r.left>wr.right)return;
      const d=Math.abs((r.left+r.width/2)-center);
      if(d<bestDistance){best=line;bestDistance=d;}
    });

    if(!best)return Math.max(0,Math.min(state.rows.length-1,state.selectedRow));
    const raw=best.classList.contains('carousel-clone') ? best.dataset.cloneTarget : best.dataset.row;
    const ri=Number(raw);
    return Number.isFinite(ri) ? Math.max(0,Math.min(state.rows.length-1,ri)) : state.selectedRow;
  }

  async function playProgression(){
    if(window.CRPParts?.handlesPlayback){
      // v3.3.63 — Play from MIDI view must consume exactly what is visible now.
      // Clear any legacy absolute starts one last time at the transport boundary
      // and commit the current durations before Baby DAW builds its scheduler.
      if(state.cardView==='midi'){
        reflowMidiTimingFrom();
        window.CRPParts?.syncMidiTimelineFromCore?.();
      }
      return window.CRPParts.togglePlayback();
    }
    if(state.playing)return stopProgression();if(!allCards().length){$('status').textContent='Add at least one chord or note first.';return;}

    const startRow=playbackStartRow();
    state.selectedRow=startRow;
    syncBuildInput();
    updateMobileLineIndicator(startRow);
    realCarouselLines().forEach(el=>el.classList.toggle('selected',+el.dataset.row===startRow));

    const initialList=state.rows.flatMap((r,ri)=>r.map((c,ci)=>({c,ri,ci})));
    let idx=initialList.findIndex(item=>item.ri>=startRow);
    if(idx<0){
      if($('loopToggle').checked)idx=0;
      else {$('status').textContent='No chords or notes from this line to the end.';return;}
    }

    state.playing=true;setRiderBonesRiding(true);$('playAllBtn').textContent='■ Stop';await ensureAudio();
    window.CRPBeatMaker?.startMainNow?.(.01,state.rows.slice(0,startRow).flat().reduce((n,c)=>n+cardDurationBeats(c),0));
    let nextStepAt=performance.now();
    const step=async()=>{
      if(!state.playing)return;
      const list=state.rows.flatMap((r,ri)=>r.map((c,ci)=>({c,ri,ci})));
      if(!list.length)return stopProgression();
      if(idx>=list.length){if($('loopToggle').checked)idx=0;else return stopProgression();}
      const bpm=Math.max(40,Math.min(240,+$('bpmInput').value||92)),item=list[idx++],durBeats=cardDurationBeats(item.c),ms=60000/bpm*durBeats;
      const stepSeconds=ms/1000;
      const noteSeconds=state.sustain
        ? sustainedNoteSeconds(stepSeconds,state.sound)
        : Math.max(.35,stepSeconds*.92);
      await playCard(item.c,noteSeconds);
      // In mobile infinite-carousel mode there is a visual clone of the last line
      // before Line 1. Always target the real project line so Auto Scroll never
      // mistakes that edge clone for the actual last line.
      const playingLine=document.querySelector(`.progression-line:not(.carousel-clone)[data-row="${item.ri}"]`);
      if(isMidiRollActive()){
        highlightMidiColumn(item.ri,item.ci);
        if(state.autoScroll){playingLine?.scrollIntoView({behavior:'smooth',block:'center',inline:'nearest'});midiColumnScrollIntoView(item.ri,item.ci,true);}
      }else{
        clearPlaybackHighlights();
        const playingCard=playingLine?.querySelectorAll('.chord-card')[item.ci];
        playingCard?.style.setProperty('outline','2px solid var(--accent)');
        if(state.autoScroll&&playingCard){
          if(isMobileCarousel()){
            scrollMobileLineTo(item.ri,true);
            updateMobileLineIndicator(item.ri);
            setTimeout(()=>{if(state.autoScroll)playingCard.scrollIntoView({behavior:'smooth',block:'center',inline:'nearest'});},180);
          }else playingCard.scrollIntoView({behavior:'smooth',block:'center',inline:'nearest'});
        }
      }
      nextStepAt += ms;
      state.timer=setTimeout(step,Math.max(0,nextStepAt-performance.now()));
    };
    step();
  }
  function stopProgression(){if(window.CRPParts?.handlesPlayback&&window.CRPParts?.isPlaying?.())return window.CRPParts.stopPlayback();state.playing=false;clearTimeout(state.timer);state.timer=null;window.CRPBeatMaker?.stopMainNow?.();setRiderBonesRiding(false);$('playAllBtn').textContent='▶ Play';clearPlaybackHighlights();if(pendingEditorReload)setTimeout(reloadOpenProject,0);}

  // ---------------------------------------------------------------------------
  // Song storage, drafts and cloud sync (contract: docs/SYNC.md)
  // ---------------------------------------------------------------------------
  // `crp-projects` is this device's working set. Song Rider Pro reads it and writes
  // BPM/key/capo straight into it, so its format must not change. Sync bookkeeping
  // lives beside it:
  //   crp-sync-meta-v1         {id:{rev,fp,legacy?}} server rev + content fingerprint at the last sync
  //   crp-local-deletes-v1     {id:deletedAt} deletes the server has not confirmed yet
  //   crp-local-owner-v1       account id that owns the working set ('' = made while signed out)
  //   crp-account-stash-v1:ID  another account's working set, parked until it signs in again
  //   crp-unsaved-draft-v1     the never-saved song in the editor, so a killed tab loses nothing
  // A song needs uploading ("dirty") when its fingerprint differs from the one recorded
  // at the last sync. That also catches edits Song Rider Pro wrote into crp-projects.
  const PROJECTS_KEY='crp-projects',ACTIVE_PROJECT_KEY='crp-active-project-id';
  const SYNC_META_KEY='crp-sync-meta-v1',LOCAL_DELETES_KEY='crp-local-deletes-v1',LEGACY_PENDING_KEY='crp-cloud-pending-v1';
  const LOCAL_OWNER_KEY='crp-local-owner-v1',ACCOUNT_STASH_PREFIX='crp-account-stash-v1:',DRAFT_KEY='crp-unsaved-draft-v1';
  const WORKING_SET_KEYS=[PROJECTS_KEY,SYNC_META_KEY,LOCAL_DELETES_KEY,LEGACY_PENDING_KEY,ACTIVE_PROJECT_KEY,DRAFT_KEY];
  const TRANSPORT_FIELDS=['bpm','capo','octave','transpose','key'];
  const CLOUD_POLL_MS=5*60*1000;

  let accountUser=null, cloudSyncState='idle';
  function accountDisplayName(){return accountUser?.display_name||accountUser?.email||'Account';}
  function setAccountCollapsed(collapsed){
    const panel=$('accountPanel');
    if(!panel)return;
    panel.classList.toggle('is-collapsed',!!collapsed);
    const btn=$('accountSummaryBtn');
    if(btn)btn.setAttribute('aria-expanded',String(!collapsed));
  }
  function updateAccountSummary(){
    const btn=$('accountSummaryBtn');
    if(!btn||!accountUser)return;
    const stateText=cloudSyncState==='ready'?'Synced':cloudSyncState==='error'?'Not synced':'Syncing…';
    btn.innerHTML=`<span>☁ ${esc(accountDisplayName())}</span><span class="cloud-state">${stateText} ▾</span>`;
  }

  const PANEL_COLLAPSE_KEYS={projects:'crp-projects-panel-collapsed-v1',notes:'crp-notes-panel-collapsed-v1'};
  function readPanelCollapsed(kind){try{return localStorage.getItem(PANEL_COLLAPSE_KEYS[kind])==='1'}catch{return false}}
  function setDataPanelCollapsed(kind,collapsed,{persist=true}={}){
    const isProjects=kind==='projects',panel=$(isProjects?'projectsPanel':'notesPanel'),body=$(isProjects?'projectsPanelBody':'notesPanelBody'),btn=$(isProjects?'projectsPanelToggleBtn':'notesPanelToggleBtn');
    if(!panel||!body||!btn)return;
    const on=!!collapsed;panel.classList.toggle('is-collapsed',on);body.hidden=on;btn.textContent=on?'Show':'Hide';btn.setAttribute('aria-expanded',String(!on));
    if(persist){try{localStorage.setItem(PANEL_COLLAPSE_KEYS[kind],on?'1':'0')}catch{}}
  }
  function restoreDataPanelCollapse(){setDataPanelCollapsed('projects',readPanelCollapsed('projects'),{persist:false});setDataPanelCollapsed('notes',readPanelCollapsed('notes'),{persist:false});}

  // --- Local store ------------------------------------------------------------
  // Reads never throw. Writes throw on failure (usually a full disk) so callers can
  // show the "Not saved" banner instead of pretending the song is safe.
  function readStored(key,fallback){try{const raw=localStorage.getItem(key);if(raw==null)return fallback;const v=JSON.parse(raw);return v??fallback;}catch{return fallback;}}
  function writeStored(key,value){localStorage.setItem(key,JSON.stringify(value));}
  function readStoredMap(key){const v=readStored(key,{});return v&&typeof v==='object'&&!Array.isArray(v)?v:{};}
  function localProjects(){const v=readStored(PROJECTS_KEY,[]);return Array.isArray(v)?v.filter(p=>p&&typeof p==='object'):[];}
  function saveLocalProjects(ps){writeStored(PROJECTS_KEY,ps);}
  function findLocal(id){return id==null?null:localProjects().find(p=>sameProjectId(p.id,id))||null;}
  function upsertLocal(p){const ps=localProjects(),i=ps.findIndex(x=>sameProjectId(x.id,p.id));if(i>=0)ps[i]=p;else ps.unshift(p);saveLocalProjects(ps);}
  function removeLocal(id){saveLocalProjects(localProjects().filter(p=>!sameProjectId(p.id,id)));}
  function readSyncMeta(){return readStoredMap(SYNC_META_KEY);}
  function writeSyncMeta(m){writeStored(SYNC_META_KEY,m);}
  function readLocalDeletes(){return readStoredMap(LOCAL_DELETES_KEY);}
  function writeLocalDeletes(d){writeStored(LOCAL_DELETES_KEY,d);}
  // Older builds kept a "pending upload" map; treat those songs as having unsent edits.
  function readLegacyPending(){return readStoredMap(LEGACY_PENDING_KEY);}
  function clearLegacyPending(id){const m=readLegacyPending();if(!(id in m))return;delete m[id];try{writeStored(LEGACY_PENDING_KEY,m)}catch{}}
  function newProjectId(){return crypto.randomUUID?crypto.randomUUID():`p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,10)}`;}
  function defaultProjectName(){return `Chord Project ${new Date().toLocaleDateString()}`;}

  // Content fingerprint: key order and bookkeeping fields (times, server rev) are ignored.
  function stableJson(value,skip){
    if(Array.isArray(value))return '['+value.map(v=>stableJson(v)).join(',')+']';
    if(value&&typeof value==='object'){
      const keys=Object.keys(value).filter(k=>value[k]!==undefined&&typeof value[k]!=='function'&&!(skip&&skip.has(k))).sort();
      return '{'+keys.map(k=>JSON.stringify(k)+':'+stableJson(value[k])).join(',')+'}';
    }
    const s=JSON.stringify(value);return s===undefined?'null':s;
  }
  function hashString(s){
    let h1=0xdeadbeef,h2=0x41c6ce57;
    for(let i=0;i<s.length;i++){const c=s.charCodeAt(i);h1=Math.imul(h1^c,2654435761);h2=Math.imul(h2^c,1597334677);}
    h1=Math.imul(h1^(h1>>>16),2246822507)^Math.imul(h2^(h2>>>13),3266489909);
    h2=Math.imul(h2^(h2>>>16),2246822507)^Math.imul(h1^(h1>>>13),3266489909);
    return (h2>>>0).toString(36)+(h1>>>0).toString(36);
  }
  const FINGERPRINT_SKIP=new Set(['updatedAt','createdAt','rev','beatMakerUpdatedAt']);
  const CONTENT_SKIP=new Set([...FINGERPRINT_SKIP,...TRANSPORT_FIELDS]);
  function projectFingerprint(p){return p?hashString(stableJson(p,FINGERPRINT_SKIP)):'';}
  // Same, but ignoring BPM/key/capo/octave/transpose, which Song Rider Pro shares live.
  function contentFingerprint(p){return p?hashString(stableJson(p,CONTENT_SKIP)):'';}
  function isDirty(p,m,legacyPending=readLegacyPending()){
    if(!m)return true;
    return !!legacyPending[String(p.id)]||m.fp!==projectFingerprint(p);
  }

  // --- "Not saved" banner and sync notices ------------------------------------
  const saveProblems={};
  let syncNotices=[];
  function renderSaveProblem(){
    const bar=$('saveProblemBanner');if(!bar)return;
    const text=saveProblems.local?`Not saved — ${saveProblems.local}`:saveProblems.cloud?`Not saved to cloud — ${saveProblems.cloud}`:'';
    bar.hidden=!text;
    const label=bar.querySelector('[data-save-problem-text]');if(label)label.textContent=text;
  }
  function setSaveProblem(channel,message){if(saveProblems[channel]===message)return;saveProblems[channel]=message;renderSaveProblem();}
  function clearSaveProblem(channel){if(!(channel in saveProblems))return;delete saveProblems[channel];renderSaveProblem();}
  function localSaveReason(e){
    const text=`${e?.name||''} ${e?.message||e||''}`;
    return /quota|exceeded/i.test(text)?'this device is out of storage space. Delete or export old songs, then tap Retry.':`this device could not store the song (${e?.message||e}).`;
  }
  function cloudSaveReason(e){
    if(e?.status===401)return 'you are signed out. Log in again and your songs will upload.';
    if(!navigator.onLine||e instanceof TypeError)return 'you are offline. Your songs are kept on this device and will upload when you reconnect.';
    return `${e?.message||'the server did not answer'}. Your songs are kept on this device; tap Retry.`;
  }
  function showSyncNotice(text){
    syncNotices=[...syncNotices.filter(t=>t!==text),text].slice(-3);
    const el=$('syncNotice');if(!el){$('status').textContent=text;return;}
    el.querySelector('[data-sync-notice-text]').textContent=syncNotices.join(' ');
    el.hidden=false;
  }
  function dismissSyncNotice(){syncNotices=[];const el=$('syncNotice');if(el)el.hidden=true;}

  async function api(path,options={}){
    const r=await fetch(path,{...options,headers:{'Content-Type':'application/json',...(options.headers||{})}});
    let d={};try{d=await r.json()}catch{}
    if(!r.ok){const err=new Error(d.error||`Request failed (${r.status})`);err.status=r.status;err.code=d.code;err.data=d;throw err;}
    return d;
  }

  // --- Editor <-> storage -----------------------------------------------------
  // editorBase remembers the stored version the editor was loaded from or last wrote,
  // so a change made by another tab or by Song Rider Pro is noticed, not overwritten.
  let editorBase={fp:'',contentFp:'',transport:null},pendingEditorReload=false;
  function noteEditorBase(p){editorBase=p?{fp:projectFingerprint(p),contentFp:contentFingerprint(p),transport:Object.fromEntries(TRANSPORT_FIELDS.map(k=>[k,p[k]]))}:{fp:'',contentFp:'',transport:null};}
  // Write a song this tab changed itself (rename, archive) without tripping that check.
  function writeProjectHere(p){upsertLocal(p);if(sameProjectId(p.id,state.currentProjectId))noteEditorBase(p);}

  let unsavedProjectTouched=false;
  function editorHasContent(){
    if(($('projectName')?.value||'').trim()||($('chordInput')?.value||'').trim()||($('keyInput')?.value||'').trim()||($('notesEditor')?.textContent||'').trim())return true;
    if((state.rows||[]).some(row=>Array.isArray(row)&&row.length))return true;
    try{
      const beat=window.CRPBeatMaker?.getBeat?.();
      if(beat&&Object.values(beat.tracks||{}).some(bars=>(bars||[]).some(a=>Array.isArray(a)&&a.length)))return true;
    }catch{}
    try{
      const pack=window.CRPParts?.capture?.(),items=pack?.items||[];
      if(items.length>1)return true;
      for(const part of items){
        if(part?.type==='chord'&&(part.data?.rows||[]).some(row=>Array.isArray(row)&&row.length))return true;
        if(part?.type==='lead'&&(part.events||[]).length)return true;
        if(part?.type==='vocal'&&((part.recordings||[]).length||(part.voxEvents||[]).length||String(part.transcript||'').trim()))return true;
      }
    }catch{}
    return false;
  }
  function unsavedProjectHasWork(){
    if(IS_PLAYBACK_BRIDGE||state.currentProjectId)return false;
    return unsavedProjectTouched||editorHasContent();
  }

  // Never-saved work goes to a draft slot holding the same full capture Save uses
  // (chords, Baby DAW parts, vocal take metadata, beat), so it survives a killed tab.
  function readDraft(){const d=readStored(DRAFT_KEY,null);return d?.project&&typeof d.project==='object'?d:null;}
  function clearDraft(){try{localStorage.removeItem(DRAFT_KEY)}catch{}state.draftId=null;}
  function persistDraft(){
    if(!editorHasContent()){
      // The user emptied their draft: drop it. Never drop a draft this tab did not open.
      const d=readDraft();if(d&&state.draftId&&sameProjectId(d.project.id,state.draftId))clearDraft();
      return;
    }
    if(!state.draftId)state.draftId=newProjectId();
    const p=capture(state.draftId,($('projectName').value||'').trim().slice(0,160));
    const prior=readDraft();
    if(prior&&projectFingerprint(prior.project)===projectFingerprint(p))return;
    writeStored(DRAFT_KEY,{project:p,savedAt:Date.now()});
  }
  function persistOpenProject(){
    const id=state.currentProjectId,stored=findLocal(id);
    if(!stored&&readLocalDeletes()[String(id)]){detachDeletedEditor();return;}
    const name=($('projectName').value.trim()||stored?.name||defaultProjectName()).slice(0,160);
    const p=capture(id,name);
    if(stored){
      const storedFp=projectFingerprint(stored);
      if(editorBase.fp&&storedFp!==editorBase.fp){
        // Someone else changed this song since the editor last saw it. Changes to
        // the song itself are real work, so both versions are kept. BPM/key/capo
        // (shared live with Song Rider Pro) merge per field: the editor only wins
        // the fields it changed itself.
        if(contentFingerprint(stored)!==editorBase.contentFp){keepEditorAsConflictCopy(stored,p,'in another tab');return;}
        let tookTheirs=false;
        for(const k of TRANSPORT_FIELDS)if(stableJson(p[k])===stableJson(editorBase.transport?.[k])&&stableJson(stored[k])!==stableJson(p[k])){p[k]=stored[k];tookTheirs=true;}
        if(tookTheirs)applyTransportFrom(p);
      }
      if(storedFp===projectFingerprint(p)){noteEditorBase(stored);return;}
    }
    upsertLocal(p);noteEditorBase(p);
  }
  // Writes the editor to this device right now. Returns false (and shows the
  // "Not saved" banner) when the browser refuses the write.
  function persistEditorLocally(){
    if(IS_PLAYBACK_BRIDGE)return true;
    try{
      if(state.currentProjectId)persistOpenProject();else persistDraft();
      clearSaveProblem('local');return true;
    }catch(e){console.error('Local save failed',e);setSaveProblem('local',localSaveReason(e));return false;}
  }
  function conflictCopyName(name){
    const stamp=new Date().toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
    return `${String(name||'Untitled Project').slice(0,110)} (conflict copy ${stamp})`;
  }
  function asConflictCopy(p){const copy=JSON.parse(JSON.stringify(p));copy.id=newProjectId();copy.name=conflictCopyName(p.name);copy.updatedAt=Date.now();delete copy.rev;delete copy.createdAt;return copy;}
  function keepEditorAsConflictCopy(theirs,mine,where){
    const copy=asConflictCopy(mine);
    upsertLocal(copy);
    loadProjectIntoEditor(theirs);
    showSyncNotice(`“${theirs.name}” was changed ${where}. Both versions are kept: “${theirs.name}” has those changes, and your edits are saved as “${copy.name}”.`);
  }
  // The open song was deleted elsewhere: keep what is on screen as an unsaved draft.
  function detachDeletedEditor(){
    state.currentProjectId=null;state.draftId=newProjectId();unsavedProjectTouched=true;noteEditorBase(null);
    try{localStorage.removeItem(ACTIVE_PROJECT_KEY)}catch{}
    try{persistDraft();}catch{}
    renderProjects();
    showSyncNotice('The song you had open was deleted somewhere else. What is on screen is kept as an unsaved draft — tap Save to keep it.');
  }

  // --- Cloud sync ---------------------------------------------------------------
  function localOwner(){try{return localStorage.getItem(LOCAL_OWNER_KEY)}catch{return null}} // null: written by an older build
  function setLocalOwner(id){localStorage.setItem(LOCAL_OWNER_KEY,String(id||''));}
  function canUpload(){return !!accountUser&&!IS_PLAYBACK_BRIDGE&&localOwner()===String(accountUser.id);}
  let syncRun=null,syncAgain=null,lastPullAt=0,cloudPollTimer=null,cloudPullTimer=null;
  function requestCloudPush(){if(canUpload())syncWithCloud({pull:false}).catch(()=>{});}
  // One sync runs at a time; requests made meanwhile fold into one follow-up pass.
  function syncWithCloud({pull=true}={}){
    if(!canUpload())return Promise.resolve(null);
    if(syncRun){syncAgain={pull:pull||!!syncAgain?.pull};return syncRun;}
    syncRun=(async()=>{
      const result={pulled:0,pushed:0,conflicts:0};
      try{
        cloudSyncState='syncing';updateAccountSummary();
        for(let next={pull};next;next=syncAgain){
          syncAgain=null;
          if(next.pull){
            const d=await api('/api/projects');
            if(!canUpload())break;
            lastPullAt=Date.now();
            persistEditorLocally(); // anything typed during the request counts as a local edit
            result.pulled+=mergeCloudSnapshot(d.projects||[],d.deleted||[]);
          }
          const r=await pushLocalChanges();result.pushed+=r.pushed;result.conflicts+=r.conflicts;
        }
        cloudSyncState='ready';clearSaveProblem('cloud');
        return result;
      }catch(e){
        cloudSyncState='error';setSaveProblem('cloud',cloudSaveReason(e));throw e;
      }finally{syncRun=null;syncAgain=null;updateAccountSummary();renderProjects();}
    })();
    return syncRun;
  }
  async function pushLocalChanges(){
    let pushed=0,conflicts=0;const owner=String(accountUser?.id||'');
    // Deletes go first so a deleted song can never be re-uploaded.
    for(const id of Object.keys(readLocalDeletes())){
      if(localOwner()!==owner)return {pushed,conflicts};
      await api('/api/projects/'+encodeURIComponent(id),{method:'DELETE'});
      const d=readLocalDeletes();delete d[id];writeLocalDeletes(d);
    }
    const tried=new Set();
    while(canUpload()&&localOwner()===owner){
      const meta=readSyncMeta(),legacy=readLegacyPending();
      const next=localProjects().find(p=>!tried.has(String(p.id))&&isDirty(p,meta[String(p.id)],legacy));
      if(!next)break;
      tried.add(String(next.id));
      const outcome=await pushProject(next,meta[String(next.id)]);
      if(outcome==='pushed')pushed++;else if(outcome==='conflict')conflicts++;
    }
    return {pushed,conflicts};
  }
  async function pushProject(local,m){
    const id=String(local.id),sent=JSON.parse(JSON.stringify(local)),sentFp=projectFingerprint(sent);
    delete sent.rev;
    const baseRev=m&&!m.legacy?Number(m.rev)||0:0;
    try{
      const d=await api('/api/projects',{method:'POST',body:JSON.stringify({project:sent,baseRev})});
      const rev=Number(d.rev??d.project?.rev)||0;
      settlePushed(id,sentFp,d.project||sent,rev);
      clearLegacyPending(id);
      if(sameProjectId(id,state.currentProjectId))Promise.resolve(window.CRPParts?.syncCloudAudio?.(id)).catch(e=>console.warn('Cloud audio sync failed',e));
      return 'pushed';
    }catch(e){
      if(e.status!==409)throw e;
      return resolvePushConflict(id,sent,e.data||{});
    }
  }
  function settlePushed(id,sentFp,saved,rev){
    const meta=readSyncMeta(),current=findLocal(id);
    if(current&&projectFingerprint(current)===sentFp){
      // Store the server's copy (it may normalise the name) so both sides fingerprint the same.
      const merged={...current,...saved,rev},wasBase=sameProjectId(id,state.currentProjectId)&&editorBase.fp===sentFp;
      upsertLocal(merged);if(wasBase)noteEditorBase(merged);
      meta[id]={rev,fp:projectFingerprint(merged)};
    }else meta[id]={rev,fp:sentFp}; // edited again during the upload: stays dirty against the new rev
    writeSyncMeta(meta);
  }
  function resolvePushConflict(id,sent,data){
    if(data.code==='id_taken'){reIdProject(id);return 'retry';} // the id belongs to another account
    const meta=readSyncMeta(),local=findLocal(id)||sent;
    if(data.code==='deleted'){
      delete meta[id];writeSyncMeta(meta);
      if(Number(local.updatedAt||0)>Number(data.deletedAt||0)){
        reIdProject(id);
        showSyncNotice(`“${local.name}” was deleted on another device, but this device had newer changes, so it is kept as a separate song.`);
      }else dropLocalProject(id,`“${local.name}” was deleted on another device.`);
      return 'conflict';
    }
    const server=data.project;
    if(!server){const err=new Error(data.error||'This song changed on another device.');err.status=409;throw err;}
    const rev=Number(server.rev??server.updatedAt)||0;
    if(sameProjectId(id,state.currentProjectId))persistEditorLocally();
    const mine=findLocal(id)||local;
    if(projectFingerprint(server)===projectFingerprint(mine)){
      upsertLocal({...mine,...server});meta[id]={rev,fp:projectFingerprint(server)};writeSyncMeta(meta);return 'pushed';
    }
    // Keep both: the other device's version stays under the song's id; ours becomes a copy.
    const copy=asConflictCopy(mine);
    upsertLocal(copy);upsertLocal(server);
    meta[id]={rev,fp:projectFingerprint(server)};writeSyncMeta(meta);
    if(sameProjectId(id,state.currentProjectId))reloadOpenProject({quiet:true});
    showSyncNotice(`“${server.name}” was changed on another device. Both versions are kept: “${server.name}” has the other device's changes, and your changes are saved as “${copy.name}”.`);
    return 'conflict';
  }
  function reIdProject(oldId){
    const ps=localProjects(),i=ps.findIndex(p=>sameProjectId(p.id,oldId));if(i<0)return null;
    const newId=newProjectId(),p={...ps[i],id:newId,updatedAt:Date.now()};delete p.rev;delete p.createdAt;
    ps[i]=p;saveLocalProjects(ps);
    const meta=readSyncMeta();delete meta[oldId];writeSyncMeta(meta);
    if(sameProjectId(state.currentProjectId,oldId)){state.currentProjectId=newId;try{localStorage.setItem(ACTIVE_PROJECT_KEY,newId)}catch{}noteEditorBase(p);}
    moveSrpLink(oldId,newId);
    return p;
  }
  function moveSrpLink(oldId,newId){
    try{const links=srpLinks();if(links[oldId]){links[newId]={...links[oldId],crpProjectId:newId};delete links[oldId];setSrpLinks(links);}}catch{}
    try{const s=readStored(SRP_LINK_SESSION_KEY,null);if(s&&String(s.crpProjectId||'')===String(oldId)){s.crpProjectId=newId;writeStored(SRP_LINK_SESSION_KEY,s);}}catch{}
  }
  function dropLocalProject(id,message){
    removeLocal(id);
    const meta=readSyncMeta();delete meta[id];writeSyncMeta(meta);
    if(sameProjectId(state.currentProjectId,id))resetEditorToBlank();
    showSyncNotice(message);
  }
  // Fold a server listing into the working set. Never discards unsent local work.
  function mergeCloudSnapshot(remote,deleted){
    const meta=readSyncMeta(),deletes=readLocalDeletes(),legacy=readLegacyPending(),openId=String(state.currentProjectId||'');
    const byId=new Map(localProjects().map(p=>[String(p.id),p]));
    const tombs=new Map((deleted||[]).map(t=>[String(t.id),Number(t.deletedAt)||0]));
    const notices=[],keepAsCopy=[];let changed=0,openAction=null;
    for(const [id,deletedAt] of tombs){
      delete deletes[id];
      const local=byId.get(id);
      if(local){
        if(isDirty(local,meta[id],legacy)&&Number(local.updatedAt||0)>deletedAt){
          keepAsCopy.push(id);notices.push(`“${local.name}” was deleted on another device, but this device had newer changes, so it is kept as a separate song.`);
        }else{byId.delete(id);changed++;notices.push(`“${local.name}” was deleted on another device.`);if(id===openId)openAction='deleted';}
      }
      delete meta[id];
    }
    const remoteIds=new Set();
    for(const server of remote||[]){
      const id=String(server?.id||'');if(!id||tombs.has(id))continue;
      remoteIds.add(id);
      if(deletes[id])continue; // deleted here; the DELETE is on its way
      const rev=Number(server.rev??server.updatedAt)||0,serverFp=projectFingerprint(server),local=byId.get(id),m=meta[id];
      if(!local){byId.set(id,server);meta[id]={rev,fp:serverFp};changed++;continue;}
      if(!m||m.legacy){
        // First sync of a song this device already had from an older build.
        meta[id]={rev,fp:serverFp};
        if(projectFingerprint(local)===serverFp)continue;
        if(legacy[id]||Number(local.updatedAt||0)>Number(server.updatedAt||0))continue; // local is newer: it uploads against this rev
        byId.set(id,server);changed++;if(id===openId)openAction=openAction||'reload';
        continue;
      }
      if(isDirty(local,m,legacy))continue; // unsent local edits: the upload merges or makes a conflict copy
      if(rev!==Number(m.rev)||serverFp!==m.fp){byId.set(id,server);meta[id]={rev,fp:serverFp};changed++;if(id===openId)openAction=openAction||'reload';}
    }
    // Songs the server lost without a delete record are uploaded again.
    for(const id of byId.keys()){const m=meta[id];if(!remoteIds.has(id)&&m&&!m.legacy&&Number(m.rev)>0)meta[id]={rev:0,fp:''};}
    saveLocalProjects([...byId.values()]);writeSyncMeta(meta);writeLocalDeletes(deletes);
    keepAsCopy.forEach(reIdProject);
    if(openAction==='deleted')resetEditorToBlank();
    else if(openAction==='reload')reloadOpenProject();
    notices.forEach(showSyncNotice);
    return changed;
  }
  function reloadOpenProject({quiet=false}={}){
    const p=findLocal(state.currentProjectId);if(!p)return;
    if(window.CRPParts?.isPlaying?.()||state.playing){pendingEditorReload=true;return;}
    pendingEditorReload=false;
    loadProjectIntoEditor(p);
    if(!quiet)$('status').textContent=`“${p.name}” was updated with changes made somewhere else.`;
  }
  function scheduleCloudPull(delay=400){
    clearTimeout(cloudPullTimer);
    if(!canUpload()||document.visibilityState==='hidden')return;
    cloudPullTimer=setTimeout(()=>{if(Date.now()-lastPullAt>4000)syncWithCloud({pull:true}).catch(()=>{});},delay);
  }
  // Pulls happen on focus/visibility/online; this slow poll only runs while visible.
  function startCloudPolling(){
    clearInterval(cloudPollTimer);cloudPollTimer=null;
    if(!accountUser)return;
    cloudPollTimer=setInterval(()=>{if(document.visibilityState==='visible'&&Date.now()-lastPullAt>CLOUD_POLL_MS-2000)syncWithCloud({pull:true}).catch(()=>{});},CLOUD_POLL_MS);
  }
  async function syncNow(){
    if(!accountUser){$('authMessage').textContent='Log in to sync projects.';return;}
    const btn=$('syncNowBtn');if(btn){btn.disabled=true;btn.textContent='↻ Syncing…';}
    $('authMessage').textContent='Syncing this device with your cloud account…';
    try{
      clearTimeout(autoSaveTimer);autoSaveTimer=null;persistEditorLocally();
      const result=await syncWithCloud({pull:true});
      if(!result){$('authMessage').textContent='Sync is paused for this device (see the message at the top).';return;}
      $('authMessage').textContent=`Sync complete${result.pushed?` • uploaded ${result.pushed}`:''}${result.pulled?` • downloaded ${result.pulled}`:''}${result.conflicts?` • ${result.conflicts} kept as copies`:''}.`;
      $('status').textContent='Cloud sync complete.';
    }catch(e){$('authMessage').textContent=`Sync failed: ${e.message}`;}
    finally{if(btn){btn.disabled=false;btn.textContent='↻ Sync Now';}}
  }

  // --- Account ownership of the local working set -------------------------------
  // The songs on this device belong to one account. Signing in as someone else parks
  // them under a per-account key and restores that account's own songs instead, so
  // one person's songs are never uploaded into another person's account.
  function adoptWorkingSetFor(user){
    const uid=String(user.id),owner=localOwner();
    if(owner===uid)return 'same';
    if(owner===null){
      // Songs from an older build: they become this account's, but songs the server
      // does not know stay on this device until they are edited (as before).
      const meta=readSyncMeta();
      for(const p of localProjects()){const id=String(p.id);if(!meta[id])meta[id]={rev:0,fp:projectFingerprint(p),legacy:true};}
      writeSyncMeta(meta);setLocalOwner(uid);return 'claimed';
    }
    if(owner===''){setLocalOwner(uid);return 'claimed';} // made on this device while signed out
    stashWorkingSet(owner);restoreWorkingSet(uid);setLocalOwner(uid);
    return 'switched';
  }
  function stashWorkingSet(owner){
    const stash={savedAt:Date.now()};
    for(const k of WORKING_SET_KEYS){const v=localStorage.getItem(k);if(v!=null)stash[k]=v;}
    localStorage.setItem(ACCOUNT_STASH_PREFIX+owner,JSON.stringify(stash)); // throws when full: nothing is removed then
    for(const k of WORKING_SET_KEYS)localStorage.removeItem(k);
  }
  function restoreWorkingSet(uid){
    const stash=readStored(ACCOUNT_STASH_PREFIX+uid,null);if(!stash)return false;
    for(const k of WORKING_SET_KEYS)if(typeof stash[k]==='string')localStorage.setItem(k,stash[k]);
    localStorage.removeItem(ACCOUNT_STASH_PREFIX+uid);
    return true;
  }
  let sessionOwner=null;
  async function onSignedIn(user){
    accountUser=user;
    persistEditorLocally();
    try{
      if(adoptWorkingSetFor(user)==='switched')openWorkingSetEditor();
    }catch(e){
      console.error('Could not switch the local working set',e);
      setSaveProblem('cloud','this device still holds songs from another account and has no room to set them aside, so nothing was uploaded.');
    }
    sessionOwner=localOwner();
    showAccount();startCloudPolling();
    try{await syncWithCloud({pull:true});}catch{}
  }
  function openWorkingSetEditor(){
    clearTimeout(autoSaveTimer);autoSaveTimer=null;state.currentProjectId=null;state.draftId=null;
    const p=findLocal(localStorage.getItem(ACTIVE_PROJECT_KEY));
    if(p)loadProjectIntoEditor(p);else if(!restoreDraft({quiet:true}))resetEditorToBlank();
  }

  // --- Autosave ----------------------------------------------------------------
  let autoSaveTimer=null;
  function scheduleAutoSave(){
    // The hidden SRP playback bridge is strictly read-only.
    if(IS_PLAYBACK_BRIDGE)return;
    window.CRPParts?.syncActiveChord?.();
    window.CRPParts?.liveEditRefresh?.();
    publishSrpHandoff();
    if(!state.currentProjectId)unsavedProjectTouched=true;
    clearTimeout(autoSaveTimer);
    autoSaveTimer=setTimeout(runAutoSave,state.currentProjectId?850:600);
  }
  function runAutoSave(){
    clearTimeout(autoSaveTimer);autoSaveTimer=null;
    if(IS_PLAYBACK_BRIDGE)return;
    if(persistEditorLocally()&&state.currentProjectId)requestCloudPush();
  }
  function flushAutoSaveNow(){runAutoSave();}

  // --- Unsaved-work dialog (in-app navigation) ---------------------------------
  function ensureUnsavedProjectDialog(){
    let modal=document.getElementById('unsavedProjectExitDialog');if(modal)return modal;
    modal=document.createElement('div');modal.id='unsavedProjectExitDialog';modal.className='unsaved-project-dialog';modal.hidden=true;
    modal.innerHTML=`<div class="unsaved-project-backdrop"></div><div class="unsaved-project-card" role="dialog" aria-modal="true" aria-labelledby="unsavedProjectTitle"><h3 id="unsavedProjectTitle">Save this project?</h3><p>You have work in an unsaved project. Save it before leaving, continue without saving, or cancel and stay here.</p><label class="unsaved-project-name-label">Project name<input id="unsavedProjectNameInput" type="text" placeholder="Project name (optional)"></label><div class="unsaved-project-actions"><button type="button" data-cancel>Cancel</button><button type="button" data-continue>Continue Without Saving</button><button type="button" data-save class="accent">Save & Continue</button></div></div>`;
    document.body.appendChild(modal);
    const close=()=>{modal.hidden=true;modal._continue=null;};
    modal.querySelector('[data-cancel]').onclick=close;modal.querySelector('.unsaved-project-backdrop').onclick=close;
    // "Continue Without Saving" discards the unsaved work (editor and draft slot).
    modal.querySelector('[data-continue]').onclick=()=>{const fn=modal._continue;close();clearDraft();resetEditorToBlank();fn?.();};
    modal.querySelector('[data-save]').onclick=async()=>{
      const saveBtn=modal.querySelector('[data-save]'),buttons=[...modal.querySelectorAll('button')],name=modal.querySelector('#unsavedProjectNameInput')?.value.trim();if(name&&$('projectName'))$('projectName').value=name;
      buttons.forEach(b=>b.disabled=true);saveBtn.textContent='Saving…';
      try{await saveProject();const fn=modal._continue;if(state.currentProjectId){close();fn?.();}}
      finally{buttons.forEach(b=>b.disabled=false);saveBtn.textContent='Save & Continue';}
    };
    return modal;
  }
  function requestProjectExit(continueFn){
    if(!unsavedProjectHasWork()){continueFn?.();return;}
    const modal=ensureUnsavedProjectDialog(),input=modal.querySelector('#unsavedProjectNameInput');modal._continue=continueFn;modal.hidden=false;if(input){input.value=($('projectName')?.value||'').trim();requestAnimationFrame(()=>input.focus());}
  }
  // Clear the editor without touching storage (used by New, deletes and account switches).
  function resetEditorToBlank(){
    if(state.playing)stopProgression();
    clearTimeout(autoSaveTimer);autoSaveTimer=null;
    state.currentProjectId=null;state.draftId=null;
    try{localStorage.removeItem(ACTIVE_PROJECT_KEY);}catch{}
    state.rows=[[]];state.selectedRow=0;state.capo=0;state.neck='open';state.transpose=false;
    $('projectName').value='';$('chordInput').value='';$('keyInput').value='';$('keyInput').dataset.autoKey='1';
    $('bpmInput').value=92;$('beatsSelect').value=4;$('loopToggle').checked=true;$('notesEditor').innerHTML='';
    $('capoSelect').value='0';$('neckSelect').value='open';
    // A new project always starts with a blank beat.
    window.CRPBeatMaker?.loadProject?.(null);
    window.ScaleRider?.newProject?.();
    renderAll();syncBuildInput();renderFits();
    window.CRPParts?.newProject?.();
    unsavedProjectTouched=false;noteEditorBase(null);undoHistory.reset();renderProjects();
  }
  function performNewProject(){
    closeExportMenu?.();
    flushAutoSaveNow();clearDraft();resetEditorToBlank();
    $('status').textContent='New blank project.';
    $('projectName').focus();
  }
  function newProject(){requestProjectExit(performNewProject);}
  function restoreDraft({quiet=false}={}){
    const d=readDraft();if(!d)return false;
    loadProjectIntoEditor(d.project,{asDraft:true});
    unsavedProjectTouched=true;
    if(!quiet){
      const when=new Date(Number(d.savedAt)||Date.now()).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
      showSyncNotice(`Restored the unsaved song you were working on (last change ${when}). Tap Save to keep it in Projects.`);
    }
    return true;
  }

  function capture(id,name){
    const draft=readDraft(),existing=id?(findLocal(id)||(draft?.project&&sameProjectId(draft.project.id,id)?draft.project:null)):null;
    const liveBeat=window.CRPBeatMaker?.getBeat?.();
    // v3.3.63 — capture Baby DAW first, then make the project's top-level rows
    // mirror the exact loaded chord part that Baby DAW will restore. Previously
    // project.rows and project.parts.items[].data.rows could save two different
    // timing patterns; loadProject() then applied the stale parts copy over CRP.
    const partsPayload=window.CRPParts?.capture?.()||existing?.parts;
    let canonicalRows=state.rows;
    if(partsPayload?.items?.length){
      const loadedId=String(partsPayload.loadedChordPartId||'');
      const loaded=partsPayload.items.find(x=>x?.type==='chord'&&loadedId&&String(x.id)===loadedId)
        || partsPayload.items.find(x=>x?.type==='chord'&&x?.data?.rows);
      if(Array.isArray(loaded?.data?.rows))canonicalRows=loaded.data.rows;
    }
    const rowsCopy=JSON.parse(JSON.stringify(canonicalRows||[[]]));
    return{id:id||newProjectId(),name,updatedAt:Date.now(),archived:!!existing?.archived,instrument:state.instrument,mode:state.mode,sound:state.sound,octave:state.octave,capo:state.capo,neck:state.neck,transpose:state.transpose,rows:rowsCopy,bpm:clampBpm($('bpmInput').value),beats:+$('beatsSelect').value||4,loop:$('loopToggle').checked,notes:$('notesEditor').innerHTML,key:$('keyInput').value.trim(),beatMaker:liveBeat||existing?.beatMaker,beatMakerUpdatedAt:window.CRPBeatMaker?.getUpdatedAt?.()||existing?.beatMakerUpdatedAt||0,parts:partsPayload,scaleRider:window.ScaleRider?.capture?.()||null};
  }

  async function saveProject(){
    clearTimeout(autoSaveTimer);autoSaveTimer=null;
    if(state.cardView==='midi'){
      reflowMidiTimingFrom();
      window.CRPParts?.syncMidiTimelineFromCore?.();
    }
    // If navigation temporarily lost the in-memory id, recover the exact saved project
    // instead of creating a duplicate with a new UUID.
    if(!state.currentProjectId){
      const storedId=String(localStorage.getItem(ACTIVE_PROJECT_KEY)||'').trim();
      if(storedId&&findLocal(storedId))state.currentProjectId=storedId;
    }
    const name=($('projectName').value.trim()||defaultProjectName()).slice(0,160);
    $('projectName').value=name;
    const firstSave=!state.currentProjectId;
    if(firstSave){state.currentProjectId=state.draftId||newProjectId();noteEditorBase(null);}
    if(!persistEditorLocally()){
      if(firstSave)state.currentProjectId=null;
      $('status').textContent='Not saved — see the message at the top of the page.';return;
    }
    try{localStorage.setItem(ACTIVE_PROJECT_KEY,String(state.currentProjectId));}catch{}
    if(firstSave)clearDraft();
    unsavedProjectTouched=false;publishSrpHandoff();renderProjects();
    if(!canUpload()){$('status').textContent=`Saved “${name}” on this device.`;return;}
    $('status').textContent=`Saved “${name}” on this device. Uploading…`;
    try{await syncWithCloud({pull:false});$('status').textContent=`Saved “${name}” to your cloud account.`;}
    catch(e){$('status').textContent=`Saved “${name}” on this device; cloud upload failed (${e.message}).`;}
  }
  let projectBrowserMode='projects';

  function sameProjectId(a,b){
    const aa=String(a??'').trim(),bb=String(b??'').trim();
    return !!aa&&!!bb&&aa===bb;
  }

  function restoreActiveProjectFromStorage(){
    try{
      if(state.currentProjectId)return true;
      const id=String(localStorage.getItem(ACTIVE_PROJECT_KEY)||'').trim();
      if(!id)return false;
      if(!findLocal(id)){localStorage.removeItem(ACTIVE_PROJECT_KEY);return false;}
      loadProject(id);
      return true;
    }catch(err){console.error('Could not restore active CRP project',err);return false;}
  }

  function setProjectBrowserMode(mode){
    projectBrowserMode=mode==='archive'?'archive':'projects';
    renderProjects();
    const win=document.querySelector('.project-browser-window');
    if(win)win.scrollTop=0;
  }

  function setProjectArchived(project,archived){
    const cur=findLocal(project.id);if(!cur)return;
    const p={...cur,archived:!!archived,updatedAt:Date.now()};
    try{writeProjectHere(p);clearSaveProblem('local');}catch(e){setSaveProblem('local',localSaveReason(e));return;}
    renderProjects();requestCloudPush();
    $('status').textContent=archived?`“${p.name}” moved to Archive.`:`“${p.name}” restored to Projects.`;
  }
  // Older builds left an emergency copy per song when switching to Song Rider Pro.
  // Use it once if it is newer than the stored song, then remove it.
  const CRP_NAV_SNAPSHOT_PREFIX='crp-nav-snapshot-v1:';
  function adoptLegacyNavSnapshot(project){
    const key=CRP_NAV_SNAPSHOT_PREFIX+String(project.id);
    try{
      const snap=readStored(key,null);if(!snap)return project;
      localStorage.removeItem(key);
      if(String(snap.id||'')!==String(project.id)||Number(snap.updatedAt||0)<=Number(project.updatedAt||0))return project;
      const merged={...project,...snap};upsertLocal(merged);return merged;
    }catch{return project;}
  }
  function loadProjectIntoEditor(p,{asDraft=false}={}){
    if(!asDraft)p=adoptLegacyNavSnapshot(p);
    const stored=p;
    // A linked Song Rider Pro session owns the live BPM/capo/octave/key for its song.
    const session=asDraft?null:readSrpLinkSession();
    const shared=(session&&String(session.crpProjectId||'')===String(p.id))?readSharedSrpMeta(p.id):null;
    if(shared)p={...p,bpm:Number.isFinite(Number(shared.bpm))?Number(shared.bpm):p.bpm,capo:Number.isFinite(Number(shared.capo))?Number(shared.capo):p.capo,octave:Number.isFinite(Number(shared.octave))?Number(shared.octave):p.octave,transpose:typeof shared.transpose==='boolean'?shared.transpose:p.transpose,key:String(shared.key??p.key??'')};
    clearTimeout(autoSaveTimer);autoSaveTimer=null;
    state.currentProjectId=asDraft?null:p.id;state.draftId=asDraft?p.id:null;unsavedProjectTouched=false;
    if(!asDraft){try{localStorage.setItem(ACTIVE_PROJECT_KEY,String(p.id));}catch{}}
    state.instrument=normalizeInstrument(p.instrument);state.mode=p.mode||'chord';state.sound=(SOUNDS[state.instrument]||SOUNDS.piano).some(x=>x[0]===p.sound)?p.sound:SOUNDS[state.instrument][0][0];state.octave=p.octave||0;state.capo=p.capo||0;state.neck=['open','triad','barre','power','shell','inversion','color'].includes(p.neck)?p.neck:'open';state.transpose=!!p.transpose;
    state.rows=JSON.parse(JSON.stringify(p.rows||[(p.chords||[]).map(v=>({type:'chord',value:v}))]));if(!state.rows.length)state.rows=[[]];state.selectedRow=0;
    $('projectName').value=p.name||'';$('bpmInput').value=clampBpm(p.bpm);$('beatsSelect').value=p.beats||4;$('loopToggle').checked=p.loop!==false;$('notesEditor').innerHTML=p.notes||'';$('capoSelect').value=state.capo;$('neckSelect').value=state.neck;$('keyInput').value=p.key||'';$('keyInput').dataset.autoKey=p.key?'0':'1';
    renderAll();syncBuildInput();autoPopulateKeyFromEntry();
    window.CRPBeatMaker?.loadProject?.(p);window.CRPParts?.loadProject?.(p);window.ScaleRider?.loadProject?.(p);
    noteEditorBase(asDraft?null:stored);undoHistory.reset();
    renderProjects();
    if(shared&&TRANSPORT_FIELDS.some(k=>String(shared[k]??stored[k]??'')!==String(stored[k]??'')))scheduleAutoSave();
  }
  function performLoadProject(id){
    if(state.currentProjectId&&!sameProjectId(state.currentProjectId,id))flushAutoSaveNow();
    const p=findLocal(id);if(!p)return;
    loadProjectIntoEditor(p);
    // v3.3.49 — opening a project pins it to the top of the browser.
    requestAnimationFrame(()=>{const win=document.querySelector('.project-browser-window');if(win)win.scrollTop=0;});
  }
  function loadProject(id){if(sameProjectId(state.currentProjectId,id)){performLoadProject(id);return;}requestProjectExit(()=>performLoadProject(id));}
  // Another tab (or Song Rider Pro) wrote crp-projects.
  function onProjectsChangedElsewhere(){
    if(sessionOwner!==null&&localOwner()!==sessionOwner){location.reload();return;} // account switched in another tab
    renderProjects();
    const id=state.currentProjectId;if(!id)return;
    const stored=findLocal(id);
    if(!stored){if(readLocalDeletes()[String(id)])detachDeletedEditor();return;}
    if(projectFingerprint(stored)===editorBase.fp)return;
    if(autoSaveTimer)return; // the pending autosave reconciles both versions
    if(contentFingerprint(stored)===editorBase.contentFp){applyTransportFrom(stored);noteEditorBase(stored);return;}
    reloadOpenProject();
  }
  function applyTransportFrom(p){
    if(document.activeElement!==$('bpmInput'))$('bpmInput').value=clampBpm(p.bpm);
    state.capo=Number(p.capo)||0;state.octave=Number(p.octave)||0;state.transpose=!!p.transpose;
    $('capoSelect').value=String(state.capo);
    if(document.activeElement!==$('keyInput')){$('keyInput').value=p.key||'';$('keyInput').dataset.autoKey=p.key?'0':'1';}
    renderAll();window.CRPParts?.syncCoreLive?.();
  }

  function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));}
  function renameProjectRecord(p){
    if(!p)return;
    const n=prompt('New project name:',p.name);
    if(!n?.trim())return;
    const name=n.trim().slice(0,160);
    if(sameProjectId(state.currentProjectId,p.id)){$('projectName').value=name;flushAutoSaveNow();}
    else{
      const cur=findLocal(p.id);if(!cur)return;
      try{writeProjectHere({...cur,name,updatedAt:Date.now()});clearSaveProblem('local');}catch(e){setSaveProblem('local',localSaveReason(e));return;}
      requestCloudPush();
    }
    renderProjects();$('status').textContent=`Renamed to “${name}”.`;
  }
  function renameLoadedProject(){
    const id=state.currentProjectId;
    if(!id){$('status').textContent='Open or save a project before renaming it.';return;}
    const p=findLocal(id);
    if(!p){$('status').textContent='Loaded project could not be found.';return;}
    renameProjectRecord(p);
  }
  function deleteProjectRecord(p){
    if(!confirm(`Delete “${p.name}”?`))return;
    const id=String(p.id);
    try{
      removeLocal(id);
      const meta=readSyncMeta(),known=!!meta[id];delete meta[id];writeSyncMeta(meta);
      // Remember the delete until the server confirms it, so a pull cannot bring it back.
      if(known||accountUser||localOwner()===null){const d=readLocalDeletes();d[id]=Date.now();writeLocalDeletes(d);}
      clearLegacyPending(id);clearSaveProblem('local');
    }catch(e){setSaveProblem('local',localSaveReason(e));return;}
    if(sameProjectId(state.currentProjectId,id))resetEditorToBlank();
    renderProjects();$('status').textContent=`Deleted “${p.name}”.`;
    requestCloudPush();
  }
  function renderProjects(){
    const w=$('projectList');if(!w)return;
    const all=localProjects().sort((a,b)=>{
      const ac=sameProjectId(state.currentProjectId,a?.id),bc=sameProjectId(state.currentProjectId,b?.id);
      if(ac!==bc)return ac?-1:1;
      return (b.updatedAt||0)-(a.updatedAt||0);
    });
    const active=all.filter(p=>!p.archived), archived=all.filter(p=>!!p.archived);
    const ps=projectBrowserMode==='archive'?archived:active;
    const meta=accountUser?readSyncMeta():null,legacy=accountUser?readLegacyPending():null;

    $('projectStorageLabel').textContent=accountUser?'Synced to your cloud account':'Saved on this device';
    if($('projectsCount'))$('projectsCount').textContent=String(active.length);
    if($('archiveCount'))$('archiveCount').textContent=String(archived.length);
    $('projectsTabBtn')?.classList.toggle('active',projectBrowserMode==='projects');
    $('archiveTabBtn')?.classList.toggle('active',projectBrowserMode==='archive');
    $('projectsTabBtn')?.setAttribute('aria-selected',String(projectBrowserMode==='projects'));
    $('archiveTabBtn')?.setAttribute('aria-selected',String(projectBrowserMode==='archive'));

    w.innerHTML=ps.length?'':`<div class="project-empty subtle">${projectBrowserMode==='archive'?'No archived projects yet.':'No active projects yet.'}</div>`;
    ps.forEach(p=>{
      const e=document.createElement('div');
      e.className='project-item'+(sameProjectId(state.currentProjectId,p.id)?' current':'');
      const count=p.rows?p.rows.flat().length:(p.chords||[]).length;
      const m=meta?.[String(p.id)],syncLabel=!meta?'':(m?.legacy&&!isDirty(p,m,legacy)?' • on this device only':(isDirty(p,m,legacy)?' • not uploaded yet':''));
      const moveLabel=projectBrowserMode==='archive'?'Restore':'Archive';
      e.innerHTML=`<div class="name">${esc(p.name)}</div><div class="meta">${count} cards${syncLabel}</div><button class="open" type="button">Open</button><button class="rename" type="button">Rename</button><button class="archive-toggle" type="button">${moveLabel}</button><button class="delete" type="button">Delete</button>`;
      e.querySelector('.open').onclick=()=>loadProject(p.id);
      e.querySelector('.rename').onclick=()=>renameProjectRecord(p);
      e.querySelector('.archive-toggle').onclick=()=>setProjectArchived(p,projectBrowserMode!=='archive');
      e.querySelector('.delete').onclick=()=>deleteProjectRecord(p);
      w.appendChild(e);
    });
  }
  function showAccount(){const logged=!!accountUser;const panel=$('accountPanel');panel?.classList.toggle('is-logged-in',logged);$('accountSummaryBtn').hidden=!logged;$('authForms').hidden=logged;$('accountTools').hidden=!logged;$('logoutBtn').hidden=!logged;$('accountStatus').textContent=logged?`Signed in as ${accountDisplayName()}`:'Not signed in — local projects still work.';$('projectStorageLabel').textContent=logged?'Synced to your cloud account':'Saved on this device';if(logged){updateAccountSummary();setAccountCollapsed(true);}else{setAccountCollapsed(false);cloudSyncState='idle';clearSaveProblem('cloud');}renderProjects();try{window.dispatchEvent(new CustomEvent('srs-auth-changed',{detail:{loggedIn:logged}}));}catch{}}
  async function checkAccount(){let user=null;try{user=(await api('/api/auth/me')).user||null;}catch{}if(user)await onSignedIn(user);else{accountUser=null;showAccount();}}
  async function login(){try{const d=await api('/api/auth/login',{method:'POST',body:JSON.stringify({email:$('loginEmail').value,password:$('loginPassword').value})});$('loginPassword').value='';$('authMessage').textContent='Logged in. Syncing projects…';await onSignedIn(d.user);$('authMessage').textContent=cloudSyncState==='error'?'Logged in, but cloud sync is not available right now.':'Cloud sync ready.';}catch(e){$('authMessage').textContent=e.message;}}
  async function register(){try{const d=await api('/api/auth/register',{method:'POST',body:JSON.stringify({displayName:$('registerName').value,email:$('registerEmail').value,password:$('registerPassword').value,inviteCode:$('inviteCode').value})});$('registerPassword').value=$('inviteCode').value='';$('authMessage').textContent='Account created. Your projects can now sync.';await onSignedIn(d.user);}catch(e){$('authMessage').textContent=e.message;}}
  async function logout(){
    flushAutoSaveNow();
    try{await syncWithCloud({pull:false});}catch{} // best effort: upload before signing out
    try{await api('/api/auth/logout',{method:'POST',body:'{}'});}catch{}
    accountUser=null;cloudSyncState='idle';startCloudPolling();showAccount();setAccountCollapsed(false);
    $('authMessage').textContent='Logged out. Your songs stay on this device.';
  }
  async function changePassword(){const currentPassword=prompt('Current password:');if(currentPassword===null)return;const newPassword=prompt('New password (8+ characters):');if(newPassword===null)return;try{await api('/api/auth/password',{method:'POST',body:JSON.stringify({currentPassword,newPassword})});$('authMessage').textContent='Password changed successfully.';}catch(e){$('authMessage').textContent=e.message;}}


  // v2.6 — export the current project as a CRP-styled chord sheet.
  function exportFileName(ext){
    const raw=$('projectName').value.trim()||'Chord-Rider-Pro';
    const safe=raw.replace(/[\\/:*?"<>|]+/g,'-').replace(/\s+/g,' ').trim()||'Chord-Rider-Pro';
    return `${safe} - Chord Sheet.${ext}`;
  }
  function exportKeyLabel(){
    const raw=$('keyInput').value.trim();
    if(raw&&enteredKey())return raw;
    const k=activeKey();
    return `${k.root}${k.minor?'m':''}`;
  }
  function uniqueUsedValues(){
    const seen=new Set(),out=[];
    state.rows.flat().forEach(card=>{const v=displayedValue(card);if(!seen.has(v)){seen.add(v);out.push(v);}});
    return out;
  }
  function guitarVoicingLabel(){
    const labels={open:'Open / Easy',triad:'Triad',barre:'Barre Chord',power:'Power Chord',shell:'Shell Voicing',inversion:'1st Inversion',color:'Color / Extended'};
    return labels[state.neck]||labels.open;
  }
  function makeMetaChip(text){const e=document.createElement('span');e.className='export-meta-chip';e.textContent=text;return e;}
  function exportGrid(title, rows, columns, activeByRow){
    if(!rows.length)return null;
    const sec=document.createElement('div');sec.className='export-grid-block';
    const h=document.createElement('div');h.className='export-part-label';h.textContent=title;sec.appendChild(h);
    const wrap=document.createElement('div');wrap.className='export-grid-wrap';
    const table=document.createElement('table');table.className='export-seq-grid';
    const cg=document.createElement('colgroup');cg.innerHTML='<col class="label-col">'+columns.map(()=>'<col class="step-col">').join('');table.appendChild(cg);
    const head=document.createElement('tr');head.innerHTML='<th class="row-label"></th>'+columns.map((c,i)=>`<th class="${String(c).match(/^\d/) ? 'beat-key' : 'sub-key'}">${esc(c)}</th>`).join('');table.appendChild(head);
    rows.forEach(r=>{const tr=document.createElement('tr');tr.innerHTML=`<th class="row-label">${esc(r)}</th>`+columns.map((_,i)=>`<td class="${activeByRow(r,i)?'hit':''}">${activeByRow(r,i)?'●':''}</td>`).join('');table.appendChild(tr);});
    wrap.appendChild(table);sec.appendChild(wrap);return sec;
  }
  function drumGridForBar(db,bar){
    if(!db?.enabled)return null;
    const labels={kick1:'Kick 1',kick2:'Kick 2',kick3:'Kick 3',snare1:'Snare 1',snare2:'Snare 2',snare3:'Snare 3',snare4:'Snare 4',snare5:'Snare 5',chh:'Closed HH',ohh:'Open HH',tomHi:'High Tom',tomMid:'Mid Tom',tomLow:'Low Tom',clap:'Clap',rim:'Rim',shaker:'Shaker',tamb:'Tambourine',cowbell:'Cowbell',conga:'Conga'};
    const bi=(bar%Math.max(1,db.bars||1));
    const used=Object.entries(db.tracks||{}).filter(([id,bars])=>(bars[bi]||[]).length);
    if(!used.length)return null;
    const res=[8,16,32,64].includes(+db.resolution)?+db.resolution:16,stride=64/res;
    const spb=res/4,sub16=['1','e','&','a'];const cols=Array.from({length:res},(_,i)=>{const pos=i%spb,beat=Math.floor(i/spb)+1;if(pos===0)return String(beat);if(spb===2)return '&';if(spb===4)return sub16[pos];return pos===spb/2?'&':String(pos+1);});
    const hitsets=Object.fromEntries(used.map(([id,bars])=>[labels[id]||id,new Set(bars[bi]||[])]));
    return exportGrid(`Drums — Bar ${bi+1}`,Object.keys(hitsets),cols,(r,i)=>hitsets[r].has(i*stride));
  }
  function leadGridForBar(part,bar){
    const res=+part.resolution||16,bi=bar%Math.max(1,+part.bars||1),start=bi*res,end=start+res;
    const durSteps=e=>Math.max(1,Math.round(Number(e?.durationSteps)||1));
    const ev=(part.events||[]).filter(e=>e.step<end&&e.step+durSteps(e)>start);
    if(!ev.length)return null;
    const nn=n=>['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'][((n%12)+12)%12]+(Math.floor(n/12)-1);
    const notes=[...new Set(ev.map(e=>nn(e.midi+(part.octave||0)*12)))].sort((a,b)=>{const m=x=>{const z=x.match(/^([A-G])(#?)(-?\d+)$/),pc={C:0,D:2,E:4,F:5,G:7,A:9,B:11}[z[1]]+(z[2]?1:0);return (+z[3]+1)*12+pc};return m(b)-m(a)});
    const sets=Object.fromEntries(notes.map(n=>[n,new Set()]));
    ev.forEach(e=>{const key=nn(e.midi+(part.octave||0)*12),a=Math.max(start,e.step),z=Math.min(end,e.step+durSteps(e));for(let step=a;step<z;step++)sets[key].add(step-start);});
    const spb=res/4,sub16=['1','e','&','a'];const cols=Array.from({length:res},(_,i)=>{const pos=i%spb,beat=Math.floor(i/spb)+1;if(pos===0)return String(beat);if(spb===2)return '&';if(spb===4)return sub16[pos];return pos===spb/2?'&':String(pos+1);});
    return exportGrid(`${part.name} — Bar ${bi+1}`,notes,cols,(r,i)=>sets[r].has(i));
  }
  function chordMidiBlockForLine(part,lineIndex){
    const row=part.data?.rows?.[lineIndex]||[];if(!row.length)return null;
    const cards=row.map(card=>({card,duration:cardDurationBeats(card,part.data?.beats||+$('beatsSelect').value||4),notes:(coreNotesFor(card,part.data)||[]).map(n=>({name:n,midi:midiOf(n)})).filter(n=>n.midi!=null)}));
    const all=[...new Set(cards.flatMap(x=>x.notes.map(n=>n.midi)))].sort((a,b)=>b-a);if(!all.length)return null;
    const sec=document.createElement('div');sec.className='export-grid-block export-chord-midi-block';
    const h=document.createElement('div');h.className='export-part-label';h.textContent=`${part.name} — MIDI`;sec.appendChild(h);
    const wrap=document.createElement('div');wrap.className='export-midi-roll-wrap';
    const grid=document.createElement('div');grid.className='export-midi-roll';
    grid.style.gridTemplateColumns=`70px ${cards.map(x=>`${Math.max(.25,x.duration)}fr`).join(' ')}`;
    const corner=document.createElement('div');corner.className='export-midi-corner';corner.textContent='Note';grid.appendChild(corner);
    cards.forEach(({card,duration})=>{const el=document.createElement('div');el.className='export-midi-head';el.innerHTML=`<strong>${esc(displayedValue(card))}</strong><span>${esc(formatBeatDuration(duration))}b</span>`;grid.appendChild(el);});
    all.forEach(m=>{const label=document.createElement('div');label.className='export-midi-note';label.textContent=noteAtMidi(m);grid.appendChild(label);cards.forEach(({notes,duration})=>{const cell=document.createElement('div');cell.className='export-midi-cell'+(notes.some(n=>n.midi===m)?' on':'');cell.style.setProperty('--duration-beats',String(duration));grid.appendChild(cell);});});
    wrap.appendChild(grid);sec.appendChild(wrap);return sec;
  }
  function chordBlockForLine(part,lineIndex){
    const row=part.data?.rows?.[lineIndex]||[];if(!row.length)return null;
    const sec=document.createElement('div');sec.className='export-chord-block export-aligned-chords';
    const h=document.createElement('div');h.className='export-part-label';h.textContent=part.name;sec.appendChild(h);

    // Use the SAME left label gutter as the drum/lead grids, then divide the
    // musical lane into equal beat/bar slots. This keeps chord boundaries
    // vertically aligned with 1 / 2 / 3 / 4 above every sequencer grid.
    const lane=document.createElement('div');lane.className='export-chord-lane';
    const gutter=document.createElement('div');gutter.className='export-chord-gutter';lane.appendChild(gutter);
    const slots=document.createElement('div');slots.className='export-chord-slots';
    slots.style.setProperty('--slot-count',String(Math.max(1,row.length)));

    const canDiagram=(part.id===window.CRPParts?.getActiveChordId?.() || (!window.CRPParts?.getActiveChordId && lineIndex<state.rows.length));
    row.forEach(card=>{
      const cell=document.createElement('div');cell.className='export-chord-slot';
      const shown=displayedValue(card),sub=subtitle(card);
      cell.innerHTML=`<div class="export-card-name">${card.type==='note'?'♪ ':''}${esc(shown)}</div><div class="export-card-subtitle">${esc(sub||' ')}</div>${canDiagram?`<div class="diagram">${state.instrument==='guitar'?guitarSvg(card):pianoSvg(card)}</div>`:''}`;
      slots.appendChild(cell);
    });
    lane.appendChild(slots);sec.appendChild(lane);
    return sec;
  }
  function buildExportSheet(selection={}){
    const bad=commitBuildInput();if(bad.length)$('status').textContent=`Skipped unrecognized: ${bad.join(', ')}`;
    syncBuildInput();autoPopulateKeyFromEntry();renderAll();
    const exportParts=window.CRPParts?.getExportData?.()||[];
    const selectedIds=new Set(selection.partIds||exportParts.filter(p=>p.enabled!==false).map(p=>p.id));
    const selectedParts=exportParts.filter(p=>selectedIds.has(p.id));
    if(!selectedParts.length&&!selection.drums&&!selection.notes)throw new Error('Choose at least one part to export.');
    const stage=$('exportStage');stage.innerHTML='';const sheet=document.createElement('section');sheet.className='export-sheet';
    const projectName=$('projectName').value.trim()||'Untitled Chord Project',keyLabel=exportKeyLabel(),bpm=Math.max(40,Math.min(240,+$('bpmInput').value||92)),beats=+$('beatsSelect').value||4;
    const header=document.createElement('header');header.className='export-sheet-header';header.innerHTML=`<div class="export-sheet-title-row"><div><h1>${esc(projectName)}</h1><div class="export-sheet-subtitle">Chord Rider Pro song blueprint</div></div><div class="export-sheet-key">Key ${esc(keyLabel)}</div></div>`;
    const meta=document.createElement('div');meta.className='export-meta-grid';meta.append(makeMetaChip(`${bpm} BPM`),makeMetaChip(`${beats} beat${beats===1?'':'s'} / chord`));header.appendChild(meta);sheet.appendChild(header);
    const chordParts=selectedParts.filter(p=>p.type==='chord'),leadParts=selectedParts.filter(p=>p.type==='lead'&&!/bass/i.test(p.name||'')&&p.sound!=='electric_bass_finger'),bassParts=selectedParts.filter(p=>p.type==='lead'&&(/bass/i.test(p.name||'')||p.sound==='electric_bass_finger')),vocals=selectedParts.filter(p=>p.type==='vocal');
    const db=selection.drums?window.CRPBeatMaker?.getBeat?.():null;
    const maxLines=Math.max(1,...chordParts.map(p=>p.data?.rows?.length||0),...leadParts.map(p=>p.bars||0),...bassParts.map(p=>p.bars||0),db?.bars||0);
    for(let li=0;li<maxLines;li++){
      const line=document.createElement('section');line.className='export-line export-song-line';line.innerHTML=`<div class="export-line-heading"><strong>Line ${li+1}</strong></div>`;
      const dg=drumGridForBar(db,li);if(dg)line.appendChild(dg);
      vocals.forEach(v=>{if(!v.transcript?.trim())return;let text=v.transcript;const words=Array.isArray(v.transcriptWords)?v.transcriptWords:[];if(words.length){const barSec=4*60/bpm,start=li*barSec,end=(li+1)*barSec;const timed=words.filter(w=>{const a=Number(w.start??w.start_time??w.begin??0),z=Number(w.end??w.end_time??a);return z>start&&a<end;}).map(w=>String(w.word??w.text??'').trim()).filter(Boolean);text=timed.join(' ').replace(/\s+/g,' ').trim();if(!text)return;}else if(li>0)return;const b=document.createElement('div');b.className='export-vocal-block';b.innerHTML=`<div class="export-part-label">${esc(v.name)}</div><div class="export-lyrics">${esc(text)}</div>`;line.appendChild(b)});
      leadParts.forEach(p=>{const g=leadGridForBar(p,li);if(g)line.appendChild(g)});
      bassParts.forEach(p=>{const g=leadGridForBar(p,li);if(g)line.appendChild(g)});
      chordParts.forEach(p=>{const c=state.cardView==='midi'?chordMidiBlockForLine(p,li):chordBlockForLine(p,li);if(c)line.appendChild(c)});
      sheet.appendChild(line);
    }
    if(selection.notes){const notes=$('notesEditor').innerHTML.trim();if(notes&&$('notesEditor').textContent.trim()){const n=document.createElement('section');n.className='export-notes';n.innerHTML=`<h3>Project notes</h3><div class="export-notes-body">${notes}</div>`;sheet.appendChild(n)}}
    const footer=document.createElement('footer');footer.className='export-sheet-footer';footer.innerHTML=`<img src="assets/rider-and-bones-left-still.png" alt="Rider and Bones"><span>Created with Chord Rider Pro</span>`;sheet.appendChild(footer);stage.appendChild(sheet);return sheet;
  }
  async function waitForExportImages(root){
    const imgs=[...root.querySelectorAll('img')];
    await Promise.all(imgs.map(img=>img.complete?Promise.resolve():new Promise(resolve=>{img.onload=img.onerror=resolve;})));
  }
  // PDF/PNG export libraries are only fetched the first time someone exports.
  const exportScripts={};
  function loadExportScript(src,ready){
    if(ready())return Promise.resolve();
    return exportScripts[src]||(exportScripts[src]=new Promise((resolve,reject)=>{
      const el=document.createElement('script');el.src=src;el.async=true;
      el.onload=()=>ready()?resolve():reject(new Error('Export tools did not load.'));
      el.onerror=()=>{delete exportScripts[src];el.remove();reject(new Error('Export tools did not load. Check your connection and try again.'));};
      document.head.appendChild(el);
    }));
  }
  const loadHtml2canvas=()=>loadExportScript('vendor/html2canvas.min.js?v=1.4.1',()=>typeof window.html2canvas==='function');
  const loadJsPdf=()=>loadExportScript('vendor/jspdf.umd.min.js?v=2.5.1',()=>!!window.jspdf?.jsPDF);
  async function captureExportSheet(forPdf=false,selection={}){
    await loadHtml2canvas();
    const sheet=buildExportSheet(selection);sheet.classList.toggle('pdf-print',forPdf);await waitForExportImages(sheet);
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    const bounds=sheet.getBoundingClientRect();
    const breaks=[...sheet.querySelectorAll('.export-sheet-header,.export-line,.export-notes,.export-sheet-footer')]
      .map(el=>Math.round(el.getBoundingClientRect().bottom-bounds.top));
    const canvas=await html2canvas(sheet,{backgroundColor:forPdf?'#ffffff':'#f7f5ef',scale:2,useCORS:true,logging:false});
    return{sheet,canvas,breaks};
  }
  function downloadDataUrl(dataUrl,name){const a=document.createElement('a');a.href=dataUrl;a.download=name;document.body.appendChild(a);a.click();a.remove();}
  async function exportPng(selection={}){
    closeExportMenu();$('status').textContent='Creating PNG chord sheet…';
    try{const {canvas}=await captureExportSheet(false,selection);downloadDataUrl(canvas.toDataURL('image/png'),exportFileName('png'));$('status').textContent='PNG chord sheet exported.';}
    catch(e){$('status').textContent=e.message||'Could not export PNG.';}
  }
  function closePngExport(){document.getElementById('pngExportModal')?.remove();}
  function openPngExport(){
    closeExportMenu();closePngExport();const parts=window.CRPParts?.getExportData?.()||[];
    const rows=parts.map(p=>`<label class="studio-export-row"><input type="checkbox" data-png-part="${p.id}" ${p.enabled===false?'':'checked'}><span><strong>${esc(p.name)}</strong><br><span class="subtle tiny">${p.type==='chord'?'Chord / Note':p.type==='lead'?'Lead / Bass':'Vocals'}</span></span></label>`).join('');
    const modal=document.createElement('div');modal.id='pngExportModal';modal.className='studio-export-modal';modal.innerHTML=`<div class="studio-export-backdrop"></div><div class="studio-export-card"><h2>PNG song blueprint</h2><p class="subtle">Choose exactly what appears in the image. Each Line is grouped as Drums → Vocals → Lead → Bass → Chords.</p><div class="studio-export-list">${rows}<label class="studio-export-row"><input id="pngExportDrums" type="checkbox" checked><span><strong>Drums</strong><br><span class="subtle tiny">Visual pattern grid</span></span></label><label class="studio-export-row"><input id="pngExportNotes" type="checkbox"><span><strong>Project notes</strong><br><span class="subtle tiny">Only included when checked</span></span></label></div><div class="studio-export-actions"><button id="pngExportCancel" type="button">Cancel</button><button id="pngExportGo" class="accent" type="button">Create PNG</button></div></div>`;
    document.body.appendChild(modal);modal.querySelector('.studio-export-backdrop').onclick=closePngExport;modal.querySelector('#pngExportCancel').onclick=closePngExport;modal.querySelector('#pngExportGo').onclick=()=>{const partIds=[...modal.querySelectorAll('[data-png-part]:checked')].map(x=>x.dataset.pngPart);const selection={partIds,drums:modal.querySelector('#pngExportDrums').checked,notes:modal.querySelector('#pngExportNotes').checked};closePngExport();exportPng(selection)};
  }
  function closePdfExport(){document.getElementById('pdfExportModal')?.remove();}
  function openPdfExport(){
    closeExportMenu();closePdfExport();const parts=window.CRPParts?.getExportData?.()||[];
    const rows=parts.map(p=>`<label class="studio-export-row"><input type="checkbox" data-pdf-part="${p.id}" ${p.enabled===false?'':'checked'}><span><strong>${esc(p.name)}</strong><br><span class="subtle tiny">${p.type==='chord'?'Chord / Note':p.type==='lead'?'Lead / Bass':'Vocals'}</span></span></label>`).join('');
    const modal=document.createElement('div');modal.id='pdfExportModal';modal.className='studio-export-modal';modal.innerHTML=`<div class="studio-export-backdrop"></div><div class="studio-export-card"><h2>PDF song blueprint</h2><p class="subtle">Choose exactly what appears in the PDF. Each Line is grouped as Drums → Vocals → Lead → Bass → Chords.</p><div class="studio-export-list">${rows}<label class="studio-export-row"><input id="pdfExportDrums" type="checkbox" checked><span><strong>Drums</strong><br><span class="subtle tiny">Visual pattern grid</span></span></label><label class="studio-export-row"><input id="pdfExportNotes" type="checkbox"><span><strong>Project notes</strong><br><span class="subtle tiny">Only included when checked</span></span></label></div><div class="studio-export-actions"><button id="pdfExportCancel" type="button">Cancel</button><button id="pdfExportGo" class="accent" type="button">Create PDF</button></div></div>`;
    document.body.appendChild(modal);modal.querySelector('.studio-export-backdrop').onclick=closePdfExport;modal.querySelector('#pdfExportCancel').onclick=closePdfExport;modal.querySelector('#pdfExportGo').onclick=()=>{const partIds=[...modal.querySelectorAll('[data-pdf-part]:checked')].map(x=>x.dataset.pdfPart);const selection={partIds,drums:modal.querySelector('#pdfExportDrums').checked,notes:modal.querySelector('#pdfExportNotes').checked};closePdfExport();exportPdf(selection)};
  }
  async function exportPdf(selection={}){
    $('status').textContent='Creating PDF song blueprint…';
    try{
      await loadJsPdf();
      const {canvas,breaks}=await captureExportSheet(true,selection),{jsPDF}=window.jspdf;
      const pdf=new jsPDF({orientation:'portrait',unit:'pt',format:'letter',compress:true});
      const pageW=pdf.internal.pageSize.getWidth(),pageH=pdf.internal.pageSize.getHeight(),margin=18,drawW=pageW-margin*2,drawH=pageH-margin*2;
      const scale=canvas.width/1120,idealSliceCss=(drawH/(drawW/canvas.width))/scale;let topCss=0,page=0,totalCss=canvas.height/scale;
      while(topCss<totalCss-1){const limit=Math.min(totalCss,topCss+idealSliceCss),candidates=breaks.filter(y=>y>topCss+idealSliceCss*.35&&y<=limit+1),bottomCss=(limit>=totalCss-1)?totalCss:(candidates.length?candidates[candidates.length-1]:limit),sy=Math.round(topCss*scale),sh=Math.max(1,Math.round((bottomCss-topCss)*scale)),slice=document.createElement('canvas');slice.width=canvas.width;slice.height=sh;slice.getContext('2d').drawImage(canvas,0,sy,canvas.width,sh,0,0,canvas.width,sh);if(page++)pdf.addPage();const imgH=sh*(drawW/canvas.width);pdf.addImage(slice.toDataURL('image/jpeg',.94),'JPEG',margin,margin,drawW,imgH,undefined,'FAST');topCss=bottomCss;}
      pdf.save(exportFileName('pdf'));$('status').textContent='PDF song blueprint exported.';
    }catch(e){$('status').textContent=e.message||'Could not export PDF.';}
  }
  function closeExportMenu(){const m=$('exportMenu'),b=$('exportBtn');if(m)m.hidden=true;if(b)b.setAttribute('aria-expanded','false');}
  function toggleExportMenu(){const m=$('exportMenu'),b=$('exportBtn'),open=m.hidden;m.hidden=!open;b.setAttribute('aria-expanded',String(open));}


  function init(){
    for(let i=0;i<=12;i++){const o=document.createElement('option');o.value=i;o.textContent=i?'Capo '+i:'None';$('capoSelect').appendChild(o);}
    initCarouselListeners();
    $('buildBtn').onclick=()=>{recordUndo();const bad=commitBuildInput();$('status').textContent=bad.length?`Skipped unrecognized: ${bad.join(', ')}`:'';syncBuildInput();autoPopulateKeyFromEntry();renderAll();scheduleAutoSave();};
    $('chordInput').oninput=()=>autoPopulateKeyFromEntry();
    $('chordInput').onkeydown=e=>{if(e.key==='Enter')$('buildBtn').click();};
    $('keyInput').oninput=()=>{const key=$('keyInput');key.dataset.autoKey='0';const raw=key.value.trim();scheduleAutoSave();if(!raw){key.dataset.autoKey='1';autoPopulateKeyFromEntry();return;}if(!enteredKey()){$('keyHint').textContent='Enter a key like F, F#m, Bb, or C minor';return;}renderFits();};
    $('keyInput').onkeydown=e=>{if(e.key==='Enter'){$('buildBtn').click();}};
    document.querySelectorAll('#instrumentTabs .seg').forEach(b=>b.onclick=()=>{const nextInstrument=b.dataset.instrument;if(!nextInstrument)return;/* v3.3.53 — instrument-family tabs are browsers, not selectors. Opening Guitar/Misc/Piano must not alter the active instrument, active sound, playback player, project data, or highlighted family. Commit both instrument + sound only after the user taps a specific sound in the popup. */showInstrumentSoundPicker(b,nextInstrument,state.sound,(value)=>{state.instrument=nextInstrument;state.sound=value;localStorage.setItem('crp-last-instrument',state.instrument);state.player=null;renderAll();window.CRPParts?.syncCoreLive?.();scheduleAutoSave();});});
    document.querySelectorAll('#modeTabs .seg').forEach(b=>b.onclick=()=>{state.mode=b.dataset.mode;localStorage.setItem('crp-last-mode',state.mode);renderAll();syncBuildInput();scheduleAutoSave();});
    $('soundSelect').onchange=e=>{state.sound=e.target.value;state.player=null;window.CRPParts?.syncCoreLive?.();scheduleAutoSave();};$('octaveDown').onclick=()=>{state.octave=Math.max(-2,state.octave-1);if(state.currentProjectId)writeSharedSrpMeta(state.currentProjectId,{pitchMode:'step'});publishLiveSrpMeta('crp');writeHardSync('crp','step');renderAll();window.CRPParts?.syncCoreLive?.();scheduleAutoSave();publishSrpHandoff();};$('octaveUp').onclick=()=>{state.octave=Math.min(3,state.octave+1);if(state.currentProjectId)writeSharedSrpMeta(state.currentProjectId,{pitchMode:'step'});publishLiveSrpMeta('crp');writeHardSync('crp','step');renderAll();window.CRPParts?.syncCoreLive?.();scheduleAutoSave();publishSrpHandoff();};
    $('sustainBtn').onclick=()=>{state.sustain=!state.sustain;localStorage.setItem('crp-sustain',state.sustain?'1':'0');updateSustainButton();window.CRPParts?.syncCoreLive?.();};
    updateSustainButton();
    $('capoSelect').onchange=e=>{state.capo=+e.target.value;if(state.currentProjectId)writeSharedSrpMeta(state.currentProjectId,{pitchMode:'capo'});publishLiveSrpMeta('crp');writeHardSync('crp','capo');renderAll();window.CRPParts?.syncCoreLive?.();scheduleAutoSave();publishSrpHandoff();};$('neckSelect').onchange=e=>{state.neck=e.target.value;renderAll();window.CRPParts?.syncCoreLive?.();scheduleAutoSave();};$('transposeBtn').onclick=()=>{state.transpose=!state.transpose;publishLiveSrpMeta('crp');renderAll();window.CRPParts?.syncCoreLive?.();scheduleAutoSave();publishSrpHandoff();};
    $('addLineBtn').onclick=()=>{recordUndo();lockAutoSongKey();state.rows.push([]);state.selectedRow=state.rows.length-1;renderRows();syncBuildInput();renderFits();scheduleAutoSave();};
    $('autoScrollBtn').onclick=()=>setAutoScroll(!state.autoScroll);
    $('midiViewBtn').onclick=()=>{state.cardView=state.cardView==='midi'?'diagram':'midi';localStorage.setItem('crp-card-view',state.cardView);updateCardViewButton();renderRows();};
    updateAutoScrollButton();updateCardViewButton();
    let lastMobileCarousel=isMobileCarousel(),resizeTimer=null;
    window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{const mobile=isMobileCarousel();if(mobile!==lastMobileCarousel){lastMobileCarousel=mobile;renderRows();}},120);},{passive:true});
    $('playAllBtn').onclick=playProgression;
    $('newProjectBtn').onclick=newProject;
    $('saveProjectBtn').onclick=saveProject;
    $('exportBtn').onclick=e=>{e.stopPropagation();toggleExportMenu();};$('exportPdfBtn').onclick=openPdfExport;$('exportPngBtn').onclick=openPngExport;$('exportAudioBtn').onclick=()=>{closeExportMenu();window.CRPParts?.openAudioExport?.();};$('exportStudioBtn').onclick=()=>{closeExportMenu();window.CRPParts?.openStudioExport?.();};
    document.addEventListener('click',e=>{if(!e.target.closest('.export-wrap'))closeExportMenu();});

    // Programmatic scrollIntoView does not generate touchmove/wheel events,
    // so these only shut Auto Scroll off when the user actually intervenes.
    let autoScrollTouchStartY=null;
    window.addEventListener('touchstart',e=>{
      if(!state.playing||!state.autoScroll||!e.touches?.length)return;
      autoScrollTouchStartY=e.touches[0].clientY;
    },{passive:true});
    window.addEventListener('touchmove',e=>{
      if(!state.playing||!state.autoScroll||autoScrollTouchStartY==null||!e.touches?.length)return;
      if(Math.abs(e.touches[0].clientY-autoScrollTouchStartY)>10){
        autoScrollTouchStartY=null;
        disableAutoScrollForManualScroll();
      }
    },{passive:true});
    window.addEventListener('touchend',()=>{autoScrollTouchStartY=null;},{passive:true});
    window.addEventListener('wheel',()=>{
      if(state.playing&&state.autoScroll)disableAutoScrollForManualScroll();
    },{passive:true});
    // Any deliberate click/tap inside the progression or MIDI table hands control
    // back to the user immediately. Programmatic follow-scroll never fires pointerdown.
    for(const el of [$('progression'),$('midiRollTableWrap')].filter(Boolean)){
      el.addEventListener('pointerdown',()=>{
        if(state.playing&&state.autoScroll)disableAutoScrollForManualScroll();
      },{passive:true});
    }
    // Autosave: saved songs autosave into Projects; never-saved work autosaves to the draft slot.
    // BPM is intentionally excluded from input-time autosave. scheduleAutoSave() publishes the
    // SRP handoff immediately, so including BPM here leaked partial mobile keystrokes ("4", "12")
    // into the sync bus before the user finished typing. BPM commits on change/blur below.
    ['projectName','keyInput'].forEach(id=>$(id)?.addEventListener('input',scheduleAutoSave));
    ['beatsSelect','loopToggle'].forEach(id=>$(id)?.addEventListener('change',scheduleAutoSave));
    // v2.5.3: do NOT publish BPM on every digit. On mobile, typing 120 fires input for
    // "1", then "12", then "120". The old hard-sync clamped that first "1" to 40
    // and the 250 ms poll wrote 40 back into the field before the user could finish typing.
    // Let the field be an editing buffer; commit only when the edit is complete.
    const commitCrpBpm=()=>{
      const node=$('bpmInput'); if(!node)return;
      const raw=Number(node.value);
      if(!Number.isFinite(raw))return;
      const bpm=Math.max(40,Math.min(240,Math.round(raw)));
      node.value=String(bpm);
      publishLiveSrpMeta('crp');writeHardSync('crp');publishSrpHandoff();scheduleAutoSave();
    };
    // A tempo above 240 can never become valid by typing more digits, so cap it at once
    // (both BPM fields); values below 40 may still be on their way to "120" and are
    // clamped when the edit is committed.
    document.addEventListener('input',e=>{if(e.target?.matches?.('#bpmInput,#voxBpmInput')&&Number(e.target.value)>240)e.target.value='240';},true);
    $('bpmInput')?.addEventListener('change',commitCrpBpm);
    $('bpmInput')?.addEventListener('blur',commitCrpBpm);
    $('bpmInput')?.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();commitCrpBpm();e.currentTarget.blur();}});
    $('notesEditor')?.addEventListener('input',scheduleAutoSave);
    $('undoBtn')?.addEventListener('click',undoEdit);
    $('redoBtn')?.addEventListener('click',redoEdit);
    document.addEventListener('keydown',e=>{
      if(!(e.ctrlKey||e.metaKey)||e.altKey)return;
      const k=String(e.key||'').toLowerCase();if(k!=='z'&&k!=='y')return;
      if(e.target?.closest?.('input,textarea,select,[contenteditable="true"]'))return; // keep native text undo
      if($('voxBoxPage')&&!$('voxBoxPage').hidden)return; // Track Master has its own undo
      if((k==='y'||e.shiftKey)?redoEdit():undoEdit())e.preventDefault();
    });
    updateUndoButtons();
    $('saveRetryBtn')?.addEventListener('click',()=>{persistEditorLocally();syncWithCloud({pull:true}).catch(()=>{});});
    $('syncNoticeClose')?.addEventListener('click',dismissSyncNotice);

    $('projectsTabBtn').onclick=()=>setProjectBrowserMode('projects');
    $('archiveTabBtn').onclick=()=>setProjectBrowserMode('archive');
    $('renameCurrentProjectBtn')?.addEventListener('click',renameLoadedProject);
    $('projectsPanelToggleBtn')?.addEventListener('click',()=>setDataPanelCollapsed('projects',!$('projectsPanel').classList.contains('is-collapsed')));
    $('notesPanelToggleBtn')?.addEventListener('click',()=>setDataPanelCollapsed('notes',!$('notesPanel').classList.contains('is-collapsed')));
    restoreDataPanelCollapse();
    $('loginBtn').onclick=login;$('registerBtn').onclick=register;$('logoutBtn').onclick=logout;$('changePasswordBtn').onclick=changePassword;if($('syncNowBtn'))$('syncNowBtn').onclick=syncNow;
    $('accountSummaryBtn').onclick=()=>{const panel=$('accountPanel');setAccountCollapsed(!panel.classList.contains('is-collapsed'));};
    document.querySelectorAll('.notes-toolbar [data-cmd]').forEach(b=>b.onclick=()=>{document.execCommand(b.dataset.cmd,false,null);scheduleAutoSave();});$('clearNotesBtn').onclick=()=>{if(confirm('Clear notes?')){$('notesEditor').innerHTML='';scheduleAutoSave();}};
    $('keyInput').dataset.autoKey=$('keyInput').value.trim()?'0':'1';
    renderProjects();renderAll();syncBuildInput();autoPopulateKeyFromEntry();setRiderBonesRiding(false);initWorkspaceMode();
    // A fresh device starts its working set as signed-out work (see adoptWorkingSetFor).
    if(localOwner()===null&&!localProjects().length){try{setLocalOwner('');}catch{}}
    sessionOwner=localOwner();
    // Restore the project the user was working on, or their never-saved draft.
    if(!restoreActiveProjectFromStorage()&&!IS_PLAYBACK_BRIDGE)restoreDraft();
    // parts.js and beat-maker.js load after app.js, so the restore above ran before they
    // existed. Load the same song into each module once it announces it is ready;
    // otherwise Baby DAW starts with only Chords 1 and the drums start blank.
    const reloadEditorIntoModules=()=>{
      if(state.currentProjectId){const p=findLocal(state.currentProjectId);if(p)loadProjectIntoEditor(p);}
      else if(state.draftId){const d=readDraft();if(d&&sameProjectId(d.project.id,state.draftId)){loadProjectIntoEditor(d.project,{asDraft:true});unsavedProjectTouched=true;}}
    };
    window.addEventListener('crp-parts-ready',reloadEditorIntoModules,{once:true});
    window.addEventListener('crp-beat-ready',reloadEditorIntoModules,{once:true});
    setTimeout(applyLinkedMetaFromSrpHandoff,0);
    // The hidden SRP playback bridge is read-only: it never syncs or listens for edits.
    if(!IS_PLAYBACK_BRIDGE){
      checkAccount();
      window.addEventListener('focus',()=>scheduleCloudPull());
      window.addEventListener('online',()=>scheduleCloudPull(150));
      document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')scheduleCloudPull();});
      window.addEventListener('storage',e=>{if(e.key===PROJECTS_KEY||e.key===LOCAL_OWNER_KEY||e.key===null)onProjectsChangedElsewhere();});
    }
    if('serviceWorker'in navigator)navigator.serviceWorker.register('service-worker.js?v=3.3.129-CRP-COMPACT-STARTUP').catch(()=>{});
  }

  const WORKSPACE_MODE_KEY='crp-workspace-mode-v1';
  const SRP_HANDOFF_KEY='crp-srp-handoff-v2';
  const SRP_META_PREFIX='crp-srp-meta-v1:';
  // v2.5.0: one tiny same-origin live metadata bus is the authority shared by CRP, BD and SRP.
  // Only real workspaces publish to it; the hidden SRP playback iframe is read-only so it can never
  // push a stale BPM/capo/octave snapshot back over the user's latest edit.
  const SRP_LIVE_META_KEY='crp-srp-live-meta-v3';
  // v2.5.1: project-scoped single source of truth. The old global live key could point at
  // a different project than the currently linked CRP/SRP pair, which is why the UI could say
  // "Linked" while BPM/capo/STEP still came from different records.
  const SRP_ACTIVE_LINK_KEY='crp-srp-active-link-id-v1';
  const SRP_UNIFIED_META_PREFIX='crp-srp-unified-meta-v1:';
  // v2.5.2: deliberately simple last-writer-wins transport metadata bus.
  // This is global to the currently open linked workspace so project-id/link-map races cannot block BPM/capo/STEP sync.
  const SRP_HARD_SYNC_KEY='crp-srp-hard-sync-v1';
  // v2.6.0: project-scoped canonical transport state. This is the ONLY authority for linked BPM/CAPO/STEP.
  const SRP_CANONICAL_PREFIX='crp-srp-canonical-v1:';
  const SRP_LINK_SESSION_KEY='crp-srp-link-session-v3';
  // v3.3.0 LINK-SCOPED TRANSPORT: CRP/Baby DAW and SRP share BPM/CAPO/STEP only
  // for the exact active linked project pair. An unrelated or unlinked SRP project must not
  // read or overwrite another CRP/BD project's transport state.
  const SRS_TRANSPORT_KEY='song-rider-suite-transport-v6';
  function readSuiteTransport(){
    try{
      const m=JSON.parse(localStorage.getItem(SRS_TRANSPORT_KEY)||'null');
      return m&&typeof m==='object'?m:null;
    }catch{return null}
  }
  function writeSuiteTransport(projectId,meta,source='crp'){
    if(IS_PLAYBACK_BRIDGE)return null;
    try{
      const prev=readSuiteTransport()||{};
      const next={
        bpm:Math.max(40,Math.min(240,Number(meta?.bpm ?? prev.bpm ?? $('bpmInput')?.value)||92)),
        capo:Math.max(0,Math.min(12,Number(meta?.capo ?? prev.capo ?? state.capo)||0)),
        octave:Math.max(-2,Math.min(3,Number(meta?.octave ?? prev.octave ?? state.octave)||0)),
        pitchMode:(meta?.pitchMode==='step'||meta?.pitchMode==='capo')?meta.pitchMode:(prev.pitchMode==='step'?'step':'capo'),
        crpProjectId:String(projectId||state.currentProjectId||localStorage.getItem('crp-active-project-id')||prev.crpProjectId||''),
        source,rev:(Number(prev.rev)||0)+1,updatedAt:Date.now()
      };
      localStorage.setItem(SRS_TRANSPORT_KEY,JSON.stringify(next));
      try{window.__SRS_TRANSPORT_CHANNEL?.postMessage(next)}catch{}
      return next;
    }catch{return null}
  }
  const IS_PLAYBACK_BRIDGE=new URLSearchParams(location.search).get('playbackBridge')==='1';
  function srpMetaKey(projectId){return SRP_META_PREFIX+String(projectId||'')}
  function unifiedSrpMetaKey(projectId){return SRP_UNIFIED_META_PREFIX+String(projectId||'')}
  function canonicalSrpKey(projectId){return SRP_CANONICAL_PREFIX+String(projectId||'')}
  function readSrpLinkSession(){try{const x=JSON.parse(localStorage.getItem(SRP_LINK_SESSION_KEY)||'null');return x&&x.linked===true?x:null}catch{return null}}
  function currentProjectHasSrpLink(){const x=readSrpLinkSession();return !!(x&&state.currentProjectId&&String(x.crpProjectId||'')===String(state.currentProjectId))}
  function readCanonicalSrp(projectId){try{const id=String(projectId||activeSrpLinkId()||'');if(!id)return null;const m=JSON.parse(localStorage.getItem(canonicalSrpKey(id))||'null');return m&&String(m.projectId||'')===id?m:null}catch{return null}}
  function writeCanonicalSrp(projectId,meta,source='crp'){
    if(IS_PLAYBACK_BRIDGE||!projectId||!currentProjectHasSrpLink())return null;
    try{
      const id=String(projectId), prev=readCanonicalSrp(id)||{};
      const next={...prev,...meta,projectId:id,source,rev:(Number(prev.rev)||0)+1,updatedAt:Date.now()};
      localStorage.setItem(SRP_ACTIVE_LINK_KEY,id);
      localStorage.setItem(canonicalSrpKey(id),JSON.stringify(next));
      try{window.__CRP_SRP_CANONICAL_CHANNEL?.postMessage(next)}catch{}
      return next;
    }catch{return null}
  }
  function activeSrpLinkId(){
    try{return String(state.currentProjectId||localStorage.getItem(SRP_ACTIVE_LINK_KEY)||localStorage.getItem('crp-active-project-id')||'')}catch{return String(state.currentProjectId||'')}
  }
  function readLiveSrpMeta(){
    try{
      const id=activeSrpLinkId();
      const canonical=readCanonicalSrp(id);
      if(canonical)return {...canonical,crpProjectId:id};
      if(id){const unified=JSON.parse(localStorage.getItem(unifiedSrpMetaKey(id))||'null');if(unified&&String(unified.crpProjectId||'')===id)return unified;}
      return JSON.parse(localStorage.getItem(SRP_LIVE_META_KEY)||'null');
    }catch{return null}
  }
  function writeLiveSrpMeta(projectId,meta){
    if(IS_PLAYBACK_BRIDGE||!projectId)return null;
    try{
      const id=String(projectId);
      // Every legacy publication also advances the canonical project record.
      writeCanonicalSrp(id,meta,String(meta?.source||'crp'));
      localStorage.setItem(SRP_ACTIVE_LINK_KEY,id);
      const key=unifiedSrpMetaKey(id);
      const old=JSON.parse(localStorage.getItem(key)||'null');
      const prev=(old&&String(old.crpProjectId||'')===id)?old:{};
      const next={...prev,...meta,crpProjectId:id,rev:(Number(prev.rev)||0)+1,updatedAt:Date.now()};
      // Unified project-scoped record is authoritative. Keep the legacy key mirrored only so
      // older code paths cannot reintroduce a stale value during this migration.
      localStorage.setItem(key,JSON.stringify(next));
      localStorage.setItem(SRP_LIVE_META_KEY,JSON.stringify(next));
      try{window.__CRP_SRP_META_CHANNEL?.postMessage(next)}catch{}
      return next;
    }catch{return null}
  }
  function readSharedSrpMeta(projectId){
    try{
      const id=String(projectId||'');
      const base=JSON.parse(localStorage.getItem(srpMetaKey(id))||'null');
      // Read the requested project's canonical record directly. Do not depend on whatever
      // project happened to be active before loadProject() switches state.currentProjectId.
      const session=readSrpLinkSession();
      const explicitlyLinked=!!(session&&String(session.crpProjectId||'')===id);
      if(!explicitlyLinked)return base;
      const suite=readSuiteTransport();
      const canonical=readCanonicalSrp(id);
      const live=readLiveSrpMeta();
      const legacy=(canonical?{...(base||{}),...canonical,crpProjectId:id}:(live&&String(live.crpProjectId||'')===id?{...(base||{}),...live}:base));
      // Suite transport wins only when it belongs to this exact linked CRP project.
      const suiteForPair=(suite&&String(suite.crpProjectId||'')===id)?suite:null;
      return suiteForPair?{...(legacy||{}),...suiteForPair,crpProjectId:id}:legacy;
    }catch{return null}
  }
  function writeSharedSrpMeta(projectId,meta){
    if(!projectId)return;
    try{
      const prev=readSharedSrpMeta(projectId)||{};
      localStorage.setItem(srpMetaKey(projectId),JSON.stringify({...prev,...meta,projectId:String(projectId),updatedAt:Date.now()}));
    }catch{}
  }
  function linkedPitchMode(projectId){
    const m=readSharedSrpMeta(projectId)?.pitchMode;
    return m==='step'?'step':'capo';
  }
  function publishLiveSrpMeta(source='crp'){
    if(IS_PLAYBACK_BRIDGE||!state.currentProjectId||!currentProjectHasSrpLink())return null;
    const id=String(state.currentProjectId);
    const bpm=Math.max(40,Math.min(240,Number($('bpmInput')?.value)||92));
    const capo=Math.max(0,Math.min(12,Number(state.capo)||0));
    const octave=Math.max(-2,Math.min(3,Number(state.octave)||0));
    const meta={bpm,capo,octave,transpose:!!state.transpose,key:String($('keyInput')?.value||'').trim(),pitchMode:linkedPitchMode(id),source};
    writeSuiteTransport(id,meta,source);
    const live=writeLiveSrpMeta(id,meta);
    // Keep the older per-project record current too, but never use it as a competing clock.
    try{
      const prev=JSON.parse(localStorage.getItem(srpMetaKey(id))||'null')||{};
      localStorage.setItem(srpMetaKey(id),JSON.stringify({...prev,...meta,projectId:id,updatedAt:Date.now()}));
    }catch{}
    return live;
  }
  function readHardSync(){
    try{
      if(!currentProjectHasSrpLink())return null;
      const id=String(state.currentProjectId||'');
      if(!id)return null;
      const suite=readSuiteTransport();
      if(suite&&String(suite.crpProjectId||'')===id)return suite;
      const canonical=readCanonicalSrp(id);
      if(canonical)return canonical;
      const legacy=JSON.parse(localStorage.getItem(SRP_HARD_SYNC_KEY)||'null');
      return legacy&&String(legacy.projectId||legacy.crpProjectId||'')===id?legacy:null;
    }catch{return null}
  }
  function writeHardSync(source='crp',modeOverride){
    if(IS_PLAYBACK_BRIDGE||!currentProjectHasSrpLink())return null;
    try{
      const id=String(state.currentProjectId||'');
      if(!id)return null;
      const bpm=Math.max(40,Math.min(240,Number($('bpmInput')?.value)||92));
      const capo=Math.max(0,Math.min(12,Number(state.capo)||0));
      const octave=Math.max(-2,Math.min(3,Number(state.octave)||0));
      const prev=readSuiteTransport()||readHardSync()||{};
      const pitchMode=modeOverride==='step'||modeOverride==='capo'?modeOverride:(prev.pitchMode==='step'?'step':'capo');
      const next=writeSuiteTransport(id,{bpm,capo,octave,pitchMode},source);
      // Mirror for older non-transport bridge code, but never use it ahead of v5.
      writeCanonicalSrp(id,{bpm,capo,octave,pitchMode},source);
      localStorage.setItem(SRP_HARD_SYNC_KEY,JSON.stringify(next||{bpm,capo,octave,pitchMode,projectId:id,source,rev:(Number(prev.rev)||0)+1,updatedAt:Date.now()}));
      return next;
    }catch{return null}
  }
  let __hardSyncRev=-1;
  function applyHardSync(){
    if(IS_PLAYBACK_BRIDGE||!currentProjectHasSrpLink())return false;
    try{
      const m=readHardSync();
      if(!m)return false;
      const activeId=String(state.currentProjectId||'');
      const metaId=String(m.crpProjectId||m.projectId||'');
      if(!activeId || (metaId&&metaId!==activeId))return false;
      // Never overwrite a number field while the user is actively typing into it.
      // Leave the revision unapplied so the newest external value can still be consumed after blur.
      const active=document.activeElement;
      if(active===$('bpmInput')||active===$('capoSelect'))return false;
      const rev=Number(m.rev)||0;
      if(rev===__hardSyncRev)return false;
      __hardSyncRev=rev;
      const bpm=Math.max(40,Math.min(240,Number(m.bpm)||92));
      const capo=Math.max(0,Math.min(12,Number(m.capo)||0));
      const octave=Math.max(-2,Math.min(3,Number(m.octave)||0));
      if($('bpmInput'))$('bpmInput').value=String(bpm);
      state.capo=capo;if($('capoSelect'))$('capoSelect').value=String(capo);
      state.octave=octave;
      // Preserve which control was last authoritative so SRP paints CAPO vs STEP correctly.
      try{if(state.currentProjectId)writeSharedSrpMeta(state.currentProjectId,{pitchMode:m.pitchMode==='step'?'step':'capo'});}catch{}
      renderAll();
      window.CRPParts?.syncCoreLive?.();
      // Hard Sync is the fast same-device transport bus. Do not stamp the whole
      // saved project here: doing so made a stale phone snapshot look newer than
      // a real PC cloud save. The project-scoped handoff/autosave path persists
      // actual transport edits through the normal pending-cloud flow.
      return true;
    }catch{return false}
  }


  function performOpenSongRiderWorkspace(){
    try{
      // Persist the open project before leaving CRP so SRP reads current data and CRP
      // restores it on return. (Unsaved work only reaches this point after the user
      // chose "Continue Without Saving", so it is not written back to the draft slot.)
      if(state.currentProjectId)flushAutoSaveNow();
      publishLiveSrpMeta('crp');
      writeHardSync('crp');
      const payload=srpPayload();
      const rec=payload?srpLinks()[payload.crpProjectId]||null:null;
      if(payload?.crpProjectId){localStorage.setItem('crp-active-project-id',String(payload.crpProjectId));}
      localStorage.setItem(SRP_HANDOFF_KEY,JSON.stringify({payload,rec,ts:Date.now()}));
      localStorage.setItem(WORKSPACE_MODE_KEY,'song-rider');
    }catch(err){console.error('Could not hand CRP project to Song Rider',err)}
    {
      const path=location.pathname||'/';
      const marker='/song-rider/';
      let appRoot='/';
      if(path.includes(marker)){
        appRoot=path.slice(0,path.indexOf(marker)+1);
      }else if(path.endsWith('/index.html')){
        appRoot=path.slice(0,-'index.html'.length);
      }else if(path.endsWith('/')){
        appRoot=path;
      }else{
        appRoot=path.slice(0,path.lastIndexOf('/')+1);
      }
      location.href=new URL(appRoot+'song-rider/index.html?crpMode=1',location.origin).href;
    }
  }
  function openSongRiderWorkspace(){requestProjectExit(performOpenSongRiderWorkspace);}

  // v3.2.2 — CRP and Baby DAW keep independent setup-menu visibility.
  // Hiding Piano/Guitar/etc. in CRP must never strand Baby DAW chord parts without those controls.
  const CRP_SETUP_HIDDEN_KEY='crp-setup-controls-hidden';
  const BD_SETUP_HIDDEN_KEY='baby-daw-setup-controls-hidden-v1';
  function setupHiddenFor(mode){
    const key=mode==='baby-daw'?BD_SETUP_HIDDEN_KEY:CRP_SETUP_HIDDEN_KEY;
    try{return localStorage.getItem(key)==='1'}catch{return false}
  }
  function currentSetupWorkspace(){return document.body.classList.contains('workspace-baby-daw')?'baby-daw':'chord-rider'}
  function applySetupVisibility(){
    // The same chord setup toolbar is shared by CRP and Baby DAW.  Keep the
    // workspace-specific preference, but apply it directly to the actual CRP
    // toolbar with both a class and the native hidden state.  This avoids the
    // higher-specificity part-editor rules from forcing the toolbar visible
    // while the button says “Show”.
    const toolbar=document.querySelector('#chordPartControls > .primary-toolbar');
    if(!toolbar)return;
    const mode=currentSetupWorkspace();
    const hidden=setupHiddenFor(mode);
    toolbar.classList.toggle('crp-controls-hidden',hidden);
    toolbar.hidden=hidden;
    const controls=$('chordPartControls');
    controls?.classList.toggle('setup-collapsed',hidden);

    const crpToggle=$('toggleCrpControlsBtn');
    if(crpToggle){
      const crpHidden=setupHiddenFor('chord-rider');
      crpToggle.textContent=crpHidden?'Show':'Hide';
      crpToggle.setAttribute('aria-expanded',String(!crpHidden));
    }
    const bdToggle=$('babyChordSetupToggleBtn');
    if(bdToggle){
      const bdHidden=setupHiddenFor('baby-daw');
      bdToggle.textContent=bdHidden?'Show Setup':'Hide Setup';
      bdToggle.setAttribute('aria-expanded',String(!bdHidden));
    }
  }
  function setWorkspaceSetupHidden(mode,hidden,persist=true){
    mode=mode==='baby-daw'?'baby-daw':'chord-rider';
    if(persist){
      const key=mode==='baby-daw'?BD_SETUP_HIDDEN_KEY:CRP_SETUP_HIDDEN_KEY;
      try{localStorage.setItem(key,hidden?'1':'0')}catch{}
    }
    applySetupVisibility();
  }
  function applyWorkspaceMode(mode, persist=true){
    mode=['chord-rider','baby-daw','song-rider'].includes(mode)?mode:'chord-rider';
    if(mode==='song-rider'){
      if(persist) openSongRiderWorkspace();
      return;
    }
    document.body.classList.toggle('workspace-chord-rider',mode==='chord-rider');
    document.body.classList.toggle('workspace-baby-daw',mode==='baby-daw');
    document.body.classList.remove('workspace-song-rider');
    document.querySelectorAll('[data-workspace-mode]').forEach(btn=>{
      const on=btn.dataset.workspaceMode===mode;btn.classList.toggle('active',on);btn.setAttribute('aria-pressed',String(on));
    });
    if(mode==='chord-rider') window.CRPParts?.focusChordPart?.();
    renderRows();updateCardViewButton();
    applySetupVisibility();
    window.CRPParts?.refreshBabySetupToggle?.();
    if(persist){try{localStorage.setItem(WORKSPACE_MODE_KEY,mode)}catch{}}
  }
  function initWorkspaceMode(){
    let mode='chord-rider';
    try{
      const q=new URLSearchParams(location.search).get('workspace');
      mode=q||localStorage.getItem(WORKSPACE_MODE_KEY)||mode;
      if(q&&['chord-rider','baby-daw'].includes(q)) localStorage.setItem(WORKSPACE_MODE_KEY,q);
      if(mode==='song-rider') mode='chord-rider';
    }catch{}
    document.querySelectorAll('[data-workspace-mode]').forEach(btn=>btn.addEventListener('click',()=>applyWorkspaceMode(btn.dataset.workspaceMode,true)));

    const crpControlsToggle=$('toggleCrpControlsBtn');
    if(crpControlsToggle)crpControlsToggle.addEventListener('click',()=>setWorkspaceSetupHidden('chord-rider',!setupHiddenFor('chord-rider')));
    const bdControlsToggle=$('babyChordSetupToggleBtn');
    if(bdControlsToggle)bdControlsToggle.addEventListener('click',()=>setWorkspaceSetupHidden('baby-daw',!setupHiddenFor('baby-daw')));

    applyWorkspaceMode(mode,false);
  }

  const SRP_LINKS_KEY='crp-srp-links-v1';
  function srpLinks(){try{return JSON.parse(localStorage.getItem(SRP_LINKS_KEY)||'{}')||{}}catch{return{}}}
  function setSrpLinks(v){try{localStorage.setItem(SRP_LINKS_KEY,JSON.stringify(v||{}))}catch{}}
  function currentCrpProject(){return state.currentProjectId?(localProjects().find(p=>p.id===state.currentProjectId)||null):null}
  function srpPayload(){
    const p=currentCrpProject(); if(!p)return null;
    const live=capture(p.id,p.name||$('projectName').value.trim()||'Untitled');
    return {crpProjectId:p.id,name:live.name||p.name||'Untitled',bpm:+live.bpm||92,beats:+live.beats||4,key:live.key||'',capo:Number(live.capo)||0,octave:Number(live.octave)||0,transpose:!!live.transpose,pitchMode:linkedPitchMode(p.id),rows:(live.rows||[]).map((row,rowIndex)=>({lineId:`crp-line-${rowIndex+1}`,cards:(row||[]).map(c=>({type:c.type||'chord',value:c.value||'',durationBeats:cardDurationBeats(c,+live.beats||4)}))}))};
  }
  function publishSrpHandoff(){
    try{
      const payload=srpPayload();
      if(!payload?.crpProjectId)return;
      const rec=srpLinks()[payload.crpProjectId]||null;
      localStorage.setItem(SRP_HANDOFF_KEY,JSON.stringify({payload,rec,ts:Date.now()}));
      writeSharedSrpMeta(payload.crpProjectId,{bpm:payload.bpm,capo:payload.capo,octave:payload.octave,transpose:payload.transpose,key:payload.key,pitchMode:payload.pitchMode||linkedPitchMode(payload.crpProjectId),source:'crp'});
    }catch(err){console.warn('Could not publish linked SRP state',err)}
  }

  function applyLinkedMetaFromSrpHandoff(){
    try{
      const activeId=String(state.currentProjectId||localStorage.getItem('crp-active-project-id')||'');
      if(!activeId||!currentProjectHasSrpLink())return false;
      const shared=readSharedSrpMeta(activeId);
      const h=JSON.parse(localStorage.getItem(SRP_HANDOFF_KEY)||'{}')||{};
      const payload=(shared ? {
        ...(h.payload||{}),crpProjectId:activeId,
        bpm:shared.bpm,capo:shared.capo,octave:shared.octave,transpose:shared.transpose,key:shared.key,
        pitchMode:shared.pitchMode
      } : h.payload);
      if(!payload?.crpProjectId||String(payload.crpProjectId)!==activeId)return false;

      const bpm=Math.max(40,Math.min(240,Number(payload.bpm)||92));
      const capo=Math.max(0,Math.min(12,Number(payload.capo)||0));
      const octave=Math.max(-2,Math.min(3,Number(payload.octave)||0));
      const transpose=!!payload.transpose;
      const key=String(payload.key||'');

      const before={bpm:+$('bpmInput')?.value||92,capo:state.capo,octave:state.octave,transpose:state.transpose,key:$('keyInput')?.value||''};
      if($('bpmInput'))$('bpmInput').value=String(bpm);
      state.capo=capo;if($('capoSelect'))$('capoSelect').value=String(capo);
      state.octave=octave;
      state.transpose=transpose;
      if($('keyInput')){$('keyInput').value=key;$('keyInput').dataset.autoKey=key?'0':'1';}

      renderAll();syncBuildInput();window.CRPParts?.syncCoreLive?.();
      const changed=before.bpm!==bpm||before.capo!==capo||before.octave!==octave||before.transpose!==transpose||String(before.key)!==key;
      // Persist the SRP-originated values through the normal autosave/cloud path.
      if(changed&&state.currentProjectId===activeId)scheduleAutoSave();
      return true;
    }catch(err){console.warn('Could not apply linked SRP metadata',err);return false}
  }
  try{window.__CRP_SRP_META_CHANNEL=new BroadcastChannel('crp-srp-live-meta-v3');window.__CRP_SRP_META_CHANNEL.onmessage=()=>setTimeout(applyLinkedMetaFromSrpHandoff,0);}catch{}
  try{window.__CRP_SRP_CANONICAL_CHANNEL=new BroadcastChannel('crp-srp-canonical-v1');window.__CRP_SRP_CANONICAL_CHANNEL.onmessage=()=>setTimeout(applyHardSync,0);}catch{}
  try{window.__SRS_TRANSPORT_CHANNEL=new BroadcastChannel('song-rider-suite-transport-v6');window.__SRS_TRANSPORT_CHANNEL.onmessage=()=>setTimeout(applyHardSync,0);}catch{}
  window.addEventListener('storage',e=>{if(e.key===SRP_LIVE_META_KEY||e.key===SRP_HANDOFF_KEY||String(e.key||'').startsWith(SRP_META_PREFIX))applyLinkedMetaFromSrpHandoff();});
  window.addEventListener('pageshow',()=>setTimeout(applyLinkedMetaFromSrpHandoff,0));
  window.addEventListener('focus',()=>setTimeout(applyLinkedMetaFromSrpHandoff,0));
  window.addEventListener('storage',e=>{if(e.key===SRP_HARD_SYNC_KEY||e.key===SRP_LINK_SESSION_KEY||String(e.key||'').startsWith(SRP_CANONICAL_PREFIX)||e.key===SRS_TRANSPORT_KEY)setTimeout(applyHardSync,0);});
  window.addEventListener('pageshow',()=>setTimeout(applyHardSync,0));
  // Phones can kill a hidden tab without warning: write the editor to this device now.
  if(!IS_PLAYBACK_BRIDGE){
    window.addEventListener('pagehide',()=>flushAutoSaveNow());
    document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')flushAutoSaveNow();});
  }
  window.addEventListener('focus',()=>setTimeout(applyHardSync,0));
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')setTimeout(applyHardSync,0);});
  setInterval(applyHardSync,250);

  // Song Rider now runs as a native same-origin workspace page.
  // The shared link map and handoff snapshot above are consumed directly by song-rider/app.js.

  function coreSnapshot(){
    return JSON.parse(JSON.stringify({instrument:state.instrument,mode:state.mode,sound:state.sound,octave:state.octave,capo:state.capo,neck:state.neck,transpose:state.transpose,rows:state.rows,key:$('keyInput').value.trim()}));
  }
  function coreApply(snapshot){
    if(!snapshot)return;
    state.instrument=normalizeInstrument(snapshot.instrument);
    state.mode=snapshot.mode==='note'?'note':'chord';
    state.sound=(SOUNDS[state.instrument]||SOUNDS.piano).some(x=>x[0]===snapshot.sound)?snapshot.sound:SOUNDS[state.instrument][0][0];
    state.octave=Number(snapshot.octave)||0;state.capo=Number(snapshot.capo)||0;
    state.neck=['open','triad','barre','power','shell','inversion','color'].includes(snapshot.neck)?snapshot.neck:'open';
    state.transpose=!!snapshot.transpose;state.rows=JSON.parse(JSON.stringify(snapshot.rows||[[]]));if(!state.rows.length)state.rows=[[]];state.selectedRow=0;
    $('capoSelect').value=String(state.capo);$('neckSelect').value=state.neck;$('keyInput').value=snapshot.key||'';$('keyInput').dataset.autoKey=snapshot.key?'0':'1';
    state.player=null;state.playerName='';renderAll();syncBuildInput();autoPopulateKeyFromEntry();
  }
  function coreNotesFor(card,snapshot){
    // v3.3.64 — NEVER replace state.rows while calculating playback notes.
    //
    // coreNotesFor() is called for every scheduled chord. The old implementation
    // used coreSnapshot() as a convenient way to save the current settings, then
    // restored `state.rows` from that JSON-cloned snapshot in finally(). That
    // silently replaced every live card object after the first playback pass.
    // The MIDI resize handles in the already-rendered DOM still referenced the old
    // card objects, so edit #1 worked, Play cloned/replaced the rows, and edit #2+
    // only changed detached objects that playback/save could no longer see.
    //
    // Notes-for-playback only needs the scalar voicing settings below. Preserve and
    // restore those values in place so the live state.rows/card identities survive
    // any number of playback passes and repeated MIDI duration edits.
    const saved={
      instrument:state.instrument,
      mode:state.mode,
      sound:state.sound,
      octave:state.octave,
      capo:state.capo,
      neck:state.neck,
      transpose:state.transpose
    };
    try{
      if(snapshot){state.instrument=normalizeInstrument(snapshot.instrument);state.mode=snapshot.mode||'chord';state.sound=(SOUNDS[state.instrument]||SOUNDS.piano).some(x=>x[0]===snapshot.sound)?snapshot.sound:SOUNDS[state.instrument][0][0];state.octave=Number(snapshot.octave)||0;state.capo=Number(snapshot.capo)||0;state.neck=snapshot.neck||'open';state.transpose=!!snapshot.transpose;}
      return midiNotesForCard(card).map(noteAtMidi);
    } finally {
      state.instrument=saved.instrument;state.mode=saved.mode;state.sound=saved.sound;state.octave=saved.octave;state.capo=saved.capo;state.neck=saved.neck;state.transpose=saved.transpose;
    }
  }
  window.CRPCore={
    snapshot:coreSnapshot,apply:coreApply,notesFor:coreNotesFor,sounds:SOUNDS,cardDurationBeats,soundPreset,soundOutputGain,isBassSound,loadSoundfontInstrument,createInstrumentFxChain,normalizeInstrument,
    scheduleAutoSave,flushAutoSaveNow,renderAll,syncBuildInput,publishSrpHandoff,loadProjectById:loadProject,
    recordUndo,undo:undoEdit,redo:redoEdit,get canUndo(){return undoHistory.undo.length>0;},
    keyTonicName,spellInKey,
    get beats(){return +$('beatsSelect').value||4},get bpm(){return clampBpm($('bpmInput').value)},get loop(){return $('loopToggle').checked},
    get currentProjectId(){return state.currentProjectId||null},get loggedIn(){return !!accountUser},get projectName(){return $('projectName').value.trim()||'Untitled Project'},get projectNotes(){return $('notesEditor').innerHTML},
    startBeat(){const ri=playbackStartRow();return state.rows.slice(0,ri).flat().reduce((n,c)=>n+storedCardDurationBeats(c),0);},
    get autoScroll(){return !!state.autoScroll;},get sustain(){return !!state.sustain;},
    setAutoScroll(on){return setAutoScroll(on);},disableAutoScroll(){disableAutoScrollForManualScroll();},updateAutoScrollUi:updateAutoScrollButton,
    followChordCard(cardIndex){
      let flat=Math.max(0,Number(cardIndex)||0),ri=0,ci=0,found=false;
      for(let r=0;r<state.rows.length;r++){if(flat<state.rows[r].length){ri=r;ci=flat;found=true;break;}flat-=state.rows[r].length;}
      if(!found)return;
      state.selectedRow=ri;realCarouselLines().forEach(el=>el.classList.toggle('selected',+el.dataset.row===ri));updateMobileLineIndicator(ri);
      if(isMidiRollActive()){
        highlightMidiColumn(ri,ci);
        if(state.autoScroll){document.querySelector(`.progression-line:not(.carousel-clone)[data-row="${ri}"]`)?.scrollIntoView({behavior:'smooth',block:'center',inline:'nearest'});midiColumnScrollIntoView(ri,ci,true);}
        return;
      }
      const line=document.querySelector(`.progression-line:not(.carousel-clone)[data-row="${ri}"]`),card=line?.querySelectorAll('.chord-card')[ci];if(!card||!state.autoScroll)return;
      if(isMobileCarousel()){scrollMobileLineTo(ri,true);setTimeout(()=>{if(state.autoScroll)card.scrollIntoView({behavior:'smooth',block:'center',inline:'nearest'});},180);}
      else card.scrollIntoView({behavior:'smooth',block:'center',inline:'nearest'});
    },
    setPlaying(on){state.playing=!!on;setRiderBonesRiding(!!on);$('playAllBtn').textContent=on?'■ Stop':'▶ Play';if(!on){clearPlaybackHighlights();if(pendingEditorReload)setTimeout(reloadOpenProject,0);}},
    status(msg){$('status').textContent=msg||'';},
    setBabyDawSetupHidden(hidden){setWorkspaceSetupHidden('baby-daw',!!hidden);},
    refreshSetupVisibility(){applySetupVisibility();},
    get workspaceMode(){return currentSetupWorkspace();},
    noteAtMidi,
    get songKey(){return activeKey();},
    get enteredSongKey(){return enteredKey();},
    setSongKey(root,minor=false){const el=$('keyInput');if(!el)return;el.value=String(root||'C')+(minor?'m':'');el.dataset.autoKey='0';renderFits();scheduleAutoSave();},
    get mode(){return state.mode;},
    addScaleNote(note){return state.mode==='note'?appendFitValue(note,'note'):false;},
    validateChordSequence(chords){return normalizeChordSequence(chords);},
    validateNote(note){return !!parseNote(note);},
    addProgressionLine(chords,{root=null,minor=false}={}){
      const checked=normalizeChordSequence(chords);if(!checked.valid){$('status').textContent=checked.invalid.length?`Scale Rider chord not supported: ${checked.invalid.join(', ')}`:'No progression chords to add.';return false;}
      const vals=checked.values;
      recordUndo();
      lockAutoSongKey();
      // Reuse a genuinely empty selected line instead of always appending a new one.
      // This keeps a brand-new project on Line 1 when Scale Rider supplies the
      // first progression, while preserving the normal append behavior once the
      // selected line already contains chords or notes.
      const rowIsEmpty=row=>!Array.isArray(row)||!row.some(card=>card&&String(card.value??'').trim());
      let targetRow=0;
      if(!rowIsEmpty(state.rows[0])){
        targetRow=Math.max(0,Math.min(state.rows.length-1,state.selectedRow));
        if(!rowIsEmpty(state.rows[targetRow])){state.rows.push([]);targetRow=state.rows.length-1;}
      }
      state.rows[targetRow]=vals.map(value=>({type:'chord',value}));state.selectedRow=targetRow;state.mode='chord';localStorage.setItem('crp-last-mode','chord');
      if(root)this.setSongKey(root,minor);renderAll();syncBuildInput();window.CRPParts?.syncCoreLive?.();scheduleAutoSave();publishSrpHandoff();return true;
    },
    auditionProgression(chords){
      const checked=normalizeChordSequence(chords);if(!checked.valid){$('status').textContent=checked.invalid.length?`Scale Rider chord not supported: ${checked.invalid.join(', ')}`:'No progression chords to audition.';return;}
      const vals=checked.values;
      // Schedule the entire audition in one unlocked AudioContext pass. This avoids
      // mobile browsers only sounding the first chord when later timer callbacks
      // fall outside the original user gesture.
      (async()=>{
        try{
          const p=await ensureAudio(),bpm=Math.max(40,Math.min(240,+$('bpmInput').value||92)),seconds=60/bpm*Math.max(1,+$('beatsSelect').value||4),start=state.audioCtx.currentTime+.045,duration=Math.max(.35,seconds*.88);
          vals.forEach((value,index)=>{
            const card={type:'chord',value},notes=midiNotesForCard(card).map(noteAtMidi),when=start+index*seconds;
            notes.forEach((n,i)=>p.play(n,when+(state.instrument==='guitar'?i*.035:0),{duration,gain:.95}));
          });
          $('status').textContent=`Auditioning ${vals.length}-chord progression…`;
          setTimeout(()=>{if($('status').textContent.startsWith('Auditioning '))$('status').textContent='';},Math.ceil((vals.length*seconds+.2)*1000));
        }catch(_){$('status').textContent='Could not audition that progression.';}
      })();
    }
  };

  init();
})();

