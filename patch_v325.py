from pathlib import Path
p=Path('/mnt/data/v325')
parts=p/'parts.js'; s=parts.read_text()
# vars
old="let voxBoxOpen=false,voxCropMode=false,voxSelected=null,voxSelections=[],voxInstrumentSelection=null,voxTargetPartId=null,voxClipboard=null,voxPlayheadBeat=0,voxRenderToken=0,voxMultiSelect=false,voxAutoScroll=true,voxShowInstrumentals=false,voxUndoStack=[],voxRedoStack=[];\n  const VOX_SNAP_KEY='crp-vox-snap-v1',VOX_RES_KEY='crp-vox-resolution-v1',VOX_AUTO_KEY='crp-vox-autoscroll-v1',VOX_INST_KEY='crp-vox-instrumentals-v1',VOX_TRANSPORT_POS_KEY='crp-vox-transport-pos-v1';"
new="let voxBoxOpen=false,voxCropMode=false,voxSelected=null,voxSelections=[],voxInstrumentSelection=null,voxInstrumentSelections=[],voxTargetPartId=null,voxClipboard=null,voxPlayheadBeat=0,voxRenderToken=0,voxMultiSelect=false,voxAutoScroll=true,voxShowInstrumentals=false,voxDrumMapOpen=false,voxToolMode='playhead',voxUndoStack=[],voxRedoStack=[];\n  const VOX_SNAP_KEY='crp-vox-snap-v1',VOX_RES_KEY='crp-vox-resolution-v1',VOX_AUTO_KEY='crp-vox-autoscroll-v1',VOX_INST_KEY='crp-vox-instrumentals-v1',VOX_TRANSPORT_POS_KEY='crp-vox-transport-pos-v1',VOX_TOOL_KEY='crp-vox-tool-v1',VOX_DRUM_MAP_KEY='crp-vox-drum-map-v1',VOX_TRACK_ORDER_KEY='crp-vox-track-order-v1';"
assert old in s
s=s.replace(old,new)
# helpers block replace set instrument selection + description
start=s.index('  function setVoxInstrumentSelection(sel)')
end=s.index('  function renderVoxInspector()', start)
block=r'''  function voxInstrumentSelectionList(){return Array.isArray(voxInstrumentSelections)?voxInstrumentSelections.filter(Boolean):[];}
  function voxInstrumentIsSelected(key){return voxInstrumentSelectionList().some(x=>String(x.key)===String(key));}
  function setVoxInstrumentSelection(sel,{add=false,toggle=false,render=true}={}){
    voxSelections=[];voxSelected=null;
    if(!sel){voxInstrumentSelections=[];voxInstrumentSelection=null;if(render){renderVoxSelectionClasses();renderVoxInspector();}return;}
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
    if(s.kind==='drum')return `Beat • ${s.name||s.drumId} at beat ${s.startBeat.toFixed(2)}`;
    if(s.kind==='lead')return `${s.part?.name||'Lead'} • ${midiName(s.event?.midi||60)} at beat ${s.startBeat.toFixed(2)}`;
    if(s.kind==='chord')return `${s.part?.name||'Chords'} • ${s.card?.value||'event'} at beat ${s.startBeat.toFixed(2)}`;
    return 'Instrument event';
  }
  function voxTrackTokenForPart(part){return part?`part:${part.id}`:'';}
  function readVoxTrackOrder(){try{const a=JSON.parse(localStorage.getItem(VOX_TRACK_ORDER_KEY)||'[]');return Array.isArray(a)?a:[];}catch{return [];}}
  function writeVoxTrackOrder(a){try{localStorage.setItem(VOX_TRACK_ORDER_KEY,JSON.stringify(a||[]));}catch{}}
  function applyVoxTrackOrder(){
    const host=$('voxTracks');if(!host)return;const rows=[...host.querySelectorAll(':scope > .vox-track-row[data-vox-track-key]')];if(rows.length<2)return;
    const saved=readVoxTrackOrder(),rank=new Map(saved.map((k,i)=>[String(k),i]));rows.sort((a,b)=>{const ak=String(a.dataset.voxTrackKey||''),bk=String(b.dataset.voxTrackKey||'');const ar=rank.has(ak)?rank.get(ak):1e6,br=rank.has(bk)?rank.get(bk):1e6;return ar-br;});rows.forEach(r=>host.appendChild(r));
  }
  function persistCurrentVoxTrackOrder(){const host=$('voxTracks');if(!host)return;writeVoxTrackOrder([...host.querySelectorAll(':scope > .vox-track-row[data-vox-track-key]')].map(r=>r.dataset.voxTrackKey));}
  function wireVoxTrackLongPress(label,row){
    if(!label||!row||label.dataset.reorderWired)return;label.dataset.reorderWired='1';label.classList.add('vox-track-reorder-handle');
    label.addEventListener('pointerdown',e=>{if(e.target.closest('input,button,select'))return;if(e.button!==undefined&&e.button!==0)return;let active=false,moved=false;const startY=e.clientY,pid=e.pointerId;const timer=setTimeout(()=>{active=true;row.classList.add('is-reordering');try{label.setPointerCapture(pid)}catch{};voxStatus('Track reorder — drag up or down, then release.');},420);
      const move=ev=>{if(Math.abs(ev.clientY-startY)>5)moved=true;if(!active)return;ev.preventDefault();const hit=document.elementsFromPoint?.(ev.clientX,ev.clientY)?.find(x=>x.classList?.contains('vox-track-row')&&x.dataset?.voxTrackKey);if(hit&&hit!==row){const rr=hit.getBoundingClientRect();hit.parentNode.insertBefore(row,ev.clientY<rr.top+rr.height/2?hit:hit.nextSibling);}};
      const up=ev=>{clearTimeout(timer);label.removeEventListener('pointermove',move);label.removeEventListener('pointerup',up);label.removeEventListener('pointercancel',up);if(active){try{label.releasePointerCapture(pid)}catch{};row.classList.remove('is-reordering');persistCurrentVoxTrackOrder();voxStatus('Track order updated.');}else if(moved){/* short scroll/gesture: no reorder */}};
      label.addEventListener('pointermove',move,{passive:false});label.addEventListener('pointerup',up);label.addEventListener('pointercancel',up);
    });
  }
'''
s=s[:start]+block+s[end:]
# render selection classes function simple replace
old="""  function renderVoxSelectionClasses(){\n    document.querySelectorAll('.vox-event').forEach(el=>el.classList.toggle('is-selected',voxIsSelected(el.dataset.voxPartId,el.dataset.voxEventId)));\n    document.querySelectorAll('.vox-instrument-event').forEach(el=>el.classList.toggle('is-selected',!!voxInstrumentSelection&&el.dataset.voxKey===voxInstrumentSelection.key));\n  }"""
new="""  function renderVoxSelectionClasses(){\n    document.querySelectorAll('.vox-event').forEach(el=>el.classList.toggle('is-selected',voxIsSelected(el.dataset.voxPartId,el.dataset.voxEventId)));\n    document.querySelectorAll('.vox-instrument-event').forEach(el=>el.classList.toggle('is-selected',voxInstrumentIsSelected(el.dataset.voxKey)));\n  }"""
assert old in s;s=s.replace(old,new)
# clear selection include instrument arrays
old="function clearVoxSelection({render=true}={}){voxSelections=[];voxSelected=null;voxInstrumentSelection=null;if(render){renderVoxInspector();renderVoxSelectionClasses();}}"
new="function clearVoxSelection({render=true}={}){voxSelections=[];voxSelected=null;voxInstrumentSelections=[];voxInstrumentSelection=null;if(render){renderVoxInspector();renderVoxSelectionClasses();}}"
assert old in s;s=s.replace(old,new)
# render inspector inst use list
s=s.replace("const inst=voxInstrumentSelection;","const inst=voxInstrumentSelectionList()[0]||null,instList=voxInstrumentSelectionList();",1)
s=s.replace("`${instrumentalSelectionDescription()} • drag to move; Delete removes it.`","`${instrumentalSelectionDescription()} • drag to move/resize; Copy/Cut/Delete work on the selection.`",1)
# make label function update signature/add rowKey later handled by caller not function
# replace entire renderVoxInstrumentTracks and beginVoxInstrumentPointerEdit
start=s.index('  function renderVoxInstrumentTracks(')
end=s.index('  function renderVoxBox()',start)
newblock=r'''  function renderVoxDrumMap(tracks,width,ppb){
    if(!voxShowInstrumentals||!voxDrumMapOpen)return;const beat=window.CRPBeatMaker?.getBeat?.();if(!beat)return;
    const defs=window.CRPBeatMaker?.getDrumDefs?.()||[],res=[8,16,32,64].includes(+beat.resolution)?+beat.resolution:16,cols=Math.max(1,beat.bars*res),canonicalStep=64/res;
    const row=document.createElement('div');row.className='vox-track-row vox-drum-map-row';row.style.width=`${width}px`;row.dataset.voxTrackKey='drum-map';
    const label=document.createElement('div');label.className='vox-track-label vox-instrument-label';label.innerHTML='<strong>Drum Map</strong><span>Click cells to add/remove hits</span>';
    const lane=document.createElement('div');lane.className='vox-drum-map-lane';
    const grid=document.createElement('div');grid.className='vox-drum-map-grid';grid.style.setProperty('--vox-drum-cols',String(cols));
    for(const d of defs){const name=document.createElement('div');name.className='vox-drum-map-name';name.textContent=d.name;grid.appendChild(name);for(let c=0;c<cols;c++){const bar=Math.floor(c/res),local=c%res,step=local*canonicalStep,on=(beat.tracks?.[d.id]?.[bar]||[]).some(x=>Number(x)===step),cell=document.createElement('button');cell.type='button';cell.className='vox-drum-cell'+(on?' on':'')+(local===0?' bar-start':'');cell.title=`${d.name} • Bar ${bar+1} • ${(local*4/res+1).toFixed(2)} beat`;cell.onclick=e=>{e.stopPropagation();voxCheckpoint();const b=window.CRPBeatMaker?.getBeat?.();if(!b)return;const arr=b.tracks[d.id][bar]||[],has=arr.some(x=>Number(x)===step);b.tracks[d.id][bar]=has?arr.filter(x=>Number(x)!==step):[...new Set([...arr,step])].sort((a,z)=>a-z);window.CRPBeatMaker.setBeat(b,{persist:true});persistVoxEdits();renderParts();renderVoxBox();voxStatus(`${d.name} ${has?'removed':'added'} in Drum Map.`);};grid.appendChild(cell);}}
    lane.appendChild(grid);row.append(label,lane);tracks.appendChild(row);
  }
  function instrumentClickSelection(sel,evEl,e){
    e.stopPropagation();if(evEl.__voxDragged){evEl.__voxDragged=false;return;}if(evEl.__voxPointerSelected){evEl.__voxPointerSelected=false;renderVoxSelectionClasses();return;}const add=voxMultiSelect||e.ctrlKey||e.metaKey||e.shiftKey;setVoxInstrumentSelection(sel,{add,toggle:add});
  }
  function appendInstrumentHandles(ev,sel){
    if(sel.kind!=='lead'&&sel.kind!=='chord')return;const lh=document.createElement('span'),rh=document.createElement('span');lh.className='vox-inst-handle left';rh.className='vox-inst-handle right';lh.title='Drag start edge';rh.title='Drag end edge';lh.onpointerdown=e=>beginVoxInstrumentPointerEdit(e,sel,ev,'trim-left');rh.onpointerdown=e=>beginVoxInstrumentPointerEdit(e,sel,ev,'trim-right');ev.append(lh,rh);
  }
  function renderVoxInstrumentTracks(tracks,width,ppb,clickBeat){
    if(!voxShowInstrumentals)return;
    const beat=window.CRPBeatMaker?.getBeat?.();
    if(beat){
      const row=document.createElement('div');row.className='vox-track-row vox-instrument-track';row.style.width=`${width}px`;row.dataset.voxKind='drum';row.dataset.voxTrackKey='beat';
      const hitCount=Object.values(beat.tracks||{}).reduce((n,bars)=>n+(bars||[]).slice(0,beat.bars).reduce((m,a)=>m+(a?.length||0),0),0);
      const label=makeVoxTrackLabel({name:'Beat',meta:`${beat.bars} bar${beat.bars===1?'':'s'} • ${hitCount} hits`,checked:beat.enabled,onChecked:on=>{voxCheckpoint();const b=window.CRPBeatMaker?.getBeat?.();if(b){b.enabled=on;window.CRPBeatMaker.setBeat(b,{persist:true});persistVoxEdits();renderVoxBox();}},kind:'drum'});
      const lane=document.createElement('div');lane.className='vox-track-lane vox-instrument-lane';lane.dataset.voxKind='drum';lane.onclick=e=>{if(e.target!==lane)return;if(voxToolMode==='playhead')voxSeekTo(clickBeat(e,lane),{manual:true});else clearVoxSelection();};
      const defs=new Map((window.CRPBeatMaker?.getDrumDefs?.()||[]).map(x=>[x.id,x.name]));
      for(const [drumId,bars] of Object.entries(beat.tracks||{}))for(let bar=0;bar<beat.bars;bar++)for(const step of (bars?.[bar]||[])){
        const startBeat=bar*4+Number(step)/16,key=`drum:${drumId}:${bar}:${step}`,ev=document.createElement('div');ev.className='vox-instrument-event vox-drum-event'+(voxInstrumentIsSelected(key)?' is-selected':'');ev.dataset.voxKey=key;ev.style.left=`${startBeat*ppb}px`;ev.style.width=`${Math.max(8,.16*ppb)}px`;ev.textContent=(defs.get(drumId)||drumId).replace(/\s+\d+$/,'');ev.title=`${defs.get(drumId)||drumId} • beat ${startBeat.toFixed(2)}`;
        const sel={kind:'drum',key,drumId,bar,step,startBeat,name:defs.get(drumId)||drumId};ev.onclick=e=>instrumentClickSelection(sel,ev,e);ev.onpointerdown=e=>beginVoxInstrumentPointerEdit(e,sel,ev,'move');lane.appendChild(ev);
      }
      row.append(label,lane);tracks.appendChild(row);wireVoxTrackLongPress(label,row);
    }
    for(const part of parts.filter(p=>p.type==='chord')){
      const items=chordFlatItems(part);if(!items.length)continue;const row=document.createElement('div');row.className='vox-track-row vox-instrument-track';row.style.width=`${width}px`;row.dataset.voxKind='chord';row.dataset.voxPartId=part.id;row.dataset.voxTrackKey=voxTrackTokenForPart(part);
      const label=makeVoxTrackLabel({name:part.name,meta:`Chord/Note • ${items.length} events`,checked:part.enabled,onChecked:on=>{voxCheckpoint();part.enabled=on;persistVoxEdits();renderParts();renderVoxBox();},kind:'chord'});
      const lane=document.createElement('div');lane.className='vox-track-lane vox-instrument-lane';lane.dataset.voxKind='chord';lane.dataset.voxPartId=part.id;lane.onclick=e=>{if(e.target!==lane)return;if(voxToolMode==='playhead')voxSeekTo(clickBeat(e,lane),{manual:true});else clearVoxSelection();};
      for(const item of items){const key=`chord:${part.id}:${item.flatIndex}`,ev=document.createElement('div');ev.className='vox-instrument-event vox-chord-event'+(voxInstrumentIsSelected(key)?' is-selected':'');ev.dataset.voxKey=key;ev.style.left=`${item.startBeat*ppb}px`;ev.style.width=`${Math.max(26,item.dur*ppb)}px`;ev.textContent=String(item.card?.value||'Chord');ev.title=`${part.name} • ${item.card?.value||'event'} • beat ${item.startBeat.toFixed(2)}`;const sel={kind:'chord',key,part,card:item.card,startBeat:item.startBeat,dur:item.dur,flatIndex:item.flatIndex};ev.onclick=e=>instrumentClickSelection(sel,ev,e);ev.onpointerdown=e=>{if(e.target.classList.contains('vox-inst-handle'))return;beginVoxInstrumentPointerEdit(e,sel,ev,'move');};appendInstrumentHandles(ev,sel);lane.appendChild(ev);}row.append(label,lane);tracks.appendChild(row);wireVoxTrackLongPress(label,row);
    }
    for(const part of parts.filter(p=>p.type==='lead')){
      const row=document.createElement('div');row.className='vox-track-row vox-instrument-track';row.style.width=`${width}px`;row.dataset.voxKind='lead';row.dataset.voxPartId=part.id;row.dataset.voxTrackKey=voxTrackTokenForPart(part);
      const label=makeVoxTrackLabel({name:part.name,meta:`Lead/Bass • ${part.events?.length||0} notes`,checked:part.enabled,onChecked:on=>{voxCheckpoint();part.enabled=on;persistVoxEdits();renderParts();renderVoxBox();},kind:'lead'});
      const lane=document.createElement('div');lane.className='vox-track-lane vox-instrument-lane';lane.dataset.voxKind='lead';lane.dataset.voxPartId=part.id;lane.onclick=e=>{if(e.target!==lane)return;if(voxToolMode==='playhead')voxSeekTo(clickBeat(e,lane),{manual:true});else clearVoxSelection();};
      const stepBeats=4/part.resolution;for(const event of part.events||[]){const startBeat=event.step*stepBeats,dur=Math.max(stepBeats,leadDurationSteps(event)*stepBeats),key=`lead:${part.id}:${event.step}:${event.midi}`,ev=document.createElement('div');ev.className='vox-instrument-event vox-lead-event'+(voxInstrumentIsSelected(key)?' is-selected':'');ev.dataset.voxKey=key;ev.style.left=`${startBeat*ppb}px`;ev.style.width=`${Math.max(22,dur*ppb)}px`;ev.textContent=midiName(event.midi);ev.title=`${part.name} • ${midiName(event.midi)} • beat ${startBeat.toFixed(2)}`;const sel={kind:'lead',key,part,event,startBeat,dur};ev.onclick=e=>instrumentClickSelection(sel,ev,e);ev.onpointerdown=e=>{if(e.target.classList.contains('vox-inst-handle'))return;beginVoxInstrumentPointerEdit(e,sel,ev,'move');};appendInstrumentHandles(ev,sel);lane.appendChild(ev);}row.append(label,lane);tracks.appendChild(row);wireVoxTrackLongPress(label,row);
    }
    renderVoxDrumMap(tracks,width,ppb);
  }
  function beginVoxInstrumentPointerEdit(e,sel,el,mode='move'){
    if(e.button!==undefined&&e.button!==0)return;e.preventDefault();e.stopPropagation();disableVoxAutoScroll();const add=voxMultiSelect||e.ctrlKey||e.metaKey||e.shiftKey;
    if(!voxInstrumentIsSelected(sel.key)){setVoxInstrumentSelection(sel,{add,render:false});el.classList.add('is-selected');el.__voxPointerSelected=true;}
    voxCheckpoint();const ppb=voxPpb(),startX=e.clientX,orig=sel.startBeat,origDur=Math.max(.001,Number(sel.dur)||.25),origEnd=orig+origDur;let current=orig,moved=false,targetLeadPart=sel.part;
    const moving=mode==='move'?voxInstrumentSelectionList().slice():[sel];const starts=new Map(moving.map(x=>[String(x.key),Number(x.startBeat)||0]));el.classList.add('is-dragging');if(mode!=='move')el.classList.add('is-trimming');try{el.setPointerCapture(e.pointerId);}catch{}
    const minBeat=voxSnapEnabled()?voxBeatStep():.03;
    const move=ev=>{ev.preventDefault();const dx=(ev.clientX-startX)/ppb;if(Math.abs(ev.clientX-startX)>3)moved=true;
      if(mode==='move'){
        current=quantizeVoxBeat(orig+dx);const delta=current-orig;
        for(const item of moving){const node=document.querySelector(`.vox-instrument-event[data-vox-key="${CSS.escape(String(item.key))}"]`),next=Math.max(0,quantizeVoxBeat((starts.get(String(item.key))||0)+delta));if(node)node.style.left=`${next*ppb}px`;item.__voxPreviewBeat=next;}
        if(moving.length===1&&sel.kind==='lead'){const lane=findVoxLaneAt(ev.clientX,ev.clientY);if(lane?.dataset.voxKind==='lead'){const p=parts.find(x=>x.type==='lead'&&String(x.id)===String(lane.dataset.voxPartId));if(p)targetLeadPart=p;}}
      }else if(sel.kind==='lead'){
        const p=sel.part,stepBeats=4/p.resolution;if(mode==='trim-right'){const targetEnd=Math.max(orig+minBeat,quantizeVoxBeat(origEnd+dx)),dur=targetEnd-orig;sel.event.durationSteps=Math.max(1,Math.round(dur/stepBeats));el.style.width=`${Math.max(22,sel.event.durationSteps*stepBeats*ppb)}px`;}
        else{const targetStart=Math.max(0,Math.min(origEnd-minBeat,quantizeVoxBeat(orig+dx))),endStep=Math.round(origEnd/stepBeats),newStep=Math.max(0,Math.round(targetStart/stepBeats));sel.event.step=newStep;sel.event.durationSteps=Math.max(1,endStep-newStep);el.style.left=`${newStep*stepBeats*ppb}px`;el.style.width=`${Math.max(22,sel.event.durationSteps*stepBeats*ppb)}px`;}
      }else if(sel.kind==='chord'){
        const items=chordFlatItems(sel.part),ix=items.findIndex(x=>x.card===sel.card),item=items[ix];if(!item)return;if(mode==='trim-right'){const targetEnd=Math.max(item.startBeat+minBeat,quantizeVoxBeat(item.startBeat+origDur+dx));sel.card.durationBeats=Math.max(minBeat,targetEnd-item.startBeat);el.style.width=`${Math.max(26,sel.card.durationBeats*ppb)}px`;}
        else if(ix>0){const prev=items[ix-1],end=item.startBeat+origDur,target=Math.max(prev.startBeat+minBeat,Math.min(end-minBeat,quantizeVoxBeat(item.startBeat+dx)));prev.card.durationBeats=Math.max(minBeat,target-prev.startBeat);sel.card.durationBeats=Math.max(minBeat,end-target);el.style.left=`${target*ppb}px`;el.style.width=`${Math.max(26,sel.card.durationBeats*ppb)}px`;}
      }};
    const up=ev=>{try{el.releasePointerCapture(ev.pointerId)}catch{};el.removeEventListener('pointermove',move);el.removeEventListener('pointerup',up);el.removeEventListener('pointercancel',up);el.classList.remove('is-dragging','is-trimming');el.__voxDragged=moved;if(!moved){voxUndoStack.pop();updateVoxHistoryButtons();return;}
      if(mode==='move')for(const item of moving){const targetBeat=Number(item.__voxPreviewBeat);delete item.__voxPreviewBeat;if(!Number.isFinite(targetBeat))continue;if(item.kind==='drum'){const b=window.CRPBeatMaker?.getBeat?.();if(b){b.tracks[item.drumId][item.bar]=(b.tracks[item.drumId][item.bar]||[]).filter(x=>Number(x)!==Number(item.step));const abs=Math.max(0,Math.min(16*64-1,Math.round(targetBeat*16))),bar=Math.floor(abs/64),step=abs%64;b.bars=Math.max(b.bars,Math.min(16,bar+1));b.tracks[item.drumId][bar]=[...new Set([...(b.tracks[item.drumId][bar]||[]),step])].sort((a,c)=>a-c);window.CRPBeatMaker.setBeat(b,{persist:true});}}
        else if(item.kind==='lead'&&item.part&&item.event){const src=item.part,dst=(moving.length===1?(targetLeadPart||src):src),srcStepBeats=4/src.resolution,durBeats=leadDurationSteps(item.event)*srcStepBeats;if(dst!==src)src.events=src.events.filter(x=>x!==item.event);const dstStepBeats=4/dst.resolution,totalSteps=dst.bars*dst.resolution,newEvent=dst===src?item.event:{...item.event};newEvent.step=Math.max(0,Math.min(totalSteps-1,Math.round(targetBeat/dstStepBeats)));newEvent.durationSteps=Math.max(1,Math.min(totalSteps-newEvent.step,Math.round(durBeats/dstStepBeats)));if(dst!==src)dst.events=normalizeLeadEvents([...(dst.events||[]),newEvent]);else dst.events=normalizeLeadEvents(dst.events);}
        else if(item.kind==='chord'&&item.part&&item.card){reorderChordCardToBeat(item.part,item.card,targetBeat);if(String(item.part.id)===String(loadedChordPartId))core.apply(item.part.data);}}
      if(mode!=='move'&&sel.kind==='chord'&&String(sel.part.id)===String(loadedChordPartId))core.apply(sel.part.data);
      voxInstrumentSelections=[];voxInstrumentSelection=null;persistVoxEdits();renderParts();renderVoxBox();voxStatus(mode==='move'?(moving.length>1?`${moving.length} instrument events moved.`:'Instrument event moved.'):'Instrument event resized.');};
    el.addEventListener('pointermove',move,{passive:false});el.addEventListener('pointerup',up,{passive:false});el.addEventListener('pointercancel',up,{passive:false});
  }
'''
s=s[:start]+newblock+s[end:]
# modify renderVoxBox ruler onclick and add track keys/reorder + multi click logic + apply order
s=s.replace("ruler.onclick=e=>{voxSeekTo(clickBeat(e,ruler),{manual:true});renderVoxInspector();};","ruler.onclick=e=>{if(voxToolMode==='playhead'){voxSeekTo(clickBeat(e,ruler),{manual:true});renderVoxInspector();}else voxStatus('Cursor mode — select or drag events. Switch to Playhead to locate playback.');};")
s=s.replace("const row=document.createElement('div');row.className='vox-track-row'+(String(part.id)===String(voxTargetPartId)?' is-target':'');row.style.width=`${width}px`;row.dataset.voxPartId=part.id;","const row=document.createElement('div');row.className='vox-track-row'+(String(part.id)===String(voxTargetPartId)?' is-target':'');row.style.width=`${width}px`;row.dataset.voxPartId=part.id;row.dataset.voxTrackKey=voxTrackTokenForPart(part);")
s=s.replace("label.onclick=()=>{voxTargetPartId=part.id;voxSelections=[];voxSelected=null;voxInstrumentSelection=null;renderVoxBox();};","label.onclick=()=>{voxTargetPartId=part.id;voxSelections=[];voxSelected=null;voxInstrumentSelections=[];voxInstrumentSelection=null;renderVoxBox();};")
s=s.replace("lane.onclick=e=>{if(e.target!==lane)return;voxTargetPartId=part.id;voxSelections=[];voxSelected=null;voxInstrumentSelection=null;voxSeekTo(clickBeat(e,lane),{manual:true});renderVoxBox();};","lane.onclick=e=>{if(e.target!==lane)return;voxTargetPartId=part.id;voxSelections=[];voxSelected=null;voxInstrumentSelections=[];voxInstrumentSelection=null;if(voxToolMode==='playhead')voxSeekTo(clickBeat(e,lane),{manual:true});renderVoxBox();};")
old="ev.onclick=e=>{e.stopPropagation();if(ev.__voxDragged){ev.__voxDragged=false;return;}const add=voxMultiSelect||e.ctrlKey||e.metaKey||e.shiftKey;voxSetSelection(part,event,{add,toggle:add});renderVoxBox();};"
new="ev.onclick=e=>{e.stopPropagation();if(ev.__voxDragged){ev.__voxDragged=false;return;}if(ev.__voxPointerSelected){ev.__voxPointerSelected=false;renderVoxSelectionClasses();renderVoxInspector();return;}const add=voxMultiSelect||e.ctrlKey||e.metaKey||e.shiftKey;voxSetSelection(part,event,{add,toggle:add});renderVoxBox();};"
assert old in s;s=s.replace(old,new)
s=s.replace("row.append(label,lane);tracks.appendChild(row);\n    }\n    inner.classList.toggle('has-crop-mode'","row.append(label,lane);tracks.appendChild(row);wireVoxTrackLongPress(label,row);\n    }\n    applyVoxTrackOrder();\n    inner.classList.toggle('has-crop-mode'",1)
# tool mode/drum button state in render near multi button line
old="if($('voxCropBtn'))$('voxCropBtn').classList.toggle('is-active',voxCropMode);if($('voxMultiSelectBtn')){$('voxMultiSelectBtn').classList.toggle('is-active',voxMultiSelect);$('voxMultiSelectBtn').setAttribute('aria-pressed',String(voxMultiSelect));}"
new="if($('voxCropBtn'))$('voxCropBtn').classList.toggle('is-active',voxCropMode);if($('voxMultiSelectBtn')){$('voxMultiSelectBtn').classList.toggle('is-active',voxMultiSelect);$('voxMultiSelectBtn').setAttribute('aria-pressed',String(voxMultiSelect));}if($('voxToolModeBtn')){$('voxToolModeBtn').textContent=voxToolMode==='cursor'?'Cursor':'Playhead';$('voxToolModeBtn').classList.toggle('is-active',voxToolMode==='playhead');$('voxToolModeBtn').setAttribute('aria-pressed',String(voxToolMode==='playhead'));}if($('voxDrumMapBtn')){$('voxDrumMapBtn').classList.toggle('is-active',voxDrumMapOpen);$('voxDrumMapBtn').setAttribute('aria-pressed',String(voxDrumMapOpen));}"
assert old in s;s=s.replace(old,new)
# beginVoxPointerEdit selection flag bug
old="if(!voxIsSelected(part.id,event.id)){voxSetSelection(part,event,{add,render:false});el.classList.add('is-selected');}"
new="if(!voxIsSelected(part.id,event.id)){voxSetSelection(part,event,{add,render:false});el.classList.add('is-selected');el.__voxPointerSelected=true;}"
assert old in s;s=s.replace(old,new)
# open vox init vars
s=s.replace("voxSelections=[];voxSelected=null;voxInstrumentSelection=null;voxCropMode=false;voxUndoStack=[];voxRedoStack=[];","voxSelections=[];voxSelected=null;voxInstrumentSelections=[];voxInstrumentSelection=null;voxCropMode=false;voxUndoStack=[];voxRedoStack=[];",1)
s=s.replace("voxShowInstrumentals=localStorage.getItem(VOX_INST_KEY)==='1';if($('voxShowInstrumentals'))$('voxShowInstrumentals').checked=voxShowInstrumentals;","voxShowInstrumentals=localStorage.getItem(VOX_INST_KEY)==='1';voxToolMode=localStorage.getItem(VOX_TOOL_KEY)||'playhead';voxDrumMapOpen=localStorage.getItem(VOX_DRUM_MAP_KEY)==='1';if($('voxShowInstrumentals'))$('voxShowInstrumentals').checked=voxShowInstrumentals;",1)
# wire show instrumentals clears array
s=s.replace("voxInstrumentSelection=null;renderVoxBox();voxStatus(voxShowInstrumentals?","voxInstrumentSelections=[];voxInstrumentSelection=null;renderVoxBox();voxStatus(voxShowInstrumentals?",1)
# add wire tool/drum after show instrumentals line
needle="if($('voxShowInstrumentals'))$('voxShowInstrumentals').onchange=e=>{voxShowInstrumentals=!!e.target.checked;try{localStorage.setItem(VOX_INST_KEY,voxShowInstrumentals?'1':'0')}catch{};voxInstrumentSelections=[];voxInstrumentSelection=null;renderVoxBox();voxStatus(voxShowInstrumentals?'Instrument tracks added to the timeline. Drag Beat, Chord/Note, and Lead/Bass events to edit timing.':'Instrument tracks hidden.');};"
assert needle in s
insert=needle+"\n    if($('voxDrumMapBtn'))$('voxDrumMapBtn').onclick=()=>{voxDrumMapOpen=!voxDrumMapOpen;try{localStorage.setItem(VOX_DRUM_MAP_KEY,voxDrumMapOpen?'1':'0')}catch{};renderVoxBox();voxStatus(voxDrumMapOpen?'Drum Map open — click cells to add/remove hits.':'Drum Map closed.');};\n    if($('voxToolModeBtn'))$('voxToolModeBtn').onclick=()=>{voxToolMode=voxToolMode==='cursor'?'playhead':'cursor';try{localStorage.setItem(VOX_TOOL_KEY,voxToolMode)}catch{};renderVoxBox();voxStatus(voxToolMode==='cursor'?'Cursor mode — select, multi-select, drag and resize events without moving playback.':'Playhead mode — click the ruler or empty lanes to locate playback; events remain draggable.');};"
s=s.replace(needle,insert)
# multi toggle better, clear instrument if off? keep selection
old="if($('voxMultiSelectBtn'))$('voxMultiSelectBtn').onclick=()=>{voxMultiSelect=!voxMultiSelect;if(!voxMultiSelect&&voxSelections.length>1)voxSelections=voxSelections.slice(0,1);voxSelected=voxSelections[0]||null;renderVoxBox();voxStatus(voxMultiSelect?'Multi Select on — tap vocal events to add/remove them from the selection.':'Multi Select off.');};"
new="if($('voxMultiSelectBtn'))$('voxMultiSelectBtn').onclick=()=>{voxMultiSelect=!voxMultiSelect;if(!voxMultiSelect){if(voxSelections.length>1)voxSelections=voxSelections.slice(0,1);if(voxInstrumentSelections.length>1)voxInstrumentSelections=voxInstrumentSelections.slice(0,1);}voxSelected=voxSelections[0]||null;voxInstrumentSelection=voxInstrumentSelections[0]||null;renderVoxBox();voxStatus(voxMultiSelect?'Multi Select on — tap events to add/remove them; drag any selected event to move the group.':'Multi Select off.');};"
assert old in s;s=s.replace(old,new)
# replace copy/delete instrument funcs with multi support
start=s.index('  function copyInstrumentSelection(cut=false)')
end=s.index('  function updateVoxFxFromUi(kind)',start)
block2=r'''  function copyInstrumentSelection(cut=false){
    const list=voxInstrumentSelectionList();if(!list.length)return false;const anchor=Math.min(...list.map(x=>Number(x.startBeat)||0));voxClipboard={kind:'instrument-group',items:list.map(s=>({kind:s.kind,deltaBeat:(Number(s.startBeat)||0)-anchor,drumId:s.drumId,name:s.name,sourcePartId:s.part?.id||null,event:s.event?clone(s.event):null,card:s.card?clone(s.card):null}))};if(cut)deleteSelectedVox();else{renderVoxInspector();voxStatus(`${list.length} instrument event${list.length===1?'':'s'} copied. Move the playhead, then Paste.`);}return true;
  }
  function copySelectedVox(cut=false){
    const selected=voxSelectionPairs();if(!selected.length){copyInstrumentSelection(cut);return;}const vocals=allVocalParts(),primary=selected[0],baseTrack=Math.max(0,vocals.indexOf(primary.part)),anchor=Math.min(...selected.map(x=>Number(x.event.startBeat)||0));voxClipboard={kind:'vocal',items:selected.map(({part,event})=>({event:clone(event),sourcePartId:part.id,deltaBeat:(Number(event.startBeat)||0)-anchor,trackOffset:vocals.indexOf(part)-baseTrack}))};
    if(cut){voxCheckpoint();for(const {part,event} of selected)part.voxEvents=(part.voxEvents||[]).filter(x=>x.id!==event.id);voxSelections=[];voxSelected=null;persistVoxEdits();renderVoxBox();voxStatus(`${selected.length} event${selected.length===1?'':'s'} cut. Choose a track/playhead position, then Paste.`);}else{renderVoxInspector();voxStatus(`${selected.length} event${selected.length===1?'':'s'} copied.`);}
  }
  function pasteOneInstrumentClip(clip,atBeat){
    if(clip.kind==='drum'){const b=window.CRPBeatMaker?.getBeat?.();if(!b)return;const abs=Math.max(0,Math.min(16*64-1,Math.round(quantizeVoxBeat(atBeat)*16))),bar=Math.floor(abs/64),step=abs%64;b.bars=Math.max(b.bars,Math.min(16,bar+1));b.tracks[clip.drumId][bar]=[...new Set([...(b.tracks[clip.drumId][bar]||[]),step])].sort((a,c)=>a-c);window.CRPBeatMaker.setBeat(b,{persist:true});}
    else if(clip.kind==='lead'){const p=parts.find(x=>x.type==='lead'&&String(x.id)===String(clip.sourcePartId))||parts.find(x=>x.type==='lead');if(!p)return;const stepBeats=4/p.resolution,e=clone(clip.event);e.step=Math.max(0,Math.min(p.bars*p.resolution-1,Math.round(quantizeVoxBeat(atBeat)/stepBeats)));p.events=normalizeLeadEvents([...(p.events||[]),e]);}
    else if(clip.kind==='chord'){const p=parts.find(x=>x.type==='chord'&&String(x.id)===String(clip.sourcePartId))||parts.find(x=>x.type==='chord');if(!p)return;const card=clone(clip.card),items=chordFlatItems(p);let idx=items.length;for(let i=0;i<items.length;i++){if(atBeat<items[i].startBeat+items[i].dur/2){idx=i;break;}}let remaining=idx,done=false;for(const row of p.data.rows){if(remaining<=row.length){row.splice(remaining,0,card);done=true;break;}remaining-=row.length;}if(!done&&(p.data.rows||[]).length)p.data.rows.at(-1).push(card);if(String(p.id)===String(loadedChordPartId))core.apply(p.data);}
  }
  function pasteInstrument(){const clip=voxClipboard;if(!clip||clip.kind==='vocal')return false;voxCheckpoint();if(clip.kind==='instrument-group'){for(const item of clip.items||[])pasteOneInstrumentClip(item,voxPlayheadBeat+(Number(item.deltaBeat)||0));}else pasteOneInstrumentClip(clip,voxPlayheadBeat);persistVoxEdits();renderParts();renderVoxBox();voxStatus('Instrument event selection pasted at the playhead.');return true;}
  function pasteVox(){if(!voxClipboard)return;if(voxClipboard.kind!=='vocal'){pasteInstrument();return;}const vocals=allVocalParts(),target=voxTargetPart();if(!target)return;voxCheckpoint();const base=Math.max(0,vocals.indexOf(target)),newSel=[];for(const item of voxClipboard.items||[]){const dest=vocals[Math.max(0,Math.min(vocals.length-1,base+(Number(item.trackOffset)||0)))]||target;const ev=normalizeVoxEvent({...clone(item.event),id:uid(),sourcePartId:item.event.sourcePartId||item.sourcePartId,startBeat:quantizeVoxBeat(voxPlayheadBeat+(Number(item.deltaBeat)||0))},dest);dest.voxEvents=dest.voxEvents||[];dest.voxEvents.push(ev);newSel.push({partId:dest.id,eventId:ev.id});}voxSelections=newSel;voxSelected=newSel[0]||null;voxInstrumentSelections=[];voxInstrumentSelection=null;persistVoxEdits();renderVoxBox();voxStatus(`Pasted ${newSel.length} event${newSel.length===1?'':'s'} at beat ${voxPlayheadBeat.toFixed(2)}.`);}
  function deleteInstrumentSelection(){const list=voxInstrumentSelectionList();if(!list.length)return false;voxCheckpoint();const b=window.CRPBeatMaker?.getBeat?.();for(const s of list){if(s.kind==='drum'&&b){b.tracks[s.drumId][s.bar]=(b.tracks[s.drumId][s.bar]||[]).filter(x=>Number(x)!==Number(s.step));}else if(s.kind==='lead'&&s.part)s.part.events=(s.part.events||[]).filter(x=>x!==s.event);else if(s.kind==='chord'&&s.part){for(const row of s.part.data?.rows||[]){const i=row.indexOf(s.card);if(i>=0){row.splice(i,1);break;}}if(String(s.part.id)===String(loadedChordPartId))core.apply(s.part.data);}}if(b)window.CRPBeatMaker.setBeat(b,{persist:true});voxInstrumentSelections=[];voxInstrumentSelection=null;persistVoxEdits();renderParts();renderVoxBox();voxStatus(`${list.length} instrument event${list.length===1?'':'s'} deleted.`);return true;}
  function deleteSelectedVox(){if(voxInstrumentSelectionList().length){deleteInstrumentSelection();return;}const selected=voxSelectionPairs();if(!selected.length)return;voxCheckpoint();for(const {part,event} of selected)part.voxEvents=(part.voxEvents||[]).filter(x=>x.id!==event.id);voxSelections=[];voxSelected=null;persistVoxEdits();renderVoxBox();voxStatus(`${selected.length} event${selected.length===1?'':'s'} deleted. Original dry takes remain safe.`);}
'''
s=s[:start]+block2+s[end:]
# Ensure persist edits render rest app more directly
old="function persistVoxEdits(){markPartsDirty();playbackTotalBeats=mediaDurationBeats();renderSongEndEditor();core.scheduleAutoSave();}"
new="function persistVoxEdits(){markPartsDirty();playbackTotalBeats=mediaDurationBeats();renderSongEndEditor();core.scheduleAutoSave();core.flushAutoSaveNow?.();}"
assert old in s;s=s.replace(old,new)
parts.write_text(s)

