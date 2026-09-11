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
    rows:[[]], selectedRow:0, playing:false, timer:null,
    audioCtx:null, player:null, playerName:'', currentProjectId:null, drag:null
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

  const allCards=()=>state.rows.flat();
  function firstChord(){return allCards().find(c=>c.type==='chord')?.value||null;}
  function inferredKey(){const c=firstChord();if(c){const p=parseChord(c);return{root:p.root,minor:p.quality.startsWith('m')&&!p.quality.startsWith('maj')}}const n=allCards().find(c=>c.type==='note')?.value||'C';return{root:n,minor:false};}
  function selectedRow(){while(state.rows.length<=state.selectedRow)state.rows.push([]);return state.rows[state.selectedRow];}

  function fitItems(){
    const k=inferredKey(),r=NOTE_INDEX[k.root],ints=k.minor?[0,2,3,5,7,8,10]:[0,2,4,5,7,9,11];
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

  function ensureAudio(){
    if(!state.audioCtx)state.audioCtx=new (window.AudioContext||window.webkitAudioContext)();
    if(state.audioCtx.state==='suspended')state.audioCtx.resume();
    if(state.player&&state.playerName===state.sound)return Promise.resolve(state.player);
    if(!window.Soundfont)return Promise.reject(new Error('Sound engine unavailable'));
    $('status').textContent='Loading instrument samples…';
    return Soundfont.instrument(state.audioCtx,state.sound,{format:'mp3',soundfont:'MusyngKite'}).then(p=>{state.player=p;state.playerName=state.sound;$('status').textContent='';return p;});
  }
  async function playCard(card,seconds=1.5){
    const p=await ensureAudio(),val=displayedValue(card);let notes;
    if(card.type==='note'){const oct=(state.instrument==='piano'?4:3)+state.octave;notes=[val+oct];}
    else if(state.instrument==='guitar'){
      // Play the actual selected guitar voicing so what you hear matches the diagram.
      const frets=guitarShapeForCard(card),opens=[40,45,50,55,59,64];
      notes=frets.map((f,i)=>f==null?null:noteAtMidi(opens[i]+f+state.capo+state.octave*12)).filter(Boolean);
      if(!notes.length)notes=chordNotes(val,3+state.octave);
    }else notes=chordNotes(val,4+state.octave);
    if(state.sound==='electric_bass_finger')notes=notes.slice(0,card.type==='note'?1:3).map(n=>noteAtMidi(midiOf(n)-12));
    const now=state.audioCtx.currentTime;notes.forEach((n,i)=>p.play(n,now+(state.instrument==='guitar'?i*.035:0),{duration:seconds,gain:.72}));
  }
  function setRiderBonesRiding(on){['riderBonesLeft','riderBonesRight'].forEach(id=>{const img=$(id);if(img)img.src=on?img.dataset.animated:img.dataset.still;});}

  function pianoSvg(card){
    const val=displayedValue(card),base=4+state.octave,ns=card.type==='note'?[val+base]:chordNotes(val,base),mids=ns.map(midiOf).filter(x=>x!=null),targets=new Set(mids);
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
  function barreShape(name){
    const c=parseChord(name);if(!c)return[null,null,null,null,null,null];
    const f=(NOTE_INDEX[c.root]-NOTE_INDEX.E+12)%12,q=c.quality;
    if(q==='m'||q==='m7'||q==='m9'||q==='m6'||q==='madd9')return q==='m7'?[f,f+2,f,f,f,f]:[f,f+2,f+2,f,f,f];
    if(q==='7'||q==='9')return[f,f+2,f,f+1,f,f];
    if(q==='maj7'||q==='maj9')return[f,f+2,f+1,f+1,f,f];
    if(q==='sus4')return[f,f+2,f+2,f+2,f,f];
    return[f,f+2,f+2,f+1,f,f];
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

  function moveDragged(toRow,toIndex){
    if(!state.drag)return;const {row:fr,index:fi}=state.drag,card=state.rows[fr][fi];if(!card)return;
    state.rows[fr].splice(fi,1);if(fr===toRow&&fi<toIndex)toIndex--;state.rows[toRow].splice(Math.max(0,toIndex),0,card);state.selectedRow=toRow;state.drag=null;$('status').textContent='';renderRows();
  }
  function renderRows(){
    const wrap=$('progression');wrap.innerHTML='';
    state.rows.forEach((row,ri)=>{
      const line=document.createElement('div');line.className='progression-line'+(ri===state.selectedRow?' selected':'');line.dataset.row=ri;line.innerHTML=`<span class="line-badge">Line ${ri+1}</span>`;
      line.onclick=e=>{if(!e.target.closest('.chord-card')){state.selectedRow=ri;renderRows();}};
      line.addEventListener('dragover',e=>{e.preventDefault();line.classList.add('drop-target');});
      line.addEventListener('dragleave',()=>line.classList.remove('drop-target'));
      line.addEventListener('drop',e=>{e.preventDefault();line.classList.remove('drop-target');moveDragged(ri,row.length);});
      if(!row.length){const empty=document.createElement('div');empty.className='empty-line';empty.textContent='Empty line — tap to select or drop a card here';line.appendChild(empty);}
      row.forEach((card,ci)=>{
        const el=document.createElement('div');el.className='chord-card'+(card.type==='note'?' note-card':'');el.draggable=true;
        const shown=displayedValue(card),sub=subtitle(card);
        el.innerHTML=`<div class="card-top"><span class="chord-name">${shown}</span><button class="remove">×</button></div>${sub?`<div class="card-subtitle">${sub}</div>`:''}<div class="diagram">${state.instrument==='piano'?pianoSvg(card):guitarSvg(card)}</div><div class="hint">Tap to play • hold & drag to move</div>`;
        el.querySelector('.remove').onclick=e=>{e.stopPropagation();row.splice(ci,1);renderRows();};
        el.onclick=e=>{e.stopPropagation();state.selectedRow=ri;if(!e.target.closest('.remove'))playCard(card);};
        el.addEventListener('dragstart',e=>{state.drag={row:ri,index:ci};e.dataTransfer.effectAllowed='move';el.classList.add('dragging');});
        el.addEventListener('dragend',()=>{el.classList.remove('dragging');state.drag=null;});
        el.addEventListener('dragover',e=>e.preventDefault());
        el.addEventListener('drop',e=>{e.preventDefault();e.stopPropagation();moveDragged(ri,ci);});
        let t=null;el.addEventListener('pointerdown',e=>{if(e.target.closest('button'))return;t=setTimeout(()=>{state.drag={row:ri,index:ci};el.classList.add('dragging');$('status').textContent='Card selected to move. Tap another card or line.';navigator.vibrate?.(20);},450);});
        ['pointerup','pointercancel','pointerleave'].forEach(ev=>el.addEventListener(ev,()=>clearTimeout(t)));
        el.addEventListener('pointerup',e=>{if(state.drag&&(state.drag.row!==ri||state.drag.index!==ci)&&!e.target.closest('button'))moveDragged(ri,ci);});
        line.appendChild(el);
      });
      line.addEventListener('pointerup',e=>{if(state.drag&&!e.target.closest('.chord-card'))moveDragged(ri,row.length);});
      wrap.appendChild(line);
    });
  }

  function renderFits(){
    $('fitHeading').textContent=state.mode==='chord'?'Chords that fit':'Notes that fit';const k=inferredKey();$('keyHint').textContent=`Based on ${k.root}: ${k.root} ${k.minor?'minor':'major'} family`;
    const w=$('compatibleChords');w.innerHTML='';fitItems().forEach(v=>{const b=document.createElement('button');b.className='chip';b.textContent=v;b.onclick=()=>{selectedRow().push({type:state.mode,value:v});renderAll();};w.appendChild(b);});
  }
  function renderSound(){const s=$('soundSelect');s.innerHTML='';SOUNDS[state.instrument].forEach(([v,l])=>{const o=document.createElement('option');o.value=v;o.textContent=l;s.appendChild(o);});if(!SOUNDS[state.instrument].some(x=>x[0]===state.sound))state.sound=SOUNDS[state.instrument][0][0];s.value=state.sound;}
  function renderAll(){
    renderSound();document.querySelectorAll('#instrumentTabs .seg').forEach(b=>b.classList.toggle('active',b.dataset.instrument===state.instrument));document.querySelectorAll('#modeTabs .seg').forEach(b=>b.classList.toggle('active',b.dataset.mode===state.mode));
    $('octaveValue').textContent=state.octave>0?'+'+state.octave:state.octave;$('capoWrap').style.display=$('transposeWrap').style.display=state.instrument==='guitar'?'':'none';$('neckWrap').style.display=state.instrument==='guitar'&&state.mode==='chord'?'':'none';$('neckSelect').value=state.neck;
    $('transposeBtn').textContent=state.transpose?'Transpose ON':'Transpose OFF';$('transposeBtn').classList.toggle('on',state.transpose);$('transposeBtn').setAttribute('aria-pressed',String(state.transpose));
    $('chordInput').placeholder=state.mode==='chord'?'Enter chords, e.g. Em A7 Cmaj7 B7':'Enter notes, e.g. E F# A B';renderFits();renderRows();
  }

  async function playProgression(){
    if(state.playing)return stopProgression();if(!allCards().length){$('status').textContent='Add at least one chord or note first.';return;}
    state.playing=true;setRiderBonesRiding(true);$('playAllBtn').textContent='■ Stop';await ensureAudio();
    let idx=0;
    let nextStepAt=performance.now();
    const step=async()=>{
      if(!state.playing)return;
      const list=state.rows.flatMap((r,ri)=>r.map((c,ci)=>({c,ri,ci})));
      if(!list.length)return stopProgression();
      if(idx>=list.length){if($('loopToggle').checked)idx=0;else return stopProgression();}
      const bpm=Math.max(40,Math.min(240,+$('bpmInput').value||92)),beats=+$('beatsSelect').value||4,ms=60000/bpm*beats,item=list[idx++];
      await playCard(item.c,Math.max(.4,ms/1000*1.03));
      document.querySelectorAll('.chord-card').forEach(c=>c.style.outline='');
      document.querySelector(`.progression-line[data-row="${item.ri}"]`)?.querySelectorAll('.chord-card')[item.ci]?.style.setProperty('outline','2px solid var(--accent)');
      nextStepAt += ms;
      state.timer=setTimeout(step,Math.max(0,nextStepAt-performance.now()));
    };
    step();
  }
  function stopProgression(){state.playing=false;clearTimeout(state.timer);state.timer=null;setRiderBonesRiding(false);$('playAllBtn').textContent='▶ Play';document.querySelectorAll('.chord-card').forEach(c=>c.style.outline='');}

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
  function capture(id,name){return{id:id||(crypto.randomUUID?crypto.randomUUID():String(Date.now())),name,updatedAt:Date.now(),instrument:state.instrument,mode:state.mode,sound:state.sound,octave:state.octave,capo:state.capo,neck:state.neck,transpose:state.transpose,rows:state.rows,bpm:+$('bpmInput').value||92,beats:+$('beatsSelect').value||4,loop:$('loopToggle').checked,notes:$('notesEditor').innerHTML};}
  function upsertLocal(p){const ps=localProjects(),i=ps.findIndex(x=>x.id===p.id);if(i>=0)ps[i]=p;else ps.unshift(p);saveLocalProjects(ps);}
  async function refreshCloudProjects(){if(!accountUser){cloudProjects=null;cloudSyncState='idle';renderProjects();return;}cloudSyncState='syncing';updateAccountSummary();try{const d=await api('/api/projects');cloudProjects=d.projects||[];cloudProjects.forEach(upsertLocal);cloudSyncState='ready';updateAccountSummary();renderProjects();}catch(e){cloudSyncState='error';updateAccountSummary();$('status').textContent='Cloud sync unavailable — using local backup.';renderProjects();}}
  async function saveProject(){const name=$('projectName').value.trim()||`Chord Project ${new Date().toLocaleDateString()}`,p=capture(state.currentProjectId,name);state.currentProjectId=p.id;$('projectName').value=name;upsertLocal(p);if(accountUser){try{const d=await api('/api/projects',{method:'POST',body:JSON.stringify({project:p})});upsertLocal(d.project);await refreshCloudProjects();$('status').textContent=`Saved “${name}” to cloud.`;}catch(e){$('status').textContent=`Saved locally; cloud sync failed: ${e.message}`;}}else{$('status').textContent=`Saved “${name}” on this device.`;renderProjects();}}
  function projectSource(){return (accountUser&&cloudProjects)?cloudProjects:localProjects();}
  function loadProject(id){const p=projectSource().find(x=>x.id===id)||localProjects().find(x=>x.id===id);if(!p)return;state.currentProjectId=id;state.instrument=p.instrument||'piano';state.mode=p.mode||'chord';state.sound=p.sound||SOUNDS[state.instrument][0][0];state.octave=p.octave||0;state.capo=p.capo||0;state.neck=['open','triad','barre','power','shell','inversion','color'].includes(p.neck)?p.neck:'open';state.transpose=!!p.transpose;state.rows=p.rows||[(p.chords||[]).map(v=>({type:'chord',value:v}))];if(!state.rows.length)state.rows=[[]];state.selectedRow=0;$('projectName').value=p.name;$('bpmInput').value=p.bpm||92;$('beatsSelect').value=p.beats||4;$('loopToggle').checked=p.loop!==false;$('notesEditor').innerHTML=p.notes||'';$('capoSelect').value=state.capo;$('neckSelect').value=state.neck;renderAll();}
  function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));}
  function renderProjects(){const w=$('projectList'),ps=[...projectSource()].sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0));$('projectStorageLabel').textContent=accountUser?'Synced to your cloud account':'Saved on this device';w.innerHTML=ps.length?'':'<div class="subtle">No saved projects yet.</div>';ps.forEach(p=>{const e=document.createElement('div');e.className='project-item';const count=p.rows?p.rows.flat().length:(p.chords||[]).length;e.innerHTML=`<div class="name">${esc(p.name)}</div><div class="meta">${count} cards</div><button class="open">Open</button><button class="rename">Rename</button><button class="delete">Delete</button>`;e.querySelector('.open').onclick=()=>loadProject(p.id);e.querySelector('.rename').onclick=async()=>{const n=prompt('New project name:',p.name);if(!n?.trim())return;const name=n.trim();const locals=localProjects(),i=locals.findIndex(x=>x.id===p.id);if(i>=0){locals[i].name=name;locals[i].updatedAt=Date.now();saveLocalProjects(locals);}if(accountUser){try{await api('/api/projects/'+encodeURIComponent(p.id),{method:'PATCH',body:JSON.stringify({name})});await refreshCloudProjects();}catch(err){$('status').textContent='Rename saved locally; cloud sync failed.';renderProjects();}}else renderProjects();};e.querySelector('.delete').onclick=async()=>{if(!confirm(`Delete “${p.name}”?`))return;saveLocalProjects(localProjects().filter(x=>x.id!==p.id));if(accountUser){try{await api('/api/projects/'+encodeURIComponent(p.id),{method:'DELETE'});await refreshCloudProjects();}catch(err){$('status').textContent='Deleted locally; cloud delete failed.';renderProjects();}}else renderProjects();};w.appendChild(e);});}
  function showAccount(){const logged=!!accountUser;const panel=$('accountPanel');panel?.classList.toggle('is-logged-in',logged);$('accountSummaryBtn').hidden=!logged;$('authForms').hidden=logged;$('accountTools').hidden=!logged;$('logoutBtn').hidden=!logged;$('accountStatus').textContent=logged?`Signed in as ${accountDisplayName()}`:'Not signed in — local projects still work.';$('projectStorageLabel').textContent=logged?'Synced to your cloud account':'Saved on this device';if(logged){updateAccountSummary();setAccountCollapsed(true);}else{setAccountCollapsed(false);cloudSyncState='idle';}renderProjects();}
  async function checkAccount(){try{const d=await api('/api/auth/me');accountUser=d.user||null;}catch{accountUser=null;}showAccount();if(accountUser)await refreshCloudProjects();}
  async function login(){try{const d=await api('/api/auth/login',{method:'POST',body:JSON.stringify({email:$('loginEmail').value,password:$('loginPassword').value})});accountUser=d.user;$('loginPassword').value='';$('authMessage').textContent='Logged in. Syncing projects…';showAccount();await refreshCloudProjects();$('authMessage').textContent='Cloud sync ready.';}catch(e){$('authMessage').textContent=e.message;}}
  async function register(){try{const d=await api('/api/auth/register',{method:'POST',body:JSON.stringify({displayName:$('registerName').value,email:$('registerEmail').value,password:$('registerPassword').value,inviteCode:$('inviteCode').value})});accountUser=d.user;$('registerPassword').value=$('inviteCode').value='';$('authMessage').textContent='Account created. Your projects can now sync.';showAccount();await refreshCloudProjects();}catch(e){$('authMessage').textContent=e.message;}}
  async function logout(){try{await api('/api/auth/logout',{method:'POST',body:'{}'});}catch{}accountUser=null;cloudProjects=null;cloudSyncState='idle';showAccount();setAccountCollapsed(false);$('authMessage').textContent='Logged out. Local backup is still available.';}
  async function changePassword(){const currentPassword=prompt('Current password:');if(currentPassword===null)return;const newPassword=prompt('New password (8+ characters):');if(newPassword===null)return;try{await api('/api/auth/password',{method:'POST',body:JSON.stringify({currentPassword,newPassword})});$('authMessage').textContent='Password changed successfully.';}catch(e){$('authMessage').textContent=e.message;}}


  function init(){
    for(let i=0;i<=12;i++){const o=document.createElement('option');o.value=i;o.textContent=i?'Capo '+i:'None';$('capoSelect').appendChild(o);}
    $('buildBtn').onclick=()=>{const raw=tokens($('chordInput').value),vals=[],bad=[];raw.forEach(x=>{const v=state.mode==='chord'?parseChord(x)?.display:parseNote(x);v?vals.push({type:state.mode,value:v}):bad.push(x);});state.rows[state.selectedRow]=vals;$('status').textContent=bad.length?`Skipped unrecognized: ${bad.join(', ')}`:'';renderAll();};
    $('chordInput').onkeydown=e=>{if(e.key==='Enter')$('buildBtn').click();};
    document.querySelectorAll('#instrumentTabs .seg').forEach(b=>b.onclick=()=>{state.instrument=b.dataset.instrument;localStorage.setItem('crp-last-instrument',state.instrument);state.sound=SOUNDS[state.instrument][0][0];state.player=null;renderAll();});
    document.querySelectorAll('#modeTabs .seg').forEach(b=>b.onclick=()=>{state.mode=b.dataset.mode;localStorage.setItem('crp-last-mode',state.mode);$('chordInput').value='';renderAll();});
    $('soundSelect').onchange=e=>{state.sound=e.target.value;state.player=null;};$('octaveDown').onclick=()=>{state.octave=Math.max(-2,state.octave-1);renderAll();};$('octaveUp').onclick=()=>{state.octave=Math.min(3,state.octave+1);renderAll();};
    $('capoSelect').onchange=e=>{state.capo=+e.target.value;renderAll();};$('neckSelect').onchange=e=>{state.neck=e.target.value;renderAll();};$('transposeBtn').onclick=()=>{state.transpose=!state.transpose;renderAll();};
    $('addLineBtn').onclick=()=>{state.rows.push([]);state.selectedRow=state.rows.length-1;renderRows();};$('playAllBtn').onclick=playProgression;$('saveProjectBtn').onclick=saveProject;
    $('loginBtn').onclick=login;$('registerBtn').onclick=register;$('logoutBtn').onclick=logout;$('changePasswordBtn').onclick=changePassword;
    $('accountSummaryBtn').onclick=()=>{const panel=$('accountPanel');setAccountCollapsed(!panel.classList.contains('is-collapsed'));};
    document.querySelectorAll('.notes-toolbar [data-cmd]').forEach(b=>b.onclick=()=>document.execCommand(b.dataset.cmd,false,null));$('clearNotesBtn').onclick=()=>{if(confirm('Clear notes?'))$('notesEditor').innerHTML='';};
    renderProjects();renderAll();setRiderBonesRiding(false);checkAccount();if('serviceWorker'in navigator)navigator.serviceWorker.register('service-worker.js').catch(()=>{});
  }
  init();
})();