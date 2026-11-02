(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const core = window.CRPCore;
  if(!core) return;

  const clone = v => JSON.parse(JSON.stringify(v));
  const uid = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const NOTE_NAMES=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  // Per-sound output levels come from CRP's table, so a sound plays at the same
  // level in CRP and Baby DAW.
  const soundGain=sound=>Number(core.soundOutputGain?.(sound))||1;
  const LEAD_OUTPUT_BOOST=1.90; // single-note Lead/Bass lines next to multi-note chords
  // Gain staging. SoundFont chords peak around -10 dBFS after soundGain and the
  // vocal chain's compressor make-up lands hot takes near -5 dBFS, so a full mix
  // can sum past full scale. MIX_HEADROOM (-6 dB) is applied to every Baby DAW
  // source (drums included, via Beat Maker's gain scale) so typical material
  // peaks below 0 dBFS; the safety stage (compressor + soft clip, see
  // createMixOutput) only catches the rare overs.
  const MIX_HEADROOM=.5,SOFT_CLIP_RANGE=4,MAX_IDLE_DECODED_SOUNDS=8;
  const clampBpm=bpm=>Math.max(40,Math.min(240,Number(bpm)||92));
  const songBpm=()=>clampBpm(core.bpm);

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


  // Every chord card in a part needs its own voxId: Track Master selection, moves
  // and placement carry-over all address cards by it. Repeated ids come from
  // older builds (the v3.3.35/36 blank-card bug appended one card twice; track
  // duplication and cross-track moves copied ids) and from CRP's Duplicate Line,
  // which deep-copies cards. A repeated card gets a new id derived from the
  // original (so re-syncing the same CRP rows gives the same ids) instead of
  // being dropped. Only at load (dropPhantoms) is an exact positioned copy of an
  // earlier card treated as the old phantom and removed. A CRP copy also loses
  // the copied Track Master start (dropCopiedPlacement), so it lands after its
  // original instead of on top of it.
  function uniquifyCardIds(data,{dropPhantoms=false,dropCopiedPlacement=false}={}){
    if(!data)return;
    if(!Array.isArray(data.rows)||!data.rows.length){data.rows=[[]];return;}
    const cards=data.rows.flat().filter(c=>c&&typeof c==='object'&&c.voxId),taken=new Set(cards.map(c=>String(c.voxId))),first=new Map();
    data.rows=data.rows.map(raw=>(Array.isArray(raw)?raw:[]).filter(card=>{
      if(!card||typeof card!=='object'||!card.voxId)return true;
      const id=String(card.voxId);
      if(!first.has(id)){first.set(id,card);return true;}
      if(dropPhantoms&&hasTrackMasterStart(card)&&JSON.stringify(first.get(id))===JSON.stringify(card))return false;
      let n=1;while(taken.has(`${id}-copy${n}`))n++;
      card.voxId=`${id}-copy${n}`;taken.add(card.voxId);first.set(card.voxId,card);
      if(dropCopiedPlacement)delete card.voxStartBeat;
      return true;
    }));
  }
  function hasTrackMasterStart(card){const s=card?.voxStartBeat;return s!=null&&Number.isFinite(Number(s))&&Number(s)>=0;}
  function migrateChordData(data){uniquifyCardIds(data,{dropPhantoms:true});normalizeChordDurations(data);return data;}


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
  let audioCtx=null, mixInput=null, cycleTimer=null;
  // Per-playback graph (dropped by silenceScheduledAudio): part players/buses,
  // live voices and clip sources, vocal FX chains and the queued windows.
  let partPlayers=new Map(), playerSound=new WeakMap(), partBuses=new Map(), partHandoffGates=new Map(), partInstrumentFx=new Map(), vocalChains=new Map(), scheduledWindows=[], scheduledVocalPlan='';
  const highlightTimers=new Set(), activeVoices=new Set(), activeVocalSources=new Set();
  // Decoded takes, kept across playbacks and cleared on project switch.
  const vocalBufferCache=new Map(), vocalBuffers=new Map();
  // v3.3.54 — cached waveform envelopes keep Track Master navigation from rescanning
  // millions of audio samples on the UI thread while WebAudio playback is running.
  const voxWaveformPeakCache=new Map();
  let micStream=null,micCtx=null,micSource=null,micAnalyser=null,micMeterRaf=0,currentPreview=null;
  let recorder=null,recording=false,recordingPaused=false,recordingResuming=false,recordTimer=null,recordScope=null,recordInsertBeat=0,recordTargetPartId=null,recordStartedFromVox=false,recordResumeBeat=0;
  let recordedSec=0,recordOpenedAtPerf=null; // captured seconds: closed gate spans + the open one
  let leadBarClipboard=null;
  let partsUpdatedAt=0, partsFingerprint='';
  let voxBoxOpen=false,voxRangeMode=false,voxRangeSelection=null,voxSelected=null,voxSelections=[],voxInstrumentSelection=null,voxInstrumentSelections=[],voxInstrumentTrackFocus=null,voxTargetPartId=null,voxClipboard=null,voxPlayheadBeat=0,voxRenderToken=0,voxAutoScroll=true,voxShowInstrumentals=false,voxOpenedFromVocal=false,voxToolMode='playhead',voxUndoStack=[],voxRedoStack=[],voxInspectorManualOverride=null;
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
    const d=migrateChordData(data?clone(data):core.snapshot());
    return {id:uid(),type:'chord',name,enabled:true,muted:false,solo:false,voxSetupEstablished:false,volume:.85,data:d};
  }
  function leadPart(name='Lead 1'){
    return {id:uid(),type:'lead',name,enabled:true,muted:false,solo:false,voxSetupEstablished:false,repeat:true,sustain:false,volume:.8,instrument:'piano',sound:'acoustic_grand_piano',octave:0,gridOctave:3,resolution:16,bars:4,barsMode:'fixed',events:[]};
  }
  function vocalPart(name='Vocals 1'){
    return {id:uid(),type:'vocal',name,enabled:true,muted:false,solo:false,voxTimeline:true,repeat:false,volume:1,transcript:'',recordings:[],activeTakeId:null,voxEvents:[],backingPartIds:parts.filter(x=>x.type==='chord'||x.type==='lead').filter(x=>x.enabled).map(x=>x.id),backingDrums:true,backingVolume:.8,fx:{eq:'clear',comp:'medium',reverb:.12,delay:0,autotune:0}};
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
    if(p.type==='chord')return {...base,type:'chord',data:migrateChordData(clone(p.data||core.snapshot()))};
    if(p.type==='lead')return {...base,type:'lead',repeat:p.repeat!==false,sustain:p.sustain===true,instrument:['piano','guitar','misc'].includes(p.instrument)?p.instrument:'piano',sound:p.sound||'acoustic_grand_piano',octave:Number(p.octave)||0,gridOctave:Number(p.gridOctave)||3,resolution:[8,16,32,64].includes(+p.resolution)?+p.resolution:16,bars:Math.max(1,Math.min(256,+p.bars||4)),barsMode:p.barsMode==='song'?'song':'fixed',events:normalizeLeadEvents(p.events)};
    const voxEvents=Array.isArray(p.voxEvents)?p.voxEvents.map(e=>normalizeVoxEvent(e,p)).filter(Boolean):[];
    const recordings=Array.isArray(p.recordings)?p.recordings.map(r=>({...r,blob:null})):[];
    const activeTakeId=p.activeTakeId||null;
    // A vocal part plays its timeline clips and nothing else. Older builds also
    // played the active take from beat 0 when a part had no clips; make that
    // implicit clip explicit, once (voxTimeline marks parts already migrated).
    if(p.voxTimeline!==true&&!voxEvents.length&&recordings.some(r=>r.id===activeTakeId))voxEvents.push(normalizeVoxEvent({takeId:activeTakeId,sourcePartId:base.id,startBeat:0},base));
    return {...base,type:'vocal',voxTimeline:true,repeat:p.repeat!==false,transcript:String(p.transcript||''),transcriptWords:Array.isArray(p.transcriptWords)?p.transcriptWords:[],recordings,activeTakeId,voxEvents,backingPartIds:Array.isArray(p.backingPartIds)?p.backingPartIds:[],backingDrums:p.backingDrums!==false,backingVolume:Number.isFinite(+p.backingVolume)?Math.max(0,Math.min(1,+p.backingVolume)):.8,fx:normalizeVocalFx(p.fx)};
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
  function voxEventDurationBeats(e,bpm=core.bpm){return voxEventDurationSeconds(e)*clampBpm(bpm)/60;}
  function voxTrackEvents(p){return p?.type==='vocal'&&Array.isArray(p.voxEvents)?p.voxEvents.filter(e=>voxEventTake(e)&&voxEventDurationSeconds(e)>.01):[];}
  function vocalHasPlayableAudio(p){return voxTrackEvents(p).length>0;}
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
  // ---- Takes and the clips that play them ----
  // A take sits in the song, when played from its start, at the beat it was
  // recorded from. Older takes did not store that: infer it from their earliest
  // clip (start minus trim), else beat 0.
  function takeAnchorBeat(take){
    if(!take)return 0;
    if(take.recordedAtBeat!=null&&Number.isFinite(Number(take.recordedAtBeat)))return Math.max(0,Number(take.recordedAtBeat));
    const beatsPerSec=songBpm()/60;let anchor=null;
    for(const p of allVocalParts())for(const e of p.voxEvents||[])if(String(e.takeId)===String(take.id)){const a=Math.max(0,(Number(e.startBeat)||0)-(Number(e.trimStartSec)||0)*beatsPerSec);anchor=anchor==null?a:Math.min(anchor,a);}
    return anchor??0;
  }
  // "Use" makes a take the one this track plays: each clip of the previously
  // active take stays where it is and plays the same moment of the song from the
  // chosen take (its trims shift by the difference between where the two takes
  // were recorded; a clip that ran to the end of its take still does). If the
  // track has no such clip, the take is placed where it was recorded.
  function useTake(p,take){
    const prior=p.recordings.find(r=>r.id===p.activeTakeId&&r.id!==take.id)||null;
    p.activeTakeId=take.id;p.transcript=take.transcript||'';p.transcriptWords=take.transcriptWords||[];
    if(prior){
      const beatsPerSec=songBpm()/60,shiftSec=(takeAnchorBeat(prior)-takeAnchorBeat(take))/beatsPerSec;let moved=0;
      for(const e of p.voxEvents){
        if(String(e.takeId)!==String(prior.id))continue;
        let start=Number(e.startBeat)||0,trimStart=(Number(e.trimStartSec)||0)+shiftSec;
        const trimEnd=e.trimEndSec==null?null:Number(e.trimEndSec)+shiftSec;
        // Song time before the chosen take began: start the clip where it does.
        if(trimStart<0){start-=trimStart*beatsPerSec;trimStart=0;}
        Object.assign(e,{takeId:take.id,sourcePartId:p.id,startBeat:start,trimStartSec:trimStart,trimEndSec:trimEnd!=null&&trimEnd<=trimStart?trimStart+.001:trimEnd});moved++;
      }
      if(moved)return;
    }
    if(!p.voxEvents.some(e=>String(e.takeId)===String(take.id)))p.voxEvents.push(normalizeVoxEvent({takeId:take.id,sourcePartId:p.id,startBeat:takeAnchorBeat(take)},p));
  }
  // A new recording replaces what its track had from the beat recording started
  // through the end of every clip it records over (Baby DAW and Track Master
  // alike). Older takes stay in the take list; in Track Master this is undoable.
  function placeRecordedTake(p,take){
    const start=takeAnchorBeat(take),end=start+(Number(take.duration)||0)*songBpm()/60;
    let clearTo=end;
    for(const e of voxTrackEvents(p)){const b=voxEventBounds(e);if(b.start<end-1e-6&&b.end>start+1e-6)clearTo=Math.max(clearTo,b.end);}
    removeVoxRangeContent({kind:'vocal',part:p,start,end:clearTo});
    const ev=normalizeVoxEvent({takeId:take.id,sourcePartId:p.id,startBeat:start},p);
    p.voxEvents.push(ev);p.activeTakeId=take.id;p.transcript='';p.transcriptWords=[];
    return ev;
  }
  // Every clip's take record lives in the clip's own part, so deleting any other
  // track never takes a clip's audio with it. Several parts may hold a record of
  // the same take (duplicated tracks, moved or pasted clips); the audio is shared
  // and its deletion is reference-counted (deleteTake).
  function ensureTakeRecord(part,takeId,fallback=null){
    const id=String(takeId);if(part.recordings.some(r=>String(r.id)===id))return;
    const found=findVocalTake(id)?.take||fallback;if(!found)return;
    const record=clone(found);delete record.blob;part.recordings.push(record);
  }
  function adoptClipTakes(part){for(const e of part.voxEvents||[]){ensureTakeRecord(part,e.takeId);e.sourcePartId=String(part.id);}}
  function normalTransportRepeatEnabled(){
    // v3.3.120 — the visible Lead/Bass Repeat control mirrors the hidden/master
    // CRP loop checkbox, but mobile live editing can briefly leave those two DOM
    // controls one paint apart. Treat either checked control as repeat-on for the
    // normal (unscoped) transport so a live instrument/sound edit cannot turn an
    // already-looping song into an end-of-song stop.
    if(playbackScope)return false;
    if(!!core.loop)return true;
    const a=active(),leadRepeat=$('leadRepeat');
    return a?.type==='lead'&&!!leadRepeat?.checked;
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
  // CRP's editor state mirrors the loaded chord part; this pulls CRP edits back
  // into the part. While Track Master is open the part data is the editing
  // authority (its inline editors, drags and trims hold live card references),
  // so nothing is pulled until it closes.
  function syncLoadedChord(){
    const p=loadedChord();
    if(!p||voxBoxOpen)return false;
    adoptCoreSnapshot(p);
    return true;
  }
  function syncActiveChord(){if(active()?.id===loadedChordPartId)syncLoadedChord();}
  function adoptCoreSnapshot(p){
    const next=core.snapshot();
    uniquifyCardIds(next,{dropCopiedPlacement:true});
    carryTrackMasterPlacement(p.data,next);
    normalizeChordDurations(next);
    p.data=next;
    syncSongKeyAcrossChordParts(next.key);
  }
  // CRP strips Track Master's absolute starts (voxStartBeat) from its own rows on
  // MIDI-view Play, Save and resize, because the MIDI view is sequential. Those
  // starts belong to Track Master, so they are restored from the part, matched by
  // voxId, unless the CRP edit genuinely conflicts with them: the card was moved
  // within the sequence, or a card CRP added/resized/shifted now overlaps it
  // where it did not before.
  function carryTrackMasterPlacement(oldData,next){
    const prior=new Map();
    chordItemsFor(oldData).forEach((it,index)=>{if(it.card?.voxId)prior.set(String(it.card.voxId),{start:it.startBeat,end:it.startBeat+it.dur,placed:hasTrackMasterStart(it.card),index});});
    const cards=(next.rows||[]).flat().filter(c=>c&&typeof c==='object'),old=c=>c.voxId?prior.get(String(c.voxId)):null;
    const restored=new Set();
    for(const card of cards){const o=old(card);if(o?.placed&&!hasTrackMasterStart(card)){card.voxStartBeat=o.start;restored.add(card);}}
    if(!restored.size)return;
    const kept=cardsKeepingOrder(cards.filter(c=>old(c)),c=>old(c).index);
    for(const card of restored)if(!kept.has(card)){delete card.voxStartBeat;restored.delete(card);}
    const overlaps=(a0,a1,b0,b1)=>a0<b1-1e-6&&b0<a1-1e-6;
    for(let pass=0;pass<=cards.length&&restored.size;pass++){
      const items=chordItemsFor(next);
      const edited=items.filter(it=>{const o=old(it.card);return !o||Math.abs(o.start-it.startBeat)>1e-6||Math.abs(o.end-(it.startBeat+it.dur))>1e-6;});
      let dropped=false;
      for(const it of items){
        if(!restored.has(it.card))continue;
        const mine=old(it.card),end=it.startBeat+it.dur;
        const clash=edited.some(e=>{if(e.card===it.card||!overlaps(e.startBeat,e.startBeat+e.dur,it.startBeat,end))return false;const theirs=old(e.card);return !theirs||!overlaps(theirs.start,theirs.end,mine.start,mine.end);});
        if(clash){delete it.card.voxStartBeat;restored.delete(it.card);dropped=true;}
      }
      if(!dropped)return;
    }
  }
  // The cards that kept their relative order (a longest increasing run of their
  // previous indexes); anything outside it was moved within the sequence.
  function cardsKeepingOrder(cards,indexOf){
    const tails=[],prev=new Array(cards.length);
    cards.forEach((card,i)=>{
      const v=indexOf(card);let lo=0,hi=tails.length;
      while(lo<hi){const mid=(lo+hi)>>1;if(indexOf(cards[tails[mid]])<v)lo=mid+1;else hi=mid;}
      prev[i]=lo>0?tails[lo-1]:-1;tails[lo]=i;
    });
    const out=new Set();for(let i=tails.length?tails[tails.length-1]:-1;i>=0;i=prev[i])out.add(cards[i]);
    return out;
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
    let prefer=root;
    if(data?.instrument==='guitar'&&Number(data?.capo)){i=(i+Number(data.capo)+120)%12;prefer=root.includes('b')?'flat':root.includes('#')?'sharp':null;}
    return {rootIndex:i,minor,prefer};
  }
  // Note names follow the song's key, like Chord Rider: Bb major shows Bb and Eb, not A# and D#.
  function keyTonicLabel(key){
    try{if(core.keyTonicName)return core.keyTonicName(key.rootIndex,key.minor,key.prefer||null);}catch{}
    return NOTE_NAMES[key.rootIndex];
  }
  function keyNoteName(pc,key){
    const p=((Number(pc)%12)+12)%12;
    if(key&&core.spellInKey){try{const n=core.spellInKey(p,{root:keyTonicLabel(key),minor:key.minor});if(n)return n;}catch{}}
    return NOTE_NAMES[p];
  }
  function vocalAutotuneScale(){
    const chord=loadedChord()||parts.find(x=>x.type==='chord')||null;
    const data=chord?.data||core.snapshot();
    const cards=(data?.rows||[]).flat().filter(Boolean);
    const key=harmonyKey(data,cards);
    // No key yet: tune to the nearest note (all 12) rather than not at all.
    if(!key)return {allowedPcs:[0,1,2,3,4,5,6,7,8,9,10,11],label:'No song key yet: tuning to the nearest note (set a key to tune to its scale)'};
    const ints=key.minor?[0,2,3,5,7,8,10]:[0,2,4,5,7,9,11];
    const allowedPcs=ints.map(i=>(key.rootIndex+i)%12);
    return {allowedPcs,label:`Song key: ${keyTonicLabel(key)} ${key.minor?'minor':'major'}`};
  }
  // The Auto-Tune worklet delays both its dry and tuned paths by the same number
  // of samples; vocal clips are started that much early (see startVocalSource).
  const AUTOTUNE_MIN_DELAY=384,AUTOTUNE_DELAY_RANGE=1792,AUTOTUNE_LATENCY_SAMPLES=AUTOTUNE_MIN_DELAY+AUTOTUNE_DELAY_RANGE/2;
  const vocalWorkletLoads=new WeakMap(),vocalWorkletReady=new WeakSet();
  // Loads the vocal worklet module (Auto-Tune and recorder processors) once per context.
  function ensureVocalWorklet(ctx){
    if(!ctx?.audioWorklet||typeof AudioWorkletNode==='undefined')return Promise.resolve(false);
    let promise=vocalWorkletLoads.get(ctx);
    if(!promise){
      promise=ctx.audioWorklet.addModule('./vocal-autotune-worklet.js?v=3.5.0').then(()=>{vocalWorkletReady.add(ctx);return true;},err=>{console.warn('Vocal worklet unavailable',err);return false;});
      vocalWorkletLoads.set(ctx,promise);
    }
    return promise;
  }
  function makeAutotuneNode(ctx,amount){
    if(!(amount>0)||!vocalWorkletReady.has(ctx))return null;
    try{
      // The amount and scale go in at construction: an offline render (WAV export) can finish before a port
      // message reaches the processor, which left exports untuned. Later changes still go by message.
      const allowedPcs=vocalAutotuneScale().allowedPcs||[];
      const node=new AudioWorkletNode(ctx,'crp-vocal-autotune',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1],processorOptions:{minDelay:AUTOTUNE_MIN_DELAY,delayRange:AUTOTUNE_DELAY_RANGE,amount,allowedPcs}});
      node.port.postMessage({amount,allowedPcs});
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
    const riderPcs=window.ScaleRider?.pitchClasses?.();
    if(Array.isArray(riderPcs)&&riderPcs.length){
      notePcs=[...riderPcs];
      for(const pc of chordTonePcs)if(!notePcs.includes(pc))notePcs.push(pc);
    }else if(key){
      const ints=key.minor?[0,2,3,5,7,8,10]:[0,2,4,5,7,9,11];
      notePcs=ints.map(i=>(key.rootIndex+i)%12);
      for(const pc of chordTonePcs)if(!notePcs.includes(pc))notePcs.push(pc);
    }else if(chordTonePcs.length){
      const start=rootPcs[0]??chordTonePcs[0];
      notePcs=[...chordTonePcs].sort((a,b)=>((a-start+12)%12)-((b-start+12)%12));
    }
    return {key,chordName:chord?.name||'Chords',chordLabels,notePcs:uniquePitchClasses(notePcs),chordTonePcs:uniquePitchClasses(chordTonePcs),rootPcs:uniquePitchClasses(rootPcs)};
  }
  window.addEventListener('scale-rider-change',()=>{try{renderLeadHarmony()}catch{}});
  function renderLeadHarmony(){
    const chordsBox=$('leadChordsUsed'),notesBox=$('leadNotesFit'),scaleName=$('leadScaleName');if(!chordsBox||!notesBox)return;
    const activeScale=window.ScaleRider?.active||null;
    if(scaleName){
      if(activeScale?.root&&activeScale?.name){
        const label=`${activeScale.root} ${activeScale.name}`;
        scaleName.textContent=`• ${label}`;
        scaleName.title=label;
        scaleName.hidden=false;
      }else{
        scaleName.textContent='';
        scaleName.removeAttribute('title');
        scaleName.hidden=true;
      }
    }
    const ctx=harmonyContextForLeadBar();chordsBox.innerHTML='';notesBox.innerHTML='';
    if(!ctx.chordLabels.length){const e=document.createElement('span');e.className='lead-harmony-empty';e.textContent='—';chordsBox.appendChild(e);}else{
      for(const name of ctx.chordLabels){const chip=document.createElement('span');chip.className='lead-harmony-chip chord';chip.textContent=name;chip.title=`${ctx.chordName} • Bar ${leadBarPage+1}`;chordsBox.appendChild(chip);}
    }
    if(!ctx.notePcs.length){const e=document.createElement('span');e.className='lead-harmony-empty';e.textContent='—';notesBox.appendChild(e);}else{
      for(const pc of ctx.notePcs){const chip=document.createElement('span');chip.className='lead-harmony-chip note';if(ctx.chordTonePcs.includes(pc))chip.classList.add('chord-tone');if(ctx.rootPcs.includes(pc))chip.classList.add('root-tone');chip.textContent=keyNoteName(pc,ctx.key);chip.title=ctx.rootPcs.includes(pc)?'Chord root':ctx.chordTonePcs.includes(pc)?'Chord tone':'In-key note';notesBox.appendChild(chip);}
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
  // ---- Take storage ----
  // Dry WAVs live in IndexedDB (database crp-vocal-audio-v1, store 'takes', keyed
  // by take id) and, when signed in, in R2 under the saved project. Next to each
  // WAV, under 'meta:<take id>', sits the take's metadata, so a take can be found
  // and attached again even if the project that used it was never saved.
  const vocalDbName='crp-vocal-audio-v1',TAKE_META_PREFIX='meta:';
  function openVocalDb(){return new Promise((resolve,reject)=>{const req=indexedDB.open(vocalDbName,1);req.onupgradeneeded=()=>{if(!req.result.objectStoreNames.contains('takes'))req.result.createObjectStore('takes');};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});}
  async function vocalDbTransaction(mode,work){
    const db=await openVocalDb();
    return new Promise((resolve,reject)=>{
      let result;
      try{
        const tx=db.transaction('takes',mode);
        tx.oncomplete=()=>{db.close();resolve(result);};
        tx.onerror=tx.onabort=()=>{db.close();reject(tx.error||new Error('Could not store the take on this device.'));};
        const req=work(tx.objectStore('takes'));if(req)req.onsuccess=()=>{result=req.result;};
      }catch(err){db.close();reject(err);}
    });
  }
  function vocalDbPut(id,blob,meta){return vocalDbTransaction('readwrite',store=>{store.put(blob,id);store.put(meta,TAKE_META_PREFIX+id);});}
  function vocalDbGet(id){return vocalDbTransaction('readonly',store=>store.get(id)).then(v=>v||null);}
  function vocalDbDelete(id){return vocalDbTransaction('readwrite',store=>{store.delete(id);store.delete(TAKE_META_PREFIX+id);});}
  // Every stored take as {id, meta}; meta is null for WAVs stored by older builds.
  async function vocalDbListTakes(){
    const db=await openVocalDb();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction('takes','readonly'),store=tx.objectStore('takes'),keys=store.getAllKeys(),metas=store.getAll(IDBKeyRange.bound(TAKE_META_PREFIX,TAKE_META_PREFIX+'￿'));
      tx.oncomplete=()=>{
        db.close();
        const byId=new Map((metas.result||[]).filter(m=>m?.id).map(m=>[String(m.id),m]));
        resolve((keys.result||[]).map(String).filter(k=>!k.startsWith(TAKE_META_PREFIX)).map(id=>({id,meta:byId.get(id)||null})));
      };
      tx.onerror=()=>{db.close();reject(tx.error);};
    });
  }
  function takeMeta(take,part){
    return {id:String(take.id),projectId:core.currentProjectId||null,projectName:core.projectName||'',partId:String(part?.id||''),partName:part?.name||'',name:take.name||'Vocal take',duration:Number(take.duration)||0,sampleRate:Number(take.sampleRate)||0,size:Number(take.size)||0,createdAt:take.createdAt||new Date().toISOString(),recordedAtBeat:Number.isFinite(Number(take.recordedAtBeat))?Number(take.recordedAtBeat):null};
  }
  // A take the device refused to store (quota, private browsing, …) is kept in
  // memory: it still plays and uploads, the user is warned, and storing it is
  // retried until it succeeds.
  const unstoredTakes=new Map();let takeStoreRetryTimer=null,takeStoreRetryMs=2000,storagePersistRequested=false;
  async function storeTakeAudio(take,blob,part){
    const id=String(take.id),meta=takeMeta(take,part);
    try{await vocalDbPut(id,blob,meta);unstoredTakes.delete(id);updateTakeStorageNote();return true;}
    catch(err){
      console.warn('Could not store take on this device',err);
      unstoredTakes.set(id,{blob,meta});updateTakeStorageNote(err);retryUnstoredTakes();
      core.status(`${take.name||'The take'} could not be saved on this device yet (${err?.message||'storage error'}). It is kept while this page stays open and saving is being retried.`);
      return false;
    }
  }
  function retryUnstoredTakes(){
    if(takeStoreRetryTimer||!unstoredTakes.size)return;
    takeStoreRetryTimer=setTimeout(async()=>{
      takeStoreRetryTimer=null;
      for(const [id,{blob,meta}] of [...unstoredTakes]){try{await vocalDbPut(id,blob,meta);unstoredTakes.delete(id);}catch{}}
      if(unstoredTakes.size){takeStoreRetryMs=Math.min(60000,takeStoreRetryMs*2);retryUnstoredTakes();}
      else{takeStoreRetryMs=2000;core.status('Vocal takes are now saved on this device.');}
      updateTakeStorageNote();
      const a=active();if(a?.type==='vocal')renderVocalTakes(a);
    },takeStoreRetryMs);
  }
  let takeStorageNoteDefault=null;
  function updateTakeStorageNote(err=null){
    const note=$('vocalStorageNote');if(!note)return;
    if(takeStorageNoteDefault===null)takeStorageNoteDefault=note.textContent;
    const n=unstoredTakes.size;
    note.textContent=n?`⚠ ${n} take${n===1?'':'s'} not saved on this device yet${err?.message?` (${err.message})`:''}. Keep this page open while it retries, or download the WAV.`:takeStorageNoteDefault;
    note.classList.toggle('is-warning',n>0);
  }
  window.addEventListener('beforeunload',e=>{if(unstoredTakes.size){e.preventDefault();e.returnValue='';}});
  function requestPersistentStorage(){
    if(storagePersistRequested)return;storagePersistRequested=true;
    try{navigator.storage?.persist?.().catch(()=>{});}catch{}
  }
  async function localTakeBlob(id){return unstoredTakes.get(String(id))?.blob||await vocalDbGet(String(id)).catch(()=>null);}
  // All records of one take across the project's vocal parts (duplicated tracks share takes).
  function takeRecords(id){return allVocalParts().flatMap(p=>(p.recordings||[]).filter(r=>String(r.id)===String(id)));}
  function markTakeInCloud(id,projectId){for(const r of takeRecords(id)){r.cloud=true;r.cloudProjectId=projectId;}}
  async function cloudAudioRequest(takeId,projectId,options={}){
    if(!core.loggedIn||!projectId)throw new Error('Sign in and save the project before cloud audio can sync.');
    const r=await fetch(`/api/audio/${encodeURIComponent(takeId)}?projectId=${encodeURIComponent(projectId)}`,{credentials:'same-origin',...options});
    if(!r.ok){let msg='Cloud audio request failed.';try{const d=await r.json();msg=d.error||msg;}catch{}throw new Error(msg);}return r;
  }
  async function uploadTakeToCloud(take,blob,projectId=core.currentProjectId){
    if(!blob||!core.loggedIn||!projectId)return false;
    await cloudAudioRequest(take.id,projectId,{method:'PUT',headers:{'Content-Type':'audio/wav'},body:blob});take.cloud=true;take.cloudProjectId=projectId;markTakeInCloud(take.id,projectId);return true;
  }
  async function getTakeBlob(take,projectId=core.currentProjectId){
    const local=await localTakeBlob(take.id);if(local)return local;
    if(core.loggedIn&&projectId){try{const r=await cloudAudioRequest(take.id,projectId);const blob=await r.blob();markTakeInCloud(take.id,projectId);take.cloud=true;take.cloudProjectId=projectId;await storeTakeAudio(take,blob,findVocalTake(take.id)?.part);return blob;}catch(e){console.warn('Cloud take unavailable',e);}}
    return null;
  }
  async function deleteTakeCloud(take,projectId=take.cloudProjectId||core.currentProjectId){if(!core.loggedIn||!projectId)return;try{await cloudAudioRequest(take.id,projectId,{method:'DELETE'});}catch(e){console.warn('Could not delete cloud take',e);}}
  async function syncCloudAudio(projectId=core.currentProjectId){
    if(!core.loggedIn||!projectId)return {uploaded:0,pending:0};let uploaded=0,pending=0,lastError=null;const done=new Set();
    for(const p of allVocalParts())for(const take of p.recordings||[]){
      const id=String(take.id);
      if(done.has(id)||(take.cloud&&take.cloudProjectId===projectId))continue;
      done.add(id);
      const blob=await localTakeBlob(id);if(!blob){pending++;continue;}
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
  // The take list. A take's button tells what the track plays: "Using" (the
  // active take, on the timeline), "In mix" (another take still on it) or "Use".
  async function renderVocalTakes(p){
    const box=$('vocalTakes');if(!box)return;box.innerHTML='';
    refreshRecoverTakesUi();scheduleRecoverCheck();
    if(!p.recordings.length){box.innerHTML='<div class="vocal-empty">No takes yet. Put on headphones and tap Record.</div>';return;}
    const audible=new Set(voxTrackEvents(p).map(e=>String(e.takeId)));
    for(const take of [...p.recordings].reverse()){
      const onTimeline=audible.has(String(take.id)),using=onTimeline&&p.activeTakeId===take.id,unstored=unstoredTakes.has(String(take.id));
      const row=document.createElement('div');row.className='vocal-take'+(using?' active':'');
      const main=document.createElement('div');main.className='vocal-take-main';
      const badge=unstored?'<span class="cloud-badge pending">⚠ Not saved</span>':`<span class="cloud-badge ${take.cloud?'':'pending'}">${take.cloud?'☁ Cloud':'Device'}</span>`;
      main.innerHTML=`<div class="vocal-take-name">${escapeHtml(take.name||'Vocal take')}${badge}</div><div class="vocal-take-meta">${fmtTime(take.duration)} • ${take.sampleRate||48000} Hz WAV • ${new Date(take.createdAt).toLocaleString()}</div>`;
      const use=document.createElement('button');use.type='button';use.className='take-use';
      use.textContent=using?'Using':onTimeline?'In mix':'Use';
      use.title=using?'This take is playing on this track':onTimeline?'Part of this take still plays on the timeline. Tap to make it the take this track plays.':'Make this the take this track plays';
      use.onclick=()=>{if(!using)chooseTake(p,take);};
      const play=document.createElement('button');play.type='button';play.textContent='▶';play.title='Preview take';play.onclick=()=>previewTake(p,take);
      const dl=document.createElement('button');dl.type='button';dl.className='take-download';dl.textContent='↓ WAV';dl.onclick=()=>downloadTake(take);
      const del=document.createElement('button');del.type='button';del.className='take-delete';del.textContent='×';del.title='Delete take';del.onclick=()=>deleteTake(p,take);
      row.append(main,use,play,dl,del);box.appendChild(row);
    }
  }
  function chooseTake(p,take){
    useTake(p,take);
    if($('vocalTranscript'))$('vocalTranscript').value=p.transcript||'';
    renderVocalTakes(p);if(voxBoxOpen)renderVoxBox();markPartsDirty();core.scheduleAutoSave();
  }
  // Deleting removes the take and its clips from this track. Its audio is only
  // deleted when nothing else uses it: no other track of this project (R2 keys
  // are per project) and, for this device's copy, no other saved project.
  async function deleteTake(p,take){
    if(!confirm(`Delete “${take.name}”?`))return;
    stopPreview();
    const id=String(take.id);
    p.recordings=p.recordings.filter(r=>String(r.id)!==id);
    p.voxEvents=(p.voxEvents||[]).filter(e=>String(e.takeId)!==id);
    if(p.activeTakeId===take.id)p.activeTakeId=p.recordings.at(-1)?.id||null;
    voxSelections=voxSelections.filter(s=>parts.some(x=>String(x.id)===String(s.partId)&&(x.voxEvents||[]).some(e=>String(e.id)===String(s.eventId))));voxSelected=voxSelections[0]||null;
    if(!projectTakeIds().has(id)){
      forgetTakeBuffer(id);
      await deleteTakeCloud(take);
      if(!otherLocalProjectTakes().has(id)){unstoredTakes.delete(id);await vocalDbDelete(id).catch(()=>{});}
    }
    renderVocalTakes(p);if(voxBoxOpen)renderVoxBox();markPartsDirty();core.scheduleAutoSave();core.flushAutoSaveNow?.();
  }
  function projectTakeIds(){
    const ids=new Set();
    for(const p of allVocalParts()){for(const r of p.recordings||[])ids.add(String(r.id));for(const e of p.voxEvents||[])ids.add(String(e.takeId));}
    return ids;
  }
  // take id -> project name, for every other project saved on this device.
  function otherLocalProjectTakes(){
    const out=new Map();let projects=[];
    try{projects=JSON.parse(localStorage.getItem('crp-projects')||'[]');}catch{}
    for(const project of Array.isArray(projects)?projects:[]){
      if(!project||String(project.id)===String(core.currentProjectId||''))continue;
      for(const part of project.parts?.items||[]){
        if(part?.type!=='vocal')continue;
        for(const r of part.recordings||[])out.set(String(r.id),project.name||'Untitled Project');
        for(const e of part.voxEvents||[])out.set(String(e.takeId),project.name||'Untitled Project');
      }
    }
    return out;
  }

  // ---- Recover takes ----
  // Takes stored on this device that no part of the current project uses: from a
  // project that was never saved, a deleted track, or another project. Nothing
  // here deletes audio; the user can attach any of them to a vocal track.
  const RECOVER_DISMISSED_KEY='crp-vocal-recover-dismissed-v1';
  // The banner is offered when a project is opened, not after in-session edits.
  let recoverCheckTimer=null,unattachedTakes=[],recoverBannerArmed=false;
  async function findUnattachedTakes(){
    let stored=[];try{stored=await vocalDbListTakes();}catch{return [];}
    for(const [id,{meta}] of unstoredTakes)if(!stored.some(t=>t.id===id))stored.push({id,meta});
    const here=projectTakeIds(),elsewhere=otherLocalProjectTakes();
    const created=t=>String(t.meta?.createdAt||'');
    return stored.filter(t=>!here.has(t.id)).map(t=>({...t,otherProject:elsewhere.get(t.id)||null})).sort((a,b)=>created(b).localeCompare(created(a)));
  }
  function scheduleRecoverCheck({banner=false}={}){
    if(banner)recoverBannerArmed=true;
    clearTimeout(recoverCheckTimer);recoverCheckTimer=setTimeout(async()=>{unattachedTakes=await findUnattachedTakes();refreshRecoverTakesUi();},banner?1200:300);
  }
  function dismissedRecoverIds(){try{return new Set(JSON.parse(localStorage.getItem(RECOVER_DISMISSED_KEY)||'[]'));}catch{return new Set();}}
  function refreshRecoverTakesUi(){
    const orphaned=unattachedTakes.filter(t=>!t.otherProject),dismissed=dismissedRecoverIds(),fresh=orphaned.filter(t=>!dismissed.has(t.id));
    // A banner for takes no project uses at all (e.g. an unsaved project was lost).
    let banner=$('vocalRecoverBanner');
    if(recoverBannerArmed&&fresh.length&&!voxBoxOpen){
      const host=$('partManager');
      if(host&&!banner){
        banner=document.createElement('div');banner.id='vocalRecoverBanner';banner.className='vocal-panel';banner.setAttribute('role','status');
        banner.style.cssText='display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:8px 0;padding:10px 12px;';
        banner.innerHTML='<span class="vocal-recover-text" style="flex:1 1 220px"></span><button type="button" data-recover>Recover takes</button><button type="button" data-dismiss>Not now</button>';
        banner.querySelector('[data-recover]').onclick=openRecoverTakesDialog;
        banner.querySelector('[data-dismiss]').onclick=()=>{try{localStorage.setItem(RECOVER_DISMISSED_KEY,JSON.stringify([...dismissedRecoverIds(),...unattachedTakes.filter(t=>!t.otherProject).map(t=>t.id)]));}catch{}recoverBannerArmed=false;refreshRecoverTakesUi();};
        host.prepend(banner);
      }
      if(banner)banner.querySelector('.vocal-recover-text').textContent=`${fresh.length} vocal take${fresh.length===1?' is':'s are'} saved on this device but not in any project.`;
    }else banner?.remove();
    // In the Takes panel, a way to attach any take this project does not use.
    const heading=$('vocalTakes')?.closest('.vocal-panel')?.querySelector('.vocal-panel-heading');
    if(heading){
      let btn=$('vocalRecoverTakesBtn');
      if(!btn){btn=document.createElement('button');btn.type='button';btn.id='vocalRecoverTakesBtn';btn.onclick=openRecoverTakesDialog;heading.appendChild(btn);}
      btn.hidden=!unattachedTakes.length;btn.textContent=`Recover takes (${unattachedTakes.length})`;
    }
  }
  function closeRecoverTakesDialog(){document.getElementById('vocalRecoverDialog')?.remove();}
  function openRecoverTakesDialog(){
    closeRecoverTakesDialog();if(!unattachedTakes.length){core.status('No other takes are stored on this device.');return;}
    const target=active()?.type==='vocal'?active():allVocalParts()[0]||null;
    const rows=unattachedTakes.map(t=>{const m=t.meta||{},when=m.createdAt?new Date(m.createdAt).toLocaleString():'unknown date',from=t.otherProject?`In project “${t.otherProject}”`:m.projectName?`Recorded in “${m.projectName}”, not saved in any project`:'Not in any project';return `<label class="studio-export-row"><input type="checkbox" data-recover-take="${escapeHtml(t.id)}" ${t.otherProject?'':'checked'}><span><strong>${escapeHtml(m.name||'Vocal take')}</strong> • ${m.duration?fmtTime(m.duration):'length unknown'}<br><span class="subtle tiny">${escapeHtml(from)} • ${escapeHtml(when)}</span></span></label>`;}).join('');
    const modal=document.createElement('div');modal.id='vocalRecoverDialog';modal.className='studio-export-modal';
    modal.innerHTML=`<div class="studio-export-backdrop"></div><div class="studio-export-card"><h2>Recover takes</h2><p class="subtle">These dry takes are stored on this device but not used by this project. Attach the ones you want to ${target?`“${escapeHtml(target.name)}”`:'a new vocal track'}.</p><div class="studio-export-list">${rows}</div><div class="studio-export-actions"><button type="button" data-cancel>Cancel</button><button type="button" class="accent" data-attach>Attach</button></div></div>`;
    document.body.appendChild(modal);
    modal.querySelector('.studio-export-backdrop').onclick=closeRecoverTakesDialog;modal.querySelector('[data-cancel]').onclick=closeRecoverTakesDialog;
    modal.querySelector('[data-attach]').onclick=async()=>{
      const ids=[...modal.querySelectorAll('[data-recover-take]:checked')].map(x=>x.dataset.recoverTake);
      if(!ids.length){core.status('Choose at least one take to attach.');return;}
      closeRecoverTakesDialog();await attachRecoveredTakes(ids.map(id=>unattachedTakes.find(t=>t.id===id)).filter(Boolean));
    };
  }
  async function attachRecoveredTakes(list){
    let p=active()?.type==='vocal'?active():allVocalParts()[0]||null;
    if(!p){p=vocalPart(`Vocals ${countType('vocal')+1}`);parts.push(p);}
    // Oldest first, like recorded takes; the newest becomes the one that plays.
    for(const t of [...list].reverse()){
      const m=t.meta||await legacyTakeMeta(t.id);
      if(!p.recordings.some(r=>String(r.id)===t.id))p.recordings.push({id:t.id,name:m.name||'Recovered take',createdAt:m.createdAt||new Date().toISOString(),duration:Number(m.duration)||0,sampleRate:Number(m.sampleRate)||48000,size:Number(m.size)||0,...(m.recordedAtBeat!=null?{recordedAtBeat:m.recordedAtBeat}:{})});
    }
    if(!voxTrackEvents(p).length){const first=p.recordings.find(r=>String(r.id)===list[0].id);if(first)useTake(p,first);}
    unattachedTakes=unattachedTakes.filter(t=>!list.includes(t));recoverBannerArmed=false;
    markPartsDirty();selectPart(p.id);if(voxBoxOpen)renderVoxBox();core.scheduleAutoSave();
    core.status(`${list.length} take${list.length===1?'':'s'} attached to ${p.name}.`);
  }
  // WAVs stored by older builds have no metadata: read length and rate from the header.
  async function legacyTakeMeta(id){
    try{
      const blob=await localTakeBlob(id),head=new DataView(await blob.slice(0,44).arrayBuffer()),rate=head.getUint32(24,true),bytesPerSec=head.getUint32(28,true);
      return {name:'Recovered take',sampleRate:rate,size:blob.size,duration:bytesPerSec?Math.max(0,blob.size-44)/bytesPerSec:0};
    }catch{return {name:'Recovered take'};}
  }
  function renderVocalEditor(p=active()){
    if(!p||p.type!=='vocal')return;$('vocalPartTitle').textContent=p.name;if($('vocalTranscript'))$('vocalTranscript').value=p.transcript||'';if($('vocalRepeat'))$('vocalRepeat').checked=p.repeat!==false;$('vocalVolume').value=Math.round(p.volume*100);$('vocalVolumeValue').textContent=`${Math.round(p.volume*100)}%`;renderVocalBacking(p);$('vocalBackingDrums').checked=p.backingDrums!==false;$('vocalBackingVolume').value=Math.round((p.backingVolume??.8)*100);$('vocalBackingVolumeValue').textContent=`${Math.round((p.backingVolume??.8)*100)}%`;$('vocalFxEq').value=p.fx?.eq||'clear';$('vocalFxComp').value=p.fx?.comp||'medium';$('vocalFxReverb').value=String(p.fx?.reverb??.12);$('vocalFxDelay').value=String(p.fx?.delay||0);if($('vocalFxAutotune'))$('vocalFxAutotune').value=String(Math.round(Number(p.fx?.autotune)||0));paintAutotuneSlider();if($('vocalFxAutotuneValue'))$('vocalFxAutotuneValue').textContent=`${Math.round(Number(p.fx?.autotune)||0)}%`;if($('vocalAutotuneKey'))$('vocalAutotuneKey').textContent=vocalAutotuneScale().label;renderVocalTakes(p);updatePartPlaybackButtons();
  }
  async function ensureMic(){
    if(micStream?.active)return micStream;if(!navigator.mediaDevices?.getUserMedia)throw new Error('Microphone recording is not available in this browser.');
    micStream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,sampleRate:{ideal:48000},sampleSize:{ideal:24},echoCancellation:false,noiseSuppression:false,autoGainControl:false}});
    micCtx=new (window.AudioContext||window.webkitAudioContext)({sampleRate:48000});if(micCtx.state==='suspended')await micCtx.resume();micSource=micCtx.createMediaStreamSource(micStream);micAnalyser=micCtx.createAnalyser();micAnalyser.fftSize=1024;micAnalyser.smoothingTimeConstant=.72;micSource.connect(micAnalyser);startMicMeter();const track=micStream.getAudioTracks()[0];const st=track.getSettings?.()||{};$('vocalMicInfo').textContent=`${track.label||'Phone microphone'} • ${st.sampleRate||micCtx.sampleRate} Hz${st.channelCount?` • ${st.channelCount} ch`:''}`;if($('vocalArmMic')){$('vocalArmMic').textContent='Mic test off';$('vocalArmMic').setAttribute('aria-pressed','true');}return micStream;
  }
  async function disableMic(){
    if(recording)return;cancelAnimationFrame(micMeterRaf);micMeterRaf=0;try{micSource?.disconnect();}catch{}try{micAnalyser?.disconnect();}catch{}for(const t of micStream?.getTracks?.()||[])try{t.stop();}catch{}micStream=null;micSource=null;micAnalyser=null;try{await micCtx?.close();}catch{}micCtx=null;if($('vocalMicMeter'))$('vocalMicMeter').style.width='0%';if($('vocalMicDb'))$('vocalMicDb').textContent='— dB';if($('vocalMicInfo'))$('vocalMicInfo').textContent='Mic test off.';if($('vocalArmMic')){$('vocalArmMic').textContent='Mic check';$('vocalArmMic').setAttribute('aria-pressed','false');}
  }
  function startMicMeter(){cancelAnimationFrame(micMeterRaf);const data=new Float32Array(micAnalyser?.fftSize||1024);const tick=()=>{if(!micAnalyser)return;micAnalyser.getFloatTimeDomainData(data);let sum=0,peak=0;for(const v of data){sum+=v*v;peak=Math.max(peak,Math.abs(v));}const rms=Math.sqrt(sum/data.length),db=rms>0?20*Math.log10(rms):-90,pct=Math.max(0,Math.min(100,(db+60)/60*100));if($('vocalMicMeter'))$('vocalMicMeter').style.width=`${pct}%`;if($('vocalMicDb'))$('vocalMicDb').textContent=db<=-89?'— dB':`${db.toFixed(1)} dB`;micMeterRaf=requestAnimationFrame(tick);};tick();}
  function floatToWav(chunks,sampleRate){
    const length=chunks.reduce((n,a)=>n+a.length,0),samples=new Float32Array(length);let o=0;
    for(const a of chunks){samples.set(a,o);o+=a.length;}
    const buffer=new ArrayBuffer(44+samples.length*2),view=new DataView(buffer),write=(off,str)=>{for(let i=0;i<str.length;i++)view.setUint8(off+i,str.charCodeAt(i));};write(0,'RIFF');view.setUint32(4,36+samples.length*2,true);write(8,'WAVE');write(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,sampleRate,true);view.setUint32(28,sampleRate*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);write(36,'data');view.setUint32(40,samples.length*2,true);let pos=44;for(let i=0;i<samples.length;i++){let x=Math.max(-1,Math.min(1,samples[i]));view.setInt16(pos,x<0?x*0x8000:x*0x7fff,true);pos+=2;}return new Blob([buffer],{type:'audio/wav'});
  }

  // ---- Recording ----
  // Capture runs in the mic's own context behind a gate that opens and closes
  // at exact mic-clock times. Those times are where the backing beat is *sung*:
  // when it is heard (playback output latency) plus the time the voice takes to
  // reach the capture (the input track's reported latency) plus the user's
  // calibration offset. Sample 0 of a take is therefore the downbeat it was sung
  // on, and pause/resume joins without shifting. Recorder: AudioWorklet, with a
  // ScriptProcessor fallback.
  const RECORD_OFFSET_KEY='crp-vocal-record-offset-ms-v1';
  function recordOffsetMs(){try{const v=Number(localStorage.getItem(RECORD_OFFSET_KEY));return Number.isFinite(v)?Math.max(-500,Math.min(500,v)):0;}catch{return 0;}}
  function recordLatencySec(){
    const output=(Number(audioCtx?.outputLatency)||0)+(Number(audioCtx?.baseLatency)||0);
    const input=Number(micStream?.getAudioTracks?.()[0]?.getSettings?.().latency)||0;
    return output+input+recordOffsetMs()/1000;
  }
  // Each context's currentTime advances in render-callback steps, so a single
  // reading of both clocks is off by up to a callback each. While recording they
  // are read together every 20 ms; the median difference is used.
  let clockOffsets=[],clockTimer=null;
  function sampleClockOffset(){if(!micCtx||!audioCtx)return;clockOffsets.push(micCtx.currentTime-audioCtx.currentTime);if(clockOffsets.length>31)clockOffsets.shift();}
  function trackRecordingClocks(on){clearInterval(clockTimer);clockTimer=null;clockOffsets=[];if(on){sampleClockOffset();clockTimer=setInterval(sampleClockOffset,20);}}
  function playbackToMicOffset(){sampleClockOffset();const sorted=[...clockOffsets].sort((a,b)=>a-b);return sorted[sorted.length>>1];}
  // The mic-context time at which sound the playback context renders at
  // `audioTime` is sung into the mic.
  function micTimeForPlaybackTime(audioTime){return (audioCtx?audioTime+playbackToMicOffset():micCtx.currentTime)+recordLatencySec();}
  function micTimeSungNow(){return micTimeForPlaybackTime(audioCtx?audioCtx.currentTime:0);}
  const delay=ms=>new Promise(r=>setTimeout(r,ms));
  // The take is cut from the mic stream by open/close spans (micCtx times). A
  // span may open or close up to a second in the past (a negative calibration
  // offset, clock jitter), so recently rejected audio is kept to recover from.
  function createTakeGate(sampleRate){
    const kept=[],recent=[],lookBack=sampleRate;
    let openFrame=Infinity,closeFrame=Infinity,isOpen=false,endFrame=0,nextFrame=Infinity;
    // Frames the gate never received (before capture began, a dropped block)
    // become silence, so every kept sample stays at its time in the take.
    const keep=(frame,samples)=>{
      if(!samples.length)return;
      const gap=Math.min(lookBack,frame-nextFrame);
      if(gap>0)kept.push({frame:frame-gap,samples:new Float32Array(gap)});
      kept.push({frame,samples});nextFrame=frame+samples.length;
    };
    const reject=(frame,samples)=>{
      if(samples.length)recent.push({frame,samples});
      while(recent.length&&recent[0].frame+recent[0].samples.length<endFrame-lookBack)recent.shift();
    };
    return {
      get endTime(){return endFrame/sampleRate;},
      add(frame,samples){
        endFrame=Math.max(endFrame,frame+samples.length);
        for(let i=0;i<samples.length;){
          const f=frame+i,inside=f>=openFrame&&f<closeFrame,boundary=inside?closeFrame:f<openFrame?openFrame:Infinity;
          const end=Math.min(samples.length,Math.max(i+1,boundary-frame)),piece=samples.subarray(i,end);
          if(inside)keep(f,piece);else reject(f,piece);
          i=end;
        }
      },
      open(at){
        openFrame=Math.round(at*sampleRate);closeFrame=Infinity;isOpen=true;nextFrame=openFrame;
        for(const {frame,samples} of recent.splice(0)){
          const cut=Math.max(0,Math.min(samples.length,openFrame-frame));
          if(cut)recent.push({frame,samples:samples.subarray(0,cut)});
          keep(frame+cut,samples.subarray(cut));
        }
      },
      close(at){
        if(!isOpen)return;
        closeFrame=Math.round(at*sampleRate);isOpen=false;
        const back=[];
        while(kept.length){
          const last=kept[kept.length-1];
          if(last.frame>=closeFrame){back.unshift(kept.pop());continue;}
          const n=closeFrame-last.frame;
          if(n<last.samples.length){back.unshift({frame:closeFrame,samples:last.samples.subarray(n)});last.samples=last.samples.subarray(0,n);}
          break;
        }
        for(const b of back)reject(b.frame,b.samples);
      },
      samples(){return kept.map(k=>k.samples);}
    };
  }
  // {open(at), close(at), finish(at) -> Float32Array[]}: the mic stream through a
  // take gate. AudioWorklet recorder (frame-stamped blocks), or a ScriptProcessor
  // whose block times are estimated from playbackTime.
  async function createRecorder(){
    const rate=micCtx.sampleRate,gate=createTakeGate(rate),sink=micCtx.createGain();
    sink.gain.value=0;sink.connect(micCtx.destination);
    let stopStream=null;
    if(await ensureVocalWorklet(micCtx)){
      try{
        const node=new AudioWorkletNode(micCtx,'crp-vocal-recorder',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1]});
        let streamEnded=()=>{};
        node.port.onmessage=e=>{if(e.data?.type==='audio')gate.add(e.data.frame,e.data.samples);else if(e.data?.type==='done')streamEnded();};
        micSource.connect(node);node.connect(sink);
        stopStream=async()=>{
          // The final partial block arrives just before 'done'.
          const ended=new Promise(r=>{streamEnded=r;});node.port.postMessage({type:'stop'});
          await Promise.race([ended,delay(500)]);
          node.port.onmessage=null;try{micSource.disconnect(node);node.disconnect();}catch{}
        };
      }catch(err){console.warn('Recorder worklet unavailable; using ScriptProcessor',err);}
    }
    if(!stopStream){
      const proc=micCtx.createScriptProcessor(4096,1,1);
      proc.onaudioprocess=e=>{const input=e.inputBuffer.getChannelData(0);gate.add(Math.round(e.playbackTime*rate)-input.length,new Float32Array(input));};
      micSource.connect(proc);proc.connect(sink);
      stopStream=()=>{proc.onaudioprocess=null;try{micSource.disconnect(proc);proc.disconnect();}catch{}};
    }
    return {
      open:at=>gate.open(at),
      close:at=>gate.close(at),
      async finish(at){
        gate.close(at);
        const deadline=performance.now()+Math.max(0,at-micCtx.currentTime)*1000+1500;
        while(gate.endTime<at&&performance.now()<deadline)await delay(30);
        await stopStream();try{sink.disconnect();}catch{}
        return gate.samples();
      }
    };
  }
  // Seconds captured so far (for the timer and Track Master's playhead).
  function recordedSeconds(){return recordedSec+(recordOpenedAtPerf!=null?Math.max(0,(performance.now()-recordOpenedAtPerf)/1000):0);}
  // Starts the backing at `beat` (muted per the recording scope, which only
  // affects what is heard) and opens the gate where that beat is sung. Returns
  // false if recording was stopped meanwhile.
  async function startBackingAndCapture(beat){
    // Past the song end there is no backing left; the take just continues.
    if(beat<mediaDurationBeats()-.001)await startPlayback({fromBeat:beat,scope:clone(recordScope)});
    if(!recording||!recorder)return false;
    let backing=!!((playing||starting)&&audioCtx&&playbackClockStartAudioTime);
    // The chosen backing parts may end before `beat`; playback would then wrap
    // to the song start, which is not where this take is.
    if(backing&&Math.abs(playbackClockStartBeat-beat)>1e-6){stopPlayback();backing=false;}
    const openAt=backing?micTimeForPlaybackTime(playbackClockStartAudioTime):micTimeSungNow();
    recorder.open(openAt);
    recordOpenedAtPerf=performance.now()+Math.max(0,openAt-micCtx.currentTime)*1000;
    return true;
  }
  function stopCaptureClock(){if(recordOpenedAtPerf!=null){recordedSec=recordedSeconds();recordOpenedAtPerf=null;}}
  async function beginRecording(options={}){
    const requestedPartId=options?.partId||null;
    if(requestedPartId){const rp=parts.find(x=>x.type==='vocal'&&String(x.id)===String(requestedPartId));if(rp)activePartId=rp.id;}
    const p=active();if(!p||p.type!=='vocal'||recording)return;
    const fromVox=!!options?.voxBox;
    try{
      requestPersistentStorage();stopPreview();await ensureMic();stopPlayback();
      recorder=await createRecorder();trackRecordingClocks(true);
      recordTargetPartId=p.id;recordStartedFromVox=fromVox;recordedSec=0;recordOpenedAtPerf=null;
      // The vocal part's backing choices become a playback scope. Nothing in the
      // parts or the drum settings changes, so autosave cannot store them.
      const backingGain=Math.max(0,Math.min(1,Number(p.backingVolume??.8)));
      recordScope={kind:'record',ownerId:p.id,playableIds:(p.backingPartIds||[]).filter(id=>parts.some(x=>x.id===id&&(x.type==='chord'||x.type==='lead'))),vocalIds:allVocalParts().filter(x=>x.enabled).map(x=>x.id),drums:p.backingDrums!==false,backingGain,drumGain:backingGain};
      recording=true;recordingPaused=false;recordingResuming=false;
      if($('vocalSpeechStatus'))$('vocalSpeechStatus').textContent='Recording clean WAV. Cloud transcription runs after the take is saved.';
      if($('vocalRecordBtn')){$('vocalRecordBtn').classList.add('recording');$('vocalRecordBtn').disabled=true;}
      if($('vocalStopBtn'))$('vocalStopBtn').disabled=false;
      recordInsertBeat=recordResumeBeat=Math.max(effectiveSongStartBeat(),Number(options?.fromBeat)||0);
      if(!await startBackingAndCapture(recordInsertBeat))return;
      recordTimer=setInterval(()=>{if($('vocalTimer'))$('vocalTimer').textContent=fmtTime(recordedSeconds());updateVoxTransportState();},100);
      if(fromVox){voxTargetPartId=p.id;updateVoxPlayhead(recordInsertBeat,true);voxStatus(`Recording into ${p.name} from beat ${recordInsertBeat.toFixed(2)}…`);}
      core.status('Recording dry WAV in beat sync. Use headphones so the backing does not bleed into the mic.');updateVoxTransportState();
    }catch(e){
      console.error(e);core.status(e.message||'Could not start microphone.');
      if(recorder)await recorder.finish(micCtx?.currentTime??0).catch(()=>{});
      recorder=null;recording=false;recordScope=null;recordStartedFromVox=false;recordTargetPartId=null;trackRecordingClocks(false);
      if($('vocalRecordBtn')){$('vocalRecordBtn').classList.remove('recording');$('vocalRecordBtn').disabled=false;}
      if($('vocalStopBtn'))$('vocalStopBtn').disabled=true;
      updateVoxTransportState();
    }
  }
  async function endRecording(){
    const p=parts.find(x=>x.type==='vocal'&&String(x.id)===String(recordTargetPartId))||active();if(!p||p.type!=='vocal'||!recording||!recorder)return;
    const wasVox=recordStartedFromVox,insertBeat=recordInsertBeat,rec=recorder;
    // Everything sung up to the beat being heard now is part of the take.
    const stopAt=recordingPaused?micCtx.currentTime:micTimeSungNow();
    stopCaptureClock();
    recording=false;recordingPaused=false;recordingResuming=false;clearInterval(recordTimer);recordTimer=null;recorder=null;recordScope=null;
    if($('vocalRecordBtn')){$('vocalRecordBtn').classList.remove('recording');$('vocalRecordBtn').disabled=false;}
    if($('vocalStopBtn'))$('vocalStopBtn').disabled=true;
    stopPlayback();
    let chunks=await rec.finish(stopAt);trackRecordingClocks(false);
    const rate=micCtx.sampleRate,frames=chunks.reduce((n,a)=>n+a.length,0),duration=frames/rate;
    if($('vocalTimer'))$('vocalTimer').textContent=fmtTime(duration);
    try{
      if(duration<.25){core.status('Recording was too short.');return;}
      const blob=floatToWav(chunks,rate),id=uid(),take={id,name:`Take ${p.recordings.length+1}`,createdAt:new Date().toISOString(),duration,sampleRate:rate,size:blob.size,recordedAtBeat:insertBeat};
      chunks=null;
      // The take joins the part even if this device refuses to store it: it is
      // then kept in memory and storing is retried (storeTakeAudio).
      p.recordings.push(take);
      const stored=await storeTakeAudio(take,blob,p);
      if(wasVox)voxCheckpoint();
      const ev=placeRecordedTake(p,take);
      if(wasVox){voxSelections=[{partId:p.id,eventId:ev.id}];voxSelected=voxSelections[0];voxTargetPartId=p.id;voxInstrumentSelections=[];voxInstrumentSelection=null;}
      markPartsDirty();core.scheduleAutoSave();await renderVocalTakes(p);
      if(voxBoxOpen){renderVoxBox();updateVoxPlayhead(insertBeat,true);voxStatus(`${take.name} recorded onto ${p.name} at beat ${insertBeat.toFixed(2)}.`);}
      if(core.loggedIn&&core.currentProjectId){try{if($('vocalSpeechStatus'))$('vocalSpeechStatus').textContent='Uploading and transcribing new take…';await uploadTakeToCloud(take,blob,core.currentProjectId);await transcribeTake(p,take,{quiet:true});core.status(`Saved ${take.name} to cloud and transcribed it.`);}catch(te){console.warn('Automatic cloud transcription pending',te);if($('vocalSpeechStatus'))$('vocalSpeechStatus').textContent=`Take is safe. ${te.message||'Tap Transcribe active take after saving.'}`;core.status(`Saved ${take.name}. Cloud transcription can be retried with Transcribe active take.`);}}else if(stored){if($('vocalSpeechStatus'))$('vocalSpeechStatus').textContent='Take is safe. Save/sign in, then tap Transcribe active take.';core.status(core.loggedIn?`Saved ${take.name} locally. Save the project to enable cloud transcription.`:`Saved ${take.name} locally. Sign in and save to use cloud transcription.`);}
    }catch(e){console.error(e);core.status(`The take was recorded, but saving it failed: ${e.message||e}`);}
    finally{recordStartedFromVox=false;recordTargetPartId=null;recordInsertBeat=0;recordResumeBeat=0;updateVoxTransportState();}
  }
  async function toggleRecordingPause(){
    if(!recording||!recorder)return false;
    if(!recordingPaused){
      // The take pauses at the beat being heard now; resuming restarts the
      // backing on that beat and opens the gate where it is sung.
      recordResumeBeat=currentCycleBeat()??recordInsertBeat+recordedSeconds()*songBpm()/60;
      recorder.close(micTimeSungNow());stopCaptureClock();
      recordingPaused=true;
      if(recordStartedFromVox)updateVoxPlayhead(recordResumeBeat,false);
      stopPlayback();
      core.status('Recording paused.');
    }else{
      if(recordingResuming)return true;
      recordingResuming=true;
      core.status('Resuming recording on the backing downbeat…');
      try{
        if(await startBackingAndCapture(Math.max(0,Number(recordResumeBeat)||0)))core.status('Recording resumed in beat sync.');
      }catch(e){
        console.warn('Could not resume backing playback',e);
        if(recorder){recorder.open(micTimeSungNow());recordOpenedAtPerf=performance.now();core.status('Recording resumed without backing.');}
      }finally{recordingPaused=false;recordingResuming=false;}
    }
    updateVoxTransportState();
    return recordingPaused;
  }
  // "Recording offset (ms)": a per-device calibration added to the measured
  // latency. Positive values move takes earlier.
  function ensureRecordOffsetControl(){
    const info=$('vocalMicInfo');if(!info||$('vocalRecordOffset'))return;
    const label=document.createElement('label');label.className='vocal-playback-level vocal-record-offset';
    label.title='If takes land late against the backing, raise this; if early, lower it. Saved on this device.';
    label.innerHTML='Recording offset (ms) <input id="vocalRecordOffset" type="number" min="-500" max="500" step="1" inputmode="numeric" style="width:5.5em">';
    info.after(label);
    const input=$('vocalRecordOffset');input.value=String(recordOffsetMs());
    input.onchange=()=>{const v=Math.max(-500,Math.min(500,Math.round(Number(input.value)||0)));input.value=String(v);try{localStorage.setItem(RECORD_OFFSET_KEY,String(v));}catch{}core.status(`Recording offset set to ${v} ms.`);};
  }
  async function downloadTake(take){const blob=await getTakeBlob(take);if(!blob){core.status('This take audio is not available on this device or cloud.');return;}const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`${(take.name||'vocal-take').replace(/[^a-z0-9_-]+/gi,'-')}.wav`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),3000);}
  function stopPreview(){
    if(!currentPreview)return;
    const {source,chain}=currentPreview;currentPreview=null;
    try{source.onended=null;source.stop();}catch{}
    disconnectVocalChain(chain);
  }
  async function previewTake(p,take){
    stopPreview();
    const buffer=await vocalBufferForTake(take.id,p.id);if(!buffer){core.status('This take audio is not available on this device or cloud.');return;}
    const ctx=ensureAudio();if(ctx.state==='suspended')await ctx.resume().catch(()=>{});
    const fx=normalizeVocalFx(p.fx);if(fx.autotune>0)await ensureVocalWorklet(ctx);
    const chain=buildVocalChain(ctx,mixInput,fx),source=ctx.createBufferSource();
    setVocalChainLevel(chain,p.volume,true);source.buffer=buffer;source.connect(chain.input);source.start();
    currentPreview={source,chain};
    source.onended=()=>{if(currentPreview?.source===source)stopPreview();};
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
  function vocalDurationBeats(p){return Math.max(0,...voxTrackEvents(p).map(e=>voxEventBounds(e).end));}

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
  // Beat Maker's copy of the beat follows the song's first drum region: its
  // pattern (hits, bars, grid) only. Volume, mute, solo and on/off are the Drums
  // track's mix and stay as they are (gainFromRegion: take the region's volume).
  function syncDrumMasterToBeatMaker({gainFromRegion=false}={}){
    if(drumMasterSyncing||!window.CRPBeatMaker?.setBeat)return false;
    ensureLegacyDrumEvent();
    const primary=primaryDrumEvent(),source=primary?clone(primary.pattern):blankDrumPattern();
    try{
      const current=window.CRPBeatMaker?.getBeat?.();
      const target=current?{...current,bars:source.bars,resolution:source.resolution,tracks:source.tracks}:source;
      if(gainFromRegion&&primary&&Number.isFinite(Number(source.gain)))target.gain=Number(source.gain);
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
  // The Drums track's mix changed in Beat Maker (volume, mute, solo, on/off; see
  // CRPBeatMaker.setMix). The regions are one Drums track, so each plays at the
  // track volume: only their gain follows. No region's pattern is touched.
  function syncDrumMix(mix){
    const gain=Number(mix?.gain);if(!Number.isFinite(gain))return false;
    const g=Math.max(0,Math.min(1,gain));
    for(const ev of drumEvents){if(ev?.pattern)ev.pattern.gain=g;}
    for(const input of document.querySelectorAll?.('.vox-track-volume-input[data-drum-track]')||[])paintVoxTrackVolume(input,Math.round(g*100));
    markPartsDirty();liveEditRefresh();return true;
  }
  // A song was loaded. Its drums are its Track Master regions: they are what plays
  // and what Track Master shows. Beat Maker's copy (edited from Chord Rider, saved
  // as project.beatMaker) starts as the first region's pattern, so a copy an older
  // build left blank, missing or out of date can never be written over the
  // regions. A song whose drums are only in that copy (older builds played it when
  // a song had no region) gets them as its first region, so no edit or save drops
  // them.
  function adoptLoadedSongDrums(project){
    const bm=window.CRPBeatMaker;
    if(!bm?.getBeat)return; // at startup Beat Maker loads after this module; the core loads the song again then
    const beat=bm.getBeat(),beatHits=drumPatternHitCount(beat)>0;
    if(!drumEvents.length){
      drumArrangementInitialized=true;
      if(beatHits)drumEvents=[normalizeDrumEvent({id:'beat-maker-drums',startBeat:0,durationBeats:Math.max(4,musicalVocalDurationBeats(),(Number(beat.bars)||1)*4),patternOffsetBeats:0,pattern:beat})];
      return;
    }
    // Every region is empty but the copy has hits: those are the song's only drums.
    if(beatHits&&drumEvents.every(e=>drumPatternHitCount(e.pattern)<=0)){
      const primary=primaryDrumEvent();primary.pattern=clone(beat);primary.durationBeats=Math.max(Number(primary.durationBeats)||0,(Number(beat.bars)||1)*4);
      return;
    }
    syncDrumMasterToBeatMaker({gainFromRegion:!project?.beatMaker});
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
  // Where the playing transport ends, or repeats: the longest part, vocal clip or
  // drum region that is playing, unless the song end marker says otherwise. Beat
  // Maker repeats at this same point.
  function playbackEndBeats(){
    const scopedDrums=playbackScope?playbackScope.drums===true:true,livePs=enabledPlayable(),liveVs=enabledVocals();
    ensureLegacyDrumEvent();const liveDrums=scopedDrums?(drumEvents.length?Math.max(0,...drumEvents.map(e=>(Number(e.startBeat)||0)+(Number(e.durationBeats)||0))):Math.max(0,Number(window.CRPBeatMaker?.getDurationBeats?.()||0))):0;
    const natural=Math.max(...livePs.map(partDurationBeats),...liveVs.map(vocalDurationBeats),liveDrums,4);
    return effectiveSongEndBeats(natural);
  }
  function naturalSongDurationBeats(){
    ensureLegacyDrumEvent();const drumEnd=drumEvents.length?Math.max(...drumEvents.map(e=>(Number(e.startBeat)||0)+(Number(e.durationBeats)||0))):0;return Math.max(musicalVocalDurationBeats(),drumEnd,0);
  }
  function effectiveSongStartBeat(){return Math.max(0,Number(songStartBeat)||0);}
  function effectiveSongEndBeats(natural=naturalSongDurationBeats()){
    const start=effectiveSongStartBeat(),custom=Number(songEndBeat);if(Number.isFinite(custom)&&custom>start+.03)return custom;const n=Math.max(0,Number(natural)||0);return Math.max(start+.05,n||start+.05);
  }
  function songRangeForTimeline(){const start=effectiveSongStartBeat(),natural=naturalSongDurationBeats(),end=Number.isFinite(Number(songEndBeat))&&Number(songEndBeat)>start+.03?Number(songEndBeat):(natural>start?natural:Math.max(16,start+16));return {start,end:Math.max(start+.05,end)};}
  function currentCycleBeat(){
    if(!(playing||starting)||!audioCtx||!playbackClockStartAudioTime||!playbackTotalBeats)return null;
    const bpm=clampBpm(+playbackClockBpm||core.bpm),beatSec=60/bpm,start=Math.max(0,Number(playbackLoopStartBeat)||0),end=Math.max(start+.05,Number(playbackTotalBeats)||start+.05),period=end-start;
    let beat=(playbackClockStartBeat||start)+Math.max(0,audioCtx.currentTime-playbackClockStartAudioTime)/beatSec;
    const loopSong=!playbackScope&&!!core.loop;
    if(period>0&&loopSong)beat=start+((((beat-start)%period)+period)%period);
    else beat=Math.max(start,Math.min(end-.001,beat));
    return beat;
  }
  function renderSongEndEditor(){ if(!(playing||starting))updateMediaPosition(); }

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
    try{navigator.mediaSession.metadata=new MediaMetadata({title:core.projectName||'Song Rider Suite',artist:'Song Rider Suite',album:'Baby DAW',artwork:[{src:new URL('assets/brand/app-icon-512.png',location.href).href,sizes:'512x512',type:'image/png'}]});}catch{}
  }
  function mediaDurationBeats(){return Math.max(effectiveSongStartBeat()+.05,effectiveSongEndBeats(naturalSongDurationBeats()));}
  function updateMediaPosition(){
    if(!('mediaSession' in navigator)||typeof navigator.mediaSession.setPositionState!=='function')return;
    try{
      const totalBeats=Math.max(.05,playbackTotalBeats||mediaDurationBeats()),bpm=clampBpm(+playbackClockBpm||core.bpm),duration=Math.max(.1,totalBeats*60/bpm);
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
  function seekPlaybackToSeconds(seconds){const bpm=songBpm();seekPlaybackToBeat(Math.max(0,Number(seconds)||0)*bpm/60);}
  function seekPlaybackSeconds(delta){const bpm=songBpm(),base=(playing||starting)?(currentCycleBeat()??0):(mediaPausedBeat||0);seekPlaybackToBeat(base+(Number(delta)||0)*bpm/60);}
  function requestedPartSound(p){
    return p?.type==='chord'?p?.data?.sound:p?.sound;
  }
  // While a newly chosen sound decodes, a playing part keeps its previous one.
  function outputSoundFor(p){
    if(playing||starting){const current=partPlayers.get(p?.id);if(current?.sound)return current.sound;}
    return requestedPartSound(p);
  }
  function desiredPartGain(p,soundOverride=null){
    const scopeGain=playbackScope&&Array.isArray(playbackScope.playableIds)&&playbackScope.playableIds.includes(p.id)?Math.max(0,Math.min(1,Number(playbackScope.backingGain??1))):1;
    const mixGain=partAudibleInMix(p)?1:0;
    return soundGain(soundOverride||requestedPartSound(p))*p.volume*(p.type==='lead'?LEAD_OUTPUT_BOOST:1)*scopeGain*mixGain;
  }
  function vocalPartLevel(p){return Math.max(0,Math.min(1.5,Number(p?.volume)||0))*(partAudibleInMix(p)?1:0);}
  function clipVolume(e){const v=Number(e?.volume??1);return Number.isFinite(v)?Math.max(0,Math.min(1.5,v)):1;}
  function applyVocalFxLive(p){
    if(!p||!audioCtx)return;
    const pid=String(p.id),scale=vocalAutotuneScale(),level=vocalPartLevel(p),now=audioCtx.currentTime,eventById=id=>(p.voxEvents||[]).find(e=>String(e.id)===id)||null;
    let replan=false;
    for(const entry of vocalChains.values()){
      if(entry.partId!==pid)continue;
      const fx=effectiveVocalFx(p,entry.eventId?eventById(entry.eventId):null);
      setVocalChainFx(entry.chain,fx,scale);setVocalChainLevel(entry.chain,level);
      // Turning Auto-Tune on adds the worklet's latency; re-plan so clips stay in time.
      if(fx.autotune>0&&!entry.chain.tune&&insertChainTune(entry.chain,fx.autotune))replan=true;
    }
    for(const item of activeVocalSources){
      if(item.partId!==pid)continue;
      const e=eventById(item.eventId);
      if(e&&vocalChainKey(p,e)!==item.chainKey)replan=true; // a clip gained/lost its own FX
      try{item.gain.gain.setTargetAtTime(clipVolume(e),now,.025);}catch{}
    }
    if(replan)refreshScheduledVocals();
  }
  function drumsShareClock(){return !!audioCtx&&window.CRPAudio?.context?.()===audioCtx;}
  // Drums that were not running when Play started (switched off, or no hits yet)
  // join the playing song, on its beat, once they have something to play.
  // `beat` is the song position now.
  function joinDrumsLive(beat,drumGain,drumRange){
    const bm=window.CRPBeatMaker;
    if(!bm?.isMainPlaying||bm.isMainPlaying()||!drumsShareClock()||(playbackScope&&playbackScope.drums!==true))return;
    const lead=.06,startBeat=beat+lead*songBpm()/60,options={...drumRange,startTime:audioCtx.currentTime+lead,context:audioCtx};
    if(drumEvents.length)bm.startArrangementNow?.(drumEvents,lead,startBeat,drumGain,options);
    else bm.startMainNow?.(lead,startBeat,drumGain,options);
  }
  function liveEditRefresh(){
    clearTimeout(liveEditTimer);
    liveEditTimer=setTimeout(()=>{
      syncLoadedChord();
      // Length-of-Song Lead/Bass parts follow the musical arrangement live, not
      // only after Save/reload. This keeps playback and the Bars control aligned
      // as chord rows / song markers grow.
      for(const q of parts)if(q?.type==='lead')syncLeadBarsToSong(q);
      pruneRemovedPartAudio();
      const now=audioCtx?.currentTime||0;
      for(const p of parts){
        const bus=partBuses.get(p.id);
        if(bus&&audioCtx){try{if(typeof bus.gain.cancelAndHoldAtTime==='function')bus.gain.cancelAndHoldAtTime(now);else bus.gain.cancelScheduledValues(now);bus.gain.setTargetAtTime(desiredPartGain(p,outputSoundFor(p)),now,.028);}catch{}}
        if(p.type==='vocal')applyVocalFxLive(p);
      }
      if(playing||starting){
        // Drums repeat where the transport repeats (what is playing), not at the
        // end of every part including disabled ones.
        const drumGain=(drumsAudibleInMix()?currentDrumScopeGain():0)*MIX_HEADROOM,drumRange={rangeStart:effectiveSongStartBeat(),rangeEnd:playbackEndBeats(),canLoop:!playbackScope};
        window.CRPBeatMaker?.setMainGainScale?.(drumGain);
        window.CRPBeatMaker?.updateArrangement?.(drumEvents,drumRange);
        // Vocal clips are queued ahead like notes; an edit to them during
        // playback re-plans what is already queued.
        const plan=vocalPlanSignature();if(plan!==scheduledVocalPlan){scheduledVocalPlan=plan;refreshScheduledVocals();}
        const beat=currentCycleBeat();
        if(Number.isFinite(beat)&&audioCtx){playbackClockStartBeat=beat;playbackClockStartAudioTime=audioCtx.currentTime;playbackClockBpm=songBpm();}
        playbackTotalBeats=drumRange.rangeEnd;
        if(playing&&Number.isFinite(beat))joinDrumsLive(beat,drumGain,drumRange);
      }
      updateMediaMetadata();updateMediaPosition();
    },24);
  }

  // ---- Audio output ----
  // Every Baby DAW source feeds mixInput: a fixed headroom trim, then the suite
  // master (window.CRPAudio, which limits) when it exists, else our own safety
  // stage. Drums play in Beat Maker's context and get the same trim through
  // their gain scale.
  function ensureAudio(){
    if(!audioCtx){
      audioCtx=window.CRPAudio?.context?.()||new (window.AudioContext||window.webkitAudioContext)();
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
    if(!mixInput)mixInput=createMixOutput(audioCtx,window.CRPAudio?.master?.());
    return audioCtx;
  }
  function createMixOutput(ctx,sharedMaster=null){
    const input=ctx.createGain();input.gain.value=MIX_HEADROOM;
    if(sharedMaster&&sharedMaster.context===ctx){input.connect(sharedMaster);return input;}
    // Offline export: the suite's loudness master (drive, glue, limiter) so the WAV
    // sounds as loud as playback.
    if(typeof window.CRPAudio?.buildMaster==='function'){input.connect(window.CRPAudio.buildMaster(ctx));return input;}
    // Safety stage: a fast compressor, then a soft clipper that is transparent
    // below 0.8 and never reaches full scale.
    const comp=ctx.createDynamicsCompressor(),pre=ctx.createGain(),clip=ctx.createWaveShaper();
    comp.threshold.value=-6;comp.knee.value=3;comp.ratio.value=12;comp.attack.value=.002;comp.release.value=.15;
    pre.gain.value=1/SOFT_CLIP_RANGE;clip.curve=softClipCurve();clip.oversample='2x';
    input.connect(comp);comp.connect(pre);pre.connect(clip);clip.connect(ctx.destination);
    return input;
  }
  let softClipCurveData=null;
  function softClipCurve(){
    if(softClipCurveData)return softClipCurveData;
    const n=4096,knee=.8,ceiling=.98,span=ceiling-knee,curve=new Float32Array(n);
    for(let i=0;i<n;i++){const x=(i/(n-1)*2-1)*SOFT_CLIP_RANGE,a=Math.abs(x);curve[i]=Math.sign(x)*(a<=knee?a:knee+span*Math.tanh((a-knee)/span));}
    return softClipCurveData=curve;
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
      const fx=core.createInstrumentFxChain?.(audioCtx,mixInput);
      if(fx){gate.connect(fx.input);partInstrumentFx.set(p.id,fx);}else gate.connect(mixInput);
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

  // ---- Instruments ----
  // Decoded SoundFont samples (network + mp3 decode) are the expensive part, so
  // they are kept for the session, keyed by sound and shared by every part that
  // uses it. Each part plays them through its own light SamplePlayer on its bus;
  // those players live for one playback.
  const decodedSounds=new Map();let decodedSoundsCtx=null,decodeSink=null;
  function decodedSound(sound){
    ensureAudio();
    if(decodedSoundsCtx!==audioCtx){decodedSounds.clear();decodedSoundsCtx=audioCtx;decodeSink=audioCtx.createGain();}
    let entry=decodedSounds.get(sound);
    if(!entry){
      if(!window.Soundfont&&!window.CRPInstruments)throw new Error('Sound engine unavailable');
      entry={base:null};
      entry.promise=Promise.resolve(core.loadSoundfontInstrument?core.loadSoundfontInstrument(audioCtx,sound,decodeSink):Soundfont.instrument(audioCtx,sound,{format:'mp3',soundfont:'MusyngKite',destination:decodeSink}))
        .then(base=>{entry.base=base;return base;},err=>{if(decodedSounds.get(sound)===entry)decodedSounds.delete(sound);throw err;});
      decodedSounds.set(sound,entry);
    }
    return entry;
  }
  function pruneDecodedSounds(){
    if(decodedSounds.size<=MAX_IDLE_DECODED_SOUNDS)return;
    const inUse=new Set(parts.map(requestedPartSound));
    for(const [sound,entry] of decodedSounds)if(decodedSounds.size>MAX_IDLE_DECODED_SOUNDS&&entry.base&&!inUse.has(sound))decodedSounds.delete(sound);
  }
  // Instruments from the engine (instruments.js) make their own per-part players from the shared
  // decoded/synth model on any context (live or offline export). SoundFont instruments use
  // window.SamplePlayer (vendor/soundfont-player.js): the player Soundfont.instrument() builds,
  // minus the fetch/decode.
  function samplePlayerOn(ctx,base,destination){
    if(typeof base?.createPlayer==='function')return base.createPlayer(ctx,destination);
    if(typeof window.SamplePlayer!=='function'||!base?.buffers)throw new Error('Sound engine unavailable');
    return window.SamplePlayer(ctx,base.buffers,{}).connect(destination);
  }
  function partPlayer(p,sound,base){
    const current=partPlayers.get(p.id);
    if(current?.sound===sound)return current.player;
    const bus=ensurePartBus(p).bus,player=samplePlayerOn(audioCtx,base,bus);
    if(current&&(playing||starting)){
      // v3.3.118 — a newly ready sound can have a very different level/waveform
      // than the one it replaces; a tiny cross-duck on the handoff gate avoids a
      // click without restarting the transport.
      const gate=partHandoffGates.get(p.id),now=audioCtx.currentTime;
      try{
        if(typeof gate.gain.cancelAndHoldAtTime==='function')gate.gain.cancelAndHoldAtTime(now);
        else{gate.gain.cancelScheduledValues(now);gate.gain.setValueAtTime(Math.max(.0001,gate.gain.value||1),now);}
        gate.gain.linearRampToValueAtTime(.0001,now+.018);
        gate.gain.linearRampToValueAtTime(1,now+.072);
      }catch{}
    }
    partPlayers.set(p.id,{sound,player});playerSound.set(player,sound);
    return player;
  }
  async function playerFor(p,{forceCurrent=false,nonBlocking=false}={}){
    const sound=requestedPartSound(p),entry=decodedSound(sound);
    if(entry.base)return partPlayer(p,sound,entry.base);
    const current=partPlayers.get(p.id);
    if(!forceCurrent&&(playing||starting)&&(current||nonBlocking)){
      // Never stall the rolling scheduler on a network/decode: the part keeps its
      // current sound (or joins later) and switches once the new one is ready.
      entry.promise.catch(err=>console.warn('Live sound preload failed',err));
      return current?.player||null;
    }
    return partPlayer(p,sound,await entry.promise);
  }
  async function preload(ps){await Promise.all(ps.map(p=>playerFor(p,{forceCurrent:true})));}
  function warmLivePlayer(p){
    if(!p||!(playing||starting))return;
    // Starts the new sample load but returns immediately through the ready-player
    // fallback; no transport restart and no scheduler stall.
    playerFor(p).catch(e=>console.warn('Live sound preload failed',e));
  }
  function queueTempoRestartIfNeeded(){
    if(recording||!(playing||starting))return false;
    const nextBpm=songBpm();
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
  // CRP MIDI-view commit (Play, Save, resize). Durations come from the MIDI view;
  // Track Master placements survive unless an edit conflicts with them.
  function syncMidiTimelineFromCore(){
    if(!syncLoadedChord())return false;
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
      const beatSec=60/songBpm();
      const auditionDuration=p.sustain?sustainedPartSeconds(scheduledSound,beatSec):.42;
      playTracked(player,midiName(soundingMidi),at,{duration:auditionDuration,gain:transportActive?.88:.96});
    }catch(e){
      console.warn('Could not audition lead/bass note',e);
      if(!(playing||starting))core.status('Could not preview that note.');
    }
  }
  // Note scheduling for one song window {startTime,fromBeat,toBeat,beatSec},
  // shared by live playback and export. play(player,note,at,opts) starts a note.
  function scheduleChordNotes(p,player,sound,win,play,onCard){
    const guitar=p.data?.instrument==='guitar';
    chordFlatItems(p).forEach((item,i)=>{
      const b=item.startBeat;if(b<win.fromBeat||b>=win.toBeat)return;
      const at=win.startTime+(b-win.fromBeat)*win.beatSec,base=item.dur*win.beatSec,duration=core.sustain?sustainedPartSeconds(sound,base):Math.max(.18,base*.98);
      (core.notesFor(item.card,p.data)||[]).forEach((n,j)=>play(player,n,at+(guitar?j*.035:0),{duration,gain:.94}));
      onCard?.(at,i);
    });
  }
  function leadPartRepeats(p){return playbackScope?.kind==='vocalMix'?p.repeat:!!core.loop;}
  function scheduleLeadNotes(p,player,sound,win,repeat,play,onNote){
    const stepBeats=4/p.resolution,partBeats=Math.max(stepBeats,p.bars*4),bassShift=(core.isBassSound?.(sound)||sound==='electric_bass_finger')?12:0;
    const first=repeat?Math.max(0,Math.floor(win.fromBeat/partBeats)):0,last=repeat?Math.floor((win.toBeat-1e-6)/partBeats):0;
    for(let cyc=first;cyc<=last;cyc++)for(const e of p.events||[]){
      if(e.voxBlank===true)continue;
      const b=leadEventStartBeat(p,e)+cyc*partBeats;if(b<win.fromBeat||b>=win.toBeat)continue;
      const at=win.startTime+(b-win.fromBeat)*win.beatSec,drawn=leadEventDurationBeats(p,e);
      const duration=p.sustain&&drawn<=stepBeats?sustainedPartSeconds(sound,win.beatSec):Math.max(.05,drawn*win.beatSec*.98);
      play(player,midiName(e.midi+(Number(p.octave)||0)*12-bassShift),at,{duration,gain:.92});
      onNote?.(at,e.step);
    }
  }
  async function scheduleInstruments(win,generation){
    for(const p of enabledPlayable()){
      const player=await playerFor(p,{nonBlocking:true});
      if(!playing||generation!==playbackGeneration)return;
      if(!player)continue;
      const sound=playerSound.get(player)||requestedPartSound(p);
      busFor(p,sound);
      if(p.type==='chord')scheduleChordNotes(p,player,sound,win,playTracked,(at,i)=>scheduleHighlight((at-audioCtx.currentTime)*1000,p,i));
      else scheduleLeadNotes(p,player,sound,win,leadPartRepeats(p),playTracked,(at,step)=>scheduleLeadHighlight((at-audioCtx.currentTime)*1000,p,step));
    }
  }

  // ---- Vocals ----
  async function vocalBufferForTake(takeId,sourcePartId=''){
    const take=findVocalTake(takeId,sourcePartId)?.take;if(!take)return null;
    const id=String(take.id);
    if(!vocalBufferCache.has(id)){
      const promise=(async()=>{
        const blob=await getTakeBlob(take);if(!blob)return null;
        const buffer=await ensureAudio().decodeAudioData(await blob.arrayBuffer());
        vocalBuffers.set(id,buffer);return buffer;
      })();
      vocalBufferCache.set(id,promise);
      // Do not cache a miss: the audio may arrive later (cloud, retry, recovery).
      promise.then(buf=>{if(!buf&&vocalBufferCache.get(id)===promise)vocalBufferCache.delete(id);},()=>{if(vocalBufferCache.get(id)===promise)vocalBufferCache.delete(id);});
    }
    return vocalBufferCache.get(id);
  }
  function forgetTakeBuffer(takeId){vocalBufferCache.delete(String(takeId));vocalBuffers.delete(String(takeId));}
  function preloadVocalBuffers(p){return Promise.all(voxTrackEvents(p).map(e=>vocalBufferForTake(e.takeId,e.sourcePartId)));}
  // ---- Vocal effects ------------------------------------------------------------------------------
  // EQ presets, in the order a vocal engineer would set them: a low cut for rumble and breath pops, a low-mid
  // band (mud or warmth), presence and air.
  const VOCAL_EQ={
    flat:{hp:70,low:['peaking',300,1,0],pres:[3200,.9,0],air:[10000,0]},
    clear:{hp:100,low:['peaking',300,1,-2],pres:[3200,.9,2.5],air:[10000,2]},
    warm:{hp:80,low:['lowshelf',220,.7,2.5],pres:[3000,.9,-1],air:[9000,-1.5]},
    bright:{hp:110,low:['peaking',280,1,-2.5],pres:[4500,.8,2.5],air:[8000,4]},
  };
  // Compression presets. The browser's compressor adds its own make-up gain (+4 to +7 dB here); `makeup` brings
  // each preset back to the uncompressed loudness (measured on a sung vowel at -24 dBFS RMS, a typical recorded
  // level), so switching presets changes the dynamics, not the volume.
  const VOCAL_COMP={
    off:{threshold:0,ratio:1,knee:0,attack:.01,release:.15,makeup:1},
    light:{threshold:-16,ratio:2,knee:6,attack:.01,release:.16,makeup:.635},
    medium:{threshold:-22,ratio:3.5,knee:6,attack:.005,release:.13,makeup:.463},
    heavy:{threshold:-30,ratio:6,knee:6,attack:.003,release:.1,makeup:.521},
  };
  // Reverb rooms: decay time (RT60), pre-delay, and how fast the highs die away. The stored setting is the
  // send level (Small .12, Medium .22, Large .34), which also picks the room.
  const VOCAL_ROOMS={small:{rt:.7,pre:.008,hiStart:9000,hiEnd:3200},medium:{rt:1.4,pre:.015,hiStart:8500,hiEnd:2600},large:{rt:2.4,pre:.024,hiStart:8000,hiEnd:2000}};
  // Send level per room so each reverb sits at about the old level (calibrated against the previous reverb).
  const REVERB_WET_SCALE={small:.57,medium:.51,large:.38};
  const roomForReverb=v=>!(v>0)?null:v<.17?'small':v<.28?'medium':'large';
  const reverbImpulses=new WeakMap();
  // A room impulse per context and size, built once: early reflections, then a decaying, darkening tail, with
  // left and right different so the reverb is wide. Deterministic, so playback and export sound the same.
  function reverbImpulse(ctx,size='small'){
    let byCtx=reverbImpulses.get(ctx);if(!byCtx)reverbImpulses.set(ctx,byCtx=new Map());
    let buffer=byCtx.get(size);if(buffer)return buffer;
    const R=VOCAL_ROOMS[size]||VOCAL_ROOMS.small,sr=ctx.sampleRate,length=Math.floor(sr*(R.pre+R.rt*1.1));
    buffer=ctx.createBuffer(2,length,sr);
    let seed=0x2f6b1d+size.length*7919;const noise=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2147483648-1;};
    const pre=Math.floor(R.pre*sr),decay=6.91/(R.rt*sr),T=length-pre;
    for(let c=0;c<2;c++){
      const d=buffer.getChannelData(c);
      // Early reflections: a few distinct echoes in the first ~60 ms, different on each side.
      for(let k=0;k<7;k++){const at=pre+Math.floor((.004+.055*((k+1)/7)**1.3+.004*noise())*sr);if(at<length)d[at]+=(.55-.06*k)*(k%2?-1:1)*(c?.9:1);}
      // Late tail: noise, exponential decay, a one-pole low-pass that closes over time, and a 20 ms fade-in.
      let lp=0;
      for(let i=0;i<T;i++){
        const t=i/T,fc=R.hiStart*Math.pow(R.hiEnd/R.hiStart,t),a=1-Math.exp(-2*Math.PI*fc/sr);
        lp+=a*(noise()-lp);
        d[pre+i]+=lp*Math.exp(-decay*i)*Math.min(1,i/(.02*sr))*.9;
      }
      // Fade the last 5% to true zero.
      const f0=Math.floor(length*.95);for(let i=f0;i<length;i++)d[i]*=(length-i)/(length-f0);
    }
    byCtx.set(size,buffer);return buffer;
  }
  // Delay: Slap is one quick echo; 1/8 and 1/4 follow the song tempo, with repeats that darken as they fade.
  function vocalDelaySpec(v){
    v=Number(v)||0;if(!(v>0))return null;
    const beat=60/(Number(songBpm())||92);
    if(v<.14)return {time:.095,feedback:0,wet:.2};
    if(v<.23)return {time:Math.min(1.9,beat/2),feedback:.32,wet:.2};
    return {time:Math.min(1.9,beat),feedback:.3,wet:.18};
  }
  // Vocal FX chain: input → [Auto-Tune] → low cut → low-mid → presence → air → compressor → make-up → post;
  // post → out (dry), post → filtered reverb send → room → out, post → tempo delay (with filtered feedback) → out.
  // Playback builds one per vocal part (plus one per clip that has its own FX) and reuses it for every clip and
  // loop; take preview and export use the same.
  function buildVocalChain(ctx,destination,fx){
    const bq=(type,f,q,g)=>{const b=ctx.createBiquadFilter();b.type=type;b.frequency.value=f;if(q!=null)b.Q.value=q;if(g!=null)b.gain.value=g;return b;};
    const chain={ctx,input:ctx.createGain(),hp:bq('highpass',80,.7),low:bq('peaking',300,1,0),pres:bq('peaking',3200,.9,0),air:bq('highshelf',10000,null,0),
      comp:ctx.createDynamicsCompressor(),makeup:ctx.createGain(),post:ctx.createGain(),
      revHp:bq('highpass',180,.7),revLp:bq('lowpass',8500,.7),rev:null,revSize:null,wet:ctx.createGain(),
      delay:ctx.createDelay(2),fb:ctx.createGain(),fbHp:bq('highpass',250,.7),fbLp:bq('lowpass',4500,.7),delayGain:ctx.createGain(),
      out:ctx.createGain(),tune:null,latency:0};
    const c=chain;
    c.input.connect(c.hp);c.hp.connect(c.low);c.low.connect(c.pres);c.pres.connect(c.air);c.air.connect(c.comp);c.comp.connect(c.makeup);c.makeup.connect(c.post);
    c.post.connect(c.out);
    c.post.connect(c.revHp);c.revHp.connect(c.revLp);c.wet.connect(c.out);
    c.post.connect(c.delay);c.delay.connect(c.delayGain);c.delayGain.connect(c.out);
    c.delay.connect(c.fb);c.fb.connect(c.fbHp);c.fbHp.connect(c.fbLp);c.fbLp.connect(c.delay);c.fb.gain.value=0;
    c.out.connect(destination);
    setVocalChainFx(chain,fx,null,true);
    if(fx.autotune>0)insertChainTune(chain,fx.autotune);
    return chain;
  }
  // Auto-Tune goes first, on the raw voice, where pitch detection is most reliable.
  function insertChainTune(chain,amount){
    const tune=makeAutotuneNode(chain.ctx,amount);if(!tune)return false;
    chain.input.disconnect();chain.input.connect(tune);tune.connect(chain.hp);
    chain.tune=tune;chain.latency=AUTOTUNE_LATENCY_SAMPLES/chain.ctx.sampleRate;
    return true;
  }
  function setRoom(chain,size){
    if(chain.revSize===size)return;
    const old=chain.rev;
    if(size){const rev=chain.ctx.createConvolver();rev.buffer=reverbImpulse(chain.ctx,size);chain.revLp.connect(rev);rev.connect(chain.wet);chain.rev=rev;}
    else chain.rev=null;
    if(old){try{chain.revLp.disconnect(old);}catch{}const o=old;setTimeout(()=>{try{o.disconnect();}catch{}},(VOCAL_ROOMS[chain.revSize]?.rt||1)*1200);}
    chain.revSize=size;
  }
  function setVocalChainFx(chain,fx,scale=null,immediate=false){
    const now=chain.ctx.currentTime,set=(param,value,tc=.02)=>{if(immediate)param.value=value;else param.setTargetAtTime(value,now,tc);};
    const E=VOCAL_EQ[fx.eq]||VOCAL_EQ.clear,C=VOCAL_COMP[fx.comp]||VOCAL_COMP.medium;
    set(chain.hp.frequency,E.hp);
    chain.low.type=E.low[0];set(chain.low.frequency,E.low[1]);set(chain.low.Q,E.low[2]);set(chain.low.gain,E.low[3]);
    set(chain.pres.frequency,E.pres[0]);set(chain.pres.Q,E.pres[1]);set(chain.pres.gain,E.pres[2]);
    set(chain.air.frequency,E.air[0]);set(chain.air.gain,E.air[1]);
    set(chain.comp.threshold,C.threshold);set(chain.comp.ratio,C.ratio);set(chain.comp.knee,C.knee);set(chain.comp.attack,C.attack);set(chain.comp.release,C.release);
    set(chain.makeup.gain,C.makeup);
    const reverb=Number(fx.reverb)||0,size=roomForReverb(reverb);
    if(size)setRoom(chain,size);
    set(chain.wet.gain,size?reverb*REVERB_WET_SCALE[size]:0,.03);
    const D=vocalDelaySpec(fx.delay);
    if(D)set(chain.delay.delayTime,D.time,immediate?.02:.05);
    set(chain.fb.gain,D?D.feedback:0,.03);
    set(chain.delayGain.gain,D?D.wet:0,.03);
    chain.tune?.port.postMessage({amount:fx.autotune,allowedPcs:(scale||vocalAutotuneScale()).allowedPcs||[]});
  }
  function setVocalChainLevel(chain,level,immediate=false){
    const v=Math.max(0,Math.min(1.5,Number(level)||0));
    if(immediate)chain.out.gain.value=v;else chain.out.gain.setTargetAtTime(v,chain.ctx.currentTime,.025);
  }
  function disconnectVocalChain(chain){
    if(!chain)return;
    for(const n of [chain.input,chain.tune,chain.hp,chain.low,chain.pres,chain.air,chain.comp,chain.makeup,chain.post,chain.revHp,chain.revLp,chain.rev,chain.wet,chain.delay,chain.fb,chain.fbHp,chain.fbLp,chain.delayGain,chain.out])try{n?.disconnect();}catch{}
    chain.tune?.port.postMessage({type:'release'});
  }
  function vocalChainKey(p,e){return e?.fx?`${p.id}:${e.id}`:String(p.id);}
  function liveVocalChain(p,e){
    const key=vocalChainKey(p,e);let entry=vocalChains.get(key);
    if(!entry){
      const chain=buildVocalChain(audioCtx,mixInput,effectiveVocalFx(p,e));
      setVocalChainLevel(chain,vocalPartLevel(p),true);
      entry={key,chain,partId:String(p.id),eventId:e?.fx?String(e.id):null};vocalChains.set(key,entry);
    }
    return entry;
  }
  // Plays `buffer` from `offset` for `dur` seconds so it is heard at `at`: it
  // starts early by the chain's latency (Auto-Tune), and joins late if `at` has
  // already passed. Returns null when nothing is left to play.
  function startVocalSource(ctx,chain,buffer,at,offset,dur,volume,fadeIn=0){
    let when=at-chain.latency,from=offset,length=dur;
    if(when<ctx.currentTime){const late=ctx.currentTime-when;when=ctx.currentTime;from+=late;length-=late;}
    if(length<=.005||from>=buffer.duration)return null;
    const src=ctx.createBufferSource(),gain=ctx.createGain();
    src.buffer=buffer;src.connect(gain);gain.connect(chain.input);
    if(fadeIn>0){gain.gain.setValueAtTime(0,when);gain.gain.linearRampToValueAtTime(volume,when+fadeIn);}else gain.gain.value=volume;
    src.start(when,from,length);
    return {src,gain};
  }
  // Clips of vocal part p for the song window [fromBeat,toBeat): those starting
  // in it, plus (includeRunning) those already sounding at fromBeat. With Repeat
  // on, a part's clips loop on its own length.
  function vocalPeriodBeats(bounds){return Math.max(...bounds.map(b=>b.end));}
  function vocalOccurrences(p,fromBeat,toBeat,includeRunning){
    const events=voxTrackEvents(p);if(!events.length)return [];
    const bounds=events.map(e=>({e,...voxEventBounds(e)})),period=vocalPeriodBeats(bounds),longest=Math.max(...bounds.map(b=>b.dur));
    const first=p.repeat?Math.max(0,Math.floor((fromBeat-longest)/period)):0,last=p.repeat?Math.max(0,Math.floor((toBeat-1e-6)/period)):0,out=[];
    for(let k=first;k<=last;k++)for(const b of bounds){
      const start=b.start+k*period,end=b.end+k*period;
      if((start>=fromBeat&&start<toBeat)||(includeRunning&&start<fromBeat&&end>fromBeat+1e-6))out.push({event:b.e,start,end});
    }
    return out;
  }
  // Schedules p's clips for one window ({…, endBeat, includeRunning}); clips stop
  // at endBeat (the song end). Shared by live playback and export.
  function scheduleVocalClips(ctx,p,win,{chainFor,bufferFor,onStart=null,fadeIn=0}){
    for(const occ of vocalOccurrences(p,win.fromBeat,win.toBeat,win.includeRunning)){
      const e=occ.event,buffer=bufferFor(e);if(!buffer)continue;
      const from=Math.max(occ.start,win.fromBeat),to=Math.min(occ.end,win.endBeat);if(to<=from)continue;
      const at=win.startTime+(from-win.fromBeat)*win.beatSec,offset=Math.max(0,Number(e.trimStartSec)||0)+(from-occ.start)*win.beatSec;
      const entry=chainFor(p,e),started=startVocalSource(ctx,entry.chain,buffer,at,offset,(to-from)*win.beatSec,clipVolume(e),fadeIn);
      if(started)onStart?.(started,p,e,entry);
    }
  }
  function scheduleVocalsLive(win,generation,fadeIn=0){
    for(const p of enabledVocals()){
      scheduleVocalClips(audioCtx,p,win,{
        chainFor:liveVocalChain,fadeIn,
        bufferFor:e=>vocalBuffers.get(String(e.takeId))||(loadVocalBufferLater(e,generation),null),
        onStart:({src,gain},part,e,entry)=>{
          const item={src,gain,partId:String(part.id),eventId:String(e.id),chainKey:entry.key};
          activeVocalSources.add(item);
          src.onended=()=>{activeVocalSources.delete(item);try{src.disconnect();gain.disconnect();}catch{}};
        }
      });
    }
  }
  // A clip whose take was not decoded yet (added during playback) joins once it is.
  const pendingVocalLoads=new Set();
  function loadVocalBufferLater(e,generation){
    const id=String(e.takeId);if(pendingVocalLoads.has(id))return;
    pendingVocalLoads.add(id);
    vocalBufferForTake(e.takeId,e.sourcePartId).then(buf=>{if(buf&&playing&&generation===playbackGeneration)refreshScheduledVocals();}).catch(()=>{}).finally(()=>pendingVocalLoads.delete(id));
  }
  function vocalPlanSignature(){
    return JSON.stringify(enabledVocals().map(p=>[p.id,!!p.repeat,voxTrackEvents(p).map(e=>[e.id,e.takeId,e.startBeat,e.trimStartSec,e.trimEndSec,vocalChainKey(p,e)])]));
  }
  // Re-plans the vocal clips already queued (after an edit during playback):
  // queued and sounding sources fade out over ~10 ms while their replacements,
  // from the current plan, fade in.
  function refreshScheduledVocals(){
    if(!playing||!audioCtx)return;
    const at=audioCtx.currentTime+.03;
    for(const item of activeVocalSources){
      const g=item.gain.gain;
      try{if(typeof g.cancelAndHoldAtTime==='function')g.cancelAndHoldAtTime(at);else g.cancelScheduledValues(at);g.setTargetAtTime(0,at,.004);item.src.stop(at+.03);}catch{}
    }
    activeVocalSources.clear();
    scheduledVocalPlan=vocalPlanSignature();
    let first=true;
    for(const w of scheduledWindows){
      if(w.endTime<=at)continue;
      const startTime=Math.max(at,w.startTime),fromBeat=w.fromBeat+(startTime-w.startTime)/w.beatSec;
      scheduleVocalsLive({...w,startTime,fromBeat,includeRunning:first||w.includeRunning},playbackGeneration,first?.012:0);
      first=false;
    }
  }
  // Drops the live audio of parts deleted during playback.
  function pruneRemovedPartAudio(){
    const ids=new Set(parts.map(p=>String(p.id)));
    for(const item of activeVocalSources)if(!ids.has(item.partId)){try{item.src.stop();}catch{}activeVocalSources.delete(item);}
    for(const [key,entry] of vocalChains)if(!ids.has(entry.partId)){disconnectVocalChain(entry.chain);vocalChains.delete(key);}
    for(const id of [...partBuses.keys()])if(!ids.has(String(id))){
      for(const node of [partBuses.get(id),partHandoffGates.get(id)])try{node?.disconnect();}catch{}
      try{partInstrumentFx.get(id)?.disconnect?.();}catch{}
      partBuses.delete(id);partHandoffGates.delete(id);partInstrumentFx.delete(id);partPlayers.delete(id);
    }
  }
  function scheduleHighlight(delayMs,p,cardIndex){
    if(p.id!==activePartId||p.type!=='chord')return;
    const t=setTimeout(()=>{
      highlightTimers.delete(t);
      document.querySelectorAll('.chord-card').forEach(c=>c.style.outline='');
      const cards=[...document.querySelectorAll('.progression-line:not(.carousel-clone) .chord-card')];
      cards[cardIndex]?.style.setProperty('outline','2px solid var(--accent)');
      core.followChordCard?.(cardIndex);
    },Math.max(0,delayMs));
    highlightTimers.add(t);
  }
  function scheduleLeadHighlight(delayMs,p,step){
    if(p.id!==activePartId||p.type!=='lead')return;
    const t=setTimeout(()=>{
      highlightTimers.delete(t);
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
    },Math.max(0,delayMs));
    highlightTimers.add(t);
  }
  function trackVoice(voice){
    if(!voice?.source||typeof voice.stop!=='function')return voice;
    activeVoices.add(voice);
    const ended=voice.source.onended;
    voice.source.onended=e=>{activeVoices.delete(voice);ended?.call(voice.source,e);};
    return voice;
  }
  function playTracked(player,note,at,opts){
    try{return trackVoice(player.play(note,at,opts));}catch(e){console.warn('Could not schedule note',note,e);return null;}
  }
  // The stop path: silence and detach everything this playback scheduled.
  // Decoded instruments and take buffers stay cached; voices, clip sources, part
  // buses, players and vocal chains (all per playback) are dropped.
  function silenceScheduledAudio(){
    const now=audioCtx?.currentTime||0;
    for(const voice of activeVoices){try{voice.stop(0);}catch{}try{voice.disconnect?.();}catch{}}
    activeVoices.clear();
    for(const item of activeVocalSources){try{item.src.onended=null;item.src.stop(0);}catch{}try{item.src.disconnect();item.gain.disconnect();}catch{}}
    activeVocalSources.clear();scheduledWindows=[];scheduledVocalPlan='';
    for(const entry of vocalChains.values())disconnectVocalChain(entry.chain);
    vocalChains.clear();
    for(const {player} of partPlayers.values())try{player.dispose?.();player.out?.disconnect();}catch{}
    partPlayers.clear();
    for(const bus of partBuses.values()){try{bus.gain.cancelScheduledValues(now);bus.gain.value=0;bus.disconnect();}catch{}}
    for(const gate of partHandoffGates.values())try{gate.disconnect();}catch{}
    for(const fx of partInstrumentFx.values())try{fx?.disconnect?.();}catch{}
    partInstrumentFx.clear();partHandoffGates.clear();partBuses.clear();
    playerSound=new WeakMap();
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
      core.status('Loading parts…');ensureAudio();if(audioCtx?.state==='suspended')await audioCtx.resume();if(vs.length)await ensureVocalWorklet(audioCtx);await Promise.all([preload(ps),...vs.map(v=>preloadVocalBuffers(v))]);
      if(generation!==playbackGeneration)return;
      pruneDecodedSounds();

      // Keep every playback source on the same musical downbeat: the drums start
      // first (Beat Maker) and the rest of the song starts on their downbeat.
      const leadIn=options?.liveRestart?.035:.16;
      const computePlaybackTotal=playbackEndBeats;
      let total=computePlaybackTotal();
      playbackTotalBeats=total;
      // Scoped Lead/Vocal preview buttons always begin at beat 1. The normal
      // Chord transport still honors "play line in view". If the visible line
      // begins past a custom song end, restart from beat 1 instead of silently ending.
      const rangeStart=effectiveSongStartBeat();playbackLoopStartBeat=rangeStart;
      let cursorBeat=Number.isFinite(Number(options?.fromBeat))?Math.max(rangeStart,Number(options.fromBeat)):((!playbackScope&&active()?.type==='chord'&&active()?.enabled&&activePartId===loadedChordPartId)?Math.max(rangeStart,Math.min(core.startBeat(),Math.max(rangeStart,total-0.001))):rangeStart);
      if(cursorBeat>=total-.001)cursorBeat=rangeStart;
      const initialBeat=cursorBeat;
      let drumStartTime=null;
      if(scopedDrums){
        const drumGain=Math.max(0,Math.min(1,Number(playbackScope?.drumGain??1)))*(drumsAudibleInMix()?1:0)*MIX_HEADROOM;
        ensureLegacyDrumEvent();if(drumEvents.length)drumStartTime=await window.CRPBeatMaker?.startArrangementNow?.(drumEvents,leadIn,initialBeat,drumGain,{rangeStart,rangeEnd:total,canLoop:!playbackScope});else drumStartTime=await window.CRPBeatMaker?.startMainNow?.(leadIn,initialBeat,drumGain);
      }else{
        window.CRPBeatMaker?.stopMainNow?.();
      }
      if(generation!==playbackGeneration)return;

      starting=false;playing=true;mediaPausedBeat=initialBeat;core.setPlaying(true);core.status('');updatePartPlaybackButtons();setMediaPlaying(true);
      if(generation!==playbackGeneration||!playing){window.CRPBeatMaker?.stopMainNow?.();return;}

      let nextAudioStart=audioCtx.currentTime+leadIn;
      // Beat Maker plays on this same AudioContext (CRPAudio): begin on the
      // drums' downbeat rather than a lead-in measured a few milliseconds later.
      if(drumsShareClock()&&Number.isFinite(drumStartTime)&&drumStartTime>audioCtx.currentTime+.005)nextAudioStart=drumStartTime;
      // Shared musical clock exposed to linked SRP so lyric AutoScroll can quantize
      // to the exact CRP/BD beat grid instead of using an independent timer.
      playbackClockStartAudioTime=nextAudioStart;
      playbackClockStartBeat=initialBeat;
      playbackClockBpm=songBpm();
      // A rolling scheduler: ~1.2 s of audio stays queued, built from ~0.2 s
      // windows so live edits enter the mix quickly. Notes and vocal clips that
      // start in a window are queued with it; each queued window is remembered so
      // vocal edits can re-plan what is already queued (refreshScheduledVocals).
      const schedulerHorizonSec=1.20,schedulerChunkSec=.20,schedulerTickMs=45;
      let chunkStartsCycle=true,schedulerBusy=false,endStopScheduled=false;
      scheduledWindows=[];scheduledVocalPlan=vocalPlanSignature();

      const scheduleNext=async()=>{
        if(!playing||generation!==playbackGeneration)return;
        if(schedulerBusy){cycleTimer=setTimeout(scheduleNext,schedulerTickMs);return;}
        schedulerBusy=true;
        try{
          if(audioCtx?.state!=='running'&&audioCtx?.state!=='closed')await audioCtx.resume().catch(()=>{});
          if(!playing||generation!==playbackGeneration)return;
          while(scheduledWindows.length&&scheduledWindows[0].endTime<audioCtx.currentTime)scheduledWindows.shift();
          const horizon=audioCtx.currentTime+schedulerHorizonSec;
          while(playing&&generation===playbackGeneration&&nextAudioStart<horizon&&!endStopScheduled){
            const beatSec=60/songBpm();
            total=computePlaybackTotal();playbackTotalBeats=total;
            if(cursorBeat>=total-.001){cursorBeat=playbackLoopStartBeat;chunkStartsCycle=true;}
            const chunkBeats=Math.max(.25,Math.min(1.25,schedulerChunkSec/beatSec));
            const fromBeat=cursorBeat,toBeat=Math.min(total,fromBeat+chunkBeats),span=(toBeat-fromBeat)*beatSec;
            if(span<=.0001)break;
            const start=nextAudioStart,end=start+span;
            // A window that begins a pass through the song also starts the vocal
            // clips already sounding at its first beat (mid-clip starts, loops).
            const win={startTime:start,endTime:end,fromBeat,toBeat,endBeat:total,beatSec,includeRunning:chunkStartsCycle};
            chunkStartsCycle=false;scheduledWindows.push(win);
            scheduleVocalsLive(win,generation);
            await scheduleInstruments(win,generation);
            if(!playing||generation!==playbackGeneration)return;

            nextAudioStart=end;cursorBeat=toBeat;
            if(cursorBeat>=total-1e-7){
              const loopSong=normalTransportRepeatEnabled();
              if(loopSong){cursorBeat=playbackLoopStartBeat;chunkStartsCycle=true;}
              else{
                endStopScheduled=true;
                cycleTimer=setTimeout(()=>{
                  if(generation!==playbackGeneration||!playing)return;
                  // Repeat may have been re-synchronized while this final audio
                  // slice was already queued. Re-check at the actual boundary;
                  // if Repeat is visibly on, continue the same transport session
                  // rather than firing a stale end timer and changing Stop -> Play.
                  if(normalTransportRepeatEnabled()){
                    endStopScheduled=false;cursorBeat=playbackLoopStartBeat;chunkStartsCycle=true;
                    nextAudioStart=Math.max(audioCtx.currentTime+.02,end);
                    scheduleNext();return;
                  }
                  stopPlayback();
                },Math.max(10,(end-audioCtx.currentTime)*1000+35));
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
    highlightTimers.forEach(clearTimeout);highlightTimers.clear();
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
  function partMidi(p){const ppq=480,E=[];if(p.type==='lead'){for(const x of p.events){if(x.voxBlank===true)continue;const start=leadEventStartBeat(p,x),t=Math.round(start*ppq),n=Math.max(0,Math.min(127,x.midi+(p.octave||0)*12+((core.isBassSound?.(p.sound)||p.sound==='electric_bass_finger')?-12:0))),drawnBeats=leadEventDurationBeats(p,x),durBeats=(p.sustain&&drawnBeats<=4/p.resolution)?Math.max(1,drawnBeats):drawnBeats,durTicks=Math.max(30,Math.round(durBeats*ppq*.98));E.push({t,on:1,note:n},{t:t+durTicks,on:0,note:n});}}else if(p.type==='chord'){for(const item of chordFlatItems(p)){const card=item.card,notes=core.notesFor(card,p.data)||[],dur=item.dur,beat=item.startBeat;for(const n of notes){const mn=midiNum(n);E.push({t:Math.round(beat*ppq),on:1,note:mn},{t:Math.round((beat+dur*.98)*ppq),on:0,note:mn});}}}return midiFile(E,songBpm());}
  function drumMidi(b){const map={kick1:36,kick2:36,kick3:35,snare1:38,snare2:38,snare3:40,snare4:38,snare5:40,chh:42,ohh:46,tomHi:50,tomMid:47,tomLow:45,clap:39,rim:37,shaker:82,tamb:54,cowbell:56,conga:64},E=[];if(!b)return midiFile(E,songBpm());for(const [id,bars] of Object.entries(b.tracks||{}))for(let bar=0;bar<(b.bars||1);bar++)for(const st of bars[bar]||[]){const t=Math.round((bar*4+st/16)*480),n=map[id]||37;E.push({t,on:1,note:n},{t:t+60,on:0,note:n});}return midiFile(E,songBpm());}
  function closeStudioExport(){document.getElementById('studioExportModal')?.remove();}
  function openStudioExport(){
    closeStudioExport();syncLoadedChord();const modal=document.createElement('div');modal.id='studioExportModal';modal.className='studio-export-modal';const rows=parts.map(p=>`<label class="studio-export-row"><input type="checkbox" data-export-part="${p.id}" checked><span><strong>${escapeHtml(p.name)}</strong><br><span class="subtle tiny">${p.type==='chord'?'Chord / Note':p.type==='lead'?'Lead / Bass':'Vocals'}</span></span></label>`).join('');
    modal.innerHTML=`<div class="studio-export-backdrop"></div><div class="studio-export-card"><h2>Studio export</h2><p class="subtle">Choose exactly what leaves the project. Musical parts export as editable Chord Rider data; selected vocal parts include every dry WAV used by Vox Box.</p><div class="studio-export-list">${rows}<label class="studio-export-row"><input id="studioExportDrums" type="checkbox" checked><span><strong>Drums</strong><br><span class="subtle tiny">Beat Maker pattern</span></span></label><label class="studio-export-row"><input id="studioExportNotes" type="checkbox"><span><strong>Project notes</strong><br><span class="subtle tiny">Only included when checked</span></span></label></div><div class="studio-export-actions"><button id="studioExportCancel" type="button">Cancel</button><button id="studioExportGo" class="accent" type="button">Export ZIP</button></div></div>`;document.body.appendChild(modal);modal.querySelector('.studio-export-backdrop').onclick=closeStudioExport;modal.querySelector('#studioExportCancel').onclick=closeStudioExport;modal.querySelector('#studioExportGo').onclick=exportStudioPackage;
  }
  async function exportStudioPackage(){
    const modal=$('studioExportModal');if(!modal)return;const ids=[...modal.querySelectorAll('[data-export-part]:checked')].map(x=>x.dataset.exportPart),selected=parts.filter(p=>ids.includes(p.id));if(!selected.length&&!$('studioExportDrums')?.checked&&!$('studioExportNotes')?.checked){core.status('Choose at least one thing to export.');return;}
    const manifest={format:'Chord Rider Pro Studio Package',version:1,createdAt:new Date().toISOString(),project:{name:core.projectName,bpm:core.bpm,beats:core.beats,songStartBeat:effectiveSongStartBeat(),songEndBeat:Number.isFinite(Number(songEndBeat))&&Number(songEndBeat)>0?Number(songEndBeat):null,drumEvents:clone(drumEvents)},parts:selected.map(p=>{const q=clone(p);if(q.type==='vocal')q.recordings=(q.recordings||[]).map(r=>({...r,blob:undefined}));return q;})};if($('studioExportDrums')?.checked)manifest.beatMaker=window.CRPBeatMaker?.getBeat?.()||null;if($('studioExportNotes')?.checked)manifest.notes=core.projectNotes||'';
    const files=[{name:'project.json',data:new TextEncoder().encode(JSON.stringify(manifest,null,2))}];for(const p of selected.filter(x=>x.type==='chord'||x.type==='lead'))files.push({name:`midi/${safeFileName(p.name)}.mid`,data:partMidi(p)});if($('studioExportDrums')?.checked)files.push({name:'midi/Drums.mid',data:drumMidi(window.CRPBeatMaker?.getBeat?.())});for(const p of selected.filter(x=>x.type==='vocal')){const refs=[...voxTrackEvents(p).map(e=>({takeId:e.takeId,sourcePartId:e.sourcePartId})),...(p.activeTakeId?[{takeId:p.activeTakeId,sourcePartId:p.id}]:[])],seen=new Set();for(const ref of refs){if(seen.has(ref.takeId))continue;seen.add(ref.takeId);const found=findVocalTake(ref.takeId,ref.sourcePartId),take=found?.take;if(!take)continue;const blob=await getTakeBlob(take);if(blob)files.push({name:`vocals/${safeFileName(p.name)}-${safeFileName(take.name)}-${String(take.id).slice(0,8)}.wav`,data:new Uint8Array(await blob.arrayBuffer())});}}
    files.push({name:'README.txt',data:new TextEncoder().encode('Chord Rider Pro Studio Package\n\nproject.json contains only the parts you checked. Project notes are included only when their checkbox was selected. Selected vocal parts include every dry WAV referenced by Vox Box. Chord/Note, Lead/Bass, and drums are also exported as Standard MIDI files in /midi for direct import into Cubase and other DAWs. project.json preserves Vox Box event placement, trims, clip FX, and Chord Rider editing data.\n')});const zip=await makeZip(files),a=document.createElement('a');a.href=URL.createObjectURL(zip);a.download=`${safeFileName(core.projectName)}-Studio-Export.zip`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),5000);closeStudioExport();core.status('Studio package exported.');
  }


  // One-file WAV mix export. The user chooses exactly which Chord, Lead/Bass,
  // Vocal and Drum parts are rendered into the song mix.
  const AUDIO_EXPORT_DRUMS={
    kick1:'assets/drums/kick-1.wav',kick2:'assets/drums/kick-2.wav',kick3:'assets/drums/kick-3.wav',
    snare1:'assets/drums/snare-1.wav',snare2:'assets/drums/snare-2.wav',snare3:'assets/drums/snare-3.wav',snare4:'assets/drums/snare-4.wav',snare5:'assets/drums/snare-5.wav',
    chh:'assets/drums/closed-hat.wav',ohh:'assets/drums/open-hat.wav',tomHi:'assets/drums/tom-high.wav',tomMid:'assets/drums/tom-mid.wav',tomLow:'assets/drums/tom-low.wav',
    clap:'assets/drums/clap.wav',rim:'assets/drums/rim.wav',shaker:'assets/drums/shaker.wav',tamb:'assets/drums/tambourine.wav',cowbell:'assets/drums/cowbell.wav',conga:'assets/drums/conga.wav'
  };
  const AUDIO_EXPORT_DRUM_SCALE=.18; // Beat Maker's DRUM_OUTPUT_SCALE
  const AUDIO_EXPORT_SAMPLE_RATE=48000;
  function closeAudioExport(){document.getElementById('audioExportModal')?.remove();}
  function openAudioExport(){
    closeAudioExport();syncLoadedChord();
    const beat=window.CRPBeatMaker?.getBeat?.()||null;
    const rows=parts.map(p=>{
      const unavailable=p.type==='vocal'&&!vocalHasPlayableAudio(p);
      const detail=p.type==='chord'?'Chord / Note':p.type==='lead'?'Lead / Bass':(unavailable?'No vocal audio':'Vox Box arrangement');
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
  // Renders the chosen parts offline (faster than real time, unaffected by a
  // locked screen) over the song range between the start and end markers, with
  // the same note, clip and FX scheduling and gain staging as playback.
  async function renderAudioMix(selected,withDrums,onProgress=()=>{}){
    const OfflineCtx=window.OfflineAudioContext||window.webkitOfflineAudioContext;
    if(!OfflineCtx)throw new Error('Audio export is not supported in this browser.');
    ensureLegacyDrumEvent();
    const beat=withDrums?window.CRPBeatMaker?.getBeat?.()||null:null,beatSec=60/songBpm(),start=effectiveSongStartBeat();
    const drumEnd=!beat?0:drumEvents.length?Math.max(...drumEvents.map(e=>(Number(e.startBeat)||0)+(Number(e.durationBeats)||0))):Math.max(1,Number(beat.bars)||1)*4;
    const natural=Math.max(0,drumEnd,...selected.map(p=>p.type==='vocal'?vocalDurationBeats(p):partDurationBeats(p)));
    const end=effectiveSongEndBeats(natural),customEnd=Number.isFinite(Number(songEndBeat))&&Number(songEndBeat)>start+.03;
    const songSec=Math.max(.05,(end-start)*beatSec),tailSec=customEnd?.08:1.8,sampleRate=AUDIO_EXPORT_SAMPLE_RATE;
    const ctx=new OfflineCtx(2,Math.ceil((songSec+tailSec)*sampleRate),sampleRate);
    const out=ctx.createGain();out.connect(createMixOutput(ctx));
    if(customEnd){out.gain.setValueAtTime(1,Math.max(0,songSec-.045));out.gain.linearRampToValueAtTime(0,songSec);}
    const win={startTime:0,endTime:songSec,fromBeat:start,toBeat:end,endBeat:end,beatSec,includeRunning:true};
    onProgress('Loading sounds…');
    const play=(player,note,at,opts)=>{try{player.play(note,at,opts);}catch{}};
    for(const p of selected.filter(x=>x.type==='chord'||x.type==='lead')){
      const sound=requestedPartSound(p),bus=ctx.createGain(),base=await decodedSound(sound).promise;
      // After the load: the level depends on which engine served the sound.
      bus.gain.value=soundGain(sound)*p.volume*(p.type==='lead'?LEAD_OUTPUT_BOOST:1);
      const fx=core.createInstrumentFxChain?.(ctx,out);if(fx){bus.connect(fx.input);fx.setSound(sound);}else bus.connect(out);
      const player=samplePlayerOn(ctx,base,bus);
      if(p.type==='chord')scheduleChordNotes(p,player,sound,win,play);
      else scheduleLeadNotes(p,player,sound,win,!!core.loop,play);
    }
    const vocals=selected.filter(x=>x.type==='vocal');
    if(vocals.length){
      await ensureVocalWorklet(ctx);await Promise.all(vocals.map(preloadVocalBuffers));
      const chains=new Map(),chainFor=(p,e)=>{
        const key=vocalChainKey(p,e);
        if(!chains.has(key)){const chain=buildVocalChain(ctx,out,effectiveVocalFx(p,e));setVocalChainLevel(chain,p.volume,true);chains.set(key,{key,chain});}
        return chains.get(key);
      };
      for(const p of vocals)scheduleVocalClips(ctx,p,win,{chainFor,bufferFor:e=>vocalBuffers.get(String(e.takeId))});
    }
    if(beat)await scheduleExportDrums(ctx,out,beat,win);
    onProgress('Rendering WAV…');
    const rendered=await ctx.startRendering();
    return {wav:wavFromStereo(rendered.getChannelData(0),rendered.getChannelData(1),sampleRate),frames:rendered.length,sampleRate};
  }
  // Track Master drum regions (or the single Beat Maker pattern), rendered the
  // way Beat Maker plays them: 16 steps per beat, each region with its pattern.
  async function scheduleExportDrums(ctx,destination,beat,win){
    const hasHits=(pattern,id)=>(pattern?.tracks?.[id]||[]).some(a=>Array.isArray(a)&&a.length);
    const buffers=new Map();
    for(const [id,url] of Object.entries(AUDIO_EXPORT_DRUMS)){
      if(!(drumEvents.length?drumEvents.some(ev=>hasHits(ev.pattern,id)):hasHits(beat,id)))continue;
      const res=await fetch(url);if(res.ok)buffers.set(id,await ctx.decodeAudioData(await res.arrayBuffer()));
    }
    if(!buffers.size)return;
    const hit=(pattern,bar,step,at)=>{
      const gain=Math.max(0,Math.min(1,Number(pattern.gain)||0))*AUDIO_EXPORT_DRUM_SCALE;
      for(const [id,buffer] of buffers){if(!pattern.tracks?.[id]?.[bar]?.includes(step))continue;const src=ctx.createBufferSource(),g=ctx.createGain();src.buffer=buffer;g.gain.value=gain;src.connect(g).connect(destination);src.start(at);}
    };
    for(let abs=Math.ceil(win.fromBeat*16-1e-6);abs<win.toBeat*16-1e-6;abs++){
      const songBeat=abs/16,at=win.startTime+(songBeat-win.fromBeat)*win.beatSec;
      if(!drumEvents.length){const bars=Math.max(1,Number(beat.bars)||1);hit(beat,Math.floor(abs/64)%bars,abs%64,at);continue;}
      for(const ev of drumEvents){
        const evStart=Math.max(0,Number(ev.startBeat)||0),evDur=Math.max(0,Number(ev.durationBeats)||0);if(songBeat<evStart-1e-6||songBeat>=evStart+evDur-1e-6)continue;
        const pat=ev.pattern||beat,patternSteps=Math.max(64,Math.max(1,Number(pat.bars)||1)*64),rawStep=Math.round((songBeat-evStart+(Number(ev.patternOffsetBeats)||0))*16),local=((rawStep%patternSteps)+patternSteps)%patternSteps;
        hit(pat,Math.floor(local/64),local%64,at);
      }
    }
  }
  async function exportAudioMix(modal){
    const ids=[...modal.querySelectorAll('[data-audio-part]:checked')].map(x=>x.dataset.audioPart),selected=parts.filter(p=>ids.includes(p.id)),drums=!!modal.querySelector('#audioExportDrums')?.checked;
    if(!selected.length&&!drums){core.status('Choose at least one audio part to export.');return;}
    if(!window.Soundfont&&!window.CRPInstruments&&selected.some(p=>p.type==='chord'||p.type==='lead')){core.status('Sound engine unavailable. Reload while online and try again.');return;}
    const go=modal.querySelector('#audioExportGo');go.disabled=true;go.textContent='Preparing…';
    stopPreview();
    try{
      const {wav}=await renderAudioMix(selected,drums,msg=>{go.textContent=msg;});
      const a=document.createElement('a');a.href=URL.createObjectURL(wav);a.download=`${safeFileName(core.projectName)}-Audio-Mix.wav`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),5000);
      closeAudioExport();core.status('Audio mix exported as WAV.');
    }catch(e){console.error('Audio export failed',e);core.status(e.message||'Could not export audio mix.');go.disabled=false;go.textContent='Export WAV';}
  }

  function partsPayloadForSave(){
    const safe=parts.map(p=>{const q=clone(p);if(q.type==='vocal')q.recordings=(q.recordings||[]).map(({blob,...r})=>r);return q;});
    return {version:6,activePartId,loadedChordPartId,songStartBeat:effectiveSongStartBeat(),songEndBeat:Number.isFinite(Number(songEndBeat))&&Number(songEndBeat)>0?Number(songEndBeat):null,drumEvents:clone(drumEvents),items:safe};
  }
  function refreshPartsFingerprintBaseline(){partsFingerprint=JSON.stringify(partsPayloadForSave());}
  function capture(){syncLoadedChord();ensureLegacyDrumEvent();drumArrangementInitialized=true;for(const p of parts)if(p?.type==='lead')syncLeadBarsToSong(p);const payload=partsPayloadForSave(),fingerprint=JSON.stringify(payload);if(fingerprint!==partsFingerprint){partsUpdatedAt=Math.max(Number(partsUpdatedAt)||0,Date.now());partsFingerprint=fingerprint;}return {...payload,updatedAt:partsUpdatedAt};}
  // Leaving a project: stop audio and drop what was cached for its takes.
  function resetProjectSession(){
    stopPlayback();stopPreview();
    vocalBufferCache.clear();vocalBuffers.clear();voxWaveformPeakCache.clear();
    voxUndoStack=[];voxRedoStack=[];updateVoxHistoryButtons();
  }
  function loadProject(project){
    resetProjectSession();
    const saved=project?.parts;
    partsUpdatedAt=Number(saved?.updatedAt||project?.updatedAt||0)||0;
    songStartBeat=Math.max(0,Number(saved?.songStartBeat)||0);songEndBeat=Number.isFinite(Number(saved?.songEndBeat))&&Number(saved.songEndBeat)>songStartBeat?Number(saved.songEndBeat):null;drumArrangementInitialized=Array.isArray(saved?.drumEvents);drumEvents=drumArrangementInitialized?saved.drumEvents.map(normalizeDrumEvent).filter(Boolean):[];
    if(saved?.items?.length){parts=saved.items.map(normalizePart).filter(Boolean);activePartId=parts.some(p=>p.id===saved.activePartId)?saved.activePartId:(parts.find(p=>p.type==='chord')||parts[0]).id;}
    else {const first=chordPart('Chords 1',core.snapshot());parts=[first];activePartId=first.id;}
    for(const p of allVocalParts())adoptClipTakes(p);
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
      c.data=migrateChordData({...(c.data||core.snapshot()),rows:clone(project.rows)});
    }
    adoptLoadedSongDrums(project);
    loadedChordPartId=c.id;core.apply(c.data);
    if(activePartId!==c.id)selectPart(activePartId);else{setEditorMode('chord');renderParts();}
    refreshPartsFingerprintBaseline();renderSongEndEditor();scheduleRecoverCheck({banner:true});
  }
  function newProject(){resetProjectSession();partsUpdatedAt=0;partsFingerprint='';songStartBeat=0;songEndBeat=null;drumEvents=[];drumArrangementInitialized=true;const p=chordPart('Chords 1',core.snapshot());parts=[p];activePartId=p.id;loadedChordPartId=p.id;setEditorMode('chord');renderParts();renderSongEndEditor();scheduleRecoverCheck({banner:true});}

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
    const out=[];if(!range||range.kind!=='vocal')return out;const beatSec=60/songBpm();for(const event of voxTrackEvents(range.part)){const b=voxEventBounds(event),start=Math.max(range.start,b.start),end=Math.min(range.end,b.end);if(end-start<=.001)continue;const trim0=Math.max(0,Number(event.trimStartSec)||0),seg=clone(event);seg.startBeat=start;seg.trimStartSec=Math.max(0,trim0+(start-b.start)*beatSec);seg.trimEndSec=Math.max(seg.trimStartSec+.001,trim0+(end-b.start)*beatSec);out.push({event:seg,take:clone(voxEventTake(event)),sourcePartId:range.part.id,deltaBeat:start-range.start});}return out;
  }
  function removeVoxRangeContent(range){
    if(!range||range.kind!=='vocal')return 0;const part=range.part,beatSec=60/songBpm(),next=[];let touched=0;for(const event of (part.voxEvents||[])){const b=voxEventBounds(event);if(range.end<=b.start+.001||range.start>=b.end-.001){next.push(event);continue;}touched++;const trim0=Math.max(0,Number(event.trimStartSec)||0),trimEnd=trim0+b.dur*beatSec,leftKeep=range.start>b.start+.001,rightKeep=range.end<b.end-.001;if(leftKeep){const left=clone(event);left.trimEndSec=Math.max(trim0+.001,trim0+(range.start-b.start)*beatSec);next.push(left);}if(rightKeep){const right=clone(event);if(leftKeep)right.id=uid();right.startBeat=range.end;right.trimStartSec=Math.max(trim0,trim0+(range.end-b.start)*beatSec);right.trimEndSec=trimEnd;next.push(right);}}
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
    return {parts:clone(parts),beat:window.CRPBeatMaker?.getBeat?.()||null,drumEvents:clone(drumEvents),drumArrangementInitialized,songStartBeat,effectiveSongEndBeat:songEndBeat,activePartId,loadedChordPartId,voxTargetPartId,voxPlayheadBeat,voxInstrumentTrackFocus:voxInstrumentTrackFocus?clone(voxInstrumentTrackFocus):null,voxToolMode,voxRangeMode,voxRangeSelection:voxRangeSelection?clone(voxRangeSelection):null,bpm:songBpm()};
  }
  function updateVoxHistoryButtons(){if($('voxUndoBtn'))$('voxUndoBtn').disabled=!voxUndoStack.length;if($('voxRedoBtn'))$('voxRedoBtn').disabled=!voxRedoStack.length;}
  // An edit pushes the state from before it; pass a snapshot taken earlier when
  // the edit is only known to have happened later (renames, drum pattern edits).
  function voxCheckpoint(before=voxSnapshot()){voxUndoStack.push(before);if(voxUndoStack.length>50)voxUndoStack.shift();voxRedoStack=[];updateVoxHistoryButtons();}
  function restoreVoxSnapshot(snap){
    if(!snap)return;parts=(snap.parts||[]).map((p,i)=>normalizePart(p,i)).filter(Boolean);ensureInitial();
    activePartId=parts.some(p=>String(p.id)===String(snap.activePartId))?snap.activePartId:(parts[0]?.id||null);
    loadedChordPartId=parts.some(p=>p.type==='chord'&&String(p.id)===String(snap.loadedChordPartId))?snap.loadedChordPartId:(parts.find(p=>p.type==='chord')?.id||null);
    // The snapshot's regions are the drums; Beat Maker gets their pattern below
    // (persistVoxEdits) and the snapshot's mix here, without writing any region.
    if(snap.beat)window.CRPBeatMaker?.setBeat?.(snap.beat,{persist:false});drumEvents=Array.isArray(snap.drumEvents)?snap.drumEvents.map(normalizeDrumEvent).filter(Boolean):drumEvents;drumArrangementInitialized=snap.drumArrangementInitialized!==false;songStartBeat=Math.max(0,Number(snap.songStartBeat)||0);songEndBeat=Number.isFinite(Number(snap.effectiveSongEndBeat))?Number(snap.effectiveSongEndBeat):songEndBeat;
    voxTargetPartId=parts.some(p=>p.type==='vocal'&&String(p.id)===String(snap.voxTargetPartId))?snap.voxTargetPartId:(allVocalParts()[0]?.id||null);voxPlayheadBeat=Math.max(0,Number(snap.voxPlayheadBeat)||0);voxSelections=[];voxSelected=null;voxInstrumentSelections=[];voxInstrumentSelection=null;voxInstrumentTrackFocus=snap.voxInstrumentTrackFocus?clone(snap.voxInstrumentTrackFocus):null;voxToolMode=snap.voxToolMode||voxToolMode;voxRangeMode=!!snap.voxRangeMode;voxRangeSelection=snap.voxRangeSelection?clone(snap.voxRangeSelection):null;
    const c=parts.find(p=>p.type==='chord'&&String(p.id)===String(loadedChordPartId));if(c)core.apply(c.data);
    if(Number.isFinite(Number(snap.bpm))&&Math.round(Number(snap.bpm))!==Math.round(songBpm()))setProjectBpm(Number(snap.bpm));
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
    // With no vocal track there is nothing for the effects panel to edit; keep it out
    // of the way (on phones it otherwise covers half the timeline) unless the user chose.
    const nothingToEdit=!instrumentEditing&&!voxTargetPart();
    setVoxInspectorCollapsed(voxInspectorManualOverride===null?(instrumentEditing||nothingToEdit):voxInspectorManualOverride);
    if(nothingToEdit){
      if($('voxInspectorTitle'))$('voxInspectorTitle').textContent='Track Effects';
      if($('voxInspectorMeta'))$('voxInspectorMeta').textContent='Add a Vocal Track (track ⋮ menu) to use vocal effects.';
      ids.forEach(id=>{if($(id))$(id).disabled=true;});
    }
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
    const b=window.CRPBeatMaker?.getMix?.();if(!b)return;
    voxCheckpoint();
    if(kind==='mute'){b.muted=!b.muted;if(b.muted)b.solo=false;}
    else{b.solo=!b.solo;if(b.solo)b.muted=false;}
    // Mute/solo is the Drums track's mix: no drum pattern is written.
    window.CRPBeatMaker.setMix({muted:b.muted,solo:b.solo});core.scheduleAutoSave();
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
    const n=clampTrackVolumePct(pct),gain=n/100;if(!window.CRPBeatMaker?.setMix)return;
    // Drums are one mixer track even when the Track Master timeline has several
    // drum regions: the volume is that track's gain, which every region plays at
    // (syncDrumMix). It only changes the gain; it never writes a drum pattern, so a
    // Beat Maker copy that is not the song's drums cannot replace them.
    window.CRPBeatMaker.setMix({gain});
    core.scheduleAutoSave();if(commit)core.flushAutoSaveNow?.();
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

  // The ⋮ button is small: on touch, the browser's tap adjustment can deliver
  // the click to the surrounding track label instead. Open on the touch
  // pointerup the button itself receives, and ignore the click that follows.
  function wireTrackMenuButton(btn,openMenu){
    let touchOpenedAt=0;
    btn.addEventListener('pointerup',e=>{
      if(e.pointerType!=='touch')return;
      e.stopPropagation();touchOpenedAt=performance.now();openMenu();
      // The tap's click may land on the label or on the menu that just opened.
      const swallow=c=>{document.removeEventListener('click',swallow,true);if(performance.now()-touchOpenedAt<700){c.preventDefault();c.stopPropagation();}};
      document.addEventListener('click',swallow,true);
    });
    btn.onclick=e=>{e.preventDefault();e.stopPropagation();if(performance.now()-touchOpenedAt>700)openMenu();};
  }
  function makeVoxTrackLabel({name,meta,checked=null,onChecked=null,kind='vocal',part=null}){
    const label=document.createElement('div');label.className='vox-track-label'+(kind!=='vocal'?' vox-instrument-label':'');
    if(checked!==null){const top=document.createElement('label');top.className='vox-track-enable';const c=document.createElement('input');c.type='checkbox';c.checked=!!checked;c.onpointerdown=e=>e.stopPropagation();c.onchange=e=>{e.stopPropagation();onChecked?.(c.checked);};const strong=document.createElement('strong');strong.textContent=name;top.append(c,strong);label.append(top);}else{const strong=document.createElement('strong');strong.textContent=name;label.append(strong);}
    const span=document.createElement('span');span.className='vox-track-meta';span.textContent=meta||'';label.append(span);
    if(part){
      label.dataset.voxPartId=String(part.id);label.dataset.voxPartType=String(part.type);
      appendVoxTrackVolume(label,{part});
      const menu=document.createElement('button');menu.type='button';menu.className='vox-track-menu-btn';menu.textContent='⋮';menu.title='Track actions';menu.setAttribute('aria-label',`${name} track actions`);
      wireTrackMenuButton(menu,()=>{const r=menu.getBoundingClientRect();openVoxTrackContextMenu(part,label,r.right,r.bottom);});label.append(menu);
      appendVoxMuteSolo(label,{part});
    }
    return label;
  }
  function leadEventStartBeat(part,event){const stepBeats=4/Math.max(8,Number(part?.resolution)||16),exact=Number(event?.voxStartBeat);return Number.isFinite(exact)&&exact>=0?exact:(Number(event?.step)||0)*stepBeats;}
  function leadEventDurationBeats(part,event){const stepBeats=4/Math.max(8,Number(part?.resolution)||16),exact=Number(event?.voxDurationBeats);return Number.isFinite(exact)&&exact>0?exact:Math.max(stepBeats,leadDurationSteps(event)*stepBeats);}
  function chordEventDurationBeats(part,card){return chordCardBeats(part?.data,card);}
  function chordCardBeats(data,card){
    // Track Master can use unsnapped/free durations, so preserve an exact
    // voxDurationBeats when it agrees with durationBeats. A disagreement is the
    // legacy CRP MIDI bug: the visible/drawn duration changed while the timeline
    // copy stayed stale. In that case the drawn value wins and load normalization
    // brings the two fields back together.
    const drawn=Number(card?.durationBeats),exact=Number(card?.voxDurationBeats);
    if(Number.isFinite(drawn)&&drawn>0&&Number.isFinite(exact)&&exact>0)return Math.abs(drawn-exact)<=1e-9?exact:drawn;
    if(Number.isFinite(exact)&&exact>0)return exact;
    return Number.isFinite(drawn)&&drawn>0?(core.cardDurationBeats?.(card,data?.beats||core.beats)||drawn):(core.beats||4);
  }
  function chordFlatItems(part){return chordItemsFor(part?.data);}
  function chordItemsFor(data){
    const out=[],rows=data?.rows||[];let cursor=0,flatIndex=0;
    for(let ri=0;ri<rows.length;ri++){const row=rows[ri]||[];for(let ci=0;ci<row.length;ci++){const card=row[ci],dur=chordCardBeats(data,card),startBeat=hasTrackMasterStart(card)?Number(card.voxStartBeat):cursor;out.push({card,rowIndex:ri,cardIndex:ci,flatIndex,startBeat,dur});cursor=Math.max(cursor,startBeat+dur);flatIndex++;}}
    return out;
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
  function addBlankDrumEventAt(beat){
    drumArrangementInitialized=true;voxCheckpoint();const start=Math.max(0,quantizeVoxBeat(beat)),event=normalizeDrumEvent({id:uid(),startBeat:start,durationBeats:4,patternOffsetBeats:0,pattern:blankDrumPattern()});drumEvents.push(event);drumEvents.sort((a,b)=>a.startBeat-b.startBeat);const sel={kind:'drum',key:`drum:${event.id}`,event,startBeat:event.startBeat,dur:event.durationBeats,name:'Drums'};voxInstrumentSelections=[sel];voxInstrumentSelection=sel;voxInstrumentTrackFocus={kind:'drum',name:'Drums',key:'drum-map',explicitTarget:true};persistVoxEdits();renderVoxBox();voxStatus(`Empty 4-beat drum region added at beat ${start.toFixed(2)}. Double-tap the region to edit its pattern.`);
  }
  function openDrumEventEditor(sel){
    const live=resolveVoxInstrumentSelection(sel);if(!live?.event||!window.CRPBeatMaker?.editBeatEvent)return;setVoxInstrumentSelection(live);
    // One undo step per editing session, from the state before it opened (Beat
    // Maker shows the region's pattern while editing).
    const before=voxSnapshot();let checkpointed=false;
    window.CRPBeatMaker.editBeatEvent(live.event.pattern,{onCommit:pattern=>{
      const ev=drumEvents.find(x=>String(x.id)===String(live.event.id));if(!ev||JSON.stringify(ev.pattern)===JSON.stringify(pattern))return;
      if(!checkpointed){voxCheckpoint(before);checkpointed=true;}
      ev.pattern=clone(pattern);markPartsDirty();core.scheduleAutoSave();
    },onClose:()=>{persistVoxEdits();renderVoxBox();voxStatus('Drum region pattern updated.');}});
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
    const label=makeVoxTrackLabel({name:'Drums',meta:`${drumEvents.length} region${drumEvents.length===1?'':'s'}`,checked:master.enabled!==false,onChecked:on=>{if(!window.CRPBeatMaker?.setMix)return;voxCheckpoint();window.CRPBeatMaker.setMix({enabled:on});persistVoxEdits();renderVoxBox();},kind:'drum'});label.title='Double-click (desktop) or double-tap (touch) empty drum-lane space to add a 4-beat region.';label.onclick=e=>{if(e.target.closest('input,label,button'))return;focusVoxInstrumentTrack('drum','Drums','drum-map',{announce:true});};appendVoxTrackVolume(label,{drums:true});appendVoxMuteSolo(label,{drums:true});
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
      if(sel?.kind==='chord'&&sel.part&&sel.card){const player=await playerFor(sel.part);busFor(sel.part);const notes=core.notesFor(sel.card,sel.part.data)||[],at=(audioCtx?.currentTime||0)+.01,dur=Math.max(.28,Math.min(1.6,chordEventDurationBeats(sel.part,sel.card)*(60/songBpm())*.8));for(const [i,n] of notes.entries())playTracked(player,n,at+(sel.part.data?.instrument==='guitar'?i*.025:0),{duration:dur,gain:.88});}
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
    let finished=false;const finish=async(commit=true)=>{if(finished)return;finished=true;const txt=(core.decapsChordText?core.decapsChordText(input.value):input.value).trim();input.remove();if(!commit||!txt){renderVoxBox();return;}
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
    cb.innerHTML='';nb.innerHTML='';if(!chords.length)cb.textContent='—';else for(const x of chords){const chip=document.createElement('span');chip.className='vox-harmony-chip chord';chip.textContent=x;cb.appendChild(chip);}if(!pcs.length)nb.textContent='—';else for(const pc of pcs){const chip=document.createElement('span');chip.className='vox-harmony-chip note'+(tone.includes(pc)?' chord-tone':'')+(roots.includes(pc)?' root-tone':'');chip.textContent=keyNoteName(pc,key);nb.appendChild(chip);}
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
  // A duplicate is a new track: every card, note and clip gets a fresh identity.
  // A vocal copy shares the original's take audio (same take ids), which take
  // deletion reference-counts.
  function duplicateVoxTrack(part){
    if(!part)return;closeVoxTrackContextMenu();voxCheckpoint();
    const src=clone(part),id=uid();
    if(part.type==='chord')for(const card of (src.data?.rows||[]).flat())if(card&&typeof card==='object')card.voxId=uid();
    if(part.type==='lead')src.events=(src.events||[]).map(e=>({...e,voxId:uid()}));
    if(part.type==='vocal')src.voxEvents=(src.voxEvents||[]).map(e=>({...e,id:uid(),sourcePartId:id}));
    const copy=normalizePart({...src,id,name:`${part.name} Copy`},parts.length);
    parts.splice(Math.max(0,parts.indexOf(part)+1),0,copy);persistVoxEdits();renderParts();renderVoxBox();voxStatus(`${copy.name} duplicated.`);
  }
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
            const newEvent=item.event;
            // A note moving to another track gets a fresh identity there.
            if(dst!==src){src.events=(src.events||[]).filter(x=>x!==newEvent&&String(x.voxId||'')!==String(newEvent.voxId||''));newEvent.voxId=uid();}
            const dstStepBeats=4/Math.max(8,Number(dst.resolution)||16);if(!newEvent.voxId)newEvent.voxId=uid();
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
            if(dst!==src){removeChordCardFromPart(src,card);card.voxId=uid();insertChordCardIntoPart(dst,card,targetBeat);voxInstrumentTrackFocus={kind:'chord',name:dst.name,key:`part:${dst.id}`,explicitTarget:true};}
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
        // A rename is one undo step, recorded once the name actually changes.
        let beforeRename=null;
        nameInput.onclick=e=>e.stopPropagation();nameInput.onfocus=()=>{beforeRename=voxSnapshot();voxTargetPartId=part.id;voxSelections=[];voxSelected=null;voxInstrumentSelections=[];voxInstrumentSelection=null;voxInstrumentTrackFocus=null;renderVoxInspector();};
        nameInput.oninput=()=>{if(beforeRename){voxCheckpoint(beforeRename);beforeRename=null;}part.name=String(nameInput.value||'');markPartsDirty();core.scheduleAutoSave();};nameInput.onblur=()=>{beforeRename=null;part.name=String(nameInput.value||'').trim()||`Vocals ${allVocalParts().indexOf(part)+1}`;nameInput.value=part.name;renderParts();markPartsDirty();core.scheduleAutoSave();};
        const meta=document.createElement('span');meta.className='vox-track-meta';meta.textContent=`${Math.round((Number(part.volume)||0)*100)}% • ${(part.voxEvents||[]).length} event${(part.voxEvents||[]).length===1?'':'s'}`;
        const menu=document.createElement('button');menu.type='button';menu.className='vox-track-menu-btn';menu.textContent='⋮';menu.title='Track actions';menu.setAttribute('aria-label',`${part.name} track actions`);wireTrackMenuButton(menu,()=>{const r=menu.getBoundingClientRect();openVoxTrackContextMenu(part,label,r.right,r.bottom);});label.append(nameInput,meta);appendVoxTrackVolume(label,{part});label.append(menu);appendVoxMuteSolo(label,{part});
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
        if(part.repeat)appendVoxRepeatGhosts(lane,part,ppb,beats);
        updateVoxRangeOverlay(part,lane);row.append(label,lane);tracks.appendChild(row);wireVoxTrackLongPress(label,row);
      }
    }else tracks.insertAdjacentHTML('beforeend','<div class="vocal-empty" style="padding:40px">No vocal tracks yet. Open a track’s ⋮ menu to add a Vocal Track.</div>');
    applyVoxTrackOrder();page?.classList.toggle('range-select-mode',voxRangeMode);page?.classList.toggle('multi-select-mode',voxToolMode==='multi');page?.classList.add('playhead-mode');if($('voxCropBtn')){$('voxCropBtn').textContent='Select';$('voxCropBtn').classList.toggle('is-active',voxRangeMode);$('voxCropBtn').setAttribute('aria-pressed',String(voxRangeMode));$('voxCropBtn').title=voxRangeMode?'Range Select on — drag on desktop; on phone tap start, then tap end':'Range Select — choose a time section on any vocal, instrument, or drum track';$('voxCropBtn').disabled=false;}
    if($('voxToolModeBtn')){$('voxToolModeBtn').textContent='Multi Select';$('voxToolModeBtn').classList.toggle('is-active',voxToolMode==='multi');$('voxToolModeBtn').setAttribute('aria-pressed',String(voxToolMode==='multi'));$('voxToolModeBtn').title=voxToolMode==='multi'?'Multi Select on — Track Master behaves normally; tap events to add/remove them from the selection':'Multi Select off — normal single-event editing';}
    updateVoxSelectAllUi();
    renderVoxSongLocators();updateVoxPlayhead(voxPlayheadBeat);renderVoxHarmonyGuide();renderVoxInspector();updateVoxTransportState();
  }
  // A vocal part with Repeat on loops its clips on its own length until the song
  // ends. Draw those repeats, ghosted and not editable, so the lane shows what plays.
  function appendVoxRepeatGhosts(lane,part,ppb,timelineBeats){
    const bounds=voxTrackEvents(part).map(e=>({e,...voxEventBounds(e)}));if(!bounds.length)return;
    const period=vocalPeriodBeats(bounds),end=Math.min(timelineBeats,mediaDurationBeats());
    for(let k=1;k*period<end;k++)for(const b of bounds){
      const start=b.start+k*period;if(start>=end)continue;
      const ghost=document.createElement('div');
      ghost.className='vox-event vox-event-repeat';ghost.setAttribute('aria-hidden','true');
      ghost.style.cssText=`left:${start*ppb}px;width:${Math.max(24,Math.min(b.dur,end-start)*ppb)}px;opacity:.38;pointer-events:none;border-style:dashed;`;
      ghost.innerHTML=`<div class="vox-event-top"><span class="vox-event-name">↻ ${escapeHtml(voxEventTake(b.e)?.name||'Vocal event')}</span></div>`;
      lane.appendChild(ghost);
    }
  }
  function findVoxLaneAt(x,y){return document.elementsFromPoint?.(x,y)?.find(el=>el.classList?.contains('vox-track-lane'))||null;}
  function beginVoxPointerEdit(e,part,event,el,mode){
    if(e.button!==undefined&&e.button!==0)return;
    const touchPointer=e.pointerType==='touch',holdToMove=touchPointer&&mode==='move',pointerId=e.pointerId;
    if(holdToMove)e.stopPropagation();else{e.preventDefault();e.stopPropagation();}
    const add=voxToolMode==='multi'||e.ctrlKey||e.metaKey||e.shiftKey,wasSelected=voxIsSelected(part.id,event.id),desktopSelectionOnly=(!touchPointer&&voxToolMode==='multi'&&mode==='move'&&!wasSelected);
    const selectForEdit=()=>{if(!voxIsSelected(part.id,event.id)){voxSetSelection(part,event,{add,render:false});el.classList.add('is-selected');el.__voxPointerSelected=true;}renderVoxSelectionClasses();renderVoxInspector();};
    if(!holdToMove)selectForEdit();
    const ppb=voxPpb(),beatSec=60/songBpm(),downX=e.clientX,downY=e.clientY,origStart=Number(event.startBeat)||0,origTrimStart=Math.max(0,Number(event.trimStartSec)||0),take=voxEventTake(event),full=Math.max(0,Number(take?.duration)||0),origTrimEnd=Math.max(origTrimStart,Math.min(full,Number.isFinite(Number(event.trimEndSec))&&Number(event.trimEndSec)>0?Number(event.trimEndSec):full)),origEndBeat=origStart+(origTrimEnd-origTrimStart)/beatSec,dragThreshold=touchPointer?6:4;
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
    const up=ev=>{if(ev.pointerId!==pointerId)return;if(armed){ev.preventDefault();ev.stopPropagation();}const wasArmed=armed;cleanup();el.__voxDragged=moved;if(holdToMove&&wasArmed&&!moved){el.__voxPointerSelected=false;el.__voxSuppressClickUntil=performance.now()+520;}if(!moved)return;if(mode==='move'&&selectedAtStart.length===1&&String(targetPartId)!==String(part.id)){const dest=parts.find(p=>p.type==='vocal'&&String(p.id)===String(targetPartId));if(dest){part.voxEvents=(part.voxEvents||[]).filter(x=>x.id!==event.id);dest.voxEvents=dest.voxEvents||[];ensureTakeRecord(dest,event.takeId);event.sourcePartId=String(dest.id);dest.voxEvents.push(event);voxSelections=[{partId:dest.id,eventId:event.id}];voxSelected=voxSelections[0];voxTargetPartId=dest.id;}}persistVoxEdits();renderVoxBox();if(mode!=='move')voxStatus('Crop applied. The original dry take remains untouched.');else voxStatus(selectedAtStart.length>1?`${selectedAtStart.length} vocal events moved together.`:'Vocal event moved.');};
    const cancel=ev=>{if(ev.pointerId!==pointerId)return;cleanup();if(moved)renderVoxBox();};
    window.addEventListener('pointermove',move,{capture:true,passive:false});window.addEventListener('pointerup',up,{capture:true,passive:false});window.addEventListener('pointercancel',cancel,{capture:true,passive:true});
  }

  function openVoxBox(options={}){
    const allowNoVocals=!!options.allowNoVocals,forceInstrumentals=!!options.forceInstrumentals,fromVocal=!!options.fromVocal,vocals=allVocalParts();if(!vocals.length&&!allowNoVocals){core.status('Add a Vocals part first.');return;}
    // Capture any CRP/BD chord edits before Vox Box becomes the canonical timeline
    // editor. Once open, syncLoadedChord() intentionally stops replacing part.data.
    syncLoadedChord();
    voxOpenedFromVocal=fromVocal;if(forceInstrumentals){try{localStorage.setItem(VOX_INST_KEY,'1')}catch{}voxShowInstrumentals=true;}
    voxBoxOpen=true;try{const savedInspector=localStorage.getItem(VOX_INSPECTOR_COLLAPSED_KEY);voxInspectorManualOverride=savedInspector===null?null:savedInspector==='1';}catch{voxInspectorManualOverride=null;}voxTargetPartId=vocals.length?(active()?.type==='vocal'?active().id:vocals[0].id):null;voxSelections=[];voxSelected=null;voxInstrumentSelections=[];voxInstrumentSelection=null;voxInstrumentTrackFocus=null;voxRangeMode=false;voxRangeSelection=null;voxUndoStack=[];voxRedoStack=[];const page=$('voxBoxPage');if(page){page.hidden=false;page.setAttribute('aria-hidden','false');}document.body.classList.add('vox-box-open');
    try{$('voxSnapToBeat').checked=localStorage.getItem(VOX_SNAP_KEY)!=='0';$('voxSnapResolution').value=localStorage.getItem(VOX_RES_KEY)||'16';/* Track Master always opens with follow enabled. Any manual timeline interaction below turns it off for the current session. */voxAutoScroll=true;localStorage.setItem(VOX_AUTO_KEY,'1');voxShowInstrumentals=forceInstrumentals?true:(fromVocal?false:localStorage.getItem(VOX_INST_KEY)==='1');const savedTool=localStorage.getItem(VOX_TOOL_KEY)||'playhead';voxToolMode=savedTool==='cursor'?'multi':(savedTool==='multi'?'multi':'playhead');}catch{voxAutoScroll=true;}
    renderVoxBox();restoreVoxTransportPosition();updateVoxHistoryButtons();
  }
  function openTrackMaster(){
    openVoxBox({allowNoVocals:true,forceInstrumentals:true,fromVocal:false});
    if(voxBoxOpen&&!allVocalParts().length)voxStatus('Track Master open. Instrument tracks are ready; add a Vocal Track whenever you want to record or edit vocals.');
  }
  function closeVoxBox(){voxBoxOpen=false;const page=$('voxBoxPage');if(page){page.hidden=true;page.setAttribute('aria-hidden','true');}document.body.classList.remove('vox-box-open');const p=active();renderParts();if(p){setEditorMode(p.type);if(p.type==='lead')renderLeadEditor(p);else if(p.type==='vocal')renderVocalEditor(p);} }
  function splitSelectedVox(){
    const split=quantizeVoxBeat(voxPlayheadBeat),vocalSelected=voxSelectionPairs(),drumSelected=voxInstrumentSelectionList().filter(s=>s.kind==='drum'),validV=vocalSelected.filter(({event})=>{const b=voxEventBounds(event);return split>b.start+.01&&split<b.end-.01;}),validD=drumSelected.filter(s=>split>s.startBeat+.01&&split<s.startBeat+s.dur-.01);
    if(!validV.length&&!validD.length){voxStatus('Move the playhead inside the selected vocal or drum event, then Split.');return;}voxCheckpoint();const beatSec=60/songBpm(),newV=[],newI=[];
    for(const {part,event} of validV){const b=voxEventBounds(event),splitSec=(Number(event.trimStartSec)||0)+(split-b.start)*beatSec,oldEnd=event.trimEndSec;event.trimEndSec=splitSec;const right=clone(event);right.id=uid();right.startBeat=split;right.trimStartSec=splitSec;right.trimEndSec=oldEnd;const ix=part.voxEvents.findIndex(x=>x.id===event.id);part.voxEvents.splice(ix+1,0,right);newV.push({partId:part.id,eventId:right.id});}
    for(const s of validD){const ev=s.event,oldEnd=ev.startBeat+ev.durationBeats,leftDur=split-ev.startBeat,rightDur=oldEnd-split,right=normalizeDrumEvent({...clone(ev),id:uid(),startBeat:split,durationBeats:rightDur,patternOffsetBeats:(Number(ev.patternOffsetBeats)||0)+leftDur});ev.durationBeats=leftDur;drumEvents.push(right);newI.push({kind:'drum',key:`drum:${right.id}`,event:right,startBeat:right.startBeat,dur:right.durationBeats,name:'Drums'});}
    drumEvents.sort((a,b)=>a.startBeat-b.startBeat);voxSelections=newV;voxSelected=newV[0]||null;voxInstrumentSelections=newI;voxInstrumentSelection=newI[0]||null;persistVoxEdits();renderVoxBox();voxStatus(`${validV.length+validD.length} event${validV.length+validD.length===1?'':'s'} split.`);
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
      const vocalTracks=allVocalParts(),baseTrack=vocalTracks.indexOf(vocals[0].part);voxClipboard={kind:'mixed',focusKeyAtCopy:String(voxInstrumentTrackFocus?.key||''),vocalItems:vocals.map(({part,event})=>({event:clone(event),take:clone(voxEventTake(event)),sourcePartId:part.id,deltaBeat:(Number(event.startBeat)||0)-anchor,trackOffset:vocalTracks.indexOf(part)-baseTrack})),instrumentItems:serializeInstrumentClipboardItems(inst,anchor)};
    }else if(inst.length){voxClipboard={kind:'instrument-group',focusKeyAtCopy:String(voxInstrumentTrackFocus?.key||''),items:serializeInstrumentClipboardItems(inst,anchor)};}
    else{const vocalTracks=allVocalParts(),baseTrack=vocalTracks.indexOf(vocals[0].part);voxClipboard={kind:'vocal',items:vocals.map(({part,event})=>({event:clone(event),take:clone(voxEventTake(event)),sourcePartId:part.id,deltaBeat:(Number(event.startBeat)||0)-anchor,trackOffset:vocalTracks.indexOf(part)-baseTrack}))};}
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
    const pasteVocals=items=>{if(!target)return;for(const item of items||[]){const dest=vocalTracks[Math.max(0,Math.min(vocalTracks.length-1,base+(Number(item.trackOffset)||0)))]||target,ev=normalizeVoxEvent({...clone(item.event),id:uid(),sourcePartId:dest.id,startBeat:Math.max(0,Math.round((voxPlayheadBeat+(Number(item.deltaBeat)||0))*1000)/1000)},dest);dest.voxEvents=dest.voxEvents||[];ensureTakeRecord(dest,ev.takeId,item.take);dest.voxEvents.push(ev);newV.push({partId:dest.id,eventId:ev.id});}};
    if(voxClipboard.kind==='vocal'||voxClipboard.kind==='vocal-range')pasteVocals(voxClipboard.items);else if(voxClipboard.kind==='mixed'){pasteVocals(voxClipboard.vocalItems);for(const item of voxClipboard.instrumentItems||[]){const dest=destinationInstrumentPartForClip(item),s=pasteOneInstrumentClip(item,voxPlayheadBeat+(Number(item.deltaBeat)||0),dest);if(s)newI.push(s);}}else{voxUndoStack.pop();updateVoxHistoryButtons();return;}
    voxSelections=newV;voxSelected=newV[0]||null;voxInstrumentSelections=newI;voxInstrumentSelection=newI[0]||null;persistVoxEdits();renderParts();renderVoxBox();const n=newV.length+newI.length;voxStatus(`${n} event${n===1?'':'s'} pasted in order; earliest event starts at beat ${voxPlayheadBeat.toFixed(2)}.`);
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
    const bpm=Math.round(songBpm());
    if(String(box.value)!==String(bpm))box.value=String(bpm);
  }
  function commitVoxBpm(){
    const box=$('voxBpmInput');if(!box||!$('bpmInput'))return;
    const raw=Number(box.value);if(!Number.isFinite(raw)){syncVoxBpmInput();return;}
    const bpm=Math.max(40,Math.min(240,Math.round(raw)));box.value=String(bpm);
    if(bpm===Math.round(songBpm()))return;
    voxCheckpoint();setProjectBpm(bpm);voxStatus(`BPM set to ${bpm}.`);
  }
  // Reuses the Suite's BPM input path so CRP, Baby DAW and linked SRP all
  // receive the same committed tempo.
  function setProjectBpm(bpm){
    const main=$('bpmInput');if(!main)return;main.value=String(bpm);
    main.dispatchEvent(new Event('input',{bubbles:true}));main.dispatchEvent(new Event('change',{bubbles:true}));
    syncVoxBpmInput();updateMediaMetadata();
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
    ensureInitial();setEditorMode(active()?.type||'chord');ensureRecordOffsetControl();renderParts();ensureMediaSession();updateMediaMetadata();renderSongEndEditor();scheduleRecoverCheck({banner:true});
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
    if($('voxCropBtn'))$('voxCropBtn').onclick=()=>{voxRangeMode=!voxRangeMode;voxRangeSelection=null;voxSelections=[];voxSelected=null;voxInstrumentSelections=[];voxInstrumentSelection=null;if(voxRangeMode){voxToolMode='playhead';try{localStorage.setItem(VOX_TOOL_KEY,'playhead')}catch{}if(!voxInstrumentTrackFocus&&allVocalParts().length&&!voxTargetPartId)voxTargetPartId=allVocalParts()[0].id;}renderVoxBox();voxStatus(voxRangeMode?(window.matchMedia?.('(pointer: coarse)')?.matches?'Select on — tap any vocal, instrument, or drum track for the start, then tap the end. Drag either blue handle to adjust.':'Select on — drag across any vocal, instrument, or drum track. Copy, Cut, or Delete use that range.'):'Select off — normal event editing restored.');};
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
    let voxFollowRaf=0;const voxFollowTick=()=>{if(voxBoxOpen){let beat=null;if(playing||starting)beat=currentCycleBeat();else if(recording)beat=recordInsertBeat+recordedSeconds()*songBpm()/60;if(Number.isFinite(beat))updateVoxPlayhead(beat,voxAutoScroll);}voxFollowRaf=requestAnimationFrame(voxFollowTick);};if(voxFollowRaf)cancelAnimationFrame(voxFollowRaf);voxFollowRaf=requestAnimationFrame(voxFollowTick);
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
    const bpm=clampBpm(+playbackClockBpm||core.bpm);
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
  },isRecording:()=>recording,isRecordingPaused:()=>recordingPaused,beginVocalRecording:beginRecording,pauseVocalRecording:toggleRecordingPause,stopVocalRecording:endRecording,openLyricsOverlay,stopPlayback,capture,loadProject,newProject,syncActiveChord,syncCoreLive,syncMidiTimelineFromCore,syncCloudAudio,openStudioExport,openAudioExport,refreshBabySetupToggle,syncBeatMakerMaster,syncDrumMix,syncDrumMasterToBeatMaker:()=>syncDrumMasterToBeatMaker(),focusChordPart(){const c=parts.find(p=>p.type==='chord');if(!c){refreshBabySetupToggle();return;}if(activePartId!==c.id)selectPart(c.id);else{setEditorMode('chord');refreshBabySetupToggle();core.refreshSetupVisibility?.();}},getActiveChordId(){return loadedChordPartId;},getExportData(){syncLoadedChord();return clone(parts);}};
  // app.js intentionally loads first to expose CRPCore. Tell it that the parts module now
  // exists so the active saved project can be rehydrated with ALL Baby DAW parts before any
  // workspace navigation/save is allowed to capture state.
  try{window.dispatchEvent(new CustomEvent('crp-parts-ready'));}catch{}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',wire);else wire();
})();