# HTML add buttons
html=p/'index.html'; h=html.read_text()
h=h.replace('<label class="vox-tool-check"><input id="voxShowInstrumentals" type="checkbox"><span>Instrumentals</span></label>','<label class="vox-tool-check"><input id="voxShowInstrumentals" type="checkbox"><span>Instrumentals</span></label>\n        <button id="voxDrumMapBtn" type="button" aria-pressed="false">Drum Map</button>')
h=h.replace('<div id="voxTimelineInner" class="vox-timeline-inner">','<div id="voxTimelineInner" class="vox-timeline-inner">\n          <button id="voxToolModeBtn" class="vox-tool-mode-btn" type="button" aria-pressed="true" title="Cycle Cursor / Playhead">Playhead</button>')
html.write_text(h)

# CSS append
css=p/'styles.css'; c=css.read_text()
c += r'''

/* =========================================================
   v3.3.25 — Vox Box deep DAW editing
   ========================================================= */
.vox-tool-mode-btn{
  position:sticky;left:6px;top:4px;z-index:90;float:left;margin:4px 0 0 5px;
  min-width:86px;min-height:31px;padding:5px 9px!important;border-radius:8px!important;
  background:#18212b!important;border:1px solid #465566!important;color:#eef3f7!important;font-weight:900!important;
  box-shadow:0 4px 14px rgba(0,0,0,.28);touch-action:manipulation;
}
.vox-tool-mode-btn.is-active{background:linear-gradient(180deg,#f8d66d,#e7b53c)!important;color:#111!important;border-color:#d4a02e!important;}
.vox-track-reorder-handle{cursor:grab;touch-action:pan-x;user-select:none;}
.vox-track-row.is-reordering{opacity:.76;outline:2px solid rgba(241,198,85,.8);z-index:80;box-shadow:0 10px 28px rgba(0,0,0,.45);}
.vox-inst-handle{position:absolute;top:0;bottom:0;width:12px;z-index:6;display:block;background:linear-gradient(90deg,rgba(255,255,255,.06),rgba(102,198,255,.22));cursor:ew-resize;touch-action:none;}
.vox-inst-handle.left{left:0;border-right:1px solid rgba(255,255,255,.35);border-radius:4px 0 0 4px;}
.vox-inst-handle.right{right:0;border-left:1px solid rgba(255,255,255,.35);border-radius:0 4px 4px 0;}
.vox-instrument-event.is-selected .vox-inst-handle{background:rgba(102,198,255,.28);}
.vox-drum-map-row{height:auto!important;min-height:180px;background:#0c131b!important;}
.vox-drum-map-row .vox-track-label{align-self:stretch;justify-content:flex-start!important;padding-top:12px!important;}
.vox-drum-map-lane{margin-left:0;min-height:180px;overflow:visible;background:#0b1118;border-top:1px solid #27323d;border-bottom:1px solid #27323d;}
.vox-drum-map-grid{display:grid;grid-template-columns:92px repeat(var(--vox-drum-cols),minmax(14px,1fr));grid-auto-rows:22px;min-width:max-content;align-items:stretch;}
.vox-drum-map-name{position:sticky;left:0;z-index:4;display:flex;align-items:center;padding:0 6px;background:#111923;border-right:1px solid #33404c;color:#dbe3eb;font-size:.65rem;font-weight:800;white-space:nowrap;}
.vox-drum-cell{min-width:14px;width:14px;height:22px;padding:0!important;border-radius:0!important;border:0!important;border-right:1px solid rgba(255,255,255,.055)!important;border-bottom:1px solid rgba(255,255,255,.04)!important;background:#151e27!important;box-shadow:none!important;}
.vox-drum-cell:nth-child(4n+1){background:#18232e!important;}
.vox-drum-cell.bar-start{border-left:1px solid #607080!important;}
.vox-drum-cell.on{background:#f1c655!important;box-shadow:inset 0 0 0 2px rgba(0,0,0,.22)!important;}
#voxDrumMapBtn.is-active,#voxMultiSelectBtn.is-active{background:linear-gradient(180deg,#f8d66d,#e7b53c)!important;color:#111!important;border-color:#d4a02e!important;}
@media(max-width:600px){
 .vox-tool-mode-btn{min-width:74px;min-height:29px;font-size:.7rem!important;padding:4px 6px!important;}
 .vox-inst-handle{width:16px;}
 .vox-drum-map-grid{grid-template-columns:76px repeat(var(--vox-drum-cols),14px);}
 .vox-drum-map-name{font-size:.58rem;padding:0 4px;}
}
'''
css.write_text(c)

# update version marker text and cache names
for fn in ['service-worker.js','worker.js','README.md']:
    fp=p/fn
    if fp.exists():
        t=fp.read_text(errors='ignore')
        t=t.replace('v3.3.24','v3.3.25').replace('3.3.24','3.3.25')
        fp.write_text(t)
# new update notes
(p/'UPDATE-v3.3.25-VOX-DEEP-DAW-EDITING.txt').write_text('''Song Rider Suite v3.3.25 — Vox Box Deep DAW Editing\n\n- Added clickable Drum Map grid inside Vox Box.\n- Added long-press track title reordering with persisted Vox Box track order.\n- Added draggable left/right event edges for Lead/Bass and Chord/Note events.\n- Added Cursor / Playhead mode switch in the track-title gutter.\n- Improved Multi Select across vocal and instrument events; group move/copy/cut/paste/delete.\n- Instrument edits persist immediately back to Baby DAW / Chord Rider state.\n- Preserved Snap to Beat / free placement behavior for event moves and edge edits.\n''')
print('patched')
