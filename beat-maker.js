(() => {
  'use strict';

  const STORAGE_KEY = 'crp-projects';
  const DRAFT_KEY = 'crp-beat-draft-v1';
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
  let scheduler = null;
  let previewStep = 0;
  let previewNextTime = 0;
  let mainPlaying = false;
  let mainGainScale = 1;
  let mainStep = 0;
  let mainNextTime = 0;
  let activeProjectId = null;
  let beat = freshBeat();
  let beatUpdatedAt=0;

  function freshBeat(){
    const tracks = {};
    DRUMS.forEach(([id]) => tracks[id] = Array.from({length:16}, () => []));
    return {version:VERSION, enabled:true, bars:1, resolution:16, gain:.50, tracks};
  }
  function normalizeBeat(src){
    const b = freshBeat();
    if(!src || typeof src !== 'object') return b;
    b.enabled = src.enabled !== false;
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
  function readProjects(){ try{return JSON.parse(localStorage.getItem(STORAGE_KEY)||'[]')}catch{return []} }
  function writeProjects(ps){ localStorage.setItem(STORAGE_KEY, JSON.stringify(ps)); }
  function projectName(){ return ($('projectName')?.value || '').trim(); }
  function inferActiveProject(){
    const ps = readProjects();
    if(activeProjectId){ const p=ps.find(x=>x.id===activeProjectId); if(p) return p; }
    const name = projectName();
    if(name){
      const matches = ps.filter(p=>p.name===name).sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0));
      if(matches[0]) { activeProjectId=matches[0].id; return matches[0]; }
    }
    // With no active project ID and no project name, this is a genuinely blank/new
    // project. Never borrow the most recently saved project's drums.
    return null;
  }
  function loadBeatFromProject(p){
    activeProjectId = p?.id || null;
    beatUpdatedAt = Number(p?.beatMakerUpdatedAt||p?.updatedAt||0)||0;
    beat = normalizeBeat(p?.beatMaker);
    currentBar = clamp(currentBar,0,beat.bars-1);
    updateMainControls();
    if($('crpBeatModal')?.classList.contains('open')) renderEditor();
  }
  function persistBeatIntoProject(){
    const now=Date.now();
    beatUpdatedAt=now;
    const ps = readProjects();
    let p = activeProjectId ? ps.find(x=>x.id===activeProjectId) : null;
    if(!p){
      const name = projectName();
      p = ps.filter(x=>x.name===name).sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0))[0] || null;
    }
    if(!p){
      localStorage.setItem(DRAFT_KEY, JSON.stringify({beat:normalizeBeat(beat),updatedAt:beatUpdatedAt}));
      // The core save will include the live beat when this draft gets its first project ID.
      window.CRPCore?.scheduleAutoSave?.();
      return false;
    }
    activeProjectId = p.id;
    const idx = ps.findIndex(x=>x.id===p.id);
    ps[idx] = {...p, beatMaker: normalizeBeat(beat), beatMakerUpdatedAt:beatUpdatedAt, updatedAt: now};
    writeProjects(ps);
    localStorage.removeItem(DRAFT_KEY);
    // Keep the authoritative project payload/cloud snapshot in lockstep with the drum editor.
    window.CRPCore?.scheduleAutoSave?.();
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
          <button id="crpBeatClose" type="button">✕</button>
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
          <button id="crpCopyBar" type="button">Copy Bar</button>
          <button id="crpPasteBar" type="button">Paste Bar</button>
          <button id="crpDuplicateBar" type="button">Duplicate →</button>
          <button id="crpClearBar" class="crp-danger" type="button">Clear Bar</button>
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
    document.addEventListener('keydown', e=>{ if(e.key==='Escape' && modal.classList.contains('open')) closeEditor(); });

    hookProjectUi();
    updateMainControls();
  }

  function hookProjectUi(){
    const saveBtn=$('saveProjectBtn');
    if(saveBtn) saveBtn.addEventListener('click', ()=>setTimeout(()=>{
      const p=inferActiveProject(); if(p) activeProjectId=p.id;
      persistBeatIntoProject(); updateMainControls();
    },0));

    const list=$('projectList');
    if(list) list.addEventListener('click', e=>{
      const open=e.target.closest('.open'); if(!open) return;
      const item=open.closest('.project-item');
      const name=item?.querySelector('.name')?.textContent?.trim();
      setTimeout(()=>{
        const ps=readProjects();
        const p=ps.filter(x=>!name || x.name===name).sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0))[0];
        if(p) loadBeatFromProject(p);
      },0);
    });

    const play=$('playAllBtn');
    if(play) play.addEventListener('click', ()=>{
      setTimeout(()=>{
        const starting = /Stop/i.test(play.textContent||'');
        if(starting) startMainDrumsWhenChordStarts(); else stopMainDrums();
      },0);
    });
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
    const p=inferActiveProject();
    if(p && p.id!==activeProjectId) loadBeatFromProject(p);
    // No saved project: keep the current in-memory beat. A brand-new project is
    // reset explicitly by loadProject(null), so stale draft drums cannot leak in.
    renderEditor(); $('crpBeatModal').classList.add('open');
  }
  function closeEditor(){ stopPreview(); $('crpBeatModal')?.classList.remove('open'); }
  function renderEditor(){
    $('crpBarsSelect').value=String(beat.bars); $('crpResolution').value=String(beat.resolution); updateVolumeControls();
    renderBarTabs(); renderGrid();
    $('crpBeatStatus').textContent=`${countHits()} hits • BPM ${getBpm()}`;
  }
  function renderBarTabs(){
    const wrap=$('crpBarTabs'); wrap.innerHTML='';
    for(let i=0;i<beat.bars;i++){
      const b=document.createElement('button'); b.className='crp-bar-tab'+(i===currentBar?' active':''); b.textContent=`Bar ${i+1}`;
      b.onclick=()=>{currentBar=i; renderBarTabs(); renderGrid();}; wrap.appendChild(b);
    }
  }
  function renderGrid(){
    const grid=$('crpBeatGrid'); if(!grid) return; grid.innerHTML='';
    const stride=RES[beat.resolution]||4; const cells=64/stride;
    DRUMS.forEach(([id,label])=>{
      const row=document.createElement('div'); row.className='crp-drum-row';
      const name=document.createElement('div'); name.className='crp-drum-name';
      name.innerHTML=`<button class="crp-audition" type="button" title="Hear ${label}">▶</button><span>${label}</span>`;
      name.querySelector('button').onclick=()=>audition(id);
      const steps=document.createElement('div'); steps.className='crp-steps'; steps.style.gridTemplateColumns=`repeat(${cells},40px)`;
      const active=new Set(beat.tracks[id][currentBar]);
      for(let c=0;c<cells;c++){
        const canonical=c*stride; const s=document.createElement('button'); s.type='button'; s.className='crp-step';
        const quarter=16; if(canonical%quarter===0) s.classList.add('beat-edge');
        if(active.has(canonical)) s.classList.add('active');
        s.dataset.canonical=String(canonical); s.dataset.drum=id;
        s.onclick=()=>toggleStep(id,canonical,s); steps.appendChild(s);
      }
      row.append(name,steps); grid.appendChild(row);
    });
  }
  function toggleStep(id,step,btn){
    const arr=beat.tracks[id][currentBar]; const i=arr.indexOf(step);
    if(i>=0) arr.splice(i,1); else {arr.push(step);arr.sort((a,b)=>a-b); audition(id,.58);}
    btn.classList.toggle('active',i<0); $('crpBeatStatus').textContent=`${countHits()} hits • BPM ${getBpm()}`;
    persistBeatIntoProject();
  }
  function copyBar(){ copiedBar={}; DRUMS.forEach(([id])=>copiedBar[id]=[...beat.tracks[id][currentBar]]); status(`Copied Bar ${currentBar+1}`); }
  function pasteBar(){ if(!copiedBar){status('Copy a bar first');return;} DRUMS.forEach(([id])=>beat.tracks[id][currentBar]=[...(copiedBar[id]||[])]); renderGrid(); persistBeatIntoProject(); status(`Pasted into Bar ${currentBar+1}`); }
  function duplicateBar(){
    if(beat.bars>=16 && currentBar>=15){status('16-bar maximum');return;}
    const target=Math.min(currentBar+1,15); if(target>=beat.bars) beat.bars=target+1;
    DRUMS.forEach(([id])=>beat.tracks[id][target]=[...beat.tracks[id][currentBar]]); currentBar=target; renderEditor(); persistBeatIntoProject(); status(`Duplicated to Bar ${target+1}`);
  }
  function clearBar(){ DRUMS.forEach(([id])=>beat.tracks[id][currentBar]=[]); renderGrid(); persistBeatIntoProject(); status(`Cleared Bar ${currentBar+1}`); }
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
  async function ensureDrums(){
    if(!audioCtx) audioCtx=new (window.AudioContext||window.webkitAudioContext)();
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
  function hit(id,time,gain=1){
    const buf=buffers.get(id); if(!buf||!audioCtx) return;
    const src=audioCtx.createBufferSource(), g=audioCtx.createGain(); src.buffer=buf; g.gain.value=beat.gain*DRUM_OUTPUT_SCALE*gain; src.connect(g).connect(audioCtx.destination); src.start(time);
  }
  async function audition(id,gain=.78){ try{await ensureDrums();hit(id,audioCtx.currentTime+.01,gain)}catch(e){console.error(e);status(`Drum error: ${e.message||e}`);} }
  function scheduleCanonicalStep(absStep,time,barIndex,gainScale=1){
    const step=absStep%64; DRUMS.forEach(([id])=>{ if(beat.tracks[id][barIndex]?.includes(step)) hit(id,time,gainScale); });
  }
  function stepSeconds(){ return (60/getBpm())/16; } // one 64th = quarter/16
  function startScheduler(kind){
    if(scheduler) clearInterval(scheduler);
    const lookAhead=.10;
    scheduler=setInterval(()=>{
      if(!audioCtx) return;
      while((kind==='preview'?previewNextTime:mainNextTime) < audioCtx.currentTime+lookAhead){
        if(kind==='preview'){
          const bar=Math.floor(previewStep/64)%beat.bars; scheduleCanonicalStep(previewStep,previewNextTime,bar,1);
          markPlayingStep(bar,previewStep%64); previewStep++; previewNextTime+=stepSeconds();
        }else{
          const bar=Math.floor(mainStep/64)%beat.bars; scheduleCanonicalStep(mainStep,mainNextTime,bar,mainGainScale);
          mainStep++; mainNextTime+=stepSeconds();
        }
      }
    },25);
  }
  async function startPreview(){
    try{await ensureDrums(); stopMainDrums(); previewing=true; previewStep=currentBar*64; previewNextTime=audioCtx.currentTime+.04; $('crpPreview').textContent='■ Stop Preview'; startScheduler('preview');}
    catch(e){console.error(e);status(`Drum error: ${e.message||e}`);}
  }
  function stopPreview(){ previewing=false; if(scheduler){clearInterval(scheduler);scheduler=null;} if($('crpPreview')) $('crpPreview').textContent='▶ Preview'; document.querySelectorAll('.crp-step.playing').forEach(x=>x.classList.remove('playing')); }
  function markPlayingStep(bar,step){
    if(!$('crpBeatModal')?.classList.contains('open')||bar!==currentBar) return;
    const stride=RES[beat.resolution]||4; if(step%stride) return;
    requestAnimationFrame(()=>{ document.querySelectorAll('.crp-step.playing').forEach(x=>x.classList.remove('playing')); document.querySelectorAll(`.crp-step[data-canonical="${step}"]`).forEach(x=>x.classList.add('playing')); });
  }

  async function startMainDrumsWhenChordStarts(){
    if(!beat.enabled || countHits()===0) return;
    stopPreview();
    try{ await ensureDrums(); }catch(e){console.error(e);return;}
    let frames=0;
    const sync=()=>{
      const play=$('playAllBtn'); if(!play || !/Stop/i.test(play.textContent||'')) return;
      const first=[...document.querySelectorAll('.chord-card')].some(c => (c.style.outline||'').includes('2px'));
      if(first || frames++>10){ startMainDrums(); return; }
      requestAnimationFrame(sync);
    };
    requestAnimationFrame(sync);
  }
  function startMainDrums(delaySeconds=.01,startBeat=0,gainScale=1){
    if(!audioCtx||!beat.enabled) return;
    mainPlaying=true;
    mainGainScale=Math.max(0,Math.min(1,Number(gainScale)||0));
    // 16 canonical drum steps per quarter-note beat (64 per 4/4 bar).
    // Starting from the same song beat keeps drums aligned when playback begins
    // from Line 2/3/etc. instead of always forcing the drums back to Bar 1.
    mainStep=Math.max(0,Math.round((Number(startBeat)||0)*16));
    mainNextTime=audioCtx.currentTime+Math.max(.01,Number(delaySeconds)||.01);
    startScheduler('main');
  }
  function stopMainDrums(){ mainPlaying=false; mainGainScale=1; if(scheduler && !previewing){clearInterval(scheduler);scheduler=null;} }

  // If the chord progression stops itself (Repeat off), stop drums too.
  setInterval(()=>{ if(mainPlaying && $('playAllBtn') && !/Stop/i.test($('playAllBtn').textContent||'')) stopMainDrums(); },120);

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
    getUpdatedAt(){ return Number(beatUpdatedAt)||0; },
    loadProject(project){
      // Passing null means New/blank project. Reset the sequencer and discard any
      // stale unsaved drum draft so another project's beat can never carry over.
      if(!project) localStorage.removeItem(DRAFT_KEY);
      loadBeatFromProject(project || null);
    },
    persist(){
      return persistBeatIntoProject();
    },
    async startMainNow(delaySeconds=.01,startBeat=0,gainScale=1){
      if(!beat.enabled || countHits()===0) return;
      stopPreview();
      try{await ensureDrums();startMainDrums(delaySeconds,startBeat,gainScale);}catch(e){console.error(e);}
    },
    getDurationBeats(){ return beat.enabled&&countHits()>0 ? Math.max(4,(Number(beat.bars)||1)*4) : 0; },
    stopMainNow(){stopMainDrums();}
  };

  // v3.2.7: beat-maker.js loads AFTER app.js/parts.js. On startup the core can restore
  // the active project before CRPBeatMaker exists, so the old init() always replaced the saved
  // drum state with a fresh blank beat. Restore the active saved project's beat here, after the
  // bridge is actually available, and announce readiness so the core can re-apply the same project.
  function init(){
    if(!document.querySelector('link[href$="beat-maker.css"]')){
      const css=document.createElement('link'); css.rel='stylesheet'; css.href='beat-maker.css'; document.head.appendChild(css);
    }
    injectUi();
    beat=freshBeat();
    beatUpdatedAt=0;
    activeProjectId=null;
    try{
      const id=String(localStorage.getItem('crp-active-project-id')||'').trim();
      const ps=readProjects();
      const saved=id ? ps.find(p=>String(p?.id||'')===id) : inferActiveProject();
      if(saved) loadBeatFromProject(saved);
      else updateMainControls();
    }catch(err){
      console.warn('Could not restore saved beat on startup',err);
      updateMainControls();
    }
    try{window.dispatchEvent(new CustomEvent('crp-beat-ready'));}catch{}
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init); else init();
})();
