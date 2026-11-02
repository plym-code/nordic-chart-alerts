import { MARKETS } from '../src/core.mjs';
const encoder = new TextEncoder();
const nowSeconds = () => Math.floor(Date.now() / 1000);
const base64 = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
const unbase64 = text => Uint8Array.from(atob(text.replaceAll('-','+').replaceAll('_','/')), c => c.charCodeAt(0));
const randomToken = () => base64(crypto.getRandomValues(new Uint8Array(32)));
const digest = async text => base64(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text))));
const statement = (env, sql, ...values) => env.DB.prepare(sql).bind(...values);
const failure = (status, message) => Object.assign(new Error(message), { status });
export function normalizeEmail(value) {
  if (typeof value !== 'string') throw failure(400, 'Use your @umusic.com email address.');
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@umusic\.com$/.test(email)) throw failure(400, 'Use your @umusic.com email address.');
  return email;
}
export function normalizeMarkets(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4 || value.some(code => typeof code !== 'string' || !Object.hasOwn(MARKETS, code))) throw failure(400, 'Choose at least one of the four Nordic charts.');
  return [...new Set(value)].sort();
}
async function hmac(secret) {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
export async function sign(payload, secret) {
  const body = base64(encoder.encode(JSON.stringify(payload)));
  return `${body}.${base64(new Uint8Array(await crypto.subtle.sign('HMAC', await hmac(secret), encoder.encode(body))))}`;
}
export async function unsign(token, secret) {
  try {
    if (typeof token !== 'string' || token.length > 2048) throw 0;
    const parts = token.split('.');
    if (parts.length !== 2 || !await crypto.subtle.verify('HMAC', await hmac(secret), unbase64(parts[1]), encoder.encode(parts[0]))) throw 0;
    const value = JSON.parse(new TextDecoder().decode(unbase64(parts[0])));
    if (!Number.isInteger(value.exp) || value.exp <= nowSeconds() || value.scope !== 'manage') throw 0;
    return value;
  } catch { throw failure(401, 'This link has expired. Request a fresh email link.'); }
}
async function rate(env, key, max, expires) {
  const result = await statement(env, `INSERT INTO rates(key,count,expires) VALUES(?,1,?)
    ON CONFLICT(key) DO UPDATE SET count=count+1 WHERE count < ? RETURNING count`, key, expires, max).first();
  return !!result;
}
export function createService(network = fetch) {
  async function send(env, email, subject, text, id, verification = false) {
    if (env.SENDING_ENABLED !== 'true' || !env.RESEND_API_KEY || !env.ALERT_FROM) throw failure(503, 'Email setup is still in progress. Please try again later.');
    const day = new Date().toISOString().slice(0,10);
    if (!await rate(env, `mail:${day}`, verification ? 100 : 90, nowSeconds()+172800)) throw failure(429, 'Today’s email allowance is full. Please try again tomorrow.');
    const response = await network('https://api.resend.com/emails', {
      method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': id },
      body: JSON.stringify({ from: env.ALERT_FROM, to: [email], subject, text }),
    });
    if (!response.ok) throw failure(503, 'Email could not be sent. Please try again later.');
  }
  async function member(env, token) {
    if (typeof env.TOKEN_SECRET !== 'string' || env.TOKEN_SECRET.length < 32) throw failure(503, 'Subscription setup is still in progress.');
    const claims = await unsign(token, env.TOKEN_SECRET);
    const row = await statement(env, 'SELECT email,version FROM members WHERE email=? AND verified=1', claims.email).first();
    if (!row || row.version !== claims.version) throw failure(401, 'Request a fresh email link to manage your subscriptions.');
    return row;
  }
  async function manageLink(env, row) {
    if (typeof env.TOKEN_SECRET !== 'string' || env.TOKEN_SECRET.length < 32) throw failure(503, 'Subscription setup is still in progress.');
    return `${env.SITE_URL}/#manage=${await sign({ scope: 'manage', email: row.email, version: row.version, exp: nowSeconds()+90*86400 }, env.TOKEN_SECRET)}`;
  }
  async function api(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/status' && request.method === 'GET') {
      const { results } = await statement(env, 'SELECT market,date FROM charts ORDER BY market').all();
      return Response.json({ dates: results, signupEnabled: env.SENDING_ENABLED === 'true' && !!env.RESEND_API_KEY && !!env.TURNSTILE_SECRET && !!env.TURNSTILE_SITE_KEY && (env.TOKEN_SECRET?.length || 0) >= 32, turnstileSiteKey: env.TURNSTILE_SITE_KEY || null });
    }
    if (request.method !== 'POST') throw failure(405, 'Use POST for this request.');
    if (!request.headers.get('content-type')?.startsWith('application/json')) throw failure(415, 'Expected JSON.');
    if (Number(request.headers.get('content-length') || 0) > 8192) throw failure(413, 'Request too large.');
    const raw = await request.text();
    if (raw.length > 8192) throw failure(413, 'Request too large.');
    let body;
    try { body = JSON.parse(raw); } catch { throw failure(400, 'Invalid request.'); }
    if (!body || Array.isArray(body) || typeof body !== 'object') throw failure(400, 'Invalid request.');
    if (url.pathname === '/api/ingest') {
      const time = request.headers.get('x-monitor-time');
      const signature = request.headers.get('x-monitor-signature');
      let valid = false;
      try { valid = !!env.INGEST_SECRET && Math.abs(nowSeconds()-Number(time)) < 300 && await crypto.subtle.verify('HMAC', await hmac(env.INGEST_SECRET), unbase64(signature), encoder.encode(`${time}.${raw}`)); } catch {}
      if (!valid) throw failure(401, 'Invalid monitor signature.');
      if (!Array.isArray(body.observations) || body.observations.length > 4) throw failure(400, 'Invalid observations.');
      for (const item of body.observations) {
        if (item.error) continue;
        if (!Object.hasOwn(MARKETS,item.code) || !/^\d{4}-\d{2}-\d{2}$/.test(item.date || '') || !Number.isFinite(Date.parse(item.date)) || new Date(item.date).toISOString().slice(0,10)!==item.date || item.date > new Date().toISOString().slice(0,10)) throw failure(400, 'Invalid chart date.');
        const prior = await statement(env,'SELECT date FROM charts WHERE market=?', item.code).first();
        if (prior && item.date < prior.date) throw failure(409, 'Chart date moved backwards.');
        if (prior?.date === item.date) continue;
        // Baseline stays quiet. One deterministic outbox record per recipient/date.
        const statements = [];
        if (prior) {
          const { results: recipients } = await statement(env, 'SELECT m.email,m.version FROM members m JOIN subscriptions s ON s.email=m.email WHERE m.verified=1 AND s.market=?', item.code).all();
          for (const row of recipients) {
            const id = `${item.code}:${item.date}:${await digest(row.email)}`;
            const text = `Spotify Top 50 ${MARKETS[item.code].name} now shows chart date ${item.date}.\n\nOpen playlist: https://open.spotify.com/playlist/${MARKETS[item.code].id}\n\nManage or unsubscribe: ${await manageLink(env,row)}\n\nYou subscribed using your @umusic.com address. Detected by a periodic check; delivery time can vary.`;
            statements.push(statement(env,'INSERT OR IGNORE INTO outbox(id,email,subject,text,created) VALUES(?,?,?,?,?)',id,row.email,`Spotify Top 50 ${MARKETS[item.code].name} updated`,text,nowSeconds()));
          }
        }
        statements.push(statement(env,'INSERT INTO charts(market,date) VALUES(?,?) ON CONFLICT(market) DO UPDATE SET date=excluded.date',item.code,item.date));
        await env.DB.batch(statements);
      }
      return Response.json({ ok: true });
    }
    if (request.headers.get('origin') !== new URL(env.SITE_URL).origin) throw failure(403, 'This request must come from the signup page.');
    if (url.pathname === '/api/subscribe') {
      const email = normalizeEmail(body.email);
      const markets = normalizeMarkets(body.markets);
      if (env.SENDING_ENABLED !== 'true') throw failure(503, 'Email setup is still in progress. Please try again later.');
      if (!env.TURNSTILE_SECRET || !env.TURNSTILE_SITE_KEY || (env.TOKEN_SECRET?.length || 0) < 32) throw failure(503, 'Signup setup is still in progress.');
      const challenge = await network('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({secret:env.TURNSTILE_SECRET,response:body.challenge}),signal:AbortSignal.timeout(10000),
      });
      const result = await challenge.json();
      if (!result.success || result.hostname !== new URL(env.SITE_URL).hostname) throw failure(400, 'Please complete the verification check again.');
      const now=nowSeconds(), addressHash=await digest(email);
      const ipHash=await digest(`${env.TOKEN_SECRET}:${request.headers.get('cf-connecting-ip') || 'unknown'}:${Math.floor(now/3600)}`);
      if (!await rate(env,`ip:${ipHash}`,5,now+7200) || !await rate(env,`address:${addressHash}:${Math.floor(now/600)}`,1,now+1200)) throw failure(429, 'Please wait before requesting another link.');
      const token=randomToken(), hash=await digest(token);
      await statement(env,'INSERT INTO tokens(hash,email,markets,expires) VALUES(?,?,?,?)',hash,email,JSON.stringify(markets),now+1200).run();
      try { await send(env,email,'Confirm your Nordic chart alerts',`Confirm the playlists you selected:\n${env.SITE_URL}/#verify=${token}\n\nThe link expires in 20 minutes. Open the link and select Confirm to activate your subscriptions. If you did not request this, ignore this email.`, `verify:${hash}`,true); }
      catch(error) { await statement(env,'DELETE FROM tokens WHERE hash=?',hash).run(); throw error; }
      return Response.json({ok:true,message:'Check your inbox for a confirmation link.'}, {status:202});
    }
    if (url.pathname === '/api/confirm') {
      if (typeof body.token!=='string' || !/^[\w-]{43}$/.test(body.token)) throw failure(400,'Invalid confirmation link.');
      const row=await statement(env,'DELETE FROM tokens WHERE hash=? AND expires>? RETURNING email,markets',await digest(body.token),nowSeconds()).first();
      if (!row) throw failure(401,'This confirmation link has expired or was already used. Request a new one.');
      const markets=normalizeMarkets(JSON.parse(row.markets));
      await env.DB.batch([
        statement(env,'INSERT INTO members(email,verified,version) VALUES(?,1,1) ON CONFLICT(email) DO UPDATE SET verified=1,version=version+1',row.email),
        statement(env,'DELETE FROM subscriptions WHERE email=?',row.email),
        ...markets.map(code=>statement(env,'INSERT INTO subscriptions(email,market) VALUES(?,?)',row.email,code)),
      ]);
      const saved=await statement(env,'SELECT email,version FROM members WHERE email=?',row.email).first();
      return Response.json({ok:true,markets,manageUrl:await manageLink(env,saved)});
    }
    if (['/api/preferences','/api/unsubscribe'].includes(url.pathname)) {
      const row=await member(env,body.token);
      if (url.pathname==='/api/unsubscribe') {
        await env.DB.batch([
          statement(env,'UPDATE members SET verified=0,version=version+1 WHERE email=?',row.email),
          statement(env,'DELETE FROM subscriptions WHERE email=?',row.email),
          statement(env,'DELETE FROM outbox WHERE email=? AND sent=0',row.email),
          statement(env,'DELETE FROM tokens WHERE email=?',row.email),
        ]);
        return Response.json({ok:true});
      }
      if (body.markets !== undefined) {
        const markets=normalizeMarkets(body.markets);
        await env.DB.batch([
          statement(env,'DELETE FROM subscriptions WHERE email=?',row.email),
          ...markets.map(code=>statement(env,'INSERT INTO subscriptions(email,market) VALUES(?,?)',row.email,code)),
          statement(env,`DELETE FROM outbox WHERE email=? AND sent=0 AND substr(id,1,2) NOT IN (${markets.map(()=>'?').join(',')})`,row.email,...markets),
        ]);
      }
      const {results}=await statement(env,'SELECT market FROM subscriptions WHERE email=? ORDER BY market',row.email).all();
      return Response.json({ok:true,markets:results.map(item=>item.market)});
    }
    throw failure(404,'Not found.');
  }
  return {
    async fetch(request, env) {
      const allowed=new URL(env.SITE_URL).origin;
      const headers={ 'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Access-Control-Allow-Origin':allowed,'Vary':'Origin' };
      if(request.method==='OPTIONS') return new Response(null,{status:204,headers:{...headers,'Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type'}});
      let response;
      try { response=await api(request,env); }
      catch(error) { response=Response.json({error:error.status ? error.message : 'The service could not complete this request. Please try again.'},{status:error.status || 500}); }
      for(const [key,value] of Object.entries(headers)) response.headers.set(key,value);
      return response;
    },
    async scheduled(_event,env) {
      if(env.SENDING_ENABLED!=='true') return;
      const now=nowSeconds();
      const {results}=await statement(env,'SELECT id FROM outbox WHERE sent=0 AND lease<? AND created>? ORDER BY created LIMIT 5',now,now-23*3600).all();
      for(const item of results) {
        const row=await statement(env,'UPDATE outbox SET lease=? WHERE id=? AND sent=0 AND lease<? RETURNING *',now+120,item.id,now).first();
        if(!row) continue;
        const active=await statement(env,'SELECT 1 AS active FROM members m JOIN subscriptions s ON s.email=m.email WHERE m.email=? AND m.verified=1 AND s.market=?',row.email,row.id.slice(0,2)).first();
        if(!active) { await statement(env,'DELETE FROM outbox WHERE id=?',row.id).run(); continue; }
        await send(env,row.email,row.subject,row.text,row.id);
        await statement(env,'UPDATE outbox SET sent=1 WHERE id=?',row.id).run();
      }
      await env.DB.batch([
        statement(env,'DELETE FROM tokens WHERE expires<?',now),
        statement(env,'DELETE FROM rates WHERE expires<?',now),
        statement(env,'DELETE FROM outbox WHERE sent=1 AND created<?',now-86400),
      ]);
    },
  };
}
export default createService();
