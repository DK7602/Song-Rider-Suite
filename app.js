(() => {
  const $ = id => document.getElementById(id);
  const NOTES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  const NOTE_INDEX = {C:0,'C#':1,Db:1,D:2,'D#':3,Eb:3,E:4,F:5,'F#':6,Gb:6,G:7,'G#':8,Ab:8,A:9,'A#':10,Bb:10,B:11};

  const QUALITY = {
    '':[0,4,7], m:[0,3,7], '7':[0,4,7,10], maj7:[0,4,7,11], m7:[0,3,7,10],
    '9':[0,4,7,10,14], maj9:[0,4,7,11,14], m9:[0,3,7,10,14],
    add9:[0,4,7,14], madd9:[0,3,7,14], '6':[0,4,7,9], m6:[0,3,7,9],
    sus2:[0,2,7], sus4:[0,5,7], dim:[0,3,6], dim7:[0,3,6,9],
    m7b5:[0,3,6,10], aug:[0,4,8]
  };

  const SOUNDS = {
    piano:[['acoustic_grand_piano','Piano'],['electric_piano_1','Electric Piano'],['synth_strings_1','Synth'],['electric_bass_finger','Bass']],
    guitar:[['acoustic_guitar_steel','Acoustic'],['electric_guitar_clean','Electric'],['electric_bass_finger','Bass']]
  };

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
    instrument: savedInstrument === 'guitar' ? 'guitar' : 'piano',
    mode: localStorage.getItem('crp-last-mode') === 'note' ? 'note' : 'chord',
    sound:'', octave:0, capo:0, neck:'open', transpose:false,
    instrumentBus:null, instrumentLimiter:null,
    rows:[[]], selectedRow:0, playing:false, timer:null,
    audioCtx:null, player:null, playerName:'', currentProjectId:null, drag:null, lineDrag:null,
    autoScroll:localStorage.getItem('crp-auto-scroll')==='1',
    sustain:localStorage.getItem('crp-sustain')==='1'
  };
  state.sound = SOUNDS[state.instrument][0][0];

  function parseRoot(raw) {
    const m=String(raw).trim().replace(/♭/g,'b').replace(/♯/g,'#').match(/^([A-Ga-g])([#b]?)/);
    return m ? m[1].toUpperCase()+m[2] : null;
  }
  function parseChord(raw) {
    raw=String(raw).trim().replace(/♭/g,'b').replace(/♯/g,'#');
    const m=raw.match(/^([A-Ga-g])([#b]?)(.*)$/); if(!m)return null;
    const root=m[1].toUpperCase()+m[2]; if(!(root in NOTE_INDEX))return null;
    let q=m[3].trim().replace(/^minor7$/i,'m7').replace(/^minor$/i,'m').replace(/^min/i,'m')
      .replace(/^major9$/i,'maj9').replace(/^major7$/i,'maj7').replace(/^M7$/,'maj7').replace(/^ø7$/,'m7b5');
    if(!(q in QUALITY))return null;
    return {root,quality:q,display:root+q};
  }
  function parseNote(raw){const r=parseRoot(raw);return r&&r in NOTE_INDEX?r:null;}
  function tokens(text){return text.split(/[\s,|]+/).map(x=>x.trim()).filter(Boolean);}
  function transposeRoot(root,semi){const n=NOTE_INDEX[root];return n==null?root:NOTES[(n+semi+120)%12];}
  function transposeChord(name,semi){const c=parseChord(name);return c?transposeRoot(c.root,semi)+c.quality:name;}
  function chordNotes(name,baseOct=4){const c=parseChord(name);if(!c)return[];return QUALITY[c.quality].map(iv=>{const n=NOTE_INDEX[c.root]+iv;return NOTES[n%12]+(baseOct+Math.floor(n/12));});}
  function midiOf(note){const m=note.match(/^([A-G])(#?)(-?\d+)$/);return m?(Number(m[3])+1)*12+NOTE_INDEX[m[1]+m[2]]:null;}
  function noteAtMidi(m){return NOTES[(m%12+12)%12]+(Math.floor(m/12)-1);}

  // Canonical piano voicing: always spell chords upward from the root.
  // This is the single source used by playback, on-screen diagrams and PDF export.
  // Example: F = F-A-C (never silently C-F-A); extended chords continue upward.
  function canonicalPianoMidis(name,octaveShift=0){
    const c=parseChord(name);if(!c)return[];
    const rootPc=NOTE_INDEX[c.root],baseOct=4+octaveShift;
    return QUALITY[c.quality].map(iv=>midiOf(NOTES[(rootPc+iv)%12]+(baseOct+Math.floor((rootPc+iv)/12))));
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
  function firstChord(){return allCards().find(c=>c.type==='chord')?.value||null;}
  function inferredKey(){const c=firstChord();if(c){const p=parseChord(c);return{root:p.root,minor:p.quality.startsWith('m')&&!p.quality.startsWith('maj')}}const n=allCards().find(c=>c.type==='note')?.value||'C';return{root:n,minor:false};}
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
    state.rows[state.selectedRow]=vals;
    return bad;
  }

  function inferKeyFromCards(cards){
    if(!cards.length)return null;
    const first=cards[0];
    let best=null;
    for(let rootIndex=0;rootIndex<12;rootIndex++){
      for(const minor of [false,true]){
        const ints=minor?[0,2,3,5,7,8,10]:[0,2,4,5,7,9,11];
        const triQ=minor?['m','dim','','m','m','','']:['','m','m','','','m','dim'];
        const sevQ=minor?['m7','m7b5','maj7','m7','m7','maj7','7']:['maj7','m7','m7','maj7','7','m7','m7b5'];
        const scaleRoots=new Set(ints.map(i=>NOTES[(rootIndex+i)%12]));
        const family=new Set();
        ints.forEach((iv,j)=>{
          const r=NOTES[(rootIndex+iv)%12];
          family.add(r+triQ[j]);
          family.add(r+sevQ[j]);
        });
        let score=0;
        for(const card of cards){
          if(card.type==='note'){
            score+=scaleRoots.has(card.value)?3:-5;
            continue;
          }
          const c=parseChord(card.value);if(!c)continue;
          if(family.has(c.display))score+=6;
          else if(scaleRoots.has(NOTES[NOTE_INDEX[c.root]]))score+=1;
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
    return best?{root:best.root,minor:best.minor}:null;
  }
  function cardsFromEntry(){
    return tokens($('chordInput')?.value||'').map(x=>{
      if(state.mode==='chord'){
        const c=parseChord(x);return c?{type:'chord',value:c.display}:null;
      }
      const n=parseNote(x);return n?{type:'note',value:n}:null;
    }).filter(Boolean);
  }
  function autoPopulateKeyFromEntry(){
    const key=$('keyInput');if(!key)return;
    const canAuto=!key.value.trim()||key.dataset.autoKey==='1';
    if(!canAuto)return;
    const inferred=inferKeyFromCards(cardsFromEntry());if(!inferred)return;
    key.value=inferred.root+(inferred.minor?'m':'');
    key.dataset.autoKey='1';
    renderFits();
  }

  function fitItems(){
    const k=activeKey(),r=NOTE_INDEX[k.root],ints=k.minor?[0,2,3,5,7,8,10]:[0,2,4,5,7,9,11];
    if(state.mode==='note')return ints.map(i=>NOTES[(r+i)%12]);
    const triQ=k.minor?['m','dim','','m','m','','']:['','m','m','','','m','dim'];
    const sevQ=k.minor?['m7','m7b5','maj7','m7','m7','maj7','7']:['maj7','m7','m7','maj7','7','m7','m7b5'];
    const tri=ints.map((i,j)=>NOTES[(r+i)%12]+triQ[j]);
    const sev=ints.map((i,j)=>NOTES[(r+i)%12]+sevQ[j]);
    const tonic=NOTES[r],fifth=NOTES[(r+7)%12];
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

  function instrumentOutputGain(){
    // MusyngKite instrument samples are much quieter than the drum WAVs.
    // These multipliers normalize the four main chord instruments so they
    // remain clearly audible at ordinary phone/device volume.
    const gains={
      acoustic_grand_piano:2.75,
      electric_piano_1:2.75,
      acoustic_guitar_steel:2.95,
      electric_guitar_clean:2.85,
      synth_strings_1:1.10,
      electric_bass_finger:1.10
    };
    return gains[state.sound]||1.0;
  }
  function ensureInstrumentBus(){
    if(state.instrumentBus&&state.instrumentLimiter)return;
    const bus=state.audioCtx.createGain();
    const limiter=state.audioCtx.createDynamicsCompressor();
    limiter.threshold.value=-3;
    limiter.knee.value=0;
    limiter.ratio.value=20;
    limiter.attack.value=.003;
    limiter.release.value=.12;
    bus.connect(limiter).connect(state.audioCtx.destination);
    state.instrumentBus=bus;
    state.instrumentLimiter=limiter;
  }
  function ensureAudio(){
    if(!state.audioCtx)state.audioCtx=new (window.AudioContext||window.webkitAudioContext)();
    if(state.audioCtx.state==='suspended')state.audioCtx.resume();
    ensureInstrumentBus();
    state.instrumentBus.gain.value=instrumentOutputGain();
    if(state.player&&state.playerName===state.sound)return Promise.resolve(state.player);
    if(!window.Soundfont)return Promise.reject(new Error('Sound engine unavailable'));
    $('status').textContent='Loading instrument samples…';
    return Soundfont.instrument(state.audioCtx,state.sound,{format:'mp3',soundfont:'MusyngKite',destination:state.instrumentBus}).then(p=>{state.player=p;state.playerName=state.sound;$('status').textContent='';return p;});
  }
  async function playCard(card,seconds=1.5){
    const p=await ensureAudio(),val=displayedValue(card);let notes;
    if(card.type==='note'){const oct=(state.instrument==='piano'?4:3)+state.octave;notes=[val+oct];}
    else if(state.instrument==='guitar'){
      // Play the actual selected guitar voicing so what you hear matches the diagram.
      const frets=guitarShapeForCard(card),opens=[40,45,50,55,59,64];
      notes=frets.map((f,i)=>f==null?null:noteAtMidi(opens[i]+f+state.capo+state.octave*12)).filter(Boolean);
      if(!notes.length)notes=chordNotes(val,3+state.octave);
    }else notes=pianoMidisForCard(card).map(noteAtMidi);
    if(state.sound==='electric_bass_finger')notes=notes.slice(0,card.type==='note'?1:3).map(n=>noteAtMidi(midiOf(n)-12));
    // Keep note gain near unity; overall instrument loudness is handled by
    // the normalized instrument bus above, followed by a peak limiter.
    const now=state.audioCtx.currentTime;notes.forEach((n,i)=>p.play(n,now+(state.instrument==='guitar'?i*.035:0),{duration:seconds,gain:.95}));
  }
  function setRiderBonesRiding(on){['riderBonesLeft','riderBonesRight'].forEach(id=>{const img=$(id);if(img)img.src=on?img.dataset.animated:img.dataset.still;});}

  function pianoSvg(card){
    const val=displayedValue(card),mids=pianoMidisForCard(card),targets=new Set(mids);
    let start=Math.min(...mids)-2,end=Math.max(...mids)+3;const black=m=>NOTES[(m%12+12)%12].includes('#');
    while(black(start))start--;while(black(end-1))end++;while(end-start<10){start--;if(black(start))start--;if(end-start>=10)break;end++;if(black(end-1))end++;}
    const whites=[];for(let m=start;m<end;m++)if(!black(m))whites.push(m);
    const ww=46,w=whites.length*ww,h=164,xmap=new Map();let ws='',bs='';
    whites.forEach((m,i)=>{const x=i*ww,pc=NOTES[m%12],hit=targets.has(m);xmap.set(m,x);ws+=`<rect x="${x}" y="18" width="${ww}" height="132" rx="2" fill="${hit?'#e9c46a':'#f6f2e7'}" stroke="#171717" stroke-width="2"/>`;if(hit)ws+=`<text x="${x+ww/2}" y="136" text-anchor="middle" font-size="16" font-weight="800" fill="#161616">${pc}</text>`;});
    for(let m=start;m<end;m++){if(!black(m))continue;const px=xmap.get(m-1);if(px==null)continue;const hit=targets.has(m),pc=NOTES[m%12],bx=px+ww-14;bs+=`<rect x="${bx}" y="18" width="28" height="82" rx="2" fill="${hit?'#f4a261':'#1a1a1a'}" stroke="#080808" stroke-width="1.5"/>`;if(hit)bs+=`<text x="${bx+14}" y="78" text-anchor="middle" font-size="11" font-weight="800" fill="#fff">${pc}</text>`;}
    return `<svg viewBox="0 0 ${w} ${h}"><text x="4" y="12" fill="#9aa3ad" font-size="11">Octave ${state.octave>0?'+':''}${state.octave}</text>${ws}${bs}</svg>`;
  }

  function chordCoreIntervals(c){
    const q=c.quality;
    if(q==='dim'||q==='dim7'||q==='m7b5')return[0,3,6];
    if(q==='aug')return[0,4,8];
    if(q==='sus2')return[0,2,7];
    if(q==='sus4')return[0,5,7];
    return q.startsWith('m')&&!q.startsWith('maj')?[0,3,7]:[0,4,7];
  }
  function seventhInterval(c){
    if(['7','9','m7','m9','m7b5'].includes(c.quality))return 10;
    if(['maj7','maj9'].includes(c.quality))return 11;
    if(c.quality==='dim7')return 9;
    return null;
  }
  function extensionInterval(c){
    if(['9','maj9','m9','add9','madd9'].includes(c.quality))return 2;
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
  function guitarShapeForName(name){
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
    let svg=`<svg viewBox="0 0 ${W} ${H}"><text x="10" y="18" fill="#9aa3ad" font-size="12">${state.capo?`Capo ${state.capo}${state.transpose?' • transpose view':''}`:`Fret ${start}`}</text>`;
    for(let s=0;s<6;s++){const x=L+s*sg;svg+=`<line x1="${x}" y1="${T}" x2="${x}" y2="${T+nf*fg}" stroke="#d8dde4" stroke-width="${1+s*.12}"/><text x="${x}" y="${T+nf*fg+24}" text-anchor="middle" fill="#8f99a5" font-size="12">${tuning[s]}</text>`;}
    for(let f=0;f<=nf;f++){const y=T+f*fg;svg+=`<line x1="${L}" y1="${y}" x2="${L+5*sg}" y2="${y}" stroke="${f===0?'#f3f4f6':'#737d89'}" stroke-width="${f===0?4:1.4}"/>`;}
    frets.forEach((f,s)=>{const x=L+s*sg;if(f==null){if(card.type==='chord')svg+=`<text x="${x}" y="29" text-anchor="middle" fill="#e76f51" font-size="15">×</text>`;return;}if(f===0){svg+=`<circle cx="${x}" cy="24" r="8" fill="none" stroke="#e9c46a" stroke-width="2"/>`;return;}let rel=f-start;if(rel<0||rel>=nf)rel=Math.max(0,Math.min(nf-1,f%nf));const y=T+(rel+.5)*fg,pc=card.type==='note'?shown:NOTES[([40,45,50,55,59,64][s]+f)%12];svg+=`<circle cx="${x}" cy="${y}" r="14" fill="#e9c46a" stroke="#201b0e" stroke-width="2"/><text x="${x}" y="${y+4.5}" text-anchor="middle" fill="#16120a" font-size="11" font-weight="900">${pc}</text>`;});
    return svg+'</svg>';
  }

  function subtitle(card){
    if(state.instrument!=='guitar')return'';
    const labels={open:'Open / Easy',triad:'Triad',barre:'Barre Chord',power:'Power Chord',shell:'Shell Voicing',inversion:'1st Inversion',color:'Color / Extended'};
    const shape=shapeValue(card),sound=displayedValue(card),kind=card.type==='chord'?labels[state.neck]||labels.open:'';
    if(!state.capo)return kind;
    const capoText=state.transpose?`${card.value} shape → sounds ${sound}`:(shape===card.value?`Capo ${state.capo}`:`Play ${shape} shape → sounds ${card.value}`);
    return [kind,capoText].filter(Boolean).join(' • ');
  }

  function isMobileCarousel(){return window.matchMedia('(max-width:700px)').matches;}
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

    let settleTimer=null,carouselTeleporting=false;
    const instantCarouselJump=target=>{
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
    };
    const settle=()=>{
      if(carouselTeleporting)return;
      const items=[...wrap.querySelectorAll(':scope > .progression-line')];if(!items.length)return;
      const wr=wrap.getBoundingClientRect(),cx=wr.left+wr.width/2;
      let nearest=items[0],dist=Infinity;
      items.forEach(el=>{const r=el.getBoundingClientRect(),d=Math.abs((r.left+r.width/2)-cx);if(d<dist){dist=d;nearest=el;}});
      if(nearest.classList.contains('carousel-clone')){
        const ri=+nearest.dataset.cloneTarget||0;
        const target=wrap.querySelector(`.progression-line:not(.carousel-clone)[data-row="${ri}"]`);
        instantCarouselJump(target);
        setCarouselSelectedRow(ri);
      }else setCarouselSelectedRow(+nearest.dataset.row||0);
    };
    wrap.addEventListener('scroll',()=>{
      if(carouselTeleporting)return;
      clearTimeout(settleTimer);settleTimer=setTimeout(settle,90);
    },{passive:true});

    // A deliberate horizontal swipe takes control away from playback-follow mode.
    let tx=null,ty=null;
    wrap.addEventListener('touchstart',e=>{if(!e.touches?.length)return;tx=e.touches[0].clientX;ty=e.touches[0].clientY;},{passive:true});
    wrap.addEventListener('touchmove',e=>{
      if(tx==null||!e.touches?.length)return;
      const dx=e.touches[0].clientX-tx,dy=e.touches[0].clientY-ty;
      if(Math.abs(dx)>12&&Math.abs(dx)>Math.abs(dy)){tx=ty=null;if(state.autoScroll)disableAutoScrollForManualScroll();}
    },{passive:true});
    wrap.addEventListener('touchend',()=>{tx=ty=null;},{passive:true});

    requestAnimationFrame(()=>scrollMobileLineTo(state.selectedRow,false));
    updateMobileLineIndicator(state.selectedRow);
  }

  function moveDragged(toRow,toIndex){
    if(state.autoScroll){state.drag=null;$('status').textContent='Turn Auto Scroll off to reorder cards.';return;}
    if(!state.drag)return;const {row:fr,index:fi}=state.drag,card=state.rows[fr][fi];if(!card)return;
    state.rows[fr].splice(fi,1);if(fr===toRow&&fi<toIndex)toIndex--;state.rows[toRow].splice(Math.max(0,toIndex),0,card);state.selectedRow=toRow;state.drag=null;$('status').textContent='';renderRows();syncBuildInput();scheduleAutoSave();
  }
  function clearLineDropMarkers(){
    document.querySelectorAll('.progression-line').forEach(el=>el.classList.remove('line-moving','line-drop-before','line-drop-after'));
  }
  function moveWholeLine(from,insertionIndex){
    if(from<0||from>=state.rows.length)return;
    insertionIndex=Math.max(0,Math.min(state.rows.length,insertionIndex));
    const selected=state.rows[state.selectedRow];
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

        lineHold=setTimeout(()=>{
          if(state.autoScroll)return;
          lineMoveActive=true;state.lineDrag={from:ri,insert:ri};
          try{badge.setPointerCapture?.(pointerId);}catch(_){}
          line.classList.add('line-moving');document.body.classList.add('moving-line');
          $('status').textContent=isMobileCarousel()?'Move the line left or right, then release.':'Move the whole line, then release.';
          navigator.vibrate?.(20);updateLineDestination(lastX,lastY);
        },450);
      });
      badge.addEventListener('pointerleave',()=>{if(!lineMoveActive){/* document listeners keep tracking until release */}});
      badge.addEventListener('click',e=>{if(suppressBadgeClick){e.preventDefault();e.stopPropagation();suppressBadgeClick=false;}});
      line.querySelector('.duplicate-line').onclick=e=>{
        e.stopPropagation();
        const copy=row.map(card=>({...card}));
        state.rows.splice(ri+1,0,copy);
        state.selectedRow=ri+1;
        renderRows();
        syncBuildInput();
        renderFits();
        scheduleAutoSave();
        $('status').textContent=`Line ${ri+1} duplicated.`;
        if(isMobileCarousel())requestAnimationFrame(()=>scrollMobileLineTo(ri+1,true));
      };
      line.querySelector('.delete-line').onclick=e=>{e.stopPropagation();if(state.rows.length===1){state.rows[0]=[];state.selectedRow=0;}else{state.rows.splice(ri,1);if(state.selectedRow>ri)state.selectedRow--;else if(state.selectedRow===ri)state.selectedRow=Math.min(ri,state.rows.length-1);}renderRows();syncBuildInput();renderFits();scheduleAutoSave();};
      line.onclick=e=>{if(!e.target.closest('.chord-card')){state.selectedRow=ri;realCarouselLines().forEach(x=>x.classList.toggle('selected',+x.dataset.row===ri));syncBuildInput();updateMobileLineIndicator(ri);}};
      line.addEventListener('dragover',e=>{if(state.autoScroll)return;e.preventDefault();line.classList.add('drop-target');});
      line.addEventListener('dragleave',()=>line.classList.remove('drop-target'));
      line.addEventListener('drop',e=>{if(state.autoScroll)return;e.preventDefault();line.classList.remove('drop-target');moveDragged(ri,row.length);});
      if(!row.length){const empty=document.createElement('div');empty.className='empty-line';empty.textContent='Empty line — tap to select or drop a card here';line.appendChild(empty);}
      row.forEach((card,ci)=>{
        const el=document.createElement('div');el.className='chord-card'+(card.type==='note'?' note-card':'');el.draggable=!state.autoScroll;
        const shown=displayedValue(card),sub=subtitle(card),hint=state.autoScroll?'Tap to play • Auto Scroll locks reordering':'Tap to play • hold & drag to move';
        el.innerHTML=`<div class="card-top"><span class="chord-name">${shown}</span><button class="remove">×</button></div>${sub?`<div class="card-subtitle">${sub}</div>`:''}<div class="diagram">${state.instrument==='piano'?pianoSvg(card):guitarSvg(card)}</div><div class="hint">${hint}</div>`;
        el.querySelector('.remove').onclick=e=>{e.stopPropagation();row.splice(ci,1);renderRows();syncBuildInput();renderFits();scheduleAutoSave();};
        el.onclick=e=>{e.stopPropagation();state.selectedRow=ri;if(!e.target.closest('.remove')){const bpm=Math.max(40,Math.min(240,+$('bpmInput').value||92)),beats=+$('beatsSelect').value||4,stepSeconds=60/bpm*beats;playCard(card,state.sustain?Math.max(.4,stepSeconds*1.03):Math.max(.35,stepSeconds*.62));}};
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

  function renderFits(){
    $('fitHeading').textContent=state.mode==='chord'?'Chords that fit':'Notes that fit';const k=activeKey(),manual=enteredKey();
    $('keyHint').textContent=`Based on the ${k.root}${k.minor?' minor':' major'} family`;
    const w=$('compatibleChords');w.innerHTML='';fitItems().forEach(v=>{const b=document.createElement('button');b.className='chip';b.textContent=v;b.onclick=()=>{
      // Treat whatever is currently typed in the Build field as the source of truth
      // before appending a chip. This preserves manually typed chords/notes and
      // prevents stale row state from wiping or duplicating the entry.
      const bad=commitBuildInput();
      selectedRow().push({type:state.mode,value:v});
      $('status').textContent=bad.length?`Skipped unrecognized: ${bad.join(', ')}`:'';
      syncBuildInput();autoPopulateKeyFromEntry();renderAll();scheduleAutoSave();
    };w.appendChild(b);});
  }
  function renderSound(){const s=$('soundSelect');s.innerHTML='';SOUNDS[state.instrument].forEach(([v,l])=>{const o=document.createElement('option');o.value=v;o.textContent=l;s.appendChild(o);});if(!SOUNDS[state.instrument].some(x=>x[0]===state.sound))state.sound=SOUNDS[state.instrument][0][0];s.value=state.sound;}
  function renderAll(){
    renderSound();document.querySelectorAll('#instrumentTabs .seg').forEach(b=>b.classList.toggle('active',b.dataset.instrument===state.instrument));document.querySelectorAll('#modeTabs .seg').forEach(b=>b.classList.toggle('active',b.dataset.mode===state.mode));
    $('octaveValue').textContent=state.octave>0?'+'+state.octave:state.octave;$('capoWrap').style.display=$('transposeWrap').style.display=state.instrument==='guitar'?'':'none';$('neckWrap').style.display=state.instrument==='guitar'&&state.mode==='chord'?'':'none';$('neckSelect').value=state.neck;
    $('transposeBtn').textContent=state.transpose?'Transpose ON':'Transpose OFF';$('transposeBtn').classList.toggle('on',state.transpose);$('transposeBtn').setAttribute('aria-pressed',String(state.transpose));
    $('chordInput').placeholder=state.mode==='chord'?'Enter chords, e.g. Em A7 Cmaj7 B7':'Enter notes, e.g. E F# A B';renderFits();renderRows();
  }

  function updateAutoScrollButton(){
    const b=$('autoScrollBtn'); if(!b)return;
    b.classList.toggle('on',state.autoScroll);
    b.setAttribute('aria-pressed',String(state.autoScroll));
    b.setAttribute('title',state.autoScroll?'Auto scroll on':'Auto scroll off');
    b.setAttribute('aria-label',state.autoScroll?'Auto scroll on':'Auto scroll off');
    b.textContent='↕';
    applyProgressionEditLock();
  }

  function disableAutoScrollForManualScroll(){
    if(!state.autoScroll)return;
    state.autoScroll=false;
    localStorage.setItem('crp-auto-scroll','0');
    updateAutoScrollButton();
    $('status').textContent='Auto scroll off — manual scrolling detected.';
  }

  function updateSustainButton(){
    const b=$('sustainBtn'); if(!b)return;
    b.classList.toggle('on',state.sustain);
    b.setAttribute('aria-pressed',String(state.sustain));
    b.textContent=state.sustain?'ON':'OFF';
    b.title=state.sustain?'Sustain on — notes ring for the full beat':'Sustain off';
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
    if(window.CRPParts?.handlesPlayback)return window.CRPParts.togglePlayback();
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
    let nextStepAt=performance.now();
    const step=async()=>{
      if(!state.playing)return;
      const list=state.rows.flatMap((r,ri)=>r.map((c,ci)=>({c,ri,ci})));
      if(!list.length)return stopProgression();
      if(idx>=list.length){if($('loopToggle').checked)idx=0;else return stopProgression();}
      const bpm=Math.max(40,Math.min(240,+$('bpmInput').value||92)),beats=+$('beatsSelect').value||4,ms=60000/bpm*beats,item=list[idx++];
      const stepSeconds=ms/1000;
      const noteSeconds=state.sustain
        ? Math.max(.4,stepSeconds*1.03)
        : Math.max(.35,stepSeconds*.62);
      await playCard(item.c,noteSeconds);
      document.querySelectorAll('.chord-card').forEach(c=>c.style.outline='');
      // In mobile infinite-carousel mode there is a visual clone of the last line
      // before Line 1. Always target the real project line so Auto Scroll never
      // mistakes that edge clone for the actual last line.
      const playingLine=document.querySelector(`.progression-line:not(.carousel-clone)[data-row="${item.ri}"]`);
      const playingCard=playingLine?.querySelectorAll('.chord-card')[item.ci];
      playingCard?.style.setProperty('outline','2px solid var(--accent)');
      if(state.autoScroll&&playingCard){
        if(isMobileCarousel()){
          scrollMobileLineTo(item.ri,true);
          updateMobileLineIndicator(item.ri);
          setTimeout(()=>{if(state.autoScroll)playingCard.scrollIntoView({behavior:'smooth',block:'center',inline:'nearest'});},180);
        }else playingCard.scrollIntoView({behavior:'smooth',block:'center',inline:'nearest'});
      }
      nextStepAt += ms;
      state.timer=setTimeout(step,Math.max(0,nextStepAt-performance.now()));
    };
    step();
  }
  function stopProgression(){if(window.CRPParts?.handlesPlayback&&window.CRPParts?.isPlaying?.())return window.CRPParts.stopPlayback();state.playing=false;clearTimeout(state.timer);state.timer=null;setRiderBonesRiding(false);$('playAllBtn').textContent='▶ Play';document.querySelectorAll('.chord-card').forEach(c=>c.style.outline='');}

  let accountUser=null, cloudProjects=null, cloudSyncState='idle';
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
    const stateText=cloudSyncState==='ready'?'Synced':cloudSyncState==='error'?'Local backup':'Syncing…';
    btn.innerHTML=`<span>☁ ${esc(accountDisplayName())}</span><span class="cloud-state">${stateText} ▾</span>`;
  }
  function localProjects(){try{return JSON.parse(localStorage.getItem('crp-projects')||'[]')}catch{return[]}}
  function saveLocalProjects(p){localStorage.setItem('crp-projects',JSON.stringify(p))}
  async function api(path,options={}){const r=await fetch(path,{...options,headers:{'Content-Type':'application/json',...(options.headers||{})}});let d={};try{d=await r.json()}catch{}if(!r.ok)throw new Error(d.error||`Request failed (${r.status})`);return d;}
  function newProject(){
    if(state.playing)stopProgression();
    closeExportMenu?.();

    // Flush any pending edits on the current saved project before leaving it.
    flushAutoSaveNow();

    // Start a fresh project instead of adding another line to the current one.
    state.currentProjectId=null;
    try{localStorage.removeItem('crp-active-project-id');}catch{}
    state.rows=[[]];
    state.selectedRow=0;
    state.capo=0;
    state.neck='open';
    state.transpose=false;

    $('projectName').value='';
    $('chordInput').value='';
    $('keyInput').value='';
    $('keyInput').dataset.autoKey='1';
    $('bpmInput').value=92;
    $('beatsSelect').value=4;
    $('loopToggle').checked=true;
    $('notesEditor').innerHTML='';
    $('capoSelect').value='0';
    $('neckSelect').value='open';

    // A new project always starts with a blank beat.
    window.CRPBeatMaker?.loadProject?.(null);

    renderAll();
    syncBuildInput();
    renderFits();
    window.CRPParts?.newProject?.();
    $('status').textContent='New blank project.';
    $('projectName').focus();
  }

  function capture(id,name){
    const existing=id?localProjects().find(x=>x.id===id):null;
    const liveBeat=window.CRPBeatMaker?.getBeat?.();
    return{id:id||(crypto.randomUUID?crypto.randomUUID():String(Date.now())),name,updatedAt:Date.now(),archived:!!existing?.archived,instrument:state.instrument,mode:state.mode,sound:state.sound,octave:state.octave,capo:state.capo,neck:state.neck,transpose:state.transpose,rows:state.rows,bpm:+$('bpmInput').value||92,beats:+$('beatsSelect').value||4,loop:$('loopToggle').checked,notes:$('notesEditor').innerHTML,key:$('keyInput').value.trim(),beatMaker:liveBeat||existing?.beatMaker,beatMakerUpdatedAt:window.CRPBeatMaker?.getUpdatedAt?.()||existing?.beatMakerUpdatedAt||0,parts:window.CRPParts?.capture?.()||existing?.parts};
  }
  function upsertLocal(p){const ps=localProjects(),i=ps.findIndex(x=>x.id===p.id);if(i>=0)ps[i]=p;else ps.unshift(p);saveLocalProjects(ps);}
  async function refreshCloudProjects(){
    if(!accountUser){cloudProjects=null;cloudSyncState='idle';renderProjects();return;}
    cloudSyncState='syncing';updateAccountSummary();
    try{
      const d=await api('/api/projects');
      const incoming=d.projects||[];
      const locals=localProjects();
      const localById=new Map(locals.map(p=>[String(p?.id||''),p]));
      cloudProjects=incoming.map(remote=>{
        const local=localById.get(String(remote?.id||''));
        if(!local)return remote;
        const localNewer=Number(local?.updatedAt||0)>Number(remote?.updatedAt||0);
        // Merge the general project by project timestamp, but merge Baby DAW parts and drums
        // by their own edit clocks. This prevents a deleted vocal or a newly-written beat from
        // being resurrected/erased by an older cloud snapshot with a newer server timestamp.
        const merged=localNewer?{...remote,...local}:{...local,...remote};
        const lp=Number(local?.parts?.updatedAt||0), rp=Number(remote?.parts?.updatedAt||0);
        if(lp||rp) merged.parts = lp>=rp ? local.parts : remote.parts;
        else if(localNewer && local.parts) merged.parts=local.parts;
        const lb=Number(local?.beatMakerUpdatedAt||0), rb=Number(remote?.beatMakerUpdatedAt||0);
        if(lb||rb){
          if(lb>=rb){merged.beatMaker=local.beatMaker;merged.beatMakerUpdatedAt=lb;}
          else {merged.beatMaker=remote.beatMaker;merged.beatMakerUpdatedAt=rb;}
        }else if(localNewer && local.beatMaker){merged.beatMaker=local.beatMaker;}
        return merged;
      });
      cloudProjects.forEach(p=>upsertLocal(p));
      cloudSyncState='ready';updateAccountSummary();renderProjects();
    }catch(e){cloudSyncState='error';updateAccountSummary();$('status').textContent='Cloud sync unavailable — using local backup.';renderProjects();}
  }
  let autoSaveTimer=null, autoSaveRunning=false, autoSaveQueued=false;

  function updateCloudSnapshot(p){
    if(!cloudProjects)return;
    const i=cloudProjects.findIndex(x=>x.id===p.id);
    if(i>=0)cloudProjects[i]=p;
    else cloudProjects.unshift(p);
  }

  function scheduleAutoSave(){
    // The hidden SRP playback bridge is strictly read-only. It must never persist its
    // in-memory playback copy over the real Baby DAW project.
    if(IS_PLAYBACK_BRIDGE)return;
    window.CRPParts?.syncActiveChord?.();
    publishSrpHandoff();
    // Brand-new/unnamed projects wait for the first manual Save.
    if(!state.currentProjectId)return;
    clearTimeout(autoSaveTimer);
    autoSaveTimer=setTimeout(()=>runAutoSave(),850);
  }

  function flushAutoSaveNow(){
    clearTimeout(autoSaveTimer);
    autoSaveTimer=null;
    if(state.currentProjectId)runAutoSave();
  }

  async function runAutoSave(){
    if(IS_PLAYBACK_BRIDGE){clearTimeout(autoSaveTimer);autoSaveTimer=null;autoSaveQueued=false;return;}
    clearTimeout(autoSaveTimer);
    autoSaveTimer=null;
    if(!state.currentProjectId)return;

    if(autoSaveRunning){
      autoSaveQueued=true;
      return;
    }

    autoSaveRunning=true;
    const projectId=state.currentProjectId;
    const existing=localProjects().find(x=>x.id===projectId);
    const name=$('projectName').value.trim()||existing?.name||`Chord Project ${new Date().toLocaleDateString()}`;
    const p=capture(projectId,name);

    // Local save happens synchronously first, so edits are protected even if cloud is unavailable.
    upsertLocal(p);
    publishSrpHandoff();
    updateCloudSnapshot(p);
    renderProjects();

    if(accountUser){
      try{
        await api('/api/projects',{method:'POST',body:JSON.stringify({project:p})});
        await window.CRPParts?.syncCloudAudio?.(projectId);
        cloudSyncState='ready';
        updateAccountSummary();
      }catch(e){
        cloudSyncState='error';
        updateAccountSummary();
        $('status').textContent=`Autosaved locally; cloud sync failed: ${e.message}`;
      }
    }

    autoSaveRunning=false;
    if(autoSaveQueued){
      autoSaveQueued=false;
      // If the same saved project changed while the cloud request was in flight,
      // immediately write the newest snapshot.
      if(state.currentProjectId===projectId)runAutoSave();
    }
  }

  async function saveProject(){
    clearTimeout(autoSaveTimer);autoSaveTimer=null;
    // If navigation temporarily lost the in-memory id, recover the exact saved project
    // instead of creating a duplicate with a new UUID.
    if(!state.currentProjectId){
      try{
        const storedId=String(localStorage.getItem('crp-active-project-id')||'').trim();
        if(storedId && localProjects().some(x=>String(x?.id||'')===storedId)) state.currentProjectId=storedId;
      }catch{}
    }
    const name=$('projectName').value.trim()||`Chord Project ${new Date().toLocaleDateString()}`,p=capture(state.currentProjectId,name);
    state.currentProjectId=p.id;try{localStorage.setItem('crp-active-project-id',String(p.id));}catch{}$('projectName').value=name;upsertLocal(p);publishSrpHandoff();
    if(accountUser){
      try{
        const d=await api('/api/projects',{method:'POST',body:JSON.stringify({project:p})});
        upsertLocal(d.project);
        await window.CRPParts?.syncCloudAudio?.(p.id);
        await refreshCloudProjects();
        $('status').textContent=`Saved “${name}” and vocal audio to cloud.`;
      }catch(e){$('status').textContent=`Saved locally; cloud sync failed: ${e.message}`;}
    }else{$('status').textContent=`Saved “${name}” on this device.`;renderProjects();}
  }
  let projectBrowserMode='projects';

  function projectSource(){return (accountUser&&cloudProjects)?cloudProjects:localProjects();}

  function restoreActiveProjectFromStorage(){
    try{
      if(state.currentProjectId)return true;
      const id=String(localStorage.getItem('crp-active-project-id')||'').trim();
      if(!id)return false;
      const p=localProjects().find(x=>String(x?.id||'')===id);
      if(!p){localStorage.removeItem('crp-active-project-id');return false;}
      loadProject(p.id);
      return true;
    }catch(err){console.error('Could not restore active CRP project',err);return false;}
  }

  function setProjectBrowserMode(mode){
    projectBrowserMode=mode==='archive'?'archive':'projects';
    $('projectsTabBtn')?.classList.toggle('active',projectBrowserMode==='projects');
    $('archiveTabBtn')?.classList.toggle('active',projectBrowserMode==='archive');
    $('projectsTabBtn')?.setAttribute('aria-selected',String(projectBrowserMode==='projects'));
    $('archiveTabBtn')?.setAttribute('aria-selected',String(projectBrowserMode==='archive'));
    renderProjects();
    const win=document.querySelector('.project-browser-window');
    if(win)win.scrollTop=0;
  }

  async function setProjectArchived(project,archived){
    const p={...project,archived:!!archived,updatedAt:Date.now()};
    upsertLocal(p);
    publishSrpHandoff();
    updateCloudSnapshot(p);
    renderProjects();

    if(accountUser){
      try{
        const d=await api('/api/projects',{method:'POST',body:JSON.stringify({project:p})});
        if(d?.project){upsertLocal(d.project);updateCloudSnapshot(d.project);}
        cloudSyncState='ready';
        updateAccountSummary();
        renderProjects();
      }catch(err){
        cloudSyncState='error';
        updateAccountSummary();
        $('status').textContent=`${archived?'Archived':'Restored'} locally; cloud sync failed: ${err.message}`;
      }
    }

    $('status').textContent=archived
      ? `“${p.name}” moved to Archive.`
      : `“${p.name}” restored to Projects.`;
  }
  function loadProject(id){if(state.currentProjectId&&state.currentProjectId!==id)flushAutoSaveNow();let p=projectSource().find(x=>x.id===id)||localProjects().find(x=>x.id===id);if(!p)return;p=recoverNavigationSnapshot(p);upsertLocal(p);const __srpSession=readSrpLinkSession();const shared=(__srpSession&&String(__srpSession.crpProjectId||'')===String(id))?readSharedSrpMeta(id):null;if(shared){p={...p,bpm:Number.isFinite(Number(shared.bpm))?Number(shared.bpm):p.bpm,capo:Number.isFinite(Number(shared.capo))?Number(shared.capo):p.capo,octave:Number.isFinite(Number(shared.octave))?Number(shared.octave):p.octave,transpose:typeof shared.transpose==='boolean'?shared.transpose:p.transpose,key:String(shared.key??p.key??'')};upsertLocal(p);updateCloudSnapshot(p);}state.currentProjectId=id;try{localStorage.setItem('crp-active-project-id',String(id));}catch{}state.instrument=p.instrument||'piano';state.mode=p.mode||'chord';state.sound=p.sound||SOUNDS[state.instrument][0][0];state.octave=p.octave||0;state.capo=p.capo||0;state.neck=['open','triad','barre','power','shell','inversion','color'].includes(p.neck)?p.neck:'open';state.transpose=!!p.transpose;state.rows=p.rows||[(p.chords||[]).map(v=>({type:'chord',value:v}))];if(!state.rows.length)state.rows=[[]];state.selectedRow=0;$('projectName').value=p.name;$('bpmInput').value=p.bpm||92;$('beatsSelect').value=p.beats||4;$('loopToggle').checked=p.loop!==false;$('notesEditor').innerHTML=p.notes||'';$('capoSelect').value=state.capo;$('neckSelect').value=state.neck;$('keyInput').value=p.key||'';$('keyInput').dataset.autoKey=p.key?'0':'1';renderAll();syncBuildInput();autoPopulateKeyFromEntry();window.CRPBeatMaker?.loadProject?.(p);window.CRPParts?.loadProject?.(p);}
  function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));}
  function renderProjects(){
    const w=$('projectList');
    const all=[...projectSource()].sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0));
    const active=all.filter(p=>!p.archived), archived=all.filter(p=>!!p.archived);
    const ps=projectBrowserMode==='archive'?archived:active;

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
      e.className='project-item'+(state.currentProjectId===p.id?' current':'');
      const count=p.rows?p.rows.flat().length:(p.chords||[]).length;
      const moveLabel=projectBrowserMode==='archive'?'Restore':'Archive';
      e.innerHTML=`<div class="name">${esc(p.name)}</div><div class="meta">${count} cards</div><button class="open">Open</button><button class="rename">Rename</button><button class="archive-toggle">${moveLabel}</button><button class="delete">Delete</button>`;

      e.querySelector('.open').onclick=()=>loadProject(p.id);

      e.querySelector('.rename').onclick=async()=>{
        const n=prompt('New project name:',p.name);
        if(!n?.trim())return;
        const name=n.trim(),locals=localProjects(),i=locals.findIndex(x=>x.id===p.id);
        if(i>=0){locals[i].name=name;locals[i].updatedAt=Date.now();saveLocalProjects(locals);}
        if(cloudProjects){const ci=cloudProjects.findIndex(x=>x.id===p.id);if(ci>=0)cloudProjects[ci]={...cloudProjects[ci],name,updatedAt:Date.now()};}
        if(state.currentProjectId===p.id)$('projectName').value=name;

        if(accountUser){
          try{
            await api('/api/projects/'+encodeURIComponent(p.id),{method:'PATCH',body:JSON.stringify({name})});
            await refreshCloudProjects();
          }catch(err){
            $('status').textContent='Rename saved locally; cloud sync failed.';
            renderProjects();
          }
        }else renderProjects();
      };

      e.querySelector('.archive-toggle').onclick=()=>setProjectArchived(p,projectBrowserMode!=='archive');

      e.querySelector('.delete').onclick=async()=>{
        if(!confirm(`Delete “${p.name}”?`))return;
        if(state.currentProjectId===p.id){
          clearTimeout(autoSaveTimer);autoSaveTimer=null;state.currentProjectId=null;
        }
        saveLocalProjects(localProjects().filter(x=>x.id!==p.id));
        if(cloudProjects)cloudProjects=cloudProjects.filter(x=>x.id!==p.id);
        if(accountUser){
          try{
            await api('/api/projects/'+encodeURIComponent(p.id),{method:'DELETE'});
            await refreshCloudProjects();
          }catch(err){
            $('status').textContent='Deleted locally; cloud delete failed.';
            renderProjects();
          }
        }else renderProjects();
      };
      w.appendChild(e);
    });
  }
  function showAccount(){const logged=!!accountUser;const panel=$('accountPanel');panel?.classList.toggle('is-logged-in',logged);$('accountSummaryBtn').hidden=!logged;$('authForms').hidden=logged;$('accountTools').hidden=!logged;$('logoutBtn').hidden=!logged;$('accountStatus').textContent=logged?`Signed in as ${accountDisplayName()}`:'Not signed in — local projects still work.';$('projectStorageLabel').textContent=logged?'Synced to your cloud account':'Saved on this device';if(logged){updateAccountSummary();setAccountCollapsed(true);}else{setAccountCollapsed(false);cloudSyncState='idle';}renderProjects();}
  async function checkAccount(){try{const d=await api('/api/auth/me');accountUser=d.user||null;}catch{accountUser=null;}showAccount();if(accountUser)await refreshCloudProjects();}
  async function login(){try{const d=await api('/api/auth/login',{method:'POST',body:JSON.stringify({email:$('loginEmail').value,password:$('loginPassword').value})});accountUser=d.user;$('loginPassword').value='';$('authMessage').textContent='Logged in. Syncing projects…';showAccount();await refreshCloudProjects();$('authMessage').textContent='Cloud sync ready.';}catch(e){$('authMessage').textContent=e.message;}}
  async function register(){try{const d=await api('/api/auth/register',{method:'POST',body:JSON.stringify({displayName:$('registerName').value,email:$('registerEmail').value,password:$('registerPassword').value,inviteCode:$('inviteCode').value})});accountUser=d.user;$('registerPassword').value=$('inviteCode').value='';$('authMessage').textContent='Account created. Your projects can now sync.';showAccount();await refreshCloudProjects();}catch(e){$('authMessage').textContent=e.message;}}
  async function logout(){try{await api('/api/auth/logout',{method:'POST',body:'{}'});}catch{}accountUser=null;cloudProjects=null;cloudSyncState='idle';showAccount();setAccountCollapsed(false);$('authMessage').textContent='Logged out. Local backup is still available.';}
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
    const res=+part.resolution||16,bi=bar%Math.max(1,+part.bars||1),start=bi*res;
    const ev=(part.events||[]).filter(e=>e.step>=start&&e.step<start+res);
    if(!ev.length)return null;
    const nn=n=>['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'][((n%12)+12)%12]+(Math.floor(n/12)-1);
    const notes=[...new Set(ev.map(e=>nn(e.midi+(part.octave||0)*12)))].sort((a,b)=>{const m=x=>{const z=x.match(/^([A-G])(#?)(-?\d+)$/),pc={C:0,D:2,E:4,F:5,G:7,A:9,B:11}[z[1]]+(z[2]?1:0);return (+z[3]+1)*12+pc};return m(b)-m(a)});
    const sets=Object.fromEntries(notes.map(n=>[n,new Set()]));ev.forEach(e=>sets[nn(e.midi+(part.octave||0)*12)].add(e.step-start));
    const spb=res/4,sub16=['1','e','&','a'];const cols=Array.from({length:res},(_,i)=>{const pos=i%spb,beat=Math.floor(i/spb)+1;if(pos===0)return String(beat);if(spb===2)return '&';if(spb===4)return sub16[pos];return pos===spb/2?'&':String(pos+1);});
    return exportGrid(`${part.name} — Bar ${bi+1}`,notes,cols,(r,i)=>sets[r].has(i));
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
      cell.innerHTML=`<div class="export-card-name">${card.type==='note'?'♪ ':''}${esc(shown)}</div><div class="export-card-subtitle">${esc(sub||' ')}</div>${canDiagram?`<div class="diagram">${state.instrument==='piano'?pianoSvg(card):guitarSvg(card)}</div>`:''}`;
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
      chordParts.forEach(p=>{const c=chordBlockForLine(p,li);if(c)line.appendChild(c)});
      sheet.appendChild(line);
    }
    if(selection.notes){const notes=$('notesEditor').innerHTML.trim();if(notes&&$('notesEditor').textContent.trim()){const n=document.createElement('section');n.className='export-notes';n.innerHTML=`<h3>Project notes</h3><div class="export-notes-body">${notes}</div>`;sheet.appendChild(n)}}
    const footer=document.createElement('footer');footer.className='export-sheet-footer';footer.innerHTML=`<img src="assets/rider-and-bones-left-still.png" alt="Rider and Bones"><span>Created with Chord Rider Pro</span>`;sheet.appendChild(footer);stage.appendChild(sheet);return sheet;
  }
  async function waitForExportImages(root){
    const imgs=[...root.querySelectorAll('img')];
    await Promise.all(imgs.map(img=>img.complete?Promise.resolve():new Promise(resolve=>{img.onload=img.onerror=resolve;})));
  }
  async function captureExportSheet(forPdf=false,selection={}){
    if(typeof html2canvas!=='function')throw new Error('Export tools did not load. Check your connection and try again.');
    const sheet=buildExportSheet(selection);sheet.classList.toggle('pdf-print',forPdf);await waitForExportImages(sheet);
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    const bounds=sheet.getBoundingClientRect();
    const breaks=[...sheet.querySelectorAll('.export-sheet-header,.export-line,.export-notes,.export-sheet-footer')]
      .map(el=>Math.round(el.getBoundingClientRect().bottom-bounds.top));
    const canvas=await html2canvas(sheet,{backgroundColor:forPdf?'#ffffff':'#f7f5ef',scale:2,useCORS:true,logging:false});
    return{sheet,canvas,breaks};
  }
  function downloadDataUrl(dataUrl,name){const a=document.createElement('a');a.href=dataUrl;a.download=name;document.body.appendChild(a);a.click();a.remove();}
  async function exportPng(){
    closeExportMenu();$('status').textContent='Creating PNG chord sheet…';
    try{const {canvas}=await captureExportSheet(false,{drums:true,notes:false});downloadDataUrl(canvas.toDataURL('image/png'),exportFileName('png'));$('status').textContent='PNG chord sheet exported.';}
    catch(e){$('status').textContent=e.message||'Could not export PNG.';}
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
      if(!window.jspdf?.jsPDF)throw new Error('PDF tools did not load. Check your connection and try again.');
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
    $('buildBtn').onclick=()=>{const bad=commitBuildInput();$('status').textContent=bad.length?`Skipped unrecognized: ${bad.join(', ')}`:'';syncBuildInput();autoPopulateKeyFromEntry();renderAll();scheduleAutoSave();};
    $('chordInput').oninput=()=>autoPopulateKeyFromEntry();
    $('chordInput').onkeydown=e=>{if(e.key==='Enter')$('buildBtn').click();};
    $('keyInput').oninput=()=>{const key=$('keyInput');key.dataset.autoKey='0';const raw=key.value.trim();scheduleAutoSave();if(!raw){key.dataset.autoKey='1';autoPopulateKeyFromEntry();return;}if(!enteredKey()){$('keyHint').textContent='Enter a key like F, F#m, Bb, or C minor';return;}renderFits();};
    $('keyInput').onkeydown=e=>{if(e.key==='Enter'){$('buildBtn').click();}};
    document.querySelectorAll('#instrumentTabs .seg').forEach(b=>b.onclick=()=>{state.instrument=b.dataset.instrument;localStorage.setItem('crp-last-instrument',state.instrument);state.sound=SOUNDS[state.instrument][0][0];state.player=null;renderAll();window.CRPParts?.syncCoreLive?.();scheduleAutoSave();});
    document.querySelectorAll('#modeTabs .seg').forEach(b=>b.onclick=()=>{state.mode=b.dataset.mode;localStorage.setItem('crp-last-mode',state.mode);renderAll();syncBuildInput();scheduleAutoSave();});
    $('soundSelect').onchange=e=>{state.sound=e.target.value;state.player=null;window.CRPParts?.syncCoreLive?.();scheduleAutoSave();};$('octaveDown').onclick=()=>{state.octave=Math.max(-2,state.octave-1);if(state.currentProjectId)writeSharedSrpMeta(state.currentProjectId,{pitchMode:'step'});publishLiveSrpMeta('crp');writeHardSync('crp','step');renderAll();scheduleAutoSave();publishSrpHandoff();};$('octaveUp').onclick=()=>{state.octave=Math.min(3,state.octave+1);if(state.currentProjectId)writeSharedSrpMeta(state.currentProjectId,{pitchMode:'step'});publishLiveSrpMeta('crp');writeHardSync('crp','step');renderAll();scheduleAutoSave();publishSrpHandoff();};
    $('sustainBtn').onclick=()=>{state.sustain=!state.sustain;localStorage.setItem('crp-sustain',state.sustain?'1':'0');updateSustainButton();};
    updateSustainButton();
    $('capoSelect').onchange=e=>{state.capo=+e.target.value;if(state.currentProjectId)writeSharedSrpMeta(state.currentProjectId,{pitchMode:'capo'});publishLiveSrpMeta('crp');writeHardSync('crp','capo');renderAll();scheduleAutoSave();publishSrpHandoff();};$('neckSelect').onchange=e=>{state.neck=e.target.value;renderAll();scheduleAutoSave();};$('transposeBtn').onclick=()=>{state.transpose=!state.transpose;publishLiveSrpMeta('crp');renderAll();scheduleAutoSave();publishSrpHandoff();};
    $('addLineBtn').onclick=()=>{state.rows.push([]);state.selectedRow=state.rows.length-1;renderRows();syncBuildInput();scheduleAutoSave();};
    $('autoScrollBtn').onclick=()=>{state.autoScroll=!state.autoScroll;localStorage.setItem('crp-auto-scroll',state.autoScroll?'1':'0');updateAutoScrollButton();};
    updateAutoScrollButton();
    let lastMobileCarousel=isMobileCarousel(),resizeTimer=null;
    window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{const mobile=isMobileCarousel();if(mobile!==lastMobileCarousel){lastMobileCarousel=mobile;renderRows();}},120);},{passive:true});
    $('playAllBtn').onclick=playProgression;
    $('newProjectBtn').onclick=newProject;
    $('saveProjectBtn').onclick=saveProject;
    $('exportBtn').onclick=e=>{e.stopPropagation();toggleExportMenu();};$('exportPdfBtn').onclick=openPdfExport;$('exportPngBtn').onclick=exportPng;$('exportStudioBtn').onclick=()=>{closeExportMenu();window.CRPParts?.openStudioExport?.();};
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
    // Full-project autosave: only active after the project has been manually saved once.
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
    $('bpmInput')?.addEventListener('change',commitCrpBpm);
    $('bpmInput')?.addEventListener('blur',commitCrpBpm);
    $('bpmInput')?.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();commitCrpBpm();e.currentTarget.blur();}});
    $('notesEditor')?.addEventListener('input',scheduleAutoSave);

    $('projectsTabBtn').onclick=()=>setProjectBrowserMode('projects');
    $('archiveTabBtn').onclick=()=>setProjectBrowserMode('archive');
    $('loginBtn').onclick=login;$('registerBtn').onclick=register;$('logoutBtn').onclick=logout;$('changePasswordBtn').onclick=changePassword;
    $('accountSummaryBtn').onclick=()=>{const panel=$('accountPanel');setAccountCollapsed(!panel.classList.contains('is-collapsed'));};
    document.querySelectorAll('.notes-toolbar [data-cmd]').forEach(b=>b.onclick=()=>{document.execCommand(b.dataset.cmd,false,null);scheduleAutoSave();});$('clearNotesBtn').onclick=()=>{if(confirm('Clear notes?')){$('notesEditor').innerHTML='';scheduleAutoSave();}};
    $('keyInput').dataset.autoKey=$('keyInput').value.trim()?'0':'1';
    renderProjects();renderAll();syncBuildInput();autoPopulateKeyFromEntry();setRiderBonesRiding(false);initWorkspaceMode();
    // Restore the exact project the user was working on before switching to SRP/Baby DAW.
    restoreActiveProjectFromStorage();
    // parts.js loads after app.js because it depends on CRPCore. The first restore above can
    // therefore restore the core project before CRPParts exists. Restore once more after the
    // parts module announces it is ready; otherwise it starts with only Chords 1 and a trip to
    // SRP can snapshot that one-part placeholder over the real Baby DAW arrangement.
    window.addEventListener('crp-parts-ready',()=>{
      // parts.js starts after the core project was restored. Force-load the SAME saved
      // project now that CRPParts exists; restoreActiveProjectFromStorage() intentionally
      // short-circuits when currentProjectId is already set, which was leaving Baby DAW
      // at its one-part placeholder on every return from SRP.
      const id=state.currentProjectId||String(localStorage.getItem('crp-active-project-id')||'');
      if(id) loadProject(id);
    },{once:true});
    setTimeout(applyLinkedMetaFromSrpHandoff,0);
    // The hidden SRP playback bridge is read-only. Never let it fetch cloud projects: a stale
    // cloud payload can overwrite the richer Baby DAW snapshot that was just saved before SRP navigation.
    if(!IS_PLAYBACK_BRIDGE) checkAccount();
    if('serviceWorker'in navigator)navigator.serviceWorker.register('service-worker.js').catch(()=>{});
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
  // v3.1.0 TRANSPORT REBUILD: CRP, Baby DAW and SRP now share ONE global transport record.
  // Project/link metadata is still used for chords, lyrics and project pairing, but it is no longer
  // allowed to gate or choose BPM / CAPO / STEP. That project-id gate was the source of the drift.
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
      // Suite transport wins for BPM/CAPO/STEP. Legacy metadata may still contribute key/transpose.
      return suite?{...(legacy||{}),...suite,crpProjectId:id}:legacy;
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
      const id=activeSrpLinkId();
      return readSuiteTransport()||readCanonicalSrp(id)||JSON.parse(localStorage.getItem(SRP_HARD_SYNC_KEY)||'null');
    }catch{return null}
  }
  function writeHardSync(source='crp',modeOverride){
    if(IS_PLAYBACK_BRIDGE)return null;
    try{
      const session=readSrpLinkSession();
      const id=String(state.currentProjectId||session?.crpProjectId||localStorage.getItem('crp-active-project-id')||'');
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
    if(IS_PLAYBACK_BRIDGE)return false;
    try{
      const m=readHardSync();
      if(!m)return false;
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
      if(state.currentProjectId){
        const projects=localProjects();
        const i=projects.findIndex(x=>String(x?.id||'')===String(state.currentProjectId));
        if(i>=0){
          projects[i]={...projects[i],bpm,capo,octave,updatedAt:Date.now()};
          saveLocalProjects(projects);updateCloudSnapshot(projects[i]);
        }
      }
      return true;
    }catch{return false}
  }
  // v2.9.5: emergency project snapshot used across workspace navigation.
  // It is written synchronously before leaving CRP/Baby DAW so newly-added parts
  // cannot be lost to an older project payload during the SRP handoff.
  const CRP_NAV_SNAPSHOT_PREFIX='crp-nav-snapshot-v1:';
  function writeNavigationSnapshot(){
    // Never let the hidden SRP playback iframe write a navigation snapshot. Its pagehide
    // used to be able to replace the real Baby DAW snapshot when SRP was closed.
    if(IS_PLAYBACK_BRIDGE)return null;
    if(!state.currentProjectId)return null;
    try{
      window.CRPParts?.syncActiveChord?.();
      const existing=localProjects().find(x=>String(x?.id||'')===String(state.currentProjectId));
      const nm=$('projectName').value.trim()||existing?.name||`Chord Project ${new Date().toLocaleDateString()}`;
      const snap=capture(state.currentProjectId,nm);
      upsertLocal(snap);
      localStorage.setItem(CRP_NAV_SNAPSHOT_PREFIX+String(state.currentProjectId),JSON.stringify(snap));
      localStorage.setItem('crp-active-project-id',String(state.currentProjectId));
      return snap;
    }catch(err){console.warn('Could not write navigation snapshot',err);return null;}
  }
  function recoverNavigationSnapshot(project){
    if(!project?.id)return project;
    try{
      const raw=localStorage.getItem(CRP_NAV_SNAPSHOT_PREFIX+String(project.id));
      if(!raw)return project;
      const snap=JSON.parse(raw);
      if(!snap||String(snap.id||'')!==String(project.id))return project;
      const projectParts=project.parts?.items?.length||0,snapParts=snap.parts?.items?.length||0;
      // Prefer the navigation snapshot when it contains newer/more complete Baby DAW data.
      if(snapParts>projectParts || Number(snap.updatedAt||0)>=Number(project.updatedAt||0))return {...project,...snap};
    }catch(err){console.warn('Could not recover navigation snapshot',err);}
    return project;
  }

  function openSongRiderWorkspace(){
    try{
      // Persist the exact active project snapshot before leaving CRP.
      // This prevents SRP from seeing stale data and lets CRP restore the same project on return.
      writeNavigationSnapshot();
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
    const toolbar=document.querySelector('.primary-toolbar');
    if(!toolbar)return;
    const mode=currentSetupWorkspace();
    const hidden=setupHiddenFor(mode);
    toolbar.classList.toggle('crp-controls-hidden',hidden);

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
    return {crpProjectId:p.id,name:live.name||p.name||'Untitled',bpm:+live.bpm||92,beats:+live.beats||4,key:live.key||'',capo:Number(live.capo)||0,octave:Number(live.octave)||0,transpose:!!live.transpose,pitchMode:linkedPitchMode(p.id),rows:(live.rows||[]).map((row,rowIndex)=>({lineId:`crp-line-${rowIndex+1}`,cards:(row||[]).map(c=>({type:c.type||'chord',value:c.value||''}))}))};
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

      // Update every CRP representation, not only localStorage. This is essential when signed in,
      // because projectSource() may be the in-memory cloudProjects array.
      const projects=localProjects();
      const i=projects.findIndex(x=>String(x?.id||'')===activeId);
      let merged=null;
      if(i>=0){
        merged={...projects[i],bpm,capo,octave,transpose,key:key||projects[i].key||'',updatedAt:Date.now()};
        projects[i]=merged;saveLocalProjects(projects);
      }
      if(merged)updateCloudSnapshot(merged);

      renderAll();syncBuildInput();window.CRPParts?.syncCoreLive?.();
      const changed=before.bpm!==bpm||before.capo!==capo||before.octave!==octave||before.transpose!==transpose||String(before.key)!==key;
      if(changed && state.currentProjectId===activeId && !IS_PLAYBACK_BRIDGE){
        // Persist the SRP-originated values through the normal CRP autosave/cloud path.
        clearTimeout(autoSaveTimer);
        autoSaveTimer=setTimeout(()=>runAutoSave(),120);
      }
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
  if(!IS_PLAYBACK_BRIDGE)window.addEventListener('pagehide',()=>{try{flushAutoSaveNow();writeNavigationSnapshot();window.CRPBeatMaker?.persist?.();}catch{}});
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
    state.instrument=snapshot.instrument==='guitar'?'guitar':'piano';
    state.mode=snapshot.mode==='note'?'note':'chord';
    state.sound=snapshot.sound||SOUNDS[state.instrument][0][0];
    state.octave=Number(snapshot.octave)||0;state.capo=Number(snapshot.capo)||0;
    state.neck=['open','triad','barre','power','shell','inversion','color'].includes(snapshot.neck)?snapshot.neck:'open';
    state.transpose=!!snapshot.transpose;state.rows=JSON.parse(JSON.stringify(snapshot.rows||[[]]));if(!state.rows.length)state.rows=[[]];state.selectedRow=0;
    $('capoSelect').value=String(state.capo);$('neckSelect').value=state.neck;$('keyInput').value=snapshot.key||'';$('keyInput').dataset.autoKey=snapshot.key?'0':'1';
    state.player=null;state.playerName='';renderAll();syncBuildInput();autoPopulateKeyFromEntry();
  }
  function coreNotesFor(card,snapshot){
    const saved=coreSnapshot();
    try{
      if(snapshot){state.instrument=snapshot.instrument||'piano';state.mode=snapshot.mode||'chord';state.sound=snapshot.sound||SOUNDS[state.instrument][0][0];state.octave=Number(snapshot.octave)||0;state.capo=Number(snapshot.capo)||0;state.neck=snapshot.neck||'open';state.transpose=!!snapshot.transpose;}
      const val=displayedValue(card);let notes;
      if(card.type==='note'){const oct=(state.instrument==='piano'?4:3)+state.octave;notes=[val+oct];}
      else if(state.instrument==='guitar'){
        const frets=guitarShapeForCard(card),opens=[40,45,50,55,59,64];
        notes=frets.map((f,i)=>f==null?null:noteAtMidi(opens[i]+f+state.capo+state.octave*12)).filter(Boolean);
        if(!notes.length)notes=chordNotes(val,3+state.octave);
      }else notes=pianoMidisForCard(card).map(noteAtMidi);
      if(state.sound==='electric_bass_finger')notes=notes.slice(0,card.type==='note'?1:3).map(n=>noteAtMidi(midiOf(n)-12));
      return notes;
    } finally {
      state.instrument=saved.instrument;state.mode=saved.mode;state.sound=saved.sound;state.octave=saved.octave;state.capo=saved.capo;state.neck=saved.neck;state.transpose=saved.transpose;state.rows=saved.rows;
    }
  }
  window.CRPCore={
    snapshot:coreSnapshot,apply:coreApply,notesFor:coreNotesFor,sounds:SOUNDS,
    scheduleAutoSave,flushAutoSaveNow,renderAll,syncBuildInput,publishSrpHandoff,loadProjectById:loadProject,
    get beats(){return +$('beatsSelect').value||4},get bpm(){return +$('bpmInput').value||92},get loop(){return $('loopToggle').checked},
    get currentProjectId(){return state.currentProjectId||null},get loggedIn(){return !!accountUser},get projectName(){return $('projectName').value.trim()||'Untitled Project'},get projectNotes(){return $('notesEditor').innerHTML},
    startBeat(){const ri=playbackStartRow();return state.rows.slice(0,ri).reduce((n,r)=>n+r.length,0)*(+$('beatsSelect').value||4);},
    get autoScroll(){return !!state.autoScroll;},
    followChordCard(cardIndex){
      if(!state.autoScroll)return;
      const cards=[...document.querySelectorAll('.progression-line:not(.carousel-clone) .chord-card')];
      const card=cards[Number(cardIndex)||0];
      if(!card)return;
      const line=card.closest('.progression-line:not(.carousel-clone)');
      const ri=Number(line?.dataset.row);
      if(Number.isFinite(ri)){
        state.selectedRow=ri;
        updateMobileLineIndicator(ri);
        realCarouselLines().forEach(el=>el.classList.toggle('selected',+el.dataset.row===ri));
      }
      if(isMobileCarousel()&&Number.isFinite(ri)){
        scrollMobileLineTo(ri,true);
        setTimeout(()=>{if(state.autoScroll)card.scrollIntoView({behavior:'smooth',block:'center',inline:'nearest'});},180);
      }else{
        card.scrollIntoView({behavior:'smooth',block:'center',inline:'nearest'});
      }
    },
    setPlaying(on){state.playing=!!on;setRiderBonesRiding(!!on);$('playAllBtn').textContent=on?'■ Stop':'▶ Play';if(!on)document.querySelectorAll('.chord-card').forEach(c=>c.style.outline='');},
    status(msg){$('status').textContent=msg||'';},
    setBabyDawSetupHidden(hidden){setWorkspaceSetupHidden('baby-daw',!!hidden);},
    refreshSetupVisibility(){applySetupVisibility();},
    get workspaceMode(){return currentSetupWorkspace();},
    noteAtMidi
  };

  init();
})();

