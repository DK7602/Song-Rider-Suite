const enc = new TextEncoder();
const COOKIE = 'crp_session';
const ITERATIONS = 100000;
const SESSION_DAYS = 30;

const json = (data, status=200, headers={}) => Response.json(data,{status,headers:{'Cache-Control':'no-store',...headers}});
const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = s => Uint8Array.from(atob(s), c=>c.charCodeAt(0));
const randomToken = (n=32) => { const a=new Uint8Array(n); crypto.getRandomValues(a); return b64(a).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); };
async function sha256(s){return b64(await crypto.subtle.digest('SHA-256',enc.encode(s)));}
async function hashPassword(password,saltB64,iterations=ITERATIONS){
  const key=await crypto.subtle.importKey('raw',enc.encode(password),'PBKDF2',false,['deriveBits']);
  const bits=await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:unb64(saltB64),iterations},key,256);
  return b64(bits);
}
function safeEqual(a,b){if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;let x=0;for(let i=0;i<a.length;i++)x|=a.charCodeAt(i)^b.charCodeAt(i);return x===0;}
function cookie(request,name){const raw=request.headers.get('Cookie')||'';for(const part of raw.split(';')){const [k,...v]=part.trim().split('=');if(k===name)return decodeURIComponent(v.join('='));}return null;}
function sessionCookie(token,maxAge=SESSION_DAYS*86400){return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;}
async function body(request){try{return await request.json();}catch{return {};}}
async function userFor(request,env){
  const token=cookie(request,COOKIE); if(!token)return null; const tokenHash=await sha256(token); const now=Date.now();
  const row=await env.DB.prepare(`SELECT users.id, users.email, users.display_name FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.token_hash=? AND sessions.expires_at>?`).bind(tokenHash,now).first();
  return row||null;
}
async function createSession(userId,env){const token=randomToken(),id=crypto.randomUUID(),now=Date.now();await env.DB.prepare('INSERT INTO sessions (id,user_id,token_hash,expires_at,created_at) VALUES (?,?,?,?,?)').bind(id,userId,await sha256(token),now+SESSION_DAYS*86400000,now).run();return token;}
function validPassword(p){return typeof p==='string'&&p.length>=8&&p.length<=200;}
function validEmail(e){return typeof e==='string'&&e.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);}

const VALID_SKINS=new Set(['rider-original','rider-og','rider-blood','studio-pastel','black-label','black-label-plain','black-label-light','royal-wave','candy-pop','rider-light','rider-light-og','rider-blood-light','rider-blood-light-og']);
let userPreferencesSchemaReady=false;
async function ensureUserPreferencesSchema(env){
  if(userPreferencesSchemaReady)return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS user_preferences (
    user_id TEXT PRIMARY KEY,
    skin TEXT,
    updated_at INTEGER NOT NULL DEFAULT 0
  )`).run();
  userPreferencesSchemaReady=true;
}

let srpSchemaReady=false;
async function ensureSrpSchema(env){
  if(srpSchemaReady)return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS srp_projects (
    owner_user_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    legacy_user_id TEXT,
    name TEXT NOT NULL DEFAULT '',
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT 0,
    deleted INTEGER NOT NULL DEFAULT 0,
    deleted_at TEXT,
    created_at TEXT,
    last_synced_at TEXT,
    PRIMARY KEY (owner_user_id, project_id)
  )`).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_srp_projects_owner_updated ON srp_projects(owner_user_id, updated_at DESC)').run();
  srpSchemaReady=true;
}

async function srpRowFor(env,userId,projectId){
  await ensureSrpSchema(env);
  return env.DB.prepare('SELECT owner_user_id,project_id,legacy_user_id,deleted FROM srp_projects WHERE owner_user_id=? AND project_id=?').bind(userId,projectId).first();
}

function srpMediaAllowed(row,userId,projectId,key){
  const clean=String(key||'').replace(/^\/+/,''), pid=String(projectId||'');
  if(!clean||!pid||!row)return false;
  const prefixes=[`${userId}/${pid}/`];
  if(row.legacy_user_id)prefixes.push(`${row.legacy_user_id}/${pid}/`);
  return prefixes.some(prefix=>clean.startsWith(prefix));
}

