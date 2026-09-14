/* CRP ↔ SRP link failsafe v2.3.0
   Deliberately independent of the large SRP app IIFE. It reads/writes the same
   localStorage records directly so Link SRP cannot become a dead button if the
   main SRP initializer stops early. */
(() => {
  const qs = new URLSearchParams(location.search);
  if (qs.get('crpMode') !== '1') return;

  const HANDOFF_KEY = 'crp-srp-handoff-v2';
  const LINKS_KEY = 'crp-srp-links-v1';
  const PROJECTS_PREFIX = 'songrider_v25_projects::';
  const CURRENT_PREFIX = 'songrider_v25_currentProjectId::';

  const readJson = (key, fallback) => {
    try { const raw = localStorage.getItem(key); return raw ? (JSON.parse(raw) ?? fallback) : fallback; }
    catch { return fallback; }
  };
  const writeJson = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} };
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

  function recoverPayload(){
    const handoff = readJson(HANDOFF_KEY, {});
    if(handoff?.payload?.crpProjectId) return handoff.payload;
    const projects = readJson('crp-projects', []);
    const activeId = String(localStorage.getItem('crp-active-project-id') || '');
    const p = (activeId && projects.find(x => String(x?.id||'') === activeId)) ||
      [...projects].sort((a,b)=>(Number(b?.updatedAt)||0)-(Number(a?.updatedAt)||0))[0];
    if(!p?.id) return null;
    const payload = {
      crpProjectId:p.id,
      name:p.name || 'Untitled',
      bpm:Number(p.bpm)||92,
      beats:Number(p.beats)||4,
      key:String(p.key||''),
      rows:(Array.isArray(p.rows)?p.rows:[]).map((row,rowIndex)=>({
        lineId:`crp-line-${rowIndex+1}`,
        cards:(Array.isArray(row)?row:[]).map(c=>({type:c?.type||'chord', value:String(c?.value||'')}))
      }))
    };
    writeJson(HANDOFF_KEY,{payload,rec:readJson(LINKS_KEY,{})[p.id]||null,ts:Date.now()});
    return payload;
  }

  function findSrpScopeAndProject(){
    const scopes=[];
    for(let i=0;i<localStorage.length;i++){
      const k=localStorage.key(i)||'';
      if(k.startsWith(PROJECTS_PREFIX)) scopes.push(k.slice(PROJECTS_PREFIX.length));
    }
    if(!scopes.length) scopes.push('guest');

    // Prefer a scope whose current-project id resolves to a project.
    for(const scope of scopes){
      const list=readJson(PROJECTS_PREFIX+scope,[]);
      const cur=String(localStorage.getItem(CURRENT_PREFIX+scope)||'');
      const p=Array.isArray(list)?list.find(x=>String(x?.id||'')===cur):null;
      if(p) return {scope,list,p};
    }
    // Then the most recently updated SRP project in any scope.
    let best=null;
    for(const scope of scopes){
      const list=readJson(PROJECTS_PREFIX+scope,[]);
      for(const p of Array.isArray(list)?list:[]){
        if(!best || (Number(p?.updatedAt)||0)>(Number(best.p?.updatedAt)||0)) best={scope,list,p};
      }
    }
    if(best) return best;
    return {scope:'guest',list:[],p:null};
  }

  function blankLine(){ return {id:uid(),notes:Array(8).fill(''),lyrics:'',beats:Array(4).fill('')}; }
  function blankProject(name){
    const t=Date.now();
    return {id:uid(),name:name||'Linked Song',createdAt:t,updatedAt:t,notesUpdatedAt:t,notesClearedAt:0,
      transposeMode:'capo',steps:0,bpm:95,capo:0,fullText:'',fullSeeded:false,
      sections:{'PAGE 1':[blankLine()]},enabledSections:['PAGE 1'],sectionTitles:{},extraSections:[],
      deletedBaseSections:[],notesDoc:'',notesColor:'#151515',notesImages:[],archived:false};
  }

  function persistLink(payload){
    if(!payload?.crpProjectId) throw new Error('Save the CRP project first, then return to Song Rider.');
    const found=findSrpScopeAndProject();
    const scope=found.scope;
    const list=Array.isArray(found.list)?found.list:[];
    let p=list.find(x=>String(x?.linkedCrpProjectId||'')===String(payload.crpProjectId)) || found.p;
    if(!p) p=blankProject(payload.name);

    p={...p};
    p.linkedCrpProjectId=payload.crpProjectId;
    p.bpm=Number(payload.bpm)||Number(p.bpm)||95;
    p.crpKey=String(payload.key||'');
    p.crpBeatsPerChord=Number(payload.beats)||4;
    p.crpChordRows=Array.isArray(payload.rows)?payload.rows:[];
    p.updatedAt=Date.now();

    const sections={...(p.sections||{})};
    const oldLines=Array.isArray(sections['PAGE 1'])?sections['PAGE 1']:[];
    const rows=Array.isArray(payload.rows)?payload.rows:[];
    if(rows.length){
      sections['PAGE 1']=rows.map((r,i)=>{
        const prev={...(oldLines[i]||blankLine())};
        const chords=(r.cards||[]).filter(c=>c?.type==='chord').map(c=>String(c.value||'')).filter(Boolean);
        const notes=Array(8).fill('');
        chords.forEach((ch,j)=>{notes[Math.min(7,Math.floor(j*8/Math.max(1,chords.length)))]=ch;});
        return {...prev,id:prev.id||String(r.lineId||uid()),notes,lyrics:String(prev.lyrics||''),beats:Array.isArray(prev.beats)?prev.beats:Array(4).fill('')};
      });
    }
    p.sections=sections;
    p.enabledSections=Array.from(new Set(['PAGE 1',...(Array.isArray(p.enabledSections)?p.enabledSections:[])]));

    const idx=list.findIndex(x=>String(x?.id||'')===String(p.id));
    if(idx>=0) list[idx]=p; else list.unshift(p);
    writeJson(PROJECTS_PREFIX+scope,list);
    try{localStorage.setItem(CURRENT_PREFIX+scope,String(p.id));}catch{}

    const links=readJson(LINKS_KEY,{});
    const rec={srpProjectId:p.id,srpName:p.name||payload.name||'Song Rider project',linkedAt:Date.now()};
    links[payload.crpProjectId]=rec;
    writeJson(LINKS_KEY,links);
    writeJson(HANDOFF_KEY,{payload,rec,ts:Date.now()});
    return rec;
  }

  function paint(rec){
    const b=document.getElementById('crpSrpLinkBtn');
    const u=document.getElementById('crpSrpUnlinkBtn');
    const s=document.getElementById('crpSrpLinkStatus');
    if(b){b.hidden=false;b.disabled=!!rec;b.textContent=rec?'Linked ✓':'Link SRP';b.classList.toggle('is-linked',!!rec);}
    if(u)u.hidden=!rec;
    if(s)s.textContent=rec?`Linked • ${rec.srpName||'Song Rider project'}`:'';
  }

  function onLink(ev){
    const b=ev.target?.closest?.('#crpSrpLinkBtn');
    if(!b)return;
    ev.preventDefault();ev.stopPropagation();ev.stopImmediatePropagation?.();
    if(b.dataset.busy==='1')return;
    b.dataset.busy='1';b.disabled=true;b.textContent='Linking…';
    const s=document.getElementById('crpSrpLinkStatus');if(s)s.textContent='Linking CRP project…';
    try{
      const payload=recoverPayload();
      const rec=persistLink(payload);
      paint(rec);
      // Reload once so SRP's own in-memory project state picks up the persisted link/chords.
      setTimeout(()=>location.reload(),220);
    }catch(err){
      console.error('CRP/SRP link failed',err);
      b.dataset.busy='0';b.disabled=false;b.textContent='Link SRP';
      if(s)s.textContent=err?.message||'Link failed — try again.';
    }
  }

  function onUnlink(ev){
    const u=ev.target?.closest?.('#crpSrpUnlinkBtn');if(!u)return;
    ev.preventDefault();ev.stopPropagation();
    const payload=recoverPayload();if(!payload?.crpProjectId)return;
    const links=readJson(LINKS_KEY,{});delete links[payload.crpProjectId];writeJson(LINKS_KEY,links);
    const h=readJson(HANDOFF_KEY,{});writeJson(HANDOFF_KEY,{...h,rec:null,ts:Date.now()});
    paint(null);
  }

  document.addEventListener('click',onLink,true);
  document.addEventListener('click',onUnlink,true);
  setTimeout(()=>{
    const payload=recoverPayload();
    const rec=payload?readJson(LINKS_KEY,{})[payload.crpProjectId]||null:null;
    paint(rec);
  },60);
})();
