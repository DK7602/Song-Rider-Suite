(() => {
  'use strict';

  // Older builds kept an unsaved beat here; the core's draft slot now holds it.
  const LEGACY_DRAFT_KEY = 'crp-beat-draft-v1';
  const VERSION = 3;
  const DRUM_OUTPUT_SCALE = .18;
  const SCRIPT_URL = document.currentScript?.src || new URL('beat-maker.js', window.location.href).href;
  const $ = id => document.getElementById(id);

  const DRUMS = [
    ['kick1','Kick 1','assets/drums/kick-1.wav'],
    ['kick2','Kick 2','assets/drums/kick-2.wav'],
    ['kick3','Kick 3','assets/drums/kick-3.wav'],
    ['snare1','Snare 1','assets/drums/snare-1.wav'],
    ['snare2','Snare 2','assets/drums/snare-2.wav'],
    ['snare3','Snare 3','assets/drums/snare-3.wav'],
    ['snare4','Snare 4','assets/drums/snare-4.wav'],
    ['snare5','Snare 5','assets/drums/snare-5.wav'],
    ['chh','Closed Hat','assets/drums/closed-hat.wav'],
    ['ohh','Open Hat','assets/drums/open-hat.wav'],
    ['tomHi','High Tom','assets/drums/tom-high.wav'],
    ['tomMid','Mid Tom','assets/drums/tom-mid.wav'],
    ['tomLow','Low Tom','assets/drums/tom-low.wav'],
    ['clap','Clap','assets/drums/clap.wav'],
    ['rim','Rim','assets/drums/rim.wav'],
    ['shaker','Shaker','assets/drums/shaker.wav'],
    ['tamb','Tambourine','assets/drums/tambourine.wav'],
    ['cowbell','Cowbell','assets/drums/cowbell.wav'],
    ['conga','Conga','assets/drums/conga.wav']
  ];
  const RES = {8:8,16:4,32:2,64:1}; // canonical grid = 64th notes, 64 per 4/4 bar

  let audioCtx = null;
  let buffers = new Map();
  let loading = null;
  let currentBar = 0;
  let copiedBar = null;
  let previewing = false;
  // Preview and the song's drums run on separate timers: previewing a pattern or
  // closing the editor must never stop the drums of a playing song.
  let previewTimer = null;
  let mainTimer = null;
  // Bumped by every transport start and stop, so a start still waiting for the
  // samples is dropped once the song has stopped or started again.
  let mainGen = 0;
  let previewStep = 0;
  let previewNextTime = 0;
  let mainPlaying = false;
  let mainGainScale = 1;
  let mainStep = 0;
  let mainNextTime = 0;
  let mainArrangement = null;
  let mainArrangementRangeStart = 0;
  let mainArrangementRangeEnd = null;
  let mainArrangementCanLoop = true;
  let eventEditCommit = null;
  let eventEditClose = null;
  let eventEditPriorBeat = null;
  let beat = freshBeat();
  let beatUpdatedAt=0;

  function freshBeat(){
    const tracks = {};
    DRUMS.forEach(([id]) => tracks[id] = Array.from({length:16}, () => []));
    return {version:VERSION, enabled:true, muted:false, solo:false, bars:1, resolution:16, gain:.50, tracks};
  }
  function normalizeBeat(src){
    const b = freshBeat();
    if(!src || typeof src !== 'object') return b;
    b.enabled = src.enabled !== false;
    b.muted = src.muted === true;
    b.solo = src.solo === true;
    b.bars = clamp(+src.bars || 1, 1, 16);
    b.resolution = [8,16,32,64].includes(+src.resolution) ? +src.resolution : 16;
    const sourceGain = Number.isFinite(+src.gain) ? +src.gain : .50;
    const sourceVersion = +src.version || 1;
    // v3: the UI still reads 0–100%, but the drum WAVs now run through a
    // fixed output scale so 40–60% is a useful musical range instead of ~7%.
    // Preserve the approximate heard loudness of already-saved v2 beats.
    if(sourceVersion < 2){
      const v2Gain = sourceGain * .65;
      b.gain = Math.max(0, Math.min(1, v2Gain / DRUM_OUTPUT_SCALE));
    }else if(sourceVersion < 3){
      b.gain = Math.max(0, Math.min(1, sourceGain / DRUM_OUTPUT_SCALE));
    }else{
      b.gain = Math.max(0, Math.min(1, sourceGain));
    }
    DRUMS.forEach(([id]) => {
      const bars = src.tracks && Array.isArray(src.tracks[id]) ? src.tracks[id] : [];
      b.tracks[id] = Array.from({length:16}, (_,bar) => {
        const arr = Array.isArray(bars[bar]) ? bars[bar] : [];
        return [...new Set(arr.map(Number).filter(n => Number.isInteger(n) && n >= 0 && n < 64))].sort((a,c)=>a-c);
      });
    });
    return b;
  }
  function clamp(n,a,b){ return Math.max(a,Math.min(b,n)); }
  // The beat lives in memory; the core loads it per project id (loadProject) and
  // saves it as part of the project capture (getBeat), so this module never reads
  // or writes crp-projects itself.
  function loadBeatFromProject(p){
    beatUpdatedAt = Number(p?.beatMakerUpdatedAt||p?.updatedAt||0)||0;
    beat = normalizeBeat(p?.beatMaker);
    currentBar = clamp(currentBar,0,beat.bars-1);
    updateMainControls();
    if($('crpBeatModal')?.classList.contains('open')) renderEditor();
  }
  function persistBeatIntoProject(){
    const now=Date.now();
    beatUpdatedAt=now;
    // When Track Master opens the Beat Maker for one drum region, that region owns
    // the edit.  Do not overwrite the project's legacy/global Beat Maker pattern.
    // The callback stores the edited snapshot in the selected drum event instead.
    if(typeof eventEditCommit==='function'){
      try{eventEditCommit(JSON.parse(JSON.stringify(normalizeBeat(beat))));}catch(e){console.warn('Could not commit drum region edit',e);}
      window.CRPCore?.scheduleAutoSave?.();
      return true;
    }
    // Keep Baby DAW Beat Maker and Track Master drum rail in lockstep.
    // Track Master owns region placement; Beat Maker owns the primary region pattern.
    try{window.CRPParts?.syncBeatMakerMaster?.(normalizeBeat(beat));}catch(e){console.warn('Could not sync Beat Maker to Track Master',e);}
    // The core autosave captures getBeat() into the open project (or the unsaved draft).
    window.CRPCore?.scheduleAutoSave?.();
    return true;
  }
  // Big pattern changes are undoable through the core's undo history. While a
  // Track Master drum region is being edited the history belongs to the song, so
  // ask before replacing the region instead.
  function beforeBigChange(question){
    if(typeof eventEditCommit==='function') return window.confirm(question);
    window.CRPCore?.recordUndo?.();
    return true;
  }
  function countHits(){
    let n=0; DRUMS.forEach(([id])=>{ for(let b=0;b<beat.bars;b++) n += beat.tracks[id][b].length; }); return n;
  }

  function injectUi(){
    if($('crpBeatBtn')) return;
    const playRow = document.querySelector('.play-row');
    if(!playRow) return;
    const wrap = document.createElement('div');
    wrap.className='crp-beat-controls';
    wrap.innerHTML = `
      <button id="crpBeatBtn" class="crp-beat-btn" type="button">Beat</button>
      <label class="check-label"><input id="crpDrumsToggle" type="checkbox" checked> Drums</label>
      <label class="crp-volume-main">Vol <input id="crpDrumVolume" type="range" min="0" max="100" step="1" value="42"><span id="crpDrumVolumeValue">42%</span></label>`;
    playRow.insertAdjacentElement('afterend', wrap);

    const modal = document.createElement('div');
    modal.id='crpBeatModal'; modal.className='crp-beat-modal';
    modal.innerHTML = `
      <div class="crp-beat-panel" role="dialog" aria-modal="true" aria-label="Beat Maker">
        <div class="crp-beat-head">
          <h2>🥁 Beat Maker</h2>
          <label class="crp-beat-tool">Bars <select id="crpBarsSelect">${Array.from({length:16},(_,i)=>`<option>${i+1}</option>`).join('')}</select></label>
          <label class="crp-beat-tool">Grid <select id="crpResolution"><option value="8">1/8</option><option value="16">1/16</option><option value="32">1/32</option><option value="64">1/64</option></select></label>
          <label class="crp-beat-tool crp-volume-tool">Volume <input id="crpBeatVolume" type="range" min="0" max="100" step="1" value="42"><span id="crpBeatVolumeValue">42%</span></label>
          <button id="crpBeatClose" type="button" aria-label="Close Beat Maker">✕</button>
        </div>
        <div class="crp-beat-body">
          <div id="crpBarTabs" class="crp-bar-tabs"></div>
          <div class="crp-grid-wrap"><div id="crpBeatGrid" class="crp-grid"></div></div>
        </div>
        <div class="crp-randomizer">
          <strong>🎲 Beat Generator</strong>
          <label>Style <select id="crpBeatStyle">
            <option value="rock">Rock</option>
            <option value="pop">Pop</option>
            <option value="rap" selected>Rap</option>
            <option value="trap">Trap</option>
            <option value="boombap">Boom Bap</option>
            <option value="gfunk">G-Funk</option>
          </select></label>
          <label>Complexity <select id="crpBeatComplexity">
            <option value="simple">Simple</option>
            <option value="medium" selected>Medium</option>
            <option value="busy">Busy</option>
          </select></label>
          <button id="crpRandomizeBeat" class="accent" type="button">🎲 Randomize Beat</button>
          <button id="crpFillLastBar" type="button">🥁 Fill Last Bar</button>
        </div>
        <div class="crp-beat-foot">
          <button id="crpPreview" type="button">▶ Preview</button>
          <button id="crpCopyBar" type="button">Copy</button>
          <button id="crpPasteBar" type="button">Paste</button>
          <button id="crpDuplicateBar" type="button">Duplicate</button>
          <button id="crpClearBar" class="crp-danger" type="button">Clear</button>
          <button id="crpBeatUndo" type="button" title="Undo the last beat change" disabled>↶ Undo</button>
          <span id="crpBeatStatus" class="crp-beat-status"></span>
          <span class="spacer"></span>
          <button id="crpBeatSave" class="accent" type="button">OK / Save Beat</button>
        </div>
      </div>`;
    document.body.appendChild(modal);

    $('crpBeatBtn').addEventListener('click', openEditor);
    $('crpBeatClose').addEventListener('click', closeEditor);
    modal.addEventListener('click', e => { if(e.target===modal) closeEditor(); });
    $('crpBeatSave').addEventListener('click', ()=>{ persistBeatIntoProject(); closeEditor(); updateMainControls(); });
    $('crpDrumsToggle').addEventListener('change', e=>{ beat.enabled=e.target.checked; persistBeatIntoProject(); updateMainControls(); });
    const setVolume = value => {
      beat.gain = clamp(+value / 100, 0, 1);
      updateVolumeControls();
      persistBeatIntoProject();
    };
    $('crpDrumVolume').addEventListener('input', e=>setVolume(e.target.value));
    $('crpBeatVolume').addEventListener('input', e=>setVolume(e.target.value));
    $('crpBarsSelect').addEventListener('change', e=>{ beat.bars=clamp(+e.target.value,1,16); currentBar=clamp(currentBar,0,beat.bars-1); renderEditor(); persistBeatIntoProject(); });
    $('crpResolution').addEventListener('change', e=>{ beat.resolution=+e.target.value; renderGrid(); persistBeatIntoProject(); });
    $('crpPreview').addEventListener('click', ()=> previewing ? stopPreview() : startPreview());
    $('crpCopyBar').addEventListener('click', copyBar);
    $('crpPasteBar').addEventListener('click', pasteBar);
    $('crpDuplicateBar').addEventListener('click', duplicateBar);
    $('crpClearBar').addEventListener('click', clearBar);
    $('crpRandomizeBeat').addEventListener('click', randomizeBeat);
    $('crpFillLastBar').addEventListener('click', fillLastBar);
    $('crpBeatUndo').addEventListener('click', ()=>window.CRPCore?.undo?.());
    document.addEventListener('keydown', e=>{ if(e.key==='Escape' && modal.classList.contains('open')) closeEditor(); });

    updateMainControls();
  }

  function updateVolumeControls(){
    const pct=Math.round(beat.gain*100);
    const main=$('crpDrumVolume'), editor=$('crpBeatVolume');
    if(main){
      main.value=String(pct);
      main.style.setProperty('--crp-volume-fill',`${pct}%`);
    }
    if($('crpDrumVolumeValue')) $('crpDrumVolumeValue').textContent=`${pct}%`;
    if(editor){
      editor.value=String(pct);
      editor.style.setProperty('--crp-volume-fill',`${pct}%`);
    }
    if($('crpBeatVolumeValue')) $('crpBeatVolumeValue').textContent=`${pct}%`;
  }
  function updateMainControls(){
    if($('crpDrumsToggle')) $('crpDrumsToggle').checked=beat.enabled;
    updateVolumeControls();
    if($('crpBeatBtn')){
      const hits=countHits();
      $('crpBeatBtn').classList.toggle('has-beat', hits>0);
      $('crpBeatBtn').textContent = hits ? `Beat (${beat.bars} bar${beat.bars===1?'':'s'})` : 'Beat';
    }
  }
  function openEditor(){
    renderEditor(); $('crpBeatModal').classList.add('open');
    $('crpBeatClose')?.focus();
  }
  function closeEditor(){
    stopPreview(); $('crpBeatModal')?.classList.remove('open');
    if(eventEditCommit){
      try{eventEditCommit(JSON.parse(JSON.stringify(normalizeBeat(beat))));}catch{}
      const close=eventEditClose,prior=eventEditPriorBeat;eventEditCommit=null;eventEditClose=null;eventEditPriorBeat=null;
      if(prior){beat=normalizeBeat(prior);currentBar=clamp(currentBar,0,beat.bars-1);updateMainControls();}
      try{close?.();}catch{}
    }
  }
  function renderEditor(){
    $('crpBarsSelect').value=String(beat.bars); $('crpResolution').value=String(beat.resolution); updateVolumeControls();
    renderBarTabs(); renderGrid();
    $('crpBeatStatus').textContent=`${countHits()} hits • BPM ${getBpm()}`;
  }
  function renderBarTabs(){
    const wrap=$('crpBarTabs'); wrap.innerHTML='';
    for(let i=0;i<beat.bars;i++){
      const b=document.createElement('button'); b.type='button'; b.className='crp-bar-tab'+(i===currentBar?' active':''); b.textContent=`Bar ${i+1}`; b.setAttribute('aria-pressed',String(i===currentBar));
      b.onclick=()=>{currentBar=i; renderBarTabs(); renderGrid();}; wrap.appendChild(b);
    }
  }
  function renderGrid(){
    const grid=$('crpBeatGrid'); if(!grid) return; grid.innerHTML='';
    const stride=RES[beat.resolution]||4; const cells=64/stride;
    DRUMS.forEach(([id,label])=>{
      const row=document.createElement('div'); row.className='crp-drum-row';
      const name=document.createElement('div'); name.className='crp-drum-name';
      name.innerHTML=`<button class="crp-audition" type="button" title="Hear ${label}" aria-label="Hear ${label}">▶</button><span>${label}</span>`;
      name.querySelector('button').onclick=()=>audition(id);
      const steps=document.createElement('div'); steps.className='crp-steps'; steps.style.gridTemplateColumns=`repeat(${cells},40px)`;
      const active=new Set(beat.tracks[id][currentBar]);
      for(let c=0;c<cells;c++){
        const canonical=c*stride; const s=document.createElement('button'); s.type='button'; s.className='crp-step';
        const quarter=16; if(canonical%quarter===0) s.classList.add('beat-edge');
        if(active.has(canonical)) s.classList.add('active');
        s.setAttribute('aria-label',`${label}, bar ${currentBar+1}, step ${c+1}`);
        s.setAttribute('aria-pressed',String(active.has(canonical)));
        s.dataset.canonical=String(canonical); s.dataset.drum=id;
        s.onclick=()=>toggleStep(id,canonical,s); steps.appendChild(s);
      }
      row.append(name,steps); grid.appendChild(row);
    });
  }
  function toggleStep(id,step,btn){
    const arr=beat.tracks[id][currentBar]; const i=arr.indexOf(step);
    if(i>=0) arr.splice(i,1); else {arr.push(step);arr.sort((a,b)=>a-b); audition(id,.58);}
    btn.classList.toggle('active',i<0); btn.setAttribute('aria-pressed',String(i<0)); $('crpBeatStatus').textContent=`${countHits()} hits • BPM ${getBpm()}`;
    persistBeatIntoProject();
  }
  function beatActiveBars(trackIds=DRUMS.map(([id])=>id)){
    const ids=new Set(trackIds);const out=[];for(let b=0;b<beat.bars;b++){if(DRUMS.some(([id])=>ids.has(id)&&(beat.tracks[id]?.[b]?.length||0)>0))out.push(b);}return out;
  }
  function beatActiveTracks(bars=Array.from({length:beat.bars},(_,i)=>i)){
    const bs=new Set(bars.map(Number));return DRUMS.map(([id])=>id).filter(id=>[...bs].some(b=>(beat.tracks[id]?.[b]?.length||0)>0));
  }
  function closeBeatBatchDialog(){document.getElementById('crpBeatBatchDialog')?.remove();}
  function openBeatBatchDialog({title,help='',showBars=true,showTracks=true,defaultBars=[],defaultTracks=[],destinationBars=false,defaultDestinationBars=[],confirmText='Apply',onConfirm}){
    closeBeatBatchDialog();const modal=document.createElement('div');modal.id='crpBeatBatchDialog';modal.className='bd-batch-backdrop';
    const bars=Array.from({length:beat.bars},(_,i)=>i),allBars=Array.from({length:16},(_,i)=>i),activeBars=beatActiveBars(),activeTracks=beatActiveTracks();
    const barHtml=bars.map(b=>`<label class="bd-batch-check${activeBars.includes(b)?' is-active':''}"><input type="checkbox" data-beat-bar="${b}" ${defaultBars.includes(b)?'checked':''}><span>Bar ${b+1}</span><small>${activeBars.includes(b)?'active':''}</small></label>`).join('');
    const trackHtml=DRUMS.map(([id,name])=>{const hits=bars.reduce((n,b)=>n+(beat.tracks[id]?.[b]?.length||0),0);return `<label class="bd-batch-check${hits?' is-active':''}"><input type="checkbox" data-beat-track="${id}" ${defaultTracks.includes(id)?'checked':''}><span>${name}</span><small>${hits?`${hits} hit${hits===1?'':'s'}`:''}</small></label>`;}).join('');
    const destSet=new Set(defaultDestinationBars.map(Number));
    const destinationHtml=destinationBars?allBars.map(b=>`<label class="bd-batch-check"><input type="checkbox" data-beat-destination="${b}" ${destSet.has(b)?'checked':''}><span>Bar ${b+1}</span></label>`).join(''):'';
    const barSection=showBars?`<div class="bd-batch-section"><div class="bd-batch-section-head"><strong>Source bars</strong><div class="bd-batch-quick"><button type="button" data-bars-active>Active bars</button><button type="button" data-bars-all>All bars</button><button type="button" data-bars-none>None</button></div></div><div class="bd-batch-grid">${barHtml}</div></div>`:'';
    const trackSection=showTracks?`<div class="bd-batch-section"><div class="bd-batch-section-head"><strong>Drum tracks</strong><div class="bd-batch-quick"><button type="button" data-tracks-active>Active tracks</button><button type="button" data-tracks-all>All tracks</button><button type="button" data-tracks-none>None</button></div></div><div class="bd-batch-grid">${trackHtml}</div></div>`:'';
    const destinationSection=destinationBars?`<div class="bd-batch-section"><div class="bd-batch-section-head"><strong>Destination bars</strong><div class="bd-batch-quick"><button type="button" data-dest-current>Current</button><button type="button" data-dest-all>All 16</button><button type="button" data-dest-none>None</button></div></div><div class="bd-batch-grid">${destinationHtml}</div><p class="subtle tiny">Choose one, several, or all destination bars. When more destination bars are selected than source bars, the copied bar pattern repeats across them.</p></div>`:'';
    modal.innerHTML=`<div class="bd-batch-card" role="dialog" aria-modal="true" aria-label="${title}"><h3>${title}</h3>${help?`<p class="subtle tiny">${help}</p>`:''}${barSection}${trackSection}${destinationSection}<div class="bd-batch-actions"><button type="button" data-cancel>Cancel</button><button type="button" class="accent" data-confirm>${confirmText}</button></div></div>`;
    document.body.appendChild(modal);const barChecks=()=>[...modal.querySelectorAll('[data-beat-bar]')],trackChecks=()=>[...modal.querySelectorAll('[data-beat-track]')],destChecks=()=>[...modal.querySelectorAll('[data-beat-destination]')];
    const setBars=vals=>{const set=new Set(vals.map(Number));barChecks().forEach(c=>c.checked=set.has(Number(c.dataset.beatBar)));};
    const setTracks=vals=>{const set=new Set(vals.map(String));trackChecks().forEach(c=>c.checked=set.has(String(c.dataset.beatTrack)));};
    const setDestinations=vals=>{const set=new Set(vals.map(Number));destChecks().forEach(c=>c.checked=set.has(Number(c.dataset.beatDestination)));};
    modal.querySelector('[data-bars-active]')?.addEventListener('click',()=>setBars(activeBars));modal.querySelector('[data-bars-all]')?.addEventListener('click',()=>barChecks().forEach(c=>c.checked=true));modal.querySelector('[data-bars-none]')?.addEventListener('click',()=>barChecks().forEach(c=>c.checked=false));
    modal.querySelector('[data-tracks-active]')?.addEventListener('click',()=>{const chosen=barChecks().filter(c=>c.checked).map(c=>Number(c.dataset.beatBar));setTracks(beatActiveTracks(chosen.length?chosen:activeBars));});modal.querySelector('[data-tracks-all]')?.addEventListener('click',()=>trackChecks().forEach(c=>c.checked=true));modal.querySelector('[data-tracks-none]')?.addEventListener('click',()=>trackChecks().forEach(c=>c.checked=false));
    modal.querySelector('[data-dest-current]')?.addEventListener('click',()=>setDestinations([currentBar]));modal.querySelector('[data-dest-all]')?.addEventListener('click',()=>destChecks().forEach(c=>c.checked=true));modal.querySelector('[data-dest-none]')?.addEventListener('click',()=>destChecks().forEach(c=>c.checked=false));
    modal.querySelector('[data-cancel]').onclick=closeBeatBatchDialog;modal.addEventListener('click',e=>{if(e.target===modal)closeBeatBatchDialog();});
    modal.querySelector('[data-confirm]').onclick=()=>{const pickedBars=barChecks().filter(c=>c.checked).map(c=>Number(c.dataset.beatBar)),pickedTracks=trackChecks().filter(c=>c.checked).map(c=>String(c.dataset.beatTrack)),pickedDestinations=destChecks().filter(c=>c.checked).map(c=>Number(c.dataset.beatDestination));if(showBars&&!pickedBars.length){status('Choose at least one source bar');return;}if(showTracks&&!pickedTracks.length){status('Choose at least one drum track');return;}if(destinationBars&&!pickedDestinations.length){status('Choose at least one destination bar');return;}closeBeatBatchDialog();onConfirm?.({bars:pickedBars,tracks:pickedTracks,destinationBars:pickedDestinations});};
  }
  function makeBeatClip(bars,tracks){
    let sourceBars=[...new Set(bars.map(Number))].filter(b=>b>=0&&b<16).sort((a,b)=>a-b),trackIds=[...new Set(tracks.map(String))];if(!sourceBars.length||!trackIds.length)return null;
    // If the user picked "All bars" but only a smaller region contains hits, trim
    // empty leading/trailing bars while preserving any intentional gaps inside the phrase.
    const activeSelected=sourceBars.filter(b=>trackIds.some(id=>(beat.tracks[id]?.[b]?.length||0)>0));
    if(activeSelected.length){const first=activeSelected[0],last=activeSelected[activeSelected.length-1];sourceBars=sourceBars.filter(b=>b>=first&&b<=last);}
    const minBar=sourceBars[0],offsets=sourceBars.map(b=>b-minBar),data={};let hits=0;
    for(const id of trackIds){data[id]={};for(const b of sourceBars){const arr=[...(beat.tracks[id]?.[b]||[])];data[id][b-minBar]=arr;hits+=arr.length;}}
    return {version:3,minBar,spanBars:sourceBars[sourceBars.length-1]-minBar+1,sourceBars,offsets,trackIds,data,hits};
  }
  function applyBeatClipToBars(clip,destinationBars){
    if(!clip?.version)return false;const dests=[...new Set((destinationBars||[]).map(Number))].filter(b=>b>=0&&b<16).sort((a,b)=>a-b);if(!dests.length)return false;
    const offsets=(clip.offsets||[]).length?clip.offsets:[0];
    if(!beforeBigChange('Paste over these bars of the drum region?'))return false;
    for(let i=0;i<dests.length;i++){
      const dest=dests[i],off=offsets[i%offsets.length];
      for(const id of clip.trackIds||[]){if(!beat.tracks[id])continue;beat.tracks[id][dest]=[...(clip.data?.[id]?.[off]||[])];}
    }
    beat.bars=Math.max(beat.bars,Math.max(...dests)+1);currentBar=dests[0];renderEditor();persistBeatIntoProject();return true;
  }
  function copyBar(){
    const activeBars=beatActiveBars(),defaultBars=activeBars.includes(currentBar)?[currentBar]:(activeBars.length?activeBars:[currentBar]),defaultTracks=beatActiveTracks(defaultBars);
    openBeatBatchDialog({title:'Copy Beat Maker',help:'Choose the source bars and drum tracks to copy. Empty leading/trailing bars are ignored automatically.',defaultBars,defaultTracks:defaultTracks.length?defaultTracks:beatActiveTracks(activeBars),confirmText:'Copy',onConfirm:({bars,tracks})=>{const clip=makeBeatClip(bars,tracks);if(!clip||!clip.hits){status('No drum hits are inside that selection');return;}copiedBar=clip;status(`Copied ${clip.hits} hit${clip.hits===1?'':'s'} from ${clip.sourceBars.length} source bar${clip.sourceBars.length===1?'':'s'} / ${tracks.length} track${tracks.length===1?'':'s'}`);}});
  }
  function pasteBar(){
    if(!copiedBar?.version){status('Copy Beat Maker bars first');return;}
    openBeatBatchDialog({title:'Paste Beat Maker',help:`Choose exactly where the copied ${copiedBar.sourceBars.length}-bar pattern should go. Pick one bar, several bars, or All 16.`,showBars:false,showTracks:false,destinationBars:true,defaultDestinationBars:[currentBar],confirmText:'Paste',onConfirm:({destinationBars})=>{if(applyBeatClipToBars(copiedBar,destinationBars))status(`Pasted the copied pattern across ${destinationBars.length} destination bar${destinationBars.length===1?'':'s'}`);}});
  }
  function duplicateBar(){
    const activeBars=beatActiveBars(),defaultBars=activeBars.includes(currentBar)?[currentBar]:(activeBars.length?activeBars:[currentBar]),defaultTracks=beatActiveTracks(defaultBars);
    openBeatBatchDialog({title:'Duplicate Beat Maker',help:'Choose the source bars/tracks, then choose one, several, or all destination bars. The source pattern repeats across every checked destination bar.',defaultBars,defaultTracks:defaultTracks.length?defaultTracks:beatActiveTracks(activeBars),destinationBars:true,defaultDestinationBars:[Math.min(15,currentBar+1)],confirmText:'Duplicate',onConfirm:({bars,tracks,destinationBars})=>{const clip=makeBeatClip(bars,tracks);if(!clip||!clip.hits){status('No drum hits are inside that source selection');return;}if(applyBeatClipToBars(clip,destinationBars))status(`Duplicated ${clip.hits} source hit${clip.hits===1?'':'s'} across ${destinationBars.length} destination bar${destinationBars.length===1?'':'s'}`);}});
  }
  function clearBar(){
    const activeBars=beatActiveBars(),defaultBars=activeBars.includes(currentBar)?[currentBar]:(activeBars.length?activeBars:[currentBar]),defaultTracks=beatActiveTracks(defaultBars);
    openBeatBatchDialog({title:'Clear Beat Maker',help:'Only hits on the checked bars and checked drum tracks are removed.',defaultBars,defaultTracks:defaultTracks.length?defaultTracks:beatActiveTracks(activeBars),confirmText:'Clear selected',onConfirm:({bars,tracks})=>{if(!beforeBigChange('Clear these hits from the drum region?'))return;let removed=0;for(const id of tracks){for(const b of bars){removed+=beat.tracks[id]?.[b]?.length||0;if(beat.tracks[id])beat.tracks[id][b]=[];}}renderEditor();persistBeatIntoProject();status(`Cleared ${removed} hit${removed===1?'':'s'} from ${bars.length} bar${bars.length===1?'':'s'} / ${tracks.length} track${tracks.length===1?'':'s'}`);}});
  }
  function status(s){ if($('crpBeatStatus')) $('crpBeatStatus').textContent=s; }


  // --- Style-aware beat generator -----------------------------------------
  // Patterns are written on the canonical 64-step grid:
  // 0,16,32,48 = quarter notes; 8-step spacing = eighth notes;
  // 4-step spacing = sixteenth notes; 2 = 32nds; 1 = 64ths.
  function addHit(id, bar, step){
    if(!beat.tracks[id] || bar < 0 || bar >= 16) return;
    step=((Math.round(step)%64)+64)%64;
    if(!beat.tracks[id][bar].includes(step)) beat.tracks[id][bar].push(step);
  }
  function chance(p){ return Math.random() < p; }
  function pick(arr){ return arr[Math.floor(Math.random()*arr.length)]; }
  function addMany(id,bar,steps){ steps.forEach(s=>addHit(id,bar,s)); }
  function clearAllBeat(){
    DRUMS.forEach(([id])=>{ for(let b=0;b<16;b++) beat.tracks[id][b]=[]; });
  }
  function humanVariation(bar, complexity){
    // Tasteful ghost/percussion variation; timing remains exactly on-grid.
    const amount = complexity==='simple' ? .10 : complexity==='busy' ? .34 : .20;
    if(chance(amount)) addHit('rim',bar,pick([12,28,44,60]));
    if(chance(amount*.75)) addHit('shaker',bar,pick([8,24,40,56]));
  }
  function hatLine(bar, style, complexity){
    const busy=complexity==='busy', simple=complexity==='simple';
    if(style==='rock'){
      addMany('chh',bar, simple?[0,8,16,24,32,40,48,56]:
        Array.from({length:16},(_,i)=>i*4));
      if(!simple && chance(.35)) addHit('ohh',bar,56);
    }else if(style==='pop'){
      addMany('chh',bar, simple?[0,8,16,24,32,40,48,56]:
        Array.from({length:16},(_,i)=>i*4));
      if(chance(.45)) addHit('ohh',bar,56);
      if(!simple && chance(.45)) addMany('shaker',bar,[8,24,40,56]);
    }else if(style==='rap' || style==='boombap' || style==='gfunk'){
      addMany('chh',bar, simple?[0,8,16,24,32,40,48,56]:
        Array.from({length:16},(_,i)=>i*4).filter(()=>chance(busy?.92:.78)));
      if(chance(style==='gfunk'?.55:.28)) addHit('ohh',bar,pick([24,56]));
      if(busy && chance(.45)) addMany('chh',bar,[54,58,60,62]);
    }else if(style==='trap'){
      addMany('chh',bar,Array.from({length:16},(_,i)=>i*4));
      const rolls=simple?0:(busy?2:1);
      for(let r=0;r<rolls;r++){
        const start=pick([12,28,44,52]);
        [0,2,4,6].forEach(x=>addHit('chh',bar,start+x));
        if(busy && chance(.45)) [0,1,2,3].forEach(x=>addHit('chh',bar,start+4+x));
      }
      if(chance(.38)) addHit('ohh',bar,pick([24,56]));
    }
  }
  function grooveBar(bar, style, complexity){
    const busy=complexity==='busy', simple=complexity==='simple';
    hatLine(bar,style,complexity);

    if(style==='rock'){
      addMany('snare1',bar,[16,48]);
      addMany('kick1',bar,simple?[0,32]:[0,24,32]);
      if(!simple && chance(.55)) addHit('kick1',bar,pick([8,40,56]));
      if(busy && chance(.5)) addHit('kick2',bar,pick([12,28,44,60]));
    }else if(style==='pop'){
      addMany('snare2',bar,[16,48]); addMany('clap',bar,[16,48]);
      addMany('kick1',bar,simple?[0,32]:[0,24,32,40]);
      if(busy && chance(.55)) addHit('kick2',bar,pick([8,28,56]));
    }else if(style==='rap'){
      addMany('snare3',bar,[16,48]);
      if(chance(.45)) addMany('clap',bar,[16,48]);
      addHit('kick2',bar,0);
      const pool=simple?[32]:[12,24,32,40,52,56];
      const n=simple?1:(busy?4:2);
      for(let i=0;i<n;i++) if(chance(.82)) addHit('kick2',bar,pick(pool));
      if(!simple && chance(.32)) addHit('rim',bar,44);
    }else if(style==='trap'){
      addMany('snare4',bar,[32]); // classic half-time backbeat
      if(chance(.35)) addHit('clap',bar,32);
      addHit('kick3',bar,0);
      const pool=[10,20,26,38,44,52,58];
      const n=simple?1:(busy?5:3);
      for(let i=0;i<n;i++) if(chance(.82)) addHit('kick3',bar,pick(pool));
    }else if(style==='boombap'){
      addMany('snare5',bar,[16,48]);
      if(chance(.55)) addHit('rim',bar,44);
      addHit('kick1',bar,0);
      const pool=[8,24,28,36,40,56];
      const n=simple?1:(busy?4:2);
      for(let i=0;i<n;i++) if(chance(.85)) addHit('kick1',bar,pick(pool));
    }else if(style==='gfunk'){
      addMany('snare2',bar,[16,48]);
      if(chance(.65)) addMany('clap',bar,[16,48]);
      addHit('kick1',bar,0);
      const pool=[12,24,36,40,52,56];
      const n=simple?1:(busy?4:2);
      for(let i=0;i<n;i++) if(chance(.8)) addHit('kick1',bar,pick(pool));
      if(!simple && chance(.5)) addHit('cowbell',bar,pick([8,24,40,56]));
      if(busy && chance(.4)) addHit('conga',bar,pick([12,28,44,60]));
    }
    humanVariation(bar,complexity);
  }
  function addFillToBar(bar, style, complexity){
    // Keep the groove, then create a fill in beat 4 (steps 48-63).
    ['tomHi','tomMid','tomLow','snare1','snare2','snare3','snare4','snare5'].forEach(id=>{
      beat.tracks[id][bar]=beat.tracks[id][bar].filter(s=>s<48);
    });
    const snare = style==='trap'?'snare4':style==='boombap'?'snare5':style==='rap'?'snare3':style==='pop'?'snare2':'snare1';
    if(complexity==='simple'){
      addMany(snare,bar,[48,56]);
      addMany('tomLow',bar,[52,60]);
    }else if(complexity==='busy'){
      addMany(snare,bar,[48,52]);
      addMany('tomHi',bar,[54,56]);
      addMany('tomMid',bar,[58,60]);
      addMany('tomLow',bar,[62]);
      if(style==='trap') addMany(snare,bar,[61,63]);
    }else{
      addMany(snare,bar,[48,52]);
      addMany('tomHi',bar,[56]);
      addMany('tomMid',bar,[60]);
      addMany('tomLow',bar,[62]);
    }
    addHit('kick1',bar,0);
  }
  function randomizeBeat(){
    const style=$('crpBeatStyle')?.value||'rap';
    const complexity=$('crpBeatComplexity')?.value||'medium';
    if(!beforeBigChange('Replace this drum region with a random beat?')) return;
    clearAllBeat();
    // 32nd display for trap rolls; 16th is clearer for the other genres.
    beat.resolution = style==='trap' && complexity!=='simple' ? 32 : 16;
    for(let b=0;b<beat.bars;b++) grooveBar(b,style,complexity);
    // Give multi-bar patterns a musical turnaround without making every bar busy.
    if(beat.bars>1 && complexity!=='simple') addFillToBar(beat.bars-1,style,complexity);
    currentBar=0;
    renderEditor();
    persistBeatIntoProject();
    status(`${styleLabel(style)} • ${complexity} • ${beat.bars} bar${beat.bars===1?'':'s'} generated`);
  }
  function fillLastBar(){
    const style=$('crpBeatStyle')?.value||'rap';
    const complexity=$('crpBeatComplexity')?.value||'medium';
    const bar=Math.max(0,beat.bars-1);
    if(!beforeBigChange('Add a fill to the last bar of this drum region?')) return;
    // If the last bar is empty, make a groove first, then add the fill.
    const hasHits=DRUMS.some(([id])=>beat.tracks[id][bar].length);
    if(!hasHits) grooveBar(bar,style,complexity);
    addFillToBar(bar,style,complexity);
    currentBar=bar;
    renderEditor();
    persistBeatIntoProject();
    status(`Fill added to Bar ${bar+1}`);
  }
  function styleLabel(style){
    return ({rock:'Rock',pop:'Pop',rap:'Rap',trap:'Trap',boombap:'Boom Bap',gfunk:'G-Funk'})[style]||style;
  }

  function getBpm(){ return clamp(+($('bpmInput')?.value||92),40,240); }
  // Drums share the suite's audio clock and master limiter (window.CRPAudio from app.js).
  function drumOutput(){ return window.CRPAudio ? window.CRPAudio.master() : audioCtx.destination; }
  // Song hits queued ahead but not sounding yet. Stop, Pause, a seek or Preview
  // cancels them, so drums from the old position do not play on for the look-ahead.
  const mainQueued=new Set();
  function playBuffer(id,time,gain,queue=null){
    const buf=buffers.get(id); if(!buf||!audioCtx) return;
    const src=audioCtx.createBufferSource(), g=audioCtx.createGain(); src.buffer=buf; g.gain.value=gain; src.connect(g).connect(drumOutput()); src.start(time);
    if(queue){src.__at=time;queue.add(src);src.onended=()=>queue.delete(src);}
  }
  function cancelQueuedMainHits(){
    const now=audioCtx?.currentTime||0;
    for(const src of mainQueued)if(src.__at>now){try{src.stop();}catch{}}
    mainQueued.clear();
  }
  async function ensureDrums(){
    if(!audioCtx) audioCtx=window.CRPAudio ? window.CRPAudio.context() : new (window.AudioContext||window.webkitAudioContext)();
    if(audioCtx.state==='suspended') await audioCtx.resume();
    if(buffers.size===DRUMS.length) return;
    if(loading) return loading;

    // Resolve samples relative to beat-maker.js. This is safer on GitHub Pages
    // where the app may live inside a repository sub-folder.
    loading=Promise.allSettled(DRUMS.map(async([id,,url])=>{
      const resolved = new URL(url, SCRIPT_URL).href;
      const r=await fetch(resolved, {cache:'no-store'});
      if(!r.ok) throw new Error(`${url} (${r.status})`);
      const a=await r.arrayBuffer();
      const buf=await audioCtx.decodeAudioData(a);
      buffers.set(id,buf);
      return id;
    })).then(results=>{
      const failed=[];
      results.forEach((result,i)=>{
        if(result.status==='rejected') failed.push(DRUMS[i][2]);
      });
      if(failed.length){
        console.error('Beat Maker missing/invalid samples:', failed);
        const first=failed[0].split('/').pop();
        status(`Missing sample: ${first}${failed.length>1 ? ` (+${failed.length-1})` : ''}`);
      }else{
        status(`${countHits()} hits • BPM ${getBpm()}`);
      }
      return failed;
    }).finally(()=>loading=null);
    return loading;
  }
  function hit(id,time,gain=1){ playBuffer(id,time,beat.gain*DRUM_OUTPUT_SCALE*gain); }
  async function audition(id,gain=.78){ try{await ensureDrums();hit(id,audioCtx.currentTime+.01,gain)}catch(e){console.error(e);status(`Drum error: ${e.message||e}`);} }
  function scheduleCanonicalStep(absStep,time,barIndex,gainScale=1,pattern=beat,queue=null){
    const pat=normalizeBeat(pattern),step=((absStep%64)+64)%64;
    DRUMS.forEach(([id])=>{ if(pat.tracks[id][barIndex]?.includes(step)) playBuffer(id,time,pat.gain*DRUM_OUTPUT_SCALE*gainScale,queue); });
  }
  function arrangementHitCount(events){
    let n=0;for(const ev of Array.isArray(events)?events:[]){const pat=normalizeBeat(ev?.pattern);DRUMS.forEach(([id])=>{for(let b=0;b<pat.bars;b++)n+=pat.tracks[id][b].length;});}return n;
  }
  function scheduleArrangementStep(absStep,time,gainScale=1){
    const songBeat=absStep/16;
    for(const ev of Array.isArray(mainArrangement)?mainArrangement:[]){
      const start=Math.max(0,Number(ev?.startBeat)||0),dur=Math.max(0,Number(ev?.durationBeats)||0),end=start+dur;if(songBeat<start-1e-6||songBeat>=end-1e-6)continue;
      const pat=normalizeBeat(ev?.pattern),offset=Number(ev?.patternOffsetBeats)||0,patternSteps=Math.max(64,Math.max(1,pat.bars)*64),rawStep=Math.round((songBeat-start+offset)*16),localCanonical=((rawStep%patternSteps)+patternSteps)%patternSteps,bar=Math.floor(localCanonical/64),step=localCanonical%64;
      DRUMS.forEach(([id])=>{ if(pat.tracks[id][bar]?.includes(step)) playBuffer(id,time,pat.gain*DRUM_OUTPUT_SCALE*gainScale,mainQueued); });
    }
  }
  function stepSeconds(){ return (60/getBpm())/16; } // one 64th = quarter/16
  // v3.3.54 — drums need enough scheduled headroom to survive UI/layout work.
  // 100ms was easy to starve when Track Master redrew waveforms or a SoundFont
  // decoded on mobile. WebAudio still fires these hits sample-accurately once queued.
  const LOOKAHEAD=.55;
  // A song step that is already this late (the page stalled for longer than the
  // look-ahead) is skipped: scheduling it would fire every missed hit at once.
  const LATE_STEP=.03;
  function startPreviewScheduler(){
    clearInterval(previewTimer);
    previewTimer=setInterval(()=>{
      if(!audioCtx) return;
      while(previewNextTime < audioCtx.currentTime+LOOKAHEAD){
        const bar=Math.floor(previewStep/64)%beat.bars; scheduleCanonicalStep(previewStep,previewNextTime,bar,1);
        markPlayingStep(bar,previewStep%64); previewStep++; previewNextTime+=stepSeconds();
      }
    },25);
  }
  function startMainScheduler(){
    clearInterval(mainTimer);
    mainTimer=setInterval(()=>{
      if(!audioCtx) return;
      while(mainNextTime < audioCtx.currentTime+LOOKAHEAD){
        if(mainArrangement) repeatAtSongEnd();
        // While Beat Maker previews a pattern, the song's drums keep counting
        // silently so they come back on the beat when the preview stops.
        if(!previewing && mainNextTime>=audioCtx.currentTime-LATE_STEP){
          if(mainArrangement) scheduleArrangementStep(mainStep,mainNextTime,mainGainScale);
          else {const bar=Math.floor(mainStep/64)%beat.bars; scheduleCanonicalStep(mainStep,mainNextTime,bar,mainGainScale,beat,mainQueued);}
        }
        mainStep++; mainNextTime+=stepSeconds();
      }
    },25);
  }
  function loopsAt(end){
    const start=Math.max(0,Number(mainArrangementRangeStart)||0);
    return !!mainArrangement&&Number.isFinite(end)&&end>start&&mainArrangementCanLoop&&!!$('loopToggle')?.checked;
  }
  // Repeat returns to the song start at the exact moment the transport does, also
  // when the song end is not on the drum grid (vocal clips, dragged end marker).
  // Rounding it to the grid moved the drums against the song on every pass.
  function repeatAtSongEnd(){
    const end=Number(mainArrangementRangeEnd);if(!loopsAt(end)||mainStep/16<end-1e-6)return;
    const start=Math.max(0,Number(mainArrangementRangeStart)||0),beatSec=stepSeconds()*16,over=mainStep/16-end;
    // Just crossed the end: time it exactly. The end moved behind the playhead
    // (edit during playback): repeat now, as the transport does.
    const endTime=mainNextTime-(over<1/16?over*beatSec:0);
    placeMainStep(start,endTime);
  }
  // The first drum step at or after song beat `pos`, which sounds at `time`; so a
  // song started between two grid steps (seek, pause/resume) stays on the beat.
  function placeMainStep(pos,time){
    const first=Math.ceil(pos*16-1e-6);mainStep=first;mainNextTime=time+(first/16-pos)*stepSeconds()*16;
  }
  // Song beat `startBeat` sounds at `startTime` (an AudioContext time) or after
  // `delaySeconds`. If that moment passed while the samples loaded, join the song
  // where it is by now. Returns the time `startBeat` (or that later beat) sounds.
  function placeMainStart(startBeat,delaySeconds,startTime){
    const beatSec=stepSeconds()*16,earliest=audioCtx.currentTime+.01;
    let pos=Math.max(0,Number(startBeat)||0),t0=startTime==null?NaN:Number(startTime);
    if(!Number.isFinite(t0)) t0=audioCtx.currentTime+Math.max(.01,Number(delaySeconds)||.01);
    else if(t0<earliest){pos+=(earliest-t0)/beatSec;t0=earliest;}
    const end=Number(mainArrangementRangeEnd),start=Math.max(0,Number(mainArrangementRangeStart)||0);
    if(pos>=end&&loopsAt(end))pos=start+(pos-start)%(end-start);
    placeMainStep(pos,t0);
    return t0;
  }
  // A start time is only meaningful on Beat Maker's own clock.
  function startTimeOn(options){ return options?.context&&options.context===audioCtx ? options.startTime : null; }
  async function startPreview(){
    try{await ensureDrums(); previewing=true; cancelQueuedMainHits(); previewStep=currentBar*64; previewNextTime=audioCtx.currentTime+.04; $('crpPreview').textContent='■ Stop Preview'; startPreviewScheduler();}
    catch(e){console.error(e);status(`Drum error: ${e.message||e}`);}
  }
  function stopPreview(){ previewing=false; clearInterval(previewTimer); previewTimer=null; if($('crpPreview')) $('crpPreview').textContent='▶ Preview'; document.querySelectorAll('.crp-step.playing').forEach(x=>x.classList.remove('playing')); }
  function markPlayingStep(bar,step){
    if(!$('crpBeatModal')?.classList.contains('open')||bar!==currentBar) return;
    const stride=RES[beat.resolution]||4; if(step%stride) return;
    requestAnimationFrame(()=>{ document.querySelectorAll('.crp-step.playing').forEach(x=>x.classList.remove('playing')); document.querySelectorAll(`.crp-step[data-canonical="${step}"]`).forEach(x=>x.classList.add('playing')); });
  }

  function startMainDrums(delaySeconds=.01,startBeat=0,gainScale=1,startTime=null){
    if(!audioCtx||!beat.enabled) return null;
    mainPlaying=true;mainArrangement=null;mainArrangementRangeStart=0;mainArrangementRangeEnd=null;mainArrangementCanLoop=true;
    mainGainScale=Math.max(0,Math.min(1,Number(gainScale)||0));
    // 16 canonical drum steps per quarter-note beat (64 per 4/4 bar).
    // Starting from the same song beat keeps drums aligned when playback begins
    // from Line 2/3/etc. instead of always forcing the drums back to Bar 1.
    const t0=placeMainStart(startBeat,delaySeconds,startTime);
    startMainScheduler();
    return t0;
  }
  function stopMainDrums(){ mainGen++; cancelQueuedMainHits(); mainPlaying=false; mainArrangement=null; mainArrangementRangeStart=0; mainArrangementRangeEnd=null; mainArrangementCanLoop=true; mainGainScale=1; clearInterval(mainTimer); mainTimer=null; }

  // Main-transport drums are started and stopped explicitly by the transport
  // (CRPParts.startPlayback/stopPlayback, or the core's fallback player).

  // Public bridge used by the core project save/load code. The beat is now
  // stored in the same project payload as chords, BPM, notes, etc.
  window.CRPBeatMaker = {
    getBeat(){
      return JSON.parse(JSON.stringify(normalizeBeat(beat)));
    },
    getDrumDefs(){
      return DRUMS.map(([id,name])=>({id,name}));
    },
    generateBeat({style='rap',complexity='medium'}={}){
      const st=$('crpBeatStyle'),cx=$('crpBeatComplexity');if(st&&[...st.options].some(o=>o.value===style))st.value=style;if(cx&&[...cx.options].some(o=>o.value===complexity))cx.value=complexity;
      $('crpRandomizeBeat')?.click();return JSON.parse(JSON.stringify(normalizeBeat(beat)));
    },
    fillLastBar({style='rap',complexity='medium'}={}){
      const st=$('crpBeatStyle'),cx=$('crpBeatComplexity');if(st&&[...st.options].some(o=>o.value===style))st.value=style;if(cx&&[...cx.options].some(o=>o.value===complexity))cx.value=complexity;
      $('crpFillLastBar')?.click();return JSON.parse(JSON.stringify(normalizeBeat(beat)));
    },
    setBeat(next,{persist=true}={}){
      beat=normalizeBeat(next);
      currentBar=clamp(currentBar,0,beat.bars-1);
      beatUpdatedAt=Date.now();
      updateMainControls();
      if($('crpBeatModal')?.classList.contains('open'))renderEditor();
      if(persist)persistBeatIntoProject();
      try{window.dispatchEvent(new CustomEvent('crp-beat-changed',{detail:{source:'vox-box'}}));}catch{}
      return JSON.parse(JSON.stringify(beat));
    },
    editBeatEvent(next,{onCommit=null,onClose=null}={}){
      // A playing song keeps its drums: the region's edits reach them through
      // updateArrangement as they are committed.
      stopPreview();eventEditPriorBeat=JSON.parse(JSON.stringify(normalizeBeat(beat)));eventEditCommit=typeof onCommit==='function'?onCommit:null;eventEditClose=typeof onClose==='function'?onClose:null;
      beat=normalizeBeat(next);currentBar=0;updateMainControls();renderEditor();$('crpBeatModal')?.classList.add('open');
      return JSON.parse(JSON.stringify(beat));
    },
    // Resolves to the AudioContext time at which startBeat sounds (null if the
    // drums did not start). options.startTime (with options.context, the caller's
    // AudioContext) joins a song that is already playing at an exact moment.
    async startArrangementNow(events,delaySeconds=.01,startBeat=0,gainScale=1,options={}){
      const list=(Array.isArray(events)?events:[]).filter(e=>Number(e?.durationBeats)>0);if(!beat.enabled||!list.length||arrangementHitCount(list)===0)return null;
      const gen=++mainGen;
      stopPreview();try{await ensureDrums();if(gen!==mainGen)return null;mainPlaying=true;mainArrangement=JSON.parse(JSON.stringify(list));mainArrangementRangeStart=Math.max(0,Number(options?.rangeStart)||0);mainArrangementRangeEnd=Number.isFinite(Number(options?.rangeEnd))?Math.max(mainArrangementRangeStart+.03,Number(options.rangeEnd)):null;mainArrangementCanLoop=options?.canLoop!==false;mainGainScale=Math.max(0,Math.min(1,Number(gainScale)||0));const t0=placeMainStart(startBeat,delaySeconds,startTimeOn(options));startMainScheduler();return t0;}catch(e){console.error(e);return null;}
    },
    updateArrangement(events,options={}){
      if(!mainArrangement)return false;const list=(Array.isArray(events)?events:[]).filter(e=>Number(e?.durationBeats)>0);mainArrangement=JSON.parse(JSON.stringify(list));if(Number.isFinite(Number(options?.rangeStart)))mainArrangementRangeStart=Math.max(0,Number(options.rangeStart));if(Number.isFinite(Number(options?.rangeEnd)))mainArrangementRangeEnd=Math.max(mainArrangementRangeStart+.03,Number(options.rangeEnd));if(options?.canLoop!==undefined)mainArrangementCanLoop=options.canLoop!==false;return true;
    },
    getUpdatedAt(){ return Number(beatUpdatedAt)||0; },
    loadProject(project){
      // Passing null means New/blank project: start from an empty sequencer.
      loadBeatFromProject(project || null);
    },
    refreshUndoButton(enabled){ const b=$('crpBeatUndo'); if(b) b.disabled=!enabled; },
    persist(){
      return persistBeatIntoProject();
    },
    async startMainNow(delaySeconds=.01,startBeat=0,gainScale=1,options={}){
      if(!beat.enabled || countHits()===0) return null;
      const gen=++mainGen;
      stopPreview();
      try{await ensureDrums();if(gen!==mainGen)return null;return startMainDrums(delaySeconds,startBeat,gainScale,startTimeOn(options));}catch(e){console.error(e);return null;}
    },
    getDurationBeats(){ return beat.enabled&&countHits()>0 ? Math.max(4,(Number(beat.bars)||1)*4) : 0; },
    setMainGainScale(scale){ mainGainScale=Math.max(0,Math.min(1,Number(scale)||0)); return mainGainScale; },
    isMainPlaying(){ return !!mainPlaying; },
    stopMainNow(){stopMainDrums();}
  };

  // beat-maker.js loads after app.js/parts.js, so the core restored the open project
  // before this bridge existed. Announce readiness so the core loads that project's beat.
  function init(){
    if(!document.querySelector('link[href$="beat-maker.css"]')){
      const css=document.createElement('link'); css.rel='stylesheet'; css.href='beat-maker.css'; document.head.appendChild(css);
    }
    injectUi();
    beat=freshBeat();
    beatUpdatedAt=0;
    try{localStorage.removeItem(LEGACY_DRAFT_KEY);}catch{}
    updateMainControls();
    // The core answers by loading the open project's (or draft's) beat into this module.
    try{window.dispatchEvent(new CustomEvent('crp-beat-ready'));}catch{}
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init); else init();
})();
