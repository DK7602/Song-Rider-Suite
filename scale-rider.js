(()=>{
'use strict';
const N=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'],NI={C:0,'C#':1,Db:1,Cb:11,'B#':0,D:2,'D#':3,Eb:3,E:4,'E#':5,Fb:4,F:5,'F#':6,Gb:6,G:7,'G#':8,Ab:8,A:9,'A#':10,Bb:10,B:11};
const GENRES={
 Classical:{Baroque:['I-IV-V-I','I-vi-ii-V','I-V-vi-iii-IV-I-IV-V','i-iv-V-i','i-bVI-bIII-bVII'],Classical:['I-V-I-IV-I-V-I','I-ii-V-I','I-vi-IV-V','i-iv-V-i','I-IV-ii-V'],Romantic:['I-iii-IV-iv','I-V7-vi-IV','i-bVI-bIII-bVII','i-iv-bVI-V','I-vi-ii-V']},
 Country:{Traditional:['I-IV-V-I','I-V-IV-I','I-IV-I-V','I-vi-IV-V','I-V-vi-IV'],Modern:['I-V-vi-IV','vi-IV-I-V','I-IV-vi-V','I-V-IV-V','I-iii-IV-I'],Outlaw:['I-bVII-IV-I','i-bVII-bVI-bVII','I-IV-I-V','i-bIII-bVII-IV','I-bVII-I']},
 Cultural:{African:['I-IV-I-V','I-bVII-IV-I','i-bVII-bVI-bVII','I-V-IV-I','i-IV-bVII-i'],Arabic:['i-bII-V-i','i-bII-bVII-i','i-iv-bII-V','i-bVI-V-i','i-bII-i'],Chinese:['I-ii-V-I','I-V-vi-I','i-bIII-iv-i','I-IV-V-I','i-bVII-i'],Indian:['I-bII-I','i-IV-i-bVII','I-IV-I-V','i-bVII-bVI-i','I-V-IV-I'],Japanese:['i-bII-v-i','i-bVI-bVII-i','I-ii-V-I','i-bIII-bVII-i','i-iv-bII-i'],Latin:['I-IV-V-IV','i-iv-V-i','I-V-vi-IV','i-bVII-bVI-V','I-vi-ii-V']},
 EDM:{House:['i-bVI-bIII-bVII','I-V-vi-IV','vi-IV-I-V','i-bVII-bVI-bVII','I-vi-IV-V'],Techno:['i-bVI-i-bVII','i-bII-i-bVII','i-iv-i-bVII','i-bIII-bVII-i','i-bVI-bVII-i'],Trance:['i-bVI-bIII-bVII','vi-IV-I-V','i-bVII-bVI-bIII','I-V-vi-IV','i-bIII-bVII-bVI'],Dubstep:['i-bVI-bVII-i','i-bII-bVI-V','i-bVII-bIII-bVI','i-iv-bVI-V','i-bVI-bIII-bVII'],'Future Bass':['I-iii-vi-IV','vi-IV-I-V','I-V-vi-IV','IV-V-iii-vi','I-vi-IV-V'],'Drum & Bass':['i-bVI-bIII-bVII','i-bVII-bVI-bVII','i-iv-bIII-bVII','vi-IV-I-V','i-bIII-bVI-bVII']},
 Metal:{Heavy:['i-bVI-bVII-i','i-bVII-bVI-V','i-bII-bVII-i','i-iv-bVI-V','i-bIII-bVII-i'],Thrash:['i-bII-i-bIII','i-bVII-bII-i','i-iv-bII-i','i-bVI-bVII-i','i-bIII-bII-i'],Doom:['i-bVI-bII-i','i-bVII-bVI-i','i-iv-bII-i','i-bIII-bII-i','i-bVI-bVII-V'],Metalcore:['i-bVI-bIII-bVII','i-bVII-bVI-bIII','i-iv-bVI-bVII','i-bIII-bVII-bVI','i-bVI-bVII-i'],Progressive:['i-bIII-IV-bVI','i-iv-bVII-bIII','i-bII-bVI-V','i-bVI-iv-V','i-bIII-bVII-IV']},
 Pop:{Contemporary:['I-V-vi-IV','vi-IV-I-V','I-vi-IV-V','IV-I-V-vi','I-iii-IV-V'],Ballad:['I-iii-IV-iv','I-V7-vi-IV','I-vi-ii-V','vi-IV-I-V','I-IV-iv-I'],Dance:['vi-IV-I-V','I-V-vi-IV','I-vi-IV-V','IV-V-iii-vi','i-bVI-bIII-bVII']},
 Rap:{'Hip Hop':['i-iv-v-i','i-bVI-bIII-bVII','i-bVII-bVI-bVII','i-bIII-iv-bVII','i-bVI-iv-V'],'Boom Bap':['i7-iv7-bVII7-bIIImaj7','i7-bVImaj7-iv7-V7','i7-bIIImaj7-iv7-bVII7','i7-iv7-i7-V7','i7-bVII7-bVImaj7-V7'],'G-Funk':['i7-IV7-i7-V7','i7-bVII7-IV7-i7','i9-IV9-bVII9-i9','i7-bIIImaj7-IV7-i7','i9-bVII9-iv9-V9'],Trap:['i-bVI-bIII-bVII','i-bVII-bVI-i','i-bII-bVI-V','i-iv-bVI-V','i-bIII-bVII-bVI'],Drill:['i-bII-bVI-V','i-bVII-bVI-V','i-bIII-bII-i','i-bVI-bVII-i','i-iv-bII-V'],'Lo-Fi':['i7-iv7-bVII7-bIIImaj7','Imaj7-iii7-vi7-ii7','ii7-V7-Imaj7-vi7','i9-bVImaj7-iv9-V7','Imaj7-vi7-ii7-V7'],Memphis:['i-bII-i-bVII','i-bVI-bVII-i','i-bIII-bII-i','i-iv-bII-i','i-bVII-bVI-V']},
 Rock:{Classic:['I-bVII-IV-I','I-IV-V-I','I-V-vi-IV','I-bIII-IV-I','i-bVII-bVI-bVII'],Alternative:['I-iii-IV-iv','i-bIII-bVII-IV','I-V-IV-iv','i-bVI-bIII-bVII','I-bVII-IV-I'],Punk:['I-IV-V-IV','I-V-IV-I','I-bVII-IV-I','vi-IV-I-V','I-IV-I-V'],Grunge:['i-bVI-bIII-bVII','I-bIII-bVII-IV','i-bVII-bVI-i','I-bVII-IV-I','i-bII-bVII-i'],'Hard Rock':['i-bVII-IV-i','I-bVII-IV-I','i-bVI-bVII-i','I-IV-bVII-I','i-bIII-IV-bVII'],Progressive:['i-bIII-IV-bVI','I-iii-IV-bVI','i-iv-bVII-bIII','I-bVII-ii-IV','i-bII-bVI-V']}
};
const SCALES={
 'Major Scale (Ionian Mode)':[0,2,4,5,7,9,11],'Natural Minor Scale (Aeolian Mode)':[0,2,3,5,7,8,10],'Dorian Mode':[0,2,3,5,7,9,10],'Phrygian Mode':[0,1,3,5,7,8,10],'Lydian Mode':[0,2,4,6,7,9,11],'Mixolydian Mode':[0,2,4,5,7,9,10],'Locrian Mode':[0,1,3,5,6,8,10],'Harmonic Minor Scale':[0,2,3,5,7,8,11],'Melodic Minor Scale':[0,2,3,5,7,9,11],'Major Pentatonic Scale':[0,2,4,7,9],'Minor Pentatonic Scale':[0,3,5,7,10],'Blues Scale':[0,3,5,6,7,10],'Major Blues Scale':[0,2,3,4,7,9],'Minor Blues Scale':[0,3,5,6,7,10],'Chromatic Scale':[0,1,2,3,4,5,6,7,8,9,10,11],'Whole-Tone Scale':[0,2,4,6,8,10],'Diminished Scale (Octatonic)':[0,2,3,5,6,8,9,11],'Altered Scale':[0,1,3,4,6,8,10],'Phrygian Dominant':[0,1,4,5,7,8,10],'Double Harmonic Major':[0,1,4,5,7,8,11],'Insen Scale':[0,1,5,7,10],'Hirajoshi Scale':[0,2,3,7,8],'Bebop Dominant':[0,2,4,5,7,9,10,11],'Bebop Major':[0,2,4,5,7,8,9,11],'Neapolitan Major':[0,1,3,5,7,9,11],'Neapolitan Minor':[0,1,3,5,7,8,11],'Hungarian Minor':[0,2,3,6,7,8,11],'Persian Scale':[0,1,4,5,6,8,11],'Hijaz Scale':[0,1,4,5,7,8,10],'Yo Scale':[0,2,5,7,9],'Kumoi Scale':[0,2,3,7,9]};
// Diatonic degree positions used only for conventional note spelling. The
// semitone arrays above remain the pitch source of truth; these degree maps make
// names read as musicians expect (C Altered = C Db Eb Fb Gb Ab Bb, etc.).
const SCALE_DEGREES={
 'Major Scale (Ionian Mode)':[1,2,3,4,5,6,7],
 'Natural Minor Scale (Aeolian Mode)':[1,2,3,4,5,6,7],
 'Dorian Mode':[1,2,3,4,5,6,7],'Phrygian Mode':[1,2,3,4,5,6,7],'Lydian Mode':[1,2,3,4,5,6,7],
 'Mixolydian Mode':[1,2,3,4,5,6,7],'Locrian Mode':[1,2,3,4,5,6,7],
 'Harmonic Minor Scale':[1,2,3,4,5,6,7],'Melodic Minor Scale':[1,2,3,4,5,6,7],
 'Major Pentatonic Scale':[1,2,3,5,6],'Minor Pentatonic Scale':[1,3,4,5,7],
 'Blues Scale':[1,3,4,5,5,7],'Major Blues Scale':[1,2,3,3,5,6],'Minor Blues Scale':[1,3,4,5,5,7],
 'Whole-Tone Scale':[1,2,3,4,5,6],'Diminished Scale (Octatonic)':[1,2,3,4,5,6,6,7],
 'Altered Scale':[1,2,3,4,5,6,7],'Phrygian Dominant':[1,2,3,4,5,6,7],'Double Harmonic Major':[1,2,3,4,5,6,7],
 'Insen Scale':[1,2,4,5,7],'Hirajoshi Scale':[1,2,3,5,6],
 'Bebop Dominant':[1,2,3,4,5,6,7,7],'Bebop Major':[1,2,3,4,5,6,6,7],
 'Neapolitan Major':[1,2,3,4,5,6,7],'Neapolitan Minor':[1,2,3,4,5,6,7],
 'Hungarian Minor':[1,2,3,4,5,6,7],'Persian Scale':[1,2,3,4,5,6,7],'Hijaz Scale':[1,2,3,4,5,6,7],
 'Yo Scale':[1,2,4,5,6],'Kumoi Scale':[1,2,3,5,6]
};
const LETTERS=['C','D','E','F','G','A','B'],NATURAL_PC={C:0,D:2,E:4,F:5,G:7,A:9,B:11};
function spelledPitch(root,degree,pc){
 const tonicLetter=String(root||'C')[0]?.toUpperCase(),start=LETTERS.indexOf(tonicLetter);if(start<0)return N[(pc+120)%12];
 const letter=LETTERS[(start+Math.max(0,Number(degree||1)-1))%7],natural=NATURAL_PC[letter],diff=((pc-natural+18)%12)-6;
 if(diff===0)return letter;if(diff===1)return letter+'#';if(diff===-1)return letter+'b';
 // Keep CRP insertable in extreme theoretical keys that would require double
 // accidentals; the pitch remains exact even when the display is enharmonic.
 return N[(pc+120)%12];
}
let activeScale=null; const favKey='scale-rider-favorites-v1';
const ALL_ROOTS=[...N];
const favs=()=>{try{return JSON.parse(localStorage.getItem(favKey)||'{}')}catch{return{}}};
const saveFavs=x=>localStorage.setItem(favKey,JSON.stringify(x));
// Scale Rider intentionally keys off the visible CRP Key window only. When that
// field is blank we browse all roots instead of silently inheriting CRP's C fallback.
function key(){return window.CRPCore?.enteredSongKey||null}
function formulaMinor(formula){
 const romans=String(formula||'').split('-').map(t=>String(t).match(/^(?:b|#)?(VII|VI|IV|III|II|V|I|vii|vi|iv|iii|ii|v|i)/)?.[1]).filter(Boolean);
 // The tonic symbol determines the key family. A progression may begin on vi
 // or ii and still be a major-key progression (vi-IV-I-V, ii-V-I, etc.).
 if(romans.includes('i'))return true;
 if(romans.includes('I'))return false;
 return false;
}
function displayKey(k){return `${k.root}${k.minor?' minor':' major'}`}
function romanQuality(roman,suffix=''){const minor=roman===roman.toLowerCase(),s=String(suffix||'');if(!s)return minor?'m':'';if(!minor)return s;if(/^maj/i.test(s))return 'mMaj'+s.slice(3);if(/^m/i.test(s))return s;return 'm'+s;}
function degreeChord(token,k){
 const m=String(token||'').match(/^(b|#)?(VII|VI|IV|III|II|V|I|vii|vi|iv|iii|ii|v|i)(.*)$/);if(!m)return null;
 const acc=m[1]==='b'?-1:m[1]==='#'?1:0,roman=m[2],suffix=m[3]||'',degree={I:0,II:1,III:2,IV:3,V:4,VI:5,VII:6}[roman.toUpperCase()];
 if(degree==null||!(k?.root in NI))return null;
 const base=[0,2,4,5,7,9,11][degree],pc=(NI[k.root]+base+acc+120)%12,root=spelledPitch(k.root,degree+1,pc);
 return root+romanQuality(roman,suffix);
}
function resolve(formula,k){const tokens=String(formula||'').split('-').filter(Boolean),chords=tokens.map(t=>degreeChord(t,k));return chords.length===tokens.length&&chords.every(Boolean)?chords:[]}
function variants(formulas){const out=[];for(const f of formulas){out.push({formula:f,label:'Core'});if(!/[0-9]/.test(f)){out.push({formula:f.replace(/\bI\b/g,'Imaj7').replace(/\bIV\b/g,'IVmaj7').replace(/\bi\b/g,'i7').replace(/\biv\b/g,'iv7').replace(/\bV\b/g,'V7'),label:'7th color'});out.push({formula:f.replace(/\bI\b/g,'Iadd9').replace(/\bi\b/g,'i9'),label:'Color'});}}return out}
function layer(title,body,onBack=null){document.querySelector('.sr-layer')?.remove();const l=document.createElement('div');l.className='sr-layer';l.innerHTML=`<section class="sr-panel"><header class="sr-head"><h2>${title}</h2><div class="sr-head-actions">${onBack?'<button class="sr-back" type="button" aria-label="Back" title="Back">←</button>':''}<button class="sr-close" type="button" aria-label="Close" title="Close">×</button></div></header>${body}</section>`;document.body.appendChild(l);l.querySelector('.sr-close').onclick=()=>l.remove();const back=l.querySelector('.sr-back');if(back)back.onclick=onBack;l.onclick=e=>{if(e.target===l)l.remove()};return l}
function genrePicker(){const names=Object.keys(GENRES).sort();const l=layer('Scale Rider — Choose Genre',`<div class="sr-toolbar"><button id="srFav" class="sr-action">★ Favorites</button><button id="srScales" class="sr-action">Scales</button></div><div class="sr-grid">${names.map(g=>`<button class="sr-choice" data-g="${g}">${g}</button>`).join('')}</div>`);l.querySelectorAll('[data-g]').forEach(b=>b.onclick=()=>subPicker(b.dataset.g));l.querySelector('#srFav').onclick=()=>favoritesPage(()=>genrePicker());l.querySelector('#srScales').onclick=()=>scalesPage(()=>genrePicker())}
function subPicker(g){const subs=Object.keys(GENRES[g]).sort();const l=layer(`${g} — Choose Style`,`<div class="sr-grid">${subs.map(x=>`<button class="sr-choice" data-s="${x}">${x}</button>`).join('')}</div>`,()=>genrePicker());l.querySelectorAll('[data-s]').forEach(b=>b.onclick=()=>progressionsPage(g,b.dataset.s))}
function progressionId(g,s,f){return `${g}|${s}|${f}`}
function progressionKeys(item){const selected=key();if(selected)return[selected];const minor=formulaMinor(item.formula);return ALL_ROOTS.map(root=>({root,minor}))}
function progressionRow(g,s,it,k,F,onFavorite){const chords=resolve(it.formula,k),id=progressionId(g,s,it.formula),row=document.createElement('div');row.className='sr-prog';row.innerHTML=`<button class="sr-prog-main" data-add><div class="sr-prog-chords">${chords.join(' • ')}</div><div class="sr-prog-meta">${displayKey(k)} • ${it.formula} • ${it.label}</div></button><button class="sr-icon" data-play title="Audition full progression" aria-label="Audition full progression">▶</button><button class="sr-icon sr-star ${F[id]?'is-fav':''}" data-star title="Favorite" aria-label="Favorite">${F[id]?'★':'☆'}</button>`;row.querySelector('[data-add]').onclick=()=>{const hadKey=!!key(),ok=window.CRPCore.addProgressionLine(chords,k);if(ok){window.CRPCore.status(`${g} • ${s} • ${displayKey(k)} progression added as a new line.`);if(!hadKey&&key())setTimeout(()=>progressionsPage(g,s),0)}};row.querySelector('[data-play]').onclick=()=>window.CRPCore.auditionProgression(chords);row.querySelector('[data-star]').onclick=()=>{const x=favs();if(x[id])delete x[id];else x[id]={g,s,f:it.formula};saveFavs(x);onFavorite?.()};return row}
function progressionsPage(g,s){const selected=key(),items=variants(GENRES[g][s]);const note=selected?`${displayKey(selected)} • Tap the progression to add it as a new CRP line. ▶ auditions every chord in order.`:'No Key selected • Showing this style in every key. Tap a progression to add it and set that key. ▶ auditions every chord in order.';const l=layer(`${g} • ${s}`,`<div class="sr-toolbar"><button id="srFav">★ Favorites</button><button id="srScales">Scales</button></div><p class="subtle">${note}</p><div class="sr-prog-list"></div>`,()=>subPicker(g)),box=l.querySelector('.sr-prog-list');
 const render=()=>{const F=favs();box.innerHTML='';if(selected){items.forEach(it=>box.appendChild(progressionRow(g,s,it,selected,F,render)));return;}ALL_ROOTS.forEach(root=>{const h=document.createElement('h3');h.className='sr-key-group-title';h.textContent=root;box.appendChild(h);items.forEach(it=>{const kk={root,minor:formulaMinor(it.formula)};box.appendChild(progressionRow(g,s,it,kk,F,render))})});};render();l.querySelector('#srFav').onclick=()=>favoritesPage(()=>progressionsPage(g,s));l.querySelector('#srScales').onclick=()=>scalesPage(()=>progressionsPage(g,s))}
function favoritesPage(onBack=()=>genrePicker()){const F=favs(),items=Object.values(F),selected=key(),groups={};items.forEach(x=>(groups[x.g]??=[]).push(x));const l=layer('★ Scale Rider Favorites',`<div class="sr-toolbar"><button id="srGenres">Genres</button><button id="srScales">Scales</button></div><p class="subtle">${selected?`${displayKey(selected)} • Favorites are narrowed to the selected key.`:'No Key selected • Favorites are shown in every key.'}</p><div id="srFavList"></div>`,onBack),box=l.querySelector('#srFavList');if(!items.length)box.innerHTML='<p>No favorites yet. Tap ☆ beside any progression to save it here.</p>';Object.keys(groups).sort().forEach(g=>{const h=document.createElement('h3');h.className='sr-genre-title';h.textContent=g;box.appendChild(h);groups[g].sort((a,b)=>a.s.localeCompare(b.s)).forEach(x=>{const it={formula:x.f,label:x.s};const keys=selected?[selected]:ALL_ROOTS.map(root=>({root,minor:formulaMinor(x.f)}));keys.forEach(kk=>{const chords=resolve(x.f,kk),r=document.createElement('div');r.className='sr-prog';r.innerHTML=`<button class="sr-prog-main"><div class="sr-prog-chords">${chords.join(' • ')}</div><div class="sr-prog-meta">${displayKey(kk)} • ${x.s} • ${x.f}</div></button><button class="sr-icon" title="Audition full progression" aria-label="Audition full progression">▶</button><button class="sr-icon sr-star is-fav" title="Remove favorite" aria-label="Remove favorite">★</button>`;r.children[0].onclick=()=>{const hadKey=!!key(),ok=window.CRPCore.addProgressionLine(chords,kk);if(ok&&!hadKey&&key())setTimeout(()=>favoritesPage(onBack),0)};r.children[1].onclick=()=>window.CRPCore.auditionProgression(chords);r.children[2].onclick=()=>{const z=favs();delete z[progressionId(x.g,x.s,x.f)];saveFavs(z);favoritesPage(onBack)};box.appendChild(r)})})});l.querySelector('#srGenres').onclick=genrePicker;l.querySelector('#srScales').onclick=()=>scalesPage(()=>favoritesPage(onBack))}
function parseKey(raw){const m=String(raw).trim().replace(/♭/g,'b').replace(/♯/g,'#').match(/^([A-Ga-g])([#b]?)\s*(m|minor)?$/i);if(!m)return null;const root=m[1].toUpperCase()+m[2];return root in NI?{root,minor:!!m[3]}:null}
function scaleNotes(root,ints,name=''){
 const pcs=ints.map(i=>(NI[root]+i+120)%12),degrees=SCALE_DEGREES[name];
 if(Array.isArray(degrees)&&degrees.length===pcs.length)return pcs.map((pc,i)=>spelledPitch(root,degrees[i],pc));
 return pcs.map(pc=>N[pc]);
}
function applyScale(name,k){activeScale={name,root:k.root,intervals:[...SCALES[name]]};renderActive();window.dispatchEvent(new CustomEvent('scale-rider-change',{detail:activeScale}));window.CRPCore?.scheduleAutoSave?.();document.querySelector('.sr-layer')?.remove();window.CRPCore?.status?.(`${k.root} ${name} is active for Scale Rider notes.`)}
function scalesPage(onBack=()=>genrePicker()){const selected=key(),initial=selected?`${selected.root}${selected.minor?'m':''}`:'';const l=layer('Scale Rider — Scales',`<div class="sr-toolbar"><button id="srGenres">Progressions</button><button id="srFav">★ Favorites</button></div><div class="sr-keybox"><label>Scale key <input id="srScaleKey" value="${initial}" placeholder="All keys" aria-label="Scale key"></label><span class="subtle">${selected?'Showing the selected song key. Clear the field to browse every key.':'No Key selected — showing every key. Enter a key here to narrow the scale list.'}</span></div><div class="sr-scale-list"></div>`,onBack),box=l.querySelector('.sr-scale-list'),input=l.querySelector('#srScaleKey');const draw=()=>{const raw=input.value.trim(),manual=parseKey(raw);box.innerHTML='';if(raw&&!manual){box.innerHTML='<p class="subtle">Enter a valid key such as C, F#, Bb, Am, or F#m.</p>';return;}const roots=manual?[manual.root]:ALL_ROOTS;roots.forEach(root=>{const h=document.createElement('h3');h.className='sr-scale-key-title';h.textContent=root;box.appendChild(h);Object.entries(SCALES).forEach(([name,ints])=>{const b=document.createElement('button');b.className='sr-scale-card';b.innerHTML=`<strong>${root} ${name}</strong><span>${scaleNotes(root,ints,name).join(' • ')}</span>`;b.onclick=()=>applyScale(name,{root,minor:false});box.appendChild(b)})})};input.oninput=draw;draw();l.querySelector('#srGenres').onclick=genrePicker;l.querySelector('#srFav').onclick=()=>favoritesPage(()=>scalesPage(onBack))}
function renderActive(){
 const wrap=document.getElementById('scaleRiderActive'),title=document.getElementById('scaleRiderActiveTitle'),box=document.getElementById('scaleRiderActiveNotes');if(!wrap||!title||!box)return;
 if(!activeScale){wrap.hidden=true;return}wrap.hidden=false;title.textContent=`${activeScale.root} ${activeScale.name}`;
 const notes=scaleNotes(activeScale.root,activeScale.intervals,activeScale.name),noteMode=window.CRPCore?.mode==='note';
 box.innerHTML=notes.map(n=>noteMode?`<button class="scale-rider-note chip" type="button" data-scale-note="${n}" title="Add ${n} to the selected line">${n}</button>`:`<span class="scale-rider-note">${n}</span>`).join('');
 if(noteMode)box.querySelectorAll('[data-scale-note]').forEach(b=>b.addEventListener('click',()=>window.CRPCore?.addScaleNote?.(b.dataset.scaleNote)));
}
function auditCatalog(){
 const problems=[],core=window.CRPCore,total={formulas:0,progressions:0,scales:0};
 Object.entries(GENRES).forEach(([g,styles])=>{
   Object.entries(styles).forEach(([st,formulas])=>{
     variants(formulas).forEach(it=>{
       total.formulas++;
       ALL_ROOTS.forEach(root=>{
         total.progressions++;
         const k={root,minor:formulaMinor(it.formula)},tokens=it.formula.split('-').filter(Boolean),chords=resolve(it.formula,k);
         if(chords.length!==tokens.length){problems.push(`${g}/${st}: ${it.formula} resolved ${chords.length}/${tokens.length}`);return;}
         const check=core?.validateChordSequence?.(chords);if(check&&!check.valid)problems.push(`${g}/${st}: ${it.formula} unsupported ${check.invalid.join(', ')}`);
       });
     });
   });
 });
 Object.entries(SCALES).forEach(([name,ints])=>{
   total.scales++;const unique=new Set(ints);if(!ints.length||unique.size!==ints.length||ints.some(n=>!Number.isInteger(n)||n<0||n>11))problems.push(`Scale intervals invalid: ${name}`);
   ALL_ROOTS.forEach(root=>{const notes=scaleNotes(root,ints,name);if(notes.length!==ints.length||notes.some(n=>core?.validateNote&&!core.validateNote(n)))problems.push(`Scale notes invalid: ${root} ${name}`)});
 });
 return {ok:problems.length===0,problems,total};
}
// Scale selection belongs to the project, never to the browser/session. Older
// projects without scaleRider data intentionally load OFF.
try{localStorage.removeItem('scale-rider-active-v1')}catch{}
function normalizeProjectScale(saved){
 if(!saved?.name||!saved?.root||!SCALES[saved.name]||!(saved.root in NI))return null;
 return {name:saved.name,root:saved.root,intervals:[...SCALES[saved.name]]};
}
function loadProjectScale(project){activeScale=normalizeProjectScale(project?.scaleRider);renderActive();window.dispatchEvent(new CustomEvent('scale-rider-change',{detail:activeScale}));}
function clearProjectScale(){activeScale=null;renderActive();window.dispatchEvent(new CustomEvent('scale-rider-change',{detail:null}));}
window.ScaleRider={get active(){return activeScale},pitchClasses(){return activeScale?activeScale.intervals.map(i=>(NI[activeScale.root]+i)%12):null},open:genrePicker,renderActive,audit:auditCatalog,capture(){return activeScale?{name:activeScale.name,root:activeScale.root}:null},loadProject:loadProjectScale,newProject:clearProjectScale};
function boot(){document.querySelectorAll('#scaleRiderBtn,#leadScaleRiderBtn').forEach(btn=>btn.addEventListener('click',genrePicker));renderActive();setTimeout(()=>{const a=auditCatalog();if(!a.ok)console.warn('Scale Rider catalog audit failed',a);else console.info(`Scale Rider audit OK: ${a.total.progressions} resolved progressions, ${a.total.scales} scales.`)},0)} document.readyState==='loading'?document.addEventListener('DOMContentLoaded',boot):boot();
})();
