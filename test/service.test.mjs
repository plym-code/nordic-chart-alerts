import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { createService,normalizeEmail,normalizeMarkets,sign,unsign } from '../service/worker.mjs';

// Exercise SQL, verification, isolation and outbox behavior with real SQLite.
function database() {
  const db=new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../service/schema.sql',import.meta.url),'utf8'));
  const wrap=(sql,args=[])=>({bind:(...v)=>wrap(sql,v),first:async()=>db.prepare(sql).get(...args)||null,
    all:async()=>({results:db.prepare(sql).all(...args)}),run:async()=>db.prepare(sql).run(...args)});
  return {prepare:sql=>wrap(sql), batch:async statements=>{
    db.exec('BEGIN');
    try { const results=[]; for(const statement of statements) results.push(await statement.run()); db.exec('COMMIT'); return results; }
    catch(error) {db.exec('ROLLBACK');throw error;}
  }};
}
function setup() {
  const mails=[];
  const env={DB:database(),SITE_URL:'https://example.test/charts',RESEND_API_KEY:'test-key',TOKEN_SECRET:'test-signing-secret-with-sufficient-length',INGEST_SECRET:'test-ingestion-secret',
    ALERT_FROM:'charts@atle.no',SENDING_ENABLED:'true',TURNSTILE_SECRET:'test-challenge-key',TURNSTILE_SITE_KEY:'public-test-key'};
  const service=createService(async(url,init)=>{
    if(url.includes('siteverify')) return Response.json({success:JSON.parse(init.body).response==='valid',hostname:'example.test'});
    assert.equal(url,'https://api.resend.com/emails'); mails.push(JSON.parse(init.body)); return Response.json({id:'accepted'});
  });
  const post=async(path,body)=>{
    const response=await service.fetch(new Request(`https://api.example.test/api/${path}`,{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://example.test'},body:JSON.stringify(body)}),env);
    return {status:response.status,body:await response.json()};
  };
  const ingest=async observations=>{
    const time=String(Math.floor(Date.now()/1000)),body=JSON.stringify({observations});
    return service.fetch(new Request('https://api.example.test/api/ingest',{method:'POST',body,headers:{'Content-Type':'application/json','X-Monitor-Time':time,'X-Monitor-Signature':createHmac('sha256',env.INGEST_SECRET).update(`${time}.${body}`).digest('base64url')}}),env);
  };
  return {env,mails,service,post,ingest};
}
test('address and playlist validation reject lookalikes and unexpected values',()=>{
  assert.equal(normalizeEmail(' Person@UMUSIC.COM '),'person@umusic.com');
  for(const email of ['a@umusic.com.attacker.test','a@sub.umusic.com','a@umusic.co','a@umusic.com\r\nbcc:a@evil.test']) assert.throws(()=>normalizeEmail(email));
  assert.throws(()=>normalizeMarkets(['__proto__'])); assert.throws(()=>normalizeMarkets([]));
});
test('signed management links reject edits and expired tokens',async()=>{
  const token=await sign({scope:'manage',email:'a@umusic.com',exp:Math.floor(Date.now()/1000)+100},'secret');
  assert.equal((await unsign(token,'secret')).email,'a@umusic.com');
  await assert.rejects(unsign(token,'different-secret'));
  await assert.rejects(unsign(await sign({scope:'manage',exp:1},'secret'),'secret'));
});
test('only confirmed addresses receive selected-country updates; replay stays quiet and unsubscribe revokes links',async()=>{
  const {env,mails,service,post,ingest}=setup();
  assert.equal((await post('subscribe',{email:'person@umusic.com',markets:['se'],challenge:'invalid'})).status,400);
  assert.equal((await post('subscribe',{email:'person@umusic.com',markets:['se'],challenge:'valid'})).status,202);
  assert.equal(mails.length,1);
  const token=mails[0].text.match(/#verify=([\w-]+)/)[1];
  await ingest([{code:'se',date:'2026-10-29'},{code:'no',date:'2026-10-29'}]);
  await ingest([{code:'se',date:'2026-10-30'}]);
  await service.scheduled({},env); assert.equal(mails.length,1);
  const confirmation=await post('confirm',{token}); assert.equal(confirmation.status,200);
  assert.equal((await post('confirm',{token})).status,401);
  const management=confirmation.body.manageUrl.split('#manage=')[1];
  assert.equal((await post('preferences',{token:management})).body.markets[0],'se');
  await ingest([{code:'no',date:'2026-10-31'}]);
  await service.scheduled({},env); assert.equal(mails.length,1);
  await ingest([{code:'se',date:'2026-10-31'}]);
  await service.scheduled({},env); assert.equal(mails.length,2); assert.match(mails[1].subject,/Sweden updated/);
  await ingest([{code:'se',date:'2026-10-31'}]);
  await service.scheduled({},env); assert.equal(mails.length,2);
  assert.equal((await post('unsubscribe',{token:management})).status,200);
  assert.equal((await post('preferences',{token:management})).status,401);
  await ingest([{code:'se',date:'2026-11-01'}]);
  await service.scheduled({},env); assert.equal(mails.length,2);
});
test('unsigned ingestion and unapproved origins cannot mutate private subscriptions',async()=>{
  const {env,service}=setup();
  const response=await service.fetch(new Request('https://api.example.test/api/ingest',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"observations":[]}'}),env);
  assert.equal(response.status,401);
  const badOrigin=await service.fetch(new Request('https://api.example.test/api/subscribe',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://evil.test'},body:'{}'}),env);
  assert.equal(badOrigin.status,403);
});