function mimeForPath(path,fallback='application/octet-stream'){
  const p=String(path||'').toLowerCase();
  if(p.endsWith('.mp3'))return 'audio/mpeg';
  if(p.endsWith('.wav'))return 'audio/wav';
  if(p.endsWith('.ogg'))return 'audio/ogg';
  if(p.endsWith('.webm'))return 'audio/webm';
  if(p.endsWith('.m4a')||p.endsWith('.mp4'))return 'audio/mp4';
  if(p.endsWith('.jpg')||p.endsWith('.jpeg'))return 'image/jpeg';
  if(p.endsWith('.png'))return 'image/png';
  if(p.endsWith('.webp'))return 'image/webp';
  if(p.endsWith('.gif'))return 'image/gif';
  if(p.endsWith('.heic'))return 'image/heic';
  return fallback;
}

async function api(request,env,url){
  const path=url.pathname, method=request.method;
  if(path==='/api/health') {try{const r=await env.DB.prepare('SELECT 1 ok').first();return json({ok:r?.ok===1,app:'Song Rider Suite',database:'connected'});}catch(e){return json({ok:false,error:String(e?.message||e)},500);}}
  if(path==='/api/auth/me'&&method==='GET'){const u=await userFor(request,env);return json({ok:true,user:u});}
  if(path==='/api/auth/register'&&method==='POST'){
    const b=await body(request), email=String(b.email||'').trim().toLowerCase(), displayName=String(b.displayName||'').trim().slice(0,80), password=String(b.password||''), invite=String(b.inviteCode||'');
    if(!env.INVITE_CODE||!safeEqual(invite,String(env.INVITE_CODE)))return json({ok:false,error:'Invalid invite code.'},403);
    if(!validEmail(email))return json({ok:false,error:'Enter a valid email address.'},400); if(!validPassword(password))return json({ok:false,error:'Password must be at least 8 characters.'},400);
    if(await env.DB.prepare('SELECT id FROM users WHERE email=? COLLATE NOCASE').bind(email).first())return json({ok:false,error:'An account already exists for that email.'},409);
    const salt=b64(crypto.getRandomValues(new Uint8Array(16))), hash=await hashPassword(password,salt), id=crypto.randomUUID(), now=Date.now();
    await env.DB.prepare('INSERT INTO users (id,email,display_name,password_hash,password_salt,password_iterations,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').bind(id,email,displayName||null,hash,salt,ITERATIONS,now,now).run();
    const token=await createSession(id,env);return json({ok:true,user:{id,email,display_name:displayName||null}},201,{'Set-Cookie':sessionCookie(token)});
  }
  if(path==='/api/auth/login'&&method==='POST'){
    const b=await body(request),email=String(b.email||'').trim().toLowerCase(),password=String(b.password||'');
    const u=await env.DB.prepare('SELECT * FROM users WHERE email=? COLLATE NOCASE').bind(email).first(); if(!u)return json({ok:false,error:'Email or password is incorrect.'},401);
    const hash=await hashPassword(password,u.password_salt,u.password_iterations||ITERATIONS);if(!safeEqual(hash,u.password_hash))return json({ok:false,error:'Email or password is incorrect.'},401);
    const token=await createSession(u.id,env);return json({ok:true,user:{id:u.id,email:u.email,display_name:u.display_name}},200,{'Set-Cookie':sessionCookie(token)});
  }
  if(path==='/api/auth/logout'&&method==='POST'){
    const token=cookie(request,COOKIE);if(token)await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await sha256(token)).run();return json({ok:true},200,{'Set-Cookie':sessionCookie('',0)});
  }
  if(path==='/api/auth/password'&&method==='POST'){
    const u=await userFor(request,env);if(!u)return json({ok:false,error:'Please log in.'},401);const b=await body(request),oldP=String(b.currentPassword||''),newP=String(b.newPassword||'');if(!validPassword(newP))return json({ok:false,error:'New password must be at least 8 characters.'},400);
    const full=await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(u.id).first(), oldHash=await hashPassword(oldP,full.password_salt,full.password_iterations||ITERATIONS);if(!safeEqual(oldHash,full.password_hash))return json({ok:false,error:'Current password is incorrect.'},403);
    const salt=b64(crypto.getRandomValues(new Uint8Array(16))),hash=await hashPassword(newP,salt),now=Date.now();await env.DB.batch([env.DB.prepare('UPDATE users SET password_hash=?,password_salt=?,password_iterations=?,updated_at=? WHERE id=?').bind(hash,salt,ITERATIONS,now,u.id),env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(u.id)]);const token=await createSession(u.id,env);return json({ok:true},200,{'Set-Cookie':sessionCookie(token)});
  }
  const u=await userFor(request,env);if(!u)return json({ok:false,error:'Please log in.'},401);

  if(path==='/api/preferences/skin'&&method==='GET'){
    await ensureUserPreferencesSchema(env);
    const row=await env.DB.prepare('SELECT skin,updated_at FROM user_preferences WHERE user_id=?').bind(u.id).first();
    return json({ok:true,skin:VALID_SKINS.has(String(row?.skin||''))?row.skin:null,updatedAt:Number(row?.updated_at)||0});
  }
  if(path==='/api/preferences/skin'&&method==='POST'){
    await ensureUserPreferencesSchema(env);
    const b=await body(request),skin=String(b.skin||'').trim();
    if(!VALID_SKINS.has(skin))return json({ok:false,error:'Unknown skin.'},400);
    const now=Date.now();
    await env.DB.prepare(`INSERT INTO user_preferences(user_id,skin,updated_at) VALUES(?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET skin=excluded.skin,updated_at=excluded.updated_at`).bind(u.id,skin,now).run();
    return json({ok:true,skin,updatedAt:now});
  }

  // Song Rider Pro projects now use the same Song Rider Suite account/session as CRP.
  if(path==='/api/srp/projects'&&method==='GET'){
    await ensureSrpSchema(env);
    const rs=await env.DB.prepare('SELECT owner_user_id,project_id,legacy_user_id,name,data,updated_at,deleted,deleted_at,created_at,last_synced_at FROM srp_projects WHERE owner_user_id=? ORDER BY updated_at DESC').bind(u.id).all();
    const projects=(rs.results||[]).map(r=>{let data={};try{data=JSON.parse(r.data)}catch{}return {...r,user_id:r.owner_user_id,data,deleted:!!r.deleted};});
    return json({ok:true,projects});
  }
  if(path==='/api/srp/projects'&&method==='POST'){
    await ensureSrpSchema(env);
    const b=await body(request), incoming=b.project||{}, dataObj=(incoming.data&&typeof incoming.data==='object')?incoming.data:incoming;
    const id=String(incoming.project_id||dataObj.id||crypto.randomUUID()), name=String(incoming.name||dataObj.name||'Untitled').trim().slice(0,200)||'Untitled';
    const updated=Number(incoming.updated_at||dataObj.updatedAt)||Date.now(), synced=String(incoming.last_synced_at||new Date().toISOString());
    const existing=await env.DB.prepare('SELECT legacy_user_id,created_at FROM srp_projects WHERE owner_user_id=? AND project_id=?').bind(u.id,id).first();
    const created=existing?.created_at||new Date(Number(dataObj.createdAt)||Date.now()).toISOString();
    const clean={...dataObj,id,name,updatedAt:updated};
    await env.DB.prepare(`INSERT INTO srp_projects(owner_user_id,project_id,legacy_user_id,name,data,updated_at,deleted,deleted_at,created_at,last_synced_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(owner_user_id,project_id) DO UPDATE SET
        name=excluded.name,data=excluded.data,updated_at=excluded.updated_at,deleted=0,deleted_at=NULL,last_synced_at=excluded.last_synced_at`)
      .bind(u.id,id,existing?.legacy_user_id||null,name,JSON.stringify(clean),updated,0,null,created,synced).run();
    return json({ok:true,project_id:id,updated_at:updated});
  }
  const srpProjectMatch=path.match(/^\/api\/srp\/projects\/([^/]+)$/);
  if(srpProjectMatch&&method==='DELETE'){
    await ensureSrpSchema(env);
    const id=decodeURIComponent(srpProjectMatch[1]), ts=Date.now(), deletedAt=new Date().toISOString();
    const existing=await env.DB.prepare('SELECT data FROM srp_projects WHERE owner_user_id=? AND project_id=?').bind(u.id,id).first();
    if(!existing)return json({ok:true});
    let data={};try{data=JSON.parse(existing.data)}catch{}data={...data,id,deleted:true,updatedAt:ts};
    await env.DB.prepare('UPDATE srp_projects SET data=?,updated_at=?,deleted=1,deleted_at=?,last_synced_at=? WHERE owner_user_id=? AND project_id=?').bind(JSON.stringify(data),ts,deletedAt,deletedAt,u.id,id).run();
    return json({ok:true});
  }

  // Authenticated SRP media gateway. Allows current Suite-owned paths plus migrated legacy Supabase paths for that project only.
  if(path==='/api/srp/media'){
    if(!env.AUDIO)return json({ok:false,error:'Song Rider Suite media storage is not connected.'},503);
    const projectId=String(url.searchParams.get('projectId')||''), key=String(url.searchParams.get('path')||'').replace(/^\/+/, '');
    if(!projectId||!key)return json({ok:false,error:'projectId and path are required.'},400);
    const row=await srpRowFor(env,u.id,projectId);
    if(!row)return json({ok:false,error:'SRP project not found.'},404);
    if(!srpMediaAllowed(row,u.id,projectId,key))return json({ok:false,error:'Media path is not authorized for this project.'},403);
    if(method==='PUT'){
      const buf=await request.arrayBuffer();
      if(!buf.byteLength)return json({ok:false,error:'Media body is empty.'},400);
      if(buf.byteLength>100*1024*1024)return json({ok:false,error:'Media file is too large.'},413);
      const contentType=request.headers.get('Content-Type')||mimeForPath(key);
      await env.AUDIO.put(key,buf,{httpMetadata:{contentType},customMetadata:{projectId,ownerUserId:u.id,uploadedAt:String(Date.now())}});
      return json({ok:true,size:buf.byteLength,path:key});
    }
    if(method==='GET'){
      const obj=await env.AUDIO.get(key);
      if(!obj)return json({ok:false,error:'Media object not found.'},404);
      const headers=new Headers();obj.writeHttpMetadata(headers);
      const existingType=String(headers.get('Content-Type')||'');
      if(!existingType||existingType==='application/octet-stream')headers.set('Content-Type',mimeForPath(key,existingType||'application/octet-stream'));
      headers.set('Cache-Control','private, max-age=0, no-store');headers.set('Content-Length',String(obj.size));
      return new Response(obj.body,{status:200,headers});
    }
    if(method==='HEAD'){
      const obj=await env.AUDIO.head(key);if(!obj)return new Response(null,{status:404});
      return new Response(null,{status:200,headers:{'Content-Length':String(obj.size),'Content-Type':mimeForPath(key)}});
    }
    if(method==='DELETE'){await env.AUDIO.delete(key);return json({ok:true});}
  }

  // Cross-device vocal transcription. The browser only records WAV; Cloudflare Workers AI transcribes the R2 master.
  const transcribeMatch=path.match(/^\/api\/transcribe\/([^/]+)$/);
  if(transcribeMatch&&method==='POST'){
    if(!env.AUDIO)return json({ok:false,error:'Cloud vocal storage is not connected.'},503);
    if(!env.AI)return json({ok:false,error:'Workers AI is not connected. Add a Workers AI binding named AI.'},503);
    const takeId=decodeURIComponent(transcribeMatch[1]), projectId=String(url.searchParams.get('projectId')||'');
    if(!projectId)return json({ok:false,error:'projectId is required.'},400);
    const owns=await env.DB.prepare('SELECT id FROM projects WHERE id=? AND user_id=?').bind(projectId,u.id).first();
    if(!owns)return json({ok:false,error:'Project not found.'},404);
    const key=`${u.id}/${projectId}/${takeId}.wav`, obj=await env.AUDIO.get(key);
    if(!obj)return json({ok:false,error:'Vocal WAV is not in cloud yet. Save the project, then try Transcribe again.'},404);
    if(obj.size>25*1024*1024)return json({ok:false,error:'This vocal take is too large for one-pass transcription. Split it into shorter takes for now.'},413);
    try{
      const bytes=new Uint8Array(await obj.arrayBuffer());
      // @cf/openai/whisper accepts audio bytes and returns text plus word timing/VTT when available.
      const result=await env.AI.run('@cf/openai/whisper',{audio:[...bytes]});
      const text=String(result?.text||result?.transcription_info?.text||'').trim();
      const words=Array.isArray(result?.words)?result.words:Array.isArray(result?.transcription_info?.words)?result.transcription_info.words:[];
      const vtt=String(result?.vtt||result?.transcription_info?.vtt||'');
      if(!text)return json({ok:false,error:'No speech was detected in this take.'},422);
      return json({ok:true,text,words,vtt,model:'@cf/openai/whisper'});
    }catch(e){console.error('Transcription failed',e);return json({ok:false,error:`Transcription failed: ${String(e?.message||e)}`},502);}
  }

  // Vocal masters live in authenticated R2 object storage, not in D1 project JSON.
  const audioMatch=path.match(/^\/api\/audio\/([^/]+)$/);
  if(audioMatch){
    if(!env.AUDIO)return json({ok:false,error:'Cloud vocal storage is not connected. Bind the Song Rider Suite R2 bucket to this Worker with binding name AUDIO.'},503);
    const takeId=decodeURIComponent(audioMatch[1]), projectId=String(url.searchParams.get('projectId')||'');
    if(!projectId)return json({ok:false,error:'projectId is required.'},400);
    const owns=await env.DB.prepare('SELECT id FROM projects WHERE id=? AND user_id=?').bind(projectId,u.id).first();
    if(!owns)return json({ok:false,error:'Project not found.'},404);
    const key=`${u.id}/${projectId}/${takeId}.wav`;
    if(method==='PUT'){
      const buf=await request.arrayBuffer();
      if(!buf.byteLength)return json({ok:false,error:'Audio body is empty.'},400);
      if(buf.byteLength>100*1024*1024)return json({ok:false,error:'Audio file is too large.'},413);
      await env.AUDIO.put(key,buf,{httpMetadata:{contentType:request.headers.get('Content-Type')||'audio/wav'},customMetadata:{takeId,projectId,uploadedAt:String(Date.now())}});
      return json({ok:true,size:buf.byteLength});
    }
    if(method==='GET'){
      const obj=await env.AUDIO.get(key);
      if(!obj)return json({ok:false,error:'Audio take not found in cloud.'},404);
      const headers=new Headers();obj.writeHttpMetadata(headers);headers.set('Cache-Control','private, max-age=0, no-store');headers.set('Content-Length',String(obj.size));
      return new Response(obj.body,{status:200,headers});
    }
    if(method==='HEAD'){const obj=await env.AUDIO.head(key);return obj?new Response(null,{status:200,headers:{'Content-Length':String(obj.size)}}):new Response(null,{status:404});}
    if(method==='DELETE'){await env.AUDIO.delete(key);return json({ok:true});}
  }
  if(path==='/api/projects'&&method==='GET'){const rs=await env.DB.prepare('SELECT id,name,data,created_at,updated_at FROM projects WHERE user_id=? ORDER BY updated_at DESC').bind(u.id).all();return json({ok:true,projects:(rs.results||[]).map(r=>{let data={};try{data=JSON.parse(r.data)}catch{}return {...data,id:r.id,name:r.name,createdAt:r.created_at,updatedAt:r.updated_at};})});}
  if(path==='/api/projects'&&method==='POST'){const b=await body(request),p=b.project||{},id=String(p.id||crypto.randomUUID()),name=String(p.name||'Untitled Project').trim().slice(0,160)||'Untitled Project',now=Date.now();const existing=await env.DB.prepare('SELECT created_at FROM projects WHERE id=? AND user_id=?').bind(id,u.id).first();const clean={...p,id,name};await env.DB.prepare(`INSERT INTO projects(id,user_id,name,data,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,data=excluded.data,updated_at=excluded.updated_at WHERE user_id=?`).bind(id,u.id,name,JSON.stringify(clean),existing?.created_at||now,now,u.id).run();return json({ok:true,project:{...clean,updatedAt:now}});}
  const m=path.match(/^\/api\/projects\/([^/]+)$/);if(m){const id=decodeURIComponent(m[1]);if(method==='DELETE'){await env.DB.prepare('DELETE FROM projects WHERE id=? AND user_id=?').bind(id,u.id).run();if(env.AUDIO){try{let cursor;do{const list=await env.AUDIO.list({prefix:`${u.id}/${id}/`,cursor});if(list.objects.length)await env.AUDIO.delete(list.objects.map(o=>o.key));cursor=list.truncated?list.cursor:undefined;}while(cursor);}catch(e){console.warn('Could not clean project audio',e);}}return json({ok:true});}if(method==='PATCH'){const b=await body(request),name=String(b.name||'').trim().slice(0,160);if(!name)return json({ok:false,error:'Project name is required.'},400);const r=await env.DB.prepare('SELECT data FROM projects WHERE id=? AND user_id=?').bind(id,u.id).first();if(!r)return json({ok:false,error:'Project not found.'},404);let d={};try{d=JSON.parse(r.data)}catch{}d.name=name;d.updatedAt=Date.now();await env.DB.prepare('UPDATE projects SET name=?,data=?,updated_at=? WHERE id=? AND user_id=?').bind(name,JSON.stringify(d),d.updatedAt,id,u.id).run();return json({ok:true});}}
  return json({ok:false,error:'API route not found.'},404);
}

export default {async fetch(request,env){const url=new URL(request.url);if(url.pathname.startsWith('/api/'))return api(request,env,url);return env.ASSETS.fetch(request);}};
