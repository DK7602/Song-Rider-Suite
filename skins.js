(() => {
  'use strict';
  const KEY = 'srs-skin-v1';
  const DEFAULT = 'black-label-plain';
  const SKINS = [
    {id:'rider-original', name:'Rider Original', desc:'Original black + gold Bones & Rider look.', swatches:['#0d0f12','#e9c46a','#11161d','#72c98a']},
    {id:'rider-og', name:'Rider OG', desc:'Rider Original with the new black-and-gold paisley background.', swatches:['#0d0f12','#887a27','#11161d','#e9c46a']},
    {id:'rider-blood', name:'Rider Blood', desc:'Original Rider look with deep red accents, red editor cells and subtle red trim.', swatches:['#0d0f12','#e9c46a','#b9242d','#2a1013']},
    {id:'studio-pastel', name:'Studio Pastel', desc:'Blue, pink, warm tan + gold. Calm studio graphics.', swatches:['#f2e6d7','#7aaed8','#e89aba','#c49a43']},
    {id:'black-label', name:'Black Label', desc:'Black, yellow and polished gold with the patterned background.', swatches:['#090a0c','#e3b84e','#f0cf57','#25272c']},
    {id:'black-label-plain', name:'Black Label Plain', desc:'Classic Black Label before the patterned background — clean black, gold and yellow.', swatches:['#090a0c','#e3b84e','#f0cf57','#25272c']},
    {id:'black-label-light', name:'Black Label Light', desc:'White, gray, gold + yellow with restrained green.', swatches:['#f6f5f1','#d4aa45','#e7ca52','#4e9d65']},
    {id:'royal-wave', name:'Royal Wave', desc:'Royal blue, baby blue, orange + cream with the polished studio icon set.', swatches:['#005CF7','#98D6FF','#FF9700','#EEE8C6']},
    {id:'candy-pop', name:'Candy Pop', desc:'Pink, teal, yellow + cream with the polished studio icon set.', swatches:['#FFB2F6','#87FFF5','#FFF600','#EFEAD7']},
    {id:'rider-light', name:'Rider Light', desc:'Light Rider palette with the current Bones & Rider buttons.', swatches:['#f4f4f2','#d8ac43','#f0cf52','#57a96f']},
    {id:'rider-light-og', name:'Rider Light OG', desc:'Rider Light with the supplied mint paisley background.', swatches:['#f4f4f2','#d8ac43','#f0cf52','#99d79f']},
    {id:'rider-blood-light', name:'Rider Blood Light', desc:'Red, patterned white, cream and polished gold with Rider artwork.', swatches:['#e60000','#fffdf7','#efe8cf','#d7a63c']}
    ,{id:'rider-blood-light-og', name:'Rider Blood Light OG', desc:'Rider Blood Light with the supplied red-and-silver paisley background.', swatches:['#e60000','#fffdf7','#d4c3c3','#ff6b63']}
  ];
  const VALID = new Set(SKINS.map(s=>s.id));
  const $ = (s, root=document) => root.querySelector(s);
  const CLOUD_SKIN_ENDPOINT='/api/preferences/skin';
  let localSkinRevision=0, cloudSaveTimer=null, cloudSyncPromise=null, lastCloudSyncAt=0;
  async function skinApi(method='GET',payload){
    const options={method,credentials:'same-origin',headers:{'Accept':'application/json'}};
    if(payload!==undefined){options.headers['Content-Type']='application/json';options.body=JSON.stringify(payload);}
    const r=await fetch(CLOUD_SKIN_ENDPOINT,options);
    let d={};try{d=await r.json();}catch{}
    if(!r.ok){const err=new Error(d.error||`Skin sync failed (${r.status})`);err.status=r.status;throw err;}
    return d;
  }
  function cacheSkin(skin){try{localStorage.setItem(KEY,skin)}catch{}}
  function queueCloudSkinSave(skin){
    clearTimeout(cloudSaveTimer);
    cloudSaveTimer=setTimeout(async()=>{
      try{await skinApi('POST',{skin});}
      catch(err){if(err?.status!==401)console.warn('Could not save skin preference to cloud',err);}
    },120);
  }
  async function syncCloudSkin({seedIfMissing=true,force=false}={}){
    const now=Date.now();
    if(!force&&now-lastCloudSyncAt<1200)return cloudSyncPromise;
    if(cloudSyncPromise)return cloudSyncPromise;
    lastCloudSyncAt=now;
    const startRevision=localSkinRevision;
    cloudSyncPromise=(async()=>{
      try{
        const d=await skinApi('GET');
        if(localSkinRevision!==startRevision)return d;
        if(VALID.has(d.skin)){cacheSkin(d.skin);applySkin(d.skin,false);return d;}
        if(seedIfMissing){const current=readSkin();await skinApi('POST',{skin:current});}
        return d;
      }catch(err){
        if(err?.status!==401)console.warn('Could not load skin preference from cloud',err);
        return null;
      }finally{cloudSyncPromise=null;}
    })();
    return cloudSyncPromise;
  }
  function readSkin(){
    try { const v=localStorage.getItem(KEY); return VALID.has(v)?v:DEFAULT; } catch { return DEFAULT; }
  }
  function setThemeColor(skin){
    const map={
      'rider-original':'#111111', 'rider-og':'#111111', 'rider-blood':'#111111', 'studio-pastel':'#f2e6d7', 'black-label':'#090a0c',
      'black-label-plain':'#090a0c', 'black-label-light':'#f6f5f1', 'royal-wave':'#005CF7', 'candy-pop':'#EFEAD7', 'rider-light':'#f4f4f2', 'rider-light-og':'#f4f4f2', 'rider-blood-light':'#efe8cf', 'rider-blood-light-og':'#efe8cf'
    };
    const meta=$('meta[name="theme-color"]'); if(meta) meta.setAttribute('content',map[skin]||map[DEFAULT]);
  }
  function updateSkinAssets(skin){
    const blood=skin==='rider-blood'||skin==='rider-blood-light'||skin==='rider-blood-light-og';
    document.querySelectorAll('.srp-exact-wordmark').forEach(img=>{
      if(!img.dataset.srsOriginalSrc)img.dataset.srsOriginalSrc=img.getAttribute('src')||'./song-rider-pro-wordmark-hq.png?v=3.3.12';
      img.setAttribute('src',blood?'./song-rider-pro-wordmark-blood.png?v=3.3.71':img.dataset.srsOriginalSrc);
    });
  }
  function applySkin(skin, persist=true){
    skin=VALID.has(skin)?skin:DEFAULT;
    const baseSkin=(skin==='rider-blood'||skin==='rider-og')?'rider-original':(skin==='black-label-plain'?'black-label':(((skin==='rider-blood-light'||skin==='rider-blood-light-og')||skin==='rider-light-og')?'rider-light':skin));
    const variant=skin==='rider-blood'||skin==='rider-blood-light'||skin==='rider-blood-light-og'?'blood':'';
    document.documentElement.dataset.skin=baseSkin;
    document.documentElement.dataset.skinChoice=skin;
    if(variant) document.documentElement.dataset.skinVariant=variant; else delete document.documentElement.dataset.skinVariant;
    if(document.body){
      document.body.dataset.skin=baseSkin;
      document.body.dataset.skinChoice=skin;
      if(variant) document.body.dataset.skinVariant=variant; else delete document.body.dataset.skinVariant;
    }
    setThemeColor(skin);
    updateSkinAssets(skin);
    if(persist){ localSkinRevision++; cacheSkin(skin); queueCloudSkinSave(skin); }
    document.querySelectorAll('[data-srs-skin-choice]').forEach(btn=>{
      const on=btn.dataset.srsSkinChoice===skin;
      btn.classList.toggle('is-selected',on);
      btn.setAttribute('aria-pressed',String(on));
    });
    const label=$('#srsSkinCurrent'); if(label){ const s=SKINS.find(x=>x.id===skin); label.textContent=s?.name||'Black Label Plain'; }
    window.dispatchEvent(new CustomEvent('srs-skin-change',{detail:{skin}}));
  }
  // Apply before the rest of the UI is enhanced whenever this script is loaded early enough.
  applySkin(readSkin(), false);

  const iconSvgs={
    chord:`<svg viewBox="0 0 64 64" aria-hidden="true" style="stroke:url(#srsGoldChord)"><defs><linearGradient id="srsGoldChord" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff5b0"/><stop offset=".25" stop-color="#f2c230"/><stop offset=".55" stop-color="#a86705"/><stop offset=".78" stop-color="#ffd95a"/><stop offset="1" stop-color="#7b4800"/></linearGradient></defs><path d="M14 42V20M14 22c10 0 17-4 24-10v30"/><circle cx="14" cy="46" r="7"/><circle cx="38" cy="46" r="7"/><path d="M38 18c7 1 11 4 14 8"/></svg>`,
    daw:`<svg viewBox="0 0 64 64" aria-hidden="true" style="stroke:url(#srsGoldDaw)"><defs><linearGradient id="srsGoldDaw" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff5b0"/><stop offset=".25" stop-color="#f2c230"/><stop offset=".55" stop-color="#a86705"/><stop offset=".78" stop-color="#ffd95a"/><stop offset="1" stop-color="#7b4800"/></linearGradient></defs><path d="M15 12v40M32 12v40M49 12v40"/><rect x="9" y="21" width="12" height="8" rx="4"/><rect x="26" y="36" width="12" height="8" rx="4"/><rect x="43" y="18" width="12" height="8" rx="4"/><path d="M8 54h48"/></svg>`,
    song:`<svg viewBox="0 0 64 64" aria-hidden="true" style="stroke:url(#srsGoldSong)"><defs><linearGradient id="srsGoldSong" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff5b0"/><stop offset=".25" stop-color="#f2c230"/><stop offset=".55" stop-color="#a86705"/><stop offset=".78" stop-color="#ffd95a"/><stop offset="1" stop-color="#7b4800"/></linearGradient></defs><rect x="23" y="8" width="18" height="31" rx="9"/><path d="M16 31c0 10 6 16 16 16s16-6 16-16M32 47v9M22 56h20M8 15h10M8 22h10M46 15h10M46 22h10"/></svg>`,
    track:`<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M12 12v40M26 12v40M40 12v40M54 12v40"/><rect x="7" y="18" width="10" height="8" rx="3"/><rect x="21" y="36" width="10" height="8" rx="3"/><rect x="35" y="25" width="10" height="8" rx="3"/><rect x="49" y="41" width="10" height="8" rx="3"/></svg>`
  };
  function addModeIcons(){
    document.querySelectorAll('.workspace-mode-switch .workspace-mode-btn').forEach((btn,i)=>{
      if(btn.querySelector('.srs-theme-mode-icon')) return;
      let kind='chord';
      const mode=btn.dataset.workspaceMode||''; const href=btn.getAttribute('href')||'';
      if(mode==='baby-daw'||href.includes('baby-daw')||i===1)kind='daw';
      else if(mode==='song-rider'||href.includes('song-rider')||i===2)kind='song';
      const art=document.createElement('span'); art.className=`srs-theme-mode-icon srs-theme-mode-icon-${kind}`; art.innerHTML=iconSvgs[kind];
      btn.prepend(art);
      if(kind==='daw'&&!btn.querySelector('.mode-copy')&&!btn.querySelector('.srs-theme-mode-copy')){
        const copy=document.createElement('span'); copy.className='mode-copy srs-theme-mode-copy'; copy.innerHTML='<strong>Baby DAW</strong><small>Production + Parts</small>'; btn.appendChild(copy);
      }
    });
    document.querySelectorAll('.track-master-gold-btn').forEach(btn=>{
      if(btn.querySelector('.srs-track-master-icon'))return;
      const art=document.createElement('span'); art.className='srs-track-master-icon'; art.innerHTML=iconSvgs.track; btn.prepend(art);
    });
  }
  function buildModal(){
    if($('#srsSkinModal'))return;
    const wrap=document.createElement('div'); wrap.id='srsSkinModal'; wrap.className='srs-skin-modal'; wrap.hidden=true;
    wrap.innerHTML=`<div class="srs-skin-backdrop" data-srs-close-skins></div><section class="srs-skin-card" role="dialog" aria-modal="true" aria-labelledby="srsSkinTitle"><div class="srs-skin-head"><div><h2 id="srsSkinTitle">Appearance</h2><p>Choose a Song Rider Suite skin. This changes appearance only — projects, audio and controls stay the same.</p></div><button class="srs-skin-close" type="button" data-srs-close-skins aria-label="Close appearance settings">×</button></div><div class="srs-skin-current">Current: <strong id="srsSkinCurrent"></strong></div><div class="srs-skin-grid">${SKINS.map(s=>`<button type="button" class="srs-skin-choice" data-srs-skin-choice="${s.id}" aria-pressed="false"><span class="srs-skin-preview preview-${s.id}"><span class="srs-preview-top"></span><span class="srs-preview-icons"><i></i><i></i><i></i></span></span><span class="srs-skin-choice-copy"><strong>${s.name}</strong><small>${s.desc}</small><span class="srs-swatch-row">${s.swatches.map(c=>`<i style="--sw:${c}"></i>`).join('')}</span></span><span class="srs-skin-check">✓</span></button>`).join('')}</div></section>`;
    document.body.appendChild(wrap);
    wrap.addEventListener('click',e=>{
      const choice=e.target.closest('[data-srs-skin-choice]'); if(choice){ applySkin(choice.dataset.srsSkinChoice,true); return; }
      if(e.target.closest('[data-srs-close-skins]')) closeModal();
    });
    document.addEventListener('keydown',e=>{ if(e.key==='Escape'&&!wrap.hidden)closeModal(); });
    applySkin(readSkin(),false);
  }
  function openModal(){ const m=$('#srsSkinModal'); if(!m)return; m.hidden=false; document.body.classList.add('srs-skin-modal-open'); applySkin(readSkin(),false); }
  function closeModal(){ const m=$('#srsSkinModal'); if(!m)return; m.hidden=true; document.body.classList.remove('srs-skin-modal-open'); }
  function addGear(){
    if($('#srsSkinSettingsBtn'))return;
    const rootPanel=$('#accountPanel');
    if(rootPanel){
      const b=document.createElement('button'); b.id='srsSkinSettingsBtn'; b.className='srs-skin-gear'; b.type='button'; b.title='Appearance / Skins'; b.setAttribute('aria-label','Appearance and skins'); b.innerHTML='<span aria-hidden="true">⚙</span>';
      rootPanel.appendChild(b); b.addEventListener('click',openModal); return;
    }
    const authHead=$('.authModal .authHead');
    if(authHead){
      const b=document.createElement('button'); b.id='srsSkinSettingsBtn'; b.className='srs-skin-gear srs-skin-gear-inline'; b.type='button'; b.title='Appearance / Skins'; b.setAttribute('aria-label','Appearance and skins'); b.innerHTML='<span aria-hidden="true">⚙</span>';
      const close=authHead.querySelector('.authClose'); authHead.insertBefore(b,close||null); b.addEventListener('click',openModal);
    }
  }
  function init(){ addModeIcons(); buildModal(); addGear(); applySkin(readSkin(),false); setTimeout(()=>syncCloudSkin({seedIfMissing:true,force:true}),0); }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true}); else init();
  window.addEventListener('storage',e=>{ if(e.key===KEY)applySkin(readSkin(),false); });
  window.addEventListener('srs-auth-changed',e=>{if(e.detail?.loggedIn)syncCloudSkin({seedIfMissing:true,force:true});});
  window.addEventListener('pageshow',()=>syncCloudSkin({seedIfMissing:true}));
  window.addEventListener('focus',()=>syncCloudSkin({seedIfMissing:true}));
  window.SRSSkins={apply:applySkin,current:readSkin,open:openModal,skins:SKINS.slice(),syncCloud:syncCloudSkin};
})();
