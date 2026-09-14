(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const core = window.CRPCore;
  if(!core) return;

  const clone = v => JSON.parse(JSON.stringify(v));
  const uid = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const NOTE_NAMES=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  const SOUND_GAIN={acoustic_grand_piano:2.35,electric_piano_1:2.35,acoustic_guitar_steel:2.55,electric_guitar_clean:2.45,synth_strings_1:1.05,electric_bass_finger:1.05};
  const LEAD_OUTPUT_BOOST=1.90; // Lead/Bass parts were much quieter than chord playback

  let parts=[];
  let activePartId=null;
  let loadedChordPartId=null;
  let leadBarPage=0;
  let playing=false, starting=false, playbackGeneration=0;
  let audioCtx=null, masterLimiter=null, cycleTimer=null;
  let playerCache=new Map(), partBuses=new Map(), highlightTimers=[], activeVoices=new Set(), vocalBufferCache=new Map(), activeVocalSources=new Set();
  let micStream=null,micCtx=null,micSource=null,micAnalyser=null,micProcessor=null,micSilentGain=null,micMeterRaf=0;
  let recording=false,recordingPaused=false,recordChunks=[],recordSampleRate=48000,recordStartedAt=0,recordPausedAt=0,recordPausedTotal=0,recordTimer=null,currentPreview=null;
  let leadBarClipboard=null, speechRec=null, speechBase='';

  function chordPart(name='Chords 1', data=null){
    const d=data?clone(data):core.snapshot();
    if(!d.rows?.length)d.rows=[[]];
    return {id:uid(),type:'chord',name,enabled:true,volume:.85,data:d};
  }
  function leadPart(name='Lead 1'){
    return {id:uid(),type:'lead',name,enabled:true,repeat:true,sustain:false,volume:.8,instrument:'piano',sound:'acoustic_grand_piano',octave:0,gridOctave:3,resolution:16,bars:4,events:[]};
  }
  function vocalPart(name='Vocals 1'){
    return {id:uid(),type:'vocal',name,enabled:true,repeat:true,volume:1,transcript:'',recordings:[],activeTakeId:null,backingPartIds:[],backingDrums:true,backingVolume:.8,fx:{eq:'clear',comp:'medium',reverb:.12,delay:0}};
  }
  function normalizePart(p,i){
    if(!p||!p.type)return null;
    const base={id:p.id||uid(),name:p.name||`${p.type==='chord'?'Chords':p.type==='lead'?'Lead':'Vocals'} ${i+1}`,enabled:p.enabled!==false,volume:Number.isFinite(+p.volume)?Math.max(0,Math.min(1,+p.volume)):.85};
    if(p.type==='chord')return {...base,type:'chord',data:clone(p.data||core.snapshot())};
    if(p.type==='lead')return {...base,type:'lead',repeat:p.repeat!==false,sustain:p.sustain===true,instrument:p.instrument==='guitar'?'guitar':'piano',sound:p.sound||'acoustic_grand_piano',octave:Number(p.octave)||0,gridOctave:Number(p.gridOctave)||3,resolution:[8,16,32,64].includes(+p.resolution)?+p.resolution:16,bars:Math.max(1,Math.min(16,+p.bars||4)),events:Array.isArray(p.events)?p.events.map(e=>({step:+e.step,midi:+e.midi})).filter(e=>Number.isFinite(e.step)&&Number.isFinite(e.midi)):[]};
    return {...base,type:'vocal',repeat:p.repeat!==false,transcript:String(p.transcript||''),transcriptWords:Array.isArray(p.transcriptWords)?p.transcriptWords:[],recordings:Array.isArray(p.recordings)?p.recordings.map(r=>({...r,blob:null})):[],activeTakeId:p.activeTakeId||null,backingPartIds:Array.isArray(p.backingPartIds)?p.backingPartIds:[],backingDrums:p.backingDrums!==false,backingVolume:Number.isFinite(+p.backingVolume)?Math.max(0,Math.min(1,+p.backingVolume)):.8,fx:{eq:p.fx?.eq||'clear',comp:p.fx?.comp||'medium',reverb:Number(p.fx?.reverb??.12),delay:Number(p.fx?.delay||0)}};
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
    if(playing||starting)stopPlayback();
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
    const slider=$('activePartVolume');const paintRange=el=>el?.style.setProperty('--range-fill',`${el.value}%`);paintRange(slider);slider.oninput=()=>{paintRange(slider);p.volume=+slider.value/100;$('activePartVolumeValue').textContent=`${slider.value}%`;const pill=[...document.querySelectorAll('.part-pill')].find(x=>x.querySelector('.part-open')?.textContent===p.name);if(pill)pill.querySelector('.part-mini-vol').textContent=`${slider.value}%`;if(p.type==='lead'&&$('leadVolume')){$('leadVolume').value=slider.value;$('leadVolumeValue').textContent=`${slider.value}%`;}if(p.type==='vocal'&&$('vocalVolume')){$('vocalVolume').value=slider.value;$('vocalVolumeValue').textContent=`${slider.value}%`;}core.scheduleAutoSave();};
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
    $('leadPartTitle').textContent=p.name;if($('leadRepeat'))$('leadRepeat').checked=p.repeat!==false;if($('leadSustain'))$('leadSustain').checked=p.sustain===true;
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
        cell.onclick=()=>{const i=p.events.findIndex(e=>e.step===abs&&e.midi===midi);if(i>=0)p.events.splice(i,1);else p.events.push({step:abs,midi});cell.classList.toggle('on',i<0);auditionLeadNote(p,midi);core.scheduleAutoSave();};
        grid.appendChild(cell);
      }
    }
  }
  function copyLeadBar(){const p=active();if(!p||p.type!=='lead')return;const spb=p.resolution,start=leadBarPage*spb;leadBarClipboard={resolution:p.resolution,events:p.events.filter(e=>e.step>=start&&e.step<start+spb).map(e=>({beat:(e.step-start)/(p.resolution/4),midi:e.midi}))};if($('leadPasteBar'))$('leadPasteBar').disabled=false;core.status(`Copied bar ${leadBarPage+1} (${leadBarClipboard.events.length} note${leadBarClipboard.events.length===1?'':'s'}).`);}
  function pasteLeadBar(){const p=active();if(!p||p.type!=='lead'||!leadBarClipboard)return;const spb=p.resolution,start=leadBarPage*spb;p.events=p.events.filter(e=>e.step<start||e.step>=start+spb);for(const e of leadBarClipboard.events){const rel=Math.round(e.beat*(p.resolution/4));if(rel>=0&&rel<spb)p.events.push({step:start+rel,midi:e.midi});}renderLeadGrid(p);core.scheduleAutoSave();core.status(`Pasted into bar ${leadBarPage+1}.`);}
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
  function renderVocalBacking(p){const box=$('vocalBackingParts');if(!box)return;const candidates=parts.filter(x=>x.id!==p.id&&(x.type==='chord'||x.type==='lead'));if(!p.backingPartIds?.length)p.backingPartIds=candidates.filter(x=>x.enabled).map(x=>x.id);box.innerHTML='';candidates.forEach(x=>{const lab=document.createElement('label');lab.className='vocal-backing-item';const chk=document.createElement('input');chk.type='checkbox';chk.checked=p.backingPartIds.includes(x.id);chk.onchange=()=>{p.backingPartIds=candidates.filter(c=>box.querySelector(`[data-back-id="${c.id}"]`)?.checked).map(c=>c.id);core.scheduleAutoSave();};chk.dataset.backId=x.id;const span=document.createElement('span');span.textContent=x.name;lab.append(chk,span);box.appendChild(lab);});if(!candidates.length)box.innerHTML='<span class="subtle tiny">Add a Chord/Note or Lead/Bass part for a headphone backing track.</span>';}
  async function renderVocalTakes(p){const box=$('vocalTakes');if(!box)return;box.innerHTML='';if(!p.recordings.length){box.innerHTML='<div class="vocal-empty">No takes yet. Put on headphones and tap Record.</div>';return;}for(const take of [...p.recordings].reverse()){const row=document.createElement('div');row.className='vocal-take'+(p.activeTakeId===take.id?' active':'');const main=document.createElement('div');main.className='vocal-take-main';main.innerHTML=`<div class="vocal-take-name">${escapeHtml(take.name||'Vocal take')}<span class="cloud-badge ${take.cloud?'':'pending'}">${take.cloud?'☁ Cloud':'Device'}</span></div><div class="vocal-take-meta">${fmtTime(take.duration)} • ${take.sampleRate||48000} Hz WAV • ${new Date(take.createdAt).toLocaleString()}</div>`;const use=document.createElement('button');use.type='button';use.className='take-use';use.textContent=p.activeTakeId===take.id?'Using':'Use';use.onclick=()=>{p.activeTakeId=take.id;p.transcript=take.transcript||'';p.transcriptWords=take.transcriptWords||[];renderVocalTakes(p);if($('vocalTranscript'))$('vocalTranscript').value=p.transcript||'';core.scheduleAutoSave();};const play=document.createElement('button');play.type='button';play.textContent='▶';play.title='Preview take';play.onclick=()=>previewTake(p,take,play);const dl=document.createElement('button');dl.type='button';dl.className='take-download';dl.textContent='↓ WAV';dl.onclick=()=>downloadTake(take);const del=document.createElement('button');del.type='button';del.className='take-delete';del.textContent='×';del.title='Delete take';del.onclick=async()=>{if(!confirm(`Delete “${take.name}”?`))return;stopPreview();await vocalDbDelete(take.id).catch(()=>{});await deleteTakeCloud(take);vocalBufferCache.delete(take.id);p.recordings=p.recordings.filter(r=>r.id!==take.id);if(p.activeTakeId===take.id)p.activeTakeId=p.recordings.at(-1)?.id||null;renderVocalTakes(p);core.scheduleAutoSave();};row.append(main,use,play,dl,del);box.appendChild(row);}}
  function renderVocalEditor(p=active()){
    if(!p||p.type!=='vocal')return;$('vocalPartTitle').textContent=p.name;if($('vocalTranscript'))$('vocalTranscript').value=p.transcript||'';if($('vocalRepeat'))$('vocalRepeat').checked=p.repeat!==false;$('vocalVolume').value=Math.round(p.volume*100);$('vocalVolumeValue').textContent=`${Math.round(p.volume*100)}%`;renderVocalBacking(p);$('vocalBackingDrums').checked=p.backingDrums!==false;$('vocalBackingVolume').value=Math.round((p.backingVolume??.8)*100);$('vocalBackingVolumeValue').textContent=`${Math.round((p.backingVolume??.8)*100)}%`;$('vocalFxEq').value=p.fx?.eq||'clear';$('vocalFxComp').value=p.fx?.comp||'medium';$('vocalFxReverb').value=String(p.fx?.reverb??.12);$('vocalFxDelay').value=String(p.fx?.delay||0);renderVocalTakes(p);
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
  async function beginRecording(){
    const p=active();if(!p||p.type!=='vocal'||recording)return;try{stopPreview();await ensureMic();window.CRPParts?.stopPlayback?.();recordChunks=[];micProcessor=micCtx.createScriptProcessor(4096,1,1);micSilentGain=micCtx.createGain();micSilentGain.gain.value=0;micSource.connect(micProcessor);micProcessor.connect(micSilentGain);micSilentGain.connect(micCtx.destination);micProcessor.onaudioprocess=e=>{if(recording&&!recordingPaused)recordChunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));};recording=true;recordingPaused=false;recordPausedAt=0;recordPausedTotal=0;recordStartedAt=performance.now();if($('vocalSpeechStatus'))$('vocalSpeechStatus').textContent='Recording clean WAV. Cloud transcription runs after the take is saved.';$('vocalRecordBtn').classList.add('recording');$('vocalRecordBtn').disabled=true;$('vocalStopBtn').disabled=false;recordTimer=setInterval(()=>{const now=recordingPaused?recordPausedAt:performance.now();$('vocalTimer').textContent=fmtTime(Math.max(0,(now-recordStartedAt-recordPausedTotal)/1000));},100);
      const oldStates=new Map(parts.map(x=>[x.id,x.enabled]));p._recordOldStates=oldStates;p._recordOldVolumes=new Map(parts.map(x=>[x.id,x.volume]));parts.forEach(x=>{if(x.type==='chord'||x.type==='lead'){x.enabled=p.backingPartIds.includes(x.id);x.volume=(p._recordOldVolumes.get(x.id)??x.volume)*(p.backingVolume??.8);}});const drumToggle=$('crpDrumsToggle');if(drumToggle){p._recordOldDrums=drumToggle.checked;drumToggle.checked=p.backingDrums!==false;drumToggle.dispatchEvent(new Event('change'));}const drumVol=$('crpDrumVolume');if(drumVol){p._recordOldDrumVol=drumVol.value;drumVol.value=String(Math.round(+drumVol.value*(p.backingVolume??.8)));drumVol.dispatchEvent(new Event('input'));}renderParts();setTimeout(()=>{if(recording)startPlayback();},80);core.status('Recording dry WAV. Use headphones so the backing does not bleed into the mic.');
    }catch(e){console.error(e);core.status(e.message||'Could not start microphone.');}
  }
  async function endRecording(){
    const p=active();if(!p||p.type!=='vocal'||!recording)return;if(recordingPaused&&recordPausedAt){recordPausedTotal+=performance.now()-recordPausedAt;}recordingPaused=false;recordPausedAt=0;recording=false;stopSpeechToText();clearInterval(recordTimer);recordTimer=null;$('vocalRecordBtn').classList.remove('recording');$('vocalRecordBtn').disabled=false;$('vocalStopBtn').disabled=true;window.CRPParts?.stopPlayback?.();micProcessor?.disconnect();micSilentGain?.disconnect();if(micProcessor)micProcessor.onaudioprocess=null;micProcessor=null;micSilentGain=null;
    if(p._recordOldStates){for(const x of parts)x.enabled=p._recordOldStates.get(x.id)??x.enabled;delete p._recordOldStates;}if(p._recordOldVolumes){for(const x of parts)x.volume=p._recordOldVolumes.get(x.id)??x.volume;delete p._recordOldVolumes;}const drumToggle=$('crpDrumsToggle');if(drumToggle&&p._recordOldDrums!==undefined){drumToggle.checked=p._recordOldDrums;drumToggle.dispatchEvent(new Event('change'));delete p._recordOldDrums;}const drumVol=$('crpDrumVolume');if(drumVol&&p._recordOldDrumVol!==undefined){drumVol.value=p._recordOldDrumVol;drumVol.dispatchEvent(new Event('input'));delete p._recordOldDrumVol;}renderParts();const duration=Math.max(0,(performance.now()-recordStartedAt-recordPausedTotal)/1000);$('vocalTimer').textContent=fmtTime(duration);if(duration<.25||!recordChunks.length){core.status('Recording was too short.');return;}const blob=floatToWav(recordChunks,recordSampleRate),id=uid(),take={id,name:`Take ${p.recordings.length+1}`,createdAt:new Date().toISOString(),duration,sampleRate:recordSampleRate,size:blob.size};try{await vocalDbPut(id,blob);vocalBufferCache.delete(id);p.recordings.push(take);p.activeTakeId=id;p.transcript='';p.transcriptWords=[];core.scheduleAutoSave();await renderVocalTakes(p);if(core.loggedIn&&core.currentProjectId){try{if($('vocalSpeechStatus'))$('vocalSpeechStatus').textContent='Uploading and transcribing new take…';await uploadTakeToCloud(take,blob,core.currentProjectId);await transcribeTake(p,take,{quiet:true});core.status(`Saved ${take.name} to cloud and transcribed it.`);}catch(te){console.warn('Automatic cloud transcription pending',te);if($('vocalSpeechStatus'))$('vocalSpeechStatus').textContent=`Take is safe. ${te.message||'Tap Transcribe active take after saving.'}`;core.status(`Saved ${take.name}. Cloud transcription can be retried with Transcribe active take.`);}}else{if($('vocalSpeechStatus'))$('vocalSpeechStatus').textContent='Take is safe. Save/sign in, then tap Transcribe active take.';core.status(core.loggedIn?`Saved ${take.name} locally. Save the project to enable cloud transcription.`:`Saved ${take.name} locally. Sign in and save to use cloud transcription.`);}}catch(e){console.error(e);core.status('Take was recorded but could not be stored on this device.');}
  }
  function toggleRecordingPause(){
    if(!recording)return false;
    if(!recordingPaused){
      recordingPaused=true;recordPausedAt=performance.now();
      try{window.CRPParts?.stopPlayback?.();}catch{}
      core.status('Recording paused.');
    }else{
      if(recordPausedAt)recordPausedTotal+=performance.now()-recordPausedAt;
      recordingPaused=false;recordPausedAt=0;
      setTimeout(()=>{if(recording&&!recordingPaused)startPlayback();},60);
      core.status('Recording resumed.');
    }
    return recordingPaused;
  }

  async function downloadTake(take){const blob=await getTakeBlob(take);if(!blob){core.status('This take audio is not available on this device or cloud.');return;}const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`${(take.name||'vocal-take').replace(/[^a-z0-9_-]+/gi,'-')}.wav`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),3000);}
  function stopPreview(){if(currentPreview){try{currentPreview.source?.stop();currentPreview.audio?.pause();}catch{}try{currentPreview.ctx?.close();}catch{}currentPreview=null;}}
  function impulse(ctx,seconds=.9,decay=2.4){const length=Math.floor(ctx.sampleRate*seconds),b=ctx.createBuffer(2,length,ctx.sampleRate);for(let c=0;c<2;c++){const d=b.getChannelData(c);for(let i=0;i<length;i++)d[i]=(Math.random()*2-1)*Math.pow(1-i/length,decay);}return b;}
  async function previewTake(p,take,btn){stopPreview();const blob=await getTakeBlob(take);if(!blob){core.status('This take audio is not available on this device or cloud.');return;}const ctx=new (window.AudioContext||window.webkitAudioContext)(),buf=await ctx.decodeAudioData(await blob.arrayBuffer()),src=ctx.createBufferSource(),eq=ctx.createBiquadFilter(),comp=ctx.createDynamicsCompressor(),dry=ctx.createGain(),wet=ctx.createGain(),rev=ctx.createConvolver(),delay=ctx.createDelay(1),delayGain=ctx.createGain(),out=ctx.createGain();src.buffer=buf;const fx=p.fx||{};eq.type=fx.eq==='warm'?'lowshelf':fx.eq==='bright'?'highshelf':'peaking';eq.frequency.value=fx.eq==='warm'?180:fx.eq==='bright'?4500:2800;eq.gain.value=fx.eq==='flat'?0:fx.eq==='warm'?2:fx.eq==='bright'?2.5:1.5;const c=fx.comp||'medium';comp.threshold.value=c==='off'?0:c==='light'?-12:c==='heavy'?-24:-18;comp.ratio.value=c==='off'?1:c==='light'?2:c==='heavy'?6:3.5;comp.attack.value=.008;comp.release.value=.12;dry.gain.value=1;wet.gain.value=Number(fx.reverb||0);rev.buffer=impulse(ctx,fx.reverb>.25?1.6:fx.reverb>.15?1.1:.7);delay.delayTime.value=Number(fx.delay||0);delayGain.gain.value=fx.delay?0.22:0;out.gain.value=p.volume;src.connect(eq);eq.connect(comp);comp.connect(dry);dry.connect(out);comp.connect(rev);rev.connect(wet);wet.connect(out);comp.connect(delay);delay.connect(delayGain);delayGain.connect(out);out.connect(ctx.destination);src.start();currentPreview={ctx,source:src};src.onended=()=>{try{ctx.close();}catch{}if(currentPreview?.source===src)currentPreview=null;};}

  function partDurationBeats(p){
    if(p.type==='chord')return (p.data?.rows||[]).reduce((n,r)=>n+r.length,0)*core.beats;
    if(p.type==='lead')return p.bars*4;
    return 0;
  }
  function enabledPlayable(){return parts.filter(p=>p.enabled&&(p.type==='chord'||p.type==='lead')&&partDurationBeats(p)>0);}
  function enabledVocals(){return parts.filter(p=>p.enabled&&p.type==='vocal'&&p.activeTakeId&&p.recordings?.some(r=>r.id===p.activeTakeId));}
  function vocalDurationBeats(p){const t=p.recordings?.find(r=>r.id===p.activeTakeId);return t?Math.max(0,(Number(t.duration)||0)*core.bpm/60):0;}
  function ensureAudio(){
    if(!audioCtx)audioCtx=new (window.AudioContext||window.webkitAudioContext)();if(audioCtx.state==='suspended')audioCtx.resume();
    if(!masterLimiter){masterLimiter=audioCtx.createDynamicsCompressor();masterLimiter.threshold.value=-2;masterLimiter.knee.value=0;masterLimiter.ratio.value=20;masterLimiter.attack.value=.003;masterLimiter.release.value=.12;masterLimiter.connect(audioCtx.destination);}
  }
  function busFor(p){
    ensureAudio();let bus=partBuses.get(p.id);if(!bus){bus=audioCtx.createGain();bus.connect(masterLimiter);partBuses.set(p.id,bus);}bus.gain.value=(SOUND_GAIN[p.type==='chord'?p.data.sound:p.sound]||1)*p.volume*(p.type==='lead'?LEAD_OUTPUT_BOOST:1);return bus;
  }
  async function playerFor(p){
    ensureAudio();const sound=p.type==='chord'?p.data.sound:p.sound,key=`${p.id}:${sound}`;if(playerCache.has(key))return playerCache.get(key);if(!window.Soundfont)throw new Error('Sound engine unavailable');
    const promise=Soundfont.instrument(audioCtx,sound,{format:'mp3',soundfont:'MusyngKite',destination:busFor(p)});playerCache.set(key,promise);return promise;
  }
  async function preload(ps){await Promise.all(ps.map(p=>playerFor(p)));}
  function invalidatePartPlayers(p){for(const key of [...playerCache.keys()])if(key.startsWith(`${p.id}:`))playerCache.delete(key);}
  function warmLivePlayer(p){if(!p||!playing)return;playerFor(p).catch(e=>console.warn('Live sound preload failed',e));}
  function syncCoreLive(){
    syncLoadedChord();
    const p=loadedChord();
    if(p){invalidatePartPlayers(p);warmLivePlayer(p);busFor(p);}
  }
  async function auditionLeadNote(p,midi){
    if(!p||p.type!=='lead')return;
    try{
      const player=await playerFor(p);
      busFor(p);
      let soundingMidi=midi+(Number(p.octave)||0)*12;
      if(p.sound==='electric_bass_finger')soundingMidi-=12;
      const at=(audioCtx?.currentTime||0)+.01;
      const beatSec=60/Math.max(40,Math.min(240,+core.bpm||92));
      const auditionDuration=p.sustain?Math.max(.65,beatSec*1.03):.42;
      playTracked(player,midiName(soundingMidi),at,{duration:auditionDuration,gain:.96});
    }catch(e){
      console.warn('Could not audition lead/bass note',e);
      core.status('Could not preview that note.');
    }
  }
  async function vocalBufferFor(p){
    const take=p.recordings?.find(r=>r.id===p.activeTakeId);if(!take)return null;
    if(vocalBufferCache.has(take.id))return vocalBufferCache.get(take.id);
    const promise=(async()=>{const blob=await getTakeBlob(take);if(!blob)return null;ensureAudio();return await audioCtx.decodeAudioData(await blob.arrayBuffer());})();
    vocalBufferCache.set(take.id,promise);
    try{return await promise;}catch(e){vocalBufferCache.delete(take.id);throw e;}
  }
  function connectVocalFx(p,src){
    ensureAudio();const eq=audioCtx.createBiquadFilter(),comp=audioCtx.createDynamicsCompressor(),dry=audioCtx.createGain(),wet=audioCtx.createGain(),rev=audioCtx.createConvolver(),delay=audioCtx.createDelay(1),delayGain=audioCtx.createGain(),out=audioCtx.createGain();
    const fx=p.fx||{};eq.type=fx.eq==='warm'?'lowshelf':fx.eq==='bright'?'highshelf':'peaking';eq.frequency.value=fx.eq==='warm'?180:fx.eq==='bright'?4500:2800;eq.gain.value=fx.eq==='flat'?0:fx.eq==='warm'?2:fx.eq==='bright'?2.5:1.5;
    const c=fx.comp||'medium';comp.threshold.value=c==='off'?0:c==='light'?-12:c==='heavy'?-24:-18;comp.ratio.value=c==='off'?1:c==='light'?2:c==='heavy'?6:3.5;comp.attack.value=.008;comp.release.value=.12;
    dry.gain.value=1;wet.gain.value=Number(fx.reverb||0);rev.buffer=impulse(audioCtx,fx.reverb>.25?1.6:fx.reverb>.15?1.1:.7);delay.delayTime.value=Number(fx.delay||0);delayGain.gain.value=fx.delay?0.22:0;out.gain.value=p.volume;
    src.connect(eq);eq.connect(comp);comp.connect(dry);dry.connect(out);comp.connect(rev);rev.connect(wet);wet.connect(out);comp.connect(delay);delay.connect(delayGain);delayGain.connect(out);out.connect(masterLimiter);
    return {eq,comp,dry,wet,rev,delay,delayGain,out};
  }
  async function scheduleVocalSegment(p,startTime,fromBeat,toBeat,generation){
    if(!playing||generation!==playbackGeneration)return;const buf=await vocalBufferFor(p);if(!buf||!playing||generation!==playbackGeneration)return;
    const beatSec=60/core.bpm,vocalBeats=Math.max(.001,buf.duration/beatSec);
    const scheduleOne=(cycleStartBeat)=>{const clipStart=Math.max(fromBeat,cycleStartBeat),clipEnd=Math.min(toBeat,cycleStartBeat+vocalBeats);if(clipEnd<=clipStart)return;const offsetSec=(clipStart-cycleStartBeat)*beatSec,dur=(clipEnd-clipStart)*beatSec,at=startTime+(clipStart-fromBeat)*beatSec;const src=audioCtx.createBufferSource();src.buffer=buf;connectVocalFx(p,src);activeVocalSources.add(src);src.onended=()=>activeVocalSources.delete(src);try{src.start(at,offsetSec,Math.min(dur,buf.duration-offsetSec));}catch(e){activeVocalSources.delete(src);try{src.disconnect();}catch{}console.warn('Could not schedule vocal',e);}};
    if(p.repeat){const first=Math.max(0,Math.floor(fromBeat/vocalBeats));const last=Math.floor((toBeat-1e-6)/vocalBeats);for(let c=first;c<=last;c++)scheduleOne(c*vocalBeats);}else scheduleOne(0);
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
    if(p.id!==activePartId||p.type!=='lead')return;const t=setTimeout(()=>{document.querySelectorAll('.lead-cell.playing').forEach(c=>c.classList.remove('playing'));document.querySelectorAll(`.lead-cell[data-step="${step}"]`).forEach(c=>c.classList.add('playing'));},Math.max(0,delayMs));highlightTimers.push(t);
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
    activeVocalSources.clear();
    for(const bus of partBuses.values()){try{bus.gain.cancelScheduledValues(audioCtx?.currentTime||0);bus.gain.value=0;bus.disconnect();}catch{}}
    partBuses.clear();
    playerCache.clear();
    if(masterLimiter){try{masterLimiter.disconnect();}catch{}masterLimiter=null;}
  }
  async function scheduleSegment(startTime,fromBeat,toBeat,generation,withVocals=true){
    const beatSec=60/core.bpm;
    for(const p of enabledPlayable()){
      if(!playing||generation!==playbackGeneration)return;
      const player=await playerFor(p);
      if(!playing||generation!==playbackGeneration)return;
      busFor(p);
      if(p.type==='chord'){
        const cards=(p.data.rows||[]).flat();const durBeats=core.beats;
        cards.forEach((card,i)=>{if(!playing||generation!==playbackGeneration)return;const b=i*durBeats;if(b<fromBeat||b>=toBeat)return;const at=startTime+(b-fromBeat)*beatSec;const duration=Math.max(.18,durBeats*beatSec*.92);const notes=core.notesFor(card,p.data)||[];notes.forEach((n,j)=>playTracked(player,n,at+(p.data.instrument==='guitar'?j*.035:0),{duration,gain:.94}));scheduleHighlight((at-audioCtx.currentTime)*1000,p,i);});
      }else{
        const subdiv=p.resolution/4,stepBeats=1/subdiv;
        // Sustain OFF keeps notes tight to the selected grid step. Sustain ON lets each note ring for a full beat.
        const duration=p.sustain?Math.max(.12,beatSec*1.03):Math.max(.05,stepBeats*beatSec*.86);
        const partBeats=Math.max(stepBeats,p.bars*4),firstCycle=p.repeat?Math.max(0,Math.floor(fromBeat/partBeats)):0,lastCycle=p.repeat?Math.floor((toBeat-1e-6)/partBeats):0;
        for(let cyc=firstCycle;cyc<=lastCycle;cyc++)p.events.forEach(e=>{if(!playing||generation!==playbackGeneration)return;const local=e.step*stepBeats,b=local+cyc*partBeats;if(b<fromBeat||b>=toBeat)return;const at=startTime+(b-fromBeat)*beatSec;let midi=e.midi+(Number(p.octave)||0)*12;if(p.sound==='electric_bass_finger')midi-=12;playTracked(player,midiName(midi),at,{duration,gain:.92});scheduleLeadHighlight((at-audioCtx.currentTime)*1000,p,e.step);});
      }
    }
    if(withVocals)for(const p of enabledVocals()){
      if(!playing||generation!==playbackGeneration)return;
      await scheduleVocalSegment(p,startTime,fromBeat,toBeat,generation);
    }
  }
  async function startPlayback(){
    if(playing||starting)stopPlayback();
    syncLoadedChord();const ps=enabledPlayable(),vs=enabledVocals();if(!ps.length&&!vs.length){core.status('Turn on a part with something in it first.');return;}
    const generation=++playbackGeneration;
    starting=true;
    try{
      core.status('Loading parts…');ensureAudio();await Promise.all([preload(ps),...vs.map(v=>vocalBufferFor(v))]);
      if(generation!==playbackGeneration)return;

      // Keep every playback source on the same musical downbeat. Drums use a
      // separate AudioContext, so both engines receive the same relative lead-in
      // instead of drums starting immediately and the parts starting ~100 ms later.
      const leadIn=.16;
      const total=Math.max(...ps.map(partDurationBeats),...vs.map(vocalDurationBeats),4);
      let cursorBeat=(active()?.type==='chord'&&active()?.enabled&&activePartId===loadedChordPartId)?Math.min(core.startBeat(),Math.max(0,total-0.001)):0;
      const initialBeat=cursorBeat;
      await window.CRPBeatMaker?.startMainNow?.(leadIn,initialBeat);
      if(generation!==playbackGeneration)return;

      starting=false;playing=true;core.setPlaying(true);core.status('');
      if(generation!==playbackGeneration||!playing){window.CRPBeatMaker?.stopMainNow?.();return;}

      let nextAudioStart=audioCtx.currentTime+leadIn;
      const chunkBeats=1; // rolling scheduler: enables live sound changes without losing timing
      let vocalsScheduledForCycle=false;

      const scheduleNext=async()=>{
        if(!playing||generation!==playbackGeneration)return;
        const beatSec=60/Math.max(40,Math.min(240,+core.bpm||92));
        const fromBeat=cursorBeat;
        const toBeat=Math.min(total,fromBeat+chunkBeats);
        const span=(toBeat-fromBeat)*beatSec;
        const start=nextAudioStart,end=start+span;

        // Vocals stay as one continuous source for the remainder of each song cycle;
        // chopping a recorded take into one-beat scheduler chunks can click at boundaries.
        if(!vocalsScheduledForCycle){
          for(const v of enabledVocals())await scheduleVocalSegment(v,start,fromBeat,total,generation);
          vocalsScheduledForCycle=true;
        }
        await scheduleSegment(start,fromBeat,toBeat,generation,false);
        if(!playing||generation!==playbackGeneration)return;

        nextAudioStart=end;
        cursorBeat=toBeat;
        if(cursorBeat>=total-1e-7){
          if(core.loop){cursorBeat=0;vocalsScheduledForCycle=false;}
          else{
            cycleTimer=setTimeout(()=>{if(generation===playbackGeneration)stopPlayback();},Math.max(10,(end-audioCtx.currentTime)*1000+35));
            return;
          }
        }

        // Schedule the next beat before the current one reaches the speakers.
        // Web Audio handles the exact timestamp; this timer only feeds the queue.
        const wakeMs=Math.max(8,(end-audioCtx.currentTime-.22)*1000);
        cycleTimer=setTimeout(scheduleNext,wakeMs);
      };
      scheduleNext();
    }catch(e){
      if(generation!==playbackGeneration)return;
      console.error(e);core.status(e.message||'Could not start playback.');stopPlayback();
    }
  }
  function stopPlayback(){
    ++playbackGeneration;starting=false;playing=false;
    clearTimeout(cycleTimer);cycleTimer=null;
    highlightTimers.forEach(clearTimeout);highlightTimers=[];
    document.querySelectorAll('.lead-cell.playing').forEach(c=>c.classList.remove('playing'));
    document.querySelectorAll('.chord-card').forEach(c=>c.style.outline='');
    silenceScheduledAudio();
    core.setPlaying(false);window.CRPBeatMaker?.stopMainNow?.();
  }
  function togglePlayback(){if(playing||starting)stopPlayback();else startPlayback();}

  function crc32(bytes){let c=0xffffffff;for(const b of bytes){c^=b;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;}
  function le16(n){return new Uint8Array([n&255,(n>>>8)&255]);}function le32(n){return new Uint8Array([n&255,(n>>>8)&255,(n>>>16)&255,(n>>>24)&255]);}
  function concatBytes(chunks){const n=chunks.reduce((a,b)=>a+b.length,0),out=new Uint8Array(n);let o=0;for(const b of chunks){out.set(b,o);o+=b.length;}return out;}
  async function makeZip(files){const enc=new TextEncoder(),locals=[],centrals=[];let offset=0;for(const f of files){const name=enc.encode(f.name),data=f.data instanceof Uint8Array?f.data:new Uint8Array(f.data),crc=crc32(data),local=concatBytes([le32(0x04034b50),le16(20),le16(0),le16(0),le16(0),le16(0),le32(crc),le32(data.length),le32(data.length),le16(name.length),le16(0),name,data]);locals.push(local);centrals.push(concatBytes([le32(0x02014b50),le16(20),le16(20),le16(0),le16(0),le16(0),le16(0),le32(crc),le32(data.length),le32(data.length),le16(name.length),le16(0),le16(0),le16(0),le16(0),le32(0),le32(offset),name]));offset+=local.length;}const central=concatBytes(centrals),end=concatBytes([le32(0x06054b50),le16(0),le16(0),le16(files.length),le16(files.length),le32(central.length),le32(offset),le16(0)]);return new Blob([...locals,central,end],{type:'application/zip'});}
  function safeFileName(s){return String(s||'part').replace(/[^a-z0-9 _.-]+/gi,'').trim().replace(/\s+/g,'-')||'part';}
  function midiNum(note){const m=String(note).match(/^([A-G])(#|b)?(-?\d+)$/);if(!m)return 60;const pc={C:0,D:2,E:4,F:5,G:7,A:9,B:11}[m[1]]+(m[2]==='#'?1:m[2]==='b'?-1:0);return Math.max(0,Math.min(127,(+m[3]+1)*12+pc));}
  function vlq(n){n=Math.max(0,Math.floor(n));let a=[n&127];while(n>>=7)a.unshift((n&127)|128);return a;}
  function midiFile(events,bpm=120){const ppq=480,tempo=Math.round(60000000/bpm),ev=[];events.sort((a,b)=>a.t-b.t||a.on-b.on);let last=0;for(const e of events){ev.push(...vlq(e.t-last),e.on?0x90:0x80,e.note&127,e.on?(e.vel||96):0);last=e.t;}ev.push(0,0xff,0x2f,0);const tr=new Uint8Array(ev),head=new Uint8Array([77,84,104,100,0,0,0,6,0,0,0,1,ppq>>8,ppq&255]),th=new Uint8Array([77,84,114,107,(tr.length>>>24)&255,(tr.length>>>16)&255,(tr.length>>>8)&255,tr.length&255]);return concatBytes([head,th,tr]);}
  function partMidi(p){const ppq=480,E=[];if(p.type==='lead'){const stepBeat=4/p.resolution;for(const x of p.events){const t=Math.round(x.step*stepBeat*ppq),n=Math.max(0,Math.min(127,x.midi+(p.octave||0)*12+(p.sound==='electric_bass_finger'?-12:0)));const durTicks=p.sustain?Math.max(30,Math.round(ppq*1.03)):Math.max(30,Math.round(stepBeat*ppq*.86));E.push({t,on:1,note:n},{t:t+durTicks,on:0,note:n});}}else if(p.type==='chord'){let beat=0;for(const row of p.data.rows||[])for(const card of row){const notes=core.notesFor(card,p.data)||[],dur=Math.max(1,core.beats);for(const n of notes){const mn=midiNum(n);E.push({t:Math.round(beat*ppq),on:1,note:mn},{t:Math.round((beat+dur*.92)*ppq),on:0,note:mn});}beat+=dur;}}return midiFile(E,core.bpm);}
  function drumMidi(b){const map={kick1:36,kick2:36,kick3:35,snare1:38,snare2:38,snare3:40,snare4:38,snare5:40,chh:42,ohh:46,tomHi:50,tomMid:47,tomLow:45,clap:39,rim:37,shaker:82,tamb:54,cowbell:56,conga:64},E=[];if(!b)return midiFile(E,core.bpm);for(const [id,bars] of Object.entries(b.tracks||{}))for(let bar=0;bar<(b.bars||1);bar++)for(const st of bars[bar]||[]){const t=Math.round((bar*4+st/16)*480),n=map[id]||37;E.push({t,on:1,note:n},{t:t+60,on:0,note:n});}return midiFile(E,core.bpm);}
  function closeStudioExport(){document.getElementById('studioExportModal')?.remove();}
  function openStudioExport(){
    closeStudioExport();syncLoadedChord();const modal=document.createElement('div');modal.id='studioExportModal';modal.className='studio-export-modal';const rows=parts.map(p=>`<label class="studio-export-row"><input type="checkbox" data-export-part="${p.id}" checked><span><strong>${escapeHtml(p.name)}</strong><br><span class="subtle tiny">${p.type==='chord'?'Chord / Note':p.type==='lead'?'Lead / Bass':'Vocals'}</span></span></label>`).join('');
    modal.innerHTML=`<div class="studio-export-backdrop"></div><div class="studio-export-card"><h2>Studio export</h2><p class="subtle">Choose exactly what leaves the project. Musical parts export as editable Chord Rider data; selected vocal parts include their active dry WAV.</p><div class="studio-export-list">${rows}<label class="studio-export-row"><input id="studioExportDrums" type="checkbox" checked><span><strong>Drums</strong><br><span class="subtle tiny">Beat Maker pattern</span></span></label><label class="studio-export-row"><input id="studioExportNotes" type="checkbox"><span><strong>Project notes</strong><br><span class="subtle tiny">Only included when checked</span></span></label></div><div class="studio-export-actions"><button id="studioExportCancel" type="button">Cancel</button><button id="studioExportGo" class="accent" type="button">Export ZIP</button></div></div>`;document.body.appendChild(modal);modal.querySelector('.studio-export-backdrop').onclick=closeStudioExport;modal.querySelector('#studioExportCancel').onclick=closeStudioExport;modal.querySelector('#studioExportGo').onclick=exportStudioPackage;
  }
  async function exportStudioPackage(){
    const modal=$('studioExportModal');if(!modal)return;const ids=[...modal.querySelectorAll('[data-export-part]:checked')].map(x=>x.dataset.exportPart),selected=parts.filter(p=>ids.includes(p.id));if(!selected.length&&!$('studioExportDrums')?.checked&&!$('studioExportNotes')?.checked){core.status('Choose at least one thing to export.');return;}
    const manifest={format:'Chord Rider Pro Studio Package',version:1,createdAt:new Date().toISOString(),project:{name:core.projectName,bpm:core.bpm,beats:core.beats},parts:selected.map(p=>{const q=clone(p);if(q.type==='vocal')q.recordings=(q.recordings||[]).map(r=>({...r,blob:undefined}));return q;})};if($('studioExportDrums')?.checked)manifest.beatMaker=window.CRPBeatMaker?.getBeat?.()||null;if($('studioExportNotes')?.checked)manifest.notes=core.projectNotes||'';
    const files=[{name:'project.json',data:new TextEncoder().encode(JSON.stringify(manifest,null,2))}];for(const p of selected.filter(x=>x.type==='chord'||x.type==='lead'))files.push({name:`midi/${safeFileName(p.name)}.mid`,data:partMidi(p)});if($('studioExportDrums')?.checked)files.push({name:'midi/Drums.mid',data:drumMidi(window.CRPBeatMaker?.getBeat?.())});for(const p of selected.filter(x=>x.type==='vocal')){const take=p.recordings?.find(r=>r.id===p.activeTakeId);if(!take)continue;const blob=await getTakeBlob(take);if(blob)files.push({name:`vocals/${safeFileName(p.name)}-${safeFileName(take.name)}.wav`,data:new Uint8Array(await blob.arrayBuffer())});}
    files.push({name:'README.txt',data:new TextEncoder().encode('Chord Rider Pro Studio Package\n\nproject.json contains only the parts you checked. Project notes are included only when their checkbox was selected. Selected vocal parts include the active dry WAV master. Chord/Note, Lead/Bass, and drums are also exported as Standard MIDI files in /midi for direct import into Cubase and other DAWs. Vocal parts include the active dry WAV master. project.json preserves Chord Rider editing data.\n')});const zip=await makeZip(files),a=document.createElement('a');a.href=URL.createObjectURL(zip);a.download=`${safeFileName(core.projectName)}-Studio-Export.zip`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),5000);closeStudioExport();core.status('Studio package exported.');
  }

  function capture(){syncLoadedChord();const safe=parts.map(p=>{const q=clone(p);delete q._recordOldStates;delete q._recordOldVolumes;delete q._recordOldDrums;delete q._recordOldDrumVol;if(q.type==='vocal')q.recordings=(q.recordings||[]).map(({blob,...r})=>r);return q;});return {version:2,activePartId,items:safe};}
  function loadProject(project){
    stopPlayback();stopPreview();
    const saved=project?.parts;
    if(saved?.items?.length){parts=saved.items.map(normalizePart).filter(Boolean);activePartId=parts.some(p=>p.id===saved.activePartId)?saved.activePartId:(parts.find(p=>p.type==='chord')||parts[0]).id;}
    else {const first=chordPart('Chords 1',core.snapshot());parts=[first];activePartId=first.id;}
    let c=parts.find(p=>p.id===activePartId&&p.type==='chord')||parts.find(p=>p.type==='chord');
    if(!c){c=chordPart('Chords 1',core.snapshot());parts.unshift(c);}core.apply(c.data);loadedChordPartId=c.id;
    if(activePartId!==c.id)selectPart(activePartId);else{setEditorMode('chord');renderParts();}
  }
  function newProject(){stopPlayback();stopPreview();const p=chordPart('Chords 1',core.snapshot());parts=[p];activePartId=p.id;loadedChordPartId=p.id;setEditorMode('chord');renderParts();}

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

  function wire(){
    ensureInitial();renderParts();
    $('addPartBtn')?.addEventListener('click',openModal);$('closePartModal')?.addEventListener('click',closeModal);document.querySelector('[data-close-part-modal]')?.addEventListener('click',closeModal);document.querySelectorAll('.part-choice').forEach(b=>b.addEventListener('click',()=>addPart(b.dataset.partType)));
    document.querySelectorAll('#leadInstrumentTabs .seg').forEach(b=>b.onclick=()=>{const p=active();if(p?.type!=='lead')return;p.instrument=b.dataset.leadInstrument;p.sound=(core.sounds[p.instrument]||[])[0]?.[0]||p.sound;invalidatePartPlayers(p);renderLeadEditor(p);warmLivePlayer(p);busFor(p);core.scheduleAutoSave();});
    $('leadRepeat').onchange=e=>{const p=active();if(p?.type!=='lead')return;p.repeat=e.target.checked;core.scheduleAutoSave();};
    $('leadSustain').onchange=e=>{const p=active();if(p?.type!=='lead')return;p.sustain=e.target.checked;core.scheduleAutoSave();};
    $('leadSoundSelect').onchange=e=>{const p=active();if(p?.type!=='lead')return;p.sound=e.target.value;invalidatePartPlayers(p);warmLivePlayer(p);busFor(p);core.scheduleAutoSave();};
    $('leadGridOctave').onchange=e=>{const p=active();if(p?.type!=='lead')return;p.gridOctave=+e.target.value;renderLeadGrid(p);core.scheduleAutoSave();};
    $('leadResolution').onchange=e=>{const p=active();if(p?.type!=='lead')return;const old=p.resolution,neu=+e.target.value;if(old!==neu&&p.events.length&&!confirm('Changing resolution keeps notes at their step numbers, so their timing may shift. Continue?')){e.target.value=String(old);return;}p.resolution=neu;renderLeadEditor(p);core.scheduleAutoSave();};
    $('leadBars').onchange=e=>{const p=active();if(p?.type!=='lead')return;p.bars=+e.target.value;const maxSteps=p.bars*(p.resolution/4)*4;p.events=p.events.filter(x=>x.step<maxSteps);leadBarPage=Math.min(leadBarPage,p.bars-1);renderLeadEditor(p);core.scheduleAutoSave();};
    $('leadPrevBar').onclick=()=>{leadBarPage=Math.max(0,leadBarPage-1);renderLeadEditor();};$('leadNextBar').onclick=()=>{const p=active();if(p?.type!=='lead')return;leadBarPage=Math.min(p.bars-1,leadBarPage+1);renderLeadEditor(p);};
    $('leadCopyBar').onclick=copyLeadBar;$('leadPasteBar').onclick=pasteLeadBar;
    $('leadClearBar').onclick=()=>{const p=active();if(p?.type!=='lead')return;const spb=(p.resolution/4)*4,start=leadBarPage*spb,end=start+spb;if(confirm(`Clear bar ${leadBarPage+1}?`)){p.events=p.events.filter(e=>e.step<start||e.step>=end);renderLeadGrid(p);core.scheduleAutoSave();}};
    $('leadVolume').oninput=e=>{const p=active();if(p?.type!=='lead')return;p.volume=+e.target.value/100;$('leadVolumeValue').textContent=`${e.target.value}%`;renderParts();core.scheduleAutoSave();};
    $('vocalVolume').oninput=e=>{const p=active();if(p?.type!=='vocal')return;p.volume=+e.target.value/100;$('vocalVolumeValue').textContent=`${e.target.value}%`;renderParts();core.scheduleAutoSave();};
    $('vocalArmMic').onclick=async()=>{if(recording)return;if(micStream?.active){await disableMic();core.status('Mic test off.');return;}try{await ensureMic();core.status('Mic test on. Aim for strong level without living at the far right of the meter.');}catch(e){core.status(e.message||'Could not access microphone.');}};
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
    for(const id of ['vocalFxEq','vocalFxComp','vocalFxReverb','vocalFxDelay'])$(id).onchange=()=>{const p=active();if(p?.type!=='vocal')return;p.fx={eq:$('vocalFxEq').value,comp:$('vocalFxComp').value,reverb:+$('vocalFxReverb').value,delay:+$('vocalFxDelay').value};core.scheduleAutoSave();};
  }

  window.CRPParts={handlesPlayback:true,togglePlayback,startPlayback,isPlaying:()=>playing||starting,isRecording:()=>recording,isRecordingPaused:()=>recordingPaused,beginVocalRecording:beginRecording,pauseVocalRecording:toggleRecordingPause,stopVocalRecording:endRecording,openLyricsOverlay,stopPlayback,capture,loadProject,newProject,syncActiveChord,syncCoreLive,syncCloudAudio,openStudioExport,focusChordPart(){const c=parts.find(p=>p.type==='chord');if(c&&activePartId!==c.id)selectPart(c.id);},getActiveChordId(){return loadedChordPartId;},getExportData(){syncLoadedChord();return clone(parts);}};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',wire);else wire();
})();
