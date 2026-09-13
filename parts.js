(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const core = window.CRPCore;
  if(!core) return;

  const clone = v => JSON.parse(JSON.stringify(v));
  const uid = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const NOTE_NAMES=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  const SOUND_GAIN={acoustic_grand_piano:2.35,electric_piano_1:2.35,acoustic_guitar_steel:2.55,electric_guitar_clean:2.45,synth_strings_1:1.05,electric_bass_finger:1.05};

  let parts=[];
  let activePartId=null;
  let loadedChordPartId=null;
  let leadBarPage=0;
  let playing=false;
  let audioCtx=null, masterLimiter=null, cycleTimer=null;
  let playerCache=new Map(), partBuses=new Map(), highlightTimers=[];

  function chordPart(name='Chords 1', data=null){
    const d=data?clone(data):core.snapshot();
    if(!d.rows?.length)d.rows=[[]];
    return {id:uid(),type:'chord',name,enabled:true,volume:.85,data:d};
  }
  function leadPart(name='Lead 1'){
    return {id:uid(),type:'lead',name,enabled:true,volume:.8,instrument:'piano',sound:'acoustic_grand_piano',octave:0,gridOctave:3,resolution:16,bars:4,events:[]};
  }
  function vocalPart(name='Vocals 1'){
    return {id:uid(),type:'vocal',name,enabled:true,volume:1,recordings:[]};
  }
  function normalizePart(p,i){
    if(!p||!p.type)return null;
    const base={id:p.id||uid(),name:p.name||`${p.type==='chord'?'Chords':p.type==='lead'?'Lead':'Vocals'} ${i+1}`,enabled:p.enabled!==false,volume:Number.isFinite(+p.volume)?Math.max(0,Math.min(1,+p.volume)):.85};
    if(p.type==='chord')return {...base,type:'chord',data:clone(p.data||core.snapshot())};
    if(p.type==='lead')return {...base,type:'lead',instrument:p.instrument==='guitar'?'guitar':'piano',sound:p.sound||'acoustic_grand_piano',octave:Number(p.octave)||0,gridOctave:Number(p.gridOctave)||3,resolution:[8,16,32,64].includes(+p.resolution)?+p.resolution:16,bars:Math.max(1,Math.min(16,+p.bars||4)),events:Array.isArray(p.events)?p.events.map(e=>({step:+e.step,midi:+e.midi})).filter(e=>Number.isFinite(e.step)&&Number.isFinite(e.midi)):[]};
    return {...base,type:'vocal',recordings:Array.isArray(p.recordings)?p.recordings:[]};
  }
  function ensureInitial(){
    if(parts.length)return;
    const p=chordPart('Chords 1');parts=[p];activePartId=p.id;loadedChordPartId=p.id;
  }
  function active(){return parts.find(p=>p.id===activePartId)||parts[0]||null;}
  function loadedChord(){return parts.find(p=>p.id===loadedChordPartId&&p.type==='chord')||null;}
  function syncLoadedChord(){
    const p=loadedChord();
    if(p)p.data=core.snapshot();
  }
  function syncActiveChord(){
    const p=active();
    if(p?.type==='chord'&&p.id===loadedChordPartId)p.data=core.snapshot();
  }

  function setEditorMode(type){
    const chord=type==='chord';
    $('chordPartControls')?.classList.toggle('part-hidden',!chord);
    $('chordPartRows')?.classList.toggle('part-hidden',!chord);
    if($('leadPartEditor'))$('leadPartEditor').hidden=type!=='lead';
    if($('vocalPartEditor'))$('vocalPartEditor').hidden=type!=='vocal';
  }

  function selectPart(id){
    if(playing)stopPlayback();
    syncLoadedChord();
    const p=parts.find(x=>x.id===id);if(!p)return;
    activePartId=id;
    if(p.type==='chord'){
      core.apply(p.data);loadedChordPartId=p.id;
    }else if(p.type==='lead'){
      leadBarPage=Math.min(leadBarPage,p.bars-1);renderLeadEditor(p);
    }else renderVocalEditor(p);
    setEditorMode(p.type);
    renderParts();
  }

  function renderParts(){
    ensureInitial();
    const strip=$('partStrip');if(!strip)return;
    strip.innerHTML='';
    parts.forEach((p,index)=>{
      const wrap=document.createElement('div');wrap.className='part-pill'+(p.id===activePartId?' active':'');
      const chk=document.createElement('input');chk.type='checkbox';chk.checked=p.enabled;chk.title='Include this part in playback';chk.setAttribute('aria-label',`Play ${p.name}`);chk.onchange=e=>{p.enabled=e.target.checked;core.scheduleAutoSave();};
      const open=document.createElement('button');open.type='button';open.className='part-open';open.textContent=p.name;open.onclick=()=>selectPart(p.id);
      const vol=document.createElement('span');vol.className='part-mini-vol';vol.textContent=`${Math.round(p.volume*100)}%`;
      const rename=document.createElement('button');rename.type='button';rename.className='part-delete';rename.textContent='✎';rename.title='Rename part';rename.onclick=e=>{e.stopPropagation();const n=prompt('Part name:',p.name);if(n?.trim()){p.name=n.trim();renderParts();if(p.id===activePartId){if(p.type==='lead')renderLeadEditor(p);if(p.type==='vocal')renderVocalEditor(p);}core.scheduleAutoSave();}};
      wrap.append(chk,open,vol,rename);
      if(!(index===0&&p.type==='chord')){
        const del=document.createElement('button');del.type='button';del.className='part-delete';del.textContent='×';del.title='Delete part';del.onclick=e=>{e.stopPropagation();if(!confirm(`Delete “${p.name}”?`))return;const wasLoaded=p.id===loadedChordPartId;parts=parts.filter(x=>x.id!==p.id);if(!parts.length){const first=chordPart('Chords 1');parts=[first];loadedChordPartId=first.id;}if(wasLoaded){const c=parts.find(x=>x.type==='chord');if(c){core.apply(c.data);loadedChordPartId=c.id;}}if(activePartId===p.id)selectPart((parts.find(x=>x.type==='chord')||parts[0]).id);else renderParts();core.scheduleAutoSave();};
        wrap.append(del);
      }
      strip.appendChild(wrap);
    });
    renderActiveVolumeControl();
  }

  function renderActiveVolumeControl(){
    const mgr=$('partManager');if(!mgr)return;
    let row=$('activePartVolumeRow');
    if(!row){row=document.createElement('div');row.id='activePartVolumeRow';row.className='active-part-volume-row';mgr.appendChild(row);}
    const p=active();if(!p){row.innerHTML='';return;}
    row.innerHTML=`<span>${escapeHtml(p.name)} volume</span><input id="activePartVolume" type="range" min="0" max="100" value="${Math.round(p.volume*100)}"><strong id="activePartVolumeValue">${Math.round(p.volume*100)}%</strong>`;
    const slider=$('activePartVolume');slider.oninput=()=>{p.volume=+slider.value/100;$('activePartVolumeValue').textContent=`${slider.value}%`;const pill=[...document.querySelectorAll('.part-pill')].find(x=>x.querySelector('.part-open')?.textContent===p.name);if(pill)pill.querySelector('.part-mini-vol').textContent=`${slider.value}%`;if(p.type==='lead'&&$('leadVolume')){$('leadVolume').value=slider.value;$('leadVolumeValue').textContent=`${slider.value}%`;}if(p.type==='vocal'&&$('vocalVolume')){$('vocalVolume').value=slider.value;$('vocalVolumeValue').textContent=`${slider.value}%`;}core.scheduleAutoSave();};
  }
  function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));}

  function openModal(){if($('addPartModal'))$('addPartModal').hidden=false;}
  function closeModal(){if($('addPartModal'))$('addPartModal').hidden=true;}
  function countType(type){return parts.filter(p=>p.type===type).length;}
  function addPart(type){
    syncLoadedChord();let p;
    if(type==='chord'){
      p=chordPart(`Chords ${countType('chord')+1}`,{...core.snapshot(),rows:[[]],key:''});
    }else if(type==='lead')p=leadPart(`Lead ${countType('lead')+1}`);
    else p=vocalPart(`Vocals ${countType('vocal')+1}`);
    parts.push(p);closeModal();selectPart(p.id);core.scheduleAutoSave();
  }

  function leadSoundOptions(p){
    const select=$('leadSoundSelect');if(!select)return;
    const options=core.sounds[p.instrument]||core.sounds.piano;select.innerHTML='';
    options.forEach(([v,l])=>{const o=document.createElement('option');o.value=v;o.textContent=l;select.appendChild(o);});
    if(!options.some(x=>x[0]===p.sound))p.sound=options[0][0];select.value=p.sound;
  }
  function midiName(m){return NOTE_NAMES[(m%12+12)%12]+(Math.floor(m/12)-1);}
  function renderLeadEditor(p=active()){
    if(!p||p.type!=='lead')return;
    $('leadPartTitle').textContent=p.name;
    $('leadVolume').value=Math.round(p.volume*100);$('leadVolumeValue').textContent=`${Math.round(p.volume*100)}%`;
    document.querySelectorAll('#leadInstrumentTabs .seg').forEach(b=>b.classList.toggle('active',b.dataset.leadInstrument===p.instrument));
    leadSoundOptions(p);$('leadGridOctave').value=String(p.gridOctave);$('leadResolution').value=String(p.resolution);$('leadBars').value=String(p.bars);
    leadBarPage=Math.max(0,Math.min(p.bars-1,leadBarPage));$('leadBarLabel').textContent=`Bar ${leadBarPage+1} / ${p.bars}`;$('leadPrevBar').disabled=leadBarPage===0;$('leadNextBar').disabled=leadBarPage>=p.bars-1;
    renderLeadGrid(p);
  }
  function renderLeadGrid(p){
    const grid=$('leadGrid');if(!grid)return;
    const subdiv=p.resolution/4,stepsPerBar=subdiv*4,startStep=leadBarPage*stepsPerBar;
    grid.style.gridTemplateColumns=`56px repeat(${stepsPerBar},26px)`;grid.innerHTML='';
    const corner=document.createElement('div');corner.className='lead-grid-corner';corner.textContent='Note';grid.appendChild(corner);
    for(let s=0;s<stepsPerBar;s++){
      const h=document.createElement('div');h.className='lead-grid-step';h.textContent=(s%subdiv===0)?String(Math.floor(s/subdiv)+1):(p.resolution<=16?(s%subdiv===subdiv/2?'&':'·'):'·');grid.appendChild(h);
    }
    const baseMidi=(p.gridOctave+1)*12;
    const on=new Set(p.events.map(e=>`${e.step}:${e.midi}`));
    for(let pc=11;pc>=0;pc--){
      const midi=baseMidi+pc;
      const label=document.createElement('div');label.className='lead-grid-note';label.textContent=midiName(midi);grid.appendChild(label);
      for(let s=0;s<stepsPerBar;s++){
        const abs=startStep+s,key=`${abs}:${midi}`;const cell=document.createElement('button');cell.type='button';cell.className='lead-cell'+(s%subdiv===0?' beat-edge':'')+(on.has(key)?' on':'');cell.dataset.step=String(abs);cell.dataset.midi=String(midi);cell.title=`${midiName(midi)} • bar ${leadBarPage+1}`;
        cell.onclick=()=>{const i=p.events.findIndex(e=>e.step===abs&&e.midi===midi);if(i>=0)p.events.splice(i,1);else p.events.push({step:abs,midi});cell.classList.toggle('on',i<0);core.scheduleAutoSave();};
        grid.appendChild(cell);
      }
    }
  }
  function renderVocalEditor(p=active()){
    if(!p||p.type!=='vocal')return;$('vocalPartTitle').textContent=p.name;$('vocalVolume').value=Math.round(p.volume*100);$('vocalVolumeValue').textContent=`${Math.round(p.volume*100)}%`;
  }

  function partDurationBeats(p){
    if(p.type==='chord')return (p.data?.rows||[]).reduce((n,r)=>n+r.length,0)*core.beats;
    if(p.type==='lead')return p.bars*4;
    return 0;
  }
  function enabledPlayable(){return parts.filter(p=>p.enabled&&(p.type==='chord'||p.type==='lead')&&partDurationBeats(p)>0);}
  function ensureAudio(){
    if(!audioCtx)audioCtx=new (window.AudioContext||window.webkitAudioContext)();if(audioCtx.state==='suspended')audioCtx.resume();
    if(!masterLimiter){masterLimiter=audioCtx.createDynamicsCompressor();masterLimiter.threshold.value=-2;masterLimiter.knee.value=0;masterLimiter.ratio.value=20;masterLimiter.attack.value=.003;masterLimiter.release.value=.12;masterLimiter.connect(audioCtx.destination);}
  }
  function busFor(p){
    ensureAudio();let bus=partBuses.get(p.id);if(!bus){bus=audioCtx.createGain();bus.connect(masterLimiter);partBuses.set(p.id,bus);}bus.gain.value=(SOUND_GAIN[p.type==='chord'?p.data.sound:p.sound]||1)*p.volume;return bus;
  }
  async function playerFor(p){
    ensureAudio();const sound=p.type==='chord'?p.data.sound:p.sound,key=`${p.id}:${sound}`;if(playerCache.has(key))return playerCache.get(key);if(!window.Soundfont)throw new Error('Sound engine unavailable');
    const promise=Soundfont.instrument(audioCtx,sound,{format:'mp3',soundfont:'MusyngKite',destination:busFor(p)});playerCache.set(key,promise);return promise;
  }
  async function preload(ps){await Promise.all(ps.map(p=>playerFor(p)));}
  function scheduleHighlight(delayMs,p,cardIndex){
    if(p.id!==activePartId||p.type!=='chord')return;
    const t=setTimeout(()=>{document.querySelectorAll('.chord-card').forEach(c=>c.style.outline='');const cards=[...document.querySelectorAll('.progression-line:not(.carousel-clone) .chord-card')];cards[cardIndex]?.style.setProperty('outline','2px solid var(--accent)');},Math.max(0,delayMs));highlightTimers.push(t);
  }
  function scheduleLeadHighlight(delayMs,p,step){
    if(p.id!==activePartId||p.type!=='lead')return;const t=setTimeout(()=>{document.querySelectorAll('.lead-cell.playing').forEach(c=>c.classList.remove('playing'));document.querySelectorAll(`.lead-cell[data-step="${step}"]`).forEach(c=>c.classList.add('playing'));},Math.max(0,delayMs));highlightTimers.push(t);
  }
  async function scheduleSegment(startTime,fromBeat,toBeat){
    const beatSec=60/core.bpm;const nowWall=performance.now();
    for(const p of enabledPlayable()){
      const player=await playerFor(p);busFor(p);
      if(p.type==='chord'){
        const cards=(p.data.rows||[]).flat();const durBeats=core.beats;
        cards.forEach((card,i)=>{const b=i*durBeats;if(b<fromBeat||b>=toBeat)return;const at=startTime+(b-fromBeat)*beatSec;const duration=Math.max(.18,durBeats*beatSec*.92);const notes=core.notesFor(card,p.data)||[];notes.forEach((n,j)=>player.play(n,at+(p.data.instrument==='guitar'?j*.035:0),{duration,gain:.94}));scheduleHighlight((at-audioCtx.currentTime)*1000,p,i);});
      }else{
        const subdiv=p.resolution/4,stepBeats=1/subdiv,duration=Math.max(.05,stepBeats*beatSec*.86);
        p.events.forEach(e=>{const b=e.step*stepBeats;if(b<fromBeat||b>=toBeat)return;const at=startTime+(b-fromBeat)*beatSec;let midi=e.midi+(Number(p.octave)||0)*12;if(p.sound==='electric_bass_finger')midi-=12;player.play(midiName(midi),at,{duration,gain:.92});scheduleLeadHighlight((at-audioCtx.currentTime)*1000,p,e.step);});
      }
    }
    return nowWall;
  }
  async function startPlayback(){
    syncLoadedChord();const ps=enabledPlayable();if(!ps.length){core.status('Turn on a Chord/Note or Lead/Bass part with something in it first.');return;}
    try{core.status('Loading part sounds…');ensureAudio();await preload(ps);playing=true;core.setPlaying(true);core.status('');await window.CRPBeatMaker?.startMainNow?.();
      const total=Math.max(...ps.map(partDurationBeats),4);let fromBeat=(active()?.type==='chord'&&active()?.enabled&&activePartId===loadedChordPartId)?Math.min(core.startBeat(),Math.max(0,total-0.001)):0;
      let nextAudioStart=audioCtx.currentTime+.10;
      const scheduleNext=async()=>{
        if(!playing)return;
        const toBeat=total,beatSec=60/core.bpm,span=(toBeat-fromBeat)*beatSec,start=nextAudioStart,end=start+span;
        await scheduleSegment(start,fromBeat,toBeat);
        nextAudioStart=end;
        if(!core.loop){cycleTimer=setTimeout(()=>stopPlayback(),Math.max(10,(end-audioCtx.currentTime)*1000+40));return;}
        const wakeMs=Math.max(10,(end-audioCtx.currentTime-.08)*1000);
        cycleTimer=setTimeout(()=>{fromBeat=0;scheduleNext();},wakeMs);
      };
      scheduleNext();
    }catch(e){console.error(e);core.status(e.message||'Could not start playback.');stopPlayback();}
  }
  function stopPlayback(){
    playing=false;clearTimeout(cycleTimer);cycleTimer=null;highlightTimers.forEach(clearTimeout);highlightTimers=[];document.querySelectorAll('.lead-cell.playing').forEach(c=>c.classList.remove('playing'));core.setPlaying(false);window.CRPBeatMaker?.stopMainNow?.();
  }
  function togglePlayback(){if(playing)stopPlayback();else startPlayback();}

  function capture(){syncLoadedChord();return {version:1,activePartId,items:clone(parts)};}
  function loadProject(project){
    const saved=project?.parts;
    if(saved?.items?.length){parts=saved.items.map(normalizePart).filter(Boolean);activePartId=parts.some(p=>p.id===saved.activePartId)?saved.activePartId:(parts.find(p=>p.type==='chord')||parts[0]).id;}
    else {const first=chordPart('Chords 1',core.snapshot());parts=[first];activePartId=first.id;}
    let c=parts.find(p=>p.id===activePartId&&p.type==='chord')||parts.find(p=>p.type==='chord');
    if(!c){c=chordPart('Chords 1',core.snapshot());parts.unshift(c);}core.apply(c.data);loadedChordPartId=c.id;
    if(activePartId!==c.id)selectPart(activePartId);else{setEditorMode('chord');renderParts();}
  }
  function newProject(){const p=chordPart('Chords 1',core.snapshot());parts=[p];activePartId=p.id;loadedChordPartId=p.id;setEditorMode('chord');renderParts();}

  function wire(){
    ensureInitial();renderParts();
    $('addPartBtn')?.addEventListener('click',openModal);$('closePartModal')?.addEventListener('click',closeModal);document.querySelector('[data-close-part-modal]')?.addEventListener('click',closeModal);document.querySelectorAll('.part-choice').forEach(b=>b.addEventListener('click',()=>addPart(b.dataset.partType)));
    document.querySelectorAll('#leadInstrumentTabs .seg').forEach(b=>b.onclick=()=>{const p=active();if(p?.type!=='lead')return;p.instrument=b.dataset.leadInstrument;p.sound=(core.sounds[p.instrument]||[])[0]?.[0]||p.sound;playerCache.clear();renderLeadEditor(p);core.scheduleAutoSave();});
    $('leadSoundSelect').onchange=e=>{const p=active();if(p?.type!=='lead')return;p.sound=e.target.value;playerCache.clear();core.scheduleAutoSave();};
    $('leadGridOctave').onchange=e=>{const p=active();if(p?.type!=='lead')return;p.gridOctave=+e.target.value;renderLeadGrid(p);core.scheduleAutoSave();};
    $('leadResolution').onchange=e=>{const p=active();if(p?.type!=='lead')return;const old=p.resolution,neu=+e.target.value;if(old!==neu&&p.events.length&&!confirm('Changing resolution keeps notes at their step numbers, so their timing may shift. Continue?')){e.target.value=String(old);return;}p.resolution=neu;renderLeadEditor(p);core.scheduleAutoSave();};
    $('leadBars').onchange=e=>{const p=active();if(p?.type!=='lead')return;p.bars=+e.target.value;const maxSteps=p.bars*(p.resolution/4)*4;p.events=p.events.filter(x=>x.step<maxSteps);leadBarPage=Math.min(leadBarPage,p.bars-1);renderLeadEditor(p);core.scheduleAutoSave();};
    $('leadPrevBar').onclick=()=>{leadBarPage=Math.max(0,leadBarPage-1);renderLeadEditor();};$('leadNextBar').onclick=()=>{const p=active();if(p?.type!=='lead')return;leadBarPage=Math.min(p.bars-1,leadBarPage+1);renderLeadEditor(p);};
    $('leadClearBar').onclick=()=>{const p=active();if(p?.type!=='lead')return;const spb=(p.resolution/4)*4,start=leadBarPage*spb,end=start+spb;if(confirm(`Clear bar ${leadBarPage+1}?`)){p.events=p.events.filter(e=>e.step<start||e.step>=end);renderLeadGrid(p);core.scheduleAutoSave();}};
    $('leadVolume').oninput=e=>{const p=active();if(p?.type!=='lead')return;p.volume=+e.target.value/100;$('leadVolumeValue').textContent=`${e.target.value}%`;renderParts();core.scheduleAutoSave();};
    $('vocalVolume').oninput=e=>{const p=active();if(p?.type!=='vocal')return;p.volume=+e.target.value/100;$('vocalVolumeValue').textContent=`${e.target.value}%`;renderParts();core.scheduleAutoSave();};
  }

  window.CRPParts={handlesPlayback:true,togglePlayback,isPlaying:()=>playing,stopPlayback,capture,loadProject,newProject,syncActiveChord};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',wire);else wire();
})();
