import { chromium } from 'playwright';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHmac } from 'node:crypto';
import { MARKETS, DATE_PATTERN, parseDate, updateState } from './core.mjs';

const probe = process.argv.includes('--probe');
const codes = (process.env.COUNTRIES || 'se,no,dk,fi').split(',');
if (codes.some(code => !MARKETS[code])) throw new Error('Unknown country code');
const statePath = process.env.STATE_FILE || 'state.json';
const email = { key: process.env.RESEND_API_KEY, from: process.env.ALERT_FROM, to: process.env.ALERT_TO };
const ingest = process.env.MONITOR_INGEST_URL;
if (!probe && ingest && !process.env.INGEST_SECRET) throw new Error('Configure INGEST_SECRET');
if (!probe && !ingest && Object.values(email).some(value => !value)) throw new Error('Configure the subscription service, direct email settings, or use --probe');

async function persist(state) {
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(`${statePath}.tmp`, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  await rename(`${statePath}.tmp`, statePath);
}

async function readMarket(context, code) {
  const page = await context.newPage();
  try {
    const market = MARKETS[code];
    const response = await page.goto(`https://open.spotify.com/playlist/${market.id}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (!response?.ok()) throw new Error(`PAGE_HTTP_${response?.status() || 'UNKNOWN'}`);
    const main = page.getByRole('main');
    await main.getByRole('heading', { name: `Top 50 - ${market.name}`, exact: true }).waitFor({ timeout: 30000 });
    await main.locator('span').filter({ hasText: DATE_PATTERN }).first().waitFor({ timeout: 30000 });
    // Read only a date outside the track grid. Never infer updates from track order.
    const texts = await main.locator('span').evaluateAll(elements => elements
      .filter(el => !el.closest('[role="grid"]') && el.getClientRects().length)
      .map(el => el.textContent.trim()));
    const dates = [...new Set(texts.filter(text => DATE_PATTERN.test(text)).map(parseDate))];
    if (dates.length !== 1) throw new Error('CHART_DATE_AMBIGUOUS');
    if (dates[0] > new Date().toISOString().slice(0,10)) throw new Error('CHART_DATE_IN_FUTURE');
    return { code, date: dates[0] };
  } catch (error) {
    // Restrict diagnostics to known codes; never print browser state or responses.
    return { code, error: /^(PAGE_HTTP_|CHART_DATE_)/.test(error.message) ? error.message : 'CHART_DATE_UNAVAILABLE' };
  } finally { await page.close(); }
}

const started = Date.now();
const browser = await chromium.launch({ headless: true });
let observations;
try {
  const context = await browser.newContext({ locale: 'en-GB', timezoneId: 'UTC', serviceWorkers: 'block' });
  await context.route('**/*', route => ['image', 'media', 'font'].includes(route.request().resourceType()) ? route.abort() : route.continue());
  observations = await Promise.all(codes.map(code => readMarket(context, code)));
} finally { await browser.close(); }
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), browserSeconds: (Date.now() - started) / 1000, observations }, null, 2));
if (observations.some(item => item.error)) process.exitCode = 1;
if (!probe && ingest) {
  const body=JSON.stringify({observations});
  const time=String(Math.floor(Date.now()/1000));
  const response=await fetch(ingest, {
    method:'POST', signal:AbortSignal.timeout(30000),
    headers:{'Content-Type':'application/json','X-Monitor-Time':time,'X-Monitor-Signature':createHmac('sha256',process.env.INGEST_SECRET).update(`${time}.${body}`).digest('base64url')},body,
  });
  if(!response.ok) throw new Error(`INGEST_HTTP_${response.status()}`);
  console.log('Chart dates accepted by the private subscription service.');
} else if (!probe) {
  let previous;
  try { previous = JSON.parse(await readFile(statePath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; previous = {}; }
  const state = updateState(previous, observations, new Date().toISOString());
  await persist(state);
  while (state.pending.length) {
    const event = state.pending[0];
    // Resend deduplicates retries for 24h. Stop automatic retries after that
    // window so a long outage cannot silently produce duplicate email.
    if (Date.now() - Date.parse(event.createdAt) > 23 * 3600 * 1000) {
      throw new Error('EMAIL_OUTBOX_EXPIRED: review pending events before retrying');
    }
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST', signal: AbortSignal.timeout(20000),
      headers: { Authorization: `Bearer ${email.key}`, 'Content-Type': 'application/json', 'Idempotency-Key': event.id },
      body: JSON.stringify({ from: email.from, to: [email.to], subject: event.subject, text: event.text }),
    });
    if (!response.ok) throw new Error(`EMAIL_HTTP_${response.status()}: email remains queued`);
    state.pending.shift();
    await persist(state);
    console.log(`Email accepted for ${event.id}`);
  }
}
