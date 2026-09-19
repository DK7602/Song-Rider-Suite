(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const core = window.CRPCore;
  if(!core) return;

  const clone = v => JSON.parse(JSON.stringify(v));
  const uid = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const NOTE_NAMES=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  const SOUND_GAIN={acoustic_grand_piano:2.65,bright_acoustic_piano:2.55,electric_grand_piano:2.45,electric_piano_1:2.35,electric_piano_2:2.20,synth_strings_1:1.05,pad_2_warm:1.10,pad_3_polysynth:1.12,lead_2_sawtooth:1.08,electric_bass_finger:1.05,acoustic_guitar_steel:2.55,acoustic_guitar_nylon:2.55,electric_guitar_clean:2.45,electric_guitar_jazz:2.35,electric_guitar_muted:2.45,overdriven_guitar:1.80,distortion_guitar:1.60,wah_wah_guitar:1.78,tenor_sax:1.78,alto_sax:1.75,french_horn:1.70,brass_section:1.35,trumpet:1.60,trombone:1.65,tuba:1.72,flute:1.82,clavinet:2.00,funky_worm:1.18,drawbar_organ:1.35,vibraphone:1.65,marimba:1.65,whistle:1.65,synth_brass_1:1.28};
  const soundGain=sound=>SOUND_GAIN[sound]??core.soundOutputGain?.(sound)??1;
  const LEAD_OUTPUT_BOOST=1.90; // Lead/Bass parts were much quieter than chord playback

  // v3.3.19 — keep Lead/Bass event data canonical. Older live-edit sessions can
  // occasionally leave duplicate note events on the same step/pitch; one visible
  // block should always correspond to one stored event and one tap should remove it.
  function normalizeLeadEvents(events){
    const byKey=new Map();
    for(const raw of Array.isArray(events)?events:[]){
      const step=Number(raw?.step),midi=Number(raw?.midi);
      if(!Number.isFinite(step)||!Number.isFinite(midi))continue;
      const durationSteps=Math.max(1,Math.round(Number(raw?.durationSteps)||1));
      const key=`${step}:${midi}`,prev=byKey.get(key);
      if(!prev||durationSteps>prev.durationSteps)byKey.set(key,{step,midi,durationSteps});
    }
    return [...byKey.values()].sort((a,b)=>a.step-b.step||a.midi-b.midi);
  }

  let parts=[];
  let activePartId=null;
  let loadedChordPartId=null;
  let leadBarPage=0;
  let leadGridCollapsed=false;
  try{leadGridCollapsed=localStorage.getItem('crp-lead-grid-collapsed-v1')==='1';}catch{}
  let playing=false, starting=false, playbackGeneration=0;
  let playbackScope=null; // null = normal enabled-part playback; otherwise a scoped Lead/Vocal preview
  let playbackClockStartAudioTime=0, playbackClockStartBeat=0, playbackClockBpm=92, playbackTotalBeats=0;
  let songEndBeat=null, songEndUiTimer=null, songEndSnapToBar=true;
  const SONG_END_OPEN_KEY='crp-song-end-open-v1', SONG_END_SNAP_KEY='crp-song-end-snap-bar-v1';
  let liveEditTimer=null, mediaPositionTimer=null, mediaKeepAlive=null, mediaKeepAliveUrl='', mediaPausedBeat=0, mediaActionsInstalled=false;
  let liveVocalFxNodes=new Map();
  let audioCtx=null, masterLimiter=null, cycleTimer=null;
  let playerCache=new Map(), resolvedPlayerCache=new Map(), lastReadyPlayer=new Map(), playerSound=new WeakMap(), partBuses=new Map(), partInstrumentFx=new Map(), highlightTimers=[], activeVoices=new Set(), vocalBufferCache=new Map(), activeVocalSources=new Set();
  let micStream=null,micCtx=null,micSource=null,micAnalyser=null,micProcessor=null,micSilentGain=null,micMeterRaf=0;
  let recording=false,recordingPaused=false,recordChunks=[],recordSampleRate=48000,recordStartedAt=0,recordPausedAt=0,recordPausedTotal=0,recordTimer=null,currentPreview=null,recordInsertBeat=0,recordTargetPartId=null,recordStartedFromVox=false,recordResumeBeat=0;
  let leadBarClipboard=null, speechRec=null, speechBase='';
  let partsUpdatedAt=0;
  let voxBoxOpen=false,voxCropMode=false,voxSelected=null,voxSelections=[],voxInstrumentSelection=null,voxInstrumentSelections=[],voxInstrumentTrackFocus=null,voxTargetPartId=null,voxClipboard=null,voxPlayheadBeat=0,voxRenderToken=0,voxMultiSelect=false,voxAutoScroll=true,voxShowInstrumentals=false,voxDrumMapOpen=false,voxToolMode='playhead',voxUndoStack=[],voxRedoStack=[],voxInspectorManualOverride=null;
  const VOX_SNAP_KEY='crp-vox-snap-v1',VOX_RES_KEY='crp-vox-resolution-v1',VOX_AUTO_KEY='crp-vox-autoscroll-v1',VOX_INST_KEY='crp-vox-instrumentals-v1',VOX_TRANSPORT_POS_KEY='crp-vox-transport-pos-v1',VOX_TOOL_KEY='crp-vox-tool-v1',VOX_DRUM_MAP_KEY='crp-vox-drum-map-v1',VOX_TRACK_ORDER_KEY='crp-vox-track-order-v1';
  function markPartsDirty(){ partsUpdatedAt=Date.now(); return partsUpdatedAt; }

  function chordPart(name='Chords 1', data=null){
    const d=data?clone(data):core.snapshot();
    if(!d.rows?.length)d.rows=[[]];
    return {id:uid(),type:'chord',name,enabled:true,volume:.85,data:d};
  }
  function leadPart(name='Lead 1'){
    return {id:uid(),type:'lead',name,enabled:true,repeat:true,sustain:false,volume:.8,instrument:'piano',sound:'acoustic_grand_piano',octave:0,gridOctave:3,resolution:16,bars:4,events:[]};
  }
  function vocalPart(name='Vocals 1'){
    return {id:uid(),type:'vocal',name,enabled:true,repeat:true,volume:1,transcript:'',recordings:[],activeTakeId:null,voxEvents:[],backingPartIds:parts.filter(x=>x.type==='chord'||x.type==='lead').filter(x=>x.enabled).map(x=>x.id),backingDrums:true,backingVolume:.8,fx:{eq:'clear',comp:'medium',reverb:.12,delay:0,autotune:0}};
  }
  function normalizeVocalFx(fx,fallback=null){
    const f=fx||fallback||{};
    return {eq:f.eq||'clear',comp:f.comp||'medium',reverb:Number(f.reverb??.12),delay:Number(f.delay||0),autotune:Math.max(0,Math.min(100,Number(f.autotune)||0))};
  }
  function normalizeVoxEvent(e,p=null){
    if(!e)return null;
    const takeId=String(e.takeId||p?.activeTakeId||'');
    if(!takeId)return null;
    const trimEndRaw=Number(e.trimEndSec);
    return {
      id:e.id||uid(),takeId,sourcePartId:String(e.sourcePartId||p?.id||''),
      startBeat:Math.max(0,Number(e.startBeat)||0),trimStartSec:Math.max(0,Number(e.trimStartSec)||0),
      trimEndSec:Number.isFinite(trimEndRaw)&&trimEndRaw>0?trimEndRaw:null,
      volume:Number.isFinite(Number(e.volume))?Math.max(0,Math.min(1.5,Number(e.volume))):1,
      fx:e.fx?normalizeVocalFx(e.fx):null
    };
  }
  function normalizePart(p,i){
    if(!p||!p.type)return null;
    const base={id:p.id||uid(),name:p.name||`${p.type==='chord'?'Chords':p.type==='lead'?'Lead':'Vocals'} ${i+1}`,enabled:p.enabled!==false,volume:Number.isFinite(+p.volume)?Math.max(0,Math.min(1,+p.volume)):.85};
    if(p.type==='chord')return {...base,type:'chord',data:clone(p.data||core.snapshot())};
    if(p.type==='lead')return {...base,type:'lead',repeat:p.repeat!==false,sustain:p.sustain===true,instrument:['piano','guitar','misc'].includes(p.instrument)?p.instrument:'piano',sound:p.sound||'acoustic_grand_piano',octave:Number(p.octave)||0,gridOctave:Number(p.gridOctave)||3,resolution:[8,16,32,64].includes(+p.resolution)?+p.resolution:16,bars:Math.max(1,Math.min(16,+p.bars||4)),events:normalizeLeadEvents(p.events)};
    const voxEvents=Array.isArray(p.voxEvents)?p.voxEvents.map(e=>normalizeVoxEvent(e,p)).filter(Boolean):[];
    return {...base,type:'vocal',repeat:p.repeat!==false,transcript:String(p.transcript||''),transcriptWords:Array.isArray(p.transcriptWords)?p.transcriptWords:[],recordings:Array.isArray(p.recordings)?p.recordings.map(r=>({...r,blob:null})):[],activeTakeId:p.activeTakeId||null,voxEvents,backingPartIds:Array.isArray(p.backingPartIds)?p.backingPartIds:[],backingDrums:p.backingDrums!==false,backingVolume:Number.isFinite(+p.backingVolume)?Math.max(0,Math.min(1,+p.backingVolume)):.8,fx:{eq:p.fx?.eq||'clear',comp:p.fx?.comp||'medium',reverb:Number(p.fx?.reverb??.12),delay:Number(p.fx?.delay||0),autotune:Math.max(0,Math.min(100,Number(p.fx?.autotune)||0))}};
  }
  function ensureInitial(){
    if(parts.length)return;
    const p=chordPart('Chords 1');parts=[p];activePartId=p.id;loadedChordPartId=p.id;
  }
  function active(){return parts.find(p=>p.id===activePartId)||parts[0]||null;}
  function allVocalParts(){return parts.filter(p=>p.type==='vocal');}
  function findVocalTake(takeId,sourcePartId=''){
    const sid=String(sourcePartId||''),tid=String(takeId||'');
    const source=parts.find(p=>p.type==='vocal'&&String(p.id)===sid);
    const direct=source?.recordings?.find(r=>String(r.id)===tid);
    if(direct)return {part:source,take:direct};
    for(const p of allVocalParts()){const take=p.recordings?.find(r=>String(r.id)===tid);if(take)return {part:p,take};}
    return null;
  }
  function voxEventTake(e){return findVocalTake(e?.takeId,e?.sourcePartId)?.take||null;}
  function voxEventDurationSeconds(e){
    const take=voxEventTake(e);if(!take)return 0;
    const full=Math.max(0,Number(take.duration)||0),start=Math.max(0,Math.min(full,Number(e.trimStartSec)||0));
    const end=Math.max(start,Math.min(full,Number.isFinite(Number(e.trimEndSec))&&Number(e.trimEndSec)>0?Number(e.trimEndSec):full));
    return Math.max(0,end-start);
  }
  function voxEventDurationBeats(e,bpm=core.bpm){return voxEventDurationSeconds(e)*Math.max(40,Math.min(240,Number(bpm)||92))/60;}
  function voxTrackEvents(p){return p?.type==='vocal'&&Array.isArray(p.voxEvents)?p.voxEvents.filter(e=>voxEventTake(e)&&voxEventDurationSeconds(e)>.01):[];}
  function vocalHasPlayableAudio(p){return !!(voxTrackEvents(p).length||(p?.activeTakeId&&p?.recordings?.some(r=>r.id===p.activeTakeId)));}
  function effectiveVocalFx(p,e=null){return e?.fx?normalizeVocalFx(e.fx,p?.fx):normalizeVocalFx(p?.fx);}
  function ensureVoxEventForActiveTake(p,startBeat=0){
    if(!p||p.type!=='vocal'||!p.activeTakeId||!p.recordings?.some(r=>r.id===p.activeTakeId))return null;
    if(!Array.isArray(p.voxEvents))p.voxEvents=[];
    const existing=p.voxEvents.find(e=>e.takeId===p.activeTakeId&&Math.abs((Number(e.startBeat)||0)-Number(startBeat||0))<1e-6);
    if(existing)return existing;
    const ev=normalizeVoxEvent({id:uid(),takeId:p.activeTakeId,sourcePartId:p.id,startBeat,trimStartSec:0,trimEndSec:null,volume:1,fx:null},p);
    p.voxEvents.push(ev);return ev;
  }
  function updatePartPlaybackButtons(){
    const a=active(), busy=!!(playing||starting);
    const leadBtn=$('leadPlaybackBtn');
    const vocalBtn=$('vocalMasterPlayBtn');
    // Lead/Bass Play is the Baby DAW master transport for the parts checked in
    // the part strip. It is intentionally not a current-part-only preview.
    const leadHere=busy&&!playbackScope;
    const vocalHere=busy&&playbackScope?.kind==='vocalMix'&&String(playbackScope.ownerId||'')===String(a?.id||'');
    if(leadBtn){
      leadBtn.textContent=leadHere?'■ Stop':'▶ Play';
      leadBtn.classList.toggle('is-playing',leadHere);
      leadBtn.setAttribute('aria-pressed',leadHere?'true':'false');
    }
    if(vocalBtn){
      vocalBtn.textContent=vocalHere?'■ Stop Mix':'▶ Play Mix';
      vocalBtn.classList.toggle('is-playing',vocalHere);
      vocalBtn.setAttribute('aria-pressed',vocalHere?'true':'false');
    }
    const voxBtn=$('voxBoxPlayBtn');
    if(voxBtn){voxBtn.textContent=busy?'■ Stop':'▶ Play';voxBtn.classList.toggle('is-playing',busy);voxBtn.setAttribute('aria-pressed',busy?'true':'false');}
  }
  function loadedChord(){return parts.find(p=>p.id===loadedChordPartId&&p.type==='chord')||null;}
  function syncLoadedChord(){
    const p=loadedChord();
    if(p)p.data=core.snapshot();
  }
  function syncActiveChord(){
    const p=active();
    if(p?.type==='chord'&&p.id===loadedChordPartId)p.data=core.snapshot();
  }

  function refreshBabySetupToggle(){
    const btn=$('babyChordSetupToggleBtn');if(!btn)return;
    const chord=active()?.type==='chord';
    const inBaby=document.body.classList.contains('workspace-baby-daw');
    btn.hidden=!(inBaby&&chord);
    if(inBaby&&chord)core.refreshSetupVisibility?.();
  }
  function setEditorMode(type){
    const chord=type==='chord';
    $('chordPartControls')?.classList.toggle('part-hidden',!chord);
    $('chordPartRows')?.classList.toggle('part-hidden',!chord);
    if($('leadPartEditor'))$('leadPartEditor').hidden=type!=='lead';
    if($('vocalPartEditor'))$('vocalPartEditor').hidden=type!=='vocal';
    refreshBabySetupToggle();
  }

  function selectPart(id){
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
      const wrap=document.createElement('div');wrap.className='part-pill'+(p.id===activePartId?' active':'');wrap.dataset.partId=String(p.id);
      const chk=document.createElement('input');chk.type='checkbox';chk.checked=p.enabled;chk.title='Include this part in playback';chk.setAttribute('aria-label',`Play ${p.name}`);chk.onchange=e=>{p.enabled=e.target.checked;core.scheduleAutoSave();};
      const open=document.createElement('button');open.type='button';open.className='part-open';open.textContent=p.name;open.onclick=()=>selectPart(p.id);
      const vol=document.createElement('span');vol.className='part-mini-vol';vol.textContent=`${Math.round(p.volume*100)}%`;
      const rename=document.createElement('button');rename.type='button';rename.className='part-delete';rename.textContent='✎';rename.title='Rename part';rename.onclick=e=>{e.stopPropagation();const n=prompt('Part name:',p.name);if(n?.trim()){p.name=n.trim();renderParts();if(p.id===activePartId){if(p.type==='lead')renderLeadEditor(p);if(p.type==='vocal')renderVocalEditor(p);}core.scheduleAutoSave();}};
      wrap.append(chk,open,vol,rename);
      if(!(index===0&&p.type==='chord')){
        const del=document.createElement('button');del.type='button';del.className='part-delete';del.textContent='×';del.title='Delete part';del.onclick=e=>{e.stopPropagation();if(!confirm(`Delete “${p.name}”?`))return;const wasLoaded=p.id===loadedChordPartId;parts=parts.filter(x=>x.id!==p.id);if(!parts.length){const first=chordPart('Chords 1');parts=[first];loadedChordPartId=first.id;}if(wasLoaded){const c=parts.find(x=>x.type==='chord');if(c){core.apply(c.data);loadedChordPartId=c.id;}}if(activePartId===p.id)selectPart((parts.find(x=>x.type==='chord')||parts[0]).id);else renderParts();markPartsDirty();core.scheduleAutoSave();core.flushAutoSaveNow?.();};
        wrap.append(del);
      }
      strip.appendChild(wrap);
    });
    renderActiveVolumeControl();
    renderSongEndEditor();
  }

  function renderActiveVolumeControl(){
    const mgr=$('partManager');if(!mgr)return;
    let row=$('activePartVolumeRow');
    if(!row){row=document.createElement('div');row.id='activePartVolumeRow';row.className='active-part-volume-row';mgr.appendChild(row);}
    const p=active();if(!p){row.innerHTML='';return;}
    row.innerHTML=`<span>${escapeHtml(p.name)} volume</span><input id="activePartVolume" type="range" min="0" max="100" value="${Math.round(p.volume*100)}"><strong id="activePartVolumeValue">${Math.round(p.volume*100)}%</strong>`;
    const slider=$('activePartVolume');const paintRange=el=>el?.style.setProperty('--range-fill',`${el.value}%`);paintRange(slider);slider.oninput=()=>{paintRange(slider);p.volume=+slider.value/100;$('activePartVolumeValue').textContent=`${slider.value}%`;const pill=[...document.querySelectorAll('.part-pill')].find(x=>x.querySelector('.part-open')?.textContent===p.name);if(pill)pill.querySelector('.part-mini-vol').textContent=`${slider.value}%`;if(p.type==='lead'&&$('leadVolume')){$('leadVolume').value=slider.value;$('leadVolumeValue').textContent=`${slider.value}%`;}if(p.type==='vocal'&&$('vocalVolume')){$('vocalVolume').value=slider.value;$('vocalVolumeValue').textContent=`${slider.value}%`;applyVocalFxLive(p);}else if((playing||starting)&&partBuses.has(p.id))busFor(p,outputSoundFor(p));core.scheduleAutoSave();};
  }
  function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));}

  function openModal(){if($('addPartModal'))$('addPartModal').hidden=false;}
  function closeModal(){if($('addPartModal'))$('addPartModal').hidden=true;}
  function countType(type){return parts.filter(p=>p.type===type).length;}
  function addPart(type){
    syncLoadedChord();let p;
    if(type==='chord'){
      p=chordPart(`Chords ${countType('chord')+1}`,{...core.snapshot(),rows:[[]],key:''});
      // A brand-new Baby DAW chord part always opens its setup controls so the user
      // can immediately choose Piano/Guitar, Chord/Note, Sound, Octave, Capo, etc.
      // This changes Baby DAW only; CRP keeps its own Hide/Show preference untouched.
      core.setBabyDawSetupHidden?.(false);
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
  function renderLeadSoundControls(p){
    if(!p||p.type!=='lead')return;
    document.querySelectorAll('#leadInstrumentTabs .seg').forEach(b=>b.classList.toggle('active',b.dataset.leadInstrument===p.instrument));
    leadSoundOptions(p);
  }
  function desktopLeadGridView(){
    return !!window.matchMedia?.('(min-width: 721px)').matches;
  }
  function updateLeadGridViewToggle(){
    const editor=$('leadPartEditor'),btn=$('leadGridViewToggle');if(!editor)return;
    const canToggle=desktopLeadGridView(),collapsed=canToggle&&leadGridCollapsed;
    editor.classList.toggle('lead-grid-collapsed',collapsed);
    if(btn){
      btn.hidden=!canToggle;
      btn.textContent=collapsed?'Expand Grid':'Collapse Grid';
      btn.setAttribute('aria-pressed',String(collapsed));
      btn.title=collapsed?'Expand the full MIDI grid':'Fit the MIDI grid to the screen with its own scroll window';
    }
  }
  function midiName(m){return NOTE_NAMES[(m%12+12)%12]+(Math.floor(m/12)-1);}
  const HARMONY_NOTE_INDEX={C:0,'C#':1,Db:1,D:2,'D#':3,Eb:3,E:4,F:5,'F#':6,Gb:6,G:7,'G#':8,Ab:8,A:9,'A#':10,Bb:10,B:11};
  function harmonyPitchClass(raw){
    const m=String(raw||'').trim().replace(/♭/g,'b').replace(/♯/g,'#').match(/^([A-Ga-g])([#b]?)/);
    if(!m)return null;const n=m[1].toUpperCase()+m[2];const i=HARMONY_NOTE_INDEX[n];return Number.isFinite(i)?i:null;
  }
  function transposeHarmonyLabel(raw,semi){
    const txt=String(raw||'').trim().replace(/♭/g,'b').replace(/♯/g,'#');
    const m=txt.match(/^([A-Ga-g])([#b]?)(.*)$/);if(!m)return txt;
    const root=m[1].toUpperCase()+m[2],i=HARMONY_NOTE_INDEX[root];if(!Number.isFinite(i))return txt;
    return NOTE_NAMES[(i+(Number(semi)||0)+120)%12]+m[3];
  }
  function harmonyDisplayCard(card,data){
    const raw=String(card?.value||'').trim();if(!raw)return '';
    if(data?.instrument==='guitar'&&data?.transpose&&Number(data?.capo))return transposeHarmonyLabel(raw,Number(data.capo)||0);
    return raw;
  }
  function harmonyKey(data,cards){
    const raw=String(data?.key||'').trim().replace(/♭/g,'b').replace(/♯/g,'#');
    let root=null,minor=false;
    let m=raw.match(/^([A-Ga-g])([#b]?)(?:\s*(m|minor|maj|major))?$/i);
    if(m){root=m[1].toUpperCase()+m[2];minor=/^(m|minor)$/i.test(m[3]||'');}
    if(root==null){
      const first=cards.find(c=>c?.type==='chord');
      if(first){m=String(first.value||'').trim().match(/^([A-Ga-g])([#b]?)(.*)$/);if(m){root=m[1].toUpperCase()+m[2];const q=(m[3]||'').toLowerCase();minor=q.startsWith('m')&&!q.startsWith('maj');}}
    }
    let i=root==null?null:HARMONY_NOTE_INDEX[root];if(!Number.isFinite(i))return null;
    if(data?.instrument==='guitar'&&Number(data?.capo))i=(i+Number(data.capo)+120)%12;
    return {rootIndex:i,minor};
  }
  function vocalAutotuneScale(){
    const chord=loadedChord()||parts.find(x=>x.type==='chord')||null;
    const data=chord?.data||core.snapshot();
    const cards=(data?.rows||[]).flat().filter(Boolean);
    const key=harmonyKey(data,cards);
    if(!key)return {allowedPcs:[],label:'Song key: set a key/chord first'};
    const ints=key.minor?[0,2,3,5,7,8,10]:[0,2,4,5,7,9,11];
    const allowedPcs=ints.map(i=>(key.rootIndex+i)%12);
    return {allowedPcs,label:`Song key: ${NOTE_NAMES[key.rootIndex]} ${key.minor?'minor':'major'}`};
  }
  const autotuneReadyContexts=new WeakSet();
  const autotuneLoadingContexts=new WeakMap();
  async function ensureAutotuneWorklet(ctx){
    if(!ctx?.audioWorklet||typeof AudioWorkletNode==='undefined')return false;
    if(autotuneReadyContexts.has(ctx))return true;
    if(autotuneLoadingContexts.has(ctx))return autotuneLoadingContexts.get(ctx);
    const promise=ctx.audioWorklet.addModule('./vocal-autotune-worklet.js?v=3.3.15').then(()=>{autotuneReadyContexts.add(ctx);return true;}).catch(err=>{console.warn('Auto-Tune worklet unavailable',err);return false;});
    autotuneLoadingContexts.set(ctx,promise);
    return promise;
  }
  function makeAutotuneNode(ctx,p,fxOverride=null){
    const fx=fxOverride||p?.fx||{};
    const amount=Math.max(0,Math.min(100,Number(fx.autotune)||0));
    const scale=vocalAutotuneScale();
    if(!autotuneReadyContexts.has(ctx)||typeof AudioWorkletNode==='undefined')return null;
    try{
      const node=new AudioWorkletNode(ctx,'crp-vocal-autotune',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1]});
      node.port.postMessage({amount,allowedPcs:scale.allowedPcs||[]});
      return node;
    }catch(err){console.warn('Could not create Auto-Tune node',err);return null;}
  }
  const LONG_SUSTAIN_SOUNDS=new Set(['acoustic_grand_piano','bright_acoustic_piano','electric_grand_piano','electric_piano_1','electric_piano_2','acoustic_guitar_steel','acoustic_guitar_nylon','pad_2_warm','pad_3_polysynth','synth_strings_1','drawbar_organ']);
  function sustainedPartSeconds(sound,seconds){
    const s=Math.max(.05,Number(seconds)||.05);
    return LONG_SUSTAIN_SOUNDS.has(sound)?Math.max(.78,s*1.38+.18):Math.max(.65,s*1.08);
  }
  function uniquePitchClasses(items){const out=[];for(const i of items){const n=Number(i);if(Number.isFinite(n)&&!out.includes((n+120)%12))out.push((n+120)%12);}return out;}
  function harmonyContextForLeadBar(){
    const chord=loadedChord()||parts.find(x=>x.type==='chord')||null;
    const data=chord?.data||core.snapshot();
    const cards=(data?.rows||[]).flat().filter(Boolean);
    const barStart=leadBarPage*4,barEnd=barStart+4;
    let chordCursor=0;const current=[];
    for(const card of cards){const dur=core.cardDurationBeats?.(card,core.beats)||Math.max(.25,Number(core.beats)||4),a=chordCursor,b=a+dur;if(b>barStart&&a<barEnd)current.push(card);chordCursor=b;}
    const chordCards=current.filter(c=>c?.type==='chord');
    const chordLabels=[];
    for(const c of chordCards){const label=harmonyDisplayCard(c,data);if(label&&!chordLabels.includes(label))chordLabels.push(label);}
    const chordTonePcs=[],rootPcs=[];
    for(const c of chordCards){
      const label=harmonyDisplayCard(c,data),root=harmonyPitchClass(label);if(root!=null&&!rootPcs.includes(root))rootPcs.push(root);
      for(const n of core.notesFor(c,data)||[]){const pc=harmonyPitchClass(n);if(pc!=null&&!chordTonePcs.includes(pc))chordTonePcs.push(pc);}
    }
    const key=harmonyKey(data,cards);
    let notePcs=[];
    if(key){
      const ints=key.minor?[0,2,3,5,7,8,10]:[0,2,4,5,7,9,11];
      notePcs=ints.map(i=>(key.rootIndex+i)%12);
      for(const pc of chordTonePcs)if(!notePcs.includes(pc))notePcs.push(pc);
    }else if(chordTonePcs.length){
      const start=rootPcs[0]??chordTonePcs[0];
      notePcs=[...chordTonePcs].sort((a,b)=>((a-start+12)%12)-((b-start+12)%12));
    }
    return {chordName:chord?.name||'Chords',chordLabels,notePcs:uniquePitchClasses(notePcs),chordTonePcs:uniquePitchClasses(chordTonePcs),rootPcs:uniquePitchClasses(rootPcs)};
  }
  function renderLeadHarmony(){
    const chordsBox=$('leadChordsUsed'),notesBox=$('leadNotesFit');if(!chordsBox||!notesBox)return;
    const ctx=harmonyContextForLeadBar();chordsBox.innerHTML='';notesBox.innerHTML='';
    if(!ctx.chordLabels.length){const e=document.createElement('span');e.className='lead-harmony-empty';e.textContent='—';chordsBox.appendChild(e);}else{
      for(const name of ctx.chordLabels){const chip=document.createElement('span');chip.className='lead-harmony-chip chord';chip.textContent=name;chip.title=`${ctx.chordName} • Bar ${leadBarPage+1}`;chordsBox.appendChild(chip);}
    }
    if(!ctx.notePcs.length){const e=document.createElement('span');e.className='lead-harmony-empty';e.textContent='—';notesBox.appendChild(e);}else{
      for(const pc of ctx.notePcs){const chip=document.createElement('span');chip.className='lead-harmony-chip note';if(ctx.chordTonePcs.includes(pc))chip.classList.add('chord-tone');if(ctx.rootPcs.includes(pc))chip.classList.add('root-tone');chip.textContent=NOTE_NAMES[pc];chip.title=ctx.rootPcs.includes(pc)?'Chord root':ctx.chordTonePcs.includes(pc)?'Chord tone':'In-key note';notesBox.appendChild(chip);}
    }
  }
  function renderLeadEditor(p=active()){
    if(!p||p.type!=='lead')return;
    $('leadPartTitle').textContent=p.name;p.repeat=!!core.loop;if($('leadRepeat'))$('leadRepeat').checked=!!core.loop;if($('leadSustain'))$('leadSustain').checked=p.sustain===true;
    $('leadVolume').value=Math.round(p.volume*100);$('leadVolumeValue').textContent=`${Math.round(p.volume*100)}%`;
    renderLeadSoundControls(p);$('leadGridOctave').value=String(p.gridOctave);$('leadResolution').value=String(p.resolution);$('leadBars').value=String(p.bars);
    leadBarPage=Math.max(0,Math.min(p.bars-1,leadBarPage));updateLeadBarUi(p);
    updateLeadGridViewToggle();
    renderLeadGrid(p,{scrollToBar:true});
    core.updateAutoScrollUi?.();
    updatePartPlaybackButtons();
  }
  const LEAD_STEP_PX=26;
  function leadDurationSteps(e){return Math.max(1,Math.round(Number(e?.durationSteps)||1));}
  function leadTotalSteps(p){return Math.max(1,Math.round((Number(p?.bars)||1)*(Number(p?.resolution)||16)));}
  function leadDurationLabel(p,steps){const beats=steps/(p.resolution/4);return Number.isInteger(beats)?`${beats} beat${beats===1?'':'s'}`:`${Math.round(beats*100)/100} beats`;}
  function updateLeadBarUi(p){
    leadBarPage=Math.max(0,Math.min(p.bars-1,leadBarPage));
    if($('leadBarLabel'))$('leadBarLabel').textContent=`Bar ${leadBarPage+1} / ${p.bars}`;
    if($('leadPrevBar'))$('leadPrevBar').disabled=leadBarPage===0;
    if($('leadNextBar'))$('leadNextBar').disabled=p.bars<=1;
    renderLeadHarmony();
  }
  function scrollLeadGridToBar(p,smooth=true){
    const wrap=$('leadGridWrap');if(!wrap)return;
    const barWidth=p.resolution*LEAD_STEP_PX;
    wrap.scrollTo({left:Math.max(0,leadBarPage*barWidth),behavior:smooth?'smooth':'auto'});
  }
  function leadEventCovering(p,midi,step){
    return p.events.find(e=>e.midi===midi&&step>=e.step&&step<e.step+leadDurationSteps(e))||null;
  }
  function removeLeadEvent(p,event){
    if(!p||!event)return false;
    const step=Number(event.step),midi=Number(event.midi),before=p.events.length;
    // Remove the exact visible note and any same-step/same-pitch duplicate left
    // behind by an older build. One visible block should always disappear in one tap.
    p.events=p.events.filter(e=>!(Number(e.step)===step&&Number(e.midi)===midi));
    if(p.events.length===before)return false;
    markPartsDirty();renderLeadGrid(p);core.scheduleAutoSave();
    return true;
  }
  function updatePartMiniVolume(p){
    if(!p)return;
    let pill=null;
    for(const el of document.querySelectorAll('.part-pill')){
      if(String(el.dataset.partId||'')===String(p.id)){pill=el;break;}
    }
    const out=pill?.querySelector('.part-mini-vol');
    if(out)out.textContent=`${Math.round(Math.max(0,Math.min(1,Number(p.volume)||0))*100)}%`;
  }
  function maxLeadDurationSteps(p,event){
    const total=leadTotalSteps(p);let max=Math.max(1,total-event.step);
    const next=p.events.filter(e=>e!==event&&e.midi===event.midi&&e.step>event.step).sort((a,b)=>a.step-b.step)[0];
    if(next)max=Math.min(max,Math.max(1,next.step-event.step));
    return max;
  }
  function bindLeadDurationDrag(handle,block,p,event,wrap){
    handle.addEventListener('pointerdown',e=>{
      if(e.button!=null&&e.button!==0)return;
      e.preventDefault();e.stopPropagation();
      const pointerId=e.pointerId,startX=e.clientX,startY=e.clientY,startScroll=wrap.scrollLeft,startDur=leadDurationSteps(event),maxDur=maxLeadDurationSteps(p,event);
      let lastDur=startDur,lastClientX=e.clientX,autoRaf=0,moved=false,maxTravel=0;
      handle.classList.add('dragging');block.classList.add('resizing');
      try{handle.setPointerCapture?.(pointerId);}catch(_){ }
      const apply=clientX=>{
        lastClientX=clientX;
        const dx=clientX-startX+(wrap.scrollLeft-startScroll);
        const next=Math.max(1,Math.min(maxDur,Math.round(startDur+dx/LEAD_STEP_PX)));
        if(next===lastDur)return;
        lastDur=next;moved=true;event.durationSteps=next;block.style.gridColumnEnd=`span ${next}`;
        core.status(`${midiName(event.midi)} duration: ${leadDurationLabel(p,next)}`);
      };
      // v3.3.5 precision pass: deliberately slow edge travel. Shrinking toward
      // the left is slower than growing right because that was easiest to overshoot
      // on a phone. Direct note-grid dragging remains one full grid step per 26px.
      let autoLastTs=0;
      const autoScroll=ts=>{
        autoRaf=0;
        const r=wrap.getBoundingClientRect(),edgeRight=52,edgeLeft=88;
        let direction=0,depth=0;
        if(lastClientX>r.right-edgeRight){direction=1;depth=Math.min(1,Math.max(0,(lastClientX-(r.right-edgeRight))/edgeRight));}
        else if(lastClientX<r.left+edgeLeft){direction=-1;depth=Math.min(1,Math.max(0,((r.left+edgeLeft)-lastClientX)/edgeLeft));}
        if(direction){
          const dt=autoLastTs?Math.min(40,Math.max(8,ts-autoLastTs)):16.67;
          const minSpeed=direction<0?7:10;
          const maxExtra=direction<0?13:18;
          const pxPerSecond=minSpeed+(maxExtra*depth);
          const before=wrap.scrollLeft;
          wrap.scrollLeft=Math.max(0,Math.min(wrap.scrollWidth-wrap.clientWidth,before+direction*pxPerSecond*(dt/1000)));
          if(Math.abs(wrap.scrollLeft-before)>.01)apply(lastClientX);
          autoLastTs=ts;
          autoRaf=requestAnimationFrame(autoScroll);
        }else autoLastTs=0;
      };
      const onMove=ev=>{if(ev.pointerId!==pointerId)return;ev.preventDefault();lastClientX=ev.clientX;maxTravel=Math.max(maxTravel,Math.hypot(ev.clientX-startX,ev.clientY-startY));apply(ev.clientX);if(!autoRaf){autoLastTs=0;autoRaf=requestAnimationFrame(autoScroll);}};
      const finish=ev=>{
        if(ev.pointerId!==pointerId)return;
        ev.preventDefault();ev.stopPropagation();
        document.removeEventListener('pointermove',onMove,true);document.removeEventListener('pointerup',finish,true);document.removeEventListener('pointercancel',finish,true);
        if(autoRaf)cancelAnimationFrame(autoRaf);handle.classList.remove('dragging');block.classList.remove('resizing');
        if(Number.isFinite(ev.clientX)&&Number.isFinite(ev.clientY))maxTravel=Math.max(maxTravel,Math.hypot(ev.clientX-startX,ev.clientY-startY));
        try{handle.releasePointerCapture?.(pointerId);}catch(_){ }
        // On a one-step note the resize handle covers a large share of the block.
        // A stationary tap on it is a delete tap; moving more than 6px means resize.
        if(ev.type==='pointerup'&&maxTravel<=6){removeLeadEvent(p,event);return;}
        if(moved){markPartsDirty();core.scheduleAutoSave();core.status(`${midiName(event.midi)} set to ${leadDurationLabel(p,leadDurationSteps(event))}.`);}
      };
      document.addEventListener('pointermove',onMove,{capture:true,passive:false});document.addEventListener('pointerup',finish,{capture:true,passive:false});document.addEventListener('pointercancel',finish,{capture:true,passive:false});
    });
    handle.onclick=e=>{e.preventDefault();e.stopPropagation();};
  }
  function renderLeadGrid(p,opts={}){
    const grid=$('leadGrid'),wrap=$('leadGridWrap');if(!grid||!wrap)return;
    const keepLeft=opts.scrollToBar?null:wrap.scrollLeft,keepTop=wrap.scrollTop;
    const subdiv=p.resolution/4,totalSteps=leadTotalSteps(p);
    grid.style.gridTemplateColumns=`56px repeat(${totalSteps},${LEAD_STEP_PX}px)`;
    grid.style.gridTemplateRows=`32px repeat(12,29px)`;
    grid.innerHTML='';
    const corner=document.createElement('div');corner.className='lead-grid-corner';corner.textContent='Note';corner.style.gridColumn='1';corner.style.gridRow='1';grid.appendChild(corner);
    for(let s=0;s<totalSteps;s++){
      const within=s%p.resolution,bar=Math.floor(s/p.resolution),pos=within%subdiv,beat=Math.floor(within/subdiv)+1;
      const h=document.createElement('div');h.className='lead-grid-step'+(within===0?' bar-edge':'');
      h.textContent=within===0?`B${bar+1}`:(pos===0?String(beat):(p.resolution<=16?(pos===subdiv/2?'&':'·'):'·'));
      h.style.gridColumn=String(s+2);h.style.gridRow='1';grid.appendChild(h);
    }
    const baseMidi=(p.gridOctave+1)*12;
    for(let pc=11;pc>=0;pc--){
      const midi=baseMidi+pc,rowIndex=2+(11-pc);
      const label=document.createElement('div');label.className='lead-grid-note';label.textContent=midiName(midi);label.style.gridColumn='1';label.style.gridRow=String(rowIndex);grid.appendChild(label);
      for(let s=0;s<totalSteps;s++){
        const cell=document.createElement('button');cell.type='button';cell.className='lead-cell'+(s%subdiv===0?' beat-edge':'')+(s%p.resolution===0?' bar-edge':'');cell.dataset.step=String(s);cell.dataset.midi=String(midi);cell.title=`${midiName(midi)} • bar ${Math.floor(s/p.resolution)+1}`;cell.style.gridColumn=String(s+2);cell.style.gridRow=String(rowIndex);
        cell.onclick=()=>{if(leadEventCovering(p,midi,s))return;const ev={step:s,midi,durationSteps:1};p.events.push(ev);p.events=normalizeLeadEvents(p.events);if(!(playing||starting))auditionLeadNote(p,midi);markPartsDirty();renderLeadGrid(p);core.scheduleAutoSave();};
        grid.appendChild(cell);
      }
    }
    for(const event of p.events){
      if(!Number.isFinite(event.step)||!Number.isFinite(event.midi)||event.step<0||event.step>=totalSteps)continue;
      const pc=((event.midi-baseMidi)%12+12)%12;if(event.midi<baseMidi||event.midi>baseMidi+11)continue;
      const rowIndex=2+(11-pc),dur=Math.min(leadDurationSteps(event),Math.max(1,totalSteps-event.step));event.durationSteps=dur;
      const block=document.createElement('button');block.type='button';block.className='lead-note-block';block.dataset.step=String(event.step);block.dataset.midi=String(event.midi);block.style.gridColumn=`${event.step+2} / span ${dur}`;block.style.gridRow=String(rowIndex);block.title=`${midiName(event.midi)} • ${leadDurationLabel(p,dur)} • tap to remove`;
      const inner=document.createElement('span');inner.className='lead-note-block-fill';block.appendChild(inner);
      const handle=document.createElement('span');handle.className='lead-duration-handle';handle.title='Drag to change note duration';block.appendChild(handle);
      block.onclick=e=>{if(e.target.closest('.lead-duration-handle'))return;e.preventDefault();e.stopPropagation();removeLeadEvent(p,event);};
      bindLeadDurationDrag(handle,block,p,event,wrap);grid.appendChild(block);
    }
    clearTimeout(wrap._leadBarTimer);wrap.onscroll=()=>{clearTimeout(wrap._leadBarTimer);wrap._leadBarTimer=setTimeout(()=>{const page=Math.max(0,Math.min(p.bars-1,Math.round(wrap.scrollLeft/(p.resolution*LEAD_STEP_PX))));if(page!==leadBarPage){leadBarPage=page;updateLeadBarUi(p);}},90);};
    requestAnimationFrame(()=>{if(opts.scrollToBar)scrollLeadGridToBar(p,false);else{wrap.scrollLeft=keepLeft||0;wrap.scrollTop=keepTop||0;}});
  }
  function copyLeadBar(){
    const p=active();if(!p||p.type!=='lead')return;const spb=p.resolution,start=leadBarPage*spb;
    leadBarClipboard={resolution:p.resolution,events:p.events.filter(e=>e.step>=start&&e.step<start+spb).map(e=>({beat:(e.step-start)/(p.resolution/4),midi:e.midi,durationBeats:leadDurationSteps(e)/(p.resolution/4)}))};
    if($('leadPasteBar'))$('leadPasteBar').disabled=false;core.status(`Copied bar ${leadBarPage+1} (${leadBarClipboard.events.length} note${leadBarClipboard.events.length===1?'':'s'}).`);
  }
  function pasteLeadBar(){
    const p=active();if(!p||p.type!=='lead'||!leadBarClipboard)return;const spb=p.resolution,start=leadBarPage*spb,total=leadTotalSteps(p);p.events=p.events.filter(e=>e.step<start||e.step>=start+spb);
    for(const e of leadBarClipboard.events){const rel=Math.round(e.beat*(p.resolution/4)),durationSteps=Math.max(1,Math.round((Number(e.durationBeats)||1/(p.resolution/4))*(p.resolution/4)));if(rel>=0&&rel<spb)p.events.push({step:start+rel,midi:e.midi,durationSteps:Math.min(durationSteps,total-(start+rel))});}
    p.events.sort((a,b)=>a.step-b.step||a.midi-b.midi);markPartsDirty();renderLeadGrid(p);core.scheduleAutoSave();core.status(`Pasted into bar ${leadBarPage+1}.`);
  }
  const vocalDbName='crp-vocal-audio-v1';
  function openVocalDb(){return new Promise((resolve,reject)=>{const req=indexedDB.open(vocalDbName,1);req.onupgradeneeded=()=>{if(!req.result.objectStoreNames.contains('takes'))req.result.createObjectStore('takes');};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});}
  async function vocalDbPut(id,blob){const db=await openVocalDb();return new Promise((resolve,reject)=>{const tx=db.transaction('takes','readwrite');tx.objectStore('takes').put(blob,id);tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>{db.close();reject(tx.error);};});}
  async function vocalDbGet(id){const db=await openVocalDb();return new Promise((resolve,reject)=>{const tx=db.transaction('takes','readonly'),req=tx.objectStore('takes').get(id);req.onsuccess=()=>{db.close();resolve(req.result||null);};req.onerror=()=>{db.close();reject(req.error);};});}
  async function vocalDbDelete(id){const db=await openVocalDb();return new Promise((resolve,reject)=>{const tx=db.transaction('takes','readwrite');tx.objectStore('takes').delete(id);tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>{db.close();reject(tx.error);};});}
  async function cloudAudioRequest(takeId,projectId,options={}){
    if(!core.loggedIn||!projectId)throw new Error('Sign in and save the project before cloud audio can sync.');
    const r=await fetch(`/api/audio/${encodeURIComponent(takeId)}?projectId=${encodeURIComponent(projectId)}`,{credentials:'same-origin',...options});
    if(!r.ok){let msg='Cloud audio request failed.';try{const d=await r.json();msg=d.error||msg;}catch{}throw new Error(msg);}return r;
  }
  async function uploadTakeToCloud(take,blob,projectId=core.currentProjectId){
    if(!blob||!core.loggedIn||!projectId)return false;
    await cloudAudioRequest(take.id,projectId,{method:'PUT',headers:{'Content-Type':'audio/wav'},body:blob});take.cloud=true;take.cloudProjectId=projectId;return true;
  }
  async function getTakeBlob(take,projectId=core.currentProjectId){
    let blob=await vocalDbGet(take.id).catch(()=>null);if(blob)return blob;
    if(core.loggedIn&&projectId){try{const r=await cloudAudioRequest(take.id,projectId);blob=await r.blob();await vocalDbPut(take.id,blob);take.cloud=true;take.cloudProjectId=projectId;return blob;}catch(e){console.warn('Cloud take unavailable',e);}}
    return null;
  }
  async function deleteTakeCloud(take,projectId=take.cloudProjectId||core.currentProjectId){if(!core.loggedIn||!projectId)return;try{await cloudAudioRequest(take.id,projectId,{method:'DELETE'});}catch(e){console.warn('Could not delete cloud take',e);}}
  async function syncCloudAudio(projectId=core.currentProjectId){
    if(!core.loggedIn||!projectId)return {uploaded:0,pending:0};let uploaded=0,pending=0,lastError=null;
    for(const p of parts.filter(x=>x.type==='vocal'))for(const take of p.recordings||[]){
      if(take.cloud&&take.cloudProjectId===projectId)continue;
      const blob=await vocalDbGet(take.id).catch(()=>null);if(!blob){pending++;continue;}
      try{await uploadTakeToCloud(take,blob,projectId);uploaded++;}
      catch(e){pending++;lastError=e;console.warn('Cloud audio sync failed',e);}
    }
    if(uploaded)core.scheduleAutoSave();
    if(lastError&&uploaded===0)throw lastError;
    return {uploaded,pending};
  }
  async function transcribeTake(p,take,{quiet=false}={}){
    if(!p||p.type!=='vocal'||!take)throw new Error('Choose a vocal take first.');
    if(!core.loggedIn)throw new Error('Sign in to use cloud transcription.');
    if(!core.currentProjectId)throw new Error('Save the project first so the vocal can be transcribed from cloud.');
    const blob=await getTakeBlob(take,core.currentProjectId);if(!blob)throw new Error('Vocal audio is unavailable.');
    if(!take.cloud||take.cloudProjectId!==core.currentProjectId){
      if(!quiet&&$('vocalSpeechStatus'))$('vocalSpeechStatus').textContent='Uploading dry WAV to cloud…';
      await uploadTakeToCloud(take,blob,core.currentProjectId);
    }
    if(!quiet&&$('vocalSpeechStatus'))$('vocalSpeechStatus').textContent='Transcribing vocal in the cloud…';
    const r=await fetch(`/api/transcribe/${encodeURIComponent(take.id)}?projectId=${encodeURIComponent(core.currentProjectId)}`,{method:'POST',credentials:'same-origin'});
    const data=await r.json().catch(()=>({}));if(!r.ok||!data.ok)throw new Error(data.error||`Transcription failed (${r.status})`);
    take.transcript=String(data.text||'').trim();take.transcriptWords=Array.isArray(data.words)?data.words:[];take.transcriptVtt=String(data.vtt||'');take.transcribedAt=new Date().toISOString();
    if(p.activeTakeId===take.id){p.transcript=take.transcript;p.transcriptWords=take.transcriptWords;if($('vocalTranscript'))$('vocalTranscript').value=p.transcript;}
    core.scheduleAutoSave();
    if($('vocalSpeechStatus'))$('vocalSpeechStatus').textContent=`Cloud transcript ready${take.transcriptWords?.length?' with word timing':''}. Edit anything it misheard.`;
    await renderVocalTakes(p);return data;
  }
  async function transcribeActiveTake(){const p=active();if(!p||p.type!=='vocal')return;const take=p.recordings?.find(r=>r.id===p.activeTakeId);if(!take){core.status('Record or choose a vocal take first.');return;}const btn=$('vocalTranscribeBtn');try{if(btn){btn.disabled=true;btn.textContent='Transcribing…';}await transcribeTake(p,take);core.status('Vocal transcript updated from the cloud recording.');}catch(e){console.error(e);if($('vocalSpeechStatus'))$('vocalSpeechStatus').textContent=e.message||'Could not transcribe this take.';core.status(e.message||'Could not transcribe this take.');}finally{if(btn){btn.disabled=false;btn.textContent='Transcribe active take';}}}
  function fmtTime(sec){sec=Math.max(0,Number(sec)||0);const m=Math.floor(sec/60),s=sec-m*60;return `${String(m).padStart(2,'0')}:${s.toFixed(1).padStart(4,'0')}`;}
  function renderVocalBacking(p){const box=$('vocalBackingParts');if(!box)return;const candidates=parts.filter(x=>x.id!==p.id&&(x.type==='chord'||x.type==='lead'));if(!Array.isArray(p.backingPartIds))p.backingPartIds=[];box.innerHTML='';candidates.forEach(x=>{const lab=document.createElement('label');lab.className='vocal-backing-item';const chk=document.createElement('input');chk.type='checkbox';chk.checked=p.backingPartIds.includes(x.id);chk.onchange=()=>{p.backingPartIds=candidates.filter(c=>box.querySelector(`[data-back-id="${c.id}"]`)?.checked).map(c=>c.id);core.scheduleAutoSave();};chk.dataset.backId=x.id;const span=document.createElement('span');span.textContent=x.name;lab.append(chk,span);box.appendChild(lab);});if(!candidates.length)box.innerHTML='<span class="subtle tiny">Add a Chord/Note or Lead/Bass part for a headphone backing track.</span>';}
  function paintAutotuneSlider(){const s=$('vocalFxAutotune');if(s)s.style.setProperty('--tune-fill',`${Math.max(0,Math.min(100,Number(s.value)||0))}%`);}
  async function renderVocalTakes(p){const box=$('vocalTakes');if(!box)return;box.innerHTML='';if(!p.recordings.length){box.innerHTML='<div class="vocal-empty">No takes yet. Put on headphones and tap Record.</div>';return;}for(const take of [...p.recordings].reverse()){const row=document.createElement('div');row.className='vocal-take'+(p.activeTakeId===take.id?' active':'');const main=document.createElement('div');main.className='vocal-take-main';main.innerHTML=`<div class="vocal-take-name">${escapeHtml(take.name||'Vocal take')}<span class="cloud-badge ${take.cloud?'':'pending'}">${take.cloud?'☁ Cloud':'Device'}</span></div><div class="vocal-take-meta">${fmtTime(take.duration)} • ${take.sampleRate||48000} Hz WAV • ${new Date(take.createdAt).toLocaleString()}</div>`;const use=document.createElement('button');use.type='button';use.className='take-use';use.textContent=p.activeTakeId===take.id?'Using':'Use';use.onclick=()=>{p.activeTakeId=take.id;p.transcript=take.transcript||'';p.transcriptWords=take.transcriptWords||[];renderVocalTakes(p);if($('vocalTranscript'))$('vocalTranscript').value=p.transcript||'';core.scheduleAutoSave();};const play=document.createElement('button');play.type='button';play.textContent='▶';play.title='Preview take';play.onclick=()=>previewTake(p,take,play);const dl=document.createElement('button');dl.type='button';dl.className='take-download';dl.textContent='↓ WAV';dl.onclick=()=>downloadTake(take);const del=document.createElement('button');del.type='button';del.className='take-delete';del.textContent='×';del.title='Delete take';del.onclick=async()=>{if(!confirm(`Delete “${take.name}”?`))return;stopPreview();await vocalDbDelete(take.id).catch(()=>{});await deleteTakeCloud(take);vocalBufferCache.delete(take.id);p.recordings=p.recordings.filter(r=>r.id!==take.id);for(const vp of allVocalParts())vp.voxEvents=(vp.voxEvents||[]).filter(e=>e.takeId!==take.id);if(p.activeTakeId===take.id)p.activeTakeId=p.recordings.at(-1)?.id||null;if(voxSelected&&voxSelected.eventId&&!(parts.find(x=>x.id===voxSelected.partId)?.voxEvents||[]).some(e=>e.id===voxSelected.eventId))voxSelected=null;renderVocalTakes(p);if(voxBoxOpen)renderVoxBox();markPartsDirty();core.scheduleAutoSave();core.flushAutoSaveNow?.();};row.append(main,use,play,dl,del);box.appendChild(row);}}
  function renderVocalEditor(p=active()){
    if(!p||p.type!=='vocal')return;$('vocalPartTitle').textContent=p.name;if($('vocalTranscript'))$('vocalTranscript').value=p.transcript||'';if($('vocalRepeat'))$('vocalRepeat').checked=p.repeat!==false;$('vocalVolume').value=Math.round(p.volume*100);$('vocalVolumeValue').textContent=`${Math.round(p.volume*100)}%`;renderVocalBacking(p);$('vocalBackingDrums').checked=p.backingDrums!==false;$('vocalBackingVolume').value=Math.round((p.backingVolume??.8)*100);$('vocalBackingVolumeValue').textContent=`${Math.round((p.backingVolume??.8)*100)}%`;$('vocalFxEq').value=p.fx?.eq||'clear';$('vocalFxComp').value=p.fx?.comp||'medium';$('vocalFxReverb').value=String(p.fx?.reverb??.12);$('vocalFxDelay').value=String(p.fx?.delay||0);if($('vocalFxAutotune'))$('vocalFxAutotune').value=String(Math.round(Number(p.fx?.autotune)||0));paintAutotuneSlider();if($('vocalFxAutotuneValue'))$('vocalFxAutotuneValue').textContent=`${Math.round(Number(p.fx?.autotune)||0)}%`;if($('vocalAutotuneKey'))$('vocalAutotuneKey').textContent=vocalAutotuneScale().label;renderVocalTakes(p);updatePartPlaybackButtons();
  }
  async function ensureMic(){
    if(micStream?.active)return micStream;if(!navigator.mediaDevices?.getUserMedia)throw new Error('Microphone recording is not available in this browser.');
    micStream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,sampleRate:{ideal:48000},sampleSize:{ideal:24},echoCancellation:false,noiseSuppression:false,autoGainControl:false}});
    micCtx=new (window.AudioContext||window.webkitAudioContext)({sampleRate:48000});recordSampleRate=micCtx.sampleRate;micSource=micCtx.createMediaStreamSource(micStream);micAnalyser=micCtx.createAnalyser();micAnalyser.fftSize=1024;micAnalyser.smoothingTimeConstant=.72;micSource.connect(micAnalyser);startMicMeter();const track=micStream.getAudioTracks()[0];const st=track.getSettings?.()||{};$('vocalMicInfo').textContent=`${track.label||'Phone microphone'} • ${st.sampleRate||recordSampleRate} Hz${st.channelCount?` • ${st.channelCount} ch`:''}`;if($('vocalArmMic')){$('vocalArmMic').textContent='Mic test off';$('vocalArmMic').setAttribute('aria-pressed','true');}return micStream;
  }
  async function disableMic(){
    if(recording)return;cancelAnimationFrame(micMeterRaf);micMeterRaf=0;try{micSource?.disconnect();}catch{}try{micAnalyser?.disconnect();}catch{}for(const t of micStream?.getTracks?.()||[])try{t.stop();}catch{}micStream=null;micSource=null;micAnalyser=null;try{await micCtx?.close();}catch{}micCtx=null;if($('vocalMicMeter'))$('vocalMicMeter').style.width='0%';if($('vocalMicDb'))$('vocalMicDb').textContent='— dB';if($('vocalMicInfo'))$('vocalMicInfo').textContent='Mic test off.';if($('vocalArmMic')){$('vocalArmMic').textContent='Mic check';$('vocalArmMic').setAttribute('aria-pressed','false');}
  }
  function startMicMeter(){cancelAnimationFrame(micMeterRaf);const data=new Float32Array(micAnalyser?.fftSize||1024);const tick=()=>{if(!micAnalyser)return;micAnalyser.getFloatTimeDomainData(data);let sum=0,peak=0;for(const v of data){sum+=v*v;peak=Math.max(peak,Math.abs(v));}const rms=Math.sqrt(sum/data.length),db=rms>0?20*Math.log10(rms):-90,pct=Math.max(0,Math.min(100,(db+60)/60*100));if($('vocalMicMeter'))$('vocalMicMeter').style.width=`${pct}%`;if($('vocalMicDb'))$('vocalMicDb').textContent=db<=-89?'— dB':`${db.toFixed(1)} dB`;micMeterRaf=requestAnimationFrame(tick);};tick();}
  function startSpeechToText(p){
    const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
    if(!SR){if($('vocalSpeechStatus'))$('vocalSpeechStatus').textContent='Live transcription is not supported by this browser. You can still edit the transcript manually.';return;}
    try{
      speechRec=new SR();speechRec.continuous=true;speechRec.interimResults=true;speechRec.lang='en-US';speechBase=(p.transcript||'').trim();let committed='';
      if($('vocalSpeechStatus'))$('vocalSpeechStatus').textContent='Listening for lyrics…';
      speechRec.onresult=e=>{let interim='';for(let i=e.resultIndex;i<e.results.length;i++){const t=(e.results[i][0]?.transcript||'').trim();if(!t)continue;if(e.results[i].isFinal)committed+=(committed?' ':'')+t;else interim+=(interim?' ':'')+t;}const text=[speechBase,committed,interim].filter(Boolean).join(' ').replace(/\s+/g,' ').trim();p.transcript=text;if($('vocalTranscript'))$('vocalTranscript').value=text;};
      speechRec.onerror=e=>{if($('vocalSpeechStatus'))$('vocalSpeechStatus').textContent=`Transcription: ${e.error||'unavailable'}. Recording is still safe.`;};
      speechRec.onend=()=>{if(recording&&speechRec){try{speechRec.start();}catch{}}else if($('vocalSpeechStatus'))$('vocalSpeechStatus').textContent=p.transcript?.trim()?'Transcript captured — edit anything it misheard.':'No speech was transcribed — you can type/edit lyrics below.';};
      speechRec.start();
    }catch(e){console.warn('Speech recognition unavailable',e);if($('vocalSpeechStatus'))$('vocalSpeechStatus').textContent='Live transcription could not start. Recording is unaffected.';}
  }
  function stopSpeechToText(){try{speechRec?.stop();}catch{}speechRec=null;}
  function floatToWav(chunks,sampleRate){let length=chunks.reduce((n,a)=>n+a.length,0),samples=new Float32Array(length),o=0;for(const a of chunks){samples.set(a,o);o+=a.length;}const buffer=new ArrayBuffer(44+samples.length*2),view=new DataView(buffer),write=(off,str)=>{for(let i=0;i<str.length;i++)view.setUint8(off+i,str.charCodeAt(i));};write(0,'RIFF');view.setUint32(4,36+samples.length*2,true);write(8,'WAVE');write(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,sampleRate,true);view.setUint32(28,sampleRate*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);write(36,'data');view.setUint32(40,samples.length*2,true);let p=44;for(let i=0;i<samples.length;i++){let x=Math.max(-1,Math.min(1,samples[i]));view.setInt16(p,x<0?x*0x8000:x*0x7fff,true);p+=2;}return new Blob([buffer],{type:'audio/wav'});}
  async function beginRecording(options={}){
    const requestedPartId=options?.partId||null;
    if(requestedPartId){const rp=parts.find(x=>x.type==='vocal'&&String(x.id)===String(requestedPartId));if(rp)activePartId=rp.id;}
    const p=active();if(!p||p.type!=='vocal'||recording)return;
    const fromBeat=Math.max(0,Number(options?.fromBeat)||0);
    const fromVox=!!options?.voxBox;
    try{
      stopPreview();await ensureMic();window.CRPParts?.stopPlayback?.();
      recordChunks=[];recordInsertBeat=fromBeat;recordTargetPartId=p.id;recordStartedFromVox=fromVox;recordResumeBeat=fromBeat;
      micProcessor=micCtx.createScriptProcessor(4096,1,1);micSilentGain=micCtx.createGain();micSilentGain.gain.value=0;micSource.connect(micProcessor);micProcessor.connect(micSilentGain);micSilentGain.connect(micCtx.destination);
      micProcessor.onaudioprocess=e=>{if(recording&&!recordingPaused)recordChunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));};
      recording=true;recordingPaused=false;recordPausedAt=0;recordPausedTotal=0;recordStartedAt=performance.now();
      if($('vocalSpeechStatus'))$('vocalSpeechStatus').textContent='Recording clean WAV. Cloud transcription runs after the take is saved.';
      if($('vocalRecordBtn')){$('vocalRecordBtn').classList.add('recording');$('vocalRecordBtn').disabled=true;}
      if($('vocalStopBtn'))$('vocalStopBtn').disabled=false;
      recordTimer=setInterval(()=>{const now=recordingPaused?recordPausedAt:performance.now();if($('vocalTimer'))$('vocalTimer').textContent=fmtTime(Math.max(0,(now-recordStartedAt-recordPausedTotal)/1000));updateVoxTransportState();},100);
      const oldStates=new Map(parts.map(x=>[x.id,x.enabled]));p._recordOldStates=oldStates;p._recordOldVolumes=new Map(parts.map(x=>[x.id,x.volume]));
      parts.forEach(x=>{if(x.type==='chord'||x.type==='lead'){x.enabled=p.backingPartIds.includes(x.id);x.volume=(p._recordOldVolumes.get(x.id)??x.volume)*(p.backingVolume??.8);}});
      const drumToggle=$('crpDrumsToggle');if(drumToggle){p._recordOldDrums=drumToggle.checked;drumToggle.checked=p.backingDrums!==false;drumToggle.dispatchEvent(new Event('change'));}
      const drumVol=$('crpDrumVolume');if(drumVol){p._recordOldDrumVol=drumVol.value;drumVol.value=String(Math.round(+drumVol.value*(p.backingVolume??.8)));drumVol.dispatchEvent(new Event('input'));}
      renderParts();
      setTimeout(()=>{if(recording)startPlayback({fromBeat:recordInsertBeat});},80);
      if(fromVox){voxTargetPartId=p.id;updateVoxPlayhead(recordInsertBeat,true);voxStatus(`Recording into ${p.name} from beat ${recordInsertBeat.toFixed(2)}…`);}
      core.status('Recording dry WAV. Use headphones so the backing does not bleed into the mic.');updateVoxTransportState();
    }catch(e){console.error(e);core.status(e.message||'Could not start microphone.');recordStartedFromVox=false;recordTargetPartId=null;}
  }
  async function endRecording(){
    const p=parts.find(x=>x.type==='vocal'&&String(x.id)===String(recordTargetPartId))||active();if(!p||p.type!=='vocal'||!recording)return;
    const wasVox=recordStartedFromVox,insertBeat=recordInsertBeat;
    if(recordingPaused&&recordPausedAt){recordPausedTotal+=performance.now()-recordPausedAt;}recordingPaused=false;recordPausedAt=0;recording=false;stopSpeechToText();clearInterval(recordTimer);recordTimer=null;
    if($('vocalRecordBtn')){$('vocalRecordBtn').classList.remove('recording');$('vocalRecordBtn').disabled=false;}
    if($('vocalStopBtn'))$('vocalStopBtn').disabled=true;
    window.CRPParts?.stopPlayback?.();micProcessor?.disconnect();micSilentGain?.disconnect();if(micProcessor)micProcessor.onaudioprocess=null;micProcessor=null;micSilentGain=null;
    if(p._recordOldStates){for(const x of parts)x.enabled=p._recordOldStates.get(x.id)??x.enabled;delete p._recordOldStates;}if(p._recordOldVolumes){for(const x of parts)x.volume=p._recordOldVolumes.get(x.id)??x.volume;delete p._recordOldVolumes;}
    const drumToggle=$('crpDrumsToggle');if(drumToggle&&p._recordOldDrums!==undefined){drumToggle.checked=p._recordOldDrums;drumToggle.dispatchEvent(new Event('change'));delete p._recordOldDrums;}
    const drumVol=$('crpDrumVolume');if(drumVol&&p._recordOldDrumVol!==undefined){drumVol.value=p._recordOldDrumVol;drumVol.dispatchEvent(new Event('input'));delete p._recordOldDrumVol;}
    renderParts();const duration=Math.max(0,(performance.now()-recordStartedAt-recordPausedTotal)/1000);if($('vocalTimer'))$('vocalTimer').textContent=fmtTime(duration);
    if(duration<.25||!recordChunks.length){core.status('Recording was too short.');recordStartedFromVox=false;recordTargetPartId=null;updateVoxTransportState();return;}
    const blob=floatToWav(recordChunks,recordSampleRate),id=uid(),take={id,name:`Take ${p.recordings.length+1}`,createdAt:new Date().toISOString(),duration,sampleRate:recordSampleRate,size:blob.size};
    try{
      await vocalDbPut(id,blob);vocalBufferCache.delete(id);p.recordings.push(take);p.activeTakeId=id;
      if(wasVox){
        voxCheckpoint();
        p.voxEvents=p.voxEvents||[];
        const ev=normalizeVoxEvent({id:uid(),takeId:id,sourcePartId:p.id,startBeat:quantizeVoxBeat(insertBeat),trimStartSec:0,trimEndSec:null,volume:1,fx:null},p);
        p.voxEvents.push(ev);voxSelections=[{partId:p.id,eventId:ev.id}];voxSelected=voxSelections[0];voxTargetPartId=p.id;voxInstrumentSelections=[];voxInstrumentSelection=null;
      }else if(!(p.voxEvents||[]).length)ensureVoxEventForActiveTake(p,0);
      p.transcript='';p.transcriptWords=[];markPartsDirty();core.scheduleAutoSave();await renderVocalTakes(p);
      if(voxBoxOpen){renderVoxBox();updateVoxPlayhead(insertBeat,true);voxStatus(`${take.name} recorded onto ${p.name} at beat ${insertBeat.toFixed(2)}.`);}
      if(core.loggedIn&&core.currentProjectId){try{if($('vocalSpeechStatus'))$('vocalSpeechStatus').textContent='Uploading and transcribing new take…';await uploadTakeToCloud(take,blob,core.currentProjectId);await transcribeTake(p,take,{quiet:true});core.status(`Saved ${take.name} to cloud and transcribed it.`);}catch(te){console.warn('Automatic cloud transcription pending',te);if($('vocalSpeechStatus'))$('vocalSpeechStatus').textContent=`Take is safe. ${te.message||'Tap Transcribe active take after saving.'}`;core.status(`Saved ${take.name}. Cloud transcription can be retried with Transcribe active take.`);}}else{if($('vocalSpeechStatus'))$('vocalSpeechStatus').textContent='Take is safe. Save/sign in, then tap Transcribe active take.';core.status(core.loggedIn?`Saved ${take.name} locally. Save the project to enable cloud transcription.`:`Saved ${take.name} locally. Sign in and save to use cloud transcription.`);}
    }catch(e){console.error(e);core.status('Take was recorded but could not be stored on this device.');}
    finally{recordStartedFromVox=false;recordTargetPartId=null;recordInsertBeat=0;recordResumeBeat=0;updateVoxTransportState();}
  }
  function toggleRecordingPause(){
    if(!recording)return false;
    if(!recordingPaused){
      recordResumeBeat=currentCycleBeat()??voxPlayheadBeat??recordResumeBeat??0;
      if(recordStartedFromVox)updateVoxPlayhead(recordResumeBeat,false);
      recordingPaused=true;recordPausedAt=performance.now();
      try{window.CRPParts?.stopPlayback?.();}catch{}
      core.status('Recording paused.');
    }else{
      if(recordPausedAt)recordPausedTotal+=performance.now()-recordPausedAt;
      recordingPaused=false;recordPausedAt=0;
      setTimeout(()=>{if(recording&&!recordingPaused)startPlayback({fromBeat:Math.max(0,Number(recordResumeBeat)||0)});},60);
      core.status('Recording resumed.');
    }
    updateVoxTransportState();
    return recordingPaused;
  }

  async function downloadTake(take){const blob=await getTakeBlob(take);if(!blob){core.status('This take audio is not available on this device or cloud.');return;}const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`${(take.name||'vocal-take').replace(/[^a-z0-9_-]+/gi,'-')}.wav`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),3000);}
  function stopPreview(){if(currentPreview){try{currentPreview.source?.stop();currentPreview.audio?.pause();}catch{}try{currentPreview.ctx?.close();}catch{}currentPreview=null;}}
  function impulse(ctx,seconds=.9,decay=2.4){const length=Math.floor(ctx.sampleRate*seconds),b=ctx.createBuffer(2,length,ctx.sampleRate);for(let c=0;c<2;c++){const d=b.getChannelData(c);for(let i=0;i<length;i++)d[i]=(Math.random()*2-1)*Math.pow(1-i/length,decay);}return b;}
  async function previewTake(p,take,btn){
    stopPreview();
    const blob=await getTakeBlob(take);if(!blob){core.status('This take audio is not available on this device or cloud.');return;}
    const ctx=new (window.AudioContext||window.webkitAudioContext)(),buf=await ctx.decodeAudioData(await blob.arrayBuffer()),src=ctx.createBufferSource(),eq=ctx.createBiquadFilter(),comp=ctx.createDynamicsCompressor(),dry=ctx.createGain(),wet=ctx.createGain(),rev=ctx.createConvolver(),delay=ctx.createDelay(1),delayGain=ctx.createGain(),out=ctx.createGain();
    src.buffer=buf;const fx=p.fx||{};
    if(Number(fx.autotune)>0)await ensureAutotuneWorklet(ctx);
    eq.type=fx.eq==='warm'?'lowshelf':fx.eq==='bright'?'highshelf':'peaking';eq.frequency.value=fx.eq==='warm'?180:fx.eq==='bright'?4500:2800;eq.gain.value=fx.eq==='flat'?0:fx.eq==='warm'?2:fx.eq==='bright'?2.5:1.5;
    const c=fx.comp||'medium';comp.threshold.value=c==='off'?0:c==='light'?-12:c==='heavy'?-24:-18;comp.ratio.value=c==='off'?1:c==='light'?2:c==='heavy'?6:3.5;comp.attack.value=.008;comp.release.value=.12;
    dry.gain.value=1;wet.gain.value=Number(fx.reverb||0);rev.buffer=impulse(ctx,fx.reverb>.25?1.6:fx.reverb>.15?1.1:.7);delay.delayTime.value=Number(fx.delay||0);delayGain.gain.value=fx.delay?0.22:0;out.gain.value=p.volume;
    const tune=makeAutotuneNode(ctx,p);src.connect(eq);eq.connect(comp);const post=tune||comp;if(tune)comp.connect(tune);post.connect(dry);dry.connect(out);post.connect(rev);rev.connect(wet);wet.connect(out);post.connect(delay);delay.connect(delayGain);delayGain.connect(out);out.connect(ctx.destination);
    src.start();currentPreview={ctx,source:src};src.onended=()=>{try{ctx.close();}catch{}if(currentPreview?.source===src)currentPreview=null;};
  }

  function partDurationBeats(p){
    if(p.type==='chord')return (p.data?.rows||[]).flat().reduce((n,c)=>n+(core.cardDurationBeats?.(c,core.beats)||core.beats),0);
    if(p.type==='lead')return p.bars*4;
    return 0;
  }
  function enabledPlayable(){
    const base=parts.filter(p=>(p.type==='chord'||p.type==='lead')&&partDurationBeats(p)>0);
    if(playbackScope){
      const ids=new Set(playbackScope.playableIds||[]);
      return base.filter(p=>ids.has(p.id));
    }
    return base.filter(p=>p.enabled);
  }
  function enabledVocals(){
    const base=parts.filter(p=>p.type==='vocal'&&vocalHasPlayableAudio(p));
    if(playbackScope){
      const ids=new Set(playbackScope.vocalIds||[]);
      return base.filter(p=>ids.has(p.id));
    }
    return base.filter(p=>p.enabled);
  }
  function vocalDurationBeats(p){
    const events=voxTrackEvents(p);
    if(events.length)return Math.max(0,...events.map(e=>(Number(e.startBeat)||0)+voxEventDurationBeats(e)));
    const t=p.recordings?.find(r=>r.id===p.activeTakeId);return t?Math.max(0,(Number(t.duration)||0)*core.bpm/60):0;
  }

  function naturalSongDurationBeats(){
    const musical=parts.filter(p=>p.type==='chord'||p.type==='lead').map(partDurationBeats);
    const vocals=parts.filter(p=>p.type==='vocal').map(vocalDurationBeats);
    const drums=Math.max(0,Number(window.CRPBeatMaker?.getDurationBeats?.()||0));
    return Math.max(0,...musical,...vocals,drums);
  }
  function effectiveSongEndBeats(natural){
    const n=Math.max(0,Number(natural)||0);
    const custom=Number(songEndBeat);
    return Number.isFinite(custom)&&custom>0?Math.max(.05,Math.min(n,custom)):n;
  }
  function songEndSeconds(beats){
    const bpm=Math.max(40,Math.min(240,Number(core.bpm)||92));
    return Math.max(0,Number(beats)||0)*60/bpm;
  }
  function formatSongTime(seconds){
    const s=Math.max(0,Number(seconds)||0),m=Math.floor(s/60),r=s-m*60;
    return `${String(m).padStart(2,'0')}:${r.toFixed(1).padStart(4,'0')}`;
  }
  function currentCycleBeat(){
    if(!(playing||starting)||!audioCtx||!playbackClockStartAudioTime||!playbackTotalBeats)return null;
    const bpm=Math.max(40,Math.min(240,+playbackClockBpm||+core.bpm||92)),beatSec=60/bpm;
    let beat=(playbackClockStartBeat||0)+Math.max(0,audioCtx.currentTime-playbackClockStartAudioTime)/beatSec;
    if(playbackTotalBeats>0)beat=((beat%playbackTotalBeats)+playbackTotalBeats)%playbackTotalBeats;
    return beat;
  }
  function songEndBarBeats(){ return 4; }
  function snappedSongEndBeat(value,natural){
    const n=Math.max(.05,Number(natural)||.05),v=Math.max(.05,Math.min(n,Number(value)||n));
    if(!songEndSnapToBar)return v;
    const bar=songEndBarBeats();
    const maxBar=Math.floor(n/bar)*bar;
    let snapped=Math.round(v/bar)*bar;
    if(snapped<bar)snapped=Math.min(bar,n);
    if(maxBar>0)snapped=Math.min(maxBar,snapped);
    if(n-maxBar>1e-5 && Math.abs(v-n)<Math.abs(v-snapped))snapped=n;
    return Math.max(.05,Math.min(n,snapped));
  }
  function renderSongEndTicks(natural){
    const box=$('songEndBarTicks');if(!box)return;
    const n=Math.max(0,Number(natural)||0),bar=songEndBarBeats(),key=`${n.toFixed(4)}:${bar}`;
    if(box.dataset.tickKey===key)return;
    box.dataset.tickKey=key;box.innerHTML='';
    if(n<=0)return;
    for(let b=bar;b<n-1e-5;b+=bar){const mark=document.createElement('span');mark.style.left=`${(b/n)*100}%`;box.appendChild(mark);}
  }
  function renderSongEndEditor(){
    const box=$('songEndEditor');if(!box)return;
    const natural=naturalSongDurationBeats(),custom=Number.isFinite(Number(songEndBeat))&&Number(songEndBeat)>0;
    const end=custom?effectiveSongEndBeats(natural):natural;
    const endLabel=custom?formatSongTime(songEndSeconds(end)):'Full song';
    if($('songEndValue'))$('songEndValue').textContent=endLabel;
    if($('songEndSummaryValue'))$('songEndSummaryValue').textContent=endLabel;
    const playhead=currentCycleBeat();
    if($('songPlayheadValue'))$('songPlayheadValue').textContent=`Playhead ${formatSongTime(songEndSeconds(playhead??mediaPausedBeat??0))}`;
    if($('songEndMinusBtn'))$('songEndMinusBtn').disabled=natural<=0;
    if($('songEndPlusBtn'))$('songEndPlusBtn').disabled=natural<=0;
    if($('songEndClearBtn'))$('songEndClearBtn').disabled=!custom;
    const slider=$('songEndSlider');
    if(slider){
      slider.disabled=natural<=0;
      slider.min='0.05';slider.max=String(Math.max(.05,natural));slider.step='0.01';
      const value=Math.max(.05,Math.min(Math.max(.05,natural),custom?end:Math.max(.05,natural)));
      if(document.activeElement!==slider)slider.value=String(value);
      const pct=natural>0?(value/natural)*100:100;slider.style.setProperty('--song-end-progress',`${Math.max(0,Math.min(100,pct))}%`);
    }
    if($('songEndSnapBar'))$('songEndSnapBar').checked=!!songEndSnapToBar;
    renderSongEndTicks(natural);
    if(!(playing||starting))updateMediaPosition();
  }
  function setSongEndPanelOpen(open,persist=true){
    const panel=$('songEndPanel'),editor=$('songEndEditor'),btn=$('songEndToggleBtn');
    if(!panel||!editor||!btn)return;
    const on=!!open;
    panel.classList.toggle('is-open',on);
    editor.hidden=!on;
    btn.setAttribute('aria-expanded',String(on));
    if(persist){try{localStorage.setItem(SONG_END_OPEN_KEY,on?'1':'0')}catch{}}
  }
  function initSongEndPanel(){
    let open=false;
    try{open=localStorage.getItem(SONG_END_OPEN_KEY)==='1';songEndSnapToBar=localStorage.getItem(SONG_END_SNAP_KEY)!=='0';}catch{}
    setSongEndPanelOpen(open,false);
    const btn=$('songEndToggleBtn');
    if(btn)btn.onclick=()=>setSongEndPanelOpen(btn.getAttribute('aria-expanded')!=='true');
  }
  function setSongEndFromSlider(value,save=true){
    const natural=naturalSongDurationBeats();if(natural<=0)return;
    songEndBeat=snappedSongEndBeat(value,natural);
    markPartsDirty();renderSongEndEditor();
    liveEditRefresh();
    if(save)core.scheduleAutoSave();
  }
  function nudgeSongEnd(seconds){
    const natural=naturalSongDurationBeats();if(natural<=0)return;
    const bpm=Math.max(40,Math.min(240,Number(core.bpm)||92));
    const base=Number.isFinite(Number(songEndBeat))&&Number(songEndBeat)>0?Number(songEndBeat):natural;
    // +/-0.1s is always a true fine adjustment, even when Snap to Bar is checked.
    songEndBeat=Math.max(.05,Math.min(natural,base+Number(seconds||0)*bpm/60));
    markPartsDirty();renderSongEndEditor();liveEditRefresh();core.scheduleAutoSave();
  }
  function clearSongEnd(){songEndBeat=null;markPartsDirty();renderSongEndEditor();liveEditRefresh();core.scheduleAutoSave();core.status('Song end restored to the full project.');}

  function makeMediaCarrierWavUrl(){
    try{
      // Android/Chrome is much more reliable about publishing Media Session controls
      // for a real, long-form HTMLMediaElement than for a 1-second silent loop.
      // This 30-second mono WAV contains an effectively inaudible low-level tone.
      const rate=8000,seconds=30,samples=rate*seconds,buffer=new ArrayBuffer(44+samples*2),view=new DataView(buffer),write=(o,s)=>{for(let i=0;i<s.length;i++)view.setUint8(o+i,s.charCodeAt(i));};
      write(0,'RIFF');view.setUint32(4,36+samples*2,true);write(8,'WAVE');write(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,rate,true);view.setUint32(28,rate*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);write(36,'data');view.setUint32(40,samples*2,true);
      for(let i=0;i<samples;i++){const sample=Math.round(Math.sin(2*Math.PI*37*i/rate)*18);view.setInt16(44+i*2,sample,true);}
      return URL.createObjectURL(new Blob([buffer],{type:'audio/wav'}));
    }catch{return '';}
  }
  function ensureMediaSession(){
    if(!('mediaSession' in navigator))return false;
    try{
      if(!mediaKeepAlive){
        mediaKeepAliveUrl=makeMediaCarrierWavUrl();
        mediaKeepAlive=document.createElement('audio');
        mediaKeepAlive.id='crpMediaSessionCarrier';
        mediaKeepAlive.src=mediaKeepAliveUrl;
        mediaKeepAlive.loop=true;mediaKeepAlive.preload='auto';mediaKeepAlive.volume=.001;mediaKeepAlive.playsInline=true;
        mediaKeepAlive.setAttribute('playsinline','');mediaKeepAlive.setAttribute('aria-hidden','true');
        mediaKeepAlive.style.cssText='position:fixed;width:1px;height:1px;opacity:.001;pointer-events:none;left:-10px;bottom:0;';
        document.body.appendChild(mediaKeepAlive);
        mediaKeepAlive.load();
        mediaKeepAlive.addEventListener('loadedmetadata',()=>updateMediaPosition());
      }
      if(!mediaActionsInstalled){
        const set=(name,fn)=>{try{navigator.mediaSession.setActionHandler(name,fn);}catch{}};
        set('play',()=>{audioCtx?.resume?.().catch(()=>{});mediaKeepAlive?.play?.().catch(()=>{});if(!(playing||starting))startPlayback({fromBeat:Math.max(0,mediaPausedBeat||0)});});
        set('pause',()=>{const b=currentCycleBeat();if(Number.isFinite(b))mediaPausedBeat=b;stopPlayback({mediaPause:true});});
        set('stop',()=>{mediaPausedBeat=0;stopPlayback();});
        set('seekbackward',d=>seekPlaybackSeconds(-Math.max(1,Number(d?.seekOffset)||5)));
        set('seekforward',d=>seekPlaybackSeconds(Math.max(1,Number(d?.seekOffset)||5)));
        set('seekto',d=>{if(Number.isFinite(Number(d?.seekTime)))seekPlaybackToSeconds(Number(d.seekTime));});
        set('previoustrack',()=>seekPlaybackToSeconds(0));
        mediaActionsInstalled=true;
      }
      return true;
    }catch(e){console.warn('Media Session unavailable',e);return false;}
  }
  function updateMediaMetadata(){
    if(!ensureMediaSession())return;
    try{navigator.mediaSession.metadata=new MediaMetadata({title:core.projectName||'Song Rider Suite',artist:'Song Rider Suite',album:'Baby DAW',artwork:[{src:new URL('assets/icon-192.png',location.href).href,sizes:'192x192',type:'image/png'}]});}catch{}
  }
  function mediaDurationBeats(){const natural=naturalSongDurationBeats();return Math.max(.05,effectiveSongEndBeats(natural)||natural||.05);}
  function updateMediaPosition(){
    if(!('mediaSession' in navigator)||typeof navigator.mediaSession.setPositionState!=='function')return;
    try{
      const totalBeats=Math.max(.05,playbackTotalBeats||mediaDurationBeats()),bpm=Math.max(40,Math.min(240,+playbackClockBpm||+core.bpm||92)),duration=Math.max(.1,totalBeats*60/bpm);
      const beat=(playing||starting)?(currentCycleBeat()??playbackClockStartBeat??0):Math.max(0,mediaPausedBeat||0),position=Math.max(0,Math.min(duration-.001,beat*60/bpm));
      navigator.mediaSession.setPositionState({duration,playbackRate:1,position});
    }catch{}
  }
  function setMediaPlaying(on){
    if(!ensureMediaSession())return;
    updateMediaMetadata();
    try{navigator.mediaSession.playbackState=on?'playing':'paused';}catch{}
    if(on){try{mediaKeepAlive?.play?.().catch(()=>{});}catch{}clearInterval(mediaPositionTimer);mediaPositionTimer=setInterval(updateMediaPosition,350);}else{try{mediaKeepAlive?.pause?.();}catch{}clearInterval(mediaPositionTimer);mediaPositionTimer=null;}
    updateMediaPosition();
  }
  function seekPlaybackToBeat(beat){
    const total=mediaDurationBeats(),target=Math.max(0,Math.min(Math.max(0,total-.001),Number(beat)||0));mediaPausedBeat=target;
    // Publish the requested position immediately.  A live seek restarts the
    // scheduler from this beat; keeping the clock pinned here while cached
    // players prepare prevents the UI/SRP bridge from flashing back to beat 1.
    playbackClockStartBeat=target;
    if(playing||starting){const scope=playbackScope?clone(playbackScope):null;startPlayback({scope,fromBeat:target,preserveUi:true,liveRestart:true});}
    else updateMediaPosition();
  }
  function seekPlaybackToSeconds(seconds){const bpm=Math.max(40,Math.min(240,+core.bpm||92));seekPlaybackToBeat(Math.max(0,Number(seconds)||0)*bpm/60);}
  function seekPlaybackSeconds(delta){const bpm=Math.max(40,Math.min(240,+core.bpm||92)),base=(playing||starting)?(currentCycleBeat()??0):(mediaPausedBeat||0);seekPlaybackToBeat(base+(Number(delta)||0)*bpm/60);}
  function requestedPartSound(p){
    return p?.type==='chord'?p?.data?.sound:p?.sound;
  }
  function outputSoundFor(p){
    const requested=requestedPartSound(p);
    if(playing||starting){
      const ready=lastReadyPlayer.get(p?.id);
      if(ready?.sound)return ready.sound;
    }
    return requested;
  }
  function desiredPartGain(p,soundOverride=null){
    const scopeGain=playbackScope&&Array.isArray(playbackScope.playableIds)&&playbackScope.playableIds.includes(p.id)?Math.max(0,Math.min(1,Number(playbackScope.backingGain??1))):1;
    return soundGain(soundOverride||requestedPartSound(p))*p.volume*(p.type==='lead'?LEAD_OUTPUT_BOOST:1)*scopeGain;
  }
  function applyVocalFxLive(p){
    const set=liveVocalFxNodes.get(p?.id);if(!set?.size||!audioCtx)return;
    const now=audioCtx.currentTime,scale=vocalAutotuneScale();
    for(const item of [...set]){
      const n=item.nodes;if(!n)continue;
      const ev=item.eventId?(p.voxEvents||[]).find(e=>String(e.id)===String(item.eventId)):null;
      const fx=effectiveVocalFx(p,ev);
      const clipVolume=ev?Math.max(0,Math.min(1.5,Number(ev.volume)||0)):1;
      try{
        n.eq.type=fx.eq==='warm'?'lowshelf':fx.eq==='bright'?'highshelf':'peaking';
        n.eq.frequency.setTargetAtTime(fx.eq==='warm'?180:fx.eq==='bright'?4500:2800,now,.02);
        n.eq.gain.setTargetAtTime(fx.eq==='flat'?0:fx.eq==='warm'?2:fx.eq==='bright'?2.5:1.5,now,.02);
        const c=fx.comp||'medium';
        n.comp.threshold.setTargetAtTime(c==='off'?0:c==='light'?-12:c==='heavy'?-24:-18,now,.02);
        n.comp.ratio.setTargetAtTime(c==='off'?1:c==='light'?2:c==='heavy'?6:3.5,now,.02);
        n.wet.gain.setTargetAtTime(Number(fx.reverb||0),now,.03);
        n.delay.delayTime.setTargetAtTime(Number(fx.delay||0),now,.03);
        n.delayGain.gain.setTargetAtTime(fx.delay?0.22:0,now,.03);
        n.out.gain.setTargetAtTime(Math.max(0,Math.min(1.5,(Number(p.volume)||0)*clipVolume)),now,.025);
        n.tune?.port?.postMessage({amount:Math.max(0,Math.min(100,Number(fx.autotune)||0)),allowedPcs:scale.allowedPcs||[]});
      }catch{}
    }
  }
  function liveEditRefresh(){
    clearTimeout(liveEditTimer);
    liveEditTimer=setTimeout(()=>{
      syncLoadedChord();
      const now=audioCtx?.currentTime||0;
      for(const p of parts){
        const bus=partBuses.get(p.id);
        if(bus&&audioCtx){try{if(typeof bus.gain.cancelAndHoldAtTime==='function')bus.gain.cancelAndHoldAtTime(now);else bus.gain.cancelScheduledValues(now);bus.gain.setTargetAtTime(desiredPartGain(p,outputSoundFor(p)),now,.028);}catch{}}
        if(p.type==='vocal')applyVocalFxLive(p);
      }
      if(playing||starting){
        const beat=currentCycleBeat();
        if(Number.isFinite(beat)&&audioCtx){playbackClockStartBeat=beat;playbackClockStartAudioTime=audioCtx.currentTime;playbackClockBpm=Math.max(40,Math.min(240,+core.bpm||92));}
        playbackTotalBeats=mediaDurationBeats();
      }
      updateMediaMetadata();updateMediaPosition();
    },24);
  }
  function ensureAudio(){
    if(!audioCtx){
      audioCtx=new (window.AudioContext||window.webkitAudioContext)();
      audioCtx.addEventListener?.('statechange',()=>{
        if((playing||starting)&&audioCtx?.state==='suspended'){audioCtx.resume().catch(()=>{});} 
      });
    }
    if(audioCtx.state==='suspended')audioCtx.resume().catch(()=>{});
    if(!masterLimiter){masterLimiter=audioCtx.createDynamicsCompressor();masterLimiter.threshold.value=-2;masterLimiter.knee.value=0;masterLimiter.ratio.value=20;masterLimiter.attack.value=.003;masterLimiter.release.value=.12;masterLimiter.connect(audioCtx.destination);}
  }
  function ensurePartBus(p){
    ensureAudio();let bus=partBuses.get(p.id),fresh=false;
    if(!bus){
      bus=audioCtx.createGain();
      const fx=core.createInstrumentFxChain?.(audioCtx,masterLimiter);
      if(fx){bus.connect(fx.input);partInstrumentFx.set(p.id,fx);}else bus.connect(masterLimiter);
      partBuses.set(p.id,bus);fresh=true;
    }
    return {bus,fresh};
  }
  function busFor(p,soundOverride=null){
    const {bus,fresh}=ensurePartBus(p),sound=soundOverride||requestedPartSound(p);
    partInstrumentFx.get(p.id)?.setSound?.(sound);
    const target=desiredPartGain(p,sound),now=audioCtx.currentTime;
    try{
      if(fresh||!(playing||starting))bus.gain.value=target;
      else{if(typeof bus.gain.cancelAndHoldAtTime==='function')bus.gain.cancelAndHoldAtTime(now);else bus.gain.cancelScheduledValues(now);bus.gain.setTargetAtTime(target,now,.032);}
    }catch{bus.gain.value=target;}
    return bus;
  }
  async function playerFor(p,{forceCurrent=false}={}){
    ensureAudio();
    const sound=requestedPartSound(p),key=`${p.id}:${sound}`;
    if(resolvedPlayerCache.has(key)){
      const ready=resolvedPlayerCache.get(key);
      lastReadyPlayer.set(p.id,{sound,player:ready});
      return ready;
    }
    if(!window.Soundfont)throw new Error('Sound engine unavailable');

    let promise=playerCache.get(key);
    if(!promise){
      // Load new samples onto the existing silent part bus without touching the
      // currently audible FX/gain. During playback the old, ready player keeps
      // feeding the scheduler until this promise has completely decoded.
      const destination=ensurePartBus(p).bus;
      promise=Promise.resolve(core.loadSoundfontInstrument
        ?core.loadSoundfontInstrument(audioCtx,sound,destination)
        :Soundfont.instrument(audioCtx,sound,{format:'mp3',soundfont:'MusyngKite',destination})
      ).then(player=>{
        resolvedPlayerCache.set(key,player);
        try{playerSound.set(player,sound);}catch{}
        if(requestedPartSound(p)===sound||!lastReadyPlayer.has(p.id))lastReadyPlayer.set(p.id,{sound,player});
        return player;
      }).catch(err=>{
        playerCache.delete(key);resolvedPlayerCache.delete(key);
        throw err;
      });
      playerCache.set(key,promise);
    }

    const fallback=lastReadyPlayer.get(p.id);
    if(!forceCurrent&&(playing||starting)&&fallback?.player&&fallback.sound!==sound){
      // Do not let sample fetch/decode block the rolling audio scheduler on
      // phones. The current sound continues cleanly, then the new sound takes
      // over at the next scheduler chunk after it is fully ready.
      promise.catch(err=>console.warn('Live sound preload failed',err));
      return fallback.player;
    }
    return promise;
  }
  async function preload(ps){await Promise.all(ps.map(p=>playerFor(p,{forceCurrent:true})));}
  function invalidatePartPlayers(p,{hard=false}={}){
    // Sound changes are keyed by sound name, so we do NOT throw away the last
    // ready player while the transport is running. It is our glitch-free bridge.
    if((playing||starting)&&!hard)return;
    for(const key of [...playerCache.keys()])if(key.startsWith(`${p.id}:`))playerCache.delete(key);
    for(const key of [...resolvedPlayerCache.keys()])if(key.startsWith(`${p.id}:`))resolvedPlayerCache.delete(key);
    lastReadyPlayer.delete(p.id);
  }
  function warmLivePlayer(p){
    if(!p||!(playing||starting))return;
    // Starts the new sample load but returns immediately through the ready-player
    // fallback; no transport restart and no scheduler stall.
    playerFor(p).catch(e=>console.warn('Live sound preload failed',e));
  }
  function syncCoreLive(){
    syncLoadedChord();
    const p=loadedChord();
    if(p){
      warmLivePlayer(p);
      if(!(playing||starting))busFor(p,requestedPartSound(p));
    }
    if(active()?.type==='lead')renderLeadHarmony();
  }
  async function auditionLeadNote(p,midi){
    if(!p||p.type!=='lead'||playing||starting)return;
    try{
      const player=await playerFor(p);
      busFor(p);
      let soundingMidi=midi+(Number(p.octave)||0)*12;
      if(core.isBassSound?.(p.sound)||p.sound==='electric_bass_finger')soundingMidi-=12;
      const at=(audioCtx?.currentTime||0)+.01;
      const beatSec=60/Math.max(40,Math.min(240,+core.bpm||92));
      const auditionDuration=p.sustain?sustainedPartSeconds(p.sound,beatSec):.42;
      playTracked(player,midiName(soundingMidi),at,{duration:auditionDuration,gain:.96});
    }catch(e){
      console.warn('Could not audition lead/bass note',e);
      core.status('Could not preview that note.');
    }
  }
  async function vocalBufferForTake(takeId,sourcePartId=''){
    const found=findVocalTake(takeId,sourcePartId),take=found?.take;if(!take)return null;
    if(vocalBufferCache.has(take.id))return vocalBufferCache.get(take.id);
    const promise=(async()=>{const blob=await getTakeBlob(take);if(!blob)return null;ensureAudio();return await audioCtx.decodeAudioData(await blob.arrayBuffer());})();
    vocalBufferCache.set(take.id,promise);
    try{return await promise;}catch(e){vocalBufferCache.delete(take.id);throw e;}
  }
  async function vocalBufferFor(p){
    if(!p||p.type!=='vocal')return null;
    const first=voxTrackEvents(p)[0];
    if(first)return vocalBufferForTake(first.takeId,first.sourcePartId);
    return p.activeTakeId?vocalBufferForTake(p.activeTakeId,p.id):null;
  }
  async function preloadVocalBuffers(p){
    const events=voxTrackEvents(p);
    if(events.length)return Promise.all(events.map(e=>vocalBufferForTake(e.takeId,e.sourcePartId)));
    return p.activeTakeId?Promise.all([vocalBufferForTake(p.activeTakeId,p.id)]):[];
  }
  function connectVocalFx(p,src,event=null){
    ensureAudio();const eq=audioCtx.createBiquadFilter(),comp=audioCtx.createDynamicsCompressor(),dry=audioCtx.createGain(),wet=audioCtx.createGain(),rev=audioCtx.createConvolver(),delay=audioCtx.createDelay(1),delayGain=audioCtx.createGain(),out=audioCtx.createGain();
    const fx=effectiveVocalFx(p,event);eq.type=fx.eq==='warm'?'lowshelf':fx.eq==='bright'?'highshelf':'peaking';eq.frequency.value=fx.eq==='warm'?180:fx.eq==='bright'?4500:2800;eq.gain.value=fx.eq==='flat'?0:fx.eq==='warm'?2:fx.eq==='bright'?2.5:1.5;
    const c=fx.comp||'medium';comp.threshold.value=c==='off'?0:c==='light'?-12:c==='heavy'?-24:-18;comp.ratio.value=c==='off'?1:c==='light'?2:c==='heavy'?6:3.5;comp.attack.value=.008;comp.release.value=.12;
    dry.gain.value=1;wet.gain.value=Number(fx.reverb||0);rev.buffer=impulse(audioCtx,1.25);delay.delayTime.value=Number(fx.delay||0);delayGain.gain.value=fx.delay?0.22:0;out.gain.value=Math.max(0,Math.min(1.5,(Number(p.volume)||0)*(event?Math.max(0,Math.min(1.5,Number(event.volume)||0)):1)));
    const tune=makeAutotuneNode(audioCtx,p,fx);src.connect(eq);eq.connect(comp);const post=tune||comp;if(tune)comp.connect(tune);post.connect(dry);dry.connect(out);post.connect(rev);rev.connect(wet);wet.connect(out);post.connect(delay);delay.connect(delayGain);delayGain.connect(out);out.connect(masterLimiter);
    const nodes={eq,comp,tune,dry,wet,rev,delay,delayGain,out};
    let set=liveVocalFxNodes.get(p.id);if(!set){set=new Set();liveVocalFxNodes.set(p.id,set);}
    const item={src,nodes,eventId:event?.id||null};set.add(item);applyVocalFxLive(p);
    return item;
  }
  async function scheduleVocalSource(p,event,buffer,startTime,fromBeat,toBeat,generation,absoluteStartBeat){
    if(!buffer||!playing||generation!==playbackGeneration)return;
    const beatSec=60/core.bpm;
    const trimStart=Math.max(0,Math.min(buffer.duration,Number(event?.trimStartSec)||0));
    const trimEnd=Math.max(trimStart,Math.min(buffer.duration,Number.isFinite(Number(event?.trimEndSec))&&Number(event.trimEndSec)>0?Number(event.trimEndSec):buffer.duration));
    const eventDurationBeats=Math.max(.0001,(trimEnd-trimStart)/beatSec);
    const eventStart=Number(absoluteStartBeat)||0,eventEnd=eventStart+eventDurationBeats;
    const clipStart=Math.max(fromBeat,eventStart),clipEnd=Math.min(toBeat,eventEnd);if(clipEnd<=clipStart)return;
    const offsetSec=trimStart+(clipStart-eventStart)*beatSec,dur=Math.min((clipEnd-clipStart)*beatSec,Math.max(0,trimEnd-offsetSec));if(dur<=.005)return;
    const at=startTime+(clipStart-fromBeat)*beatSec,src=audioCtx.createBufferSource();src.buffer=buffer;
    const liveItem=connectVocalFx(p,src,event);activeVocalSources.add(src);src.onended=()=>{activeVocalSources.delete(src);const set=liveVocalFxNodes.get(p.id);set?.delete(liveItem);if(set&&!set.size)liveVocalFxNodes.delete(p.id);};
    try{src.start(at,offsetSec,dur);}catch(e){activeVocalSources.delete(src);try{src.disconnect();}catch{}console.warn('Could not schedule vocal event',e);}
  }
  async function scheduleVocalSegment(p,startTime,fromBeat,toBeat,generation){
    if(!playing||generation!==playbackGeneration)return;await ensureAutotuneWorklet(audioCtx);
    const events=voxTrackEvents(p);
    if(events.length){
      const buffers=new Map();
      for(const e of events){const key=`${e.sourcePartId}:${e.takeId}`;if(!buffers.has(key))buffers.set(key,await vocalBufferForTake(e.takeId,e.sourcePartId));}
      const period=Math.max(.001,...events.map(e=>(Number(e.startBeat)||0)+voxEventDurationBeats(e)));
      const firstCycle=p.repeat?Math.max(0,Math.floor(fromBeat/period)-1):0;
      const lastCycle=p.repeat?Math.max(0,Math.floor((toBeat-1e-6)/period)):0;
      for(let cyc=firstCycle;cyc<=lastCycle;cyc++){
        for(const e of events){
          if(!playing||generation!==playbackGeneration)return;
          const key=`${e.sourcePartId}:${e.takeId}`,buf=buffers.get(key);
          await scheduleVocalSource(p,e,buf,startTime,fromBeat,toBeat,generation,(Number(e.startBeat)||0)+cyc*period);
        }
      }
      return;
    }
    const take=p.recordings?.find(r=>r.id===p.activeTakeId);if(!take)return;
    const buf=await vocalBufferForTake(take.id,p.id);if(!buf||!playing||generation!==playbackGeneration)return;
    const beatSec=60/core.bpm,vocalBeats=Math.max(.001,buf.duration/beatSec);
    const fallback={id:null,trimStartSec:0,trimEndSec:buf.duration,volume:1,fx:null};
    const first=p.repeat?Math.max(0,Math.floor(fromBeat/vocalBeats)):0,last=p.repeat?Math.floor((toBeat-1e-6)/vocalBeats):0;
    for(let c=first;c<=last;c++)await scheduleVocalSource(p,fallback,buf,startTime,fromBeat,toBeat,generation,c*vocalBeats);
  }
  function scheduleHighlight(delayMs,p,cardIndex){
    if(p.id!==activePartId||p.type!=='chord')return;
    const t=setTimeout(()=>{
      document.querySelectorAll('.chord-card').forEach(c=>c.style.outline='');
      const cards=[...document.querySelectorAll('.progression-line:not(.carousel-clone) .chord-card')];
      cards[cardIndex]?.style.setProperty('outline','2px solid var(--accent)');
      core.followChordCard?.(cardIndex);
    },Math.max(0,delayMs));
    highlightTimers.push(t);
  }
  function scheduleLeadHighlight(delayMs,p,step){
    if(p.id!==activePartId||p.type!=='lead')return;
    const t=setTimeout(()=>{
      document.querySelectorAll('.lead-cell.playing,.lead-note-block.playing').forEach(c=>c.classList.remove('playing'));
      const target=document.querySelector(`.lead-note-block[data-step="${step}"]`);
      if(target){
        target.classList.add('playing');
        if(core.autoScroll){
          const wrap=$('leadGridWrap');
          if(wrap&&wrap.contains(target)){
            const tr=target.getBoundingClientRect(),wr=wrap.getBoundingClientRect();
            const left=wrap.scrollLeft+(tr.left-wr.left)-wrap.clientWidth/2+tr.width/2;
            const top=wrap.scrollTop+(tr.top-wr.top)-wrap.clientHeight/2+tr.height/2;
            wrap.scrollTo({left:Math.max(0,left),top:Math.max(0,top),behavior:'smooth'});
          }else target.scrollIntoView({behavior:'smooth',block:'nearest',inline:'center'});
        }
      }
    },Math.max(0,delayMs));highlightTimers.push(t);
  }
  function trackVoice(voice){
    if(!voice||typeof voice.stop!=='function')return voice;
    activeVoices.add(voice);
    // Soundfont-player nodes do not consistently expose an ended event, so
    // cleanup is also performed wholesale by stopPlayback().
    return voice;
  }
  function playTracked(player,note,at,opts){
    try{return trackVoice(player.play(note,at,opts));}catch(e){console.warn('Could not schedule note',note,e);return null;}
  }
  function silenceScheduledAudio(){
    // The critical stop path: detach every old part bus from the output graph.
    // Even if a browser/Soundfont node was scheduled far ahead and cannot be
    // individually cancelled, it now has nowhere audible to go.
    for(const voice of activeVoices){try{voice.stop(0);}catch{}try{voice.disconnect?.();}catch{}}
    activeVoices.clear();
    for(const src of activeVocalSources){try{src.stop(0);}catch{}try{src.disconnect();}catch{}}
    activeVocalSources.clear();liveVocalFxNodes.clear();
    for(const bus of partBuses.values()){try{bus.gain.cancelScheduledValues(audioCtx?.currentTime||0);bus.gain.value=0;bus.disconnect();}catch{}}
    for(const fx of partInstrumentFx.values())try{fx?.disconnect?.();}catch{}
    partInstrumentFx.clear();partBuses.clear();
    playerCache.clear();resolvedPlayerCache.clear();lastReadyPlayer.clear();playerSound=new WeakMap();
    if(masterLimiter){try{masterLimiter.disconnect();}catch{}masterLimiter=null;}
  }
  async function scheduleSegment(startTime,fromBeat,toBeat,generation,withVocals=true){
    const beatSec=60/core.bpm;
    for(const p of enabledPlayable()){
      if(!playing||generation!==playbackGeneration)return;
      const player=await playerFor(p);
      if(!playing||generation!==playbackGeneration)return;
      const scheduledSound=playerSound.get(player)||outputSoundFor(p)||requestedPartSound(p);
      busFor(p,scheduledSound);
      if(p.type==='chord'){
        const cards=(p.data.rows||[]).flat();let chordBeat=0;
        cards.forEach((card,i)=>{if(!playing||generation!==playbackGeneration)return;const durBeats=core.cardDurationBeats?.(card,core.beats)||core.beats,b=chordBeat;chordBeat+=durBeats;if(b<fromBeat||b>=toBeat)return;const at=startTime+(b-fromBeat)*beatSec;const baseDur=durBeats*beatSec,duration=core.sustain?sustainedPartSeconds(scheduledSound,baseDur):Math.max(.18,baseDur*.98);const notes=core.notesFor(card,p.data)||[];notes.forEach((n,j)=>playTracked(player,n,at+(p.data.instrument==='guitar'?j*.035:0),{duration,gain:.94}));scheduleHighlight((at-audioCtx.currentTime)*1000,p,i);});
      }else{
        const subdiv=p.resolution/4,stepBeats=1/subdiv;
        const partBeats=Math.max(stepBeats,p.bars*4),repeatLead=playbackScope?.kind==='vocalMix'?p.repeat:!!core.loop,firstCycle=repeatLead?Math.max(0,Math.floor(fromBeat/partBeats)):0,lastCycle=repeatLead?Math.floor((toBeat-1e-6)/partBeats):0;
        for(let cyc=firstCycle;cyc<=lastCycle;cyc++)p.events.forEach(e=>{if(!playing||generation!==playbackGeneration)return;const local=e.step*stepBeats,b=local+cyc*partBeats;if(b<fromBeat||b>=toBeat)return;const at=startTime+(b-fromBeat)*beatSec;let midi=e.midi+(Number(p.octave)||0)*12;if(core.isBassSound?.(scheduledSound)||scheduledSound==='electric_bass_finger')midi-=12;const drawnBeats=leadDurationSteps(e)*stepBeats,duration=p.sustain&&drawnBeats<=stepBeats?sustainedPartSeconds(scheduledSound,beatSec):Math.max(.05,drawnBeats*beatSec*.98);playTracked(player,midiName(midi),at,{duration,gain:.92});scheduleLeadHighlight((at-audioCtx.currentTime)*1000,p,e.step);});
      }
    }
    if(withVocals)for(const p of enabledVocals()){
      if(!playing||generation!==playbackGeneration)return;
      await scheduleVocalSegment(p,startTime,fromBeat,toBeat,generation);
    }
  }
  async function startPlayback(options={}){
    const requestedScope=options?.scope||null, preserveUi=!!options?.preserveUi;
    if(playing||starting)stopPlayback({preserveUi,preserveScope:preserveUi,preserveMedia:preserveUi});
    playbackScope=requestedScope;
    updatePartPlaybackButtons();
    syncLoadedChord();
    const ps=enabledPlayable(),vs=enabledVocals();
    const scopedDrums=playbackScope?playbackScope.drums===true:true;
    const drumBeats=scopedDrums?Math.max(0,Number(window.CRPBeatMaker?.getDurationBeats?.()||0)):0;
    if(!ps.length&&!vs.length&&drumBeats<=0){
      const wasVocalMix=playbackScope?.kind==='vocalMix';
      playbackScope=null;updatePartPlaybackButtons();
      core.status(wasVocalMix?'Choose at least one backing part/drums or an active vocal take.':'There is nothing to play in this part yet.');
      return;
    }
    // Start the silent media-session carrier while the original Play tap still has
    // user activation. This makes Android/Chrome much more likely to expose the
    // lock-screen/notification transport and seek slider for our WebAudio mix.
    ensureMediaSession();updateMediaMetadata();
    if(mediaKeepAlive){try{if(mediaKeepAlive.readyState===0)mediaKeepAlive.load();const pp=mediaKeepAlive.play();pp?.then?.(()=>{try{navigator.mediaSession.playbackState='playing';}catch{} updateMediaPosition();}).catch(()=>{});}catch{}}
    const generation=++playbackGeneration;
    starting=true;updatePartPlaybackButtons();
    try{
      core.status('Loading parts…');ensureAudio();if(vs.length)await ensureAutotuneWorklet(audioCtx);await Promise.all([preload(ps),...vs.map(v=>preloadVocalBuffers(v))]);
      if(generation!==playbackGeneration)return;

      // Keep every playback source on the same musical downbeat. Drums use a
      // separate AudioContext, so both engines receive the same relative lead-in.
      const leadIn=options?.liveRestart?.035:.16;
      const computePlaybackTotal=()=>{
        const livePs=enabledPlayable(),liveVs=enabledVocals();
        const liveDrums=scopedDrums?Math.max(0,Number(window.CRPBeatMaker?.getDurationBeats?.()||0)):0;
        const natural=Math.max(...livePs.map(partDurationBeats),...liveVs.map(vocalDurationBeats),liveDrums,4);
        return effectiveSongEndBeats(natural);
      };
      let total=computePlaybackTotal();
      playbackTotalBeats=total;
      // Scoped Lead/Vocal preview buttons always begin at beat 1. The normal
      // Chord transport still honors "play line in view". If the visible line
      // begins past a custom song end, restart from beat 1 instead of silently ending.
      let cursorBeat=Number.isFinite(Number(options?.fromBeat))?Math.max(0,Number(options.fromBeat)):((!playbackScope&&active()?.type==='chord'&&active()?.enabled&&activePartId===loadedChordPartId)?Math.min(core.startBeat(),Math.max(0,total-0.001)):0);
      if(cursorBeat>=total-.001)cursorBeat=0;
      const initialBeat=cursorBeat;
      if(scopedDrums){
        const drumGain=Math.max(0,Math.min(1,Number(playbackScope?.drumGain??1)));
        await window.CRPBeatMaker?.startMainNow?.(leadIn,initialBeat,drumGain);
      }else{
        window.CRPBeatMaker?.stopMainNow?.();
      }
      if(generation!==playbackGeneration)return;

      starting=false;playing=true;mediaPausedBeat=initialBeat;core.setPlaying(true);core.status('');updatePartPlaybackButtons();setMediaPlaying(true);
      if(generation!==playbackGeneration||!playing){window.CRPBeatMaker?.stopMainNow?.();return;}

      let nextAudioStart=audioCtx.currentTime+leadIn;
      // Shared musical clock exposed to linked SRP so lyric AutoScroll can quantize
      // to the exact CRP/BD beat grid instead of using an independent timer.
      playbackClockStartAudioTime=nextAudioStart;
      playbackClockStartBeat=initialBeat;
      playbackClockBpm=Math.max(40,Math.min(240,+core.bpm||92));
      // Keep roughly 0.65-0.7 seconds of WebAudio safely scheduled ahead.
      // This is intentionally time-based rather than a fixed number of beats:
      // phones get enough render headroom for SoundFont decode/UI work, while
      // instrument/sound edits still land quickly at the next scheduler chunk.
      let vocalsScheduledForCycle=false;

      const scheduleNext=async()=>{
        if(!playing||generation!==playbackGeneration)return;
        const beatSec=60/Math.max(40,Math.min(240,+core.bpm||92));
        const chunkBeats=Math.max(1,Math.min(2.5,.68/beatSec));
        total=computePlaybackTotal();playbackTotalBeats=total;
        if(cursorBeat>=total-.001)cursorBeat=0;
        const fromBeat=cursorBeat;
        const toBeat=Math.min(total,fromBeat+chunkBeats);
        const span=(toBeat-fromBeat)*beatSec;
        const start=nextAudioStart,end=start+span;

        // Vocals stay as one continuous source for the remainder of each song cycle.
        if(!vocalsScheduledForCycle){
          for(const v of enabledVocals())await scheduleVocalSegment(v,start,fromBeat,total,generation);
          vocalsScheduledForCycle=true;
        }
        await scheduleSegment(start,fromBeat,toBeat,generation,false);
        if(!playing||generation!==playbackGeneration)return;

        nextAudioStart=end;
        cursorBeat=toBeat;
        if(cursorBeat>=total-1e-7){
          const loopSong=playbackScope?false:!!core.loop;
          if(loopSong){cursorBeat=0;vocalsScheduledForCycle=false;}
          else{
            cycleTimer=setTimeout(()=>{if(generation===playbackGeneration)stopPlayback();},Math.max(10,(end-audioCtx.currentTime)*1000+35));
            return;
          }
        }

        // Refill while a healthy amount of already-scheduled audio is still
        // playing. That buffer is what lets mobile switch/decode instruments
        // without the mix crackling, starving, or restarting.
        const wakeAhead=Math.min(.50,Math.max(.30,span*.68));
        const wakeMs=Math.max(8,(end-audioCtx.currentTime-wakeAhead)*1000);
        cycleTimer=setTimeout(scheduleNext,wakeMs);
      };
      scheduleNext();
    }catch(e){
      if(generation!==playbackGeneration)return;
      console.error(e);core.status(e.message||'Could not start playback.');stopPlayback();
    }
  }
  function stopPlayback(options={}){
    const priorBeat=currentCycleBeat();
    ++playbackGeneration;starting=false;playing=false;
    playbackClockStartAudioTime=0;
    playbackTotalBeats=0;
    clearTimeout(cycleTimer);cycleTimer=null;
    highlightTimers.forEach(clearTimeout);highlightTimers=[];
    document.querySelectorAll('.lead-cell.playing,.lead-note-block.playing').forEach(c=>c.classList.remove('playing'));
    document.querySelectorAll('.chord-card').forEach(c=>c.style.outline='');
    silenceScheduledAudio();window.CRPBeatMaker?.stopMainNow?.();
    if(options?.mediaPause&&Number.isFinite(priorBeat))mediaPausedBeat=priorBeat;
    else if(!options?.preserveMedia&&!options?.mediaPause)mediaPausedBeat=0;
    if(!options?.preserveUi)core.setPlaying(false);
    if(!options?.preserveScope)playbackScope=null;
    if(!options?.preserveUi)updatePartPlaybackButtons();
    if(!options?.preserveMedia)setMediaPlaying(false);
  }
  function togglePlayback(){if(playing||starting)stopPlayback();else startPlayback();}
  document.addEventListener('visibilitychange',()=>{
    if((playing||starting)&&audioCtx?.state==='suspended')audioCtx.resume().catch(()=>{});
    if(playing||starting){ensureMediaSession();mediaKeepAlive?.play?.().catch(()=>{});updateMediaPosition();}
  });
  function toggleLeadPartPlayback(){
    const p=active();if(!p||p.type!=='lead')return;
    // Play exactly the parts checked in the top Parts strip (plus drums when
    // enabled), matching the main Baby DAW transport instead of soloing this part.
    if(playing||starting){stopPlayback();return;}
    const hasCheckedPlayable=parts.some(x=>x.enabled&&((x.type==='chord'&&partDurationBeats(x)>0)||(x.type==='lead'&&x.events?.length)||(x.type==='vocal'&&vocalHasPlayableAudio(x))));
    const drumsOn=!!$('crpDrumsToggle')?.checked;
    if(!hasCheckedPlayable&&!drumsOn){core.status('Check at least one part above, or turn on Drums, to play.');return;}
    startPlayback();
  }
  function toggleVocalMasterPlayback(){
    const p=active();if(!p||p.type!=='vocal')return;
    if((playing||starting)&&playbackScope?.kind==='vocalMix'&&String(playbackScope.ownerId||'')===String(p.id)){stopPlayback();return;}
    const playableIds=(p.backingPartIds||[]).filter(id=>parts.some(x=>x.id===id&&(x.type==='chord'||x.type==='lead')));
    const hasActiveTake=vocalHasPlayableAudio(p);
    const drums=p.backingDrums!==false;
    if(!playableIds.length&&!hasActiveTake&&!drums){core.status('Check a backing part/drums or choose/add a vocal event first.');return;}
    const gain=Math.max(0,Math.min(1,Number(p.backingVolume??.8)));
    startPlayback({scope:{kind:'vocalMix',ownerId:p.id,playableIds,vocalIds:hasActiveTake?[p.id]:[],drums,backingGain:gain,drumGain:gain}});
  }

  function crc32(bytes){let c=0xffffffff;for(const b of bytes){c^=b;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;}
  function le16(n){return new Uint8Array([n&255,(n>>>8)&255]);}function le32(n){return new Uint8Array([n&255,(n>>>8)&255,(n>>>16)&255,(n>>>24)&255]);}
  function concatBytes(chunks){const n=chunks.reduce((a,b)=>a+b.length,0),out=new Uint8Array(n);let o=0;for(const b of chunks){out.set(b,o);o+=b.length;}return out;}
  async function makeZip(files){const enc=new TextEncoder(),locals=[],centrals=[];let offset=0;for(const f of files){const name=enc.encode(f.name),data=f.data instanceof Uint8Array?f.data:new Uint8Array(f.data),crc=crc32(data),local=concatBytes([le32(0x04034b50),le16(20),le16(0),le16(0),le16(0),le16(0),le32(crc),le32(data.length),le32(data.length),le16(name.length),le16(0),name,data]);locals.push(local);centrals.push(concatBytes([le32(0x02014b50),le16(20),le16(20),le16(0),le16(0),le16(0),le16(0),le32(crc),le32(data.length),le32(data.length),le16(name.length),le16(0),le16(0),le16(0),le16(0),le32(0),le32(offset),name]));offset+=local.length;}const central=concatBytes(centrals),end=concatBytes([le32(0x06054b50),le16(0),le16(0),le16(files.length),le16(files.length),le32(central.length),le32(offset),le16(0)]);return new Blob([...locals,central,end],{type:'application/zip'});}
  function safeFileName(s){return String(s||'part').replace(/[^a-z0-9 _.-]+/gi,'').trim().replace(/\s+/g,'-')||'part';}
  function midiNum(note){const m=String(note).match(/^([A-G])(#|b)?(-?\d+)$/);if(!m)return 60;const pc={C:0,D:2,E:4,F:5,G:7,A:9,B:11}[m[1]]+(m[2]==='#'?1:m[2]==='b'?-1:0);return Math.max(0,Math.min(127,(+m[3]+1)*12+pc));}
  function vlq(n){n=Math.max(0,Math.floor(n));let a=[n&127];while(n>>=7)a.unshift((n&127)|128);return a;}
  function midiFile(events,bpm=120){const ppq=480,tempo=Math.round(60000000/bpm),ev=[];events.sort((a,b)=>a.t-b.t||a.on-b.on);let last=0;for(const e of events){ev.push(...vlq(e.t-last),e.on?0x90:0x80,e.note&127,e.on?(e.vel||96):0);last=e.t;}ev.push(0,0xff,0x2f,0);const tr=new Uint8Array(ev),head=new Uint8Array([77,84,104,100,0,0,0,6,0,0,0,1,ppq>>8,ppq&255]),th=new Uint8Array([77,84,114,107,(tr.length>>>24)&255,(tr.length>>>16)&255,(tr.length>>>8)&255,tr.length&255]);return concatBytes([head,th,tr]);}
  function partMidi(p){const ppq=480,E=[];if(p.type==='lead'){const stepBeat=4/p.resolution;for(const x of p.events){const t=Math.round(x.step*stepBeat*ppq),n=Math.max(0,Math.min(127,x.midi+(p.octave||0)*12+((core.isBassSound?.(p.sound)||p.sound==='electric_bass_finger')?-12:0))),drawnBeats=leadDurationSteps(x)*stepBeat,durBeats=(p.sustain&&leadDurationSteps(x)===1)?Math.max(1,drawnBeats):drawnBeats,durTicks=Math.max(30,Math.round(durBeats*ppq*.98));E.push({t,on:1,note:n},{t:t+durTicks,on:0,note:n});}}else if(p.type==='chord'){let beat=0;for(const row of p.data.rows||[])for(const card of row){const notes=core.notesFor(card,p.data)||[],dur=core.cardDurationBeats?.(card,core.beats)||Math.max(.25,core.beats);for(const n of notes){const mn=midiNum(n);E.push({t:Math.round(beat*ppq),on:1,note:mn},{t:Math.round((beat+dur*.98)*ppq),on:0,note:mn});}beat+=dur;}}return midiFile(E,core.bpm);}
  function drumMidi(b){const map={kick1:36,kick2:36,kick3:35,snare1:38,snare2:38,snare3:40,snare4:38,snare5:40,chh:42,ohh:46,tomHi:50,tomMid:47,tomLow:45,clap:39,rim:37,shaker:82,tamb:54,cowbell:56,conga:64},E=[];if(!b)return midiFile(E,core.bpm);for(const [id,bars] of Object.entries(b.tracks||{}))for(let bar=0;bar<(b.bars||1);bar++)for(const st of bars[bar]||[]){const t=Math.round((bar*4+st/16)*480),n=map[id]||37;E.push({t,on:1,note:n},{t:t+60,on:0,note:n});}return midiFile(E,core.bpm);}
  function closeStudioExport(){document.getElementById('studioExportModal')?.remove();}
  function openStudioExport(){
    closeStudioExport();syncLoadedChord();const modal=document.createElement('div');modal.id='studioExportModal';modal.className='studio-export-modal';const rows=parts.map(p=>`<label class="studio-export-row"><input type="checkbox" data-export-part="${p.id}" checked><span><strong>${escapeHtml(p.name)}</strong><br><span class="subtle tiny">${p.type==='chord'?'Chord / Note':p.type==='lead'?'Lead / Bass':'Vocals'}</span></span></label>`).join('');
    modal.innerHTML=`<div class="studio-export-backdrop"></div><div class="studio-export-card"><h2>Studio export</h2><p class="subtle">Choose exactly what leaves the project. Musical parts export as editable Chord Rider data; selected vocal parts include every dry WAV used by Vox Box.</p><div class="studio-export-list">${rows}<label class="studio-export-row"><input id="studioExportDrums" type="checkbox" checked><span><strong>Drums</strong><br><span class="subtle tiny">Beat Maker pattern</span></span></label><label class="studio-export-row"><input id="studioExportNotes" type="checkbox"><span><strong>Project notes</strong><br><span class="subtle tiny">Only included when checked</span></span></label></div><div class="studio-export-actions"><button id="studioExportCancel" type="button">Cancel</button><button id="studioExportGo" class="accent" type="button">Export ZIP</button></div></div>`;document.body.appendChild(modal);modal.querySelector('.studio-export-backdrop').onclick=closeStudioExport;modal.querySelector('#studioExportCancel').onclick=closeStudioExport;modal.querySelector('#studioExportGo').onclick=exportStudioPackage;
  }
  async function exportStudioPackage(){
    const modal=$('studioExportModal');if(!modal)return;const ids=[...modal.querySelectorAll('[data-export-part]:checked')].map(x=>x.dataset.exportPart),selected=parts.filter(p=>ids.includes(p.id));if(!selected.length&&!$('studioExportDrums')?.checked&&!$('studioExportNotes')?.checked){core.status('Choose at least one thing to export.');return;}
    const manifest={format:'Chord Rider Pro Studio Package',version:1,createdAt:new Date().toISOString(),project:{name:core.projectName,bpm:core.bpm,beats:core.beats,songEndBeat:Number.isFinite(Number(songEndBeat))&&Number(songEndBeat)>0?Number(songEndBeat):null},parts:selected.map(p=>{const q=clone(p);if(q.type==='vocal')q.recordings=(q.recordings||[]).map(r=>({...r,blob:undefined}));return q;})};if($('studioExportDrums')?.checked)manifest.beatMaker=window.CRPBeatMaker?.getBeat?.()||null;if($('studioExportNotes')?.checked)manifest.notes=core.projectNotes||'';
    const files=[{name:'project.json',data:new TextEncoder().encode(JSON.stringify(manifest,null,2))}];for(const p of selected.filter(x=>x.type==='chord'||x.type==='lead'))files.push({name:`midi/${safeFileName(p.name)}.mid`,data:partMidi(p)});if($('studioExportDrums')?.checked)files.push({name:'midi/Drums.mid',data:drumMidi(window.CRPBeatMaker?.getBeat?.())});for(const p of selected.filter(x=>x.type==='vocal')){const refs=voxTrackEvents(p).length?voxTrackEvents(p).map(e=>({takeId:e.takeId,sourcePartId:e.sourcePartId})):(p.activeTakeId?[{takeId:p.activeTakeId,sourcePartId:p.id}]:[]),seen=new Set();for(const ref of refs){if(seen.has(ref.takeId))continue;seen.add(ref.takeId);const found=findVocalTake(ref.takeId,ref.sourcePartId),take=found?.take;if(!take)continue;const blob=await getTakeBlob(take);if(blob)files.push({name:`vocals/${safeFileName(p.name)}-${safeFileName(take.name)}-${String(take.id).slice(0,8)}.wav`,data:new Uint8Array(await blob.arrayBuffer())});}}
    files.push({name:'README.txt',data:new TextEncoder().encode('Chord Rider Pro Studio Package\n\nproject.json contains only the parts you checked. Project notes are included only when their checkbox was selected. Selected vocal parts include every dry WAV referenced by Vox Box. Chord/Note, Lead/Bass, and drums are also exported as Standard MIDI files in /midi for direct import into Cubase and other DAWs. project.json preserves Vox Box event placement, trims, clip FX, and Chord Rider editing data.\n')});const zip=await makeZip(files),a=document.createElement('a');a.href=URL.createObjectURL(zip);a.download=`${safeFileName(core.projectName)}-Studio-Export.zip`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),5000);closeStudioExport();core.status('Studio package exported.');
  }


  // v3.3.14 — one-file WAV mix export. The user chooses exactly which Chord,
  // Lead/Bass, Vocal and Drum parts are rendered into the song mix.
  const AUDIO_EXPORT_DRUMS={
    kick1:'assets/drums/kick-1.wav',kick2:'assets/drums/kick-2.wav',kick3:'assets/drums/kick-3.wav',
    snare1:'assets/drums/snare-1.wav',snare2:'assets/drums/snare-2.wav',snare3:'assets/drums/snare-3.wav',snare4:'assets/drums/snare-4.wav',snare5:'assets/drums/snare-5.wav',
    chh:'assets/drums/closed-hat.wav',ohh:'assets/drums/open-hat.wav',tomHi:'assets/drums/tom-high.wav',tomMid:'assets/drums/tom-mid.wav',tomLow:'assets/drums/tom-low.wav',
    clap:'assets/drums/clap.wav',rim:'assets/drums/rim.wav',shaker:'assets/drums/shaker.wav',tamb:'assets/drums/tambourine.wav',cowbell:'assets/drums/cowbell.wav',conga:'assets/drums/conga.wav'
  };
  const AUDIO_EXPORT_DRUM_SCALE=.18;
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  function closeAudioExport(){document.getElementById('audioExportModal')?.remove();}
  function openAudioExport(){
    closeAudioExport();syncLoadedChord();
    const beat=window.CRPBeatMaker?.getBeat?.()||null;
    const rows=parts.map(p=>{
      const hasVocal=p.type==='vocal'?vocalHasPlayableAudio(p):false;
      const unavailable=p.type==='vocal'&&!hasVocal;
      const detail=p.type==='chord'?'Chord / Note':p.type==='lead'?'Lead / Bass':(hasVocal?(voxTrackEvents(p).length?'Vox Box arrangement':'Active vocal take'):'No vocal audio');
      return `<label class="studio-export-row${unavailable?' is-disabled':''}"><input type="checkbox" data-audio-part="${p.id}" ${p.enabled!==false&&!unavailable?'checked':''} ${unavailable?'disabled':''}><span><strong>${escapeHtml(p.name)}</strong><br><span class="subtle tiny">${detail}</span></span></label>`;
    }).join('');
    const modal=document.createElement('div');modal.id='audioExportModal';modal.className='studio-export-modal';
    modal.innerHTML=`<div class="studio-export-backdrop"></div><div class="studio-export-card"><h2>Export audio mix</h2><p class="subtle">Check only the parts you want in the finished WAV. Choose the music parts for an instrumental, or include Vocals for the full song.</p><div class="studio-export-list">${rows}<label class="studio-export-row"><input id="audioExportDrums" type="checkbox" ${beat?.enabled===false?'':'checked'}><span><strong>Drums</strong><br><span class="subtle tiny">Beat Maker audio</span></span></label></div><div class="studio-export-actions"><button id="audioExportCancel" type="button">Cancel</button><button id="audioExportGo" class="accent" type="button">Export WAV</button></div></div>`;
    document.body.appendChild(modal);
    modal.querySelector('.studio-export-backdrop').onclick=closeAudioExport;
    modal.querySelector('#audioExportCancel').onclick=closeAudioExport;
    modal.querySelector('#audioExportGo').onclick=()=>exportAudioMix(modal);
  }
  function wavFromStereo(left,right,sampleRate){
    const n=Math.min(left.length,right.length),buf=new ArrayBuffer(44+n*4),v=new DataView(buf),write=(o,str)=>{for(let i=0;i<str.length;i++)v.setUint8(o+i,str.charCodeAt(i));};
    write(0,'RIFF');v.setUint32(4,36+n*4,true);write(8,'WAVE');write(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,2,true);v.setUint32(24,sampleRate,true);v.setUint32(28,sampleRate*4,true);v.setUint16(32,4,true);v.setUint16(34,16,true);write(36,'data');v.setUint32(40,n*4,true);
    let o=44;for(let i=0;i<n;i++){const a=Math.max(-1,Math.min(1,left[i]||0)),b=Math.max(-1,Math.min(1,right[i]||0));v.setInt16(o,a<0?a*0x8000:a*0x7fff,true);o+=2;v.setInt16(o,b<0?b*0x8000:b*0x7fff,true);o+=2;}
    return new Blob([buf],{type:'audio/wav'});
  }
  function concatFloatChunks(chunks,total){const out=new Float32Array(total);let o=0;for(const c of chunks){const n=Math.min(c.length,total-o);if(n<=0)break;out.set(c.subarray(0,n),o);o+=n;}return out;}
  async function exportAudioMix(modal){
    const ids=[...modal.querySelectorAll('[data-audio-part]:checked')].map(x=>x.dataset.audioPart),selected=parts.filter(p=>ids.includes(p.id)),drums=!!modal.querySelector('#audioExportDrums')?.checked;
    if(!selected.length&&!drums){core.status('Choose at least one audio part to export.');return;}
    if(!window.Soundfont&&selected.some(p=>p.type==='chord'||p.type==='lead')){core.status('Sound engine unavailable. Reload while online and try again.');return;}
    const go=modal.querySelector('#audioExportGo');go.disabled=true;go.textContent='Preparing…';
    stopPlayback();stopPreview();
    const Ctx=window.AudioContext||window.webkitAudioContext;if(!Ctx){core.status('Audio export is not supported in this browser.');go.disabled=false;go.textContent='Export WAV';return;}
    let ctx=null;
    try{
      ctx=new Ctx({sampleRate:48000});if(ctx.state==='suspended')await ctx.resume();
      const beatSec=60/Math.max(40,Math.min(240,Number(core.bpm)||92));
      const beat=window.CRPBeatMaker?.getBeat?.()||null;
      let songSec=.25;
      selected.forEach(p=>{if(p.type==='chord'||p.type==='lead')songSec=Math.max(songSec,partDurationBeats(p)*beatSec);else if(p.type==='vocal')songSec=Math.max(songSec,vocalDurationBeats(p)*beatSec);});
      if(drums&&beat)songSec=Math.max(songSec,Math.max(1,Number(beat.bars)||1)*4*beatSec);
      const customEnd=Number.isFinite(Number(songEndBeat))&&Number(songEndBeat)>0;
      if(customEnd)songSec=Math.max(.05,Math.min(songSec,Number(songEndBeat)*beatSec));
      const tailSec=customEnd?.08:1.8,leadSec=.18;
      const mix=ctx.createGain(),lim=ctx.createDynamicsCompressor();lim.threshold.value=-2;lim.knee.value=0;lim.ratio.value=20;lim.attack.value=.003;lim.release.value=.12;mix.connect(lim);
      const proc=ctx.createScriptProcessor(4096,2,2),silent=ctx.createGain();silent.gain.value=0;lim.connect(proc);proc.connect(silent);silent.connect(ctx.destination);
      const L=[],R=[];let captured=0,captureStart=ctx.currentTime;proc.onaudioprocess=e=>{const l=new Float32Array(e.inputBuffer.getChannelData(0)),r=new Float32Array(e.inputBuffer.numberOfChannels>1?e.inputBuffer.getChannelData(1):e.inputBuffer.getChannelData(0));L.push(l);R.push(r);captured+=l.length;};

      go.textContent='Loading sounds…';
      const playerMap=new Map();
      for(const p of selected.filter(x=>x.type==='chord'||x.type==='lead')){
        const sound=p.type==='chord'?p.data.sound:p.sound,bus=ctx.createGain();
        bus.gain.value=soundGain(sound)*p.volume*(p.type==='lead'?LEAD_OUTPUT_BOOST:1);
        const fx=core.createInstrumentFxChain?.(ctx,mix);if(fx){bus.connect(fx.input);fx.setSound(sound);}else bus.connect(mix);
        const player=await (core.loadSoundfontInstrument?core.loadSoundfontInstrument(ctx,sound,bus):Soundfont.instrument(ctx,sound,{format:'mp3',soundfont:'MusyngKite',destination:bus}));playerMap.set(p.id,player);
      }
      const vocalBuffers=new Map();
      for(const p of selected.filter(x=>x.type==='vocal')){const refs=voxTrackEvents(p).length?voxTrackEvents(p).map(e=>({takeId:e.takeId,sourcePartId:e.sourcePartId})):(p.activeTakeId?[{takeId:p.activeTakeId,sourcePartId:p.id}]:[]);for(const ref of refs){const key=`${ref.sourcePartId}:${ref.takeId}`;if(vocalBuffers.has(key))continue;const found=findVocalTake(ref.takeId,ref.sourcePartId),take=found?.take;if(!take)continue;const blob=await getTakeBlob(take);if(blob)vocalBuffers.set(key,await ctx.decodeAudioData(await blob.arrayBuffer()));}}
      if([...selected].some(p=>p.type==='vocal'&&(Number(p.fx?.autotune)>0||voxTrackEvents(p).some(e=>Number(e.fx?.autotune)>0))))await ensureAutotuneWorklet(ctx);
      const drumBuffers=new Map();
      if(drums&&beat){for(const [id,url] of Object.entries(AUDIO_EXPORT_DRUMS)){if(!(beat.tracks?.[id]||[]).some(a=>Array.isArray(a)&&a.length))continue;const res=await fetch(url);if(!res.ok)continue;drumBuffers.set(id,await ctx.decodeAudioData(await res.arrayBuffer()));}}

      // Discard the silent processing buffers accumulated while remote soundfont
      // samples and vocal/drum assets were loading. The exported WAV starts at
      // the musical downbeat instead of containing seconds of load-time silence.
      L.length=0;R.length=0;captured=0;captureStart=ctx.currentTime;
      const startAt=ctx.currentTime+leadSec;
      if(customEnd){
        const fadeStart=startAt+Math.max(0,songSec-.045);
        mix.gain.setValueAtTime(1,startAt);
        mix.gain.setValueAtTime(1,fadeStart);
        mix.gain.linearRampToValueAtTime(0,startAt+songSec);
      }
      // Chord and Lead/Bass parts.
      for(const p of selected.filter(x=>x.type==='chord'||x.type==='lead')){
        const player=playerMap.get(p.id);if(!player)continue;
        if(p.type==='chord'){
          let b=0;for(const row of p.data.rows||[])for(const card of row){const durBeats=core.cardDurationBeats?.(card,core.beats)||core.beats,at=startAt+b*beatSec,base=durBeats*beatSec,duration=core.sustain?sustainedPartSeconds(p.data?.sound,base):Math.max(.18,base*.98),notes=core.notesFor(card,p.data)||[];notes.forEach((n,j)=>{try{player.play(n,at+(p.data.instrument==='guitar'?j*.035:0),{duration,gain:.94});}catch{}});b+=durBeats;}
        }else{
          const stepBeats=4/p.resolution;for(const e of p.events||[]){const at=startAt+e.step*stepBeats*beatSec;let midi=e.midi+(Number(p.octave)||0)*12;if(core.isBassSound?.(p.sound)||p.sound==='electric_bass_finger')midi-=12;const drawn=leadDurationSteps(e)*stepBeats,duration=p.sustain&&drawn<=stepBeats?sustainedPartSeconds(p.sound,beatSec):Math.max(.05,drawn*beatSec*.98);try{player.play(midiName(midi),at,{duration,gain:.92});}catch{}}
        }
      }
      // Vocal parts: render the Vox Box arrangement (placement, trims and clip FX).
      for(const p of selected.filter(x=>x.type==='vocal')){
        const makeExportFx=(src,fx,volume)=>{const eq=ctx.createBiquadFilter(),comp=ctx.createDynamicsCompressor(),dry=ctx.createGain(),wet=ctx.createGain(),rev=ctx.createConvolver(),delay=ctx.createDelay(1),delayGain=ctx.createGain(),out=ctx.createGain();eq.type=fx.eq==='warm'?'lowshelf':fx.eq==='bright'?'highshelf':'peaking';eq.frequency.value=fx.eq==='warm'?180:fx.eq==='bright'?4500:2800;eq.gain.value=fx.eq==='flat'?0:fx.eq==='warm'?2:fx.eq==='bright'?2.5:1.5;const c=fx.comp||'medium';comp.threshold.value=c==='off'?0:c==='light'?-12:c==='heavy'?-24:-18;comp.ratio.value=c==='off'?1:c==='light'?2:c==='heavy'?6:3.5;comp.attack.value=.008;comp.release.value=.12;dry.gain.value=1;wet.gain.value=Number(fx.reverb||0);rev.buffer=impulse(ctx,fx.reverb>.25?1.6:fx.reverb>.15?1.1:.7);delay.delayTime.value=Number(fx.delay||0);delayGain.gain.value=fx.delay?0.22:0;out.gain.value=Math.max(0,Math.min(1.5,volume));const tune=makeAutotuneNode(ctx,p,fx);src.connect(eq);eq.connect(comp);const post=tune||comp;if(tune)comp.connect(tune);post.connect(dry);dry.connect(out);post.connect(rev);rev.connect(wet);wet.connect(out);post.connect(delay);delay.connect(delayGain);delayGain.connect(out);out.connect(mix);};
        const events=voxTrackEvents(p);
        if(events.length){
          const period=Math.max(.001,...events.map(e=>(Number(e.startBeat)||0)+voxEventDurationBeats(e)));
          const cycles=p.repeat?Math.max(1,Math.ceil((songSec/beatSec)/period)):1;
          for(let cyc=0;cyc<cycles;cyc++)for(const e of events){const key=`${e.sourcePartId}:${e.takeId}`,buf=vocalBuffers.get(key);if(!buf)continue;const trimStart=Math.max(0,Math.min(buf.duration,Number(e.trimStartSec)||0)),trimEnd=Math.max(trimStart,Math.min(buf.duration,Number.isFinite(Number(e.trimEndSec))&&Number(e.trimEndSec)>0?Number(e.trimEndSec):buf.duration)),dur=Math.max(0,trimEnd-trimStart),when=(Number(e.startBeat)||0)*beatSec+cyc*period*beatSec;if(dur<=.005||when>=songSec)continue;const playDur=Math.min(dur,songSec-when);if(playDur<=.005)continue;const src=ctx.createBufferSource();src.buffer=buf;makeExportFx(src,effectiveVocalFx(p,e),(Number(p.volume)||0)*Math.max(0,Math.min(1.5,Number(e.volume)||0)));src.start(startAt+when,trimStart,playDur);}
        }else if(p.activeTakeId){
          const key=`${p.id}:${p.activeTakeId}`,buf=vocalBuffers.get(key);if(!buf)continue;const schedule=(when=0)=>{if(when>=songSec)return;const src=ctx.createBufferSource();src.buffer=buf;makeExportFx(src,effectiveVocalFx(p),Number(p.volume)||0);src.start(startAt+when,0,Math.min(buf.duration,songSec-when));};schedule(0);if(p.repeat&&buf.duration>0)for(let t=buf.duration;t<songSec-.05;t+=buf.duration)schedule(t);
        }
      }
      // Drum pattern loops for the length of the selected song mix, matching normal playback.
      if(drums&&beat&&drumBuffers.size){const stepSec=beatSec/16,totalSteps=Math.ceil(songSec/stepSec),bars=Math.max(1,Number(beat.bars)||1),gain=Math.max(0,Math.min(1,Number(beat.gain)||0))*AUDIO_EXPORT_DRUM_SCALE;for(let abs=0;abs<totalSteps;abs++){const bar=Math.floor(abs/64)%bars,step=abs%64,at=startAt+abs*stepSec;for(const [id,buf] of drumBuffers){if(!beat.tracks?.[id]?.[bar]?.includes(step))continue;const src=ctx.createBufferSource(),g=ctx.createGain();src.buffer=buf;g.gain.value=gain;src.connect(g).connect(mix);src.start(at);}}}

      go.textContent='Rendering WAV…';
      await sleep((leadSec+songSec+tailSec+.25)*1000);
      proc.onaudioprocess=null;try{proc.disconnect();silent.disconnect();}catch{}
      const trim=Math.max(0,Math.round((startAt-captureStart)*ctx.sampleRate)),wanted=Math.max(1,Math.round((songSec+tailSec)*ctx.sampleRate));
      const allL=concatFloatChunks(L,captured),allR=concatFloatChunks(R,captured),left=allL.slice(trim,trim+wanted),right=allR.slice(trim,trim+wanted),wav=wavFromStereo(left,right,ctx.sampleRate);
      const a=document.createElement('a');a.href=URL.createObjectURL(wav);a.download=`${safeFileName(core.projectName)}-Audio-Mix.wav`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),5000);closeAudioExport();core.status('Audio mix exported as WAV.');
    }catch(e){console.error('Audio export failed',e);core.status(e.message||'Could not export audio mix.');if(go){go.disabled=false;go.textContent='Export WAV';}}
    finally{try{await ctx?.close();}catch{}}
  }

  function capture(){syncLoadedChord();partsUpdatedAt=Math.max(partsUpdatedAt,Date.now());const safe=parts.map(p=>{const q=clone(p);delete q._recordOldStates;delete q._recordOldVolumes;delete q._recordOldDrums;delete q._recordOldDrumVol;if(q.type==='vocal')q.recordings=(q.recordings||[]).map(({blob,...r})=>r);return q;});return {version:4,updatedAt:partsUpdatedAt,activePartId,songEndBeat:Number.isFinite(Number(songEndBeat))&&Number(songEndBeat)>0?Number(songEndBeat):null,items:safe};}
  function loadProject(project){
    stopPlayback();stopPreview();
    const saved=project?.parts;
    partsUpdatedAt=Number(saved?.updatedAt||project?.updatedAt||0)||0;
    songEndBeat=Number.isFinite(Number(saved?.songEndBeat))&&Number(saved.songEndBeat)>0?Number(saved.songEndBeat):null;
    if(saved?.items?.length){parts=saved.items.map(normalizePart).filter(Boolean);activePartId=parts.some(p=>p.id===saved.activePartId)?saved.activePartId:(parts.find(p=>p.type==='chord')||parts[0]).id;}
    else {const first=chordPart('Chords 1',core.snapshot());parts=[first];activePartId=first.id;}
    let c=parts.find(p=>p.id===activePartId&&p.type==='chord')||parts.find(p=>p.type==='chord');
    if(!c){c=chordPart('Chords 1',core.snapshot());parts.unshift(c);}core.apply(c.data);loadedChordPartId=c.id;
    if(activePartId!==c.id)selectPart(activePartId);else{setEditorMode('chord');renderParts();}
    renderSongEndEditor();
  }
  function newProject(){stopPlayback();stopPreview();partsUpdatedAt=0;songEndBeat=null;const p=chordPart('Chords 1',core.snapshot());parts=[p];activePartId=p.id;loadedChordPartId=p.id;setEditorMode('chord');renderParts();renderSongEndEditor();}

  function openLyricsOverlay(){
    const overlay=$('srpLyricsOverlay'),frame=$('srpLyricsFrame');if(!overlay||!frame)return;
    try{
      if(core.currentProjectId)localStorage.setItem('crp-active-project-id',String(core.currentProjectId));
      localStorage.setItem('crp-workspace-mode-v1','baby-daw');
    }catch{}
    frame.src='song-rider/index.html?crpMode=1&lyricsOverlay=1#full';
    overlay.hidden=false;document.body.style.overflow='hidden';
    setTimeout(()=>{try{frame.contentWindow?.postMessage({type:'srp-show-full-song'},location.origin)}catch{}},500);
    updateFloatRecorder();
  }
  function closeLyricsOverlay(){const overlay=$('srpLyricsOverlay'),frame=$('srpLyricsFrame');if(overlay)overlay.hidden=true;if(frame)frame.src='about:blank';document.body.style.overflow='';}
  function updateFloatRecorder(){
    const r=$('srpFloatRecord'),pa=$('srpFloatPause'),st=$('srpFloatStop');if(!r||!pa||!st)return;
    r.disabled=recording;r.textContent=recording?'●':'●';
    pa.disabled=!recording;pa.textContent=recordingPaused?'▶':'Ⅱ';
    st.disabled=!recording;
  }

  // =========================
  // Vox Box — DAW-style non-destructive event editor (v3.3.24)
  // =========================
  function voxPpb(){return window.innerWidth<=600?44:56;}
  function voxLabelWidth(){return window.innerWidth<=600?96:132;}
  function voxBeatStep(){const den=Math.max(4,Math.min(64,Number($('voxSnapResolution')?.value)||16));return 4/den;}
  function voxSnapEnabled(){return !!$('voxSnapToBeat')?.checked;}
  function quantizeVoxBeat(beat){const b=Math.max(0,Number(beat)||0);if(!voxSnapEnabled())return Math.round(b*1000)/1000;const st=voxBeatStep();return Math.max(0,Math.round(b/st)*st);}
  function voxSelectionPairs(){
    const out=[];
    for(const sel of Array.isArray(voxSelections)?voxSelections:[]){
      const part=parts.find(p=>p.type==='vocal'&&String(p.id)===String(sel.partId));
      const event=part?.voxEvents?.find(e=>String(e.id)===String(sel.eventId));
      if(part&&event)out.push({part,event});
    }
    return out;
  }
  function voxSelectedPair(){
    const pairs=voxSelectionPairs();
    if(pairs.length){voxSelected={partId:pairs[0].part.id,eventId:pairs[0].event.id};return pairs[0];}
    voxSelected=null;return {part:null,event:null};
  }
  function voxIsSelected(partId,eventId){return voxSelections.some(s=>String(s.partId)===String(partId)&&String(s.eventId)===String(eventId));}
  function voxTargetPart(){return parts.find(p=>p.type==='vocal'&&String(p.id)===String(voxTargetPartId))||voxSelectedPair().part||allVocalParts()[0]||null;}
  function voxTimelineBeats(){const natural=Math.max(0,naturalSongDurationBeats()),maxEvent=Math.max(0,...allVocalParts().flatMap(p=>voxTrackEvents(p).map(e=>(Number(e.startBeat)||0)+voxEventDurationBeats(e))));return Math.max(16,Math.ceil((Math.max(natural,maxEvent,voxPlayheadBeat+1)+4)/4)*4);}
  function voxStatus(msg){if($('voxBoxStatus'))$('voxBoxStatus').textContent=msg||'';}
  function persistVoxEdits(){markPartsDirty();playbackTotalBeats=mediaDurationBeats();renderSongEndEditor();core.scheduleAutoSave();core.flushAutoSaveNow?.();}
  function voxSetSelection(part,event,{add=false,toggle=false,render=true}={}){
    if(!part||!event)return;
    voxInspectorManualOverride=null;
    voxInstrumentSelections=[];voxInstrumentSelection=null;voxInstrumentTrackFocus=null;voxTargetPartId=part.id;
    const key=s=>String(s.partId)===String(part.id)&&String(s.eventId)===String(event.id),exists=voxSelections.some(key);
    if(toggle&&exists)voxSelections=voxSelections.filter(s=>!key(s));
    else if(add){if(!exists)voxSelections.push({partId:part.id,eventId:event.id});}
    else voxSelections=[{partId:part.id,eventId:event.id}];
    voxSelected=voxSelections[0]||null;
    // Multi-selection means the user's next FX move should edit the selected clips,
    // not accidentally rewrite only the last track's global effects.
    if(voxSelections.length>1&&$('voxFxTarget'))$('voxFxTarget').value='event';
    if(render){renderVoxInspector();renderVoxSelectionClasses();}
  }
  function clearVoxSelection({render=true,keepInstrumentFocus=false}={}){voxInspectorManualOverride=null;voxSelections=[];voxSelected=null;voxInstrumentSelections=[];voxInstrumentSelection=null;if(!keepInstrumentFocus)voxInstrumentTrackFocus=null;if(render){renderVoxInspector();renderVoxSelectionClasses();}}
  function renderVoxSelectionClasses(){
    document.querySelectorAll('.vox-event').forEach(el=>el.classList.toggle('is-selected',voxIsSelected(el.dataset.voxPartId,el.dataset.voxEventId)));
    document.querySelectorAll('.vox-instrument-event').forEach(el=>el.classList.toggle('is-selected',voxInstrumentIsSelected(el.dataset.voxKey)));
  }
  function voxEventBounds(e){const start=Math.max(0,Number(e?.startBeat)||0),dur=Math.max(.001,voxEventDurationBeats(e));return {start,end:start+dur,dur};}
  function setVoxAutoScroll(on,{manual=false,persist=true}={}){
    voxAutoScroll=!!on;if(persist){try{localStorage.setItem(VOX_AUTO_KEY,voxAutoScroll?'1':'0')}catch{}}
    const b=$('voxAutoScrollBtn');if(b){b.classList.toggle('is-active',voxAutoScroll);b.setAttribute('aria-pressed',String(voxAutoScroll));b.textContent='↔ Auto';b.title=voxAutoScroll?'AutoScroll on — follows the playhead':'AutoScroll off';}
    if(manual&&!voxAutoScroll)voxStatus('AutoScroll off — manual navigation detected.');
  }
  function disableVoxAutoScroll(){if(voxAutoScroll)setVoxAutoScroll(false,{manual:true});}
  function updateVoxPlayhead(beat,scrollIntoView=false){
    voxPlayheadBeat=Math.max(0,Math.min(voxTimelineBeats(),Number(beat)||0));
    const x=voxLabelWidth()+voxPlayheadBeat*voxPpb(),ph=$('voxPlayhead');if(ph)ph.style.left=`${x}px`;
    if(scrollIntoView){const sc=$('voxTimelineScroller');if(sc){const left=sc.scrollLeft,right=left+sc.clientWidth-140;if(x<left+voxLabelWidth()+20)sc.scrollTo({left:Math.max(0,x-voxLabelWidth()-30),behavior:'smooth'});else if(x>right)sc.scrollTo({left:Math.max(0,x-sc.clientWidth+190),behavior:'smooth'});}}
  }
  function voxSeekTo(beat,{manual=false}={}){
    if(recording&&!recordingPaused){voxStatus('Pause or stop recording before moving the playhead.');return;}
    const target=Math.max(0,Math.min(mediaDurationBeats(),Number(beat)||0));
    if(manual)disableVoxAutoScroll();
    updateVoxPlayhead(target,true);
    if(playing||starting)seekPlaybackToBeat(target);else mediaPausedBeat=target;
    updateVoxTransportState();
  }
  async function drawVoxWaveform(canvas,event,token){
    if(!canvas?.isConnected||token!==voxRenderToken)return;
    try{
      const buf=await vocalBufferForTake(event.takeId,event.sourcePartId);if(!buf||!canvas.isConnected||token!==voxRenderToken)return;
      const rect=canvas.getBoundingClientRect(),dpr=Math.max(1,Math.min(2,window.devicePixelRatio||1)),w=Math.max(20,Math.round(rect.width*dpr)),h=Math.max(20,Math.round(rect.height*dpr));
      canvas.width=w;canvas.height=h;const g=canvas.getContext('2d');if(!g)return;g.clearRect(0,0,w,h);g.strokeStyle='rgba(42,36,27,.72)';g.lineWidth=Math.max(1,dpr);
      const data=buf.getChannelData(0),startSec=Math.max(0,Number(event.trimStartSec)||0),endSec=Math.min(buf.duration,Number.isFinite(Number(event.trimEndSec))&&Number(event.trimEndSec)>0?Number(event.trimEndSec):buf.duration),i0=Math.max(0,Math.floor(startSec*buf.sampleRate)),i1=Math.min(data.length,Math.ceil(endSec*buf.sampleRate)),span=Math.max(1,i1-i0),mid=h/2;
      g.beginPath();for(let x=0;x<w;x++){const a=i0+Math.floor(x/w*span),b=Math.min(i1,a+Math.max(1,Math.ceil(span/w)));let lo=1,hi=-1;for(let i=a;i<b;i++){const v=data[i]||0;if(v<lo)lo=v;if(v>hi)hi=v;}g.moveTo(x,mid-hi*mid*.82);g.lineTo(x,mid-lo*mid*.82);}g.stroke();
    }catch(err){console.warn('Could not draw Vox Box waveform',err);}
  }
  function queueLiveVoxWaveform(canvas,event){if(!canvas||!event)return;if(canvas.__voxWaveRaf)return;canvas.__voxWaveRaf=requestAnimationFrame(()=>{canvas.__voxWaveRaf=0;drawVoxWaveform(canvas,event,voxRenderToken);});}
  function updateVoxEventReadout(el,event){if(!el||!event)return;const b=voxEventBounds(event),time=el.querySelector('.vox-event-time');if(time)time.textContent=`${b.start.toFixed(2)}–${b.end.toFixed(2)}b`;}

  function voxSnapshot(){return {parts:clone(parts),beat:window.CRPBeatMaker?.getBeat?.()||null,activePartId,loadedChordPartId,voxTargetPartId,voxPlayheadBeat};}
  function updateVoxHistoryButtons(){if($('voxUndoBtn'))$('voxUndoBtn').disabled=!voxUndoStack.length;if($('voxRedoBtn'))$('voxRedoBtn').disabled=!voxRedoStack.length;}
  function voxCheckpoint(){voxUndoStack.push(voxSnapshot());if(voxUndoStack.length>50)voxUndoStack.shift();voxRedoStack=[];updateVoxHistoryButtons();}
  function restoreVoxSnapshot(snap){
    if(!snap)return;parts=(snap.parts||[]).map((p,i)=>normalizePart(p,i)).filter(Boolean);ensureInitial();
    activePartId=parts.some(p=>String(p.id)===String(snap.activePartId))?snap.activePartId:(parts[0]?.id||null);
    loadedChordPartId=parts.some(p=>p.type==='chord'&&String(p.id)===String(snap.loadedChordPartId))?snap.loadedChordPartId:(parts.find(p=>p.type==='chord')?.id||null);
    if(snap.beat)window.CRPBeatMaker?.setBeat?.(snap.beat,{persist:true});
    voxTargetPartId=parts.some(p=>p.type==='vocal'&&String(p.id)===String(snap.voxTargetPartId))?snap.voxTargetPartId:(allVocalParts()[0]?.id||null);voxPlayheadBeat=Math.max(0,Number(snap.voxPlayheadBeat)||0);voxSelections=[];voxSelected=null;voxInstrumentSelections=[];voxInstrumentSelection=null;voxInstrumentTrackFocus=null;
    const c=parts.find(p=>p.type==='chord'&&String(p.id)===String(loadedChordPartId));if(c)core.apply(c.data);
    renderParts();persistVoxEdits();renderVoxBox();
  }
  function voxUndo(){if(!voxUndoStack.length)return;voxRedoStack.push(voxSnapshot());restoreVoxSnapshot(voxUndoStack.pop());updateVoxHistoryButtons();voxStatus('Undo.');}
  function voxRedo(){if(!voxRedoStack.length)return;voxUndoStack.push(voxSnapshot());restoreVoxSnapshot(voxRedoStack.pop());updateVoxHistoryButtons();voxStatus('Redo.');}

  function voxInstrumentSelectionList(){return Array.isArray(voxInstrumentSelections)?voxInstrumentSelections.filter(Boolean):[];}
  function voxInstrumentIsSelected(key){return voxInstrumentSelectionList().some(x=>String(x.key)===String(key));}
  function setVoxInstrumentSelection(sel,{add=false,toggle=false,render=true}={}){
    voxInspectorManualOverride=null;
    voxSelections=[];voxSelected=null;
    if(!sel){voxInstrumentSelections=[];voxInstrumentSelection=null;if(render){renderVoxSelectionClasses();renderVoxInspector();}return;}
    voxInstrumentTrackFocus={kind:sel.kind||'instrument',name:sel.kind==='drum'?'Beat':(sel.part?.name||'Instrument'),key:sel.kind==='drum'?'beat':(sel.part?.id?`part:${sel.part.id}`:null)};
    const exists=voxInstrumentIsSelected(sel.key);
    if(toggle&&exists)voxInstrumentSelections=voxInstrumentSelections.filter(x=>String(x.key)!==String(sel.key));
    else if(add){if(!exists)voxInstrumentSelections.push(sel);}
    else voxInstrumentSelections=[sel];
    voxInstrumentSelection=voxInstrumentSelections[0]||null;
    if(render){renderVoxSelectionClasses();renderVoxInspector();}
  }
  function instrumentalSelectionDescription(){
    const list=voxInstrumentSelectionList(),s=list[0];if(!s)return '';
    if(list.length>1)return `${list.length} instrument events selected`;
    if(s.kind==='drum')return `Beat • ${s.name||s.drumId} at beat ${s.startBeat.toFixed(2)}`;
    if(s.kind==='lead')return `${s.part?.name||'Lead'} • ${midiName(s.event?.midi||60)} at beat ${s.startBeat.toFixed(2)}`;
    if(s.kind==='chord')return `${s.part?.name||'Chords'} • ${s.card?.value||'event'} at beat ${s.startBeat.toFixed(2)}`;
    return 'Instrument event';
  }
  function voxTrackTokenForPart(part){return part?`part:${part.id}`:'';}
  function readVoxTrackOrder(){try{const a=JSON.parse(localStorage.getItem(VOX_TRACK_ORDER_KEY)||'[]');return Array.isArray(a)?a:[];}catch{return [];}}
  function writeVoxTrackOrder(a){try{localStorage.setItem(VOX_TRACK_ORDER_KEY,JSON.stringify(a||[]));}catch{}}
  function applyVoxTrackOrder(){
    const host=$('voxTracks');if(!host)return;const rows=[...host.querySelectorAll(':scope > .vox-track-row[data-vox-track-key]')];if(rows.length<2)return;
    const saved=readVoxTrackOrder(),rank=new Map(saved.map((k,i)=>[String(k),i]));rows.sort((a,b)=>{const ak=String(a.dataset.voxTrackKey||''),bk=String(b.dataset.voxTrackKey||'');const ar=rank.has(ak)?rank.get(ak):1e6,br=rank.has(bk)?rank.get(bk):1e6;return ar-br;});rows.forEach(r=>host.appendChild(r));
  }
  function persistCurrentVoxTrackOrder(){const host=$('voxTracks');if(!host)return;const order=[...host.querySelectorAll(':scope > .vox-track-row[data-vox-track-key]')].map(r=>r.dataset.voxTrackKey);writeVoxTrackOrder(order);const rank=new Map(order.filter(k=>String(k).startsWith('part:')).map((k,i)=>[String(k).slice(5),i]));parts.sort((a,b)=>(rank.get(String(a.id))??1e6)-(rank.get(String(b.id))??1e6));markPartsDirty();renderParts();core.scheduleAutoSave();core.flushAutoSaveNow?.();}
  function wireVoxTrackLongPress(label,row){
    if(!label||!row||label.dataset.reorderWired)return;label.dataset.reorderWired='1';label.classList.add('vox-track-reorder-handle');
    label.addEventListener('contextmenu',e=>e.preventDefault());
    label.addEventListener('pointerdown',e=>{
      if(e.target.closest('button,select,input[type="checkbox"]'))return;if(e.button!==undefined&&e.button!==0)return;
      const pid=e.pointerId,startY=e.clientY,host=row.parentElement;let active=false,moved=false,lastY=startY;
      const cleanup=()=>{window.removeEventListener('pointermove',move,true);window.removeEventListener('pointerup',up,true);window.removeEventListener('pointercancel',up,true);document.body.classList.remove('vox-track-reordering');};
      const timer=setTimeout(()=>{active=true;row.classList.add('is-reordering');document.body.classList.add('vox-track-reordering');try{label.setPointerCapture(pid)}catch{};if(navigator.vibrate)try{navigator.vibrate(18)}catch{};voxStatus('Track reorder — drag up or down, then release.');},360);
      const move=ev=>{
        if(ev.pointerId!==pid)return;lastY=ev.clientY;if(Math.abs(lastY-startY)>5)moved=true;if(!active)return;ev.preventDefault();
        // Do not rely on elementsFromPoint here. On mobile the sticky label and the
        // elevated dragged row can remain the top hit target, so the row lights up
        // but never crosses another track. Reorder directly from row midpoints.
        const rows=[...host.querySelectorAll(':scope > .vox-track-row[data-vox-track-key]')].filter(r=>r!==row);
        let before=null;for(const candidate of rows){const r=candidate.getBoundingClientRect();if(lastY<r.top+r.height/2){before=candidate;break;}}
        if(before){if(row.nextElementSibling!==before)host.insertBefore(row,before);}else if(host.lastElementChild!==row)host.appendChild(row);
      };
      const up=ev=>{
        if(ev.pointerId!==pid)return;clearTimeout(timer);cleanup();
        if(active){try{label.releasePointerCapture(pid)}catch{};row.classList.remove('is-reordering');persistCurrentVoxTrackOrder();voxStatus('Track order updated.');}
        else if(moved){/* normal gesture before the long-press threshold */}
      };
      window.addEventListener('pointermove',move,{passive:false,capture:true});window.addEventListener('pointerup',up,true);window.addEventListener('pointercancel',up,true);
    });
  }
  function focusVoxInstrumentTrack(kind,name,key=null){
    voxInspectorManualOverride=null;
    voxSelections=[];voxSelected=null;voxInstrumentSelections=[];voxInstrumentSelection=null;
    voxInstrumentTrackFocus={kind:kind||'instrument',name:name||'Instrument',key:key||null};
    renderVoxSelectionClasses();renderVoxInspector();
  }
  function setVoxInspectorCollapsed(on){
    const box=document.querySelector('.vox-inspector');if(!box)return;
    const collapsed=!!on;box.classList.toggle('is-collapsed',collapsed);box.setAttribute('aria-expanded',String(!collapsed));
    const btn=$('voxInspectorToggleBtn');if(btn){btn.textContent=collapsed?'Show':'Hide';btn.setAttribute('aria-expanded',String(!collapsed));btn.title=collapsed?'Show Track Effects':'Hide Track Effects';}
  }
  function toggleVoxInspector(){
    const box=document.querySelector('.vox-inspector');if(!box)return;const next=!box.classList.contains('is-collapsed');voxInspectorManualOverride=next;setVoxInspectorCollapsed(next);
  }
  function renderVoxInspector(){
    const inst=voxInstrumentSelectionList()[0]||null,instList=voxInstrumentSelectionList();
    const ids=['voxFxVolume','voxFxEq','voxFxComp','voxFxReverb','voxFxDelay','voxFxAutotune','voxFxTarget','voxResetEventFxBtn'];
    const instrumentEditing=!!(inst||voxInstrumentTrackFocus);
    setVoxInspectorCollapsed(voxInspectorManualOverride===null?instrumentEditing:voxInspectorManualOverride);
    if(instrumentEditing){
      const focusName=inst?instrumentalSelectionDescription():(voxInstrumentTrackFocus?.name||'Instrument track');
      if($('voxInspectorTitle'))$('voxInspectorTitle').textContent=inst?'Instrument Event':'Instrument Track';
      if($('voxInspectorMeta'))$('voxInspectorMeta').textContent=`${focusName} • Vocal Effects collapsed while editing instruments. Select a vocal track or clip to reopen them.`;
      ids.forEach(id=>{if($(id))$(id).disabled=true;});
      for(const id of ['voxCropBtn','voxSplitBtn'])if($(id))$(id).disabled=true;
      for(const id of ['voxCopyBtn','voxCutBtn','voxDeleteBtn'])if($(id))$(id).disabled=!inst;
      if($('voxPasteBtn'))$('voxPasteBtn').disabled=!voxClipboard;updateVoxHistoryButtons();return;
    }
    const part=voxTargetPart(),pairs=voxSelectionPairs(),primary=pairs[0]||{part:null,event:null},event=primary.event,fxTarget=$('voxFxTarget');if(!part)return;
    ids.forEach(id=>{if($(id))$(id).disabled=false;});
    if(fxTarget){const opt=fxTarget.querySelector('option[value="event"]');if(opt){opt.disabled=!pairs.length;opt.textContent=pairs.length>1?`Selected Events (${pairs.length})`:'Selected Event';}if(!pairs.length&&fxTarget.value==='event')fxTarget.value='track';}
    const useEvent=!!(pairs.length&&fxTarget?.value==='event'),fx=useEvent?effectiveVocalFx(primary.part,event):effectiveVocalFx(part),vol=useEvent?Math.max(0,Math.min(1.5,Number(event.volume)||0)):Math.max(0,Math.min(1.5,Number(part.volume)||0));
    if($('voxInspectorTitle'))$('voxInspectorTitle').textContent=useEvent?(pairs.length>1?'Selected Event Effects':'Event Effects'):'Track Effects';
    if($('voxInspectorMeta'))$('voxInspectorMeta').textContent=useEvent?(pairs.length>1?`${pairs.length} vocal events selected • edits apply to all selected clips`:`${primary.part.name} • ${voxEventTake(event)?.name||'Vocal event'}${event.fx?' • override':' • using track FX'}`):`${part.name} • affects all events without an override`;
    if($('voxFxVolume'))$('voxFxVolume').value=String(Math.round(vol*100));if($('voxFxVolumeValue'))$('voxFxVolumeValue').textContent=`${Math.round(vol*100)}%`;
    if($('voxFxEq'))$('voxFxEq').value=fx.eq;if($('voxFxComp'))$('voxFxComp').value=fx.comp;if($('voxFxReverb'))$('voxFxReverb').value=String(fx.reverb);if($('voxFxDelay'))$('voxFxDelay').value=String(fx.delay);if($('voxFxAutotune'))$('voxFxAutotune').value=String(Math.round(Number(fx.autotune)||0));if($('voxFxAutotuneValue'))$('voxFxAutotuneValue').textContent=`${Math.round(Number(fx.autotune)||0)}%`;
    if($('voxResetEventFxBtn'))$('voxResetEventFxBtn').disabled=!(pairs.length&&pairs.some(({event:e})=>e.fx||Number(e.volume)!==1));
    for(const id of ['voxCropBtn','voxSplitBtn','voxCopyBtn','voxCutBtn','voxDeleteBtn'])if($(id))$(id).disabled=!pairs.length;
    if($('voxPasteBtn'))$('voxPasteBtn').disabled=!voxClipboard;updateVoxHistoryButtons();
  }

  function makeVoxTrackLabel({name,meta,checked=null,onChecked=null,kind='vocal'}){
    const label=document.createElement('div');label.className='vox-track-label'+(kind!=='vocal'?' vox-instrument-label':'');
    if(checked!==null){const top=document.createElement('label');top.className='vox-track-enable';const c=document.createElement('input');c.type='checkbox';c.checked=!!checked;c.onpointerdown=e=>e.stopPropagation();c.onchange=e=>{e.stopPropagation();onChecked?.(c.checked);};const strong=document.createElement('strong');strong.textContent=name;top.append(c,strong);label.append(top);}else{const strong=document.createElement('strong');strong.textContent=name;label.append(strong);}
    const span=document.createElement('span');span.textContent=meta||'';label.append(span);return label;
  }
  function chordFlatItems(part){
    const out=[];let beat=0,flatIndex=0;for(let ri=0;ri<(part.data?.rows||[]).length;ri++){const row=part.data.rows[ri]||[];for(let ci=0;ci<row.length;ci++){const card=row[ci],dur=core.cardDurationBeats?.(card,core.beats)||core.beats;out.push({card,rowIndex:ri,cardIndex:ci,flatIndex,startBeat:beat,dur});beat+=dur;flatIndex++;}}return out;
  }
  function reorderChordCardToBeat(part,card,targetBeat){
    const rows=part.data?.rows||[];const lengths=rows.map(r=>r.length),flat=rows.flat();const old=flat.indexOf(card);if(old<0||flat.length<2)return;
    flat.splice(old,1);let beat=0,idx=flat.length;for(let i=0;i<flat.length;i++){const dur=core.cardDurationBeats?.(flat[i],core.beats)||core.beats;if(targetBeat<beat+dur/2){idx=i;break;}beat+=dur;}flat.splice(idx,0,card);let pos=0;part.data.rows=lengths.map(len=>{const r=flat.slice(pos,pos+len);pos+=len;return r;});
  }
  function renderVoxDrumMap(tracks,width,ppb){
    if(!voxShowInstrumentals||!voxDrumMapOpen)return;const beat=window.CRPBeatMaker?.getBeat?.();if(!beat)return;
    const defs=window.CRPBeatMaker?.getDrumDefs?.()||[],res=[8,16,32,64].includes(+beat.resolution)?+beat.resolution:16,cols=Math.max(1,beat.bars*res),canonicalStep=64/res;
    const row=document.createElement('div');row.className='vox-track-row vox-drum-map-row';row.style.width=`${width}px`;row.dataset.voxTrackKey='drum-map';row.dataset.voxKind='drum-map';row.classList.toggle('is-instrument-focus',voxInstrumentTrackFocus?.key==='drum-map');
    // The old fixed 180px row was shorter than the 19-row drum grid (418px),
    // so mobile rendered the following vocal lane on top of the map. Size the
    // track to the real grid height so every drum row owns its vertical space.
    const drumRowHeight=22,drumMapHeight=Math.max(180,defs.length*drumRowHeight+2);
    row.style.setProperty('--vox-drum-map-height',`${drumMapHeight}px`);
    const label=document.createElement('div');label.className='vox-track-label vox-instrument-label';label.innerHTML='<strong>Drum Map</strong><span>Click cells to add/remove hits</span>';label.onclick=e=>{if(e.target.closest('button,input,select'))return;focusVoxInstrumentTrack('drum-map','Drum Map','drum-map');renderVoxBox();};
    const lane=document.createElement('div');lane.className='vox-drum-map-lane';lane.onclick=e=>{if(e.target!==lane&&e.target!==grid)return;focusVoxInstrumentTrack('drum-map','Drum Map','drum-map');};
    const grid=document.createElement('div');grid.className='vox-drum-map-grid';grid.style.setProperty('--vox-drum-cols',String(cols));
    for(const d of defs){const name=document.createElement('div');name.className='vox-drum-map-name';name.textContent=d.name;grid.appendChild(name);for(let c=0;c<cols;c++){const bar=Math.floor(c/res),local=c%res,step=local*canonicalStep,on=(beat.tracks?.[d.id]?.[bar]||[]).some(x=>Number(x)===step),cell=document.createElement('button');cell.type='button';cell.className='vox-drum-cell'+(on?' on':'')+(local===0?' bar-start':'');cell.title=`${d.name} • Bar ${bar+1} • ${(local*4/res+1).toFixed(2)} beat`;cell.onclick=e=>{e.stopPropagation();voxInstrumentTrackFocus={kind:'drum-map',name:'Drum Map',key:'drum-map'};voxSelections=[];voxSelected=null;voxInstrumentSelections=[];voxInstrumentSelection=null;voxCheckpoint();const b=window.CRPBeatMaker?.getBeat?.();if(!b)return;const arr=b.tracks[d.id][bar]||[],has=arr.some(x=>Number(x)===step);b.tracks[d.id][bar]=has?arr.filter(x=>Number(x)!==step):[...new Set([...arr,step])].sort((a,z)=>a-z);window.CRPBeatMaker.setBeat(b,{persist:true});persistVoxEdits();renderParts();renderVoxBox();voxStatus(`${d.name} ${has?'removed':'added'} in Drum Map.`);};grid.appendChild(cell);}}
    lane.appendChild(grid);row.append(label,lane);tracks.appendChild(row);
  }
  function instrumentClickSelection(sel,evEl,e){
    e.stopPropagation();if(evEl.__voxDragged){evEl.__voxDragged=false;return;}if(evEl.__voxPointerSelected){evEl.__voxPointerSelected=false;renderVoxSelectionClasses();return;}const add=voxMultiSelect||e.ctrlKey||e.metaKey||e.shiftKey;setVoxInstrumentSelection(sel,{add,toggle:add});
  }
  function appendInstrumentHandles(ev,sel){
    if(sel.kind!=='lead'&&sel.kind!=='chord')return;const lh=document.createElement('span'),rh=document.createElement('span');lh.className='vox-inst-handle left';rh.className='vox-inst-handle right';lh.title='Drag start edge';rh.title='Drag end edge';lh.onpointerdown=e=>beginVoxInstrumentPointerEdit(e,sel,ev,'trim-left');rh.onpointerdown=e=>beginVoxInstrumentPointerEdit(e,sel,ev,'trim-right');ev.append(lh,rh);
  }
  function renderVoxInstrumentTracks(tracks,width,ppb,clickBeat){
    if(!voxShowInstrumentals)return;
    const beat=window.CRPBeatMaker?.getBeat?.();
    if(beat){
      const row=document.createElement('div');row.className='vox-track-row vox-instrument-track';row.style.width=`${width}px`;row.dataset.voxKind='drum';row.dataset.voxTrackKey='beat';row.classList.toggle('is-instrument-focus',voxInstrumentTrackFocus?.key==='beat');
      const hitCount=Object.values(beat.tracks||{}).reduce((n,bars)=>n+(bars||[]).slice(0,beat.bars).reduce((m,a)=>m+(a?.length||0),0),0);
      const label=makeVoxTrackLabel({name:'Beat',meta:`${beat.bars} bar${beat.bars===1?'':'s'} • ${hitCount} hits`,checked:beat.enabled,onChecked:on=>{voxCheckpoint();const b=window.CRPBeatMaker?.getBeat?.();if(b){b.enabled=on;window.CRPBeatMaker.setBeat(b,{persist:true});persistVoxEdits();renderVoxBox();}},kind:'drum'});label.onclick=e=>{if(e.target.closest('input,label'))return;focusVoxInstrumentTrack('drum','Beat','beat');renderVoxBox();};label.querySelector('strong')?.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();focusVoxInstrumentTrack('drum','Beat','beat');renderVoxBox();});
      const lane=document.createElement('div');lane.className='vox-track-lane vox-instrument-lane';lane.dataset.voxKind='drum';lane.onclick=e=>{if(e.target!==lane)return;focusVoxInstrumentTrack('drum','Beat','beat');if(voxToolMode==='playhead')voxSeekTo(clickBeat(e,lane),{manual:true});};
      const defs=new Map((window.CRPBeatMaker?.getDrumDefs?.()||[]).map(x=>[x.id,x.name]));
      for(const [drumId,bars] of Object.entries(beat.tracks||{}))for(let bar=0;bar<beat.bars;bar++)for(const step of (bars?.[bar]||[])){
        const startBeat=bar*4+Number(step)/16,key=`drum:${drumId}:${bar}:${step}`,ev=document.createElement('div');ev.className='vox-instrument-event vox-drum-event'+(voxInstrumentIsSelected(key)?' is-selected':'');ev.dataset.voxKey=key;ev.style.left=`${startBeat*ppb}px`;ev.style.width=`${Math.max(8,.16*ppb)}px`;ev.textContent=(defs.get(drumId)||drumId).replace(/\s+\d+$/,'');ev.title=`${defs.get(drumId)||drumId} • beat ${startBeat.toFixed(2)}`;
        const sel={kind:'drum',key,drumId,bar,step,startBeat,name:defs.get(drumId)||drumId};ev.onclick=e=>instrumentClickSelection(sel,ev,e);ev.onpointerdown=e=>beginVoxInstrumentPointerEdit(e,sel,ev,'move');lane.appendChild(ev);
      }
      row.append(label,lane);tracks.appendChild(row);wireVoxTrackLongPress(label,row);
    }
    for(const part of parts.filter(p=>p.type==='chord')){
      const items=chordFlatItems(part);if(!items.length)continue;const row=document.createElement('div');row.className='vox-track-row vox-instrument-track';row.style.width=`${width}px`;row.dataset.voxKind='chord';row.dataset.voxPartId=part.id;row.dataset.voxTrackKey=voxTrackTokenForPart(part);row.classList.toggle('is-instrument-focus',voxInstrumentTrackFocus?.key===voxTrackTokenForPart(part));
      const label=makeVoxTrackLabel({name:part.name,meta:`Chord/Note • ${items.length} events`,checked:part.enabled,onChecked:on=>{voxCheckpoint();part.enabled=on;persistVoxEdits();renderParts();renderVoxBox();},kind:'chord'});label.onclick=e=>{if(e.target.closest('input,label'))return;focusVoxInstrumentTrack('chord',part.name,`part:${part.id}`);renderVoxBox();};label.querySelector('strong')?.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();focusVoxInstrumentTrack('chord',part.name,`part:${part.id}`);renderVoxBox();});
      const lane=document.createElement('div');lane.className='vox-track-lane vox-instrument-lane';lane.dataset.voxKind='chord';lane.dataset.voxPartId=part.id;lane.onclick=e=>{if(e.target!==lane)return;focusVoxInstrumentTrack('chord',part.name,`part:${part.id}`);if(voxToolMode==='playhead')voxSeekTo(clickBeat(e,lane),{manual:true});};
      for(const item of items){const key=`chord:${part.id}:${item.flatIndex}`,ev=document.createElement('div');ev.className='vox-instrument-event vox-chord-event'+(voxInstrumentIsSelected(key)?' is-selected':'');ev.dataset.voxKey=key;ev.style.left=`${item.startBeat*ppb}px`;ev.style.width=`${Math.max(26,item.dur*ppb)}px`;ev.textContent=String(item.card?.value||'Chord');ev.title=`${part.name} • ${item.card?.value||'event'} • beat ${item.startBeat.toFixed(2)}`;const sel={kind:'chord',key,part,card:item.card,startBeat:item.startBeat,dur:item.dur,flatIndex:item.flatIndex};ev.onclick=e=>instrumentClickSelection(sel,ev,e);ev.onpointerdown=e=>{if(e.target.classList.contains('vox-inst-handle'))return;beginVoxInstrumentPointerEdit(e,sel,ev,'move');};appendInstrumentHandles(ev,sel);lane.appendChild(ev);}row.append(label,lane);tracks.appendChild(row);wireVoxTrackLongPress(label,row);
    }
    for(const part of parts.filter(p=>p.type==='lead')){
      const row=document.createElement('div');row.className='vox-track-row vox-instrument-track';row.style.width=`${width}px`;row.dataset.voxKind='lead';row.dataset.voxPartId=part.id;row.dataset.voxTrackKey=voxTrackTokenForPart(part);row.classList.toggle('is-instrument-focus',voxInstrumentTrackFocus?.key===voxTrackTokenForPart(part));
      const label=makeVoxTrackLabel({name:part.name,meta:`Lead/Bass • ${part.events?.length||0} notes`,checked:part.enabled,onChecked:on=>{voxCheckpoint();part.enabled=on;persistVoxEdits();renderParts();renderVoxBox();},kind:'lead'});label.onclick=e=>{if(e.target.closest('input,label'))return;focusVoxInstrumentTrack('lead',part.name,`part:${part.id}`);renderVoxBox();};label.querySelector('strong')?.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();focusVoxInstrumentTrack('lead',part.name,`part:${part.id}`);renderVoxBox();});
      const lane=document.createElement('div');lane.className='vox-track-lane vox-instrument-lane';lane.dataset.voxKind='lead';lane.dataset.voxPartId=part.id;lane.onclick=e=>{if(e.target!==lane)return;focusVoxInstrumentTrack('lead',part.name,`part:${part.id}`);if(voxToolMode==='playhead')voxSeekTo(clickBeat(e,lane),{manual:true});};
      const stepBeats=4/part.resolution;for(const event of part.events||[]){const startBeat=event.step*stepBeats,dur=Math.max(stepBeats,leadDurationSteps(event)*stepBeats),key=`lead:${part.id}:${event.step}:${event.midi}`,ev=document.createElement('div');ev.className='vox-instrument-event vox-lead-event'+(voxInstrumentIsSelected(key)?' is-selected':'');ev.dataset.voxKey=key;ev.style.left=`${startBeat*ppb}px`;ev.style.width=`${Math.max(22,dur*ppb)}px`;ev.textContent=midiName(event.midi);ev.title=`${part.name} • ${midiName(event.midi)} • beat ${startBeat.toFixed(2)}`;const sel={kind:'lead',key,part,event,startBeat,dur};ev.onclick=e=>instrumentClickSelection(sel,ev,e);ev.onpointerdown=e=>{if(e.target.classList.contains('vox-inst-handle'))return;beginVoxInstrumentPointerEdit(e,sel,ev,'move');};appendInstrumentHandles(ev,sel);lane.appendChild(ev);}row.append(label,lane);tracks.appendChild(row);wireVoxTrackLongPress(label,row);
    }
    renderVoxDrumMap(tracks,width,ppb);
  }
  function beginVoxInstrumentPointerEdit(e,sel,el,mode='move'){
    if(e.button!==undefined&&e.button!==0)return;e.preventDefault();e.stopPropagation();disableVoxAutoScroll();const add=voxMultiSelect||e.ctrlKey||e.metaKey||e.shiftKey;
    if(!voxInstrumentIsSelected(sel.key)){setVoxInstrumentSelection(sel,{add,render:false});el.classList.add('is-selected');el.__voxPointerSelected=true;}
    voxCheckpoint();const ppb=voxPpb(),startX=e.clientX,orig=sel.startBeat,origDur=Math.max(.001,Number(sel.dur)||.25),origEnd=orig+origDur;let current=orig,moved=false,targetLeadPart=sel.part;
    const moving=mode==='move'?voxInstrumentSelectionList().slice():[sel];const starts=new Map(moving.map(x=>[String(x.key),Number(x.startBeat)||0]));el.classList.add('is-dragging');if(mode!=='move')el.classList.add('is-trimming');try{el.setPointerCapture(e.pointerId);}catch{}
    const minBeat=voxSnapEnabled()?voxBeatStep():.03;
    const move=ev=>{ev.preventDefault();const dx=(ev.clientX-startX)/ppb;if(Math.abs(ev.clientX-startX)>3)moved=true;
      if(mode==='move'){
        current=quantizeVoxBeat(orig+dx);const delta=current-orig;
        for(const item of moving){const node=document.querySelector(`.vox-instrument-event[data-vox-key="${CSS.escape(String(item.key))}"]`),next=Math.max(0,quantizeVoxBeat((starts.get(String(item.key))||0)+delta));if(node)node.style.left=`${next*ppb}px`;item.__voxPreviewBeat=next;}
        if(moving.length===1&&sel.kind==='lead'){const lane=findVoxLaneAt(ev.clientX,ev.clientY);if(lane?.dataset.voxKind==='lead'){const p=parts.find(x=>x.type==='lead'&&String(x.id)===String(lane.dataset.voxPartId));if(p)targetLeadPart=p;}}
      }else if(sel.kind==='lead'){
        const p=sel.part,stepBeats=4/p.resolution;if(mode==='trim-right'){const targetEnd=Math.max(orig+minBeat,quantizeVoxBeat(origEnd+dx)),dur=targetEnd-orig;sel.event.durationSteps=Math.max(1,Math.round(dur/stepBeats));el.style.width=`${Math.max(22,sel.event.durationSteps*stepBeats*ppb)}px`;}
        else{const targetStart=Math.max(0,Math.min(origEnd-minBeat,quantizeVoxBeat(orig+dx))),endStep=Math.round(origEnd/stepBeats),newStep=Math.max(0,Math.round(targetStart/stepBeats));sel.event.step=newStep;sel.event.durationSteps=Math.max(1,endStep-newStep);el.style.left=`${newStep*stepBeats*ppb}px`;el.style.width=`${Math.max(22,sel.event.durationSteps*stepBeats*ppb)}px`;}
      }else if(sel.kind==='chord'){
        const items=chordFlatItems(sel.part),ix=items.findIndex(x=>x.card===sel.card),item=items[ix];if(!item)return;if(mode==='trim-right'){const targetEnd=Math.max(item.startBeat+minBeat,quantizeVoxBeat(item.startBeat+origDur+dx));sel.card.durationBeats=Math.max(minBeat,targetEnd-item.startBeat);el.style.width=`${Math.max(26,sel.card.durationBeats*ppb)}px`;}
        else if(ix>0){const prev=items[ix-1],end=item.startBeat+origDur,target=Math.max(prev.startBeat+minBeat,Math.min(end-minBeat,quantizeVoxBeat(item.startBeat+dx)));prev.card.durationBeats=Math.max(minBeat,target-prev.startBeat);sel.card.durationBeats=Math.max(minBeat,end-target);el.style.left=`${target*ppb}px`;el.style.width=`${Math.max(26,sel.card.durationBeats*ppb)}px`;}
      }};
    const up=ev=>{try{el.releasePointerCapture(ev.pointerId)}catch{};el.removeEventListener('pointermove',move);el.removeEventListener('pointerup',up);el.removeEventListener('pointercancel',up);el.classList.remove('is-dragging','is-trimming');el.__voxDragged=moved;if(!moved){voxUndoStack.pop();updateVoxHistoryButtons();return;}
      if(mode==='move')for(const item of moving){const targetBeat=Number(item.__voxPreviewBeat);delete item.__voxPreviewBeat;if(!Number.isFinite(targetBeat))continue;if(item.kind==='drum'){const b=window.CRPBeatMaker?.getBeat?.();if(b){b.tracks[item.drumId][item.bar]=(b.tracks[item.drumId][item.bar]||[]).filter(x=>Number(x)!==Number(item.step));const abs=Math.max(0,Math.min(16*64-1,Math.round(targetBeat*16))),bar=Math.floor(abs/64),step=abs%64;b.bars=Math.max(b.bars,Math.min(16,bar+1));b.tracks[item.drumId][bar]=[...new Set([...(b.tracks[item.drumId][bar]||[]),step])].sort((a,c)=>a-c);window.CRPBeatMaker.setBeat(b,{persist:true});}}
        else if(item.kind==='lead'&&item.part&&item.event){const src=item.part,dst=(moving.length===1?(targetLeadPart||src):src),srcStepBeats=4/src.resolution,durBeats=leadDurationSteps(item.event)*srcStepBeats;if(dst!==src)src.events=src.events.filter(x=>x!==item.event);const dstStepBeats=4/dst.resolution,totalSteps=dst.bars*dst.resolution,newEvent=dst===src?item.event:{...item.event};newEvent.step=Math.max(0,Math.min(totalSteps-1,Math.round(targetBeat/dstStepBeats)));newEvent.durationSteps=Math.max(1,Math.min(totalSteps-newEvent.step,Math.round(durBeats/dstStepBeats)));if(dst!==src)dst.events=normalizeLeadEvents([...(dst.events||[]),newEvent]);else dst.events=normalizeLeadEvents(dst.events);}
        else if(item.kind==='chord'&&item.part&&item.card){reorderChordCardToBeat(item.part,item.card,targetBeat);if(String(item.part.id)===String(loadedChordPartId))core.apply(item.part.data);}}
      if(mode!=='move'&&sel.kind==='chord'&&String(sel.part.id)===String(loadedChordPartId))core.apply(sel.part.data);
      voxInstrumentSelections=[];voxInstrumentSelection=null;persistVoxEdits();renderParts();renderVoxBox();voxStatus(mode==='move'?(moving.length>1?`${moving.length} instrument events moved.`:'Instrument event moved.'):'Instrument event resized.');};
    el.addEventListener('pointermove',move,{passive:false});el.addEventListener('pointerup',up,{passive:false});el.addEventListener('pointercancel',up,{passive:false});
  }
  function renderVoxBox(){
    if(!voxBoxOpen)return;const vocals=allVocalParts(),tracks=$('voxTracks'),ruler=$('voxRuler'),inner=$('voxTimelineInner');if(!tracks||!ruler||!inner)return;
    const token=++voxRenderToken,ppb=voxPpb(),beats=voxTimelineBeats(),width=Math.max(720,Math.ceil(beats*ppb));inner.style.width=`${width}px`;ruler.style.width=`${width}px`;ruler.innerHTML='';tracks.innerHTML='';
    for(let b=0;b<=Math.ceil(beats);b++){const tick=document.createElement('span');tick.className='vox-ruler-beat'+(b%4===0?' major':'');tick.style.left=`${b*ppb}px`;ruler.appendChild(tick);if(b%4===0){const lab=document.createElement('span');lab.className='vox-ruler-label';lab.style.left=`${b*ppb}px`;lab.textContent=String(b+1);ruler.appendChild(lab);}}
    const clickBeat=(e,base)=>{const rect=base.getBoundingClientRect();return quantizeVoxBeat((e.clientX-rect.left)/ppb);};
    ruler.onclick=e=>{if(voxToolMode==='playhead'){voxSeekTo(clickBeat(e,ruler),{manual:true});renderVoxInspector();}else voxStatus('Cursor mode — select or drag events. Switch to Playhead to locate playback.');};
    renderVoxInstrumentTracks(tracks,width,ppb,clickBeat);
    if(!vocals.length){tracks.insertAdjacentHTML('beforeend','<div class="vocal-empty" style="padding:40px">Add a Vocals part in Baby DAW first.</div>');renderVoxInspector();return;}
    if(!voxTargetPartId||!vocals.some(p=>p.id===voxTargetPartId))voxTargetPartId=(active()?.type==='vocal'?active().id:vocals[0].id);
    for(const part of vocals){
      const row=document.createElement('div');row.className='vox-track-row'+(String(part.id)===String(voxTargetPartId)?' is-target':'');row.style.width=`${width}px`;row.dataset.voxPartId=part.id;row.dataset.voxTrackKey=voxTrackTokenForPart(part);
      const label=document.createElement('div');label.className='vox-track-label';
      const nameInput=document.createElement('input');nameInput.type='text';nameInput.className='vox-track-name';nameInput.value=part.name||'Vocal Track';nameInput.setAttribute('aria-label','Vocal track name');nameInput.title='Rename vocal track';
      nameInput.onclick=e=>e.stopPropagation();nameInput.onfocus=()=>{voxCheckpoint();voxTargetPartId=part.id;voxSelections=[];voxSelected=null;voxInstrumentSelections=[];voxInstrumentSelection=null;voxInstrumentTrackFocus=null;renderVoxInspector();};
      nameInput.oninput=()=>{part.name=String(nameInput.value||'');markPartsDirty();core.scheduleAutoSave();};nameInput.onblur=()=>{part.name=String(nameInput.value||'').trim()||`Vocals ${allVocalParts().indexOf(part)+1}`;nameInput.value=part.name;renderParts();markPartsDirty();core.scheduleAutoSave();};
      const meta=document.createElement('span');meta.className='vox-track-meta';meta.textContent=`${Math.round((Number(part.volume)||0)*100)}% • ${(part.voxEvents||[]).length} event${(part.voxEvents||[]).length===1?'':'s'}`;label.append(nameInput,meta);
      label.onclick=()=>{voxTargetPartId=part.id;voxSelections=[];voxSelected=null;voxInstrumentSelections=[];voxInstrumentSelection=null;voxInstrumentTrackFocus=null;renderVoxBox();};
      const lane=document.createElement('div');lane.className='vox-track-lane';lane.dataset.voxPartId=part.id;lane.dataset.voxKind='vocal';lane.onclick=e=>{if(e.target!==lane)return;voxTargetPartId=part.id;voxSelections=[];voxSelected=null;voxInstrumentSelections=[];voxInstrumentSelection=null;voxInstrumentTrackFocus=null;if(voxToolMode==='playhead')voxSeekTo(clickBeat(e,lane),{manual:true});renderVoxBox();};
      for(const event of voxTrackEvents(part)){
        const take=voxEventTake(event),bounds=voxEventBounds(event),ev=document.createElement('div');ev.className='vox-event'+(voxIsSelected(part.id,event.id)?' is-selected':'');ev.dataset.voxEventId=event.id;ev.dataset.voxPartId=part.id;ev.style.left=`${bounds.start*ppb}px`;ev.style.width=`${Math.max(24,bounds.dur*ppb)}px`;
        const top=document.createElement('div');top.className='vox-event-top';top.innerHTML=`<span class="vox-event-name">${escapeHtml(take?.name||'Vocal event')}</span><span class="vox-event-time">${bounds.start.toFixed(2)}–${bounds.end.toFixed(2)}b</span>`;
        const canvas=document.createElement('canvas');canvas.className='vox-event-waveform';const lh=document.createElement('span');lh.className='vox-trim-handle left';const rh=document.createElement('span');rh.className='vox-trim-handle right';ev.append(top,canvas,lh,rh);
        ev.onclick=e=>{e.stopPropagation();if(ev.__voxDragged){ev.__voxDragged=false;return;}if(ev.__voxPointerSelected){ev.__voxPointerSelected=false;renderVoxSelectionClasses();renderVoxInspector();return;}const add=voxMultiSelect||e.ctrlKey||e.metaKey||e.shiftKey;voxSetSelection(part,event,{add,toggle:add});renderVoxBox();};
        ev.onpointerdown=e=>{if(e.target===lh||e.target===rh)return;beginVoxPointerEdit(e,part,event,ev,'move');};lh.onpointerdown=e=>beginVoxPointerEdit(e,part,event,ev,'trim-left');rh.onpointerdown=e=>beginVoxPointerEdit(e,part,event,ev,'trim-right');lane.appendChild(ev);requestAnimationFrame(()=>drawVoxWaveform(canvas,event,token));
      }
      row.append(label,lane);tracks.appendChild(row);wireVoxTrackLongPress(label,row);
    }
    applyVoxTrackOrder();
    inner.classList.toggle('has-crop-mode',voxCropMode);$('voxBoxPage')?.classList.toggle('crop-mode',voxCropMode);if($('voxCropBtn'))$('voxCropBtn').classList.toggle('is-active',voxCropMode);if($('voxMultiSelectBtn')){$('voxMultiSelectBtn').classList.toggle('is-active',voxMultiSelect);$('voxMultiSelectBtn').setAttribute('aria-pressed',String(voxMultiSelect));}if($('voxToolModeBtn')){$('voxToolModeBtn').textContent=voxToolMode==='cursor'?'Cursor':'Playhead';$('voxToolModeBtn').classList.toggle('is-active',voxToolMode==='playhead');$('voxToolModeBtn').setAttribute('aria-pressed',String(voxToolMode==='playhead'));}if($('voxDrumMapBtn')){$('voxDrumMapBtn').classList.toggle('is-active',voxDrumMapOpen);$('voxDrumMapBtn').setAttribute('aria-pressed',String(voxDrumMapOpen));}
    updateVoxPlayhead(voxPlayheadBeat);renderVoxInspector();updateVoxTransportState();
  }
  function findVoxLaneAt(x,y){return document.elementsFromPoint?.(x,y)?.find(el=>el.classList?.contains('vox-track-lane'))||null;}
  function beginVoxPointerEdit(e,part,event,el,mode){
    if(e.button!==undefined&&e.button!==0)return;e.preventDefault();e.stopPropagation();disableVoxAutoScroll();
    const add=voxMultiSelect||e.ctrlKey||e.metaKey||e.shiftKey;if(!voxIsSelected(part.id,event.id)){voxSetSelection(part,event,{add,render:false});el.classList.add('is-selected');el.__voxPointerSelected=true;}
    voxCheckpoint();const ppb=voxPpb(),beatSec=60/Math.max(40,Math.min(240,Number(core.bpm)||92)),startX=e.clientX,origStart=Number(event.startBeat)||0,origTrimStart=Math.max(0,Number(event.trimStartSec)||0),take=voxEventTake(event),full=Math.max(0,Number(take?.duration)||0),origTrimEnd=Math.max(origTrimStart,Math.min(full,Number.isFinite(Number(event.trimEndSec))&&Number(event.trimEndSec)>0?Number(event.trimEndSec):full)),origEndBeat=origStart+(origTrimEnd-origTrimStart)/beatSec;let targetPartId=part.id,moved=false;
    const selectedAtStart=mode==='move'?voxSelectionPairs():[{part,event}],starts=new Map(selectedAtStart.map(x=>[`${x.part.id}:${x.event.id}`,Number(x.event.startBeat)||0]));const canvas=el.querySelector('.vox-event-waveform');
    el.classList.add('is-dragging');if(mode!=='move')el.classList.add('is-trimming');try{el.setPointerCapture(e.pointerId);}catch{}
    const liveCrop=()=>{updateVoxEventReadout(el,event);queueLiveVoxWaveform(canvas,event);};
    const move=ev=>{ev.preventDefault();const dx=(ev.clientX-startX)/ppb;if(Math.abs(ev.clientX-startX)>3)moved=true;if(mode==='move'){
        for(const item of selectedAtStart){const base=starts.get(`${item.part.id}:${item.event.id}`)||0;item.event.startBeat=quantizeVoxBeat(base+dx);const node=document.querySelector(`.vox-event[data-vox-part-id="${CSS.escape(String(item.part.id))}"][data-vox-event-id="${CSS.escape(String(item.event.id))}"]`);if(node){node.style.left=`${item.event.startBeat*ppb}px`;updateVoxEventReadout(node,item.event);}}
        if(selectedAtStart.length===1){const lane=findVoxLaneAt(ev.clientX,ev.clientY);if(lane?.dataset.voxKind==='vocal'&&lane?.dataset.voxPartId)targetPartId=lane.dataset.voxPartId;document.querySelectorAll('.vox-track-row').forEach(r=>r.classList.toggle('is-target',String(r.dataset.voxPartId)===String(targetPartId)));}
      }else if(mode==='trim-left'){let target=quantizeVoxBeat(origStart+dx),delta=(target-origStart)*beatSec,newTrim=Math.max(0,Math.min(origTrimEnd-.03,origTrimStart+delta));event.trimStartSec=newTrim;event.startBeat=Math.max(0,origStart+(newTrim-origTrimStart)/beatSec);const dur=Math.max(.001,(origTrimEnd-newTrim)/beatSec);el.style.left=`${event.startBeat*ppb}px`;el.style.width=`${Math.max(24,dur*ppb)}px`;liveCrop();voxStatus(`Cropping start • ${event.startBeat.toFixed(2)}–${(event.startBeat+dur).toFixed(2)} beats`);
      }else{let targetEnd=quantizeVoxBeat(origEndBeat+dx),newEnd=origTrimStart+Math.max(.02,targetEnd-origStart)*beatSec;newEnd=Math.max(origTrimStart+.03,Math.min(full,newEnd));event.trimEndSec=newEnd;const dur=Math.max(.001,(newEnd-origTrimStart)/beatSec);el.style.width=`${Math.max(24,dur*ppb)}px`;liveCrop();voxStatus(`Cropping end • ${origStart.toFixed(2)}–${(origStart+dur).toFixed(2)} beats`);}};
    const up=ev=>{try{el.releasePointerCapture(ev.pointerId);}catch{}el.removeEventListener('pointermove',move);el.removeEventListener('pointerup',up);el.removeEventListener('pointercancel',up);el.classList.remove('is-dragging','is-trimming');el.__voxDragged=moved;if(!moved&&mode==='move'){voxUndoStack.pop();updateVoxHistoryButtons();return;}if(mode==='move'&&selectedAtStart.length===1&&String(targetPartId)!==String(part.id)){const dest=parts.find(p=>p.type==='vocal'&&String(p.id)===String(targetPartId));if(dest){part.voxEvents=(part.voxEvents||[]).filter(x=>x.id!==event.id);dest.voxEvents=dest.voxEvents||[];dest.voxEvents.push(event);voxSelections=[{partId:dest.id,eventId:event.id}];voxSelected=voxSelections[0];voxTargetPartId=dest.id;}}persistVoxEdits();renderVoxBox();if(mode!=='move')voxStatus('Crop applied. The original dry take remains untouched.');else if(selectedAtStart.length>1)voxStatus(`${selectedAtStart.length} events moved together.`);};
    el.addEventListener('pointermove',move,{passive:false});el.addEventListener('pointerup',up,{passive:false});el.addEventListener('pointercancel',up,{passive:false});
  }

  function openVoxBox(options={}){
    const allowNoVocals=!!options.allowNoVocals,forceInstrumentals=!!options.forceInstrumentals;
    const vocals=allVocalParts();if(!vocals.length&&!allowNoVocals){core.status('Add a Vocals part first.');return;}let changed=false;for(const p of vocals){if(!(p.voxEvents||[]).length&&p.activeTakeId&&p.recordings?.some(r=>r.id===p.activeTakeId)){ensureVoxEventForActiveTake(p,0);changed=true;}}
    if(forceInstrumentals){try{localStorage.setItem(VOX_INST_KEY,'1')}catch{}voxShowInstrumentals=true;}
    voxBoxOpen=true;voxInspectorManualOverride=null;voxTargetPartId=vocals.length?(active()?.type==='vocal'?active().id:vocals[0].id):null;voxSelections=[];voxSelected=null;voxInstrumentSelections=[];voxInstrumentSelection=null;voxInstrumentTrackFocus=null;voxCropMode=false;voxUndoStack=[];voxRedoStack=[];const page=$('voxBoxPage');if(page){page.hidden=false;page.setAttribute('aria-hidden','false');}document.body.classList.add('vox-box-open');
    try{$('voxSnapToBeat').checked=localStorage.getItem(VOX_SNAP_KEY)!=='0';$('voxSnapResolution').value=localStorage.getItem(VOX_RES_KEY)||'16';voxAutoScroll=localStorage.getItem(VOX_AUTO_KEY)!=='0';voxShowInstrumentals=forceInstrumentals||localStorage.getItem(VOX_INST_KEY)==='1';voxToolMode=localStorage.getItem(VOX_TOOL_KEY)||'playhead';voxDrumMapOpen=localStorage.getItem(VOX_DRUM_MAP_KEY)==='1';voxInstrumentTrackFocus=voxDrumMapOpen?{kind:'drum-map',name:'Drum Map',key:'drum-map'}:null;if($('voxShowInstrumentals'))$('voxShowInstrumentals').checked=voxShowInstrumentals;}catch{}
    if(changed)persistVoxEdits();renderVoxBox();restoreVoxTransportPosition();updateVoxHistoryButtons();
  }
  function openTrackMaster(){
    openVoxBox({allowNoVocals:true,forceInstrumentals:true});
    if(voxBoxOpen&&!allVocalParts().length)voxStatus('Track Master open. Instrument tracks are ready; add a Vocal Track whenever you want to record or edit vocals.');
  }
  function closeVoxBox(){voxBoxOpen=false;const page=$('voxBoxPage');if(page){page.hidden=true;page.setAttribute('aria-hidden','true');}document.body.classList.remove('vox-box-open');const p=active();if(p?.type==='vocal')renderVocalEditor(p);}
  function addVoxTrack(){voxCheckpoint();const p=vocalPart(`Vocals ${countType('vocal')+1}`);parts.push(p);activePartId=p.id;voxTargetPartId=p.id;voxSelections=[];voxSelected=null;voxInstrumentSelections=[];voxInstrumentSelection=null;markPartsDirty();renderParts();persistVoxEdits();renderVoxBox();voxStatus(`${p.name} added. Rename it in the track header, paste/layer clips here, or record directly with the floating transport.`);}
  function addActiveTakeToVox(){const p=voxTargetPart();if(!p?.activeTakeId||!p.recordings?.some(r=>r.id===p.activeTakeId)){voxStatus('Choose an active take on this vocal track first.');return;}voxCheckpoint();p.voxEvents=p.voxEvents||[];const ev=normalizeVoxEvent({id:uid(),takeId:p.activeTakeId,sourcePartId:p.id,startBeat:quantizeVoxBeat(voxPlayheadBeat),trimStartSec:0,trimEndSec:null,volume:1,fx:null},p);p.voxEvents.push(ev);voxSelections=[{partId:p.id,eventId:ev.id}];voxSelected=voxSelections[0];voxInstrumentSelections=[];voxInstrumentSelection=null;persistVoxEdits();renderVoxBox();voxStatus(`Added ${voxEventTake(ev)?.name||'active take'} at beat ${ev.startBeat.toFixed(2)}.`);}
  function splitSelectedVox(){const selected=voxSelectionPairs();if(!selected.length)return;const split=quantizeVoxBeat(voxPlayheadBeat),valid=selected.filter(({event})=>{const b=voxEventBounds(event);return split>b.start+.01&&split<b.end-.01;});if(!valid.length){voxStatus('Move the playhead inside the selected event(s), then Split.');return;}voxCheckpoint();const beatSec=60/Math.max(40,Math.min(240,Number(core.bpm)||92)),newSel=[];for(const {part,event} of valid){const b=voxEventBounds(event),splitSec=(Number(event.trimStartSec)||0)+(split-b.start)*beatSec,oldEnd=event.trimEndSec;event.trimEndSec=splitSec;const right=clone(event);right.id=uid();right.startBeat=split;right.trimStartSec=splitSec;right.trimEndSec=oldEnd;const ix=part.voxEvents.findIndex(x=>x.id===event.id);part.voxEvents.splice(ix+1,0,right);newSel.push({partId:part.id,eventId:right.id});}voxSelections=newSel;voxSelected=newSel[0]||null;persistVoxEdits();renderVoxBox();voxStatus(`${valid.length} event${valid.length===1?'':'s'} split at the playhead.`);}
  function copyInstrumentSelection(cut=false){
    const list=voxInstrumentSelectionList();if(!list.length)return false;const anchor=Math.min(...list.map(x=>Number(x.startBeat)||0));voxClipboard={kind:'instrument-group',items:list.map(s=>({kind:s.kind,deltaBeat:(Number(s.startBeat)||0)-anchor,drumId:s.drumId,name:s.name,sourcePartId:s.part?.id||null,event:s.event?clone(s.event):null,card:s.card?clone(s.card):null}))};if(cut)deleteSelectedVox();else{renderVoxInspector();voxStatus(`${list.length} instrument event${list.length===1?'':'s'} copied. Move the playhead, then Paste.`);}return true;
  }
  function copySelectedVox(cut=false){
    const selected=voxSelectionPairs();if(!selected.length){copyInstrumentSelection(cut);return;}const vocals=allVocalParts(),primary=selected[0],baseTrack=Math.max(0,vocals.indexOf(primary.part)),anchor=Math.min(...selected.map(x=>Number(x.event.startBeat)||0));voxClipboard={kind:'vocal',items:selected.map(({part,event})=>({event:clone(event),sourcePartId:part.id,deltaBeat:(Number(event.startBeat)||0)-anchor,trackOffset:vocals.indexOf(part)-baseTrack}))};
    if(cut){voxCheckpoint();for(const {part,event} of selected)part.voxEvents=(part.voxEvents||[]).filter(x=>x.id!==event.id);voxSelections=[];voxSelected=null;persistVoxEdits();renderVoxBox();voxStatus(`${selected.length} event${selected.length===1?'':'s'} cut. Choose a track/playhead position, then Paste.`);}else{renderVoxInspector();voxStatus(`${selected.length} event${selected.length===1?'':'s'} copied.`);}
  }
  function pasteOneInstrumentClip(clip,atBeat){
    if(clip.kind==='drum'){const b=window.CRPBeatMaker?.getBeat?.();if(!b)return;const abs=Math.max(0,Math.min(16*64-1,Math.round(quantizeVoxBeat(atBeat)*16))),bar=Math.floor(abs/64),step=abs%64;b.bars=Math.max(b.bars,Math.min(16,bar+1));b.tracks[clip.drumId][bar]=[...new Set([...(b.tracks[clip.drumId][bar]||[]),step])].sort((a,c)=>a-c);window.CRPBeatMaker.setBeat(b,{persist:true});}
    else if(clip.kind==='lead'){const p=parts.find(x=>x.type==='lead'&&String(x.id)===String(clip.sourcePartId))||parts.find(x=>x.type==='lead');if(!p)return;const stepBeats=4/p.resolution,e=clone(clip.event);e.step=Math.max(0,Math.min(p.bars*p.resolution-1,Math.round(quantizeVoxBeat(atBeat)/stepBeats)));p.events=normalizeLeadEvents([...(p.events||[]),e]);}
    else if(clip.kind==='chord'){const p=parts.find(x=>x.type==='chord'&&String(x.id)===String(clip.sourcePartId))||parts.find(x=>x.type==='chord');if(!p)return;const card=clone(clip.card),items=chordFlatItems(p);let idx=items.length;for(let i=0;i<items.length;i++){if(atBeat<items[i].startBeat+items[i].dur/2){idx=i;break;}}let remaining=idx,done=false;for(const row of p.data.rows){if(remaining<=row.length){row.splice(remaining,0,card);done=true;break;}remaining-=row.length;}if(!done&&(p.data.rows||[]).length)p.data.rows.at(-1).push(card);if(String(p.id)===String(loadedChordPartId))core.apply(p.data);}
  }
  function pasteInstrument(){const clip=voxClipboard;if(!clip||clip.kind==='vocal')return false;voxCheckpoint();if(clip.kind==='instrument-group'){for(const item of clip.items||[])pasteOneInstrumentClip(item,voxPlayheadBeat+(Number(item.deltaBeat)||0));}else pasteOneInstrumentClip(clip,voxPlayheadBeat);persistVoxEdits();renderParts();renderVoxBox();voxStatus('Instrument event selection pasted at the playhead.');return true;}
  function pasteVox(){if(!voxClipboard)return;if(voxClipboard.kind!=='vocal'){pasteInstrument();return;}const vocals=allVocalParts(),target=voxTargetPart();if(!target)return;voxCheckpoint();const base=Math.max(0,vocals.indexOf(target)),newSel=[];for(const item of voxClipboard.items||[]){const dest=vocals[Math.max(0,Math.min(vocals.length-1,base+(Number(item.trackOffset)||0)))]||target;const ev=normalizeVoxEvent({...clone(item.event),id:uid(),sourcePartId:item.event.sourcePartId||item.sourcePartId,startBeat:quantizeVoxBeat(voxPlayheadBeat+(Number(item.deltaBeat)||0))},dest);dest.voxEvents=dest.voxEvents||[];dest.voxEvents.push(ev);newSel.push({partId:dest.id,eventId:ev.id});}voxSelections=newSel;voxSelected=newSel[0]||null;voxInstrumentSelections=[];voxInstrumentSelection=null;persistVoxEdits();renderVoxBox();voxStatus(`Pasted ${newSel.length} event${newSel.length===1?'':'s'} at beat ${voxPlayheadBeat.toFixed(2)}.`);}
  function deleteInstrumentSelection(){const list=voxInstrumentSelectionList();if(!list.length)return false;voxCheckpoint();const b=window.CRPBeatMaker?.getBeat?.();for(const s of list){if(s.kind==='drum'&&b){b.tracks[s.drumId][s.bar]=(b.tracks[s.drumId][s.bar]||[]).filter(x=>Number(x)!==Number(s.step));}else if(s.kind==='lead'&&s.part)s.part.events=(s.part.events||[]).filter(x=>x!==s.event);else if(s.kind==='chord'&&s.part){for(const row of s.part.data?.rows||[]){const i=row.indexOf(s.card);if(i>=0){row.splice(i,1);break;}}if(String(s.part.id)===String(loadedChordPartId))core.apply(s.part.data);}}if(b)window.CRPBeatMaker.setBeat(b,{persist:true});voxInstrumentSelections=[];voxInstrumentSelection=null;persistVoxEdits();renderParts();renderVoxBox();voxStatus(`${list.length} instrument event${list.length===1?'':'s'} deleted.`);return true;}
  function deleteSelectedVox(){if(voxInstrumentSelectionList().length){deleteInstrumentSelection();return;}const selected=voxSelectionPairs();if(!selected.length)return;voxCheckpoint();for(const {part,event} of selected)part.voxEvents=(part.voxEvents||[]).filter(x=>x.id!==event.id);voxSelections=[];voxSelected=null;persistVoxEdits();renderVoxBox();voxStatus(`${selected.length} event${selected.length===1?'':'s'} deleted. Original dry takes remain safe.`);}
  function updateVoxFxFromUi(kind){
    const p=voxTargetPart(),selected=voxSelectionPairs(),eventMode=$('voxFxTarget')?.value==='event'&&selected.length;if(!p)return;const touchedParts=new Set();
    if(eventMode){for(const item of selected){const ev=item.event;let fx=ev.fx||(ev.fx=normalizeVocalFx(item.part.fx));if(kind==='volume')ev.volume=Math.max(0,Math.min(1.5,(Number($('voxFxVolume')?.value)||0)/100));else if(kind==='autotune')fx.autotune=Math.max(0,Math.min(100,Number($('voxFxAutotune')?.value)||0));else if(kind==='eq')fx.eq=$('voxFxEq').value;else if(kind==='comp')fx.comp=$('voxFxComp').value;else if(kind==='reverb')fx.reverb=Number($('voxFxReverb').value)||0;else if(kind==='delay')fx.delay=Number($('voxFxDelay').value)||0;touchedParts.add(item.part);}}
    else{let fx=p.fx;if(kind==='volume'){p.volume=Math.max(0,Math.min(1.5,(Number($('voxFxVolume')?.value)||0)/100));updatePartMiniVolume(p);}else if(kind==='autotune')fx.autotune=Math.max(0,Math.min(100,Number($('voxFxAutotune')?.value)||0));else if(kind==='eq')fx.eq=$('voxFxEq').value;else if(kind==='comp')fx.comp=$('voxFxComp').value;else if(kind==='reverb')fx.reverb=Number($('voxFxReverb').value)||0;else if(kind==='delay')fx.delay=Number($('voxFxDelay').value)||0;touchedParts.add(p);}
    if(kind==='volume'&&$('voxFxVolumeValue'))$('voxFxVolumeValue').textContent=`${$('voxFxVolume').value}%`;if(kind==='autotune'&&$('voxFxAutotuneValue'))$('voxFxAutotuneValue').textContent=`${$('voxFxAutotune').value}%`;for(const part of touchedParts)applyVocalFxLive(part);markPartsDirty();core.scheduleAutoSave();renderVoxInspector();
  }
  function resetSelectedVoxFx(){const selected=voxSelectionPairs();if(!selected.length)return;voxCheckpoint();const touched=new Set();for(const {part,event} of selected){event.fx=null;event.volume=1;touched.add(part);}for(const p of touched)applyVocalFxLive(p);markPartsDirty();core.scheduleAutoSave();renderVoxInspector();voxStatus(`${selected.length} selected event${selected.length===1?'':'s'} now follow track effects.`);}

  function updateVoxTransportState(){
    const on=!!(playing||starting),rec=!!recording,paused=!!recordingPaused;
    if($('voxBoxPlayBtn'))$('voxBoxPlayBtn').textContent=on?'■ Stop':'▶ Play';if($('voxPlayTransportBtn')){$('voxPlayTransportBtn').classList.toggle('is-active',on);$('voxPlayTransportBtn').textContent=on?'▶':'▶';}
    if($('voxPauseTransportBtn'))$('voxPauseTransportBtn').classList.toggle('is-active',paused||(!on&&mediaPausedBeat>0));
    if($('voxRecordTransportBtn')){$('voxRecordTransportBtn').classList.toggle('recording',rec);$('voxRecordTransportBtn').textContent=rec?'● REC':'●';}
    setVoxAutoScroll(voxAutoScroll,{persist:false});
  }
  function voxTransportPlay(){if(recording&&recordingPaused){toggleRecordingPause();return;}if(playing||starting)return;startPlayback({fromBeat:voxPlayheadBeat});updateVoxTransportState();}
  async function voxTransportStop(){const b=currentCycleBeat()??voxPlayheadBeat;if(recording)await endRecording();else stopPlayback();updateVoxPlayhead(Math.max(0,Number(b)||0),false);mediaPausedBeat=voxPlayheadBeat;updateVoxTransportState();}
  function voxTransportPause(){if(recording){toggleRecordingPause();return;}if(playing||starting){const b=currentCycleBeat()??voxPlayheadBeat;mediaPausedBeat=b;stopPlayback({mediaPause:true});updateVoxPlayhead(b,false);}updateVoxTransportState();}
  async function voxTransportRecord(){if(recording){voxStatus('Recording is already running. Use Stop to finish the take.');return;}const p=voxTargetPart();if(!p){voxStatus('Select or add a vocal track first.');return;}activePartId=p.id;await beginRecording({partId:p.id,fromBeat:voxPlayheadBeat,voxBox:true});updateVoxTransportState();}
  function saveVoxTransportPosition(){const el=$('voxFloatingTransport');if(!el)return;const r=el.getBoundingClientRect();try{localStorage.setItem(VOX_TRANSPORT_POS_KEY,JSON.stringify({x:r.left/window.innerWidth,y:r.top/window.innerHeight}))}catch{}}
  function clampVoxTransportToViewport({persist=false}={}){const el=$('voxFloatingTransport');if(!el||!voxBoxOpen)return;const r=el.getBoundingClientRect(),maxX=Math.max(4,window.innerWidth-r.width-4),maxY=Math.max(4,window.innerHeight-r.height-4),x=Math.max(4,Math.min(maxX,r.left)),y=Math.max(4,Math.min(maxY,r.top));if(Math.abs(x-r.left)>.5||Math.abs(y-r.top)>.5||el.style.transform){el.style.left=`${x}px`;el.style.top=`${y}px`;el.style.bottom='auto';el.style.transform='none';}if(persist)saveVoxTransportPosition();}
  function restoreVoxTransportPosition(){const el=$('voxFloatingTransport');if(!el)return;let pos=null;try{pos=JSON.parse(localStorage.getItem(VOX_TRANSPORT_POS_KEY)||'null')}catch{};if(pos&&Number.isFinite(pos.x)&&Number.isFinite(pos.y)){requestAnimationFrame(()=>{const r=el.getBoundingClientRect(),x=Math.max(6,Math.min(Math.max(6,window.innerWidth-r.width-6),pos.x*window.innerWidth)),y=Math.max(6,Math.min(Math.max(6,window.innerHeight-r.height-6),pos.y*window.innerHeight));el.style.left=`${x}px`;el.style.top=`${y}px`;el.style.bottom='auto';el.style.transform='none';clampVoxTransportToViewport();});}else{el.style.left='50%';el.style.top='auto';el.style.bottom='18%';el.style.transform='translateX(-50%)';requestAnimationFrame(()=>clampVoxTransportToViewport());}}
  function wireVoxTransportDrag(){const bar=$('voxFloatingTransport'),handle=$('voxTransportDrag');if(!bar||!handle||handle.dataset.wired)return;handle.dataset.wired='1';handle.addEventListener('pointerdown',e=>{if(e.button!==undefined&&e.button!==0)return;e.preventDefault();const r=bar.getBoundingClientRect(),dx=e.clientX-r.left,dy=e.clientY-r.top;bar.style.left=`${r.left}px`;bar.style.top=`${r.top}px`;bar.style.bottom='auto';bar.style.transform='none';try{handle.setPointerCapture(e.pointerId)}catch{};const move=ev=>{ev.preventDefault();const br=bar.getBoundingClientRect(),x=Math.max(4,Math.min(window.innerWidth-br.width-4,ev.clientX-dx)),y=Math.max(4,Math.min(window.innerHeight-br.height-4,ev.clientY-dy));bar.style.left=`${x}px`;bar.style.top=`${y}px`;};const up=ev=>{try{handle.releasePointerCapture(ev.pointerId)}catch{};handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',up);handle.removeEventListener('pointercancel',up);saveVoxTransportPosition();};handle.addEventListener('pointermove',move,{passive:false});handle.addEventListener('pointerup',up);handle.addEventListener('pointercancel',up);});}
  function wireVoxPlayheadDrag(){const grip=$('voxPlayhead')?.querySelector('span');if(!grip||grip.dataset.wired)return;grip.dataset.wired='1';grip.addEventListener('pointerdown',e=>{if(recording&&!recordingPaused){voxStatus('Pause or stop recording before moving the playhead.');return;}e.preventDefault();e.stopPropagation();disableVoxAutoScroll();const sc=$('voxTimelineScroller'),inner=$('voxTimelineInner');if(!sc||!inner)return;try{grip.setPointerCapture(e.pointerId)}catch{};const move=ev=>{ev.preventDefault();const rect=inner.getBoundingClientRect(),beat=quantizeVoxBeat((ev.clientX-rect.left-voxLabelWidth())/voxPpb());updateVoxPlayhead(beat,false);};const up=ev=>{try{grip.releasePointerCapture(ev.pointerId)}catch{};grip.removeEventListener('pointermove',move);grip.removeEventListener('pointerup',up);grip.removeEventListener('pointercancel',up);voxSeekTo(voxPlayheadBeat,{manual:true});};grip.addEventListener('pointermove',move,{passive:false});grip.addEventListener('pointerup',up);grip.addEventListener('pointercancel',up);});}

  function wire(){
    ensureInitial();setEditorMode(active()?.type||'chord');renderParts();initSongEndPanel();ensureMediaSession();updateMediaMetadata();renderSongEndEditor();
    if($('voxBoxBtn'))$('voxBoxBtn').onclick=()=>openVoxBox();
    if($('trackMasterBtn'))$('trackMasterBtn').onclick=openTrackMaster;
    try{
      const q=new URLSearchParams(location.search);
      if(q.get('trackMaster')==='1'){
        setTimeout(()=>{openTrackMaster();q.delete('trackMaster');q.delete('return');const qs=q.toString();history.replaceState(null,'',location.pathname+(qs?'?'+qs:'')+location.hash);},80);
      }
    }catch{}
    if($('voxBoxCloseBtn'))$('voxBoxCloseBtn').onclick=closeVoxBox;
    if($('voxBoxPlayBtn'))$('voxBoxPlayBtn').onclick=()=>{if(playing||starting)voxTransportStop();else voxTransportPlay();};
    if($('voxSnapToBeat'))$('voxSnapToBeat').onchange=e=>{try{localStorage.setItem(VOX_SNAP_KEY,e.target.checked?'1':'0')}catch{}voxStatus(e.target.checked?`Snap on (1/${$('voxSnapResolution')?.value||'16'})`:'Free drag enabled.');};
    if($('voxSnapResolution'))$('voxSnapResolution').onchange=e=>{try{localStorage.setItem(VOX_RES_KEY,e.target.value)}catch{}voxStatus(`Snap grid set to 1/${e.target.value}.`);};
    if($('voxShowInstrumentals'))$('voxShowInstrumentals').onchange=e=>{voxShowInstrumentals=!!e.target.checked;try{localStorage.setItem(VOX_INST_KEY,voxShowInstrumentals?'1':'0')}catch{};voxInstrumentSelections=[];voxInstrumentSelection=null;if(!voxShowInstrumentals)voxInstrumentTrackFocus=null;renderVoxBox();voxStatus(voxShowInstrumentals?'Instrument tracks added to the timeline. Drag Beat, Chord/Note, and Lead/Bass events to edit timing.':'Instrument tracks hidden.');};
    if($('voxDrumMapBtn'))$('voxDrumMapBtn').onclick=()=>{voxDrumMapOpen=!voxDrumMapOpen;try{localStorage.setItem(VOX_DRUM_MAP_KEY,voxDrumMapOpen?'1':'0')}catch{};voxInstrumentTrackFocus=voxDrumMapOpen?{kind:'drum-map',name:'Drum Map',key:'drum-map'}:null;renderVoxBox();voxStatus(voxDrumMapOpen?'Drum Map open — click cells to add/remove hits. Vocal Effects are collapsed while you edit instruments.':'Drum Map closed.');};
    if($('voxToolModeBtn'))$('voxToolModeBtn').onclick=()=>{voxToolMode=voxToolMode==='cursor'?'playhead':'cursor';try{localStorage.setItem(VOX_TOOL_KEY,voxToolMode)}catch{};renderVoxBox();voxStatus(voxToolMode==='cursor'?'Cursor mode — select, multi-select, drag and resize events without moving playback.':'Playhead mode — click the ruler or empty lanes to locate playback; events remain draggable.');};
    if($('voxAddTrackBtn'))$('voxAddTrackBtn').onclick=addVoxTrack;
    if($('voxAddActiveTakeBtn'))$('voxAddActiveTakeBtn').onclick=addActiveTakeToVox;
    if($('voxCropBtn'))$('voxCropBtn').onclick=()=>{voxCropMode=!voxCropMode;renderVoxBox();voxStatus(voxCropMode?'Crop mode: drag the blue-selected event edges.':'Crop mode off.');};
    if($('voxSplitBtn'))$('voxSplitBtn').onclick=splitSelectedVox;
    if($('voxMultiSelectBtn'))$('voxMultiSelectBtn').onclick=()=>{voxMultiSelect=!voxMultiSelect;if(!voxMultiSelect){if(voxSelections.length>1)voxSelections=voxSelections.slice(0,1);if(voxInstrumentSelections.length>1)voxInstrumentSelections=voxInstrumentSelections.slice(0,1);}voxSelected=voxSelections[0]||null;voxInstrumentSelection=voxInstrumentSelections[0]||null;renderVoxBox();voxStatus(voxMultiSelect?'Multi Select on — tap events to add/remove them; drag any selected event to move the group.':'Multi Select off.');};
    if($('voxCopyBtn'))$('voxCopyBtn').onclick=()=>copySelectedVox(false);
    if($('voxCutBtn'))$('voxCutBtn').onclick=()=>copySelectedVox(true);
    if($('voxPasteBtn'))$('voxPasteBtn').onclick=pasteVox;
    if($('voxDeleteBtn'))$('voxDeleteBtn').onclick=deleteSelectedVox;
    if($('voxUndoBtn'))$('voxUndoBtn').onclick=voxUndo;
    if($('voxRedoBtn'))$('voxRedoBtn').onclick=voxRedo;
    if($('voxFxTarget'))$('voxFxTarget').onchange=renderVoxInspector;
    if($('voxFxVolume')){$('voxFxVolume').addEventListener('pointerdown',voxCheckpoint);$('voxFxVolume').oninput=()=>updateVoxFxFromUi('volume');}
    if($('voxFxEq'))$('voxFxEq').onchange=()=>{voxCheckpoint();updateVoxFxFromUi('eq');};
    if($('voxFxComp'))$('voxFxComp').onchange=()=>{voxCheckpoint();updateVoxFxFromUi('comp');};
    if($('voxFxReverb'))$('voxFxReverb').onchange=()=>{voxCheckpoint();updateVoxFxFromUi('reverb');};
    if($('voxFxDelay'))$('voxFxDelay').onchange=()=>{voxCheckpoint();updateVoxFxFromUi('delay');};
    if($('voxFxAutotune')){$('voxFxAutotune').addEventListener('pointerdown',voxCheckpoint);$('voxFxAutotune').oninput=()=>updateVoxFxFromUi('autotune');}
    if($('voxInspectorToggleBtn'))$('voxInspectorToggleBtn').onclick=toggleVoxInspector;
    if($('voxResetEventFxBtn'))$('voxResetEventFxBtn').onclick=resetSelectedVoxFx;
    if($('voxToStartBtn'))$('voxToStartBtn').onclick=()=>voxSeekTo(0);
    if($('voxRewindBtn'))$('voxRewindBtn').onclick=()=>voxSeekTo(Math.max(0,voxPlayheadBeat-4));
    if($('voxFastForwardBtn'))$('voxFastForwardBtn').onclick=()=>voxSeekTo(Math.min(mediaDurationBeats(),voxPlayheadBeat+4));
    if($('voxToEndBtn'))$('voxToEndBtn').onclick=()=>voxSeekTo(Math.max(0,mediaDurationBeats()-.001));
    if($('voxStopTransportBtn'))$('voxStopTransportBtn').onclick=voxTransportStop;
    if($('voxPlayTransportBtn'))$('voxPlayTransportBtn').onclick=voxTransportPlay;
    if($('voxPauseTransportBtn'))$('voxPauseTransportBtn').onclick=voxTransportPause;
    if($('voxRecordTransportBtn'))$('voxRecordTransportBtn').onclick=voxTransportRecord;
    if($('voxAutoScrollBtn'))$('voxAutoScrollBtn').onclick=()=>setVoxAutoScroll(!voxAutoScroll);
    if($('voxLyricsTransportBtn'))$('voxLyricsTransportBtn').onclick=openLyricsOverlay;
    wireVoxTransportDrag();wireVoxPlayheadDrag();
    const voxScroller=$('voxTimelineScroller');if(voxScroller){
      voxScroller.addEventListener('wheel',()=>{if((playing||starting)&&voxAutoScroll)disableVoxAutoScroll();},{passive:true});
      let voxTouchX=null,voxTouchY=null;
      voxScroller.addEventListener('touchstart',e=>{if(!e.touches?.length)return;voxTouchX=e.touches[0].clientX;voxTouchY=e.touches[0].clientY;},{passive:true});
      voxScroller.addEventListener('touchmove',e=>{if(!voxAutoScroll||voxTouchX==null||!e.touches?.length)return;const dx=e.touches[0].clientX-voxTouchX,dy=e.touches[0].clientY-voxTouchY;if(Math.hypot(dx,dy)>10){voxTouchX=voxTouchY=null;disableVoxAutoScroll();}},{passive:true});
      voxScroller.addEventListener('touchend',()=>{voxTouchX=voxTouchY=null;},{passive:true});
    }
    window.addEventListener('resize',()=>{updateLeadGridViewToggle();if(voxBoxOpen){renderVoxBox();requestAnimationFrame(()=>clampVoxTransportToViewport());}});
    if($('songEndMinusBtn'))$('songEndMinusBtn').onclick=()=>nudgeSongEnd(-.1);
    if($('songEndPlusBtn'))$('songEndPlusBtn').onclick=()=>nudgeSongEnd(.1);
    if($('songEndClearBtn'))$('songEndClearBtn').onclick=clearSongEnd;
    if($('songEndSlider')){
      $('songEndSlider').addEventListener('input',e=>setSongEndFromSlider(e.target.value,false));
      $('songEndSlider').addEventListener('change',e=>{setSongEndFromSlider(e.target.value,true);});
    }
    if($('songEndSnapBar'))$('songEndSnapBar').onchange=e=>{songEndSnapToBar=!!e.target.checked;try{localStorage.setItem(SONG_END_SNAP_KEY,songEndSnapToBar?'1':'0')}catch{}const natural=naturalSongDurationBeats();if(songEndSnapToBar&&Number.isFinite(Number(songEndBeat))&&natural>0)songEndBeat=snappedSongEndBeat(songEndBeat,natural);renderSongEndEditor();liveEditRefresh();core.scheduleAutoSave();};
    $('bpmInput')?.addEventListener('input',()=>{renderSongEndEditor();updateMediaMetadata();liveEditRefresh();});
    if(songEndUiTimer)clearInterval(songEndUiTimer);songEndUiTimer=setInterval(()=>{
      renderSongEndEditor();
      if(voxBoxOpen){
        let beat=null;
        if(playing||starting)beat=currentCycleBeat();
        else if(recording){
          const now=recordingPaused&&recordPausedAt?recordPausedAt:performance.now();
          const activeMs=Math.max(0,now-recordStartedAt-recordPausedTotal);
          beat=recordInsertBeat+(activeMs/1000)*(Math.max(40,Math.min(240,Number(core.bpm)||92))/60);
        }
        if(Number.isFinite(beat))updateVoxPlayhead(beat,voxAutoScroll);
        updatePartPlaybackButtons();updateVoxTransportState();
      }
    },120);
    $('addPartBtn')?.addEventListener('click',openModal);$('closePartModal')?.addEventListener('click',closeModal);document.querySelector('[data-close-part-modal]')?.addEventListener('click',closeModal);document.querySelectorAll('.part-choice').forEach(b=>b.addEventListener('click',()=>addPart(b.dataset.partType)));
    document.querySelectorAll('#leadInstrumentTabs .seg').forEach(b=>b.onclick=()=>{const p=active();if(p?.type!=='lead')return;p.instrument=b.dataset.leadInstrument;p.sound=(core.sounds[p.instrument]||[])[0]?.[0]||p.sound;renderLeadSoundControls(p);warmLivePlayer(p);core.scheduleAutoSave();});
    if($('leadPlaybackBtn'))$('leadPlaybackBtn').onclick=toggleLeadPartPlayback;
    if($('leadAutoScrollBtn'))$('leadAutoScrollBtn').onclick=()=>core.setAutoScroll?.(!core.autoScroll);
    $('leadRepeat').onchange=e=>{
      const p=active();if(p?.type!=='lead')return;
      // This Repeat control mirrors the project/master repeat so the Lead/Bass
      // Play button loops the entire checked mix, not only the current part.
      p.repeat=e.target.checked;
      const master=$('loopToggle');
      if(master){master.checked=e.target.checked;master.dispatchEvent(new Event('change',{bubbles:true}));}
      core.scheduleAutoSave();
    };
    $('loopToggle')?.addEventListener('change',()=>{const p=active();if(p?.type==='lead'){p.repeat=!!$('loopToggle').checked;if($('leadRepeat'))$('leadRepeat').checked=p.repeat;}});
    $('leadSustain').onchange=e=>{const p=active();if(p?.type!=='lead')return;p.sustain=e.target.checked;core.scheduleAutoSave();};
    $('leadSoundSelect').onchange=e=>{const p=active();if(p?.type!=='lead')return;p.sound=e.target.value;warmLivePlayer(p);core.scheduleAutoSave();};
    if($('leadGridViewToggle'))$('leadGridViewToggle').onclick=()=>{if(!desktopLeadGridView())return;leadGridCollapsed=!leadGridCollapsed;try{localStorage.setItem('crp-lead-grid-collapsed-v1',leadGridCollapsed?'1':'0');}catch{}updateLeadGridViewToggle();const p=active();if(p?.type==='lead')requestAnimationFrame(()=>scrollLeadGridToBar(p,false));};
    const leadWrap=$('leadGridWrap');if(leadWrap){
      leadWrap.addEventListener('pointerdown',()=>{if((playing||starting)&&core.autoScroll)core.disableAutoScroll?.();},{passive:true});
      leadWrap.addEventListener('wheel',()=>{if((playing||starting)&&core.autoScroll)core.disableAutoScroll?.();},{passive:true});
      let leadTouchX=null,leadTouchY=null;
      leadWrap.addEventListener('touchstart',e=>{if(!e.touches?.length)return;leadTouchX=e.touches[0].clientX;leadTouchY=e.touches[0].clientY;},{passive:true});
      leadWrap.addEventListener('touchmove',e=>{if(!core.autoScroll||leadTouchX==null||!e.touches?.length)return;const dx=e.touches[0].clientX-leadTouchX,dy=e.touches[0].clientY-leadTouchY;if(Math.hypot(dx,dy)>10){leadTouchX=leadTouchY=null;core.disableAutoScroll?.();}},{passive:true});
      leadWrap.addEventListener('touchend',()=>{leadTouchX=leadTouchY=null;},{passive:true});
    }
    // Baby DAW chord/note navigation shares the project autoscroll state.  Keep
    // this local guard too because Parts playback can be active even when the
    // legacy CRP view is not the element that initiated playback.
    for(const nav of [$('progression'),$('midiRollTableWrap')].filter(Boolean)){
      nav.addEventListener('pointerdown',()=>{if((playing||starting)&&core.autoScroll)core.disableAutoScroll?.();},{passive:true});
      nav.addEventListener('wheel',()=>{if((playing||starting)&&core.autoScroll)core.disableAutoScroll?.();},{passive:true});
      let navTouchX=null,navTouchY=null;
      nav.addEventListener('touchstart',e=>{if(!e.touches?.length)return;navTouchX=e.touches[0].clientX;navTouchY=e.touches[0].clientY;},{passive:true});
      nav.addEventListener('touchmove',e=>{if(!core.autoScroll||navTouchX==null||!e.touches?.length)return;const dx=e.touches[0].clientX-navTouchX,dy=e.touches[0].clientY-navTouchY;if(Math.hypot(dx,dy)>10){navTouchX=navTouchY=null;core.disableAutoScroll?.();}},{passive:true});
      nav.addEventListener('touchend',()=>{navTouchX=navTouchY=null;},{passive:true});
    }
    $('leadGridOctave').onchange=e=>{const p=active();if(p?.type!=='lead')return;p.gridOctave=+e.target.value;renderLeadGrid(p);core.scheduleAutoSave();};
    $('leadResolution').onchange=e=>{const p=active();if(p?.type!=='lead')return;const old=p.resolution,neu=+e.target.value;if(old!==neu&&p.events.length&&!confirm('Changing resolution keeps notes at their step numbers, so their timing may shift. Continue?')){e.target.value=String(old);return;}p.resolution=neu;renderLeadEditor(p);core.scheduleAutoSave();};
    $('leadBars').onchange=e=>{const p=active();if(p?.type!=='lead')return;p.bars=+e.target.value;const maxSteps=leadTotalSteps(p);p.events=p.events.filter(x=>x.step<maxSteps).map(x=>({...x,durationSteps:Math.min(leadDurationSteps(x),Math.max(1,maxSteps-x.step))}));leadBarPage=Math.min(leadBarPage,p.bars-1);markPartsDirty();renderLeadEditor(p);core.scheduleAutoSave();};
    $('leadPrevBar').onclick=()=>{const p=active();if(p?.type!=='lead')return;leadBarPage=Math.max(0,leadBarPage-1);updateLeadBarUi(p);scrollLeadGridToBar(p,true);};$('leadNextBar').onclick=()=>{const p=active();if(p?.type!=='lead')return;leadBarPage=p.bars>1?(leadBarPage+1)%p.bars:0;updateLeadBarUi(p);scrollLeadGridToBar(p,true);};
    $('beatsSelect')?.addEventListener('change',()=>{if(active()?.type==='lead')renderLeadHarmony();});
    $('leadCopyBar').onclick=copyLeadBar;$('leadPasteBar').onclick=pasteLeadBar;
    $('leadClearBar').onclick=()=>{const p=active();if(p?.type!=='lead')return;const spb=p.resolution,start=leadBarPage*spb,end=start+spb;if(confirm(`Clear bar ${leadBarPage+1}?`)){p.events=p.events.filter(e=>e.step<start||e.step>=end);markPartsDirty();renderLeadGrid(p);core.scheduleAutoSave();}};
    $('leadVolume').oninput=e=>{const p=active();if(p?.type!=='lead')return;p.volume=+e.target.value/100;$('leadVolumeValue').textContent=`${e.target.value}%`;updatePartMiniVolume(p);if((playing||starting)&&partBuses.has(p.id))busFor(p,outputSoundFor(p));core.scheduleAutoSave();};
    $('vocalVolume').oninput=e=>{const p=active();if(p?.type!=='vocal')return;p.volume=+e.target.value/100;$('vocalVolumeValue').textContent=`${e.target.value}%`;applyVocalFxLive(p);updatePartMiniVolume(p);core.scheduleAutoSave();};
    $('vocalArmMic').onclick=async()=>{if(recording)return;if(micStream?.active){await disableMic();core.status('Mic test off.');return;}try{await ensureMic();core.status('Mic test on. Aim for strong level without living at the far right of the meter.');}catch(e){core.status(e.message||'Could not access microphone.');}};
    if($('vocalMasterPlayBtn'))$('vocalMasterPlayBtn').onclick=toggleVocalMasterPlayback;
    $('vocalRepeat').onchange=e=>{const p=active();if(p?.type!=='vocal')return;p.repeat=e.target.checked;core.scheduleAutoSave();};
    $('vocalRecordBtn').onclick=async()=>{await beginRecording();updateFloatRecorder();};$('vocalStopBtn').onclick=async()=>{await endRecording();updateFloatRecorder();};if($('vocalLyricsBtn'))$('vocalLyricsBtn').onclick=openLyricsOverlay;if($('srpLyricsCloseBtn'))$('srpLyricsCloseBtn').onclick=closeLyricsOverlay;if($('srpFloatRecord'))$('srpFloatRecord').onclick=async()=>{await beginRecording();updateFloatRecorder();};if($('srpFloatPause'))$('srpFloatPause').onclick=()=>{toggleRecordingPause();updateFloatRecorder();};if($('srpFloatStop'))$('srpFloatStop').onclick=async()=>{await endRecording();updateFloatRecorder();};
    window.addEventListener('message',(e)=>{
      if(e.origin!==location.origin)return;
      const d=e.data||{}; if(d.type!=='srp-playback-command')return;
      if(d.command==='play'){ if(!playing&&!starting) startPlayback(); }
      else if(d.command==='pause'){ if(playing||starting) stopPlayback(); }
      else if(d.command==='stop'){ stopPlayback(); }
      setTimeout(()=>{try{e.source?.postMessage({type:'crp-playback-state',playing:!!(playing||starting)},location.origin)}catch{}},40);
    });
    $('vocalBackingDrums').onchange=e=>{const p=active();if(p?.type!=='vocal')return;p.backingDrums=e.target.checked;core.scheduleAutoSave();};
    $('vocalBackingVolume').oninput=e=>{const p=active();if(p?.type!=='vocal')return;p.backingVolume=+e.target.value/100;$('vocalBackingVolumeValue').textContent=`${e.target.value}%`;core.scheduleAutoSave();};
    if($('vocalTranscribeBtn'))$('vocalTranscribeBtn').onclick=transcribeActiveTake;
    $('vocalTranscript').oninput=e=>{const p=active();if(p?.type!=='vocal')return;p.transcript=e.target.value;const t=p.recordings?.find(r=>r.id===p.activeTakeId);if(t)t.transcript=p.transcript;core.scheduleAutoSave();};
    for(const id of ['vocalFxEq','vocalFxComp','vocalFxReverb','vocalFxDelay'])$(id).onchange=()=>{const p=active();if(p?.type!=='vocal')return;p.fx={eq:$('vocalFxEq').value,comp:$('vocalFxComp').value,reverb:+$('vocalFxReverb').value,delay:+$('vocalFxDelay').value,autotune:Math.max(0,Math.min(100,Number($('vocalFxAutotune')?.value)||0))};applyVocalFxLive(p);core.scheduleAutoSave();};if($('vocalFxAutotune'))$('vocalFxAutotune').oninput=e=>{const p=active();if(p?.type!=='vocal')return;p.fx={...(p.fx||{}),autotune:Math.max(0,Math.min(100,Number(e.target.value)||0))};paintAutotuneSlider();if($('vocalFxAutotuneValue'))$('vocalFxAutotuneValue').textContent=`${Math.round(p.fx.autotune)}%`;if($('vocalAutotuneKey'))$('vocalAutotuneKey').textContent=vocalAutotuneScale().label;applyVocalFxLive(p);core.scheduleAutoSave();};
  }

  window.CRPParts={handlesPlayback:true,togglePlayback,startPlayback,openTrackMaster,openVoxBox:()=>openVoxBox(),liveEditRefresh,seekPlaybackToBeat,seekPlaybackToSeconds,isPlaying:()=>playing||starting,getPlaybackTiming(){
    const bpm=Math.max(40,Math.min(240,+playbackClockBpm||+core.bpm||92));
    const beatMs=60000/bpm;
    const transportActive=!!(playing||starting);
    // While Play is still loading/preparing, the musical clock does not exist yet.
    // SRP must wait for ready=true instead of interpreting 0 ms as "start now".
    if(!transportActive) return {playing:false,ready:false,bpm,beatMs,currentBeat:playbackClockStartBeat||0,msUntilNextBeat:null};
    if(!audioCtx||!playbackClockStartAudioTime) return {playing:true,ready:false,bpm,beatMs,currentBeat:playbackClockStartBeat||0,msUntilNextBeat:null};

    const elapsedMs=(audioCtx.currentTime-playbackClockStartAudioTime)*1000;
    const currentBeat=(playbackClockStartBeat||0)+(elapsedMs/beatMs);
    const phase=((currentBeat%1)+1)%1;
    let msUntilNextBeat=(1-phase)*beatMs;

    // "Next beat" means the NEXT STRICTLY-FUTURE beat. If the tap lands right on
    // a beat boundary, wait one whole beat rather than firing immediately.
    const boundaryToleranceMs=14;
    if(msUntilNextBeat<boundaryToleranceMs || beatMs-msUntilNextBeat<boundaryToleranceMs){
      msUntilNextBeat=beatMs;
    }
    return {playing:true,ready:true,bpm,beatMs,currentBeat,msUntilNextBeat};
  },isRecording:()=>recording,isRecordingPaused:()=>recordingPaused,beginVocalRecording:beginRecording,pauseVocalRecording:toggleRecordingPause,stopVocalRecording:endRecording,openLyricsOverlay,stopPlayback,capture,loadProject,newProject,syncActiveChord,syncCoreLive,syncCloudAudio,openStudioExport,openAudioExport,refreshBabySetupToggle,focusChordPart(){const c=parts.find(p=>p.type==='chord');if(!c){refreshBabySetupToggle();return;}if(activePartId!==c.id)selectPart(c.id);else{setEditorMode('chord');refreshBabySetupToggle();core.refreshSetupVisibility?.();}},getActiveChordId(){return loadedChordPartId;},getExportData(){syncLoadedChord();return clone(parts);}};
  // app.js intentionally loads first to expose CRPCore. Tell it that the parts module now
  // exists so the active saved project can be rehydrated with ALL Baby DAW parts before any
  // workspace navigation/save is allowed to capture state.
  try{window.dispatchEvent(new CustomEvent('crp-parts-ready'));}catch{}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',wire);else wire();
})();
