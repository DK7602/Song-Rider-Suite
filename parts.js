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
      const exactStart=Number(raw?.voxStartBeat),exactDur=Number(raw?.voxDurationBeats);
      const key=Number.isFinite(exactStart)&&exactStart>=0?`x:${exactStart.toFixed(3)}:${midi}`:`s:${step}:${midi}`,prev=byKey.get(key);
      if(!prev||durationSteps>prev.durationSteps)byKey.set(key,{step,midi,durationSteps,...(raw?.voxId?{voxId:String(raw.voxId)}:{}),...(raw?.voxBlank===true?{voxBlank:true}:{}),...(Number.isFinite(exactStart)&&exactStart>=0?{voxStartBeat:exactStart}:{}),...(Number.isFinite(exactDur)&&exactDur>0?{voxDurationBeats:exactDur}:{})});
    }
    return [...byKey.values()].sort((a,b)=>a.step-b.step||a.midi-b.midi);
  }


  // v3.3.37 — repair duplicated chord-card identities. v3.3.35/36's Track Master
  // blank-card insertion could append the same new card twice to the final row.
  // Because both entries shared one voxId, they rendered as stacked/phantom blocks
  // and required repeated Delete presses. Keep exactly one stored card per voxId.
  function dedupeChordRows(data){
    if(!data)return false;
    if(!Array.isArray(data.rows)||!data.rows.length){data.rows=[[]];return false;}
    const seenIds=new Set(),seenRefs=new Set();let changed=false;
    data.rows=data.rows.map(raw=>{
      const out=[];
      for(const card of Array.isArray(raw)?raw:[]){
        if(!card||typeof card!=='object'){out.push(card);continue;}
        const id=String(card.voxId||'');
        if(seenRefs.has(card)||(id&&seenIds.has(id))){changed=true;continue;}
        seenRefs.add(card);if(id)seenIds.add(id);out.push(card);
      }
      return out;
    });
    if(!data.rows.length)data.rows=[[]];
    return changed;
  }


  // v3.3.59 — repair the dual chord-duration representation used by CRP MIDI
  // (durationBeats) and Track Master (voxDurationBeats). Current Track Master
  // edits write both fields together, so a disagreement means an older MIDI edit
  // was saved beside stale timeline metadata. The visible CRP/MIDI duration is the
  // canonical value; if only the Track Master value exists, promote it so both UIs
  // render and save the same length.
  function normalizeChordDurations(data){
    if(!data?.rows)return false;
    let changed=false;
    for(const row of data.rows)for(const card of Array.isArray(row)?row:[]){
      if(!card||typeof card!=='object')continue;
      const drawn=Number(card.durationBeats),timeline=Number(card.voxDurationBeats);
      if(Number.isFinite(drawn)&&drawn>0){
        // Do not quantize here: Track Master supports unsnapped/free durations.
        // We only reconcile a disagreement; equal exact values stay untouched.
        if(Number.isFinite(timeline)&&timeline>0&&Math.abs(timeline-drawn)>1e-9){card.voxDurationBeats=drawn;changed=true;}
      }else if(Number.isFinite(timeline)&&timeline>0){
        card.durationBeats=timeline;changed=true;
      }
    }
    return changed;
  }

  let parts=[];
  let activePartId=null;
  let loadedChordPartId=null;
  let leadBarPage=0;
  let leadGridCollapsed=false;
  try{leadGridCollapsed=localStorage.getItem('crp-lead-grid-collapsed-v1')==='1';}catch{}
  let playing=false, starting=false, playbackGeneration=0;
  let playbackScope=null; // null = normal enabled-part playback; otherwise a scoped Lead/Vocal preview
  let playbackClockStartAudioTime=0, playbackClockStartBeat=0, playbackClockBpm=92, playbackTotalBeats=0, playbackLoopStartBeat=0;
  let songStartBeat=0, songEndBeat=null, songEndUiTimer=null;
  let drumEvents=[];
  let drumArrangementInitialized=false;
  let voxLastHarmonyBeatKey='';
  let liveEditTimer=null,bpmRestartTimer=null,mediaPositionTimer=null,mediaKeepAlive=null,mediaKeepAliveUrl='',mediaPausedBeat=0,mediaActionsInstalled=false;
  let liveVocalFxNodes=new Map();
  let audioCtx=null, masterLimiter=null, cycleTimer=null;
  let playerCache=new Map(), resolvedPlayerCache=new Map(), lastReadyPlayer=new Map(), playerSound=new WeakMap(), partBuses=new Map(), partHandoffGates=new Map(), partInstrumentFx=new Map(), highlightTimers=[], activeVoices=new Set(), vocalBufferCache=new Map(), activeVocalSources=new Set();
  // v3.3.54 — cached waveform envelopes keep Track Master navigation from rescanning
  // millions of audio samples on the UI thread while WebAudio playback is running.
  const voxWaveformPeakCache=new Map();
  let micStream=null,micCtx=null,micSource=null,micAnalyser=null,micProcessor=null,micSilentGain=null,micMeterRaf=0;
  let recording=false,recordingPaused=false,recordingResuming=false,recordChunks=[],recordSampleRate=48000,recordStartedAt=0,recordCaptureStartMicTime=0,recordInitialTrimSec=0,recordPausedAt=0,recordPausedTotal=0,recordTimer=null,recordResumeTimer=null,currentPreview=null,recordInsertBeat=0,recordTargetPartId=null,recordStartedFromVox=false,recordResumeBeat=0;
  let leadBarClipboard=null, speechRec=null, speechBase='';
  let partsUpdatedAt=0, partsFingerprint='';
  let voxBoxOpen=false,voxCropMode=false,voxRangeMode=false,voxRangeSelection=null,voxSelected=null,voxSelections=[],voxInstrumentSelection=null,voxInstrumentSelections=[],voxInstrumentTrackFocus=null,voxTargetPartId=null,voxClipboard=null,voxPlayheadBeat=0,voxRenderToken=0,voxAutoScroll=true,voxShowInstrumentals=false,voxOpenedFromVocal=false,voxToolMode='playhead',voxUndoStack=[],voxRedoStack=[],voxInspectorManualOverride=null;
  // v3.3.36 — persists across Track Master rerenders so Android's synthesized dblclick/click
  // cannot create or refocus a second phantom event after a touch double-tap.
  let voxLaneAddGuard={partId:'',at:0,x:0,y:0};
  // v3.3.34 — mobile soft keyboards resize the visual viewport. A Vox inline
  // editor must survive that height-only resize or Android immediately removes
  // the input, blurs it, and collapses the keyboard. Track the layout width so
  // only genuine width/orientation changes rebuild the timeline.
  let voxLastLayoutWidth=Math.round(window.innerWidth||document.documentElement.clientWidth||0);
  const VOX_SNAP_KEY='crp-vox-snap-v1',VOX_RES_KEY='crp-vox-resolution-v1',VOX_AUTO_KEY='crp-vox-autoscroll-v1',VOX_INST_KEY='crp-vox-instrumentals-v1',VOX_TRANSPORT_POS_KEY='crp-vox-transport-pos-v1',VOX_TOOL_KEY='crp-vox-tool-v1',VOX_TRACK_ORDER_KEY='crp-vox-track-order-v1',VOX_INSPECTOR_COLLAPSED_KEY='crp-vox-inspector-collapsed-v1';
  function markPartsDirty(){ partsUpdatedAt=Date.now(); return partsUpdatedAt; }

  function chordPart(name='Chords 1', data=null){
    const d=data?clone(data):core.snapshot();
    if(!d.rows?.length)d.rows=[[]];
    dedupeChordRows(d);normalizeChordDurations(d);
    return {id:uid(),type:'chord',name,enabled:true,muted:false,solo:false,voxSetupEstablished:false,volume:.85,data:d};
  }
  function leadPart(name='Lead 1'){
    return {id:uid(),type:'lead',name,enabled:true,muted:false,solo:false,voxSetupEstablished:false,repeat:true,sustain:false,volume:.8,instrument:'piano',sound:'acoustic_grand_piano',octave:0,gridOctave:3,resolution:16,bars:4,barsMode:'fixed',events:[]};
  }
  function vocalPart(name='Vocals 1'){
    return {id:uid(),type:'vocal',name,enabled:true,muted:false,solo:false,repeat:true,volume:1,transcript:'',recordings:[],activeTakeId:null,voxEvents:[],backingPartIds:parts.filter(x=>x.type==='chord'||x.type==='lead').filter(x=>x.enabled).map(x=>x.id),backingDrums:true,backingVolume:.8,fx:{eq:'clear',comp:'medium',reverb:.12,delay:0,autotune:0}};
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
    const base={id:p.id||uid(),name:p.name||`${p.type==='chord'?'Chords':p.type==='lead'?'Lead':'Vocals'} ${i+1}`,enabled:p.enabled!==false,muted:p.muted===true,solo:p.solo===true,voxSetupEstablished:p.voxSetupEstablished===true,volume:Number.isFinite(+p.volume)?Math.max(0,Math.min(1,+p.volume)):.85};
    if(p.type==='chord'){const data=clone(p.data||core.snapshot());dedupeChordRows(data);normalizeChordDurations(data);return {...base,type:'chord',data};}
    if(p.type==='lead')return {...base,type:'lead',repeat:p.repeat!==false,sustain:p.sustain===true,instrument:['piano','guitar','misc'].includes(p.instrument)?p.instrument:'piano',sound:p.sound||'acoustic_grand_piano',octave:Number(p.octave)||0,gridOctave:Number(p.gridOctave)||3,resolution:[8,16,32,64].includes(+p.resolution)?+p.resolution:16,bars:Math.max(1,Math.min(256,+p.bars||4)),barsMode:p.barsMode==='song'?'song':'fixed',events:normalizeLeadEvents(p.events)};
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
  function currentBeatMixState(){return window.CRPBeatMaker?.getBeat?.()||null;}
  function anyTrackSoloed(){
    const partSolo=parts.some(p=>p.enabled!==false&&p.solo===true&&p.muted!==true);
    const b=currentBeatMixState();
    return partSolo||!!(b&&b.enabled!==false&&b.solo===true&&b.muted!==true);
  }
  function partAudibleInMix(p){
    if(!p||p.enabled===false||p.muted===true)return false;
    return !anyTrackSoloed()||p.solo===true;
  }
  function drumsAudibleInMix(){
    const b=currentBeatMixState();
    if(!b||b.enabled===false||b.muted===true)return false;
    return !anyTrackSoloed()||b.solo===true;
  }
  function currentDrumScopeGain(){return playbackScope?Math.max(0,Math.min(1,Number(playbackScope?.drumGain??1))):1;}
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
  // v3.3.60 — every chord/note part is part of one song, so they all share one
  // project key. Keep legacy/new Baby DAW chord tracks from carrying their own
  // stale key that can overwrite CRP when the user switches parts.
  function normalizeSongKeyValue(raw){return String(raw||'').trim();}
  function syncSongKeyAcrossChordParts(raw){
    const key=normalizeSongKeyValue(raw);if(!key)return key;
    for(const part of parts){
      if(part?.type!=='chord')continue;
      if(!part.data)part.data=core.snapshot();
      part.data.key=key;
    }
    return key;
  }
  function currentSongKey(){return normalizeSongKeyValue(core.snapshot()?.key)||normalizeSongKeyValue(parts.find(p=>p?.type==='chord'&&p.data?.key)?.data?.key);}
  function syncLoadedChord(){
    const p=loadedChord();
    if(!p)return;
    // v3.3.35 — while Track Master / Vox Box is open, the timeline's part data is
    // the editing authority. Autosave calls capture(), and capture() historically
    // replaced p.data with a fresh core.snapshot(). That invalidated the live card
    // object references held by inline editors / drag / trim / delete. The exact
    // symptom was: the typed chord auditioned, but the visible block stayed blank,
    // and the same block could no longer be deleted, moved, or resized reliably.
    // Capture the core -> part snapshot before opening Vox Box instead; while Vox is
    // open, keep the existing part/card identities stable.
    if(voxBoxOpen)return;
    p.data=core.snapshot();
    syncSongKeyAcrossChordParts(p.data.key);
  }
  function syncActiveChord(){
    const p=active();
    if(p?.type==='chord'&&p.id===loadedChordPartId){p.data=core.snapshot();syncSongKeyAcrossChordParts(p.data.key);}
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
      const songKey=currentSongKey();if(songKey){p.data.key=songKey;syncSongKeyAcrossChordParts(songKey);}
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
    const slider=$('activePartVolume');const paintRange=el=>el?.style.setProperty('--range-fill',`${el.value}%`);paintRange(slider);slider.oninput=()=>{paintRange(slider);p.volume=+slider.value/100;$('activePartVolumeValue').textContent=`${slider.value}%`;const pill=[...document.querySelectorAll('.part-pill')].find(x=>x.querySelector('.part-open')?.textContent===p.name);if(pill)pill.querySelector('.part-mini-vol').textContent=`${slider.value}%`;if(p.type==='lead'&&$('leadVolume')){$('leadVolume').value=slider.value;$('leadVolumeValue').textContent=`${slider.value}%`;}if(p.type==='vocal'&&$('vocalVolume')){$('vocalVolume').value=slider.value;$('vocalVolumeValue').textContent=`${slider.value}%`;applyVocalFxLive(p);}else if((playing||starting)&&partBuses.has(p.id))busFor(p,outputSoundFor(p));syncPartVolumeControls(p,slider.value);core.scheduleAutoSave();};
  }
  function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));}

  function openModal(){if($('addPartModal'))$('addPartModal').hidden=false;}
  function closeModal(){if($('addPartModal'))$('addPartModal').hidden=true;}
  function countType(type){return parts.filter(p=>p.type===type).length;}
  function addPart(type){
    syncLoadedChord();let p;
    if(type==='chord'){
      const snap=core.snapshot();
      p=chordPart(`Chords ${countType('chord')+1}`,{...snap,rows:[[]],key:normalizeSongKeyValue(snap.key)});
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
    let raw=String(data?.key||'').trim().replace(/♭/g,'b').replace(/♯/g,'#');
    let root=null,minor=false;
    let m=raw.match(/^([A-Ga-g])([#b]?)(?:\s*(m|minor|maj|major))?$/i);
    if(m){root=m[1].toUpperCase()+m[2];minor=/^(m|minor)$/i.test(m[3]||'');}
    // Legacy Baby DAW chord parts may have saved with an empty/per-part key. The
    // live CRP project key is the song-level authority before any chord fallback.
    if(root==null){
      raw=String(core.snapshot()?.key||'').trim().replace(/♭/g,'b').replace(/♯/g,'#');
      m=raw.match(/^([A-Ga-g])([#b]?)(?:\s*(m|minor|maj|major))?$/i);
      if(m){root=m[1].toUpperCase()+m[2];minor=/^(m|minor)$/i.test(m[3]||'');}
    }
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
  function leadExactEventEndBeat(p){
    const events=p?.events||[];
    return events.length?Math.max(0,...events.map(e=>leadEventStartBeat(p,e)+leadEventDurationBeats(p,e))):0;
  }
  function leadSongLengthBeats(p){
    const explicit=Number(songEndBeat);
    if(Number.isFinite(explicit)&&explicit>effectiveSongStartBeat()+.03)return explicit;
    let end=0;
    for(const q of parts){
      if(!q||q===p)continue;
      if(q.type==='chord')end=Math.max(end,partDurationBeats(q));
      else if(q.type==='lead')end=Math.max(end,leadExactEventEndBeat(q),q.barsMode==='fixed'?(Number(q.bars)||0)*4:0);
      else if(q.type==='vocal')end=Math.max(end,vocalDurationBeats(q));
    }
    ensureLegacyDrumEvent();
    if(drumEvents.length)end=Math.max(end,...drumEvents.map(e=>(Number(e.startBeat)||0)+(Number(e.durationBeats)||0)));
    end=Math.max(end,leadExactEventEndBeat(p));
    return Math.max(4,end||4);
  }
  function syncLeadBarsToSong(p){
    if(!p||p.type!=='lead'||p.barsMode!=='song')return false;
    const eventBars=Math.max(1,Math.ceil(leadExactEventEndBeat(p)/4));
    const songBars=Math.max(1,Math.ceil(leadSongLengthBeats(p)/4));
    const next=Math.max(eventBars,Math.min(256,songBars));
    if(next===p.bars)return false;
    p.bars=next;
    return true;
  }
  function paintLeadBarsControl(p){
    const sel=$('leadBars');if(!sel)return;
    let songOpt=sel.querySelector('option[value="song"]');
    if(songOpt)songOpt.textContent=`Length of Song (${Math.max(1,Number(p?.bars)||1)} bars)`;
    sel.value=p?.barsMode==='song'?'song':String(p?.bars||4);
    if(sel.value===''){
      const val=Math.max(1,Math.min(256,Number(p?.bars)||4));
      let custom=sel.querySelector(`option[data-custom-bars="${val}"]`);
      if(!custom){custom=document.createElement('option');custom.value=String(val);custom.dataset.customBars=String(val);custom.textContent=String(val);sel.insertBefore(custom,songOpt||null);}
      sel.value=String(val);
    }
  }
  function renderLeadEditor(p=active()){
    if(!p||p.type!=='lead')return;
    $('leadPartTitle').textContent=p.name;p.repeat=!!core.loop;if($('leadRepeat'))$('leadRepeat').checked=!!core.loop;if($('leadSustain'))$('leadSustain').checked=p.sustain===true;
    $('leadVolume').value=Math.round(p.volume*100);$('leadVolumeValue').textContent=`${Math.round(p.volume*100)}%`;
    syncLeadBarsToSong(p);renderLeadSoundControls(p);$('leadGridOctave').value=String(p.gridOctave);$('leadResolution').value=String(p.resolution);paintLeadBarsControl(p);
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
    return p.events.find(e=>e.voxBlank!==true&&e.midi===midi&&step>=e.step&&step<e.step+leadDurationSteps(e))||null;
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
        cell.onclick=()=>{if(leadEventCovering(p,midi,s))return;const ev={step:s,midi,durationSteps:1};p.events.push(ev);p.events=normalizeLeadEvents(p.events);auditionLeadNote(p,midi);markPartsDirty();renderLeadGrid(p);core.scheduleAutoSave();};
        grid.appendChild(cell);
      }
    }
    for(const event of p.events){
      if(event.voxBlank===true)continue;
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
  function leadEventGridOctave(event){
    const midi=Math.max(0,Math.min(127,Number(event?.midi)||0));
    return Math.max(0,Math.min(9,Math.floor(midi/12)-1));
  }
  function leadEventBarIndex(p,event){return Math.max(0,Math.floor(leadEventStartBeat(p,event)/4));}
  function leadActiveBars(p,octaves=null){
    const allowed=octaves?new Set(octaves.map(Number)):null,out=new Set();
    for(const e of p?.events||[]){if(allowed&&!allowed.has(leadEventGridOctave(e)))continue;const b=leadEventBarIndex(p,e);if(b>=0&&b<p.bars)out.add(b);}
    return [...out].sort((a,b)=>a-b);
  }
  function leadActiveOctaves(p,bars=null){
    const allowed=bars?new Set(bars.map(Number)):null,out=new Set();
    for(const e of p?.events||[]){if(allowed&&!allowed.has(leadEventBarIndex(p,e)))continue;out.add(leadEventGridOctave(e));}
    return [...out].filter(o=>o>=1&&o<=6).sort((a,b)=>a-b);
  }
  function closeBdBatchModal(){document.getElementById('bdBatchModal')?.remove();}
  function openBdBatchModal({title,help='',bars=[],activeBars=[],octaves=[],activeOctaves=[],defaultBars=[],defaultOctaves=[],confirmText='Apply',targetBar=false,targetOctave=false,targetOctaves=null,barsLabel='Bars',onConfirm}){
    closeBdBatchModal();
    const modal=document.createElement('div');modal.id='bdBatchModal';modal.className='bd-batch-backdrop';
    const barSet=new Set(defaultBars.map(Number)),octSet=new Set(defaultOctaves.map(Number)),activeBarSet=new Set(activeBars.map(Number)),activeOctSet=new Set(activeOctaves.map(Number));
    const barHtml=bars.map(b=>`<label class="bd-batch-check ${activeBarSet.has(b)?'is-active':''}"><input type="checkbox" data-batch-bar="${b}" ${barSet.has(b)?'checked':''}><span>Bar ${b+1}</span>${activeBarSet.has(b)?'<small>active</small>':''}</label>`).join('');
    const octHtml=octaves.map(o=>`<label class="bd-batch-check ${activeOctSet.has(o)?'is-active':''}"><input type="checkbox" data-batch-octave="${o}" ${octSet.has(o)?'checked':''}><span>Grid ${o}</span>${activeOctSet.has(o)?'<small>active</small>':''}</label>`).join('');
    const targetBarHtml=targetBar?`<label class="bd-batch-field">Paste / duplicate starting at<select id="bdBatchTargetBar">${bars.map(b=>`<option value="${b}">Bar ${b+1}</option>`).join('')}</select></label>`:'';
    const targetGridChoices=Array.isArray(targetOctaves)?targetOctaves:octaves;const targetOctHtml=targetOctave?`<label class="bd-batch-field">Target octave grid<select id="bdBatchTargetOctave"><option value="keep">Keep original grids</option>${targetGridChoices.map(o=>`<option value="${o}">Move phrase to Grid ${o}</option>`).join('')}</select></label>`:'';
    modal.innerHTML=`<div class="bd-batch-card" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}"><h3>${escapeHtml(title)}</h3>${help?`<p class="subtle tiny">${escapeHtml(help)}</p>`:''}<div class="bd-batch-section"><div class="bd-batch-section-head"><strong>${escapeHtml(barsLabel)}</strong><div class="bd-batch-quick"><button type="button" data-bars-active>Active bars</button><button type="button" data-bars-all>All bars</button><button type="button" data-bars-none>None</button></div></div><div class="bd-batch-grid">${barHtml}</div></div>${octaves.length?`<div class="bd-batch-section"><div class="bd-batch-section-head"><strong>Octave grids</strong><div class="bd-batch-quick"><button type="button" data-oct-active>Active grids</button><button type="button" data-oct-all>All grids</button><button type="button" data-oct-none>None</button></div></div><div class="bd-batch-grid">${octHtml}</div></div>`:''}${targetBarHtml}${targetOctHtml}<div class="bd-batch-actions"><button type="button" data-cancel>Cancel</button><button type="button" class="accent" data-confirm>${escapeHtml(confirmText)}</button></div></div>`;
    document.body.appendChild(modal);
    const checks=(sel)=>[...modal.querySelectorAll(sel)],setChecks=(sel,values)=>{const allowed=new Set(values.map(Number));for(const c of checks(sel)){const raw=c.dataset.batchBar??c.dataset.batchOctave??c.value;c.checked=allowed.has(Number(raw));}};
    modal.querySelector('[data-bars-active]').onclick=()=>setChecks('[data-batch-bar]',activeBars);modal.querySelector('[data-bars-all]').onclick=()=>checks('[data-batch-bar]').forEach(c=>c.checked=true);modal.querySelector('[data-bars-none]').onclick=()=>checks('[data-batch-bar]').forEach(c=>c.checked=false);
    if(octaves.length){modal.querySelector('[data-oct-active]').onclick=()=>setChecks('[data-batch-octave]',activeOctaves);modal.querySelector('[data-oct-all]').onclick=()=>checks('[data-batch-octave]').forEach(c=>c.checked=true);modal.querySelector('[data-oct-none]').onclick=()=>checks('[data-batch-octave]').forEach(c=>c.checked=false);}
    modal.querySelector('[data-cancel]').onclick=closeBdBatchModal;modal.addEventListener('click',e=>{if(e.target===modal)closeBdBatchModal();});
    if(targetBar){const target=modal.querySelector('#bdBatchTargetBar');target.value=String(Math.max(0,Math.min(bars.length-1,leadBarPage)));target.onchange=()=>setChecks('[data-batch-bar]',[Number(target.value)]);}
    if(targetOctave)modal.querySelector('#bdBatchTargetOctave').value='keep';
    modal.querySelector('[data-confirm]').onclick=()=>{const pickedBars=checks('[data-batch-bar]:checked').map(c=>Number(c.dataset.batchBar)),pickedOctaves=checks('[data-batch-octave]:checked').map(c=>Number(c.dataset.batchOctave)),tb=targetBar?Number(modal.querySelector('#bdBatchTargetBar')?.value||0):null,to=targetOctave?String(modal.querySelector('#bdBatchTargetOctave')?.value||'keep'):null;if(!pickedBars.length){core.status('Choose at least one bar.');return;}if(octaves.length&&!pickedOctaves.length){core.status('Choose at least one octave grid.');return;}closeBdBatchModal();onConfirm?.({bars:pickedBars,octaves:pickedOctaves,targetBar:tb,targetOctave:to});};
  }
  function syncLeadEditViews(p,message=''){
    markPartsDirty();
    if(active()?.id===p.id)renderLeadEditor(p);
    if(voxBoxOpen)renderVoxBox();
    core.scheduleAutoSave();
    if(message)core.status(message);
  }
  function copyLeadBar(){
    const p=active();if(!p||p.type!=='lead')return;const bars=Array.from({length:p.bars},(_,i)=>i),octaves=[1,2,3,4,5,6],activeBars=leadActiveBars(p),activeOctaves=leadActiveOctaves(p),defaultBars=activeBars.includes(leadBarPage)?[leadBarPage]:(activeBars.length?activeBars:[leadBarPage]),defaultOctaves=activeOctaves.includes(p.gridOctave)?[p.gridOctave]:(activeOctaves.length?activeOctaves:[p.gridOctave]);
    openBdBatchModal({title:'Copy Lead / Bass',help:'Choose any active bars and octave grids. Multi-bar timing is preserved when you paste.',bars,activeBars,octaves,activeOctaves,defaultBars,defaultOctaves,confirmText:'Copy',onConfirm:({bars:selectedBars,octaves:selectedOctaves})=>{
      const barSet=new Set(selectedBars),octSet=new Set(selectedOctaves),minBar=Math.min(...selectedBars),maxBar=Math.max(...selectedBars),items=[];
      for(const e of p.events||[]){const b=leadEventBarIndex(p,e),o=leadEventGridOctave(e);if(!barSet.has(b)||!octSet.has(o))continue;const start=leadEventStartBeat(p,e),dur=leadEventDurationBeats(p,e);items.push({event:clone(e),deltaBeat:start-minBar*4,durationBeats:dur,sourceOctave:o});}
      if(!items.length){core.status('No Lead/Bass notes are inside that bar / octave selection.');return;}
      leadBarClipboard={version:2,items,spanBars:maxBar-minBar+1,sourceBars:[...selectedBars],sourceOctaves:[...selectedOctaves],sourceMinOctave:Math.min(...selectedOctaves)};
      if($('leadPasteBar'))$('leadPasteBar').disabled=false;core.status(`Copied ${items.length} note${items.length===1?'':'s'} from ${selectedBars.length} bar${selectedBars.length===1?'':'s'} / ${selectedOctaves.length} grid${selectedOctaves.length===1?'':'s'}.`);
    }});
  }
  function pasteLeadBar(){
    const p=active();if(!p||p.type!=='lead'||!leadBarClipboard){core.status('Copy Lead/Bass notes first.');return;}const bars=Array.from({length:p.bars},(_,i)=>i),octaves=[1,2,3,4,5,6],activeBars=leadActiveBars(p),activeOctaves=leadActiveOctaves(p);
    openBdBatchModal({title:'Paste Lead / Bass',help:'Choose one or more destination bars. The copied phrase is pasted starting at every checked bar. “Move phrase to Grid” transposes every copied note by whole octaves while preserving intervals.',bars,activeBars,octaves:[],activeOctaves:[],defaultBars:[leadBarPage],defaultOctaves:[],targetBar:true,targetOctave:true,targetOctaves:octaves,barsLabel:'Destination bars',confirmText:'Paste',onConfirm:({bars:selectedBars,targetBar,targetOctave})=>{
      const clip=leadBarClipboard,items=clip.items||[];if(!items.length)return;
      const destinations=[...new Set((selectedBars?.length?selectedBars:[targetBar]).map(Number))].filter(Number.isFinite).sort((a,b)=>a-b);if(!destinations.length)return;
      const span=Math.max(1,Number(clip.spanBars)||1),needed=Math.max(...destinations.map(b=>b+span));if(needed>p.bars){p.bars=Math.min(256,needed);if(p.barsMode==='song')p.barsMode='fixed';}
      const shift=targetOctave==='keep'?0:(Number(targetOctave)-Number(clip.sourceMinOctave||p.gridOctave))*12,stepBeats=4/Math.max(8,Number(p.resolution)||16),newEvents=[];
      for(const destBar of destinations){
        for(const item of items){const startBeat=destBar*4+Math.max(0,Number(item.deltaBeat)||0);if(startBeat>=p.bars*4)continue;const durationBeats=Math.max(stepBeats,Math.min(Number(item.durationBeats)||stepBeats,p.bars*4-startBeat)),midi=Math.max(0,Math.min(127,(Number(item.event?.midi)||60)+shift)),e={...clone(item.event),voxId:uid(),midi,voxStartBeat:startBeat,voxDurationBeats:durationBeats,step:Math.max(0,Math.round(startBeat/stepBeats)),durationSteps:Math.max(1,Math.round(durationBeats/stepBeats))};newEvents.push(e);}
      }
      p.events=normalizeLeadEvents([...(p.events||[]),...newEvents]);leadBarPage=Math.min(p.bars-1,destinations[0]);syncLeadEditViews(p,`Pasted ${newEvents.length} note${newEvents.length===1?'':'s'} to ${destinations.length} destination bar${destinations.length===1?'':'s'}${targetOctave==='keep'?'':` on Grid ${targetOctave}`}.`);
    }});
  }
  function clearLeadBars(){
    const p=active();if(!p||p.type!=='lead')return;const bars=Array.from({length:p.bars},(_,i)=>i),octaves=[1,2,3,4,5,6],activeBars=leadActiveBars(p),activeOctaves=leadActiveOctaves(p),defaultBars=activeBars.includes(leadBarPage)?[leadBarPage]:(activeBars.length?activeBars:[leadBarPage]),defaultOctaves=activeOctaves.includes(p.gridOctave)?[p.gridOctave]:(activeOctaves.length?activeOctaves:[p.gridOctave]);
    openBdBatchModal({title:'Clear Lead / Bass',help:'Only notes in the checked bars and octave grids are removed.',bars,activeBars,octaves,activeOctaves,defaultBars,defaultOctaves,confirmText:'Clear selected',onConfirm:({bars:selectedBars,octaves:selectedOctaves})=>{const barSet=new Set(selectedBars),octSet=new Set(selectedOctaves),before=p.events.length;p.events=(p.events||[]).filter(e=>!(barSet.has(leadEventBarIndex(p,e))&&octSet.has(leadEventGridOctave(e))));const removed=before-p.events.length;syncLeadEditViews(p,`Cleared ${removed} note${removed===1?'':'s'} from the selected bars / grids.`);}});
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
    micCtx=new (window.AudioContext||window.webkitAudioContext)({sampleRate:48000});if(micCtx.state==='suspended')await micCtx.resume();recordSampleRate=micCtx.sampleRate;micSource=micCtx.createMediaStreamSource(micStream);micAnalyser=micCtx.createAnalyser();micAnalyser.fftSize=1024;micAnalyser.smoothingTimeConstant=.72;micSource.connect(micAnalyser);startMicMeter();const track=micStream.getAudioTracks()[0];const st=track.getSettings?.()||{};$('vocalMicInfo').textContent=`${track.label||'Phone microphone'} • ${st.sampleRate||recordSampleRate} Hz${st.channelCount?` • ${st.channelCount} ch`:''}`;if($('vocalArmMic')){$('vocalArmMic').textContent='Mic test off';$('vocalArmMic').setAttribute('aria-pressed','true');}return micStream;
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
  function floatToWav(chunks,sampleRate,trimStartSamples=0){
    const total=chunks.reduce((n,a)=>n+a.length,0),trim=Math.max(0,Math.min(total,Math.round(Number(trimStartSamples)||0))),length=Math.max(0,total-trim),samples=new Float32Array(length);
    let skip=trim,o=0;
    for(const a of chunks){
      if(skip>=a.length){skip-=a.length;continue;}
      const src=skip>0?a.subarray(skip):a;skip=0;
      const n=Math.min(src.length,length-o);if(n<=0)break;samples.set(src.subarray(0,n),o);o+=n;
    }
    const buffer=new ArrayBuffer(44+samples.length*2),view=new DataView(buffer),write=(off,str)=>{for(let i=0;i<str.length;i++)view.setUint8(off+i,str.charCodeAt(i));};write(0,'RIFF');view.setUint32(4,36+samples.length*2,true);write(8,'WAVE');write(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,sampleRate,true);view.setUint32(28,sampleRate*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);write(36,'data');view.setUint32(40,samples.length*2,true);let pos=44;for(let i=0;i<samples.length;i++){let x=Math.max(-1,Math.min(1,samples[i]));view.setInt16(pos,x<0?x*0x8000:x*0x7fff,true);pos+=2;}return new Blob([buffer],{type:'audio/wav'});
  }
  async function beginRecording(options={}){
    const requestedPartId=options?.partId||null;
    if(requestedPartId){const rp=parts.find(x=>x.type==='vocal'&&String(x.id)===String(requestedPartId));if(rp)activePartId=rp.id;}
    const p=active();if(!p||p.type!=='vocal'||recording)return;
    const fromBeat=Math.max(0,Number(options?.fromBeat)||0);
    const fromVox=!!options?.voxBox;
    try{
      stopPreview();await ensureMic();window.CRPParts?.stopPlayback?.();
      clearTimeout(recordResumeTimer);recordResumeTimer=null;recordingResuming=false;
      recordChunks=[];recordInsertBeat=fromBeat;recordTargetPartId=p.id;recordStartedFromVox=fromVox;recordResumeBeat=fromBeat;recordInitialTrimSec=0;
      micProcessor=micCtx.createScriptProcessor(4096,1,1);micSilentGain=micCtx.createGain();micSilentGain.gain.value=0;micSource.connect(micProcessor);micProcessor.connect(micSilentGain);micSilentGain.connect(micCtx.destination);
      recordCaptureStartMicTime=micCtx.currentTime;
      micProcessor.onaudioprocess=e=>{if(recording&&!recordingPaused)recordChunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));};
      recording=true;recordingPaused=false;recordPausedAt=0;recordPausedTotal=0;recordStartedAt=performance.now();
      if($('vocalSpeechStatus'))$('vocalSpeechStatus').textContent='Recording clean WAV. Cloud transcription runs after the take is saved.';
      if($('vocalRecordBtn')){$('vocalRecordBtn').classList.add('recording');$('vocalRecordBtn').disabled=true;}
      if($('vocalStopBtn'))$('vocalStopBtn').disabled=false;
      const oldStates=new Map(parts.map(x=>[x.id,x.enabled]));p._recordOldStates=oldStates;p._recordOldVolumes=new Map(parts.map(x=>[x.id,x.volume]));
      parts.forEach(x=>{if(x.type==='chord'||x.type==='lead'){x.enabled=p.backingPartIds.includes(x.id);x.volume=(p._recordOldVolumes.get(x.id)??x.volume)*(p.backingVolume??.8);}});
      const drumToggle=$('crpDrumsToggle');if(drumToggle){p._recordOldDrums=drumToggle.checked;drumToggle.checked=p.backingDrums!==false;drumToggle.dispatchEvent(new Event('change'));}
      const drumVol=$('crpDrumVolume');if(drumVol){p._recordOldDrumVol=drumVol.value;drumVol.value=String(Math.round(+drumVol.value*(p.backingVolume??.8)));drumVol.dispatchEvent(new Event('input'));}
      renderParts();

      // v3.3.67 — remove arbitrary recorder delay. Start the backing, measure the
      // actual preload + WebAudio lead-in, and trim that exact pre-roll from the
      // saved WAV so sample 0 lands on the backing downbeat.
      await startPlayback({fromBeat:recordInsertBeat});
      const micElapsed=Math.max(0,(micCtx?.currentTime||0)-recordCaptureStartMicTime),backingStarted=!!((playing||starting)&&audioCtx&&playbackClockStartAudioTime);
      recordInitialTrimSec=backingStarted?Math.max(0,micElapsed+playbackLeadRemainingSec()):0;
      recordTimer=setInterval(()=>{const now=recordingPaused?recordPausedAt:performance.now(),elapsed=Math.max(0,(now-recordStartedAt-recordPausedTotal-recordInitialTrimSec*1000)/1000);if($('vocalTimer'))$('vocalTimer').textContent=fmtTime(elapsed);updateVoxTransportState();},100);

      if(fromVox){voxTargetPartId=p.id;updateVoxPlayhead(recordInsertBeat,true);voxStatus(`Recording into ${p.name} from beat ${recordInsertBeat.toFixed(2)}…`);}
      core.status('Recording dry WAV in beat sync. Use headphones so the backing does not bleed into the mic.');updateVoxTransportState();
    }catch(e){console.error(e);core.status(e.message||'Could not start microphone.');recordStartedFromVox=false;recordTargetPartId=null;recordInitialTrimSec=0;recordCaptureStartMicTime=0;}
  }
  async function endRecording(){
    const p=parts.find(x=>x.type==='vocal'&&String(x.id)===String(recordTargetPartId))||active();if(!p||p.type!=='vocal'||!recording)return;
    const wasVox=recordStartedFromVox,insertBeat=recordInsertBeat;
    clearTimeout(recordResumeTimer);recordResumeTimer=null;recordingResuming=false;
    if(recordingPaused&&recordPausedAt){recordPausedTotal+=performance.now()-recordPausedAt;}recordingPaused=false;recordPausedAt=0;recording=false;stopSpeechToText();clearInterval(recordTimer);recordTimer=null;
    if($('vocalRecordBtn')){$('vocalRecordBtn').classList.remove('recording');$('vocalRecordBtn').disabled=false;}
    if($('vocalStopBtn'))$('vocalStopBtn').disabled=true;
    window.CRPParts?.stopPlayback?.();micProcessor?.disconnect();micSilentGain?.disconnect();if(micProcessor)micProcessor.onaudioprocess=null;micProcessor=null;micSilentGain=null;
    if(p._recordOldStates){for(const x of parts)x.enabled=p._recordOldStates.get(x.id)??x.enabled;delete p._recordOldStates;}if(p._recordOldVolumes){for(const x of parts)x.volume=p._recordOldVolumes.get(x.id)??x.volume;delete p._recordOldVolumes;}
    const drumToggle=$('crpDrumsToggle');if(drumToggle&&p._recordOldDrums!==undefined){drumToggle.checked=p._recordOldDrums;drumToggle.dispatchEvent(new Event('change'));delete p._recordOldDrums;}
    const drumVol=$('crpDrumVolume');if(drumVol&&p._recordOldDrumVol!==undefined){drumVol.value=p._recordOldDrumVol;drumVol.dispatchEvent(new Event('input'));delete p._recordOldDrumVol;}
    renderParts();
    const capturedSamples=recordChunks.reduce((n,a)=>n+a.length,0),trimSamples=Math.max(0,Math.min(capturedSamples,Math.round(recordInitialTrimSec*recordSampleRate))),usableSamples=Math.max(0,capturedSamples-trimSamples),duration=usableSamples/Math.max(1,recordSampleRate);
    if($('vocalTimer'))$('vocalTimer').textContent=fmtTime(duration);
    if(duration<.25||usableSamples<Math.max(1,Math.round(recordSampleRate*.25))){core.status('Recording was too short.');recordStartedFromVox=false;recordTargetPartId=null;recordInitialTrimSec=0;recordCaptureStartMicTime=0;updateVoxTransportState();return;}
    const blob=floatToWav(recordChunks,recordSampleRate,trimSamples),id=uid(),take={id,name:`Take ${p.recordings.length+1}`,createdAt:new Date().toISOString(),duration,sampleRate:recordSampleRate,size:blob.size};
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
    finally{recordStartedFromVox=false;recordTargetPartId=null;recordInsertBeat=0;recordResumeBeat=0;recordInitialTrimSec=0;recordCaptureStartMicTime=0;recordingResuming=false;clearTimeout(recordResumeTimer);recordResumeTimer=null;updateVoxTransportState();}
  }
  async function toggleRecordingPause(){
    if(!recording)return false;
    if(!recordingPaused){
      clearTimeout(recordResumeTimer);recordResumeTimer=null;recordingResuming=false;
      recordResumeBeat=currentCycleBeat()??voxPlayheadBeat??recordResumeBeat??0;
      if(recordStartedFromVox)updateVoxPlayhead(recordResumeBeat,false);
      recordingPaused=true;recordPausedAt=performance.now();
      try{window.CRPParts?.stopPlayback?.();}catch{}
      core.status('Recording paused.');
    }else{
      if(recordingResuming)return true;
      recordingResuming=true;
      core.status('Resuming recording on the backing downbeat…');
      try{
        await startPlayback({fromBeat:Math.max(0,Number(recordResumeBeat)||0)});
        if(!recording||!recordingPaused){recordingResuming=false;return recordingPaused;}
        const finishResume=()=>{
          recordResumeTimer=null;
          if(!recording||!recordingPaused){recordingResuming=false;return;}
          if(recordPausedAt)recordPausedTotal+=performance.now()-recordPausedAt;
          recordingPaused=false;recordPausedAt=0;recordingResuming=false;
          core.status('Recording resumed in beat sync.');
          updateVoxTransportState();
        };
        const delayMs=Math.max(0,playbackLeadRemainingSec()*1000);
        if(delayMs>4)recordResumeTimer=setTimeout(finishResume,delayMs);else finishResume();
      }catch(e){
        console.warn('Could not resume backing playback',e);
        if(recordPausedAt)recordPausedTotal+=performance.now()-recordPausedAt;
        recordingPaused=false;recordPausedAt=0;recordingResuming=false;
        core.status('Recording resumed without backing.');
      }
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
    if(p.type==='chord'){const items=chordFlatItems(p);return items.length?Math.max(...items.map(x=>x.startBeat+x.dur)):0;}
    if(p.type==='lead'){const events=p.events||[];const exact=events.length?Math.max(...events.map(e=>leadEventStartBeat(p,e)+leadEventDurationBeats(p,e))):0;return Math.max(p.bars*4,exact);}
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

  function drumPatternHitCount(pattern){
    if(!pattern?.tracks)return 0;let n=0;for(const bars of Object.values(pattern.tracks||{}))for(const arr of Array.isArray(bars)?bars:[])n+=Array.isArray(arr)?arr.length:0;return n;
  }
  function blankDrumPattern(){
    const b=clone(window.CRPBeatMaker?.getBeat?.()||{version:3,enabled:true,muted:false,solo:false,bars:1,resolution:16,gain:.5,tracks:{}});b.enabled=true;b.bars=1;
    for(const k of Object.keys(b.tracks||{}))b.tracks[k]=Array.from({length:16},()=>[]);return b;
  }
  function normalizeDrumEvent(raw){
    if(!raw)return null;const start=Math.max(0,Number(raw.startBeat)||0),duration=Math.max(.03,Number(raw.durationBeats)||4),pattern=clone(raw.pattern||blankDrumPattern());
    return {id:String(raw.id||uid()),startBeat:start,durationBeats:duration,patternOffsetBeats:Number(raw.patternOffsetBeats)||0,pattern};
  }
  let drumMasterSyncing=false;
  function primaryDrumEvent(){return [...drumEvents].sort((a,b)=>(Number(a.startBeat)||0)-(Number(b.startBeat)||0))[0]||null;}
  function syncDrumMasterToBeatMaker(){
    if(drumMasterSyncing||!window.CRPBeatMaker?.setBeat)return false;
    ensureLegacyDrumEvent();
    const primary=primaryDrumEvent(),target=primary?clone(primary.pattern):blankDrumPattern();
    try{
      const current=window.CRPBeatMaker?.getBeat?.();
      if(current&&JSON.stringify(current)===JSON.stringify(target))return false;
      drumMasterSyncing=true;window.CRPBeatMaker.setBeat(target,{persist:false});return true;
    }catch(err){console.warn('Could not sync Track Master drums to Beat Maker',err);return false;}finally{drumMasterSyncing=false;}
  }
  function syncBeatMakerMaster(pattern){
    if(drumMasterSyncing||!pattern)return false;
    drumArrangementInitialized=true;let primary=primaryDrumEvent();const pat=clone(pattern),bars=Math.max(1,Number(pat?.bars)||1);
    if(!primary){const duration=Math.max(4,musicalVocalDurationBeats(),bars*4);primary=normalizeDrumEvent({id:uid(),startBeat:0,durationBeats:duration,patternOffsetBeats:0,pattern:pat});drumEvents=[primary];}
    else{primary.pattern=pat;if(Math.abs(Number(primary.startBeat)||0)<.001)primary.patternOffsetBeats=0;primary.durationBeats=Math.max(Number(primary.durationBeats)||0,bars*4,.03);}
    // Beat Maker/CRP volume is the global Drums track volume. Preserve each
    // region's own pattern, but keep its gain connected to that master slider.
    const masterGain=Math.max(0,Math.min(1,Number(pat.gain)||0));for(const ev of drumEvents){if(ev?.pattern)ev.pattern.gain=masterGain;}
    markPartsDirty();playbackTotalBeats=mediaDurationBeats();if(voxBoxOpen)renderVoxBox();core.scheduleAutoSave();return true;
  }
  function musicalVocalDurationBeats(){
    const musical=parts.filter(p=>p.type==='chord'||p.type==='lead').map(partDurationBeats),vocals=parts.filter(p=>p.type==='vocal').map(vocalDurationBeats);return Math.max(0,...musical,...vocals);
  }
  function ensureLegacyDrumEvent(){
    // Old projects stored one global Beat Maker pattern. Migrate it exactly once.
    // New projects explicitly persist drumEvents (even []), so deleting the last
    // region never resurrects a legacy pattern on the next render/save.
    if(drumArrangementInitialized)return;
    if(!window.CRPBeatMaker?.getBeat)return;
    drumArrangementInitialized=true;
    const beat=window.CRPBeatMaker.getBeat();if(!beat||beat.enabled===false||drumPatternHitCount(beat)<=0)return;
    const duration=Math.max(4,musicalVocalDurationBeats(),(Number(beat.bars)||1)*4);
    drumEvents=[normalizeDrumEvent({id:uid(),startBeat:0,durationBeats:duration,pattern:beat})];
  }
  function naturalSongDurationBeats(){
    ensureLegacyDrumEvent();const drumEnd=drumEvents.length?Math.max(...drumEvents.map(e=>(Number(e.startBeat)||0)+(Number(e.durationBeats)||0))):0;return Math.max(musicalVocalDurationBeats(),drumEnd,0);
  }
  function effectiveSongStartBeat(){return Math.max(0,Number(songStartBeat)||0);}
  function effectiveSongEndBeats(natural=naturalSongDurationBeats()){
    const start=effectiveSongStartBeat(),custom=Number(songEndBeat);if(Number.isFinite(custom)&&custom>start+.03)return custom;const n=Math.max(0,Number(natural)||0);return Math.max(start+.05,n||start+.05);
  }
  function songRangeForTimeline(){const start=effectiveSongStartBeat(),natural=naturalSongDurationBeats(),end=Number.isFinite(Number(songEndBeat))&&Number(songEndBeat)>start+.03?Number(songEndBeat):(natural>start?natural:Math.max(16,start+16));return {start,end:Math.max(start+.05,end)};}
  function songEndSeconds(beats){
    const bpm=Math.max(40,Math.min(240,Number(core.bpm)||92));return Math.max(0,Number(beats)||0)*60/bpm;
  }
  function formatSongTime(seconds){
    const s=Math.max(0,Number(seconds)||0),m=Math.floor(s/60),r=s-m*60;return `${String(m).padStart(2,'0')}:${r.toFixed(1).padStart(4,'0')}`;
  }
  function currentCycleBeat(){
    if(!(playing||starting)||!audioCtx||!playbackClockStartAudioTime||!playbackTotalBeats)return null;
    const bpm=Math.max(40,Math.min(240,+playbackClockBpm||+core.bpm||92)),beatSec=60/bpm,start=Math.max(0,Number(playbackLoopStartBeat)||0),end=Math.max(start+.05,Number(playbackTotalBeats)||start+.05),period=end-start;
    let beat=(playbackClockStartBeat||start)+Math.max(0,audioCtx.currentTime-playbackClockStartAudioTime)/beatSec;
    const loopSong=!playbackScope&&!!core.loop;
    if(period>0&&loopSong)beat=start+((((beat-start)%period)+period)%period);
    else beat=Math.max(start,Math.min(end-.001,beat));
    return beat;
  }
  function playbackLeadRemainingSec(){
    if(!(playing||starting)||!audioCtx||!playbackClockStartAudioTime)return 0;
    return Math.max(0,playbackClockStartAudioTime-audioCtx.currentTime);
  }
  function renderSongEndEditor(){ if(!(playing||starting))updateMediaPosition(); }
  function setSongRange(start,end,{save=true,status=true}={}){
    const minGap=voxSnapEnabled()?Math.max(.03,voxBeatStep()):.03;let a=Math.max(0,Number(start)||0),b=Math.max(a+minGap,Number(end)||a+minGap);songStartBeat=a;songEndBeat=b;markPartsDirty();liveEditRefresh();if(save)core.scheduleAutoSave();if(voxBoxOpen){renderVoxBox();if(status)voxStatus(`Song range: ${a.toFixed(2)}–${b.toFixed(2)} beats.`);}
  }

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
  function mediaDurationBeats(){return Math.max(effectiveSongStartBeat()+.05,effectiveSongEndBeats(naturalSongDurationBeats()));}
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
    const mixGain=partAudibleInMix(p)?1:0;
    return soundGain(soundOverride||requestedPartSound(p))*p.volume*(p.type==='lead'?LEAD_OUTPUT_BOOST:1)*scopeGain*mixGain;
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
        n.out.gain.setTargetAtTime(Math.max(0,Math.min(1.5,(Number(p.volume)||0)*clipVolume*(partAudibleInMix(p)?1:0))),now,.025);
        n.tune?.port?.postMessage({amount:Math.max(0,Math.min(100,Number(fx.autotune)||0)),allowedPcs:scale.allowedPcs||[]});
      }catch{}
    }
  }
  function liveEditRefresh(){
    clearTimeout(liveEditTimer);
    liveEditTimer=setTimeout(()=>{
      syncLoadedChord();
      // Length-of-Song Lead/Bass parts follow the musical arrangement live, not
      // only after Save/reload. This keeps playback and the Bars control aligned
      // as chord rows / song markers grow.
      for(const q of parts)if(q?.type==='lead')syncLeadBarsToSong(q);
      const now=audioCtx?.currentTime||0;
      for(const p of parts){
        const bus=partBuses.get(p.id);
        if(bus&&audioCtx){try{if(typeof bus.gain.cancelAndHoldAtTime==='function')bus.gain.cancelAndHoldAtTime(now);else bus.gain.cancelScheduledValues(now);bus.gain.setTargetAtTime(desiredPartGain(p,outputSoundFor(p)),now,.028);}catch{}}
        if(p.type==='vocal')applyVocalFxLive(p);
      }
      if(playing||starting){
        window.CRPBeatMaker?.setMainGainScale?.(drumsAudibleInMix()?currentDrumScopeGain():0);
        window.CRPBeatMaker?.updateArrangement?.(drumEvents,{rangeStart:effectiveSongStartBeat(),rangeEnd:mediaDurationBeats(),canLoop:!playbackScope});
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
        // Mobile browsers can temporarily suspend/interupt WebAudio when the UI,
        // audio route, or page focus changes. While transport is active, make a
        // best-effort resume instead of letting the rolling scheduler silently die.
        if((playing||starting)&&audioCtx&&audioCtx.state!=='running'&&audioCtx.state!=='closed'){
          audioCtx.resume().catch(()=>{});
        }
      });
    }
    if(audioCtx.state==='suspended')audioCtx.resume().catch(()=>{});
    if(!masterLimiter){masterLimiter=audioCtx.createDynamicsCompressor();masterLimiter.threshold.value=-2;masterLimiter.knee.value=0;masterLimiter.ratio.value=20;masterLimiter.attack.value=.003;masterLimiter.release.value=.12;masterLimiter.connect(audioCtx.destination);}
  }
  function ensurePartBus(p){
    ensureAudio();let bus=partBuses.get(p.id),fresh=false;
    if(!bus){
      bus=audioCtx.createGain();
      // v3.3.118 — keep a dedicated unity-gain handoff gate between the part
      // volume bus and its FX chain.  The normal scheduler is free to smooth
      // bus.gain for live volume/mute changes without cancelling the tiny
      // anti-click envelope used when a newly decoded SoundFont becomes ready.
      const gate=audioCtx.createGain();gate.gain.value=1;bus.connect(gate);partHandoffGates.set(p.id,gate);
      const fx=core.createInstrumentFxChain?.(audioCtx,masterLimiter);
      if(fx){gate.connect(fx.input);partInstrumentFx.set(p.id,fx);}else gate.connect(masterLimiter);
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
  async function playerFor(p,{forceCurrent=false,nonBlocking=false}={}){
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
        const previous=lastReadyPlayer.get(p.id);
        if(requestedPartSound(p)===sound||!previous){
          // v3.3.118 — A decoded live sound may have a very different sample level/
          // waveform than the currently queued player.  Switching it into the same
          // part bus at full level can make a short click/static burst, especially on
          // mobile.  Schedule a tiny WebAudio cross-duck around the handoff.  This is
          // audio-thread automation (not a transport restart), so playback and the
          // rolling scheduler stay continuous while the new player becomes current.
          if((playing||starting)&&previous?.player&&previous.sound!==sound){
            ensurePartBus(p);const gate=partHandoffGates.get(p.id),now=audioCtx.currentTime;
            try{
              if(gate){
                if(typeof gate.gain.cancelAndHoldAtTime==='function')gate.gain.cancelAndHoldAtTime(now);
                else{gate.gain.cancelScheduledValues(now);gate.gain.setValueAtTime(Math.max(.0001,gate.gain.value||1),now);}
                gate.gain.linearRampToValueAtTime(.0001,now+.018);
                gate.gain.linearRampToValueAtTime(1,now+.072);
              }
            }catch{}
          }
          lastReadyPlayer.set(p.id,{sound,player});
        }
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
    if(nonBlocking&&!forceCurrent&&(playing||starting)&&!fallback?.player){
      // A newly-enabled/live-created part may not have any ready player yet.
      // Start loading it, but never stall the transport waiting for decode/network.
      // It simply joins the mix on a later scheduler pass when ready.
      promise.catch(err=>console.warn('Live sound preload failed',err));
      return null;
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
  function queueTempoRestartIfNeeded(){
    if(recording||!(playing||starting))return false;
    const nextBpm=Math.max(40,Math.min(240,Number(core.bpm)||92));
    if(Math.abs(nextBpm-playbackClockBpm)<.001)return false;
    clearTimeout(bpmRestartTimer);
    const beat=currentCycleBeat(),scope=playbackScope?clone(playbackScope):null;
    bpmRestartTimer=setTimeout(()=>{
      if(!(playing||starting)||recording)return;
      startPlayback({scope,fromBeat:Number.isFinite(beat)?beat:playbackClockStartBeat,preserveUi:true,liveRestart:true});
    },18);
    return true;
  }
  function syncCoreLive(){
    syncLoadedChord();
    const p=loadedChord();
    if(p){
      warmLivePlayer(p);
      if(!(playing||starting))busFor(p,requestedPartSound(p));
    }
    queueTempoRestartIfNeeded();
    if(active()?.type==='lead')renderLeadHarmony();
  }
  // v3.3.63 — dedicated CRP MIDI timeline commit. MIDI is sequential, so a
  // completed MIDI resize removes old Track Master absolute starts instead of
  // rewriting them. chordFlatItems() then derives every start from the CURRENT
  // duration sequence on every playback/export/save pass. This removes the stale
  // first-edit timeline that could survive later resizes.
  function syncMidiTimelineFromCore(){
    const p=loadedChord();if(!p)return false;
    p.data=core.snapshot();
    dedupeChordRows(p.data);normalizeChordDurations(p.data);
    for(const row of p.data?.rows||[])for(const card of Array.isArray(row)?row:[]){
      if(!card||typeof card!=='object')continue;
      const drawn=Number(card.durationBeats),exact=Number(card.voxDurationBeats);
      const dur=Number.isFinite(drawn)&&drawn>0?Math.max(.03,drawn):(Number.isFinite(exact)&&exact>0?Math.max(.03,exact):Math.max(.03,Number(core.cardDurationBeats?.(card,p.data?.beats||core.beats))||Number(core.beats)||4));
      card.durationBeats=dur;card.voxDurationBeats=dur;delete card.voxStartBeat;
    }
    syncSongKeyAcrossChordParts(p.data.key);
    markPartsDirty();playbackTotalBeats=mediaDurationBeats();
    return true;
  }
  async function auditionLeadNote(p,midi){
    if(!p||p.type!=='lead')return;
    try{
      const transportActive=!!(playing||starting);
      // Tapping/placing Lead or Bass notes should remain audible while the song is
      // already playing. Never block the transport waiting on a network/sample load:
      // use the ready player when available and warm the requested sound in parallel.
      const player=await playerFor(p,{nonBlocking:transportActive});
      if(!player){warmLivePlayer(p);return;}
      const scheduledSound=playerSound.get(player)||outputSoundFor(p)||requestedPartSound(p);
      busFor(p,scheduledSound);
      let soundingMidi=midi+(Number(p.octave)||0)*12;
      if(core.isBassSound?.(scheduledSound)||scheduledSound==='electric_bass_finger')soundingMidi-=12;
      const at=(audioCtx?.currentTime||0)+(transportActive?.012:.01);
      const beatSec=60/Math.max(40,Math.min(240,+core.bpm||92));
      const auditionDuration=p.sustain?sustainedPartSeconds(scheduledSound,beatSec):.42;
      playTracked(player,midiName(soundingMidi),at,{duration:auditionDuration,gain:transportActive?.88:.96});
    }catch(e){
      console.warn('Could not audition lead/bass note',e);
      if(!(playing||starting))core.status('Could not preview that note.');
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
    dry.gain.value=1;wet.gain.value=Number(fx.reverb||0);rev.buffer=impulse(audioCtx,1.25);delay.delayTime.value=Number(fx.delay||0);delayGain.gain.value=fx.delay?0.22:0;out.gain.value=Math.max(0,Math.min(1.5,(Number(p.volume)||0)*(event?Math.max(0,Math.min(1.5,Number(event.volume)||0)):1)*(partAudibleInMix(p)?1:0)));
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
    for(const gate of partHandoffGates.values()){try{gate.gain.cancelScheduledValues(audioCtx?.currentTime||0);gate.gain.value=0;gate.disconnect();}catch{}}
    for(const fx of partInstrumentFx.values())try{fx?.disconnect?.();}catch{}
    partInstrumentFx.clear();partHandoffGates.clear();partBuses.clear();
    playerCache.clear();resolvedPlayerCache.clear();lastReadyPlayer.clear();playerSound=new WeakMap();
    if(masterLimiter){try{masterLimiter.disconnect();}catch{}masterLimiter=null;}
  }
  async function scheduleSegment(startTime,fromBeat,toBeat,generation,withVocals=true){
    const beatSec=60/core.bpm;
    for(const p of enabledPlayable()){
      if(!playing||generation!==playbackGeneration)return;
      const player=await playerFor(p,{nonBlocking:true});
      if(!playing||generation!==playbackGeneration)return;
      if(!player)continue;
      const scheduledSound=playerSound.get(player)||outputSoundFor(p)||requestedPartSound(p);
      busFor(p,scheduledSound);
      if(p.type==='chord'){
        const items=chordFlatItems(p);items.forEach((item,i)=>{if(!playing||generation!==playbackGeneration)return;const card=item.card,durBeats=item.dur,b=item.startBeat;if(b<fromBeat||b>=toBeat)return;const at=startTime+(b-fromBeat)*beatSec;const baseDur=durBeats*beatSec,duration=core.sustain?sustainedPartSeconds(scheduledSound,baseDur):Math.max(.18,baseDur*.98);const notes=core.notesFor(card,p.data)||[];notes.forEach((n,j)=>playTracked(player,n,at+(p.data.instrument==='guitar'?j*.035:0),{duration,gain:.94}));scheduleHighlight((at-audioCtx.currentTime)*1000,p,i);});
      }else{
        const stepBeats=4/p.resolution,partBeats=Math.max(stepBeats,p.bars*4),repeatLead=playbackScope?.kind==='vocalMix'?p.repeat:!!core.loop,firstCycle=repeatLead?Math.max(0,Math.floor(fromBeat/partBeats)):0,lastCycle=repeatLead?Math.floor((toBeat-1e-6)/partBeats):0;
        for(let cyc=firstCycle;cyc<=lastCycle;cyc++)p.events.forEach(e=>{if(e.voxBlank===true||!playing||generation!==playbackGeneration)return;const local=leadEventStartBeat(p,e),b=local+cyc*partBeats;if(b<fromBeat||b>=toBeat)return;const at=startTime+(b-fromBeat)*beatSec;let midi=e.midi+(Number(p.octave)||0)*12;if(core.isBassSound?.(scheduledSound)||scheduledSound==='electric_bass_finger')midi-=12;const drawnBeats=leadEventDurationBeats(p,e),duration=p.sustain&&drawnBeats<=stepBeats?sustainedPartSeconds(scheduledSound,beatSec):Math.max(.05,drawnBeats*beatSec*.98);playTracked(player,midiName(midi),at,{duration,gain:.92});scheduleLeadHighlight((at-audioCtx.currentTime)*1000,p,e.step);});
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
    ensureLegacyDrumEvent();const drumBeats=scopedDrums?(drumEvents.length?Math.max(0,...drumEvents.map(e=>(Number(e.startBeat)||0)+(Number(e.durationBeats)||0))):Math.max(0,Number(window.CRPBeatMaker?.getDurationBeats?.()||0))):0;
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
      core.status('Loading parts…');ensureAudio();if(audioCtx?.state==='suspended')await audioCtx.resume();if(vs.length)await ensureAutotuneWorklet(audioCtx);await Promise.all([preload(ps),...vs.map(v=>preloadVocalBuffers(v))]);
      if(generation!==playbackGeneration)return;

      // Keep every playback source on the same musical downbeat. Drums use a
      // separate AudioContext, so both engines receive the same relative lead-in.
      const leadIn=options?.liveRestart?.035:.16;
      const computePlaybackTotal=()=>{
        const livePs=enabledPlayable(),liveVs=enabledVocals();
        ensureLegacyDrumEvent();const liveDrums=scopedDrums?(drumEvents.length?Math.max(0,...drumEvents.map(e=>(Number(e.startBeat)||0)+(Number(e.durationBeats)||0))):Math.max(0,Number(window.CRPBeatMaker?.getDurationBeats?.()||0))):0;
        const natural=Math.max(...livePs.map(partDurationBeats),...liveVs.map(vocalDurationBeats),liveDrums,4);
        return effectiveSongEndBeats(natural);
      };
      let total=computePlaybackTotal();
      playbackTotalBeats=total;
      // Scoped Lead/Vocal preview buttons always begin at beat 1. The normal
      // Chord transport still honors "play line in view". If the visible line
      // begins past a custom song end, restart from beat 1 instead of silently ending.
      const rangeStart=effectiveSongStartBeat();playbackLoopStartBeat=rangeStart;
      let cursorBeat=Number.isFinite(Number(options?.fromBeat))?Math.max(rangeStart,Number(options.fromBeat)):((!playbackScope&&active()?.type==='chord'&&active()?.enabled&&activePartId===loadedChordPartId)?Math.max(rangeStart,Math.min(core.startBeat(),Math.max(rangeStart,total-0.001))):rangeStart);
      if(cursorBeat>=total-.001)cursorBeat=rangeStart;
      const initialBeat=cursorBeat;
      if(scopedDrums){
        const drumGain=Math.max(0,Math.min(1,Number(playbackScope?.drumGain??1)))*(drumsAudibleInMix()?1:0);
        ensureLegacyDrumEvent();if(drumEvents.length)await window.CRPBeatMaker?.startArrangementNow?.(drumEvents,leadIn,initialBeat,drumGain,{rangeStart,rangeEnd:total,canLoop:!playbackScope});else await window.CRPBeatMaker?.startMainNow?.(leadIn,initialBeat,drumGain);
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
      // v3.3.54 — keep a deeper rolling buffer made of short scheduling slices.
      // The prior scheduler held only one ~0.68s slice and waited until late in that
      // slice to queue the next. A sound decode, Track Master waveform redraw, page
      // switch, or heavy scroll/layout pass could delay that timer and create a tiny
      // underrun heard as static. We now keep ~1 second safely queued, while using
      // ~0.22s slices so live edits still enter the mix quickly after the buffer drains.
      // Keep enough audio queued to survive a short mobile layout/network/UI stall,
      // while retaining short chunks so live edits join the mix promptly.
      const schedulerHorizonSec=1.20,schedulerChunkSec=.20,schedulerTickMs=45;
      let vocalsScheduledForCycle=false,schedulerBusy=false,endStopScheduled=false;

      const scheduleNext=async()=>{
        if(!playing||generation!==playbackGeneration)return;
        if(schedulerBusy){cycleTimer=setTimeout(scheduleNext,schedulerTickMs);return;}
        schedulerBusy=true;
        try{
          if(audioCtx?.state!=='running'&&audioCtx?.state!=='closed')await audioCtx.resume().catch(()=>{});
          if(!playing||generation!==playbackGeneration)return;
          const horizon=audioCtx.currentTime+schedulerHorizonSec;
          while(playing&&generation===playbackGeneration&&nextAudioStart<horizon&&!endStopScheduled){
            const beatSec=60/Math.max(40,Math.min(240,+core.bpm||92));
            total=computePlaybackTotal();playbackTotalBeats=total;
            if(cursorBeat>=total-.001)cursorBeat=playbackLoopStartBeat;
            const chunkBeats=Math.max(.25,Math.min(1.25,schedulerChunkSec/beatSec));
            const fromBeat=cursorBeat,toBeat=Math.min(total,fromBeat+chunkBeats),span=(toBeat-fromBeat)*beatSec;
            if(span<=.0001)break;
            const start=nextAudioStart,end=start+span;

            // Vocals stay as one continuous source for the remainder of each song cycle.
            if(!vocalsScheduledForCycle){
              for(const v of enabledVocals())await scheduleVocalSegment(v,start,fromBeat,total,generation);
              vocalsScheduledForCycle=true;
            }
            await scheduleSegment(start,fromBeat,toBeat,generation,false);
            if(!playing||generation!==playbackGeneration)return;

            nextAudioStart=end;cursorBeat=toBeat;
            if(cursorBeat>=total-1e-7){
              const loopSong=playbackScope?false:!!core.loop;
              if(loopSong){cursorBeat=playbackLoopStartBeat;vocalsScheduledForCycle=false;}
              else{
                endStopScheduled=true;
                cycleTimer=setTimeout(()=>{if(generation===playbackGeneration)stopPlayback();},Math.max(10,(end-audioCtx.currentTime)*1000+35));
                break;
              }
            }
          }
        }catch(err){
          // A transient decode/context hiccup should not kill the transport loop.
          // Log it, keep the scheduler alive, and let the next short tick recover.
          console.warn('Playback scheduler recovered from a transient error',err);
          if(audioCtx&&audioCtx.state!=='running'&&audioCtx.state!=='closed')audioCtx.resume().catch(()=>{});
        }finally{
          schedulerBusy=false;
          if(playing&&generation===playbackGeneration&&!endStopScheduled)cycleTimer=setTimeout(scheduleNext,schedulerTickMs);
        }
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
    playbackTotalBeats=0;playbackLoopStartBeat=effectiveSongStartBeat();
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
    if((playing||starting)&&audioCtx&&audioCtx.state!=='running'&&audioCtx.state!=='closed')audioCtx.resume().catch(()=>{});
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
  function partMidi(p){const ppq=480,E=[];if(p.type==='lead'){for(const x of p.events){if(x.voxBlank===true)continue;const start=leadEventStartBeat(p,x),t=Math.round(start*ppq),n=Math.max(0,Math.min(127,x.midi+(p.octave||0)*12+((core.isBassSound?.(p.sound)||p.sound==='electric_bass_finger')?-12:0))),drawnBeats=leadEventDurationBeats(p,x),durBeats=(p.sustain&&drawnBeats<=4/p.resolution)?Math.max(1,drawnBeats):drawnBeats,durTicks=Math.max(30,Math.round(durBeats*ppq*.98));E.push({t,on:1,note:n},{t:t+durTicks,on:0,note:n});}}else if(p.type==='chord'){for(const item of chordFlatItems(p)){const card=item.card,notes=core.notesFor(card,p.data)||[],dur=item.dur,beat=item.startBeat;for(const n of notes){const mn=midiNum(n);E.push({t:Math.round(beat*ppq),on:1,note:mn},{t:Math.round((beat+dur*.98)*ppq),on:0,note:mn});}}}return midiFile(E,core.bpm);}
  function drumMidi(b){const map={kick1:36,kick2:36,kick3:35,snare1:38,snare2:38,snare3:40,snare4:38,snare5:40,chh:42,ohh:46,tomHi:50,tomMid:47,tomLow:45,clap:39,rim:37,shaker:82,tamb:54,cowbell:56,conga:64},E=[];if(!b)return midiFile(E,core.bpm);for(const [id,bars] of Object.entries(b.tracks||{}))for(let bar=0;bar<(b.bars||1);bar++)for(const st of bars[bar]||[]){const t=Math.round((bar*4+st/16)*480),n=map[id]||37;E.push({t,on:1,note:n},{t:t+60,on:0,note:n});}return midiFile(E,core.bpm);}
  function closeStudioExport(){document.getElementById('studioExportModal')?.remove();}
  function openStudioExport(){
    closeStudioExport();syncLoadedChord();const modal=document.createElement('div');modal.id='studioExportModal';modal.className='studio-export-modal';const rows=parts.map(p=>`<label class="studio-export-row"><input type="checkbox" data-export-part="${p.id}" checked><span><strong>${escapeHtml(p.name)}</strong><br><span class="subtle tiny">${p.type==='chord'?'Chord / Note':p.type==='lead'?'Lead / Bass':'Vocals'}</span></span></label>`).join('');
    modal.innerHTML=`<div class="studio-export-backdrop"></div><div class="studio-export-card"><h2>Studio export</h2><p class="subtle">Choose exactly what leaves the project. Musical parts export as editable Chord Rider data; selected vocal parts include every dry WAV used by Vox Box.</p><div class="studio-export-list">${rows}<label class="studio-export-row"><input id="studioExportDrums" type="checkbox" checked><span><strong>Drums</strong><br><span class="subtle tiny">Beat Maker pattern</span></span></label><label class="studio-export-row"><input id="studioExportNotes" type="checkbox"><span><strong>Project notes</strong><br><span class="subtle tiny">Only included when checked</span></span></label></div><div class="studio-export-actions"><button id="studioExportCancel" type="button">Cancel</button><button id="studioExportGo" class="accent" type="button">Export ZIP</button></div></div>`;document.body.appendChild(modal);modal.querySelector('.studio-export-backdrop').onclick=closeStudioExport;modal.querySelector('#studioExportCancel').onclick=closeStudioExport;modal.querySelector('#studioExportGo').onclick=exportStudioPackage;
  }
  async function exportStudioPackage(){
    const modal=$('studioExportModal');if(!modal)return;const ids=[...modal.querySelectorAll('[data-export-part]:checked')].map(x=>x.dataset.exportPart),selected=parts.filter(p=>ids.includes(p.id));if(!selected.length&&!$('studioExportDrums')?.checked&&!$('studioExportNotes')?.checked){core.status('Choose at least one thing to export.');return;}
    const manifest={format:'Chord Rider Pro Studio Package',version:1,createdAt:new Date().toISOString(),project:{name:core.projectName,bpm:core.bpm,beats:core.beats,songStartBeat:effectiveSongStartBeat(),songEndBeat:Number.isFinite(Number(songEndBeat))&&Number(songEndBeat)>0?Number(songEndBeat):null,drumEvents:clone(drumEvents)},parts:selected.map(p=>{const q=clone(p);if(q.type==='vocal')q.recordings=(q.recordings||[]).map(r=>({...r,blob:undefined}));return q;})};if($('studioExportDrums')?.checked)manifest.beatMaker=window.CRPBeatMaker?.getBeat?.()||null;if($('studioExportNotes')?.checked)manifest.notes=core.projectNotes||'';
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
      ensureLegacyDrumEvent();
      let songSec=.25;
      selected.forEach(p=>{if(p.type==='chord'||p.type==='lead')songSec=Math.max(songSec,partDurationBeats(p)*beatSec);else if(p.type==='vocal')songSec=Math.max(songSec,vocalDurationBeats(p)*beatSec);});
      if(drums&&drumEvents.length)songSec=Math.max(songSec,Math.max(...drumEvents.map(e=>(Number(e.startBeat)||0)+(Number(e.durationBeats)||0)))*beatSec);
      else if(drums&&beat)songSec=Math.max(songSec,Math.max(1,Number(beat.bars)||1)*4*beatSec);
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
      if(drums&&beat){for(const [id,url] of Object.entries(AUDIO_EXPORT_DRUMS)){const used=drumEvents.length?drumEvents.some(ev=>(ev.pattern?.tracks?.[id]||[]).some(a=>Array.isArray(a)&&a.length)):(beat.tracks?.[id]||[]).some(a=>Array.isArray(a)&&a.length);if(!used)continue;const res=await fetch(url);if(!res.ok)continue;drumBuffers.set(id,await ctx.decodeAudioData(await res.arrayBuffer()));}}

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
          for(const item of chordFlatItems(p)){const card=item.card,durBeats=item.dur,at=startAt+item.startBeat*beatSec,base=durBeats*beatSec,duration=core.sustain?sustainedPartSeconds(p.data?.sound,base):Math.max(.18,base*.98),notes=core.notesFor(card,p.data)||[];notes.forEach((n,j)=>{try{player.play(n,at+(p.data.instrument==='guitar'?j*.035:0),{duration,gain:.94});}catch{}});}
        }else{
          const stepBeats=4/p.resolution;for(const e of p.events||[]){if(e.voxBlank===true)continue;const at=startAt+leadEventStartBeat(p,e)*beatSec;let midi=e.midi+(Number(p.octave)||0)*12;if(core.isBassSound?.(p.sound)||p.sound==='electric_bass_finger')midi-=12;const drawn=leadEventDurationBeats(p,e),duration=p.sustain&&drawn<=stepBeats?sustainedPartSeconds(p.sound,beatSec):Math.max(.05,drawn*beatSec*.98);try{player.play(midiName(midi),at,{duration,gain:.92});}catch{}}
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
      // Render the Track Master drum arrangement. Each region owns its own pattern,
      // so intro / verse / chorus drums export exactly as they play in Track Master.
      if(drums&&beat&&drumBuffers.size){
        const stepSec=beatSec/16,totalSteps=Math.ceil(songSec/stepSec);
        for(let abs=0;abs<totalSteps;abs++){
          const songBeat=abs/16,at=startAt+abs*stepSec;
          if(drumEvents.length){
            for(const ev of drumEvents){
              const evStart=Math.max(0,Number(ev.startBeat)||0),evDur=Math.max(0,Number(ev.durationBeats)||0);if(songBeat<evStart-1e-6||songBeat>=evStart+evDur-1e-6)continue;
              const pat=ev.pattern||beat,bars=Math.max(1,Number(pat.bars)||1),patternSteps=Math.max(64,bars*64),offset=Number(ev.patternOffsetBeats)||0,rawStep=Math.round((songBeat-evStart+offset)*16),local=((rawStep%patternSteps)+patternSteps)%patternSteps,bar=Math.floor(local/64),step=local%64,gain=Math.max(0,Math.min(1,Number(pat.gain)||0))*AUDIO_EXPORT_DRUM_SCALE;
              for(const [id,buf] of drumBuffers){if(!pat.tracks?.[id]?.[bar]?.includes(step))continue;const src=ctx.createBufferSource(),g=ctx.createGain();src.buffer=buf;g.gain.value=gain;src.connect(g).connect(mix);src.start(at);}
            }
          }else{
            const bars=Math.max(1,Number(beat.bars)||1),bar=Math.floor(abs/64)%bars,step=abs%64,gain=Math.max(0,Math.min(1,Number(beat.gain)||0))*AUDIO_EXPORT_DRUM_SCALE;
            for(const [id,buf] of drumBuffers){if(!beat.tracks?.[id]?.[bar]?.includes(step))continue;const src=ctx.createBufferSource(),g=ctx.createGain();src.buffer=buf;g.gain.value=gain;src.connect(g).connect(mix);src.start(at);}
          }
        }
      }

      go.textContent='Rendering WAV…';
      await sleep((leadSec+songSec+tailSec+.25)*1000);
      proc.onaudioprocess=null;try{proc.disconnect();silent.disconnect();}catch{}
      const trim=Math.max(0,Math.round((startAt-captureStart)*ctx.sampleRate)),wanted=Math.max(1,Math.round((songSec+tailSec)*ctx.sampleRate));
      const allL=concatFloatChunks(L,captured),allR=concatFloatChunks(R,captured),left=allL.slice(trim,trim+wanted),right=allR.slice(trim,trim+wanted),wav=wavFromStereo(left,right,ctx.sampleRate);
      const a=document.createElement('a');a.href=URL.createObjectURL(wav);a.download=`${safeFileName(core.projectName)}-Audio-Mix.wav`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),5000);closeAudioExport();core.status('Audio mix exported as WAV.');
    }catch(e){console.error('Audio export failed',e);core.status(e.message||'Could not export audio mix.');if(go){go.disabled=false;go.textContent='Export WAV';}}
    finally{try{await ctx?.close();}catch{}}
  }

  function partsPayloadForSave(){
    const safe=parts.map(p=>{const q=clone(p);delete q._recordOldStates;delete q._recordOldVolumes;delete q._recordOldDrums;delete q._recordOldDrumVol;if(q.type==='vocal')q.recordings=(q.recordings||[]).map(({blob,...r})=>r);return q;});
    return {version:6,activePartId,loadedChordPartId,songStartBeat:effectiveSongStartBeat(),songEndBeat:Number.isFinite(Number(songEndBeat))&&Number(songEndBeat)>0?Number(songEndBeat):null,drumEvents:clone(drumEvents),items:safe};
  }
  function refreshPartsFingerprintBaseline(){partsFingerprint=JSON.stringify(partsPayloadForSave());}
  function capture(){syncLoadedChord();ensureLegacyDrumEvent();drumArrangementInitialized=true;for(const p of parts)if(p?.type==='lead')syncLeadBarsToSong(p);const payload=partsPayloadForSave(),fingerprint=JSON.stringify(payload);if(fingerprint!==partsFingerprint){partsUpdatedAt=Math.max(Number(partsUpdatedAt)||0,Date.now());partsFingerprint=fingerprint;}return {...payload,updatedAt:partsUpdatedAt};}
  function loadProject(project){
    stopPlayback();stopPreview();
    const saved=project?.parts;
    partsUpdatedAt=Number(saved?.updatedAt||project?.updatedAt||0)||0;
    songStartBeat=Math.max(0,Number(saved?.songStartBeat)||0);songEndBeat=Number.isFinite(Number(saved?.songEndBeat))&&Number(saved.songEndBeat)>songStartBeat?Number(saved.songEndBeat):null;drumArrangementInitialized=Array.isArray(saved?.drumEvents);drumEvents=drumArrangementInitialized?saved.drumEvents.map(normalizeDrumEvent).filter(Boolean):[];
    if(saved?.items?.length){parts=saved.items.map(normalizePart).filter(Boolean);activePartId=parts.some(p=>p.id===saved.activePartId)?saved.activePartId:(parts.find(p=>p.type==='chord')||parts[0]).id;}
    else {const first=chordPart('Chords 1',core.snapshot());parts=[first];activePartId=first.id;}
    const projectSongKey=normalizeSongKeyValue(project?.key)||normalizeSongKeyValue(core.snapshot()?.key)||normalizeSongKeyValue(parts.find(p=>p?.type==='chord'&&p.data?.key)?.data?.key);
    if(projectSongKey)syncSongKeyAcrossChordParts(projectSongKey);
    const savedLoadedChordId=String(saved?.loadedChordPartId||'');
    let c=(savedLoadedChordId?parts.find(p=>p.type==='chord'&&String(p.id)===savedLoadedChordId):null)
      ||parts.find(p=>p.id===activePartId&&p.type==='chord')||parts.find(p=>p.type==='chord');
    if(!c){c=chordPart('Chords 1',core.snapshot());parts.unshift(c);if(projectSongKey)c.data.key=projectSongKey;}
    // v3.3.63 legacy repair: older saves did not record which chord part CRP was
    // displaying. If the saved project has top-level CRP rows but no loaded-part
    // id, use those rows for the chord part CRP is about to restore. This prevents
    // an older Baby DAW copy from resetting freshly saved MIDI durations on refresh.
    if(!savedLoadedChordId&&Array.isArray(project?.rows)&&project.rows.length){
      c.data={...(c.data||core.snapshot()),rows:clone(project.rows)};
      dedupeChordRows(c.data);normalizeChordDurations(c.data);
    }
    loadedChordPartId=c.id;core.apply(c.data);
    if(activePartId!==c.id)selectPart(activePartId);else{setEditorMode('chord');renderParts();}
    refreshPartsFingerprintBaseline();renderSongEndEditor();
  }
  function newProject(){stopPlayback();stopPreview();partsUpdatedAt=0;partsFingerprint='';songStartBeat=0;songEndBeat=null;drumEvents=[];drumArrangementInitialized=true;const p=chordPart('Chords 1',core.snapshot());parts=[p];activePartId=p.id;loadedChordPartId=p.id;setEditorMode('chord');renderParts();renderSongEndEditor();}

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
  function voxTimelineBeats(){const natural=Math.max(0,naturalSongDurationBeats()),maxEvent=Math.max(0,...allVocalParts().flatMap(p=>voxTrackEvents(p).map(e=>(Number(e.startBeat)||0)+voxEventDurationBeats(e)))),range=songRangeForTimeline(),drumEnd=drumEvents.length?Math.max(...drumEvents.map(e=>(Number(e.startBeat)||0)+(Number(e.durationBeats)||0))):0;return Math.max(16,Math.ceil((Math.max(natural,maxEvent,drumEnd,range.end,voxPlayheadBeat+1)+4)/4)*4);}
  function voxStatus(msg){if($('voxBoxStatus'))$('voxBoxStatus').textContent=msg||'';}
  function persistVoxEdits(){markPartsDirty();syncDrumMasterToBeatMaker();playbackTotalBeats=mediaDurationBeats();renderSongEndEditor();const a=active();if(a?.type==='lead')renderLeadEditor(a);else if(a?.type==='vocal')renderVocalEditor(a);core.scheduleAutoSave();core.flushAutoSaveNow?.();}
  // v3.3.47 — keep destructive Track Master edits visually immediate on phones.
  // The first frame removes the event; heavier editor refresh/autosave runs after paint.
  let voxDeferredPersistSeq=0;
  function persistVoxEditsAfterPaint({renderPartsToo=false}={}){
    const seq=++voxDeferredPersistSeq;
    requestAnimationFrame(()=>requestAnimationFrame(()=>{
      if(seq!==voxDeferredPersistSeq)return;
      persistVoxEdits();
      if(renderPartsToo)renderParts();
    }));
  }
  function voxSetSelection(part,event,{add=false,toggle=false,render=true}={}){
    if(!part||!event)return;
    if(voxToolMode!=='multi'){voxInstrumentSelections=[];voxInstrumentSelection=null;voxInstrumentTrackFocus=null;}voxTargetPartId=part.id;
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
  function clearVoxSelection({render=true,keepInstrumentFocus=false}={}){voxSelections=[];voxSelected=null;voxInstrumentSelections=[];voxInstrumentSelection=null;if(!keepInstrumentFocus)voxInstrumentTrackFocus=null;if(render){renderVoxInspector();renderVoxSelectionClasses();}}
  function focusedVoxTrackInfo(){
    const key=String(voxInstrumentTrackFocus?.key||'');
    if(key==='drum-map')return {kind:'drum',key:'drum-map',name:'Drums'};
    if(key.startsWith('part:')){const id=key.slice(5),part=parts.find(p=>String(p.id)===id);if(part&&['chord','lead'].includes(part.type))return {kind:part.type,key:`part:${part.id}`,part,name:part.name};}
    const vocal=parts.find(p=>p.type==='vocal'&&String(p.id)===String(voxTargetPartId||''))||allVocalParts()[0]||null;
    return vocal?{kind:'vocal',key:`part:${vocal.id}`,part:vocal,name:vocal.name}:null;
  }
  function allSelectionsForFocusedTrack(info=focusedVoxTrackInfo()){
    if(!info)return [];
    if(info.kind==='vocal')return (info.part.voxEvents||[]).filter(e=>voxEventTake(e)&&voxEventDurationSeconds(e)>.01).map(event=>({family:'vocal',part:info.part,event,key:`vocal:${info.part.id}:${event.id}`}));
    if(info.kind==='chord')return chordFlatItems(info.part).map(item=>{if(!item.card.voxId)item.card.voxId=uid();return {family:'instrument',sel:{kind:'chord',key:`chord:${info.part.id}:${item.card.voxId}`,part:info.part,card:item.card,startBeat:item.startBeat,dur:item.dur,flatIndex:item.flatIndex}};});
    if(info.kind==='lead')return (info.part.events||[]).map(event=>{if(!event.voxId)event.voxId=uid();return {family:'instrument',sel:{kind:'lead',key:`lead:${info.part.id}:${event.voxId}`,part:info.part,event,startBeat:leadEventStartBeat(info.part,event),dur:leadEventDurationBeats(info.part,event)}};});
    if(info.kind==='drum')return drumEvents.map(event=>({family:'instrument',sel:{kind:'drum',key:`drum:${event.id}`,event,startBeat:Number(event.startBeat)||0,dur:Math.max(.03,Number(event.durationBeats)||4),name:'Drums'}}));
    return [];
  }
  function updateVoxSelectAllUi(){
    const wrap=$('voxSelectAllTrackWrap'),box=$('voxSelectAllTrack');if(!wrap||!box)return;wrap.hidden=voxToolMode!=='multi';if(wrap.hidden)return;
    const info=focusedVoxTrackInfo(),items=allSelectionsForFocusedTrack(info);let selected=0;
    for(const item of items){if(item.family==='vocal'){if(voxIsSelected(item.part.id,item.event.id))selected++;}else if(voxInstrumentIsSelected(item.sel.key))selected++;}
    box.disabled=!info||!items.length;box.checked=!!items.length&&selected===items.length;box.indeterminate=selected>0&&selected<items.length;wrap.classList.toggle('is-all',box.checked);wrap.title=info?`${box.checked?'Clear':'Select'} all events on ${info.name}`:'Select a track first';
  }
  function setVoxSelectAllForFocusedTrack(on){
    const info=focusedVoxTrackInfo(),items=allSelectionsForFocusedTrack(info);if(!info||!items.length){updateVoxSelectAllUi();return;}
    if(on){for(const item of items){if(item.family==='vocal'){if(!voxIsSelected(item.part.id,item.event.id))voxSelections.push({partId:item.part.id,eventId:item.event.id});}else if(!voxInstrumentIsSelected(item.sel.key))voxInstrumentSelections.push(item.sel);}}
    else{if(info.kind==='vocal')voxSelections=voxSelections.filter(s=>String(s.partId)!==String(info.part.id));else if(info.kind==='drum')voxInstrumentSelections=voxInstrumentSelections.filter(s=>(resolveVoxInstrumentSelection(s)||s).kind!=='drum');else voxInstrumentSelections=voxInstrumentSelections.filter(s=>String((resolveVoxInstrumentSelection(s)||s).part?.id||'')!==String(info.part.id));}
    voxSelected=voxSelections[0]||null;voxInstrumentSelection=voxInstrumentSelections[0]||null;renderVoxSelectionClasses();renderVoxInspector();voxStatus(`${on?'Selected':'Cleared'} all ${items.length} event${items.length===1?'':'s'} on ${info.name}.`);
  }
  function renderVoxSelectionClasses(){
    document.querySelectorAll('.vox-event').forEach(el=>el.classList.toggle('is-selected',voxIsSelected(el.dataset.voxPartId,el.dataset.voxEventId)));
    document.querySelectorAll('.vox-instrument-event').forEach(el=>el.classList.toggle('is-selected',voxInstrumentIsSelected(el.dataset.voxKey)));
    updateVoxSelectAllUi();
  }
  function voxEventBounds(e){const start=Math.max(0,Number(e?.startBeat)||0),dur=Math.max(.001,voxEventDurationBeats(e));return {start,end:start+dur,dur};}
  // v3.3.55 — Cubase-style Range Select for every Track Master lane.
  // A range can target one vocal, chord/note, Lead/Bass, or drum track. Copy/Cut/Delete
  // trim only the selected time window and preserve the rest of any crossing event.
  function voxRangeMinBeat(){return voxSnapEnabled()?Math.max(.03,voxBeatStep()):.03;}
  function voxRangeTrackInfo(track){
    if(!track)return null;
    if(track.trackKey&&track.kind)return track;
    if(track.type==='vocal')return {kind:'vocal',part:track,partId:track.id,trackKey:`part:${track.id}`,name:track.name||'Vocals'};
    if(track.type==='chord')return {kind:'chord',part:track,partId:track.id,trackKey:`part:${track.id}`,name:track.name||'Chord / Note'};
    if(track.type==='lead')return {kind:'lead',part:track,partId:track.id,trackKey:`part:${track.id}`,name:track.name||'Lead / Bass'};
    if(track.kind==='drum'||track==='drum')return {kind:'drum',part:null,partId:null,trackKey:'drum-map',name:'Drums'};
    return null;
  }
  function voxRangeResolved(){
    const sel=voxRangeSelection;if(!voxRangeMode||!sel||sel.awaitingEnd)return null;
    let part=null;if(sel.kind!=='drum'){part=parts.find(p=>String(p.id)===String(sel.partId)&&String(p.type)===String(sel.kind));if(!part)return null;}
    const start=Math.max(0,Number(sel.startBeat)||0),end=Math.max(start,Number(sel.endBeat)||start);if(end-start<.001)return null;
    return {kind:sel.kind,part,trackKey:sel.trackKey,name:sel.name||(part?.name||'Track'),start,end,dur:end-start};
  }
  function voxRangeBeatAt(lane,clientX){const rect=lane.getBoundingClientRect(),raw=Math.max(0,(Number(clientX)-rect.left)/voxPpb());return quantizeVoxBeat(raw);}
  function updateVoxRangeOverlay(track,lane){
    if(!lane)return;const info=voxRangeTrackInfo(track);let box=lane.querySelector('.vox-range-selection');const sel=voxRangeSelection,same=voxRangeMode&&sel&&info&&String(sel.trackKey)===String(info.trackKey);
    if(!same){box?.remove();return;}
    if(!box){box=document.createElement('div');box.className='vox-range-selection';box.innerHTML='<span class="vox-range-caption"></span><button type="button" class="vox-range-handle start" aria-label="Selection start"></button><button type="button" class="vox-range-handle end" aria-label="Selection end"></button>';lane.appendChild(box);const sh=box.querySelector('.vox-range-handle.start'),eh=box.querySelector('.vox-range-handle.end');sh.onpointerdown=e=>beginVoxRangeHandleDrag(e,'start',info,lane);eh.onpointerdown=e=>beginVoxRangeHandleDrag(e,'end',info,lane);}
    const a=Math.max(0,Number(sel.startBeat)||0),b=Math.max(a,Number(sel.endBeat)||a),left=a*voxPpb(),width=Math.max(2,(b-a)*voxPpb());box.style.left=`${left}px`;box.style.width=`${width}px`;box.classList.toggle('is-pending',!!sel.awaitingEnd);const cap=box.querySelector('.vox-range-caption');if(cap){cap.textContent=sel.awaitingEnd?'START':`${(b-a).toFixed(2)}b`;cap.hidden=!sel.awaitingEnd&&width<52;}
  }
  function announceVoxRange(){const r=voxRangeResolved();if(r)voxStatus(`Range selected on ${r.name}: ${r.start.toFixed(2)}–${r.end.toFixed(2)} beats. Copy, Cut, or Delete; drag either blue handle to adjust.`);}
  function beginVoxRangeHandleDrag(e,edge,track,lane){
    const info=voxRangeTrackInfo(track);if(!voxRangeMode||!voxRangeSelection||!info||String(voxRangeSelection.trackKey)!==String(info.trackKey))return;if(e.button!==undefined&&e.button!==0)return;e.preventDefault();e.stopPropagation();disableVoxAutoScroll();const handle=e.currentTarget,pid=e.pointerId,min=voxRangeMinBeat();try{handle.setPointerCapture(pid)}catch{}
    const apply=clientX=>{const beat=voxRangeBeatAt(lane,clientX),sel=voxRangeSelection;if(!sel)return;if(edge==='start')sel.startBeat=Math.max(0,Math.min((Number(sel.endBeat)||0)-min,beat));else sel.endBeat=Math.max((Number(sel.startBeat)||0)+min,beat);sel.anchorBeat=edge==='start'?sel.startBeat:sel.endBeat;sel.awaitingEnd=false;updateVoxRangeOverlay(info,lane);renderVoxInspector();};
    const move=ev=>{if(ev.pointerId!==pid)return;ev.preventDefault();apply(ev.clientX);};const up=ev=>{if(ev.pointerId!==pid)return;try{handle.releasePointerCapture(pid)}catch{};window.removeEventListener('pointermove',move,true);window.removeEventListener('pointerup',up,true);window.removeEventListener('pointercancel',up,true);apply(ev.clientX);announceVoxRange();};window.addEventListener('pointermove',move,{capture:true,passive:false});window.addEventListener('pointerup',up,true);window.addEventListener('pointercancel',up,true);
  }
  function focusVoxRangeTrack(info){
    if(!info)return;
    if(info.kind==='vocal'){voxTargetPartId=info.partId;voxInstrumentTrackFocus=null;}
    else{voxInstrumentTrackFocus={kind:info.kind,name:info.name,key:info.trackKey,explicitTarget:true};}
    voxSelections=[];voxSelected=null;voxInstrumentSelections=[];voxInstrumentSelection=null;syncVoxTrackFocusClasses();updateVoxSelectAllUi();
  }
  function beginVoxRangePointer(e,track,lane){
    const info=voxRangeTrackInfo(track);if(!voxRangeMode||!info||!lane)return false;if(e.button!==undefined&&e.button!==0)return false;e.preventDefault();e.stopPropagation();disableVoxAutoScroll();focusVoxRangeTrack(info);
    const capture=e.currentTarget||lane,pid=e.pointerId,downX=e.clientX,downY=e.clientY,downBeat=voxRangeBeatAt(lane,e.clientX),previous=(voxRangeSelection&&String(voxRangeSelection.trackKey)===String(info.trackKey))?{...voxRangeSelection}:null;let moved=false,lastBeat=downBeat;try{capture.setPointerCapture?.(pid)}catch{}
    const makeSel=(a,b,pending=false,anchor=downBeat)=>({kind:info.kind,partId:info.partId,trackKey:info.trackKey,name:info.name,anchorBeat:anchor,startBeat:a,endBeat:b,awaitingEnd:pending});
    const preview=beat=>{lastBeat=beat;const start=Math.min(downBeat,beat),end=Math.max(downBeat,beat);voxRangeSelection=makeSel(start,end,false,downBeat);updateVoxRangeOverlay(info,lane);renderVoxInspector();};
    const move=ev=>{if(ev.pointerId!==pid)return;const dist=Math.hypot(ev.clientX-downX,ev.clientY-downY);if(dist>5)moved=true;if(moved){ev.preventDefault();preview(voxRangeBeatAt(lane,ev.clientX));}};
    const cleanup=()=>{window.removeEventListener('pointermove',move,true);window.removeEventListener('pointerup',up,true);window.removeEventListener('pointercancel',cancel,true);};
    const up=ev=>{if(ev.pointerId!==pid)return;try{capture.releasePointerCapture?.(pid)}catch{};cleanup();const beat=voxRangeBeatAt(lane,ev.clientX);if(moved){preview(beat);const sel=voxRangeSelection,min=voxRangeMinBeat();if(sel.endBeat-sel.startBeat<min)sel.endBeat=sel.startBeat+min;updateVoxRangeOverlay(info,lane);announceVoxRange();}
      else if(previous?.awaitingEnd){const anchor=Math.max(0,Number(previous.anchorBeat)||0),start=Math.min(anchor,beat),end=Math.max(anchor,beat),min=voxRangeMinBeat();voxRangeSelection=makeSel(start,Math.max(start+min,end),false,anchor);updateVoxRangeOverlay(info,lane);announceVoxRange();}
      else{voxRangeSelection=makeSel(beat,beat,true,beat);updateVoxRangeOverlay(info,lane);voxStatus(`Range start set at beat ${beat.toFixed(2)} on ${info.name}. Tap the end point.`);}renderVoxInspector();};
    const cancel=ev=>{if(ev.pointerId!==pid)return;cleanup();if(moved&&previous)voxRangeSelection=previous;else if(moved)voxRangeSelection=null;updateVoxRangeOverlay(info,lane);renderVoxInspector();};
    window.addEventListener('pointermove',move,{capture:true,passive:false});window.addEventListener('pointerup',up,{capture:true,passive:false});window.addEventListener('pointercancel',cancel,true);return true;
  }
  function voxRangeSegments(range){
    const out=[];if(!range||range.kind!=='vocal')return out;const beatSec=60/Math.max(40,Math.min(240,Number(core.bpm)||92));for(const event of voxTrackEvents(range.part)){const b=voxEventBounds(event),start=Math.max(range.start,b.start),end=Math.min(range.end,b.end);if(end-start<=.001)continue;const trim0=Math.max(0,Number(event.trimStartSec)||0),seg=clone(event);seg.startBeat=start;seg.trimStartSec=Math.max(0,trim0+(start-b.start)*beatSec);seg.trimEndSec=Math.max(seg.trimStartSec+.001,trim0+(end-b.start)*beatSec);out.push({event:seg,sourcePartId:range.part.id,deltaBeat:start-range.start});}return out;
  }
  function removeVoxRangeContent(range){
    if(!range||range.kind!=='vocal')return 0;const part=range.part,beatSec=60/Math.max(40,Math.min(240,Number(core.bpm)||92)),next=[];let touched=0;for(const event of (part.voxEvents||[])){const b=voxEventBounds(event);if(range.end<=b.start+.001||range.start>=b.end-.001){next.push(event);continue;}touched++;const trim0=Math.max(0,Number(event.trimStartSec)||0),trimEnd=trim0+b.dur*beatSec,leftKeep=range.start>b.start+.001,rightKeep=range.end<b.end-.001;if(leftKeep){const left=clone(event);left.trimEndSec=Math.max(trim0+.001,trim0+(range.start-b.start)*beatSec);next.push(left);}if(rightKeep){const right=clone(event);if(leftKeep)right.id=uid();right.startBeat=range.end;right.trimStartSec=Math.max(trim0,trim0+(range.end-b.start)*beatSec);right.trimEndSec=trimEnd;next.push(right);}}
    part.voxEvents=next.map(e=>normalizeVoxEvent(e,part)).filter(Boolean);return touched;
  }
  function leadRangeSegment(part,event,start,end,{newId=false}={}){const stepBeats=4/Math.max(8,Number(part.resolution)||16),e=clone(event),dur=Math.max(stepBeats,end-start);if(newId||!e.voxId)e.voxId=uid();e.voxStartBeat=start;e.voxDurationBeats=dur;e.step=Math.max(0,Math.round(start/stepBeats));e.durationSteps=Math.max(1,Math.round(dur/stepBeats));return e;}
  function chordRangeSegment(card,start,end,{newId=false}={}){const c=clone(card),dur=Math.max(.03,end-start);if(newId||!c.voxId)c.voxId=uid();c.voxStartBeat=start;c.voxDurationBeats=dur;c.durationBeats=dur;return c;}
  function instrumentRangeSegments(range){
    const out=[];if(!range||range.kind==='vocal')return out;
    if(range.kind==='lead'){for(const event of range.part.events||[]){const s=leadEventStartBeat(range.part,event),e=s+leadEventDurationBeats(range.part,event),a=Math.max(range.start,s),b=Math.min(range.end,e);if(b-a<=.001)continue;out.push({kind:'lead',event:leadRangeSegment(range.part,event,a,b),sourcePartId:range.part.id,deltaBeat:a-range.start});}}
    else if(range.kind==='chord'){for(const item of chordFlatItems(range.part)){const a=Math.max(range.start,item.startBeat),b=Math.min(range.end,item.startBeat+item.dur);if(b-a<=.001)continue;out.push({kind:'chord',card:chordRangeSegment(item.card,a,b),sourcePartId:range.part.id,deltaBeat:a-range.start});}}
    else if(range.kind==='drum'){for(const event of drumEvents){const s=Number(event.startBeat)||0,e=s+Math.max(.03,Number(event.durationBeats)||4),a=Math.max(range.start,s),b=Math.min(range.end,e);if(b-a<=.001)continue;out.push({kind:'drum',event:normalizeDrumEvent({...clone(event),id:event.id,startBeat:a,durationBeats:b-a,patternOffsetBeats:(Number(event.patternOffsetBeats)||0)+(a-s)}),deltaBeat:a-range.start});}}
    return out;
  }
  function removeInstrumentRangeContent(range){
    if(!range||range.kind==='vocal')return 0;let touched=0;
    if(range.kind==='lead'){
      const next=[];for(const event of range.part.events||[]){const s=leadEventStartBeat(range.part,event),e=s+leadEventDurationBeats(range.part,event);if(range.end<=s+.001||range.start>=e-.001){next.push(event);continue;}touched++;const left=range.start>s+.001,right=range.end<e-.001;if(left)next.push(leadRangeSegment(range.part,event,s,range.start));if(right)next.push(leadRangeSegment(range.part,event,range.end,e,{newId:left}));}range.part.events=normalizeLeadEvents(next);
    }else if(range.kind==='chord'){
      const hits=chordFlatItems(range.part).filter(item=>range.start<item.startBeat+item.dur-.001&&range.end>item.startBeat+.001);for(const item of hits){touched++;const s=item.startBeat,e=s+item.dur,left=range.start>s+.001,right=range.end<e-.001;removeChordCardFromPart(range.part,item.card);if(left)insertChordCardIntoPart(range.part,chordRangeSegment(item.card,s,range.start),s);if(right)insertChordCardIntoPart(range.part,chordRangeSegment(item.card,range.end,e,{newId:left}),range.end);}if(String(range.part.id)===String(loadedChordPartId))core.apply(range.part.data);
    }else if(range.kind==='drum'){
      drumArrangementInitialized=true;const next=[];for(const event of drumEvents){const s=Number(event.startBeat)||0,e=s+Math.max(.03,Number(event.durationBeats)||4);if(range.end<=s+.001||range.start>=e-.001){next.push(event);continue;}touched++;const left=range.start>s+.001,right=range.end<e-.001;if(left)next.push(normalizeDrumEvent({...clone(event),startBeat:s,durationBeats:range.start-s}));if(right)next.push(normalizeDrumEvent({...clone(event),id:left?uid():event.id,startBeat:range.end,durationBeats:e-range.end,patternOffsetBeats:(Number(event.patternOffsetBeats)||0)+(range.end-s)}));}drumEvents=next.sort((a,b)=>a.startBeat-b.startBeat);
    }
    return touched;
  }
  function copyVoxRange(cut=false){
    const range=voxRangeResolved();if(!range){voxStatus('Finish the Select range first. On phone: tap the start, then tap the end.');return true;}
    if(range.kind==='vocal'){
      const items=voxRangeSegments(range);if(!items.length){voxStatus('That range contains no vocal audio.');return true;}voxClipboard={kind:'vocal-range',items,durationBeats:range.dur,sourcePartId:range.part.id};if(cut){voxCheckpoint();const n=removeVoxRangeContent(range);renderVoxBox();persistVoxEditsAfterPaint({renderPartsToo:true});voxStatus(`${range.dur.toFixed(2)}-beat range cut from ${range.name} (${n} event${n===1?'':'s'} affected). Paste starts at the playhead.`);}else{renderVoxInspector();voxStatus(`${range.dur.toFixed(2)}-beat range copied from ${range.name}. Paste starts at the playhead.`);}return true;
    }
    const items=instrumentRangeSegments(range);if(!items.length){voxStatus(`That range contains no ${range.name} events.`);return true;}voxClipboard={kind:'instrument-group',focusKeyAtCopy:range.trackKey,items};if(cut){voxCheckpoint();const n=removeInstrumentRangeContent(range);renderVoxBox();persistVoxEditsAfterPaint({renderPartsToo:true});voxStatus(`${range.dur.toFixed(2)}-beat range cut from ${range.name} (${n} event${n===1?'':'s'} affected). Paste starts at the playhead.`);}else{renderVoxInspector();voxStatus(`${range.dur.toFixed(2)}-beat range copied from ${range.name}. Paste starts at the playhead.`);}return true;
  }
  function deleteVoxRange(){
    const range=voxRangeResolved();if(!range){voxStatus('Finish the Select range first.');return true;}
    const hits=range.kind==='vocal'?voxRangeSegments(range):instrumentRangeSegments(range);if(!hits.length){voxStatus(`That range contains no ${range.kind==='vocal'?'vocal audio':`${range.name} events`}.`);return true;}voxCheckpoint();const n=range.kind==='vocal'?removeVoxRangeContent(range):removeInstrumentRangeContent(range);renderVoxBox();persistVoxEditsAfterPaint({renderPartsToo:true});voxStatus(`${range.dur.toFixed(2)}-beat range deleted from ${range.name} (${n} event${n===1?'':'s'} affected).${range.kind==='vocal'?' Original takes remain safe.':''}`);return true;
  }
  function setVoxAutoScroll(on,{manual=false,persist=true}={}){
    voxAutoScroll=!!on;if(persist){try{localStorage.setItem(VOX_AUTO_KEY,voxAutoScroll?'1':'0')}catch{}}
    const b=$('voxAutoScrollBtn');if(b){b.classList.toggle('is-active',voxAutoScroll);b.setAttribute('aria-pressed',String(voxAutoScroll));b.textContent='→';b.setAttribute('aria-label','AutoScroll');b.title=voxAutoScroll?'AutoScroll on — follows the playhead':'AutoScroll off';}
    if(manual&&!voxAutoScroll)voxStatus('AutoScroll off — manual navigation detected.');
  }
  function disableVoxAutoScroll(){if(voxAutoScroll)setVoxAutoScroll(false,{manual:true});}
  let voxLastFollowBeat=null;
  function updateVoxPlayhead(beat,scrollIntoView=false){
    voxPlayheadBeat=Math.max(0,Math.min(voxTimelineBeats(),Number(beat)||0));
    const x=voxLabelWidth()+voxPlayheadBeat*voxPpb(),ph=$('voxPlayhead');if(ph)ph.style.left=`${x}px`;
    // Harmony is textual UI; rebuilding it at 60fps was enough DOM churn to make
    // horizontal follow stutter on phones. Refresh only on quarter-beat changes.
    if(voxBoxOpen){const hk=`${Math.floor(voxPlayheadBeat*4)}:${Math.round(Number(core.bpm)||92)}`;if(hk!==voxLastHarmonyBeatKey){voxLastHarmonyBeatKey=hk;renderVoxHarmonyGuide();}}
    if(scrollIntoView){const sc=$('voxTimelineScroller');if(sc){
      const wrapped=Number.isFinite(voxLastFollowBeat)&&voxPlayheadBeat+0.75<voxLastFollowBeat;
      const viewport=Math.max(120,sc.clientWidth),label=voxLabelWidth(),anchor=Math.min(viewport*.58,Math.max(label+70,viewport-190)),max=Math.max(0,sc.scrollWidth-viewport);
      if(wrapped){
        // A repeat is a transport jump, not a backwards camera animation.
        const startX=voxLabelWidth()+effectiveSongStartBeat()*voxPpb();sc.scrollLeft=Math.max(0,Math.min(max,startX-anchor));
      }else{
        // Once the playhead reaches the follow anchor, move the viewport a few pixels
        // every animation frame at exactly the playhead rate. No edge-hit jump cycle.
        const target=Math.max(0,Math.min(max,x-anchor));if(x>=anchor||sc.scrollLeft>target+2)sc.scrollLeft=target;
      }
      voxLastFollowBeat=voxPlayheadBeat;
    }}else voxLastFollowBeat=null;
  }
  function voxSeekTo(beat,{manual=false}={}){
    if(recording&&!recordingPaused){voxStatus('Pause or stop recording before moving the playhead.');return;}
    const target=Math.max(effectiveSongStartBeat(),Math.min(mediaDurationBeats(),Number(beat)||0));
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
      const cacheKey=`${event.takeId}|${Math.round(startSec*1000)}|${Math.round(endSec*1000)}|${w}`;
      let peaks=voxWaveformPeakCache.get(cacheKey);
      if(!peaks){
        peaks=new Float32Array(w*2);
        // Cap each pixel column to a representative sample budget. The old renderer
        // rescanned every source sample after page/instrument/navigation changes,
        // which could block mobile's main thread long enough to starve the audio scheduler.
        for(let x=0;x<w;x++){
          const a=i0+Math.floor(x/w*span),b=Math.min(i1,a+Math.max(1,Math.ceil(span/w))),count=Math.max(1,b-a),stride=Math.max(1,Math.floor(count/96));let lo=1,hi=-1;
          for(let i=a;i<b;i+=stride){const v=data[i]||0;if(v<lo)lo=v;if(v>hi)hi=v;}
          if(lo>hi){lo=0;hi=0;}peaks[x*2]=lo;peaks[x*2+1]=hi;
        }
        voxWaveformPeakCache.set(cacheKey,peaks);
        if(voxWaveformPeakCache.size>180)voxWaveformPeakCache.delete(voxWaveformPeakCache.keys().next().value);
      }
      g.beginPath();for(let x=0;x<w;x++){const lo=peaks[x*2],hi=peaks[x*2+1];g.moveTo(x,mid-hi*mid*.82);g.lineTo(x,mid-lo*mid*.82);}g.stroke();
    }catch(err){console.warn('Could not draw Vox Box waveform',err);}
  }
  function queueLiveVoxWaveform(canvas,event){
    if(!canvas||!event||canvas.__voxWaveQueued)return;
    const token=voxRenderToken,run=()=>{canvas.__voxWaveQueued=0;drawVoxWaveform(canvas,event,token);};
    // During playback, waveform painting is visual-only work. Let the browser do it
    // in idle time (with a short timeout) so sound scheduling/decoding stays first.
    if((playing||starting)&&typeof requestIdleCallback==='function')canvas.__voxWaveQueued=requestIdleCallback(run,{timeout:700});
    else canvas.__voxWaveQueued=requestAnimationFrame(run);
  }
  function updateVoxEventReadout(el,event){if(!el||!event)return;const b=voxEventBounds(event),time=el.querySelector('.vox-event-time');if(time)time.textContent=`${b.start.toFixed(2)}–${b.end.toFixed(2)}b`;}

  function voxSnapshot(){
    return {parts:clone(parts),beat:window.CRPBeatMaker?.getBeat?.()||null,drumEvents:clone(drumEvents),drumArrangementInitialized,songStartBeat,effectiveSongEndBeat:songEndBeat,activePartId,loadedChordPartId,voxTargetPartId,voxPlayheadBeat,voxInstrumentTrackFocus:voxInstrumentTrackFocus?clone(voxInstrumentTrackFocus):null,voxToolMode,voxRangeMode,voxRangeSelection:voxRangeSelection?clone(voxRangeSelection):null};
  }
  function updateVoxHistoryButtons(){if($('voxUndoBtn'))$('voxUndoBtn').disabled=!voxUndoStack.length;if($('voxRedoBtn'))$('voxRedoBtn').disabled=!voxRedoStack.length;}
  function voxCheckpoint(){voxUndoStack.push(voxSnapshot());if(voxUndoStack.length>50)voxUndoStack.shift();voxRedoStack=[];updateVoxHistoryButtons();}
  function restoreVoxSnapshot(snap){
    if(!snap)return;parts=(snap.parts||[]).map((p,i)=>normalizePart(p,i)).filter(Boolean);ensureInitial();
    activePartId=parts.some(p=>String(p.id)===String(snap.activePartId))?snap.activePartId:(parts[0]?.id||null);
    loadedChordPartId=parts.some(p=>p.type==='chord'&&String(p.id)===String(snap.loadedChordPartId))?snap.loadedChordPartId:(parts.find(p=>p.type==='chord')?.id||null);
    if(snap.beat)window.CRPBeatMaker?.setBeat?.(snap.beat,{persist:true});drumEvents=Array.isArray(snap.drumEvents)?snap.drumEvents.map(normalizeDrumEvent).filter(Boolean):drumEvents;drumArrangementInitialized=snap.drumArrangementInitialized!==false;songStartBeat=Math.max(0,Number(snap.songStartBeat)||0);songEndBeat=Number.isFinite(Number(snap.effectiveSongEndBeat))?Number(snap.effectiveSongEndBeat):songEndBeat;
    voxTargetPartId=parts.some(p=>p.type==='vocal'&&String(p.id)===String(snap.voxTargetPartId))?snap.voxTargetPartId:(allVocalParts()[0]?.id||null);voxPlayheadBeat=Math.max(0,Number(snap.voxPlayheadBeat)||0);voxSelections=[];voxSelected=null;voxInstrumentSelections=[];voxInstrumentSelection=null;voxInstrumentTrackFocus=snap.voxInstrumentTrackFocus?clone(snap.voxInstrumentTrackFocus):null;voxToolMode=snap.voxToolMode||voxToolMode;voxRangeMode=!!snap.voxRangeMode;voxRangeSelection=snap.voxRangeSelection?clone(snap.voxRangeSelection):null;
    const c=parts.find(p=>p.type==='chord'&&String(p.id)===String(loadedChordPartId));if(c)core.apply(c.data);
    renderParts();persistVoxEdits();renderVoxBox();
  }
  function voxUndo(){if(!voxUndoStack.length)return;voxRedoStack.push(voxSnapshot());restoreVoxSnapshot(voxUndoStack.pop());updateVoxHistoryButtons();voxStatus('Undo.');}
  function voxRedo(){if(!voxRedoStack.length)return;voxUndoStack.push(voxSnapshot());restoreVoxSnapshot(voxRedoStack.pop());updateVoxHistoryButtons();voxStatus('Redo.');}

  function resolveVoxInstrumentSelection(sel){
    if(!sel)return null;
    const key=String(sel.key||'');
    if(sel.kind==='drum'||key.startsWith('drum:')){const id=String(sel.event?.id||key.slice(5)||'');const event=drumEvents.find(e=>String(e.id)===id);if(!event)return null;return {...sel,kind:'drum',key:`drum:${event.id}`,event,startBeat:Number(event.startBeat)||0,dur:Math.max(.03,Number(event.durationBeats)||4),name:'Drums'};}
    if(sel.kind==='lead'||key.startsWith('lead:')){
      const bits=key.split(':'),partId=String(sel.part?.id||bits[1]||''),voxId=String(sel.event?.voxId||bits.slice(2).join(':')||'');
      const part=parts.find(p=>p.type==='lead'&&String(p.id)===partId);if(!part)return null;
      const event=(part.events||[]).find(e=>String(e.voxId||'')===voxId)||((part.events||[]).includes(sel.event)?sel.event:null);if(!event)return null;
      return {...sel,kind:'lead',key:`lead:${part.id}:${event.voxId}`,part,event,startBeat:leadEventStartBeat(part,event),dur:leadEventDurationBeats(part,event)};
    }
    if(sel.kind==='chord'||key.startsWith('chord:')){
      const bits=key.split(':'),partId=String(sel.part?.id||bits[1]||''),voxId=String(sel.card?.voxId||bits.slice(2).join(':')||'');
      const part=parts.find(p=>p.type==='chord'&&String(p.id)===partId);if(!part)return null;
      const item=chordFlatItems(part).find(x=>String(x.card?.voxId||'')===voxId)||null;if(!item)return null;
      return {...sel,kind:'chord',key:`chord:${part.id}:${item.card.voxId}`,part,card:item.card,startBeat:item.startBeat,dur:item.dur,flatIndex:item.flatIndex};
    }
    return sel;
  }
  function voxInstrumentSelectionList(){
    const raw=Array.isArray(voxInstrumentSelections)?voxInstrumentSelections.filter(Boolean):[],resolved=raw.map(resolveVoxInstrumentSelection).filter(Boolean);
    if(resolved.length!==raw.length||resolved.some((x,i)=>x!==raw[i])){voxInstrumentSelections=resolved;voxInstrumentSelection=resolved[0]||null;}
    return resolved;
  }
  function voxInstrumentIsSelected(key){return voxInstrumentSelectionList().some(x=>String(x.key)===String(key));}
  function setVoxInstrumentSelection(sel,{add=false,toggle=false,render=true}={}){
    if(voxToolMode!=='multi'){voxSelections=[];voxSelected=null;}
    if(!sel){voxInstrumentSelections=[];voxInstrumentSelection=null;if(render){renderVoxSelectionClasses();renderVoxInspector();}return;}
    // v3.3.47 — event selection and the gold paste/drop target are separate states.
    // In Multi Select, tapping clips must not steal an explicitly tapped destination row.
    // With no explicit destination, keep a lightweight implicit focus on the clip's own row.
    if(!(voxToolMode==='multi'&&voxInstrumentTrackFocus?.explicitTarget===true)){
      voxInstrumentTrackFocus={kind:sel.kind||'instrument',name:sel.kind==='drum'?'Drums':(sel.part?.name||'Instrument'),key:sel.kind==='drum'?'drum-map':(sel.part?.id?`part:${sel.part.id}`:null),explicitTarget:false};
    }
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
    if(s.kind==='drum')return `Drums • ${s.dur.toFixed(2)} beats from ${s.startBeat.toFixed(2)}`;
    if(s.kind==='lead')return `${s.part?.name||'Lead'} • ${midiName(s.event?.midi||60)} at beat ${s.startBeat.toFixed(2)}`;
    if(s.kind==='chord')return `${s.part?.name||'Chords'} • ${s.card?.value||'event'} at beat ${s.startBeat.toFixed(2)}`;
    return 'Instrument event';
  }
  function voxTrackTokenForPart(part){return part?`part:${part.id}`:'';}
  function readVoxTrackOrder(){try{const a=JSON.parse(localStorage.getItem(VOX_TRACK_ORDER_KEY)||'[]');return Array.isArray(a)?a:[];}catch{return [];}}
  function writeVoxTrackOrder(a){try{localStorage.setItem(VOX_TRACK_ORDER_KEY,JSON.stringify(a||[]));}catch{}}
  function applyVoxTrackOrder(){
    const host=$('voxTracks');if(!host)return;const all=[...host.querySelectorAll(':scope > .vox-track-row[data-vox-track-key]')];if(all.length<2)return;
    const drum=all.find(r=>r.dataset.voxTrackKey==='drum-map')||null,saved=readVoxTrackOrder(),rank=new Map(saved.map((k,i)=>[String(k),i]));
    const bySavedOrder=(a,b)=>{const ak=String(a.dataset.voxTrackKey||''),bk=String(b.dataset.voxTrackKey||''),ar=rank.has(ak)?rank.get(ak):1e6,br=rank.has(bk)?rank.get(bk):1e6;return ar-br;};
    // v3.3.49 — Drums belong to the Instruments section. Keep all melodic
    // instrument tracks together, then Drums, then vocal tracks.
    const instruments=all.filter(r=>r!==drum&&String(r.dataset.voxKind||'')!=='vocal').sort(bySavedOrder);
    const vocals=all.filter(r=>String(r.dataset.voxKind||'')==='vocal').sort(bySavedOrder);
    instruments.forEach(r=>host.appendChild(r));if(drum)host.appendChild(drum);vocals.forEach(r=>host.appendChild(r));
  }
  function persistCurrentVoxTrackOrder(){
    const host=$('voxTracks');if(!host)return;const order=[...host.querySelectorAll(':scope > .vox-track-row[data-vox-track-key]')].map(r=>r.dataset.voxTrackKey).filter(k=>k!=='drum-map');writeVoxTrackOrder(order);
    const rank=new Map(order.filter(k=>String(k).startsWith('part:')).map((k,i)=>[String(k).slice(5),i]));parts.sort((a,b)=>(rank.get(String(a.id))??1e6)-(rank.get(String(b.id))??1e6));markPartsDirty();renderParts();core.scheduleAutoSave();core.flushAutoSaveNow?.();
  }
  function wireVoxTrackLongPress(label,row){
    if(!label||!row||label.dataset.reorderWired)return;label.dataset.reorderWired='1';label.classList.add('vox-track-reorder-handle');
    label.addEventListener('pointerdown',e=>{
      if(e.target.closest('button,select,input,label'))return;if(e.button!==undefined&&e.button!==0)return;
      const pid=e.pointerId,startY=e.clientY,host=row.parentElement;let active=false,moved=false,lastY=startY;
      const cleanup=()=>{window.removeEventListener('pointermove',move,true);window.removeEventListener('pointerup',up,true);window.removeEventListener('pointercancel',up,true);document.body.classList.remove('vox-track-reordering');};
      const timer=setTimeout(()=>{active=true;row.classList.add('is-reordering');document.body.classList.add('vox-track-reordering');try{label.setPointerCapture(pid)}catch{};if(navigator.vibrate)try{navigator.vibrate(18)}catch{};voxStatus('Track reorder — drag up or down, then release.');},360);
      const move=ev=>{if(ev.pointerId!==pid)return;lastY=ev.clientY;if(Math.abs(lastY-startY)>5)moved=true;if(!active)return;ev.preventDefault();const rows=[...host.querySelectorAll(':scope > .vox-track-row[data-vox-track-key]')].filter(r=>r!==row&&r.dataset.voxTrackKey!=='drum-map');let before=null;for(const candidate of rows){const r=candidate.getBoundingClientRect();if(lastY<r.top+r.height/2){before=candidate;break;}}if(before){if(row.nextElementSibling!==before)host.insertBefore(row,before);}else{const drum=host.querySelector(':scope > .vox-track-row[data-vox-track-key="drum-map"]');drum?host.insertBefore(row,drum):host.appendChild(row);}};
      const up=ev=>{if(ev.pointerId!==pid)return;clearTimeout(timer);cleanup();if(active){try{label.releasePointerCapture(pid)}catch{};row.classList.remove('is-reordering');persistCurrentVoxTrackOrder();voxStatus('Track order updated.');}};
      window.addEventListener('pointermove',move,{passive:false,capture:true});window.addEventListener('pointerup',up,true);window.addEventListener('pointercancel',up,true);
    });
  }
  function syncVoxTrackFocusClasses(){
    const instrumentKey=String(voxInstrumentTrackFocus?.key||'');
    document.querySelectorAll('#voxTracks > .vox-track-row[data-vox-track-key]').forEach(row=>{
      const key=String(row.dataset.voxTrackKey||''),kind=String(row.dataset.voxKind||'');
      row.classList.toggle('is-instrument-focus',!!instrumentKey&&kind!=='vocal'&&key===instrumentKey);
      if(kind==='vocal')row.classList.toggle('is-target',!instrumentKey&&String(row.dataset.voxPartId||'')===String(voxTargetPartId||''));
    });
  }
  function focusVoxInstrumentTrack(kind,name,key=null,{announce=false}={}){
    // In Multi Select, changing the highlighted track must NOT throw away selections
    // on other tracks. This is what makes per-track “All” additive across tracks.
    if(voxToolMode!=='multi'){voxSelections=[];voxSelected=null;voxInstrumentSelections=[];voxInstrumentSelection=null;}
    // A direct tap on a row is an explicit paste/drop destination. Keep that target
    // sticky while Multi Select clips are chosen elsewhere.
    voxInstrumentTrackFocus={kind:kind||'instrument',name:name||'Instrument',key:key||null,explicitTarget:true};
    renderVoxSelectionClasses();syncVoxTrackFocusClasses();renderVoxInspector();updateVoxSelectAllUi();
    if(announce)voxStatus(`${name||'Instrument'} selected — Paste and drag/drop will target this track.`);
  }
  function focusVoxVocalTrack(part,{announce=false}={}){
    if(!part)return;voxTargetPartId=part.id;
    if(voxToolMode!=='multi'){voxSelections=[];voxSelected=null;voxInstrumentSelections=[];voxInstrumentSelection=null;}
    voxInstrumentTrackFocus=null;
    renderVoxSelectionClasses();syncVoxTrackFocusClasses();renderVoxInspector();updateVoxSelectAllUi();
    if(announce)voxStatus(`${part.name||'Vocal Track'} selected — Paste and drag/drop will target this track.`);
  }
  function setVoxInspectorCollapsed(on){
    const box=document.querySelector('.vox-inspector');if(!box)return;
    const collapsed=!!on;box.classList.toggle('is-collapsed',collapsed);box.setAttribute('aria-expanded',String(!collapsed));
    const btn=$('voxInspectorToggleBtn');if(btn){btn.textContent=collapsed?'Show':'Hide';btn.setAttribute('aria-expanded',String(!collapsed));btn.title=collapsed?'Show Track Effects':'Hide Track Effects';}
  }
  function toggleVoxInspector(){
    const box=document.querySelector('.vox-inspector');if(!box)return;const next=!box.classList.contains('is-collapsed');voxInspectorManualOverride=next;try{localStorage.setItem(VOX_INSPECTOR_COLLAPSED_KEY,next?'1':'0')}catch{}setVoxInspectorCollapsed(next);
  }
  function renderVoxInspector(){
    const inst=voxInstrumentSelectionList()[0]||null,instList=voxInstrumentSelectionList();
    const ids=['voxFxVolume','voxFxEq','voxFxComp','voxFxReverb','voxFxDelay','voxFxAutotune','voxFxTarget','voxResetEventFxBtn'];
    const instrumentEditing=!!(inst||voxInstrumentTrackFocus);
    setVoxInspectorCollapsed(voxInspectorManualOverride===null?instrumentEditing:voxInspectorManualOverride);
    if(instrumentEditing){
      const focusName=inst?instrumentalSelectionDescription():(voxInstrumentTrackFocus?.name||'Instrument track'),rangeReady=!!voxRangeResolved();
      if($('voxInspectorTitle'))$('voxInspectorTitle').textContent=inst?'Instrument Event':'Instrument Track';
      if($('voxInspectorMeta'))$('voxInspectorMeta').textContent=`${focusName} • Vocal Effects collapsed while editing instruments. Select a vocal track or clip to reopen them.`;
      ids.forEach(id=>{if($(id))$(id).disabled=true;});
      if($('voxCropBtn'))$('voxCropBtn').disabled=false;
      if($('voxSplitBtn'))$('voxSplitBtn').disabled=!instList.some(x=>x.kind==='drum');
      for(const id of ['voxCopyBtn','voxCutBtn','voxDeleteBtn'])if($(id))$(id).disabled=!(inst||rangeReady);
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
    const rangeReady=!!voxRangeResolved();
    if($('voxCropBtn'))$('voxCropBtn').disabled=false;
    if($('voxSplitBtn'))$('voxSplitBtn').disabled=!pairs.length;
    for(const id of ['voxCopyBtn','voxCutBtn','voxDeleteBtn'])if($(id))$(id).disabled=!(pairs.length||rangeReady);
    if($('voxPasteBtn'))$('voxPasteBtn').disabled=!voxClipboard;updateVoxHistoryButtons();
  }

  function applyVoxTrackMixChange(){
    persistVoxEdits();
    liveEditRefresh();
    renderParts();
    renderVoxBox();
  }
  function toggleVoxPartMuteSolo(part,kind){
    if(!part)return;
    voxCheckpoint();
    if(kind==='mute'){part.muted=!part.muted;if(part.muted)part.solo=false;}
    else{part.solo=!part.solo;if(part.solo)part.muted=false;}
    applyVoxTrackMixChange();
    voxStatus(`${part.name} ${kind==='mute'?(part.muted?'muted':'unmuted'):(part.solo?'soloed':'solo off')}.`);
  }
  function toggleVoxDrumMuteSolo(kind){
    const b=window.CRPBeatMaker?.getBeat?.();if(!b)return;
    voxCheckpoint();
    if(kind==='mute'){b.muted=!b.muted;if(b.muted)b.solo=false;}
    else{b.solo=!b.solo;if(b.solo)b.muted=false;}
    window.CRPBeatMaker.setBeat(b,{persist:true});
    liveEditRefresh();
    renderVoxBox();
    voxStatus(`Drums ${kind==='mute'?(b.muted?'muted':'unmuted'):(b.solo?'soloed':'solo off')}.`);
  }
  function appendVoxMuteSolo(host,{part=null,drums=false}={}){
    if(!host)return;
    const state=drums?(window.CRPBeatMaker?.getBeat?.()||{}):(part||{});
    const row=document.createElement('div');row.className='vox-track-ms';
    const m=document.createElement('button'),s=document.createElement('button');
    m.type=s.type='button';m.textContent='M';s.textContent='S';m.title='Mute track';s.title='Solo track';
    m.setAttribute('aria-pressed',String(state.muted===true));s.setAttribute('aria-pressed',String(state.solo===true));
    m.classList.toggle('is-on',state.muted===true);s.classList.toggle('is-on',state.solo===true);
    const stop=e=>{e.preventDefault();e.stopPropagation();};
    m.onpointerdown=stop;s.onpointerdown=stop;
    m.onclick=e=>{stop(e);drums?toggleVoxDrumMuteSolo('mute'):toggleVoxPartMuteSolo(part,'mute');};
    s.onclick=e=>{stop(e);drums?toggleVoxDrumMuteSolo('solo'):toggleVoxPartMuteSolo(part,'solo');};
    row.append(m,s);host.append(row);
  }

  // v3.3.65 — Track Master track-title volume controls are the same mix values
  // used by CRP/Baby DAW.  There is no second Track Master volume state.
  function clampTrackVolumePct(value){return Math.max(0,Math.min(100,Math.round(Number(value)||0)));}
  function paintVoxTrackVolume(input,pct){
    if(!input)return;const n=clampTrackVolumePct(pct);input.value=String(n);input.style.setProperty('--vox-track-volume-fill',`${n}%`);input.title=`Volume ${n}%`;input.setAttribute('aria-valuetext',`${n}%`);const out=input.parentElement?.querySelector('.vox-track-volume-value');if(out)out.textContent=`${n}%`;
  }
  function syncPartVolumeControls(part,pct){
    if(!part)return;const n=clampTrackVolumePct(pct);updatePartMiniVolume(part);
    // Keep any visible Track Master title slider on this exact part in lockstep
    // when volume is changed from Baby DAW or Track Effects instead.
    for(const input of document.querySelectorAll?.('.vox-track-volume-input[data-part-id]')||[]){if(String(input.dataset.partId)===String(part.id))paintVoxTrackVolume(input,n);}
    if(part.type==='vocal'){const lab=document.querySelector?.(`.vox-track-label[data-vox-part-id="${String(part.id).replace(/"/g,'\"')}"][data-vox-part-type="vocal"]`),meta=lab?.querySelector?.('.vox-track-meta');if(meta)meta.textContent=`${n}% • ${(part.voxEvents||[]).length} event${(part.voxEvents||[]).length===1?'':'s'}`;}
    const cur=active();
    if(cur&&String(cur.id)===String(part.id)){
      const main=$('activePartVolume');if(main){main.value=String(n);main.style.setProperty('--range-fill',`${n}%`);}if($('activePartVolumeValue'))$('activePartVolumeValue').textContent=`${n}%`;
      if(part.type==='lead'&&$('leadVolume')){$('leadVolume').value=String(n);if($('leadVolumeValue'))$('leadVolumeValue').textContent=`${n}%`;}
      if(part.type==='vocal'&&$('vocalVolume')){$('vocalVolume').value=String(n);if($('vocalVolumeValue'))$('vocalVolumeValue').textContent=`${n}%`;}
    }
    // Track Effects > Volume is the vocal track volume when Apply to = Track.
    if(part.type==='vocal'&&String(voxTargetPartId||'')===String(part.id)&&$('voxFxTarget')?.value==='track'){if($('voxFxVolume'))$('voxFxVolume').value=String(n);if($('voxFxVolumeValue'))$('voxFxVolumeValue').textContent=`${n}%`;}
  }
  function setVoxPartTrackVolume(part,pct){
    if(!part)return;const n=clampTrackVolumePct(pct);part.volume=n/100;syncPartVolumeControls(part,n);markPartsDirty();liveEditRefresh();core.scheduleAutoSave();
  }
  function setVoxDrumTrackVolume(pct,{commit=false}={}){
    const n=clampTrackVolumePct(pct),gain=n/100,b=window.CRPBeatMaker?.getBeat?.();if(!b)return;
    b.gain=gain;
    // Drums are one mixer track even when the Track Master timeline has several
    // drum regions. Keep every region on the same master gain.
    for(const ev of drumEvents){if(ev?.pattern)ev.pattern.gain=gain;}
    window.CRPBeatMaker?.setBeat?.(b,{persist:!!commit});
    markPartsDirty();liveEditRefresh();core.scheduleAutoSave();if(commit)core.flushAutoSaveNow?.();
  }
  function appendVoxTrackVolume(host,{part=null,drums=false}={}){
    if(!host||(!part&&!drums))return;host.classList.add('has-track-volume');
    const wrap=document.createElement('div');wrap.className='vox-track-volume';
    const input=document.createElement('input');input.type='range';input.min='0';input.max='100';input.step='1';input.className='vox-track-volume-input';
    if(part)input.dataset.partId=String(part.id);if(drums)input.dataset.drumTrack='1';
    input.setAttribute('aria-label',`${drums?'Drums':(part?.name||'Track')} volume`);
    const out=document.createElement('span');out.className='vox-track-volume-value';wrap.append(input,out);host.append(wrap);
    const pct=drums?Math.round((Number(window.CRPBeatMaker?.getBeat?.()?.gain)||0)*100):Math.round((Number(part?.volume)||0)*100);paintVoxTrackVolume(input,pct);
    const stop=e=>e.stopPropagation();input.onclick=stop;input.ondblclick=stop;input.onpointerdown=e=>{e.stopPropagation();voxCheckpoint();};
    input.oninput=e=>{e.stopPropagation();const n=clampTrackVolumePct(e.target.value);paintVoxTrackVolume(input,n);if(drums)setVoxDrumTrackVolume(n,{commit:false});else setVoxPartTrackVolume(part,n);};
    input.onchange=e=>{e.stopPropagation();const n=clampTrackVolumePct(e.target.value);if(drums)setVoxDrumTrackVolume(n,{commit:true});else core.flushAutoSaveNow?.();};
  }

  function makeVoxTrackLabel({name,meta,checked=null,onChecked=null,kind='vocal',part=null}){
    const label=document.createElement('div');label.className='vox-track-label'+(kind!=='vocal'?' vox-instrument-label':'');
    if(checked!==null){const top=document.createElement('label');top.className='vox-track-enable';const c=document.createElement('input');c.type='checkbox';c.checked=!!checked;c.onpointerdown=e=>e.stopPropagation();c.onchange=e=>{e.stopPropagation();onChecked?.(c.checked);};const strong=document.createElement('strong');strong.textContent=name;top.append(c,strong);label.append(top);}else{const strong=document.createElement('strong');strong.textContent=name;label.append(strong);}
    const span=document.createElement('span');span.className='vox-track-meta';span.textContent=meta||'';label.append(span);
    if(part){
      label.dataset.voxPartId=String(part.id);label.dataset.voxPartType=String(part.type);
      appendVoxTrackVolume(label,{part});
      const menu=document.createElement('button');menu.type='button';menu.className='vox-track-menu-btn';menu.textContent='⋮';menu.title='Track actions';menu.setAttribute('aria-label',`${name} track actions`);
      menu.onclick=e=>{e.preventDefault();e.stopPropagation();const r=menu.getBoundingClientRect();openVoxTrackContextMenu(part,label,r.right,r.bottom);};label.append(menu);
      appendVoxMuteSolo(label,{part});
    }
    return label;
  }
  function leadEventStartBeat(part,event){const stepBeats=4/Math.max(8,Number(part?.resolution)||16),exact=Number(event?.voxStartBeat);return Number.isFinite(exact)&&exact>=0?exact:(Number(event?.step)||0)*stepBeats;}
  function leadEventDurationBeats(part,event){const stepBeats=4/Math.max(8,Number(part?.resolution)||16),exact=Number(event?.voxDurationBeats);return Number.isFinite(exact)&&exact>0?exact:Math.max(stepBeats,leadDurationSteps(event)*stepBeats);}
  function chordEventDurationBeats(part,card){
    // Track Master can use unsnapped/free durations, so preserve an exact
    // voxDurationBeats when it agrees with durationBeats. A disagreement is the
    // legacy CRP MIDI bug: the visible/drawn duration changed while the timeline
    // copy stayed stale. In that case the drawn value wins and load normalization
    // brings the two fields back together.
    const drawn=Number(card?.durationBeats),exact=Number(card?.voxDurationBeats);
    if(Number.isFinite(drawn)&&drawn>0&&Number.isFinite(exact)&&exact>0)return Math.abs(drawn-exact)<=1e-9?exact:drawn;
    if(Number.isFinite(exact)&&exact>0)return exact;
    return Number.isFinite(drawn)&&drawn>0?(core.cardDurationBeats?.(card,part?.data?.beats||core.beats)||drawn):(core.beats||4);
  }
  function chordFlatItems(part){
    dedupeChordRows(part?.data);
    const out=[];let cursor=0,flatIndex=0;for(let ri=0;ri<(part.data?.rows||[]).length;ri++){const row=part.data.rows[ri]||[];for(let ci=0;ci<row.length;ci++){const card=row[ci],dur=chordEventDurationBeats(part,card),raw=Number(card?.voxStartBeat),startBeat=Number.isFinite(raw)&&raw>=0?raw:cursor;out.push({card,rowIndex:ri,cardIndex:ci,flatIndex,startBeat,dur});cursor=Math.max(cursor,startBeat+dur);flatIndex++;}}return out;
  }
  function removeChordCardFromPart(part,card){
    if(!part?.data?.rows)return false;const id=String(card?.voxId||'');
    for(const row of part.data.rows){let i=row.indexOf(card);if(i<0&&id)i=row.findIndex(c=>String(c?.voxId||'')===id);if(i>=0){row.splice(i,1);return true;}}
    return false;
  }
  function insertChordCardIntoPart(part,card,targetBeat){
    if(!part||!card)return null;part.data=part.data||core.snapshot();if(!Array.isArray(part.data.rows)||!part.data.rows.length)part.data.rows=[[]];
    const beat=Math.max(0,Math.round((Number(targetBeat)||0)*1000)/1000);card.voxStartBeat=beat;card.voxDurationBeats=Math.max(.03,Number(card.voxDurationBeats)||Number(card.durationBeats)||core.cardDurationBeats?.(card,part.data?.beats||core.beats)||core.beats);card.durationBeats=card.voxDurationBeats;
    const items=chordFlatItems(part);let idx=items.length;for(let i=0;i<items.length;i++){if(beat<items[i].startBeat){idx=i;break;}}
    let remaining=idx,done=false;for(const row of part.data.rows){if(remaining<=row.length){row.splice(remaining,0,card);done=true;break;}remaining-=row.length;}if(!done)part.data.rows.at(-1).push(card);return card;
  }
  function instrumentPartsForKind(kind){return parts.filter(p=>p.type===(kind==='chord'?'chord':'lead'));}
  function focusedInstrumentPart(kind){
    const key=String(voxInstrumentTrackFocus?.key||'');if(!key.startsWith('part:'))return null;const id=key.slice(5),p=parts.find(x=>String(x.id)===id);
    return p&&p.type===(kind==='chord'?'chord':'lead')?p:null;
  }
  function focusedMelodicInstrumentPart(){
    const key=String(voxInstrumentTrackFocus?.key||'');if(!key.startsWith('part:'))return null;const id=key.slice(5),p=parts.find(x=>String(x.id)===id);
    return p&&['chord','lead'].includes(p.type)?p:null;
  }
  function serializeInstrumentClipboardItems(list,anchor){
    const baseByKind={};
    for(const kind of ['chord','lead']){const tracks=instrumentPartsForKind(kind),indexes=list.filter(s=>s.kind===kind).map(s=>tracks.indexOf(s.part)).filter(i=>i>=0);baseByKind[kind]=indexes.length?Math.min(...indexes):0;}
    return list.map(s=>{if(s.kind==='drum')return {kind:'drum',deltaBeat:(Number(s.startBeat)||0)-anchor,event:clone(s.event)};const tracks=instrumentPartsForKind(s.kind),idx=Math.max(0,tracks.indexOf(s.part));return {kind:s.kind,deltaBeat:(Number(s.startBeat)||0)-anchor,sourcePartId:s.part?.id||null,trackOffset:idx-(baseByKind[s.kind]||0),event:s.event?clone(s.event):null,card:s.card?clone(s.card):null};});
  }
  function destinationInstrumentPartForClip(clip){
    const kind=clip?.kind;if(!['chord','lead'].includes(kind))return null;const tracks=instrumentPartsForKind(kind),focus=focusedInstrumentPart(kind),focusAny=focusedMelodicInstrumentPart(),source=parts.find(x=>x.type===(kind==='chord'?'chord':'lead')&&String(x.id)===String(clip?.sourcePartId))||null;
    // v3.3.47 — only a row the user explicitly tapped is a destination override.
    // Event selection itself no longer changes the destination, so copying several clips
    // cannot silently redirect Paste back to the source row.
    const explicit=voxInstrumentTrackFocus?.explicitTarget===true;
    if(explicit&&focusAny&&focusAny.type!==(kind==='chord'?'chord':'lead'))return focusAny;
    if(explicit&&focus&&tracks.length){const base=tracks.indexOf(focus),offset=Number(clip.trackOffset)||0;return tracks[Math.max(0,Math.min(tracks.length-1,base+offset))]||focus;}
    return source||tracks[0]||focusAny||null;
  }
  function reorderChordCardToBeat(part,card,targetBeat){
    const rows=part.data?.rows||[];const lengths=rows.map(r=>r.length),flat=rows.flat();const old=flat.indexOf(card);if(old<0||flat.length<2)return;
    flat.splice(old,1);let beat=0,idx=flat.length;for(let i=0;i<flat.length;i++){const dur=core.cardDurationBeats?.(flat[i],core.beats)||core.beats;if(targetBeat<beat+dur/2){idx=i;break;}beat+=dur;}flat.splice(idx,0,card);let pos=0;part.data.rows=lengths.map(len=>{const r=flat.slice(pos,pos+len);pos+=len;return r;});
  }
  function addBlankDrumEventAt(beat){
    drumArrangementInitialized=true;voxCheckpoint();const start=Math.max(0,quantizeVoxBeat(beat)),event=normalizeDrumEvent({id:uid(),startBeat:start,durationBeats:4,patternOffsetBeats:0,pattern:blankDrumPattern()});drumEvents.push(event);drumEvents.sort((a,b)=>a.startBeat-b.startBeat);const sel={kind:'drum',key:`drum:${event.id}`,event,startBeat:event.startBeat,dur:event.durationBeats,name:'Drums'};voxInstrumentSelections=[sel];voxInstrumentSelection=sel;voxInstrumentTrackFocus={kind:'drum',name:'Drums',key:'drum-map',explicitTarget:true};persistVoxEdits();renderVoxBox();voxStatus(`Empty 4-beat drum region added at beat ${start.toFixed(2)}. Double-tap the region to edit its pattern.`);
  }
  function openDrumEventEditor(sel){
    const live=resolveVoxInstrumentSelection(sel);if(!live?.event||!window.CRPBeatMaker?.editBeatEvent)return;setVoxInstrumentSelection(live);window.CRPBeatMaker.editBeatEvent(live.event.pattern,{onCommit:pattern=>{const ev=drumEvents.find(x=>String(x.id)===String(live.event.id));if(!ev)return;ev.pattern=clone(pattern);markPartsDirty();core.scheduleAutoSave();},onClose:()=>{persistVoxEdits();renderVoxBox();voxStatus('Drum region pattern updated.');}});
  }
  function wireDrumLaneDoubleAdd(lane,clickBeat){
    if(!lane)return;
    const pseudo={id:'drum-map'};
    const commit=(e,beat)=>{
      if(recentVoxLaneAdd(pseudo,e))return false;
      voxLaneAddGuard={partId:'drum-map',at:performance.now(),x:Number(e?.clientX)||0,y:Number(e?.clientY)||0};
      addBlankDrumEventAt(beat);return true;
    };
    // Desktop: detect the second pointer-down ourselves. Timeline pointer handling can
    // capture empty space, which can prevent Chrome from delivering a
    // native dblclick to the lane. Handling click #2 before that capture makes the
    // 4-beat add reliable in both Cursor and Playhead modes.
    let lastMouseDown=0,lastMouseX=0,lastMouseY=0;
    lane.addEventListener('pointerdown',e=>{
      if(voxRangeMode)return;
      if(e.target!==lane||e.button!==0||!['mouse','pen'].includes(e.pointerType||'mouse'))return;
      const now=performance.now(),near=Math.hypot(e.clientX-lastMouseX,e.clientY-lastMouseY)<18;
      if(lastMouseDown&&now-lastMouseDown<460&&near){
        const beat=clickBeat(e,lane);lastMouseDown=0;
        e.preventDefault();e.stopImmediatePropagation();
        commit(e,beat);
      }else{lastMouseDown=now;lastMouseX=e.clientX;lastMouseY=e.clientY;}
    },true);
    // Keep native dblclick as a fallback (for accessibility/mouse implementations
    // that do not expose PointerEvent.pointerType). The shared guard prevents a
    // second region if both paths fire.
    lane.ondblclick=e=>{if(voxRangeMode||e.target!==lane)return;e.preventDefault();e.stopPropagation();commit(e,clickBeat(e,lane));};
    let lastTouch=0,lastX=0,lastY=0;
    lane.addEventListener('pointerup',e=>{if(voxRangeMode||e.pointerType!=='touch'||e.target!==lane)return;const now=performance.now(),near=Math.hypot(e.clientX-lastX,e.clientY-lastY)<28;if(now-lastTouch<360&&near){e.preventDefault();e.stopPropagation();lastTouch=0;commit(e,clickBeat(e,lane));}else{lastTouch=now;lastX=e.clientX;lastY=e.clientY;}},{passive:false});
  }
  function renderVoxDrumMap(tracks,width,ppb,clickBeat){
    if(!voxShowInstrumentals)return;ensureLegacyDrumEvent();const master=window.CRPBeatMaker?.getBeat?.()||blankDrumPattern();
    const row=document.createElement('div');row.className='vox-track-row vox-instrument-track vox-drum-region-row';row.style.width=`${width}px`;row.dataset.voxTrackKey='drum-map';row.dataset.voxKind='drum';row.classList.toggle('is-instrument-focus',voxInstrumentTrackFocus?.key==='drum-map');
    const label=makeVoxTrackLabel({name:'Drums',meta:`${drumEvents.length} region${drumEvents.length===1?'':'s'}`,checked:master.enabled!==false,onChecked:on=>{voxCheckpoint();const b=window.CRPBeatMaker?.getBeat?.();if(!b)return;b.enabled=on;window.CRPBeatMaker.setBeat(b,{persist:true});persistVoxEdits();renderVoxBox();},kind:'drum'});label.title='Double-click (desktop) or double-tap (touch) empty drum-lane space to add a 4-beat region.';label.onclick=e=>{if(e.target.closest('input,label,button'))return;focusVoxInstrumentTrack('drum','Drums','drum-map',{announce:true});};appendVoxTrackVolume(label,{drums:true});appendVoxMuteSolo(label,{drums:true});
    const drumRange={kind:'drum',trackKey:'drum-map',name:'Drums'};
    const lane=document.createElement('div');lane.className='vox-track-lane vox-instrument-lane vox-drum-region-lane';lane.dataset.voxKind='drum';lane.onpointerdown=e=>{if(voxRangeMode&&e.target===lane)beginVoxRangePointer(e,drumRange,lane);};lane.onclick=e=>{if(e.target!==lane)return;if(voxRangeMode){e.preventDefault();e.stopPropagation();return;}if(recentVoxLaneAdd({id:'drum-map'},e)){e.preventDefault();e.stopPropagation();return;}focusVoxInstrumentTrack('drum','Drums','drum-map',{announce:true});/* Empty drum-lane creation is double-click/double-tap only. The ruler owns seeking. */};wireDrumLaneDoubleAdd(lane,clickBeat);
    for(const event of drumEvents){const key=`drum:${event.id}`,sel={kind:'drum',key,event,startBeat:event.startBeat,dur:event.durationBeats,name:'Drums'},ev=document.createElement('div');ev.className='vox-instrument-event vox-drum-event'+(voxInstrumentIsSelected(key)?' is-selected':'');ev.dataset.voxKey=key;ev.style.left=`${event.startBeat*ppb}px`;ev.style.width=`${Math.max(34,event.durationBeats*ppb)}px`;const hits=drumPatternHitCount(event.pattern),bars=Math.max(1,Number(event.pattern?.bars)||1);ev.innerHTML=`<strong>Drums</strong><span>${event.durationBeats.toFixed(2)}b • ${bars}-bar pattern • ${hits} hits</span>`;ev.title='Drag to move • drag either edge to resize • Split • double-tap to edit pattern';ev.__voxSelection=sel;ev.onclick=e=>{if(voxRangeMode){e.preventDefault();e.stopPropagation();return;}instrumentClickSelection(sel,ev,e);};ev.ondblclick=e=>{if(voxRangeMode)return;e.preventDefault();e.stopPropagation();openDrumEventEditor(sel);};ev.onpointerdown=e=>{if(voxRangeMode){beginVoxRangePointer(e,drumRange,lane);return;}if(e.target.classList.contains('vox-inst-handle'))return;beginVoxInstrumentPointerEdit(e,sel,ev,'move');};appendInstrumentHandles(ev,sel);lane.appendChild(ev);}
    updateVoxRangeOverlay(drumRange,lane);row.append(label,lane);tracks.appendChild(row);
  }

  function instrumentClickSelection(sel,evEl,e){
    e.stopPropagation();
    if(evEl.__voxDragged){evEl.__voxDragged=false;return;}
    if((evEl.__voxSuppressClickUntil||0)>performance.now())return;
    if(evEl.__voxPointerSelected){
      evEl.__voxPointerSelected=false;renderVoxSelectionClasses();renderVoxInspector();return;
    }
    const live=resolveVoxInstrumentSelection(sel)||sel,multi=voxToolMode==='multi',add=multi||e.ctrlKey||e.metaKey||e.shiftKey;setVoxInstrumentSelection(live,{add,toggle:add});
  }

  function voxNoteFromText(raw,defaultOct=4){
    const m=String(raw||'').trim().replace(/♭/g,'b').replace(/♯/g,'#').match(/^([A-Ga-g])([#b]?)(-?\d+)?$/);if(!m)return null;
    const naturals={C:0,D:2,E:4,F:5,G:7,A:9,B:11},base=naturals[m[1].toUpperCase()]+(m[2]==='#'?1:m[2]==='b'?-1:0),pc=(base+120)%12,oct=m[3]!==undefined?Number(m[3]):Number(defaultOct),midi=Math.max(0,Math.min(127,(oct+1)*12+pc));return {root:NOTE_NAMES[pc],octave:oct,midi,label:`${NOTE_NAMES[pc]}${oct}`};
  }
  function defaultChordNoteOctave(part,card){
    const own=Array.isArray(card?.midiNotes)&&Number.isFinite(Number(card.midiNotes[0]))?Math.floor(Number(card.midiNotes[0])/12)-1:null;if(own!=null)return own;
    for(const c of (part?.data?.rows||[]).flat()){if(c===card||c?.type!=='note')continue;const m=Array.isArray(c.midiNotes)?Number(c.midiNotes[0]):NaN;if(Number.isFinite(m))return Math.floor(m/12)-1;}
    return 4+(Number(part?.data?.octave)||0);
  }
  async function auditionVoxInstrument(sel){
    try{
      if(sel?.kind==='lead'&&sel.part&&sel.event){await auditionLeadNote(sel.part,sel.event.midi);return;}
      if(sel?.kind==='chord'&&sel.part&&sel.card){const player=await playerFor(sel.part);busFor(sel.part);const notes=core.notesFor(sel.card,sel.part.data)||[],at=(audioCtx?.currentTime||0)+.01,dur=Math.max(.28,Math.min(1.6,chordEventDurationBeats(sel.part,sel.card)*(60/Math.max(40,Math.min(240,Number(core.bpm)||92)))*.8));for(const [i,n] of notes.entries())playTracked(player,n,at+(sel.part.data?.instrument==='guitar'?i*.025:0),{duration:dur,gain:.88});}
    }catch(err){console.warn('Vox Box audition failed',err);}
  }
  function beginVoxInlineEventEdit(sel,el){
    sel=resolveVoxInstrumentSelection(sel)||sel;
    if(!sel||!el||sel.kind==='drum')return;
    // Finish any other inline editor first, but never rebuild this event simply
    // because the phone keyboard changed viewport height.
    const prior=document.querySelector('.vox-inline-event-input');if(prior&&prior!==el.querySelector('.vox-inline-event-input'))prior.blur();
    el.querySelector('.vox-inline-event-input')?.remove();const input=document.createElement('input');input.className='vox-inline-event-input';input.type='text';input.autocomplete='off';input.autocapitalize='off';input.enterKeyHint='done';input.spellcheck=false;const noteCard=sel.kind==='chord'&&sel.card?.type==='note',blank=sel.kind==='lead'?sel.event?.voxBlank===true:sel.card?.voxBlank===true;input.value=blank?'':(sel.kind==='lead'?midiName(sel.event.midi):(noteCard&&Number.isFinite(Number(sel.card?.midiNotes?.[0]))?midiName(Number(sel.card.midiNotes[0])):String(sel.card?.value||'')));input.placeholder=sel.kind==='lead'||noteCard?'Type note (ex. F#4)':'Type chord (ex. Bm7)';el.appendChild(input);
    requestAnimationFrame(()=>{if(!input.isConnected)return;try{input.focus({preventScroll:true});}catch{input.focus();}try{input.setSelectionRange(0,input.value.length);}catch{}});
    let finished=false;const finish=async(commit=true)=>{if(finished)return;finished=true;const txt=input.value.trim();input.remove();if(!commit||!txt){renderVoxBox();return;}
      // Re-resolve by stable voxId at commit time. Autosave / history / other UI work
      // must never leave the editor mutating a detached card object.
      const live=resolveVoxInstrumentSelection(sel)||sel;voxCheckpoint();
      if(live.kind==='lead'){
        const oldOct=Math.floor((Number(live.event.midi)||60)/12)-1,n=voxNoteFromText(txt,oldOct);if(!n){voxUndoStack.pop();updateVoxHistoryButtons();voxStatus('Type a note such as F#, D5, or Bb3.');renderVoxBox();return;}
        live.event.midi=n.midi;delete live.event.voxBlank;
      }else if(live.kind==='chord'){
        const noteMode=live.card?.type==='note';
        if(noteMode){const n=voxNoteFromText(txt,defaultChordNoteOctave(live.part,live.card));if(!n){voxUndoStack.pop();updateVoxHistoryButtons();voxStatus('Type a note such as C#, A4, or Bb3.');renderVoxBox();return;}live.card.type='note';live.card.value=n.root;live.card.midiNotes=[n.midi];delete live.card.voxBlank;}
        else{const probe={...live.card,type:'chord',value:txt};if(!(core.notesFor(probe,live.part.data)||[]).length){voxUndoStack.pop();updateVoxHistoryButtons();voxStatus('That chord name was not recognized. Try D, Bm, F#m7, Cmaj7, etc.');renderVoxBox();return;}live.card.type='chord';live.card.value=txt;delete live.card.midiNotes;delete live.card.voxBlank;}
        // Keep the event an explicit timeline block after the first text commit.
        if(!Number.isFinite(Number(live.card.voxStartBeat)))live.card.voxStartBeat=Math.max(0,Number(live.startBeat)||0);
        if(!Number.isFinite(Number(live.card.voxDurationBeats))||Number(live.card.voxDurationBeats)<=0)live.card.voxDurationBeats=Math.max(.03,Number(live.dur)||1);
        live.card.durationBeats=live.card.voxDurationBeats;
        if(String(live.part.id)===String(loadedChordPartId))core.apply(live.part.data);
      }
      const committed=resolveVoxInstrumentSelection(live)||live;voxInstrumentSelections=[committed];voxInstrumentSelection=committed;persistVoxEdits();renderParts();renderVoxBox();await auditionVoxInstrument(committed);voxStatus(`${txt} updated and auditioned.`);};
    input.onkeydown=e=>{e.stopPropagation();if(e.key==='Enter'){e.preventDefault();input.blur();}else if(e.key==='Escape'){e.preventDefault();finished=true;input.remove();renderVoxBox();}};
    input.onblur=()=>finish(true);input.onclick=e=>e.stopPropagation();input.onpointerdown=e=>e.stopPropagation();input.ondblclick=e=>e.stopPropagation();
  }
  function renderVoxHarmonyGuide(){
    const cb=$('voxChordsUsed'),nb=$('voxNotesFit');if(!cb||!nb)return;const focusId=String(voxInstrumentTrackFocus?.key||'').startsWith('part:')?String(voxInstrumentTrackFocus.key).slice(5):'',part=parts.find(p=>p.type==='chord'&&String(p.id)===focusId)||loadedChord()||parts.find(p=>p.type==='chord');if(!part){cb.textContent='—';nb.textContent='—';return;}
    const barStart=Math.floor(Math.max(0,voxPlayheadBeat)/4)*4,barEnd=barStart+4,items=chordFlatItems(part).filter(x=>x.startBeat<barEnd&&x.startBeat+x.dur>barStart),cards=items.map(x=>x.card),chords=[];for(const c of cards.filter(c=>c?.type==='chord')){const lab=harmonyDisplayCard(c,part.data);if(lab&&!chords.includes(lab))chords.push(lab);}const tone=[],roots=[];for(const c of cards.filter(c=>c?.type==='chord')){const root=harmonyPitchClass(harmonyDisplayCard(c,part.data));if(root!=null&&!roots.includes(root))roots.push(root);for(const n of core.notesFor(c,part.data)||[]){const pc=harmonyPitchClass(n);if(pc!=null&&!tone.includes(pc))tone.push(pc);}}
    const allCards=(part.data?.rows||[]).flat().filter(Boolean),key=harmonyKey(part.data,allCards);let pcs=[];if(key){const ints=key.minor?[0,2,3,5,7,8,10]:[0,2,4,5,7,9,11];pcs=ints.map(i=>(key.rootIndex+i)%12);for(const pc of tone)if(!pcs.includes(pc))pcs.push(pc);}else pcs=[...tone];
    cb.innerHTML='';nb.innerHTML='';if(!chords.length)cb.textContent='—';else for(const x of chords){const chip=document.createElement('span');chip.className='vox-harmony-chip chord';chip.textContent=x;cb.appendChild(chip);}if(!pcs.length)nb.textContent='—';else for(const pc of pcs){const chip=document.createElement('span');chip.className='vox-harmony-chip note'+(tone.includes(pc)?' chord-tone':'')+(roots.includes(pc)?' root-tone':'');chip.textContent=NOTE_NAMES[pc];nb.appendChild(chip);}
  }
  function closeVoxTrackContextMenu(){document.getElementById('voxTrackContextMenu')?.remove();}
  function deleteVoxTrack(part){
    if(!part)return;closeVoxTrackContextMenu();if(!confirm(`Delete “${part.name}”?`))return;
    voxCheckpoint();const deletedId=String(part.id),deletedType=String(part.type||''),wasLoaded=deletedId===String(loadedChordPartId),wasActive=deletedId===String(activePartId);
    parts=parts.filter(p=>String(p.id)!==deletedId);
    // Remove stale backing references to the deleted Baby DAW part as well.
    for(const p of parts.filter(p=>p.type==='vocal'))p.backingPartIds=(p.backingPartIds||[]).filter(id=>String(id)!==deletedId);
    if(!parts.length){const first=chordPart('Chords 1');parts=[first];loadedChordPartId=first.id;activePartId=first.id;}
    if(wasLoaded){const c=parts.find(p=>p.type==='chord');if(c){loadedChordPartId=c.id;core.apply(c.data);}}
    if(wasActive||!parts.some(p=>String(p.id)===String(activePartId))){const next=parts.find(p=>p.type==='chord')||parts[0]||null;activePartId=next?.id||null;}
    const nowActive=active();if(nowActive){if(nowActive.type==='chord'){loadedChordPartId=nowActive.id;core.apply(nowActive.data);}else if(nowActive.type==='lead')renderLeadEditor(nowActive);else if(nowActive.type==='vocal')renderVocalEditor(nowActive);setEditorMode(nowActive.type);}
    else setEditorMode('chord');
    const vocals=allVocalParts();voxTargetPartId=vocals.some(p=>String(p.id)===String(voxTargetPartId))?voxTargetPartId:(vocals[0]?.id||null);
    voxSelections=voxSelections.filter(sel=>String(sel.partId)!==deletedId);voxSelected=voxSelections[0]||null;
    voxInstrumentSelections=voxInstrumentSelections.filter(sel=>String((resolveVoxInstrumentSelection(sel)||sel)?.part?.id||'')!==deletedId);voxInstrumentSelection=voxInstrumentSelections[0]||null;
    if(String(voxInstrumentTrackFocus?.key||'')===`part:${deletedId}`)voxInstrumentTrackFocus=null;
    markPartsDirty();renderParts();renderVoxBox();core.scheduleAutoSave();core.flushAutoSaveNow?.();
    voxStatus(`${deletedType==='vocal'?'Vocal track':'Track'} deleted from Track Master and Baby DAW.`);
  }
  function duplicateVoxTrack(part){if(!part)return;closeVoxTrackContextMenu();voxCheckpoint();let copy;if(part.type==='chord'){copy=normalizePart({...clone(part),id:uid(),name:`${part.name} Copy`},parts.length);}else if(part.type==='lead'){copy=normalizePart({...clone(part),id:uid(),name:`${part.name} Copy`,events:(part.events||[]).map(e=>({...clone(e),voxId:uid()}))},parts.length);}else{copy={...part,id:uid(),name:`${part.name} Copy`,recordings:(part.recordings||[]).map(r=>({...r})),voxEvents:(part.voxEvents||[]).map(e=>({...clone(e),id:uid()}))};copy.voxEvents.forEach(e=>e.sourcePartId=copy.id);}parts.splice(Math.max(0,parts.indexOf(part)+1),0,copy);persistVoxEdits();renderParts();renderVoxBox();voxStatus(`${copy.name} duplicated.`);}
  function ensureVoxTrackDialog(){
    let modal=document.getElementById('voxTrackDialog');if(modal)return modal;modal=document.createElement('div');modal.id='voxTrackDialog';modal.className='vox-track-dialog';modal.hidden=true;modal.innerHTML=`<div class="vox-track-dialog-backdrop"></div><div class="vox-track-dialog-card" role="dialog" aria-modal="true" aria-label="Add track"><h3>Add Track</h3><label>Name<input id="voxNewTrackName" type="text"></label><label>Type<select id="voxNewTrackType"><option value="chord">Chord / Note</option><option value="lead">Lead / Bass</option><option value="vocal">Vocal</option></select></label><label class="vox-new-mode-row">Chord/Note<select id="voxNewTrackMode"><option value="chord">Chord</option><option value="note">Note</option></select></label><label class="vox-new-inst-row">Instrument<select id="voxNewTrackInstrument"><option value="piano">Piano</option><option value="guitar">Guitar</option><option value="misc">Misc</option></select></label><label class="vox-new-inst-row">Sound<select id="voxNewTrackSound"></select></label><div class="vox-track-dialog-actions"><button type="button" data-cancel>Cancel</button><button type="button" data-add class="accent">Add Track</button></div></div>`;document.body.appendChild(modal);modal.querySelector('[data-cancel]').onclick=()=>modal.hidden=true;modal.querySelector('.vox-track-dialog-backdrop').onclick=()=>modal.hidden=true;const type=modal.querySelector('#voxNewTrackType'),inst=modal.querySelector('#voxNewTrackInstrument'),sound=modal.querySelector('#voxNewTrackSound');const fillSounds=()=>{const opts=core.sounds[inst.value]||core.sounds.piano;sound.innerHTML=opts.map(([v,l])=>`<option value="${escapeHtml(v)}">${escapeHtml(l)}</option>`).join('');};const refresh=()=>{const vocal=type.value==='vocal';modal.querySelector('.vox-new-mode-row').hidden=type.value!=='chord';modal.querySelectorAll('.vox-new-inst-row').forEach(x=>x.hidden=vocal);fillSounds();};type.onchange=refresh;inst.onchange=fillSounds;modal._refresh=refresh;modal.querySelector('[data-add]').onclick=()=>{const t=type.value,name=modal.querySelector('#voxNewTrackName').value.trim();voxCheckpoint();let p;if(t==='chord'){const snap=core.snapshot();p=chordPart(name||`Chords ${countType('chord')+1}`,{...snap,rows:[[]],key:normalizeSongKeyValue(snap.key)});p.data.mode=modal.querySelector('#voxNewTrackMode').value;p.data.instrument=inst.value;p.data.sound=sound.value;p.voxSetupEstablished=true;}else if(t==='lead'){p=leadPart(name||`Lead ${countType('lead')+1}`);p.instrument=inst.value;p.sound=sound.value;p.voxSetupEstablished=true;}else p=vocalPart(name||`Vocals ${countType('vocal')+1}`);parts.push(p);modal.hidden=true;persistVoxEdits();renderParts();renderVoxBox();voxStatus(`${p.name} added.`);};refresh();return modal;
  }
  function openVoxAddTrackDialog(type='chord'){closeVoxTrackContextMenu();const modal=ensureVoxTrackDialog();modal.hidden=false;const sel=modal.querySelector('#voxNewTrackType');sel.value=['chord','lead','vocal'].includes(type)?type:'chord';modal.querySelector('#voxNewTrackName').value='';modal._refresh?.();setTimeout(()=>modal.querySelector('#voxNewTrackName').focus(),30);}
  function ensureVoxEditTrackDialog(){
    let modal=document.getElementById('voxEditTrackDialog');if(modal)return modal;
    modal=document.createElement('div');modal.id='voxEditTrackDialog';modal.className='vox-track-dialog';modal.hidden=true;
    modal.innerHTML=`<div class="vox-track-dialog-backdrop"></div><div class="vox-track-dialog-card" role="dialog" aria-modal="true" aria-label="Edit track"><h3>Edit This Track</h3><label class="vox-edit-track-mode-row">Chord/Note<select id="voxEditTrackMode"><option value="chord">Chord</option><option value="note">Note</option></select></label><label>Instrument<select id="voxEditTrackInstrument"><option value="piano">Piano</option><option value="guitar">Guitar</option><option value="misc">Misc</option></select></label><label>Sound<select id="voxEditTrackSound"></select></label><div class="vox-track-dialog-actions"><button type="button" data-cancel>Cancel</button><button type="button" data-save class="accent">Save Changes</button></div></div>`;
    document.body.appendChild(modal);const inst=modal.querySelector('#voxEditTrackInstrument'),sound=modal.querySelector('#voxEditTrackSound');
    const fill=()=>{const opts=core.sounds[inst.value]||core.sounds.piano;sound.innerHTML=opts.map(([v,l])=>`<option value="${escapeHtml(v)}">${escapeHtml(l)}</option>`).join('');};modal._fill=fill;inst.onchange=fill;
    const close=()=>{modal.hidden=true;modal._part=null;};modal.querySelector('[data-cancel]').onclick=close;modal.querySelector('.vox-track-dialog-backdrop').onclick=close;
    modal.querySelector('[data-save]').onclick=()=>{const part=modal._part;if(!part)return;voxCheckpoint();if(part.type==='chord'){part.data=part.data||core.snapshot();part.data.mode=modal.querySelector('#voxEditTrackMode').value==='note'?'note':'chord';part.data.instrument=inst.value;part.data.sound=sound.value;if(String(part.id)===String(loadedChordPartId))core.apply(part.data);}else if(part.type==='lead'){part.instrument=inst.value;part.sound=sound.value;}part.voxSetupEstablished=true;close();persistVoxEdits();renderParts();renderVoxBox();voxStatus(`${part.name} track settings updated.`);};
    return modal;
  }
  function openVoxEditTrackDialog(part){
    closeVoxTrackContextMenu();if(!part||!['chord','lead'].includes(part.type))return;const modal=ensureVoxEditTrackDialog(),mode=modal.querySelector('#voxEditTrackMode'),inst=modal.querySelector('#voxEditTrackInstrument'),sound=modal.querySelector('#voxEditTrackSound');modal._part=part;modal.hidden=false;
    const chord=part.type==='chord';mode.disabled=!chord;mode.value=chord?(part.data?.mode==='note'?'note':'chord'):'note';modal.querySelector('.vox-edit-track-mode-row').classList.toggle('is-note-only',!chord);inst.value=chord?(part.data?.instrument||'piano'):(part.instrument||'piano');modal._fill?.();const wanted=chord?part.data?.sound:part.sound;if(wanted&&[...sound.options].some(o=>o.value===wanted))sound.value=wanted;requestAnimationFrame(()=>inst.focus());
  }
  function openVoxTrackContextMenu(part,label,x,y,{drums=false}={}){closeVoxTrackContextMenu();const menu=document.createElement('div');menu.id='voxTrackContextMenu';menu.className='vox-track-context-menu';const add=(txt,fn,cls='')=>{const b=document.createElement('button');b.type='button';b.textContent=txt;if(cls)b.className=cls;b.onclick=e=>{e.stopPropagation();fn();};menu.appendChild(b);};if(part&&['chord','lead'].includes(part.type))add('Edit This Track',()=>openVoxEditTrackDialog(part));if(part)add('Duplicate Track',()=>duplicateVoxTrack(part));add('Add Chord / Note Track',()=>openVoxAddTrackDialog('chord'));add('Add Lead / Bass Track',()=>openVoxAddTrackDialog('lead'));add('Add Vocal Track',()=>openVoxAddTrackDialog('vocal'));if(part)add('Delete Track',()=>deleteVoxTrack(part),'danger');document.body.appendChild(menu);const r=menu.getBoundingClientRect(),left=Math.max(6,Math.min(window.innerWidth-r.width-6,Number(x)||label.getBoundingClientRect().right)),top=Math.max(6,Math.min(window.innerHeight-r.height-6,Number(y)||label.getBoundingClientRect().top));menu.style.left=`${left}px`;menu.style.top=`${top}px`;const outside=e=>{if(menu.contains(e.target))return;document.removeEventListener('pointerdown',outside,true);closeVoxTrackContextMenu();};setTimeout(()=>document.addEventListener('pointerdown',outside,true),0);}
  function wireVoxMarquee(){
    const tracks=$('voxTracks'),inner=$('voxTimelineInner');if(!tracks||!inner||tracks.dataset.marqueeWired)return;tracks.dataset.marqueeWired='1';tracks.addEventListener('click',e=>{if((tracks.__voxSuppressClickUntil||0)>performance.now()){e.preventDefault();e.stopImmediatePropagation();}},true);tracks.addEventListener('pointerdown',e=>{if(voxToolMode!=='cursor'||(e.button!==undefined&&e.button!==0)||e.target.closest('.vox-event,.vox-instrument-event,.vox-track-label,.vox-drum-cell,.vox-drum-region-lane,input,button,select'))return;const startX=e.clientX,startY=e.clientY,add=e.ctrlKey||e.metaKey||e.shiftKey;let box=null,moved=false;try{tracks.setPointerCapture(e.pointerId)}catch{};const move=ev=>{const dx=ev.clientX-startX,dy=ev.clientY-startY;if(!moved&&Math.hypot(dx,dy)<4)return;moved=true;ev.preventDefault();if(!box){box=document.createElement('div');box.className='vox-marquee';inner.appendChild(box);}const ir=inner.getBoundingClientRect(),x1=Math.min(startX,ev.clientX)-ir.left,y1=Math.min(startY,ev.clientY)-ir.top,x2=Math.max(startX,ev.clientX)-ir.left,y2=Math.max(startY,ev.clientY)-ir.top;Object.assign(box.style,{left:`${x1}px`,top:`${y1}px`,width:`${x2-x1}px`,height:`${y2-y1}px`});};const up=ev=>{try{tracks.releasePointerCapture(ev.pointerId)}catch{};tracks.removeEventListener('pointermove',move);tracks.removeEventListener('pointerup',up);tracks.removeEventListener('pointercancel',up);if(!moved){if(!add){voxSelections=[];voxSelected=null;voxInstrumentSelections=[];voxInstrumentSelection=null;renderVoxSelectionClasses();renderVoxInspector();}return;}const sr={left:Math.min(startX,ev.clientX),right:Math.max(startX,ev.clientX),top:Math.min(startY,ev.clientY),bottom:Math.max(startY,ev.clientY)};if(!add){voxSelections=[];voxInstrumentSelections=[];}for(const el of tracks.querySelectorAll('.vox-event,.vox-instrument-event')){const r=el.getBoundingClientRect();if(r.right<sr.left||r.left>sr.right||r.bottom<sr.top||r.top>sr.bottom)continue;if(el.classList.contains('vox-event')){const part=parts.find(p=>p.type==='vocal'&&String(p.id)===String(el.dataset.voxPartId)),event=part?.voxEvents?.find(v=>String(v.id)===String(el.dataset.voxEventId));if(part&&event&&!voxSelections.some(s=>String(s.partId)===String(part.id)&&String(s.eventId)===String(event.id)))voxSelections.push({partId:part.id,eventId:event.id});}else if(el.__voxSelection&&!voxInstrumentIsSelected(el.__voxSelection.key))voxInstrumentSelections.push(el.__voxSelection);}voxSelected=voxSelections[0]||null;voxInstrumentSelection=voxInstrumentSelections[0]||null;box?.remove();tracks.__voxSuppressClickUntil=performance.now()+180;renderVoxSelectionClasses();renderVoxInspector();voxStatus(`${voxSelections.length+voxInstrumentSelections.length} event${voxSelections.length+voxInstrumentSelections.length===1?'':'s'} selected.`);};tracks.addEventListener('pointermove',move,{passive:false});tracks.addEventListener('pointerup',up,{passive:false});tracks.addEventListener('pointercancel',up,{passive:false});});
  }

  function appendInstrumentHandles(ev,sel){
    if(!['lead','chord','drum'].includes(sel.kind))return;const lh=document.createElement('span'),rh=document.createElement('span');lh.className='vox-inst-handle left';rh.className='vox-inst-handle right';lh.title='Drag start edge';rh.title='Drag end edge';lh.onpointerdown=e=>{if(voxRangeMode)return;beginVoxInstrumentPointerEdit(e,sel,ev,'trim-left');};rh.onpointerdown=e=>{if(voxRangeMode)return;beginVoxInstrumentPointerEdit(e,sel,ev,'trim-right');};ev.append(lh,rh);
  }
  function voxTrackSetupEstablished(part){
    if(!part)return false;
    if(part.voxSetupEstablished===true)return true;
    if(part.type==='chord')return chordFlatItems(part).length>0;
    if(part.type==='lead')return (part.events||[]).some(e=>!e.voxBlank);
    return true;
  }
  function insertBlankChordAtBeat(part,beat,mode){
    const start=Math.max(0,quantizeVoxBeat(beat)),dur=1,card={voxId:uid(),voxBlank:true,type:mode==='note'?'note':'chord',value:'',durationBeats:dur,voxStartBeat:start,voxDurationBeats:dur};
    if(card.type==='note')card.midiNotes=[];
    if(!Array.isArray(part.data.rows)||!part.data.rows.length)part.data.rows=[[]];
    // Insert once at the chronological destination. The previous row-rebuild path
    // put the final-row remainder into that row and then appended it a second time.
    insertChordCardIntoPart(part,card,start);
    return card;
  }
  function insertBlankLeadAtBeat(part,beat){
    const start=Math.max(0,quantizeVoxBeat(beat)),stepBeats=4/Math.max(8,Number(part.resolution)||16),oct=Number.isFinite(Number(part.gridOctave))?Number(part.gridOctave):3;
    const event={voxId:uid(),voxBlank:true,voxStartBeat:start,voxDurationBeats:1,step:Math.max(0,Math.round(start/stepBeats)),durationSteps:Math.max(1,Math.round(1/stepBeats)),midi:Math.max(0,Math.min(127,(oct+1)*12))};
    part.events=normalizeLeadEvents([...(part.events||[]),event]);
    return part.events.find(e=>String(e.voxId)===String(event.voxId))||event;
  }
  function focusNewBlankEvent(part,item){
    requestAnimationFrame(()=>{
      if(!item)return;
      const key=part.type==='lead'?`lead:${part.id}:${item.voxId}`:`chord:${part.id}:${item.voxId}`;
      const el=document.querySelector(`.vox-instrument-event[data-vox-key="${CSS.escape(key)}"]`);
      if(!el)return;
      const sel=el.__voxSelection;
      if(sel){setVoxInstrumentSelection(sel,{render:false});renderVoxSelectionClasses();beginVoxInlineEventEdit(sel,el);}
    });
  }
  function createBlankVoxInstrumentEvent(part,beat,{mode=null,instrument=null,sound=null}={}){
    if(!part||!['chord','lead'].includes(part.type))return;
    voxCheckpoint();
    if(part.type==='chord'){
      part.data=part.data||core.snapshot();part.data.mode=mode||part.data.mode||'chord';
      if(instrument)part.data.instrument=instrument;if(sound)part.data.sound=sound;
    }else{
      if(instrument)part.instrument=instrument;if(sound)part.sound=sound;
    }
    part.voxSetupEstablished=true;
    const item=part.type==='chord'?insertBlankChordAtBeat(part,beat,part.data.mode):insertBlankLeadAtBeat(part,beat);
    if(part.type==='chord'&&String(part.id)===String(loadedChordPartId))core.apply(part.data);
    persistVoxEdits();renderParts();renderVoxBox();focusNewBlankEvent(part,item);
    voxStatus(`Blank ${part.type==='chord'?(part.data.mode==='note'?'note':'chord'):'note'} added at beat ${(quantizeVoxBeat(beat)+1).toFixed(2)}. Type its value, then press Enter.`);
  }
  function ensureVoxEventSetupDialog(){
    let modal=document.getElementById('voxEventSetupDialog');if(modal)return modal;
    modal=document.createElement('div');modal.id='voxEventSetupDialog';modal.className='vox-track-dialog';modal.hidden=true;
    modal.innerHTML=`<div class="vox-track-dialog-backdrop"></div><div class="vox-track-dialog-card vox-event-setup-card" role="dialog" aria-modal="true" aria-label="Set up track event"><h3>Set Up Track</h3><label>Chord/Note<select id="voxEventMode"><option value="chord">Chord</option><option value="note">Note</option></select></label><label>Instrument<select id="voxEventInstrument"><option value="piano">Piano</option><option value="guitar">Guitar</option><option value="misc">Misc</option></select></label><label>Sound<select id="voxEventSound"></select></label><div class="vox-track-dialog-actions"><button type="button" data-cancel>Cancel</button><button type="button" data-add class="accent">Add Event</button></div></div>`;
    document.body.appendChild(modal);
    const mode=modal.querySelector('#voxEventMode'),inst=modal.querySelector('#voxEventInstrument'),sound=modal.querySelector('#voxEventSound');
    const fillSounds=()=>{const opts=core.sounds[inst.value]||core.sounds.piano;sound.innerHTML=opts.map(([v,l])=>`<option value="${escapeHtml(v)}">${escapeHtml(l)}</option>`).join('');};
    inst.onchange=fillSounds;modal.querySelector('[data-cancel]').onclick=()=>{modal.hidden=true;modal._pending=null;};modal.querySelector('.vox-track-dialog-backdrop').onclick=()=>{modal.hidden=true;modal._pending=null;};
    modal.querySelector('[data-add]').onclick=()=>{const p=modal._pending?.part,atBeat=modal._pending?.beat;if(!p)return;modal.hidden=true;modal._pending=null;createBlankVoxInstrumentEvent(p,atBeat,{mode:mode.value,instrument:inst.value,sound:sound.value});};
    modal._fillSounds=fillSounds;return modal;
  }
  function openVoxEventSetupDialog(part,beat){
    const modal=ensureVoxEventSetupDialog(),mode=modal.querySelector('#voxEventMode'),inst=modal.querySelector('#voxEventInstrument'),sound=modal.querySelector('#voxEventSound');
    modal._pending={part,beat};modal.hidden=false;
    if(part.type==='lead'){mode.innerHTML='<option value="note">Note</option>';mode.value='note';mode.disabled=true;inst.value=part.instrument||'piano';}
    else{mode.innerHTML='<option value="chord">Chord</option><option value="note">Note</option>';mode.disabled=false;mode.value=part.data?.mode==='note'?'note':'chord';inst.value=part.data?.instrument||'piano';}
    modal._fillSounds?.();const wanted=part.type==='lead'?part.sound:part.data?.sound;if(wanted&&[...sound.options].some(o=>o.value===wanted))sound.value=wanted;
    requestAnimationFrame(()=>mode.disabled?inst.focus():mode.focus());
  }
  function addVoxInstrumentEventAt(part,beat){
    if(!voxTrackSetupEstablished(part)){openVoxEventSetupDialog(part,beat);return;}
    createBlankVoxInstrumentEvent(part,beat,{mode:part.type==='chord'?(part.data?.mode||'chord'):'note',instrument:part.type==='chord'?part.data?.instrument:part.instrument,sound:part.type==='chord'?part.data?.sound:part.sound});
  }
  function recentVoxLaneAdd(part,e,windowMs=780){
    const g=voxLaneAddGuard,now=performance.now(),x=Number(e?.clientX)||0,y=Number(e?.clientY)||0;
    return !!(g&&String(g.partId)===String(part?.id||'')&&now-Number(g.at||0)<windowMs&&Math.hypot(x-Number(g.x||0),y-Number(g.y||0))<42);
  }
  function commitVoxLaneDoubleAdd(part,beat,e){
    if(recentVoxLaneAdd(part,e))return false;voxLaneAddGuard={partId:String(part?.id||''),at:performance.now(),x:Number(e?.clientX)||0,y:Number(e?.clientY)||0};addVoxInstrumentEventAt(part,beat);return true;
  }
  function wireVoxLaneDoubleAdd(lane,part,clickBeat){
    if(!lane||!part)return;
    // The guard lives outside the lane DOM node because adding an event rerenders the lane.
    // Android can send the synthesized dblclick/click to that *new* lane; a node-local flag
    // disappears during the rerender and was the source of the phantom second/third blocks.
    lane.ondblclick=e=>{if(voxRangeMode||e.target!==lane)return;e.preventDefault();e.stopPropagation();commitVoxLaneDoubleAdd(part,clickBeat(e,lane),e);};
    let lastTouch=0,lastX=0,lastY=0;
    lane.addEventListener('pointerup',e=>{if(voxRangeMode||e.pointerType!=='touch'||e.target!==lane)return;const now=performance.now(),near=Math.hypot(e.clientX-lastX,e.clientY-lastY)<28;if(now-lastTouch<360&&near){e.preventDefault();e.stopPropagation();lastTouch=0;commitVoxLaneDoubleAdd(part,clickBeat(e,lane),e);}else{lastTouch=now;lastX=e.clientX;lastY=e.clientY;}},{passive:false});
  }

  function renderVoxInstrumentGroupToggle(tracks,width){
    if(!voxOpenedFromVocal)return;const row=document.createElement('div');row.className='vox-track-row vox-instrument-group-row';row.style.width=`${width}px`;
    const label=document.createElement('div');label.className='vox-track-label vox-instrument-group-label';const btn=document.createElement('button');btn.type='button';btn.className='vox-instrument-group-toggle';btn.textContent=voxShowInstrumentals?'−':'+';btn.setAttribute('aria-label',voxShowInstrumentals?'Collapse instrument tracks':'Show instrument tracks');const title=document.createElement('strong');title.textContent='Instruments';label.append(btn,title);
    const lane=document.createElement('div');lane.className='vox-track-lane vox-instrument-group-lane';lane.innerHTML=`<span>${voxShowInstrumentals?'Chord/Note • Lead/Bass • Drums shown':'Tap + for Chord/Note, Lead/Bass & Drums'}</span>`;
    const toggle=e=>{e?.preventDefault?.();e?.stopPropagation?.();voxShowInstrumentals=!voxShowInstrumentals;voxInstrumentSelections=[];voxInstrumentSelection=null;if(!voxShowInstrumentals)voxInstrumentTrackFocus=null;renderVoxBox();voxStatus(voxShowInstrumentals?'Instrument tracks expanded.':'Instrument tracks collapsed.');};btn.onclick=toggle;lane.onclick=()=>{if(!voxShowInstrumentals)toggle();};row.append(label,lane);tracks.appendChild(row);
  }
  function renderVoxInstrumentTracks(tracks,width,ppb,clickBeat){
    renderVoxInstrumentGroupToggle(tracks,width);
    if(!voxShowInstrumentals)return;
    for(const part of parts.filter(p=>p.type==='chord')){
      const items=chordFlatItems(part);const row=document.createElement('div');row.className='vox-track-row vox-instrument-track';row.style.width=`${width}px`;row.dataset.voxKind='chord';row.dataset.voxPartId=part.id;row.dataset.voxTrackKey=voxTrackTokenForPart(part);row.classList.toggle('is-instrument-focus',voxInstrumentTrackFocus?.key===voxTrackTokenForPart(part));
      const mode=part.data?.mode==='note'?'Note':'Chord';const label=makeVoxTrackLabel({name:part.name,meta:`${mode} • ${items.length} events`,checked:part.enabled,onChecked:on=>{voxCheckpoint();part.enabled=on;persistVoxEdits();renderParts();renderVoxBox();},kind:'chord',part});label.onclick=e=>{if(e.target.closest('input,label,button'))return;focusVoxInstrumentTrack('chord',part.name,`part:${part.id}`,{announce:true});};label.querySelector('strong')?.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();focusVoxInstrumentTrack('chord',part.name,`part:${part.id}`,{announce:true});});label.oncontextmenu=e=>{e.preventDefault();openVoxTrackContextMenu(part,label,e.clientX,e.clientY);};
      const lane=document.createElement('div');lane.className='vox-track-lane vox-instrument-lane';lane.dataset.voxKind='chord';lane.dataset.voxPartId=part.id;lane.onpointerdown=e=>{if(voxRangeMode&&e.target===lane)beginVoxRangePointer(e,part,lane);};lane.onclick=e=>{if(e.target!==lane)return;if(voxRangeMode){e.preventDefault();e.stopPropagation();return;}if(recentVoxLaneAdd(part,e)){e.preventDefault();e.stopPropagation();return;}focusVoxInstrumentTrack('chord',part.name,`part:${part.id}`,{announce:true});/* Blank track space selects the paste/drop target; only the ruler seeks. */};wireVoxLaneDoubleAdd(lane,part,clickBeat);
      for(const item of items){if(!item.card.voxId)item.card.voxId=uid();const key=`chord:${part.id}:${item.card.voxId}`,ev=document.createElement('div');ev.className='vox-instrument-event vox-chord-event'+(voxInstrumentIsSelected(key)?' is-selected':'');ev.dataset.voxKey=key;ev.dataset.voxPartId=part.id;ev.style.left=`${item.startBeat*ppb}px`;ev.style.width=`${Math.max(26,item.dur*ppb)}px`;ev.classList.toggle('is-blank',item.card?.voxBlank===true);ev.textContent=item.card?.voxBlank===true?`Type ${mode.toLowerCase()}`:String(item.card?.value||mode);ev.title=`${part.name} • ${item.card?.value||'event'} • beat ${item.startBeat.toFixed(2)}`;const sel={kind:'chord',key,part,card:item.card,startBeat:item.startBeat,dur:item.dur,flatIndex:item.flatIndex};ev.__voxSelection=sel;ev.onclick=e=>{if(voxRangeMode){e.preventDefault();e.stopPropagation();return;}instrumentClickSelection(sel,ev,e);};ev.ondblclick=e=>{if(voxRangeMode)return;e.preventDefault();e.stopPropagation();beginVoxInlineEventEdit(sel,ev);};ev.onpointerdown=e=>{if(voxRangeMode){beginVoxRangePointer(e,part,lane);return;}if(e.target.classList.contains('vox-inst-handle')||e.target.classList.contains('vox-inline-event-input'))return;beginVoxInstrumentPointerEdit(e,sel,ev,'move');};appendInstrumentHandles(ev,sel);lane.appendChild(ev);}updateVoxRangeOverlay(part,lane);row.append(label,lane);tracks.appendChild(row);wireVoxTrackLongPress(label,row);
    }
    for(const part of parts.filter(p=>p.type==='lead')){
      const row=document.createElement('div');row.className='vox-track-row vox-instrument-track';row.style.width=`${width}px`;row.dataset.voxKind='lead';row.dataset.voxPartId=part.id;row.dataset.voxTrackKey=voxTrackTokenForPart(part);row.classList.toggle('is-instrument-focus',voxInstrumentTrackFocus?.key===voxTrackTokenForPart(part));
      const label=makeVoxTrackLabel({name:part.name,meta:`Lead/Bass • ${part.events?.length||0} notes`,checked:part.enabled,onChecked:on=>{voxCheckpoint();part.enabled=on;persistVoxEdits();renderParts();renderVoxBox();},kind:'lead',part});label.onclick=e=>{if(e.target.closest('input,label,button'))return;focusVoxInstrumentTrack('lead',part.name,`part:${part.id}`,{announce:true});};label.querySelector('strong')?.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();focusVoxInstrumentTrack('lead',part.name,`part:${part.id}`,{announce:true});});label.oncontextmenu=e=>{e.preventDefault();openVoxTrackContextMenu(part,label,e.clientX,e.clientY);};
      const lane=document.createElement('div');lane.className='vox-track-lane vox-instrument-lane';lane.dataset.voxKind='lead';lane.dataset.voxPartId=part.id;lane.onpointerdown=e=>{if(voxRangeMode&&e.target===lane)beginVoxRangePointer(e,part,lane);};lane.onclick=e=>{if(e.target!==lane)return;if(voxRangeMode){e.preventDefault();e.stopPropagation();return;}if(recentVoxLaneAdd(part,e)){e.preventDefault();e.stopPropagation();return;}focusVoxInstrumentTrack('lead',part.name,`part:${part.id}`,{announce:true});/* Blank track space selects the paste/drop target; only the ruler seeks. */};wireVoxLaneDoubleAdd(lane,part,clickBeat);
      for(const event of part.events||[]){if(!event.voxId)event.voxId=uid();const startBeat=leadEventStartBeat(part,event),dur=leadEventDurationBeats(part,event),key=`lead:${part.id}:${event.voxId}`,ev=document.createElement('div');ev.className='vox-instrument-event vox-lead-event'+(voxInstrumentIsSelected(key)?' is-selected':'');ev.dataset.voxKey=key;ev.dataset.voxPartId=part.id;ev.style.left=`${startBeat*ppb}px`;ev.style.width=`${Math.max(22,dur*ppb)}px`;ev.classList.toggle('is-blank',event.voxBlank===true);ev.textContent=event.voxBlank===true?'Type note':midiName(event.midi);ev.title=`${part.name} • ${event.voxBlank===true?'blank note':midiName(event.midi)} • beat ${startBeat.toFixed(2)}`;const sel={kind:'lead',key,part,event,startBeat,dur};ev.__voxSelection=sel;ev.onclick=e=>{if(voxRangeMode){e.preventDefault();e.stopPropagation();return;}instrumentClickSelection(sel,ev,e);};ev.ondblclick=e=>{if(voxRangeMode)return;e.preventDefault();e.stopPropagation();beginVoxInlineEventEdit(sel,ev);};ev.onpointerdown=e=>{if(voxRangeMode){beginVoxRangePointer(e,part,lane);return;}if(e.target.classList.contains('vox-inst-handle')||e.target.classList.contains('vox-inline-event-input'))return;beginVoxInstrumentPointerEdit(e,sel,ev,'move');};appendInstrumentHandles(ev,sel);lane.appendChild(ev);}updateVoxRangeOverlay(part,lane);row.append(label,lane);tracks.appendChild(row);wireVoxTrackLongPress(label,row);
    }
    renderVoxDrumMap(tracks,width,ppb,clickBeat);
  }
  function beginVoxInstrumentPointerEdit(e,sel,el,mode='move'){
    sel=resolveVoxInstrumentSelection(sel)||sel;
    if(!sel||e.button!==undefined&&e.button!==0)return;
    const touchPointer=e.pointerType==='touch',holdToMove=touchPointer&&mode==='move',pointerId=e.pointerId;
    // Moving an event on touch is deliberately different from resizing it: a normal
    // swipe must remain a timeline scroll, and only a stationary long-press grabs it.
    if(holdToMove)e.stopPropagation();else{e.preventDefault();e.stopPropagation();}
    const add=voxToolMode==='multi'||e.ctrlKey||e.metaKey||e.shiftKey,wasSelected=voxInstrumentIsSelected(sel.key),desktopSelectionOnly=(!touchPointer&&voxToolMode==='multi'&&mode==='move'&&!wasSelected);
    const selectForEdit=()=>{
      if(!voxInstrumentIsSelected(sel.key)){setVoxInstrumentSelection(sel,{add,render:false});el.classList.add('is-selected');el.__voxPointerSelected=true;}
      renderVoxSelectionClasses();renderVoxInspector();
    };
    if(!holdToMove)selectForEdit();
    const ppb=voxPpb(),downX=e.clientX,downY=e.clientY,orig=Number(sel.startBeat)||0,origDur=Math.max(.001,Number(sel.dur)||.25),origEnd=orig+origDur,minBeat=voxSnapEnabled()?voxBeatStep():.03,dragThreshold=touchPointer?6:4;
    let dragX=downX,dragY=downY,moved=false,targetInstrumentPart=sel.part,cleaned=false,mutationStarted=false,armed=!holdToMove,holdTimer=0,holdCanceled=false,moving=[],starts=new Map();
    const captureEl=e.currentTarget||el;
    const startMutation=()=>{if(mutationStarted)return;mutationStarted=true;disableVoxAutoScroll();voxCheckpoint();};
    const refreshMoving=()=>{moving=(mode==='move'?voxInstrumentSelectionList():[sel]).map(resolveVoxInstrumentSelection).filter(Boolean);if(!moving.length)moving=[resolveVoxInstrumentSelection(sel)||sel];starts=new Map(moving.map(x=>[String(x.key),Number(x.startBeat)||0]));};
    const blockTouchScroll=te=>{if(armed&&holdToMove&&te.cancelable)te.preventDefault();};
    const armTouchMove=()=>{
      if(cleaned||holdCanceled||armed)return;armed=true;selectForEdit();refreshMoving();dragX=downX;dragY=downY;el.classList.add('is-dragging','is-longpress-grabbed');
      try{captureEl.setPointerCapture?.(pointerId)}catch{}
      document.addEventListener('touchmove',blockTouchScroll,{capture:true,passive:false});
      voxStatus('Event grabbed — drag to move.');
    };
    if(holdToMove){holdTimer=setTimeout(armTouchMove,420);}else{refreshMoving();el.classList.add('is-dragging');if(mode!=='move')el.classList.add('is-trimming');try{captureEl.setPointerCapture?.(pointerId)}catch{}}

    const move=ev=>{
      if(ev.pointerId!==pointerId)return;
      if(!armed){
        if(Math.hypot(ev.clientX-downX,ev.clientY-downY)>10){holdCanceled=true;if(holdTimer){clearTimeout(holdTimer);holdTimer=0;}}
        return; // leave the browser free to scroll the timeline normally
      }
      ev.preventDefault();ev.stopPropagation();
      const distance=Math.hypot(ev.clientX-dragX,ev.clientY-dragY);if(distance<=dragThreshold)return;
      if(desktopSelectionOnly)return;
      if(!moved){moved=true;startMutation();}
      const dx=(ev.clientX-dragX)/ppb;
      if(mode==='move'){
        const target=quantizeVoxBeat(orig+dx),delta=target-orig;
        for(const item of moving){
          const next=Math.max(0,Math.round(((starts.get(String(item.key))||0)+delta)*1000)/1000),node=document.querySelector(`.vox-instrument-event[data-vox-key="${CSS.escape(String(item.key))}"]`);
          item.__voxPreviewBeat=next;if(node)node.style.left=`${next*ppb}px`;
        }
        if(['lead','chord'].includes(sel.kind)){
          const lane=findVoxLaneAt(ev.clientX,ev.clientY);if(lane&&['lead','chord'].includes(String(lane.dataset.voxKind||''))){
            const p=parts.find(x=>['chord','lead'].includes(x.type)&&String(x.id)===String(lane.dataset.voxPartId));if(p)targetInstrumentPart=p;
          }
          document.querySelectorAll('.vox-instrument-track').forEach(r=>r.classList.toggle('is-target',String(r.dataset.voxPartId||'')===String(targetInstrumentPart?.id||'')));
        }
      }else if(sel.kind==='lead'){
        const p=sel.part,stepBeats=4/Math.max(8,Number(p.resolution)||16);
        if(mode==='trim-right'){
          const targetEnd=Math.max(orig+minBeat,quantizeVoxBeat(origEnd+dx)),dur=Math.max(minBeat,targetEnd-orig);
          sel.event.voxDurationBeats=dur;sel.event.durationSteps=Math.max(1,Math.round(dur/stepBeats));el.style.width=`${Math.max(22,dur*ppb)}px`;
        }else{
          const targetStart=Math.max(0,Math.min(origEnd-minBeat,quantizeVoxBeat(orig+dx))),dur=Math.max(minBeat,origEnd-targetStart);
          sel.event.voxStartBeat=targetStart;sel.event.voxDurationBeats=dur;sel.event.step=Math.max(0,Math.round(targetStart/stepBeats));sel.event.durationSteps=Math.max(1,Math.round(dur/stepBeats));el.style.left=`${targetStart*ppb}px`;el.style.width=`${Math.max(22,dur*ppb)}px`;
        }
      }else if(sel.kind==='chord'){
        const start=Number.isFinite(Number(sel.card.voxStartBeat))?Number(sel.card.voxStartBeat):orig;
        if(mode==='trim-right'){
          const targetEnd=Math.max(start+minBeat,quantizeVoxBeat(origEnd+dx)),dur=Math.max(minBeat,targetEnd-start);
          sel.card.voxStartBeat=start;sel.card.voxDurationBeats=dur;sel.card.durationBeats=dur;el.style.width=`${Math.max(26,dur*ppb)}px`;
        }else{
          const targetStart=Math.max(0,Math.min(origEnd-minBeat,quantizeVoxBeat(orig+dx))),dur=Math.max(minBeat,origEnd-targetStart);
          sel.card.voxStartBeat=targetStart;sel.card.voxDurationBeats=dur;sel.card.durationBeats=dur;el.style.left=`${targetStart*ppb}px`;el.style.width=`${Math.max(26,dur*ppb)}px`;
        }
      }else if(sel.kind==='drum'){
        if(mode==='trim-right'){const targetEnd=Math.max(orig+minBeat,quantizeVoxBeat(origEnd+dx)),dur=Math.max(minBeat,targetEnd-orig);sel.event.durationBeats=dur;el.style.width=`${Math.max(34,dur*ppb)}px`;}
        else{const targetStart=Math.max(0,Math.min(origEnd-minBeat,quantizeVoxBeat(orig+dx))),shift=targetStart-orig,dur=Math.max(minBeat,origEnd-targetStart);sel.event.startBeat=targetStart;sel.event.durationBeats=dur;sel.event.patternOffsetBeats=(Number(sel.event.patternOffsetBeats)||0)+shift;el.style.left=`${targetStart*ppb}px`;el.style.width=`${Math.max(34,dur*ppb)}px`;}
      }
    };

    const cleanup=()=>{
      if(cleaned)return;cleaned=true;if(holdTimer){clearTimeout(holdTimer);holdTimer=0;}
      window.removeEventListener('pointermove',move,true);window.removeEventListener('pointerup',up,true);window.removeEventListener('pointercancel',cancel,true);document.removeEventListener('touchmove',blockTouchScroll,true);
      try{captureEl.releasePointerCapture?.(pointerId)}catch{}
      el.classList.remove('is-dragging','is-trimming','is-longpress-grabbed');document.querySelectorAll('.vox-instrument-track.is-target').forEach(r=>r.classList.remove('is-target'));
    };
    const finishMove=()=>{
      const movedSelections=[];
      if(mode==='move')for(const raw of moving){
        const item=resolveVoxInstrumentSelection(raw)||raw,targetBeat=Number(raw.__voxPreviewBeat);delete raw.__voxPreviewBeat;if(!Number.isFinite(targetBeat))continue;
        if(item.kind==='lead'&&item.part&&item.event){
          const src=item.part,dst=(targetInstrumentPart&&['chord','lead'].includes(targetInstrumentPart.type)?targetInstrumentPart:src),dur=leadEventDurationBeats(src,item.event);
          if(dst.type==='chord'&&dst!==src){
            const clip={kind:'lead',sourcePartId:src.id,event:clone(item.event)},made=pasteOneInstrumentClip(clip,targetBeat,dst);if(made){removeInstrumentSelectionNoCheckpoint([item]);movedSelections.push(made);voxInstrumentTrackFocus={kind:'chord',name:dst.name,key:`part:${dst.id}`,explicitTarget:true};}
          }else{
            if(dst!==src)src.events=(src.events||[]).filter(x=>x!==item.event&&String(x.voxId||'')!==String(item.event.voxId||''));
            const dstStepBeats=4/Math.max(8,Number(dst.resolution)||16),newEvent=item.event;if(!newEvent.voxId)newEvent.voxId=uid();
            newEvent.voxStartBeat=targetBeat;newEvent.voxDurationBeats=dur;newEvent.step=Math.max(0,Math.round(targetBeat/dstStepBeats));newEvent.durationSteps=Math.max(1,Math.round(dur/dstStepBeats));
            dst.events=normalizeLeadEvents(dst===src?(dst.events||[]):[...(dst.events||[]),newEvent]);const stored=(dst.events||[]).find(x=>String(x.voxId||'')===String(newEvent.voxId||''))||newEvent;
            movedSelections.push({kind:'lead',key:`lead:${dst.id}:${stored.voxId}`,part:dst,event:stored,startBeat:leadEventStartBeat(dst,stored),dur:leadEventDurationBeats(dst,stored)});
            if(dst!==src)voxInstrumentTrackFocus={kind:'lead',name:dst.name,key:`part:${dst.id}`,explicitTarget:true};
          }
        }else if(item.kind==='chord'&&item.part&&item.card){
          const src=item.part,dst=(targetInstrumentPart&&['chord','lead'].includes(targetInstrumentPart.type)?targetInstrumentPart:src),card=item.card;if(!card.voxId)card.voxId=uid();
          if(dst.type==='lead'&&dst!==src){
            const clip={kind:'chord',sourcePartId:src.id,card:clone(card)},made=pasteOneInstrumentClip(clip,targetBeat,dst);if(made){removeInstrumentSelectionNoCheckpoint([item]);movedSelections.push(made);voxInstrumentTrackFocus={kind:'lead',name:dst.name,key:`part:${dst.id}`,explicitTarget:true};}
          }else{
            if(dst!==src){removeChordCardFromPart(src,card);insertChordCardIntoPart(dst,card,targetBeat);voxInstrumentTrackFocus={kind:'chord',name:dst.name,key:`part:${dst.id}`,explicitTarget:true};}
            else{card.voxStartBeat=targetBeat;if(!Number.isFinite(Number(card.voxDurationBeats)))card.voxDurationBeats=Math.max(.001,Number(item.dur)||chordEventDurationBeats(src,card));card.durationBeats=card.voxDurationBeats;}
            movedSelections.push({kind:'chord',key:`chord:${dst.id}:${card.voxId}`,part:dst,card,startBeat:targetBeat,dur:chordEventDurationBeats(dst,card)});
          }
        }else if(item.kind==='drum'&&item.event){item.event.startBeat=targetBeat;movedSelections.push({kind:'drum',key:`drum:${item.event.id}`,event:item.event,startBeat:targetBeat,dur:item.event.durationBeats,name:'Drums'});voxInstrumentTrackFocus={kind:'drum',name:'Drums',key:'drum-map',explicitTarget:true};}
      }
      if(mode==='move'&&movedSelections.length){voxInstrumentSelections=movedSelections;voxInstrumentSelection=movedSelections[0]||null;}
      const loaded=loadedChord();if(loaded)core.apply(loaded.data);
      persistVoxEdits();renderParts();renderVoxBox();voxStatus(mode==='move'?(moving.length>1?`${moving.length} instrument events moved.`:'Instrument event moved.'):'Instrument event resized.');
    };
    const up=ev=>{
      if(ev.pointerId!==pointerId)return;
      if(armed){ev.preventDefault();ev.stopPropagation();}const wasArmed=armed;cleanup();el.__voxDragged=moved;if(holdToMove&&wasArmed&&!moved){el.__voxPointerSelected=false;el.__voxSuppressClickUntil=performance.now()+520;}
      if(!moved){if(wasArmed){renderVoxSelectionClasses();renderVoxInspector();}return;}finishMove();
    };
    const cancel=ev=>{if(ev.pointerId!==pointerId)return;cleanup();if(moved)renderVoxBox();};
    window.addEventListener('pointermove',move,{capture:true,passive:false});window.addEventListener('pointerup',up,{capture:true,passive:false});window.addEventListener('pointercancel',cancel,{capture:true,passive:true});
  }

  function renderVoxSongLocators(){
    const ppb=voxPpb(),range=songRangeForTimeline(),startEl=$('voxSongStartLocator'),endEl=$('voxSongEndLocator'),fill=$('voxSongRangeFill');/* Locators now live inside the sticky ruler layer, whose x=0 is timeline beat 0 (after the title rail). */if(startEl)startEl.style.left=`${range.start*ppb}px`;if(endEl)endEl.style.left=`${range.end*ppb}px`;if(fill){fill.style.left=`${range.start*ppb}px`;fill.style.width=`${Math.max(2,(range.end-range.start)*ppb)}px`;}
  }
  function ensureVoxTimelineVisualBeats(beats){
    const inner=$('voxTimelineInner'),ruler=$('voxRuler'),tracks=$('voxTracks'),ppb=voxPpb(),width=Math.max(720,Math.ceil(Math.max(16,beats)*ppb));if(inner)inner.style.width=`${width}px`;if(ruler)ruler.style.width=`${width}px`;for(const row of tracks?.querySelectorAll?.(':scope > .vox-track-row')||[])row.style.width=`${width}px`;
  }
  function wireVoxSongLocatorDrag(id,kind){
    const el=$(id);if(!el||el.dataset.wired)return;el.dataset.wired='1';el.addEventListener('pointerdown',e=>{if(e.button!==undefined&&e.button!==0)return;e.preventDefault();e.stopPropagation();disableVoxAutoScroll();voxCheckpoint();const sc=$('voxTimelineScroller');if(!sc)return;try{el.setPointerCapture(e.pointerId)}catch{};let moved=false,lastClientX=e.clientX,raf=0;
      const apply=clientX=>{const r=sc.getBoundingClientRect(),local=clientX-r.left+sc.scrollLeft-voxLabelWidth(),raw=Math.max(0,local/voxPpb()),step=voxSnapEnabled()?voxBeatStep():.03,q=voxSnapEnabled()?Math.max(0,Math.round(raw/step)*step):Math.max(0,Math.round(raw*1000)/1000),range=songRangeForTimeline();if(kind==='start'){if(!Number.isFinite(Number(songEndBeat)))songEndBeat=range.end;songStartBeat=Math.max(0,Math.min(songEndBeat-step,q));if(songEndBeat<=songStartBeat)songEndBeat=songStartBeat+step;}else{songEndBeat=Math.max(range.start+step,q);ensureVoxTimelineVisualBeats(songEndBeat+8);}renderVoxSongLocators();};
      const auto=()=>{raf=0;const r=sc.getBoundingClientRect(),edge=44;let delta=0;if(lastClientX>r.right-edge)delta=Math.min(18,(lastClientX-(r.right-edge))*.45);else if(lastClientX<r.left+edge)delta=-Math.min(18,((r.left+edge)-lastClientX)*.45);if(delta){sc.scrollLeft=Math.max(0,sc.scrollLeft+delta);apply(lastClientX);raf=requestAnimationFrame(auto);}};
      const move=ev=>{if(ev.pointerId!==e.pointerId)return;ev.preventDefault();moved=true;lastClientX=ev.clientX;apply(ev.clientX);if(!raf)raf=requestAnimationFrame(auto);};const up=ev=>{if(ev.pointerId!==e.pointerId)return;try{el.releasePointerCapture(ev.pointerId)}catch{};window.removeEventListener('pointermove',move,true);window.removeEventListener('pointerup',up,true);window.removeEventListener('pointercancel',up,true);if(raf)cancelAnimationFrame(raf);if(!moved){voxUndoStack.pop();updateVoxHistoryButtons();return;}markPartsDirty();liveEditRefresh();core.scheduleAutoSave();renderVoxBox();voxStatus(`${kind==='start'?'Song start':'Song finish'} set to beat ${(kind==='start'?songStartBeat:songEndBeat).toFixed(2)}.`);};window.addEventListener('pointermove',move,{capture:true,passive:false});window.addEventListener('pointerup',up,true);window.addEventListener('pointercancel',up,true);
    });
  }
  function renderVoxBox(){
    if(!voxBoxOpen)return;const vocals=allVocalParts(),tracks=$('voxTracks'),ruler=$('voxRuler'),inner=$('voxTimelineInner'),page=$('voxBoxPage');if(!tracks||!ruler||!inner)return;
    const token=++voxRenderToken,ppb=voxPpb(),beats=voxTimelineBeats(),width=Math.max(720,Math.ceil(beats*ppb));inner.style.width=`${width}px`;ruler.style.width=`${width}px`;ruler.innerHTML='';tracks.innerHTML='';
    for(let b=0;b<=Math.ceil(beats);b++){const tick=document.createElement('span');tick.className='vox-ruler-beat'+(b%4===0?' major':'');tick.style.left=`${b*ppb}px`;ruler.appendChild(tick);if(b%4===0){const lab=document.createElement('span');lab.className='vox-ruler-label';lab.style.left=`${b*ppb}px`;lab.textContent=String(b+1);ruler.appendChild(lab);}}renderVoxSongLocators();
    const clickBeat=(e,base)=>{const rect=base.getBoundingClientRect();return quantizeVoxBeat((e.clientX-rect.left)/ppb);};
    ruler.onclick=e=>{voxSeekTo(clickBeat(e,ruler),{manual:true});renderVoxInspector();renderVoxHarmonyGuide();};
    renderVoxInstrumentTracks(tracks,width,ppb,clickBeat);
    if(vocals.length){
      if(!voxTargetPartId||!vocals.some(p=>p.id===voxTargetPartId))voxTargetPartId=(active()?.type==='vocal'?active().id:vocals[0].id);
      for(const part of vocals){
        const row=document.createElement('div');row.className='vox-track-row'+(String(part.id)===String(voxTargetPartId)?' is-target':'');row.style.width=`${width}px`;row.dataset.voxPartId=part.id;row.dataset.voxKind='vocal';row.dataset.voxTrackKey=voxTrackTokenForPart(part);
        const label=document.createElement('div');label.className='vox-track-label';label.dataset.voxPartId=String(part.id);label.dataset.voxPartType='vocal';
        const nameInput=document.createElement('input');nameInput.type='text';nameInput.className='vox-track-name';nameInput.value=part.name||'Vocal Track';nameInput.setAttribute('aria-label','Vocal track name');nameInput.title='Rename vocal track';
        nameInput.onclick=e=>e.stopPropagation();nameInput.onfocus=()=>{voxCheckpoint();voxTargetPartId=part.id;voxSelections=[];voxSelected=null;voxInstrumentSelections=[];voxInstrumentSelection=null;voxInstrumentTrackFocus=null;renderVoxInspector();};
        nameInput.oninput=()=>{part.name=String(nameInput.value||'');markPartsDirty();core.scheduleAutoSave();};nameInput.onblur=()=>{part.name=String(nameInput.value||'').trim()||`Vocals ${allVocalParts().indexOf(part)+1}`;nameInput.value=part.name;renderParts();markPartsDirty();core.scheduleAutoSave();};
        const meta=document.createElement('span');meta.className='vox-track-meta';meta.textContent=`${Math.round((Number(part.volume)||0)*100)}% • ${(part.voxEvents||[]).length} event${(part.voxEvents||[]).length===1?'':'s'}`;
        const menu=document.createElement('button');menu.type='button';menu.className='vox-track-menu-btn';menu.textContent='⋮';menu.title='Track actions';menu.setAttribute('aria-label',`${part.name} track actions`);menu.onclick=e=>{e.preventDefault();e.stopPropagation();const r=menu.getBoundingClientRect();openVoxTrackContextMenu(part,label,r.right,r.bottom);};label.append(nameInput,meta);appendVoxTrackVolume(label,{part});label.append(menu);appendVoxMuteSolo(label,{part});
        label.onclick=e=>{if(e.target.closest('input,button'))return;focusVoxVocalTrack(part,{announce:true});};
        label.oncontextmenu=e=>{e.preventDefault();openVoxTrackContextMenu(part,label,e.clientX,e.clientY);};
        const lane=document.createElement('div');lane.className='vox-track-lane';lane.dataset.voxPartId=part.id;lane.dataset.voxKind='vocal';lane.onpointerdown=e=>{if(voxRangeMode&&e.target===lane)beginVoxRangePointer(e,part,lane);};lane.onclick=e=>{if(e.target!==lane)return;if(voxRangeMode){e.preventDefault();e.stopPropagation();return;}focusVoxVocalTrack(part,{announce:true});/* Blank vocal space selects the paste/drop target. The ruler is the only seek surface. */};
        for(const event of voxTrackEvents(part)){
          const take=voxEventTake(event),bounds=voxEventBounds(event),ev=document.createElement('div');ev.className='vox-event'+(voxIsSelected(part.id,event.id)?' is-selected':'');ev.dataset.voxEventId=event.id;ev.dataset.voxPartId=part.id;ev.style.left=`${bounds.start*ppb}px`;ev.style.width=`${Math.max(24,bounds.dur*ppb)}px`;
          const top=document.createElement('div');top.className='vox-event-top';top.innerHTML=`<span class="vox-event-name">${escapeHtml(take?.name||'Vocal event')}</span><span class="vox-event-time">${bounds.start.toFixed(2)}–${bounds.end.toFixed(2)}b</span>`;
          const canvas=document.createElement('canvas');canvas.className='vox-event-waveform';const lh=document.createElement('span');lh.className='vox-trim-handle left';const rh=document.createElement('span');rh.className='vox-trim-handle right';ev.append(top,canvas,lh,rh);
          ev.onclick=e=>{e.stopPropagation();if(voxRangeMode){e.preventDefault();return;}if(ev.__voxDragged){ev.__voxDragged=false;return;}if((ev.__voxSuppressClickUntil||0)>performance.now())return;if(ev.__voxPointerSelected){ev.__voxPointerSelected=false;renderVoxSelectionClasses();renderVoxInspector();return;}const multi=voxToolMode==='multi',add=multi||e.ctrlKey||e.metaKey||e.shiftKey;voxSetSelection(part,event,{add,toggle:add});renderVoxSelectionClasses();renderVoxInspector();};
          ev.onpointerdown=e=>{if(voxRangeMode){beginVoxRangePointer(e,part,lane);return;}if(e.target===lh||e.target===rh)return;beginVoxPointerEdit(e,part,event,ev,'move');};lh.onpointerdown=e=>{if(voxRangeMode){beginVoxRangePointer(e,part,lane);return;}beginVoxPointerEdit(e,part,event,ev,'trim-left');};rh.onpointerdown=e=>{if(voxRangeMode){beginVoxRangePointer(e,part,lane);return;}beginVoxPointerEdit(e,part,event,ev,'trim-right');};lane.appendChild(ev);queueLiveVoxWaveform(canvas,event);
        }
        updateVoxRangeOverlay(part,lane);row.append(label,lane);tracks.appendChild(row);wireVoxTrackLongPress(label,row);
      }
    }else tracks.insertAdjacentHTML('beforeend','<div class="vocal-empty" style="padding:40px">No vocal tracks yet. Open a track’s ⋮ menu to add a Vocal Track.</div>');
    applyVoxTrackOrder();inner.classList.toggle('has-crop-mode',voxCropMode);page?.classList.toggle('crop-mode',voxCropMode);page?.classList.toggle('range-select-mode',voxRangeMode);page?.classList.remove('cursor-mode');page?.classList.toggle('multi-select-mode',voxToolMode==='multi');page?.classList.add('playhead-mode');if($('voxCropBtn')){$('voxCropBtn').textContent='Select';$('voxCropBtn').classList.toggle('is-active',voxRangeMode);$('voxCropBtn').setAttribute('aria-pressed',String(voxRangeMode));$('voxCropBtn').title=voxRangeMode?'Range Select on — drag on desktop; on phone tap start, then tap end':'Range Select — choose a time section on any vocal, instrument, or drum track';$('voxCropBtn').disabled=false;}
    if($('voxToolModeBtn')){$('voxToolModeBtn').textContent='Multi Select';$('voxToolModeBtn').classList.toggle('is-active',voxToolMode==='multi');$('voxToolModeBtn').setAttribute('aria-pressed',String(voxToolMode==='multi'));$('voxToolModeBtn').title=voxToolMode==='multi'?'Multi Select on — Track Master behaves normally; tap events to add/remove them from the selection':'Multi Select off — normal single-event editing';}
    updateVoxSelectAllUi();
    renderVoxSongLocators();updateVoxPlayhead(voxPlayheadBeat);renderVoxHarmonyGuide();renderVoxInspector();updateVoxTransportState();wireVoxMarquee();
  }
  function findVoxLaneAt(x,y){return document.elementsFromPoint?.(x,y)?.find(el=>el.classList?.contains('vox-track-lane'))||null;}
  function beginVoxPointerEdit(e,part,event,el,mode){
    if(e.button!==undefined&&e.button!==0)return;
    const touchPointer=e.pointerType==='touch',holdToMove=touchPointer&&mode==='move',pointerId=e.pointerId;
    if(holdToMove)e.stopPropagation();else{e.preventDefault();e.stopPropagation();}
    const add=voxToolMode==='multi'||e.ctrlKey||e.metaKey||e.shiftKey,wasSelected=voxIsSelected(part.id,event.id),desktopSelectionOnly=(!touchPointer&&voxToolMode==='multi'&&mode==='move'&&!wasSelected);
    const selectForEdit=()=>{if(!voxIsSelected(part.id,event.id)){voxSetSelection(part,event,{add,render:false});el.classList.add('is-selected');el.__voxPointerSelected=true;}renderVoxSelectionClasses();renderVoxInspector();};
    if(!holdToMove)selectForEdit();
    const ppb=voxPpb(),beatSec=60/Math.max(40,Math.min(240,Number(core.bpm)||92)),downX=e.clientX,downY=e.clientY,origStart=Number(event.startBeat)||0,origTrimStart=Math.max(0,Number(event.trimStartSec)||0),take=voxEventTake(event),full=Math.max(0,Number(take?.duration)||0),origTrimEnd=Math.max(origTrimStart,Math.min(full,Number.isFinite(Number(event.trimEndSec))&&Number(event.trimEndSec)>0?Number(event.trimEndSec):full)),origEndBeat=origStart+(origTrimEnd-origTrimStart)/beatSec,dragThreshold=touchPointer?6:4;
    let dragX=downX,dragY=downY,targetPartId=part.id,moved=false,mutationStarted=false,armed=!holdToMove,holdTimer=0,holdCanceled=false,cleaned=false,selectedAtStart=[],starts=new Map();
    const canvas=el.querySelector('.vox-event-waveform');
    const startMutation=()=>{if(mutationStarted)return;mutationStarted=true;disableVoxAutoScroll();voxCheckpoint();};
    const refreshMoving=()=>{selectedAtStart=mode==='move'?voxSelectionPairs():[{part,event}];if(!selectedAtStart.length)selectedAtStart=[{part,event}];starts=new Map(selectedAtStart.map(x=>[`${x.part.id}:${x.event.id}`,Number(x.event.startBeat)||0]));};
    const blockTouchScroll=te=>{if(armed&&holdToMove&&te.cancelable)te.preventDefault();};
    const armTouchMove=()=>{if(cleaned||holdCanceled||armed)return;armed=true;selectForEdit();refreshMoving();dragX=downX;dragY=downY;el.classList.add('is-dragging','is-longpress-grabbed');try{el.setPointerCapture(pointerId)}catch{}document.addEventListener('touchmove',blockTouchScroll,{capture:true,passive:false});voxStatus('Event grabbed — drag to move.');};
    if(holdToMove)holdTimer=setTimeout(armTouchMove,420);else{refreshMoving();el.classList.add('is-dragging');if(mode!=='move')el.classList.add('is-trimming');try{el.setPointerCapture(pointerId)}catch{}}
    const liveCrop=()=>{updateVoxEventReadout(el,event);queueLiveVoxWaveform(canvas,event);};
    const move=ev=>{
      if(ev.pointerId!==pointerId)return;
      if(!armed){if(Math.hypot(ev.clientX-downX,ev.clientY-downY)>10){holdCanceled=true;if(holdTimer){clearTimeout(holdTimer);holdTimer=0;}}return;}
      ev.preventDefault();ev.stopPropagation();const distance=Math.hypot(ev.clientX-dragX,ev.clientY-dragY);if(distance<=dragThreshold)return;if(desktopSelectionOnly)return;if(!moved){moved=true;startMutation();}const dx=(ev.clientX-dragX)/ppb;
      if(mode==='move'){
        const primaryNew=quantizeVoxBeat(origStart+dx),delta=primaryNew-origStart;for(const item of selectedAtStart){const base=starts.get(`${item.part.id}:${item.event.id}`)||0;item.event.startBeat=Math.max(0,Math.round((base+delta)*1000)/1000);const node=document.querySelector(`.vox-event[data-vox-part-id="${CSS.escape(String(item.part.id))}"][data-vox-event-id="${CSS.escape(String(item.event.id))}"]`);if(node){node.style.left=`${item.event.startBeat*ppb}px`;updateVoxEventReadout(node,item.event);}}
        if(selectedAtStart.length===1){const lane=findVoxLaneAt(ev.clientX,ev.clientY);if(lane?.dataset.voxKind==='vocal'&&lane?.dataset.voxPartId)targetPartId=lane.dataset.voxPartId;document.querySelectorAll('.vox-track-row').forEach(r=>r.classList.toggle('is-target',String(r.dataset.voxPartId)===String(targetPartId)));}
      }else if(mode==='trim-left'){const target=quantizeVoxBeat(origStart+dx),delta=(target-origStart)*beatSec,newTrim=Math.max(0,Math.min(origTrimEnd-.03,origTrimStart+delta));event.trimStartSec=newTrim;event.startBeat=Math.max(0,origStart+(newTrim-origTrimStart)/beatSec);const dur=Math.max(.001,(origTrimEnd-newTrim)/beatSec);el.style.left=`${event.startBeat*ppb}px`;el.style.width=`${Math.max(24,dur*ppb)}px`;liveCrop();voxStatus(`Cropping start • ${event.startBeat.toFixed(2)}–${(event.startBeat+dur).toFixed(2)} beats`);
      }else{const targetEnd=quantizeVoxBeat(origEndBeat+dx),newEnd=Math.max(origTrimStart+.03,Math.min(full,origTrimStart+Math.max(.02,targetEnd-origStart)*beatSec));event.trimEndSec=newEnd;const dur=Math.max(.001,(newEnd-origTrimStart)/beatSec);el.style.width=`${Math.max(24,dur*ppb)}px`;liveCrop();voxStatus(`Cropping end • ${origStart.toFixed(2)}–${(origStart+dur).toFixed(2)} beats`);}
    };
    const cleanup=()=>{if(cleaned)return;cleaned=true;if(holdTimer){clearTimeout(holdTimer);holdTimer=0;}window.removeEventListener('pointermove',move,true);window.removeEventListener('pointerup',up,true);window.removeEventListener('pointercancel',cancel,true);document.removeEventListener('touchmove',blockTouchScroll,true);try{el.releasePointerCapture(pointerId)}catch{}el.classList.remove('is-dragging','is-trimming','is-longpress-grabbed');document.querySelectorAll('.vox-track-row.is-target').forEach(r=>r.classList.remove('is-target'));};
    const up=ev=>{if(ev.pointerId!==pointerId)return;if(armed){ev.preventDefault();ev.stopPropagation();}const wasArmed=armed;cleanup();el.__voxDragged=moved;if(holdToMove&&wasArmed&&!moved){el.__voxPointerSelected=false;el.__voxSuppressClickUntil=performance.now()+520;}if(!moved)return;if(mode==='move'&&selectedAtStart.length===1&&String(targetPartId)!==String(part.id)){const dest=parts.find(p=>p.type==='vocal'&&String(p.id)===String(targetPartId));if(dest){part.voxEvents=(part.voxEvents||[]).filter(x=>x.id!==event.id);dest.voxEvents=dest.voxEvents||[];dest.voxEvents.push(event);voxSelections=[{partId:dest.id,eventId:event.id}];voxSelected=voxSelections[0];voxTargetPartId=dest.id;}}persistVoxEdits();renderVoxBox();if(mode!=='move')voxStatus('Crop applied. The original dry take remains untouched.');else voxStatus(selectedAtStart.length>1?`${selectedAtStart.length} vocal events moved together.`:'Vocal event moved.');};
    const cancel=ev=>{if(ev.pointerId!==pointerId)return;cleanup();if(moved)renderVoxBox();};
    window.addEventListener('pointermove',move,{capture:true,passive:false});window.addEventListener('pointerup',up,{capture:true,passive:false});window.addEventListener('pointercancel',cancel,{capture:true,passive:true});
  }

  function openVoxBox(options={}){
    const allowNoVocals=!!options.allowNoVocals,forceInstrumentals=!!options.forceInstrumentals,fromVocal=!!options.fromVocal,vocals=allVocalParts();if(!vocals.length&&!allowNoVocals){core.status('Add a Vocals part first.');return;}
    // Capture any CRP/BD chord edits before Vox Box becomes the canonical timeline
    // editor. Once open, syncLoadedChord() intentionally stops replacing part.data.
    syncLoadedChord();
    let changed=false;for(const p of vocals){if(!(p.voxEvents||[]).length&&p.activeTakeId&&p.recordings?.some(r=>r.id===p.activeTakeId)){ensureVoxEventForActiveTake(p,0);changed=true;}}
    voxOpenedFromVocal=fromVocal;if(forceInstrumentals){try{localStorage.setItem(VOX_INST_KEY,'1')}catch{}voxShowInstrumentals=true;}
    voxBoxOpen=true;try{const savedInspector=localStorage.getItem(VOX_INSPECTOR_COLLAPSED_KEY);voxInspectorManualOverride=savedInspector===null?null:savedInspector==='1';}catch{voxInspectorManualOverride=null;}voxTargetPartId=vocals.length?(active()?.type==='vocal'?active().id:vocals[0].id):null;voxSelections=[];voxSelected=null;voxInstrumentSelections=[];voxInstrumentSelection=null;voxInstrumentTrackFocus=null;voxCropMode=false;voxRangeMode=false;voxRangeSelection=null;voxUndoStack=[];voxRedoStack=[];const page=$('voxBoxPage');if(page){page.hidden=false;page.setAttribute('aria-hidden','false');}document.body.classList.add('vox-box-open');
    try{$('voxSnapToBeat').checked=localStorage.getItem(VOX_SNAP_KEY)!=='0';$('voxSnapResolution').value=localStorage.getItem(VOX_RES_KEY)||'16';/* Track Master always opens with follow enabled. Any manual timeline interaction below turns it off for the current session. */voxAutoScroll=true;localStorage.setItem(VOX_AUTO_KEY,'1');voxShowInstrumentals=forceInstrumentals?true:(fromVocal?false:localStorage.getItem(VOX_INST_KEY)==='1');const savedTool=localStorage.getItem(VOX_TOOL_KEY)||'playhead';voxToolMode=savedTool==='cursor'?'multi':(savedTool==='multi'?'multi':'playhead');}catch{voxAutoScroll=true;}
    if(changed)persistVoxEdits();renderVoxBox();restoreVoxTransportPosition();updateVoxHistoryButtons();
  }
  function openTrackMaster(){
    openVoxBox({allowNoVocals:true,forceInstrumentals:true,fromVocal:false});
    if(voxBoxOpen&&!allVocalParts().length)voxStatus('Track Master open. Instrument tracks are ready; add a Vocal Track whenever you want to record or edit vocals.');
  }
  function closeVoxBox(){voxBoxOpen=false;const page=$('voxBoxPage');if(page){page.hidden=true;page.setAttribute('aria-hidden','true');}document.body.classList.remove('vox-box-open');const p=active();renderParts();if(p){setEditorMode(p.type);if(p.type==='lead')renderLeadEditor(p);else if(p.type==='vocal')renderVocalEditor(p);} }
  function addVoxTrack(){voxCheckpoint();const p=vocalPart(`Vocals ${countType('vocal')+1}`);parts.push(p);activePartId=p.id;voxTargetPartId=p.id;voxSelections=[];voxSelected=null;voxInstrumentSelections=[];voxInstrumentSelection=null;markPartsDirty();renderParts();persistVoxEdits();renderVoxBox();voxStatus(`${p.name} added. Rename it in the track header, paste/layer clips here, or record directly with the floating transport.`);}
  function addActiveTakeToVox(){const p=voxTargetPart();if(!p?.activeTakeId||!p.recordings?.some(r=>r.id===p.activeTakeId)){voxStatus('Choose an active take on this vocal track first.');return;}voxCheckpoint();p.voxEvents=p.voxEvents||[];const ev=normalizeVoxEvent({id:uid(),takeId:p.activeTakeId,sourcePartId:p.id,startBeat:quantizeVoxBeat(voxPlayheadBeat),trimStartSec:0,trimEndSec:null,volume:1,fx:null},p);p.voxEvents.push(ev);voxSelections=[{partId:p.id,eventId:ev.id}];voxSelected=voxSelections[0];voxInstrumentSelections=[];voxInstrumentSelection=null;persistVoxEdits();renderVoxBox();voxStatus(`Added ${voxEventTake(ev)?.name||'active take'} at beat ${ev.startBeat.toFixed(2)}.`);}
  function splitSelectedVox(){
    const split=quantizeVoxBeat(voxPlayheadBeat),vocalSelected=voxSelectionPairs(),drumSelected=voxInstrumentSelectionList().filter(s=>s.kind==='drum'),validV=vocalSelected.filter(({event})=>{const b=voxEventBounds(event);return split>b.start+.01&&split<b.end-.01;}),validD=drumSelected.filter(s=>split>s.startBeat+.01&&split<s.startBeat+s.dur-.01);
    if(!validV.length&&!validD.length){voxStatus('Move the playhead inside the selected vocal or drum event, then Split.');return;}voxCheckpoint();const beatSec=60/Math.max(40,Math.min(240,Number(core.bpm)||92)),newV=[],newI=[];
    for(const {part,event} of validV){const b=voxEventBounds(event),splitSec=(Number(event.trimStartSec)||0)+(split-b.start)*beatSec,oldEnd=event.trimEndSec;event.trimEndSec=splitSec;const right=clone(event);right.id=uid();right.startBeat=split;right.trimStartSec=splitSec;right.trimEndSec=oldEnd;const ix=part.voxEvents.findIndex(x=>x.id===event.id);part.voxEvents.splice(ix+1,0,right);newV.push({partId:part.id,eventId:right.id});}
    for(const s of validD){const ev=s.event,oldEnd=ev.startBeat+ev.durationBeats,leftDur=split-ev.startBeat,rightDur=oldEnd-split,right=normalizeDrumEvent({...clone(ev),id:uid(),startBeat:split,durationBeats:rightDur,patternOffsetBeats:(Number(ev.patternOffsetBeats)||0)+leftDur});ev.durationBeats=leftDur;drumEvents.push(right);newI.push({kind:'drum',key:`drum:${right.id}`,event:right,startBeat:right.startBeat,dur:right.durationBeats,name:'Drums'});}
    drumEvents.sort((a,b)=>a.startBeat-b.startBeat);voxSelections=newV;voxSelected=newV[0]||null;voxInstrumentSelections=newI;voxInstrumentSelection=newI[0]||null;persistVoxEdits();renderVoxBox();voxStatus(`${validV.length+validD.length} event${validV.length+validD.length===1?'':'s'} split.`);
  }

  function copyInstrumentSelection(cut=false){
    const list=voxInstrumentSelectionList().slice().sort((a,b)=>(Number(a.startBeat)||0)-(Number(b.startBeat)||0));if(!list.length)return false;const anchor=Number(list[0].startBeat)||0;
    voxClipboard={kind:'instrument-group',focusKeyAtCopy:String(voxInstrumentTrackFocus?.key||''),items:serializeInstrumentClipboardItems(list,anchor)};
    if(cut){voxCheckpoint();removeInstrumentSelectionNoCheckpoint(list);voxInstrumentSelections=[];voxInstrumentSelection=null;persistVoxEdits();renderParts();renderVoxBox();voxStatus(`${list.length} instrument event${list.length===1?'':'s'} cut. First event will paste at the playhead.`);}else{renderVoxInspector();voxStatus(`${list.length} instrument event${list.length===1?'':'s'} copied. First event will paste at the playhead.`);}return true;
  }
  function removeInstrumentSelectionNoCheckpoint(list=voxInstrumentSelectionList()){
    for(const raw of list){
      const s=resolveVoxInstrumentSelection(raw)||raw;
      if(s.kind==='drum'&&s.event){drumArrangementInitialized=true;drumEvents=drumEvents.filter(e=>String(e.id)!==String(s.event.id));}
      else if(s.kind==='lead'&&s.part){const id=String(s.event?.voxId||'');s.part.events=(s.part.events||[]).filter(x=>x!==s.event&&(id?String(x.voxId||'')!==id:true));}
      else if(s.kind==='chord'&&s.part){
        const id=String(s.card?.voxId||'');let removed=false;
        for(const row of s.part.data?.rows||[]){let i=row.indexOf(s.card);if(i<0&&id)i=row.findIndex(c=>String(c?.voxId||'')===id);if(i>=0){row.splice(i,1);removed=true;break;}}
        if(removed&&String(s.part.id)===String(loadedChordPartId))core.apply(s.part.data);
      }
    }
  }
  function removeVocalSelectionNoCheckpoint(list=voxSelectionPairs()){for(const {part,event} of list)part.voxEvents=(part.voxEvents||[]).filter(x=>x.id!==event.id);}
  function copySelectedVox(cut=false){
    if(voxRangeMode&&voxRangeResolved())return copyVoxRange(cut);
    const vocals=voxSelectionPairs().slice().sort((a,b)=>(Number(a.event.startBeat)||0)-(Number(b.event.startBeat)||0)),inst=voxInstrumentSelectionList().slice().sort((a,b)=>(Number(a.startBeat)||0)-(Number(b.startBeat)||0));
    if(!vocals.length&&!inst.length){if(voxRangeMode)voxStatus('Finish the Select range first.');return;}
    const allStarts=[...vocals.map(x=>Number(x.event.startBeat)||0),...inst.map(x=>Number(x.startBeat)||0)],anchor=Math.min(...allStarts);
    if(vocals.length&&inst.length){
      const vocalTracks=allVocalParts(),baseTrack=vocalTracks.indexOf(vocals[0].part);voxClipboard={kind:'mixed',focusKeyAtCopy:String(voxInstrumentTrackFocus?.key||''),vocalItems:vocals.map(({part,event})=>({event:clone(event),sourcePartId:part.id,deltaBeat:(Number(event.startBeat)||0)-anchor,trackOffset:vocalTracks.indexOf(part)-baseTrack})),instrumentItems:serializeInstrumentClipboardItems(inst,anchor)};
    }else if(inst.length){voxClipboard={kind:'instrument-group',focusKeyAtCopy:String(voxInstrumentTrackFocus?.key||''),items:serializeInstrumentClipboardItems(inst,anchor)};}
    else{const vocalTracks=allVocalParts(),baseTrack=vocalTracks.indexOf(vocals[0].part);voxClipboard={kind:'vocal',items:vocals.map(({part,event})=>({event:clone(event),sourcePartId:part.id,deltaBeat:(Number(event.startBeat)||0)-anchor,trackOffset:vocalTracks.indexOf(part)-baseTrack}))};}
    const count=vocals.length+inst.length;
    if(cut){voxCheckpoint();removeVocalSelectionNoCheckpoint(vocals);removeInstrumentSelectionNoCheckpoint(inst);voxSelections=[];voxSelected=null;voxInstrumentSelections=[];voxInstrumentSelection=null;persistVoxEdits();renderParts();renderVoxBox();voxStatus(`${count} event${count===1?'':'s'} cut. The earliest event will paste at the playhead.`);}else{renderVoxInspector();voxStatus(`${count} event${count===1?'':'s'} copied. The earliest event will paste at the playhead.`);}
  }
  function pasteOneInstrumentClip(clip,atBeat,destinationPart=null){
    const targetBeat=Math.max(0,Math.round((Number(atBeat)||0)*1000)/1000);
    if(clip.kind==='drum'){drumArrangementInitialized=true;const event=normalizeDrumEvent({...clone(clip.event||{}),id:uid(),startBeat:targetBeat});drumEvents.push(event);drumEvents.sort((a,b)=>a.startBeat-b.startBeat);return {kind:'drum',key:`drum:${event.id}`,event,startBeat:event.startBeat,dur:event.durationBeats,name:'Drums'};}
    if(clip.kind==='lead'){
      if(destinationPart?.type==='chord'){
        const src=parts.find(x=>x.type==='lead'&&String(x.id)===String(clip.sourcePartId))||null,e=clone(clip.event||{}),midi=Math.max(0,Math.min(127,Number(e.midi)||60)),dur=src?leadEventDurationBeats(src,e):Math.max(.03,Number(e.voxDurationBeats)||1),card={voxId:uid(),type:'note',value:NOTE_NAMES[(midi%12+12)%12],midiNotes:[midi],durationBeats:dur,voxStartBeat:targetBeat,voxDurationBeats:dur};
        insertChordCardIntoPart(destinationPart,card,targetBeat);if(String(destinationPart.id)===String(loadedChordPartId))core.apply(destinationPart.data);return {kind:'chord',key:`chord:${destinationPart.id}:${card.voxId}`,part:destinationPart,card,startBeat:targetBeat,dur};
      }
      const p=(destinationPart?.type==='lead'?destinationPart:null)||parts.find(x=>x.type==='lead'&&String(x.id)===String(clip.sourcePartId))||parts.find(x=>x.type==='lead');if(!p)return null;const stepBeats=4/Math.max(8,Number(p.resolution)||16),e=clone(clip.event||{});e.voxId=uid();e.voxStartBeat=targetBeat;e.voxDurationBeats=Math.max(stepBeats,Number(e.voxDurationBeats)||Math.max(1,Number(e.durationSteps)||1)*stepBeats);e.step=Math.max(0,Math.round(targetBeat/stepBeats));e.durationSteps=Math.max(1,Math.round(e.voxDurationBeats/stepBeats));p.events=normalizeLeadEvents([...(p.events||[]),e]);const stored=p.events.find(x=>String(x.voxId)===String(e.voxId))||e;return {kind:'lead',key:`lead:${p.id}:${stored.voxId}`,part:p,event:stored,startBeat:leadEventStartBeat(p,stored),dur:leadEventDurationBeats(p,stored)};
    }
    if(clip.kind==='chord'){
      if(destinationPart?.type==='lead'){
        const src=parts.find(x=>x.type==='chord'&&String(x.id)===String(clip.sourcePartId))||null,card=clone(clip.card||{}),notes=src?(core.notesFor(card,src.data)||[]):[],explicit=Array.isArray(card.midiNotes)&&Number.isFinite(Number(card.midiNotes[0]))?Number(card.midiNotes[0]):NaN,midi=Number.isFinite(explicit)?explicit:(notes.length?midiNum(notes[0]):60),dur=src?chordEventDurationBeats(src,card):Math.max(.03,Number(card.voxDurationBeats)||Number(card.durationBeats)||1),p=destinationPart,stepBeats=4/Math.max(8,Number(p.resolution)||16),e={voxId:uid(),voxStartBeat:targetBeat,voxDurationBeats:dur,step:Math.max(0,Math.round(targetBeat/stepBeats)),durationSteps:Math.max(1,Math.round(dur/stepBeats)),midi:Math.max(0,Math.min(127,midi))};
        p.events=normalizeLeadEvents([...(p.events||[]),e]);const stored=p.events.find(x=>String(x.voxId)===String(e.voxId))||e;return {kind:'lead',key:`lead:${p.id}:${stored.voxId}`,part:p,event:stored,startBeat:leadEventStartBeat(p,stored),dur:leadEventDurationBeats(p,stored)};
      }
      const p=(destinationPart?.type==='chord'?destinationPart:null)||parts.find(x=>x.type==='chord'&&String(x.id)===String(clip.sourcePartId))||parts.find(x=>x.type==='chord');if(!p)return null;const card=clone(clip.card||{});card.voxId=uid();insertChordCardIntoPart(p,card,targetBeat);if(String(p.id)===String(loadedChordPartId))core.apply(p.data);return {kind:'chord',key:`chord:${p.id}:${card.voxId}`,part:p,card,startBeat:targetBeat,dur:card.voxDurationBeats};
    }
    return null;
  }
  function pasteInstrument(){
    const clip=voxClipboard;if(!clip||!['instrument-group'].includes(clip.kind))return false;voxCheckpoint();const chosenFocus=focusedMelodicInstrumentPart(),explicitTarget=voxInstrumentTrackFocus?.explicitTarget===true,newSel=[];for(const item of clip.items||[]){const dest=destinationInstrumentPartForClip(item),s=pasteOneInstrumentClip(item,voxPlayheadBeat+(Number(item.deltaBeat)||0),dest);if(s)newSel.push(s);}voxInstrumentSelections=newSel;voxInstrumentSelection=newSel[0]||null;voxSelections=[];voxSelected=null;if(chosenFocus)voxInstrumentTrackFocus={kind:chosenFocus.type==='chord'?'chord':'lead',name:chosenFocus.name,key:`part:${chosenFocus.id}`,explicitTarget};else if(newSel[0])voxInstrumentTrackFocus=newSel[0].kind==='drum'?{kind:'drum',name:'Drums',key:'drum-map',explicitTarget}:{kind:newSel[0].kind,name:newSel[0].part?.name||'Instrument',key:newSel[0]?.part?`part:${newSel[0].part.id}`:null,explicitTarget};persistVoxEdits();renderParts();renderVoxBox();voxStatus(`${newSel.length} event${newSel.length===1?'':'s'} pasted to the selected track${newSel.length===1?'':'s'}; first event starts at the playhead.`);return true;
  }
  function pasteVox(){
    if(!voxClipboard)return;if(voxClipboard.kind==='instrument-group'){pasteInstrument();return;}voxCheckpoint();const newV=[],newI=[],vocalTracks=allVocalParts(),target=voxTargetPart()||vocalTracks[0]||null,base=target?Math.max(0,vocalTracks.indexOf(target)):0;
    const pasteVocals=items=>{if(!target)return;for(const item of items||[]){const dest=vocalTracks[Math.max(0,Math.min(vocalTracks.length-1,base+(Number(item.trackOffset)||0)))]||target,ev=normalizeVoxEvent({...clone(item.event),id:uid(),sourcePartId:item.event?.sourcePartId||item.sourcePartId,startBeat:Math.max(0,Math.round((voxPlayheadBeat+(Number(item.deltaBeat)||0))*1000)/1000)},dest);dest.voxEvents=dest.voxEvents||[];dest.voxEvents.push(ev);newV.push({partId:dest.id,eventId:ev.id});}};
    if(voxClipboard.kind==='vocal'||voxClipboard.kind==='vocal-range')pasteVocals(voxClipboard.items);else if(voxClipboard.kind==='mixed'){pasteVocals(voxClipboard.vocalItems);for(const item of voxClipboard.instrumentItems||[]){const dest=destinationInstrumentPartForClip(item),s=pasteOneInstrumentClip(item,voxPlayheadBeat+(Number(item.deltaBeat)||0),dest);if(s)newI.push(s);}}else{voxUndoStack.pop();updateVoxHistoryButtons();return;}
    voxSelections=newV;voxSelected=newV[0]||null;voxInstrumentSelections=newI;voxInstrumentSelection=newI[0]||null;persistVoxEdits();renderParts();renderVoxBox();const n=newV.length+newI.length;voxStatus(`${n} event${n===1?'':'s'} pasted in order; earliest event starts at beat ${voxPlayheadBeat.toFixed(2)}.`);
  }
  function deleteInstrumentSelection(){
    const list=voxInstrumentSelectionList();if(!list.length)return false;voxCheckpoint();removeInstrumentSelectionNoCheckpoint(list);voxInstrumentSelections=[];voxInstrumentSelection=null;renderVoxBox();voxStatus(`${list.length} instrument event${list.length===1?'':'s'} deleted.`);persistVoxEditsAfterPaint({renderPartsToo:true});return true;
  }
  function deleteSelectedVox(){
    if(voxRangeMode&&voxRangeResolved())return deleteVoxRange();
    const inst=voxInstrumentSelectionList(),voc=voxSelectionPairs();if(!inst.length&&!voc.length){if(voxRangeMode)voxStatus('Finish the Select range first.');return;}voxCheckpoint();removeInstrumentSelectionNoCheckpoint(inst);removeVocalSelectionNoCheckpoint(voc);voxSelections=[];voxSelected=null;voxInstrumentSelections=[];voxInstrumentSelection=null;renderVoxBox();const n=inst.length+voc.length;voxStatus(`${n} event${n===1?'':'s'} deleted. Original vocal takes remain safe.`);persistVoxEditsAfterPaint({renderPartsToo:true});
  }
  function updateVoxFxFromUi(kind){
    const p=voxTargetPart(),selected=voxSelectionPairs(),eventMode=$('voxFxTarget')?.value==='event'&&selected.length;if(!p)return;const touchedParts=new Set();
    if(eventMode){for(const item of selected){const ev=item.event;let fx=ev.fx||(ev.fx=normalizeVocalFx(item.part.fx));if(kind==='volume')ev.volume=Math.max(0,Math.min(1.5,(Number($('voxFxVolume')?.value)||0)/100));else if(kind==='autotune')fx.autotune=Math.max(0,Math.min(100,Number($('voxFxAutotune')?.value)||0));else if(kind==='eq')fx.eq=$('voxFxEq').value;else if(kind==='comp')fx.comp=$('voxFxComp').value;else if(kind==='reverb')fx.reverb=Number($('voxFxReverb').value)||0;else if(kind==='delay')fx.delay=Number($('voxFxDelay').value)||0;touchedParts.add(item.part);}}
    else{let fx=p.fx;if(kind==='volume'){p.volume=Math.max(0,Math.min(1.5,(Number($('voxFxVolume')?.value)||0)/100));syncPartVolumeControls(p,Math.min(100,Math.round(p.volume*100)));}else if(kind==='autotune')fx.autotune=Math.max(0,Math.min(100,Number($('voxFxAutotune')?.value)||0));else if(kind==='eq')fx.eq=$('voxFxEq').value;else if(kind==='comp')fx.comp=$('voxFxComp').value;else if(kind==='reverb')fx.reverb=Number($('voxFxReverb').value)||0;else if(kind==='delay')fx.delay=Number($('voxFxDelay').value)||0;touchedParts.add(p);}
    if(kind==='volume'&&$('voxFxVolumeValue'))$('voxFxVolumeValue').textContent=`${$('voxFxVolume').value}%`;if(kind==='autotune'&&$('voxFxAutotuneValue'))$('voxFxAutotuneValue').textContent=`${$('voxFxAutotune').value}%`;for(const part of touchedParts)applyVocalFxLive(part);markPartsDirty();core.scheduleAutoSave();renderVoxInspector();
  }
  function resetSelectedVoxFx(){const selected=voxSelectionPairs();if(!selected.length)return;voxCheckpoint();const touched=new Set();for(const {part,event} of selected){event.fx=null;event.volume=1;touched.add(part);}for(const p of touched)applyVocalFxLive(p);markPartsDirty();core.scheduleAutoSave();renderVoxInspector();voxStatus(`${selected.length} selected event${selected.length===1?'':'s'} now follow track effects.`);}

  function syncVoxBpmInput(){
    const box=$('voxBpmInput');if(!box||document.activeElement===box)return;
    const bpm=Math.max(40,Math.min(240,Math.round(Number(core.bpm)||92)));
    if(String(box.value)!==String(bpm))box.value=String(bpm);
  }
  function commitVoxBpm(){
    const box=$('voxBpmInput'),main=$('bpmInput');if(!box||!main)return;
    const raw=Number(box.value);if(!Number.isFinite(raw)){syncVoxBpmInput();return;}
    const bpm=Math.max(40,Math.min(240,Math.round(raw)));box.value=String(bpm);main.value=String(bpm);
    // Reuse the Suite's existing BPM live-audio refresh + canonical sync path so
    // CRP, Baby DAW and linked SRP all receive the same committed tempo.
    main.dispatchEvent(new Event('input',{bubbles:true}));main.dispatchEvent(new Event('change',{bubbles:true}));
    updateMediaMetadata();voxStatus(`BPM set to ${bpm}.`);
  }
  function updateVoxTransportState(){
    syncVoxBpmInput();
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
    ensureInitial();setEditorMode(active()?.type||'chord');renderParts();ensureMediaSession();updateMediaMetadata();renderSongEndEditor();
    if($('voxBoxBtn'))$('voxBoxBtn').onclick=()=>openVoxBox({fromVocal:true});
    if($('trackMasterBtn'))$('trackMasterBtn').onclick=openTrackMaster;
    try{
      const q=new URLSearchParams(location.search);
      if(q.get('trackMaster')==='1'){
        setTimeout(()=>{openTrackMaster();q.delete('trackMaster');q.delete('return');const qs=q.toString();history.replaceState(null,'',location.pathname+(qs?'?'+qs:'')+location.hash);},80);
      }
    }catch{}
    if($('voxBoxCloseBtn'))$('voxBoxCloseBtn').onclick=closeVoxBox;
    if($('voxBpmInput')){syncVoxBpmInput();$('voxBpmInput').addEventListener('change',commitVoxBpm);$('voxBpmInput').addEventListener('blur',commitVoxBpm);$('voxBpmInput').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();commitVoxBpm();e.currentTarget.blur();}});}
    if($('voxSnapToBeat'))$('voxSnapToBeat').onchange=e=>{try{localStorage.setItem(VOX_SNAP_KEY,e.target.checked?'1':'0')}catch{}voxStatus(e.target.checked?`Snap on (1/${$('voxSnapResolution')?.value||'16'})`:'Free drag enabled.');};
    if($('voxSnapResolution'))$('voxSnapResolution').onchange=e=>{try{localStorage.setItem(VOX_RES_KEY,e.target.value)}catch{}voxStatus(`Snap grid set to 1/${e.target.value}.`);};
    if($('voxToolModeBtn'))$('voxToolModeBtn').onclick=()=>{voxRangeMode=false;voxRangeSelection=null;voxToolMode=voxToolMode==='multi'?'playhead':'multi';clearVoxSelection({render:false,keepInstrumentFocus:true});try{localStorage.setItem(VOX_TOOL_KEY,voxToolMode)}catch{};renderVoxBox();voxStatus(voxToolMode==='multi'?'Multi Select on — tap a track, then use All or tap individual events. Selections on other tracks stay selected.':'Multi Select off — normal single-event editing.');};
    if($('voxSelectAllTrack'))$('voxSelectAllTrack').onchange=e=>setVoxSelectAllForFocusedTrack(!!e.target.checked);
    if($('voxCropBtn'))$('voxCropBtn').onclick=()=>{voxRangeMode=!voxRangeMode;voxCropMode=false;voxRangeSelection=null;voxSelections=[];voxSelected=null;voxInstrumentSelections=[];voxInstrumentSelection=null;if(voxRangeMode){voxToolMode='playhead';try{localStorage.setItem(VOX_TOOL_KEY,'playhead')}catch{}if(!voxInstrumentTrackFocus&&allVocalParts().length&&!voxTargetPartId)voxTargetPartId=allVocalParts()[0].id;}renderVoxBox();voxStatus(voxRangeMode?(window.matchMedia?.('(pointer: coarse)')?.matches?'Select on — tap any vocal, instrument, or drum track for the start, then tap the end. Drag either blue handle to adjust.':'Select on — drag across any vocal, instrument, or drum track. Copy, Cut, or Delete use that range.'):'Select off — normal event editing restored.');};
    if($('voxSplitBtn'))$('voxSplitBtn').onclick=splitSelectedVox;
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
    if($('voxToStartBtn'))$('voxToStartBtn').onclick=()=>voxSeekTo(effectiveSongStartBeat());
    if($('voxRewindBtn'))$('voxRewindBtn').onclick=()=>voxSeekTo(Math.max(effectiveSongStartBeat(),voxPlayheadBeat-4));
    if($('voxFastForwardBtn'))$('voxFastForwardBtn').onclick=()=>voxSeekTo(Math.min(mediaDurationBeats(),voxPlayheadBeat+4));
    if($('voxToEndBtn'))$('voxToEndBtn').onclick=()=>voxSeekTo(Math.max(0,mediaDurationBeats()-.001));
    if($('voxStopTransportBtn'))$('voxStopTransportBtn').onclick=voxTransportStop;
    if($('voxPlayTransportBtn'))$('voxPlayTransportBtn').onclick=voxTransportPlay;
    if($('voxPauseTransportBtn'))$('voxPauseTransportBtn').onclick=voxTransportPause;
    if($('voxRecordTransportBtn'))$('voxRecordTransportBtn').onclick=voxTransportRecord;
    if($('voxAutoScrollBtn'))$('voxAutoScrollBtn').onclick=()=>setVoxAutoScroll(!voxAutoScroll);
    if($('voxLyricsTransportBtn'))$('voxLyricsTransportBtn').onclick=openLyricsOverlay;
    wireVoxTransportDrag();wireVoxPlayheadDrag();wireVoxSongLocatorDrag('voxSongStartLocator','start');wireVoxSongLocatorDrag('voxSongEndLocator','end');
    const voxScroller=$('voxTimelineScroller');if(voxScroller){
      /* Cubase-style follow behavior: Track Master starts in AutoScroll, then any direct timeline tap, wheel, or horizontal/vertical swipe hands control back to the user. */
      voxScroller.addEventListener('pointerdown',()=>{if(voxAutoScroll)disableVoxAutoScroll();},{passive:true});
      voxScroller.addEventListener('wheel',()=>{if(voxAutoScroll)disableVoxAutoScroll();},{passive:true});
      let voxTouchX=null,voxTouchY=null;
      voxScroller.addEventListener('touchstart',e=>{if(!e.touches?.length)return;voxTouchX=e.touches[0].clientX;voxTouchY=e.touches[0].clientY;},{passive:true});
      voxScroller.addEventListener('touchmove',e=>{if(!voxAutoScroll||voxTouchX==null||!e.touches?.length)return;const dx=e.touches[0].clientX-voxTouchX,dy=e.touches[0].clientY-voxTouchY;if(Math.hypot(dx,dy)>10){voxTouchX=voxTouchY=null;disableVoxAutoScroll();}},{passive:true});
      voxScroller.addEventListener('touchend',()=>{voxTouchX=voxTouchY=null;},{passive:true});
    }
    window.addEventListener('resize',()=>{
      updateLeadGridViewToggle();if(!voxBoxOpen)return;
      const width=Math.round(window.innerWidth||document.documentElement.clientWidth||0),widthChanged=Math.abs(width-voxLastLayoutWidth)>4;
      voxLastLayoutWidth=width;
      const inlineEditor=document.querySelector('.vox-inline-event-input');
      const active=document.activeElement,voxFormFocus=!!(active&&active.closest?.('#voxBoxPage')&&active.matches?.('input,textarea,select,[contenteditable="true"]'));
      // Android/iOS open/close the software keyboard by changing viewport height.
      // Re-rendering here destroys the focused input and collapses the keyboard.
      // Keep the live editor/form control intact; committed edits already redraw.
      if(inlineEditor||voxFormFocus||!widthChanged){requestAnimationFrame(()=>clampVoxTransportToViewport());return;}
      renderVoxBox();requestAnimationFrame(()=>clampVoxTransportToViewport());
    });
    $('bpmInput')?.addEventListener('input',()=>{
      renderSongEndEditor();updateMediaMetadata();
      // Do not retime the live clock while the BPM field is still being typed.
      // A committed tempo change below cancels old queued audio and restarts every
      // engine from the same beat at the new BPM.
      if(!(playing||starting))liveEditRefresh();
    });
    $('bpmInput')?.addEventListener('change',()=>{
      renderSongEndEditor();updateMediaMetadata();
      if(recording)return;
      if(!(playing||starting)){liveEditRefresh();return;}
      if(!queueTempoRestartIfNeeded())liveEditRefresh();
    });
    let voxFollowRaf=0;const voxFollowTick=()=>{if(voxBoxOpen){let beat=null;if(playing||starting)beat=currentCycleBeat();else if(recording){const now=recordingPaused&&recordPausedAt?recordPausedAt:performance.now(),activeMs=Math.max(0,now-recordStartedAt-recordPausedTotal-recordInitialTrimSec*1000);beat=recordInsertBeat+(activeMs/1000)*(Math.max(40,Math.min(240,Number(core.bpm)||92))/60);}if(Number.isFinite(beat))updateVoxPlayhead(beat,voxAutoScroll);}voxFollowRaf=requestAnimationFrame(voxFollowTick);};if(voxFollowRaf)cancelAnimationFrame(voxFollowRaf);voxFollowRaf=requestAnimationFrame(voxFollowTick);
    if(songEndUiTimer)clearInterval(songEndUiTimer);songEndUiTimer=setInterval(()=>{renderSongEndEditor();if(voxBoxOpen){updatePartPlaybackButtons();updateVoxTransportState();}},300);
    $('addPartBtn')?.addEventListener('click',openModal);$('closePartModal')?.addEventListener('click',closeModal);document.querySelector('[data-close-part-modal]')?.addEventListener('click',closeModal);document.querySelectorAll('.part-choice').forEach(b=>b.addEventListener('click',()=>addPart(b.dataset.partType)));
    document.querySelectorAll('#leadInstrumentTabs .seg').forEach(b=>b.onclick=()=>{const p=active();if(p?.type!=='lead')return;const nextInstrument=b.dataset.leadInstrument;if(!nextInstrument)return;/* Browsing an instrument family must be non-destructive. Keep the currently selected instrument/sound audible until the user explicitly chooses a sound from the popup. */if(typeof window.CRPShowSoundPicker!=='function')return;window.CRPShowSoundPicker(b,nextInstrument,p.sound,(value)=>{p.instrument=nextInstrument;p.sound=value;renderLeadSoundControls(p);warmLivePlayer(p);core.scheduleAutoSave();});});
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
    $('leadBars').onchange=e=>{const p=active();if(p?.type!=='lead')return;if(e.target.value==='song'){p.barsMode='song';syncLeadBarsToSong(p);}else{p.barsMode='fixed';p.bars=Math.max(1,Math.min(256,+e.target.value||4));const maxSteps=leadTotalSteps(p);p.events=p.events.filter(x=>x.step<maxSteps).map(x=>({...x,durationSteps:Math.min(leadDurationSteps(x),Math.max(1,maxSteps-x.step))}));}leadBarPage=Math.min(leadBarPage,p.bars-1);markPartsDirty();renderLeadEditor(p);core.scheduleAutoSave();};
    $('leadPrevBar').onclick=()=>{const p=active();if(p?.type!=='lead')return;leadBarPage=Math.max(0,leadBarPage-1);updateLeadBarUi(p);scrollLeadGridToBar(p,true);};$('leadNextBar').onclick=()=>{const p=active();if(p?.type!=='lead')return;leadBarPage=p.bars>1?(leadBarPage+1)%p.bars:0;updateLeadBarUi(p);scrollLeadGridToBar(p,true);};
    $('beatsSelect')?.addEventListener('change',()=>{if(active()?.type==='lead')renderLeadHarmony();});
    $('leadCopyBar').onclick=copyLeadBar;$('leadPasteBar').onclick=pasteLeadBar;
    $('leadClearBar').onclick=clearLeadBars;
    $('leadVolume').oninput=e=>{const p=active();if(p?.type!=='lead')return;p.volume=+e.target.value/100;$('leadVolumeValue').textContent=`${e.target.value}%`;updatePartMiniVolume(p);syncPartVolumeControls(p,e.target.value);if((playing||starting)&&partBuses.has(p.id))busFor(p,outputSoundFor(p));core.scheduleAutoSave();};
    $('vocalVolume').oninput=e=>{const p=active();if(p?.type!=='vocal')return;p.volume=+e.target.value/100;$('vocalVolumeValue').textContent=`${e.target.value}%`;applyVocalFxLive(p);updatePartMiniVolume(p);syncPartVolumeControls(p,e.target.value);core.scheduleAutoSave();};
    $('vocalArmMic').onclick=async()=>{if(recording)return;if(micStream?.active){await disableMic();core.status('Mic test off.');return;}try{await ensureMic();core.status('Mic test on. Aim for strong level without living at the far right of the meter.');}catch(e){core.status(e.message||'Could not access microphone.');}};
    if($('vocalMasterPlayBtn'))$('vocalMasterPlayBtn').onclick=toggleVocalMasterPlayback;
    $('vocalRepeat').onchange=e=>{const p=active();if(p?.type!=='vocal')return;p.repeat=e.target.checked;core.scheduleAutoSave();};
    $('vocalRecordBtn').onclick=async()=>{await beginRecording();updateFloatRecorder();};$('vocalStopBtn').onclick=async()=>{await endRecording();updateFloatRecorder();};if($('vocalLyricsBtn'))$('vocalLyricsBtn').onclick=openLyricsOverlay;if($('srpLyricsCloseBtn'))$('srpLyricsCloseBtn').onclick=closeLyricsOverlay;if($('srpFloatRecord'))$('srpFloatRecord').onclick=async()=>{await beginRecording();updateFloatRecorder();};if($('srpFloatPause'))$('srpFloatPause').onclick=async()=>{await toggleRecordingPause();updateFloatRecorder();};if($('srpFloatStop'))$('srpFloatStop').onclick=async()=>{await endRecording();updateFloatRecorder();};
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

  window.CRPParts={handlesPlayback:true,togglePlayback,startPlayback,openTrackMaster,openVoxBox:()=>openVoxBox({fromVocal:true}),liveEditRefresh,seekPlaybackToBeat,seekPlaybackToSeconds,isPlaying:()=>playing||starting,getPlaybackTiming(){
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
  },isRecording:()=>recording,isRecordingPaused:()=>recordingPaused,beginVocalRecording:beginRecording,pauseVocalRecording:toggleRecordingPause,stopVocalRecording:endRecording,openLyricsOverlay,stopPlayback,capture,loadProject,newProject,syncActiveChord,syncCoreLive,syncMidiTimelineFromCore,syncCloudAudio,openStudioExport,openAudioExport,refreshBabySetupToggle,syncBeatMakerMaster,focusChordPart(){const c=parts.find(p=>p.type==='chord');if(!c){refreshBabySetupToggle();return;}if(activePartId!==c.id)selectPart(c.id);else{setEditorMode('chord');refreshBabySetupToggle();core.refreshSetupVisibility?.();}},getActiveChordId(){return loadedChordPartId;},getExportData(){syncLoadedChord();return clone(parts);}};
  // app.js intentionally loads first to expose CRPCore. Tell it that the parts module now
  // exists so the active saved project can be rehydrated with ALL Baby DAW parts before any
  // workspace navigation/save is allowed to capture state.
  try{window.dispatchEvent(new CustomEvent('crp-parts-ready'));}catch{}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',wire);else wire();
})();
