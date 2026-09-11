(() => {
  'use strict';

  const STORAGE_KEY = 'crp-projects';
  const DRAFT_KEY = 'crp-beat-draft-v1';
  const VERSION = 1;
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
  let mainStep = 0;
  let mainNextTime = 0;
  let activeProjectId = null;
  let beat = freshBeat();

  function freshBeat(){
    const tracks = {};
    DRUMS.forEach(([id]) => tracks[id] = Array.from({length:16}, () => []));
    return {version:VERSION, enabled:true, bars:1, resolution:16, gain:.78, tracks};
  }
  function normalizeBeat(src){
    const b = freshBeat();
    if(!src || typeof src !== 'object') return b;
    b.enabled = src.enabled !== false;
    b.bars = clamp(+src.bars || 1, 1, 16);
    b.resolution = [8,16,32,64].includes(+src.resolution) ? +src.resolution : 16;
    b.gain = Math.max(.1, Math.min(1.2, +src.gain || .78));
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
    return ps.slice().sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0))[0] || null;
  }
  function loadBeatFromProject(p){
    activeProjectId = p?.id || null;
    beat = normalizeBeat(p?.beatMaker);
    currentBar = clamp(currentBar,0,beat.bars-1);
    updateMainControls();
    if($('crpBeatModal')?.classList.contains('open')) renderEditor();
  }
  function persistBeatIntoProject(){
    const ps = readProjects();
    let p = activeProjectId ? ps.find(x=>x.id===activeProjectId) : null;
    if(!p){
      const name = projectName();
      p = ps.filter(x=>x.name===name).sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0))[0] || null;
    }
    if(!p){ localStorage.setItem(DRAFT_KEY, JSON.stringify(beat)); return false; }
    activeProjectId = p.id;
    const idx = ps.findIndex(x=>x.id===p.id);
    ps[idx] = {...p, beatMaker: normalizeBeat(beat), updatedAt: Date.now()};
    writeProjects(ps);
    localStorage.removeItem(DRAFT_KEY);
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
      <button id="crpBeatBtn" class="crp-beat-btn" type="button">🥁 Beat</button>
      <label class="check-label"><input id="crpDrumsToggle" type="checkbox" checked> Drums</label>`;
    playRow.insertAdjacentElement('afterend', wrap);

    const modal = document.createElement('div');
    modal.id='crpBeatModal'; modal.className='crp-beat-modal';
    modal.innerHTML = `
      <div class="crp-beat-panel" role="dialog" aria-modal="true" aria-label="Beat Maker">
        <div class="crp-beat-head">
          <h2>🥁 Beat Maker</h2>
          <label class="crp-beat-tool">Bars <select id="crpBarsSelect">${Array.from({length:16},(_,i)=>`<option>${i+1}</option>`).join('')}</select></label>
          <label class="crp-beat-tool">Grid <select id="crpResolution"><option value="8">1/8</option><option value="16">1/16</option><option value="32">1/32</option><option value="64">1/64</option></select></label>
          <button id="crpBeatClose" type="button">✕</button>
        </div>
        <div class="crp-beat-body">
          <div id="crpBarTabs" class="crp-bar-tabs"></div>
          <div class="crp-grid-wrap"><div id="crpBeatGrid" class="crp-grid"></div></div>
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
    $('crpBarsSelect').addEventListener('change', e=>{ beat.bars=clamp(+e.target.value,1,16); currentBar=clamp(currentBar,0,beat.bars-1); renderEditor(); });
    $('crpResolution').addEventListener('change', e=>{ beat.resolution=+e.target.value; renderGrid(); });
    $('crpPreview').addEventListener('click', ()=> previewing ? stopPreview() : startPreview());
    $('crpCopyBar').addEventListener('click', copyBar);
    $('crpPasteBar').addEventListener('click', pasteBar);
    $('crpDuplicateBar').addEventListener('click', duplicateBar);
    $('crpClearBar').addEventListener('click', clearBar);
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

  function updateMainControls(){
    if($('crpDrumsToggle')) $('crpDrumsToggle').checked=beat.enabled;
    if($('crpBeatBtn')){
      const hits=countHits();
      $('crpBeatBtn').classList.toggle('has-beat', hits>0);
      $('crpBeatBtn').textContent = hits ? `🥁 Beat (${beat.bars} bar${beat.bars===1?'':'s'})` : '🥁 Beat';
    }
  }
  function openEditor(){
    const p=inferActiveProject();
    if(p && p.id!==activeProjectId) loadBeatFromProject(p);
    else if(!p){ try{beat=normalizeBeat(JSON.parse(localStorage.getItem(DRAFT_KEY)||'null'))}catch{} }
    renderEditor(); $('crpBeatModal').classList.add('open');
  }
  function closeEditor(){ stopPreview(); $('crpBeatModal')?.classList.remove('open'); }
  function renderEditor(){
    $('crpBarsSelect').value=String(beat.bars); $('crpResolution').value=String(beat.resolution);
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
      const steps=document.createElement('div'); steps.className='crp-steps'; steps.style.gridTemplateColumns=`repeat(${cells},33px)`;
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
  }
  function copyBar(){ copiedBar={}; DRUMS.forEach(([id])=>copiedBar[id]=[...beat.tracks[id][currentBar]]); status(`Copied Bar ${currentBar+1}`); }
  function pasteBar(){ if(!copiedBar){status('Copy a bar first');return;} DRUMS.forEach(([id])=>beat.tracks[id][currentBar]=[...(copiedBar[id]||[])]); renderGrid(); status(`Pasted into Bar ${currentBar+1}`); }
  function duplicateBar(){
    if(beat.bars>=16 && currentBar>=15){status('16-bar maximum');return;}
    const target=Math.min(currentBar+1,15); if(target>=beat.bars) beat.bars=target+1;
    DRUMS.forEach(([id])=>beat.tracks[id][target]=[...beat.tracks[id][currentBar]]); currentBar=target; renderEditor(); status(`Duplicated to Bar ${target+1}`);
  }
  function clearBar(){ DRUMS.forEach(([id])=>beat.tracks[id][currentBar]=[]); renderGrid(); status(`Cleared Bar ${currentBar+1}`); }
  function status(s){ if($('crpBeatStatus')) $('crpBeatStatus').textContent=s; }

  function getBpm(){ return clamp(+($('bpmInput')?.value||92),40,240); }
  async function ensureDrums(){
    if(!audioCtx) audioCtx=new (window.AudioContext||window.webkitAudioContext)();
    if(audioCtx.state==='suspended') await audioCtx.resume();
    if(buffers.size===DRUMS.length) return;
    if(loading) return loading;
    loading=Promise.all(DRUMS.map(async([id,,url])=>{
      const r=await fetch(url); if(!r.ok) throw new Error(`Missing drum sample: ${url}`);
      const a=await r.arrayBuffer(); const buf=await audioCtx.decodeAudioData(a); buffers.set(id,buf);
    })).finally(()=>loading=null);
    return loading;
  }
  function hit(id,time,gain=1){
    const buf=buffers.get(id); if(!buf||!audioCtx) return;
    const src=audioCtx.createBufferSource(), g=audioCtx.createGain(); src.buffer=buf; g.gain.value=beat.gain*gain; src.connect(g).connect(audioCtx.destination); src.start(time);
  }
  async function audition(id,gain=.78){ try{await ensureDrums();hit(id,audioCtx.currentTime+.01,gain)}catch(e){console.error(e);status('Could not load drum samples');} }
  function scheduleCanonicalStep(absStep,time,barIndex){
    const step=absStep%64; DRUMS.forEach(([id])=>{ if(beat.tracks[id][barIndex]?.includes(step)) hit(id,time,1); });
  }
  function stepSeconds(){ return (60/getBpm())/16; } // one 64th = quarter/16
  function startScheduler(kind){
    if(scheduler) clearInterval(scheduler);
    const lookAhead=.10;
    scheduler=setInterval(()=>{
      if(!audioCtx) return;
      while((kind==='preview'?previewNextTime:mainNextTime) < audioCtx.currentTime+lookAhead){
        if(kind==='preview'){
          const bar=Math.floor(previewStep/64)%beat.bars; scheduleCanonicalStep(previewStep,previewNextTime,bar);
          markPlayingStep(bar,previewStep%64); previewStep++; previewNextTime+=stepSeconds();
        }else{
          const bar=Math.floor(mainStep/64)%beat.bars; scheduleCanonicalStep(mainStep,mainNextTime,bar);
          mainStep++; mainNextTime+=stepSeconds();
        }
      }
    },25);
  }
  async function startPreview(){
    try{await ensureDrums(); stopMainDrums(); previewing=true; previewStep=currentBar*64; previewNextTime=audioCtx.currentTime+.04; $('crpPreview').textContent='■ Stop Preview'; startScheduler('preview');}
    catch(e){console.error(e);status('Could not load drum samples');}
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
  function startMainDrums(){
    if(!audioCtx||!beat.enabled) return; mainPlaying=true; mainStep=0; mainNextTime=audioCtx.currentTime+.01; startScheduler('main');
  }
  function stopMainDrums(){ mainPlaying=false; if(scheduler && !previewing){clearInterval(scheduler);scheduler=null;} }

  // If the chord progression stops itself (Repeat off), stop drums too.
  setInterval(()=>{ if(mainPlaying && $('playAllBtn') && !/Stop/i.test($('playAllBtn').textContent||'')) stopMainDrums(); },120);

  // Initial beat belongs to the most recently saved project, if any.
  function init(){
    if(!document.querySelector('link[href$="beat-maker.css"]')){
      const css=document.createElement('link'); css.rel='stylesheet'; css.href='beat-maker.css'; document.head.appendChild(css);
    }
    injectUi();
    const p=inferActiveProject(); if(p) loadBeatFromProject(p);
    else { try{beat=normalizeBeat(JSON.parse(localStorage.getItem(DRAFT_KEY)||'null'))}catch{} updateMainControls(); }
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init); else init();
})();
