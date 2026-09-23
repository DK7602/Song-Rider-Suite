(() => {
  'use strict';
  const KEY = 'srs-skin-v1';
  const DEFAULT = 'rider-original';
  const SKINS = [
    {id:'rider-original', name:'Rider Original', desc:'Original black + gold Bones & Rider look.', swatches:['#0d0f12','#e9c46a','#11161d','#72c98a']},
    {id:'rider-blood', name:'Rider Blood', desc:'Original Rider look with deep red accents, red editor cells and subtle red trim.', swatches:['#0d0f12','#e9c46a','#b9242d','#2a1013']},
    {id:'studio-pastel', name:'Studio Pastel', desc:'Blue, pink, warm tan + gold. Calm studio graphics.', swatches:['#f2e6d7','#7aaed8','#e89aba','#c49a43']},
    {id:'celtic-gold', name:'Celtic Gold', desc:'Light Celtic skin with fresh green, 24-karat gold, cream and Celtic knot art.', swatches:['#2f8757','#d2a239','#fffdf7','#f3ecda']},
    {id:'celtic-gold-dark', name:'Celtic Gold Dark', desc:'Deep green-black Celtic skin with 24-karat gold, cream highlights and Celtic knot art.', swatches:['#0f2419','#d2a239','#e7ebde','#2f8757']},
    {id:'black-label', name:'Black Label', desc:'Black, yellow and polished gold. Elegant and skull-free.', swatches:['#090a0c','#e3b84e','#f0cf57','#25272c']},
    {id:'black-label-light', name:'Black Label Light', desc:'White, gray, gold + yellow with restrained green.', swatches:['#f6f5f1','#d4aa45','#e7ca52','#4e9d65']},
    {id:'rider-light', name:'Rider Light', desc:'Light Rider palette with the current Bones & Rider buttons.', swatches:['#f4f4f2','#d8ac43','#f0cf52','#57a96f']},
    {id:'rider-blood-light', name:'Rider Blood Light', desc:'Rider Light with deep red accents, red editor cells and subtle red trim.', swatches:['#f4f4f2','#d8ac43','#f0cf52','#c62f38']}
  ];
  const VALID = new Set(SKINS.map(s=>s.id));
  const $ = (s, root=document) => root.querySelector(s);
  function readSkin(){
    try { const v=localStorage.getItem(KEY); return VALID.has(v)?v:DEFAULT; } catch { return DEFAULT; }
  }
  function setThemeColor(skin){
    const map={
      'rider-original':'#111111', 'rider-blood':'#111111', 'studio-pastel':'#f2e6d7', 'celtic-gold':'#f3ecda', 'celtic-gold-dark':'#0f2419', 'black-label':'#090a0c',
      'black-label-light':'#f6f5f1', 'rider-light':'#f4f4f2', 'rider-blood-light':'#f4f4f2'
    };
    const meta=$('meta[name="theme-color"]'); if(meta) meta.setAttribute('content',map[skin]||map[DEFAULT]);
  }
  function updateSkinAssets(skin){
    const blood=skin==='rider-blood'||skin==='rider-blood-light';
    document.querySelectorAll('.srp-exact-wordmark').forEach(img=>{
      if(!img.dataset.srsOriginalSrc)img.dataset.srsOriginalSrc=img.getAttribute('src')||'./song-rider-pro-wordmark-hq.png?v=3.3.12';
      img.setAttribute('src',blood?'./song-rider-pro-wordmark-blood.png?v=3.3.71':img.dataset.srsOriginalSrc);
    });
  }
  function applySkin(skin, persist=true){
    skin=VALID.has(skin)?skin:DEFAULT;
    const baseSkin=skin==='rider-blood'?'rider-original':(skin==='rider-blood-light'?'rider-light':skin);
    const variant=skin==='rider-blood'||skin==='rider-blood-light'?'blood':'';
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
    refreshModeIcons(skin);
    if(persist){ try{localStorage.setItem(KEY,skin)}catch{} }
    document.querySelectorAll('[data-srs-skin-choice]').forEach(btn=>{
      const on=btn.dataset.srsSkinChoice===skin;
      btn.classList.toggle('is-selected',on);
      btn.setAttribute('aria-pressed',String(on));
    });
    const label=$('#srsSkinCurrent'); if(label){ const s=SKINS.find(x=>x.id===skin); label.textContent=s?.name||'Rider Original'; }
    window.dispatchEvent(new CustomEvent('srs-skin-change',{detail:{skin}}));
  }
  // Apply before the rest of the UI is enhanced whenever this script is loaded early enough.
  applySkin(readSkin(), false);

  const iconSvgs={
    chord:`<svg viewBox="0 0 64 64" aria-hidden="true" style="stroke:url(#srsGoldChord)"><defs><linearGradient id="srsGoldChord" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff5b0"/><stop offset=".25" stop-color="#f2c230"/><stop offset=".55" stop-color="#a86705"/><stop offset=".78" stop-color="#ffd95a"/><stop offset="1" stop-color="#7b4800"/></linearGradient></defs><path d="M14 42V20M14 22c10 0 17-4 24-10v30"/><circle cx="14" cy="46" r="7"/><circle cx="38" cy="46" r="7"/><path d="M38 18c7 1 11 4 14 8"/></svg>`,
    daw:`<svg viewBox="0 0 64 64" aria-hidden="true" style="stroke:url(#srsGoldDaw)"><defs><linearGradient id="srsGoldDaw" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff5b0"/><stop offset=".25" stop-color="#f2c230"/><stop offset=".55" stop-color="#a86705"/><stop offset=".78" stop-color="#ffd95a"/><stop offset="1" stop-color="#7b4800"/></linearGradient></defs><path d="M15 12v40M32 12v40M49 12v40"/><rect x="9" y="21" width="12" height="8" rx="4"/><rect x="26" y="36" width="12" height="8" rx="4"/><rect x="43" y="18" width="12" height="8" rx="4"/><path d="M8 54h48"/></svg>`,
    song:`<svg viewBox="0 0 64 64" aria-hidden="true" style="stroke:url(#srsGoldSong)"><defs><linearGradient id="srsGoldSong" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff5b0"/><stop offset=".25" stop-color="#f2c230"/><stop offset=".55" stop-color="#a86705"/><stop offset=".78" stop-color="#ffd95a"/><stop offset="1" stop-color="#7b4800"/></linearGradient></defs><rect x="23" y="8" width="18" height="31" rx="9"/><path d="M16 31c0 10 6 16 16 16s16-6 16-16M32 47v9M22 56h20M8 15h10M8 22h10M46 15h10M46 22h10"/></svg>`,
    track:`<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M12 12v40M26 12v40M40 12v40M54 12v40"/><rect x="7" y="18" width="10" height="8" rx="3"/><rect x="21" y="36" width="10" height="8" rx="3"/><rect x="35" y="25" width="10" height="8" rx="3"/><rect x="49" y="41" width="10" height="8" rx="3"/></svg>`,
    celticChord:`<svg viewBox="0 0 64 64" aria-hidden="true" style="stroke:url(#srsCelticGold1)"><defs><linearGradient id="srsCelticGold1" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff7c8"/><stop offset=".25" stop-color="#f4d05d"/><stop offset=".58" stop-color="#c58f11"/><stop offset=".82" stop-color="#ffe699"/><stop offset="1" stop-color="#7b5400"/></linearGradient></defs><path d="M32 14c5 0 9 4 9 9 0 6-5 10-9 13-4-3-9-7-9-13 0-5 4-9 9-9z"/><path d="M22 28c5 0 9 4 9 9 0 6-5 10-9 13-4-3-9-7-9-13 0-5 4-9 9-9z"/><path d="M42 28c5 0 9 4 9 9 0 6-5 10-9 13-4-3-9-7-9-13 0-5 4-9 9-9z"/><path d="M32 36v14"/><path d="M28 50c2 0 3 1 4 3 1-2 2-3 4-3"/></svg>`,
    celticDaw:`<svg viewBox="0 0 64 64" aria-hidden="true" style="stroke:url(#srsCelticGold2)"><defs><linearGradient id="srsCelticGold2" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff7c8"/><stop offset=".25" stop-color="#f4d05d"/><stop offset=".58" stop-color="#c58f11"/><stop offset=".82" stop-color="#ffe699"/><stop offset="1" stop-color="#7b5400"/></linearGradient></defs><path d="M32 10c6 7 11 12 11 19 0 5-3 9-11 17-8-8-11-12-11-17 0-7 5-12 11-19z"/><path d="M20 24c9 0 12 4 12 16"/><path d="M44 24c-9 0-12 4-12 16"/><path d="M19 40c6-5 12-5 25 0"/><path d="M25 17c5 4 9 4 14 0"/></svg>`,
    celticSong:`<svg viewBox="0 0 64 64" aria-hidden="true" style="stroke:url(#srsCelticGold3)"><defs><linearGradient id="srsCelticGold3" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff7c8"/><stop offset=".25" stop-color="#f4d05d"/><stop offset=".58" stop-color="#c58f11"/><stop offset=".82" stop-color="#ffe699"/><stop offset="1" stop-color="#7b5400"/></linearGradient></defs><circle cx="32" cy="32" r="18"/><path d="M32 14c6 5 10 11 10 18s-4 13-10 18c-6-5-10-11-10-18s4-13 10-18z"/><path d="M14 32c5-6 11-10 18-10s13 4 18 10c-5 6-11 10-18 10s-13-4-18-10z"/><path d="M24 24c5 1 11 1 16 0"/><path d="M24 40c5-1 11-1 16 0"/></svg>`,
    celticTrack:`<svg viewBox="0 0 64 64" aria-hidden="true" style="stroke:url(#srsCelticGold4)"><defs><linearGradient id="srsCelticGold4" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff7c8"/><stop offset=".25" stop-color="#f4d05d"/><stop offset=".58" stop-color="#c58f11"/><stop offset=".82" stop-color="#ffe699"/><stop offset="1" stop-color="#7b5400"/></linearGradient></defs><path d="M12 20h40"/><path d="M12 32h40"/><path d="M12 44h40"/><path d="M20 14c4 2 6 5 6 9-4-2-8-2-12 0 0-4 2-7 6-9z"/><path d="M32 26c4 2 6 5 6 9-4-2-8-2-12 0 0-4 2-7 6-9z"/><path d="M44 38c4 2 6 5 6 9-4-2-8-2-12 0 0-4 2-7 6-9z"/></svg>`
  };
  function getSkinAssetUrl(file){
    const root = window.location.pathname.includes('/song-rider/') ? '../assets/' : './assets/';
    return new URL(root + file, window.location.href).href;
  }
  function getModeMarkup(kind, skin){
    const celtic = skin==='celtic-gold' || skin==='celtic-gold-dark';
    if(celtic){
      const map = {
        chord:'celtic-mode-chord.png',
        daw:'celtic-mode-daw.png',
        song:'celtic-mode-song.png',
        track:'celtic-mode-track.png'
      };
      const file = map[kind] || map.chord;
      return `<img src="${getSkinAssetUrl(file)}" alt="" decoding="async" loading="eager">`;
    }
    return iconSvgs[kind]||iconSvgs.chord;
  }
  function refreshModeIcons(skin){
    document.querySelectorAll('.srs-theme-mode-icon').forEach(el=>{
      const kind=el.dataset.iconKind||'chord';
      el.innerHTML=getModeMarkup(kind, skin);
    });
    // Celtic Gold keeps the Track Master button as a clean 24-karat gold button with no icon.
    document.querySelectorAll('.srs-track-master-icon').forEach(el=>el.remove());
  }
  function addModeIcons(){

    document.querySelectorAll('.workspace-mode-switch .workspace-mode-btn').forEach((btn,i)=>{
      if(btn.querySelector('.srs-theme-mode-icon')) return;
      let kind='chord';
      const mode=btn.dataset.workspaceMode||''; const href=btn.getAttribute('href')||'';
      if(mode==='baby-daw'||href.includes('baby-daw')||i===1)kind='daw';
      else if(mode==='song-rider'||href.includes('song-rider')||i===2)kind='song';
      const art=document.createElement('span'); art.className=`srs-theme-mode-icon srs-theme-mode-icon-${kind}`; art.dataset.iconKind=kind; art.innerHTML=getModeMarkup(kind, readSkin());
      btn.prepend(art);
      if(kind==='daw'&&!btn.querySelector('.mode-copy')&&!btn.querySelector('.srs-theme-mode-copy')){
        const copy=document.createElement('span'); copy.className='mode-copy srs-theme-mode-copy'; copy.innerHTML='<strong>Baby DAW</strong><small>Production + Parts</small>'; btn.appendChild(copy);
      }
    });
    document.querySelectorAll('.track-master-gold-btn .srs-track-master-icon').forEach(el=>el.remove());
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
  function init(){ addModeIcons(); buildModal(); addGear(); applySkin(readSkin(),false); }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true}); else init();
  window.addEventListener('storage',e=>{ if(e.key===KEY)applySkin(readSkin(),false); });
  window.SRSSkins={apply:applySkin,current:readSkin,open:openModal,skins:SKINS.slice()};
})();
