import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
// Load root-level .env in this package directory first (not relying on ESM loader order)
try {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const primaryEnv = path.join(thisDir, '.env');
  const parentEnv = path.join(thisDir, '..', '.env');
  // Load local first, then parent (parent may override if needed)
  dotenv.config({ path: primaryEnv });
  dotenv.config({ path: parentEnv });
  if (!process.env.PUPIL_ID || !process.env.CLASS_YEAR_ID) {
    // final attempt: log what we have
    if (process.env.DEBUG || process.env.SHKOLO_DEBUG) {
      console.error('[env-debug] Tried .env paths:', primaryEnv, parentEnv);
      console.error('[env-debug] Current PUPIL_ID=', process.env.PUPIL_ID, ' CLASS_YEAR_ID=', process.env.CLASS_YEAR_ID);
    }
  }
} catch (e) {
  // ignore
}
import fetchOrig from 'node-fetch';
import fetchCookie from 'fetch-cookie';
import { CookieJar } from 'tough-cookie';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { writeFile } from 'fs/promises';

// Wrap fetch with a cookie jar
const jar = new CookieJar();
const fetch = fetchCookie(fetchOrig, jar);

export const BASE = 'https://app.shkolo.bg';

// Session cache (in-memory). If we logged in recently, reuse cookies & csrf.
let sessionCache = {
  csrf: null,
  loggedAt: 0,
  username: null
};
const SESSION_TTL_MS = 3 * 60 * 60 * 1000; // 3 hours
// const SESSION_TTL_MS = 2 * 60 * 1000; // TESTING

export function nowISOWeek(date = new Date()) {
  // ISO week calculation
  const tmp = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = tmp.getUTCDay() || 7; // 1..7
  tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(),0,1));
  const weekNo = Math.ceil(((tmp - yearStart) / 86400000 + 1) / 7);
  // console.log(`[i] Current ISO week number is ${weekNo}`);
  return weekNo;
}

async function getLoginPage() {
  await fetch(`${BASE}/auth/logout`, {
    method: 'GET',
    headers: {
      'User-Agent': fingerprint().userAgent,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    }
  }).catch(() => {/* ignore errors */});
  const res = await fetch(`${BASE}/auth/login`, {
    headers: {
      'User-Agent': fingerprint().userAgent,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Cookie': '' // avoid sending old cookies
    }
  });
  if (!res.ok) throw new Error(`Login page failed: ${res.status}`);
  const html = await res.text();
  const tokenMatch = html.match(/name="_token"\s+value="([^"]+)"/);
  if (!tokenMatch) throw new Error('Could not extract CSRF _token');
  return tokenMatch[1];
}

export function fingerprint() {
  return {
    visitor_id: process.env.FINGERPRINT_VISITOR_ID || 'visitor_placeholder',
    userAgent: process.env.FINGERPRINT_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:142.0) Gecko/20100101 Firefox/142.0',
    timezone: process.env.FINGERPRINT_TIMEZONE || 'Europe/Sofia',
    webgl_vendor: process.env.FINGERPRINT_WEBGL_VENDOR || 'webgl_vendor_placeholder',
    fonts: process.env.FINGERPRINT_FONTS || 'fonts_placeholder',
    canvas_hash: process.env.FINGERPRINT_CANVAS_HASH || 'canvas_hash_placeholder',
    audio_hash: process.env.FINGERPRINT_AUDIO_HASH || 'audio_hash_placeholder',
    browser_hash: process.env.FINGERPRINT_BROWSER_HASH || 'browser_hash_placeholder'
  };
}

function formEncode(obj) {
  return Object.entries(obj)
    .map(([k,v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
    .join('&');
}

async function listCookies() {
  return new Promise((resolve, reject) => {
    jar.getCookies(BASE, (err, cookies) => {
      if (err) return reject(err);
      resolve(cookies.map(c=>c.key));
    });
  });
}

async function login(username, password, debug=false) {
  const _token = await getLoginPage();
  const fp = fingerprint();
  if (debug) {
    console.log('[D] Login fingerprint UA:', fp.userAgent);
    console.log('[D] _token prefix:', _token.slice(0,8));
  }
  const bodyObj = {
    _token,
    'fingerprint[visitor_id]': fp.visitor_id,
    'fingerprint[user_agent]': fp.userAgent,
    'fingerprint[timezone]': fp.timezone,
    'fingerprint[webgl_vendor]': fp.webgl_vendor,
    'fingerprint[fonts]': fp.fonts,
    'fingerprint[canvas_hash]': fp.canvas_hash,
    'fingerprint[audio_hash]': fp.audio_hash,
    'fingerprint[browser_hash]': fp.browser_hash,
    login: username,
    password: password,
    remember: 1
  };
  if (debug) console.log('[D] Login POST body keys:', Object.keys(bodyObj));
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: {
      'User-Agent': fp.userAgent,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Accept-Encoding': 'gzip, deflate, br, zstd',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Origin': BASE,
      'Connection': 'keep-alive',
      'Referer': `${BASE}/auth/login`,
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-User': '?1',
      'Priority': 'u=0, i'
    },
    body: formEncode(bodyObj),
    redirect: 'manual'
  });
  if (debug) {
    console.log('[D] Login response status:', res.status);
    console.log('[D] Location header:', res.headers.get('location'));
    console.log('[D] Set-Cookie count:', (res.headers.raw()['set-cookie']||[]).length);
  }
  let followHtmlSnippet = '';
  let followStatus = res.status;
  if (res.status === 302) {
    const loc = res.headers.get('location');
    if (loc) {
      const follow = await fetch(loc.startsWith('http') ? loc : BASE + loc, { headers: { 'User-Agent': fp.userAgent, 'Referer': `${BASE}/auth/login` } });
      followStatus = follow.status;
      const followHtml = await follow.text().catch(()=> '');
      followHtmlSnippet = followHtml.slice(0,300).replace(/\n/g,' ');
      if (debug) {
        console.log('[D] Follow redirect status:', follow.status);
        console.log('[D] Follow snippet:', followHtmlSnippet);
      }
    }
  } else if (![200].includes(res.status)) {
    const text = await res.text().catch(()=> '');
    throw new Error(`Login failed: ${res.status} ${text.slice(0,200)}`);
  }
  if (debug) {
    console.log('[D] Cookies after login:', await listCookies());
  }
  // Warmup diary page to trigger potential additional cookies
  const warm = await fetch(`${BASE}/diary`, { headers: { 'User-Agent': fp.userAgent, 'Referer': BASE } });
  if (debug) console.log('[D] Warmup /diary status:', warm.status);
  const warmHtml = await warm.text().catch(()=> '');
  if (debug) {
    console.log('[D] Warmup snippet:', warmHtml.slice(0,160).replace(/\n/g,' '));
  }
  if (debug) console.log('[D] Cookies after warmup:', await listCookies());
  const xsrfRaw = await getCookieValue('XSRF-TOKEN');
  if (!xsrfRaw) throw new Error('Missing XSRF-TOKEN cookie after login');
  // Do NOT decode; send raw so encoding matches cookie value (Laravel expects base64/URL form)
  if (debug) {
    console.log('[D] XSRF raw prefix:', xsrfRaw.slice(0,12));
  }
  // Heuristic: if still on login page (form present) after warmup, credentials likely invalid
  if (followStatus === 302 && followHtmlSnippet.includes('name="login"') && warmHtml.includes('name="password"')) {
    console.warn('[W] Login form still present; credentials may be invalid or extra fingerprint fields required.');
  }
  return xsrfRaw; // return raw token now
}

function getCookieValue(name) {
  return new Promise((resolve, reject) => {
    jar.getCookies(BASE, (err, cookies) => {
      if (err) return reject(err);
      const c = cookies.find(c=>c.key === name);
      resolve(c ? c.value : undefined);
    });
  });
}

export async function fetchSchedule({ pupilId, classYearId, week, year, outFile = 'schedule.html', forceLogin = false, debug=false }) {
  const username = process.env.SHKOLO_USERNAME;
  const password = process.env.SHKOLO_PASSWORD;
  if (!username || !password) throw new Error('Missing SHKOLO_USERNAME or SHKOLO_PASSWORD in environment');
  let csrf;
  const now = Date.now();
  if (!forceLogin && sessionCache.csrf && sessionCache.username === username && (now - sessionCache.loggedAt) < SESSION_TTL_MS) {
    csrf = sessionCache.csrf;
    console.log('[*] Reusing cached session');
  } else {
    console.log('[*] Logging in (new session)...');
    csrf = await login(username, password, debug);
    sessionCache = { csrf, loggedAt: now, username };
    console.log('[*] Logged in, CSRF token acquired');
  }
  if (debug) {
    console.log('[D] CSRF token prefix:', csrf.slice(0,10));
  }
  const fp = fingerprint();
  const url = `${BASE}/ajax/diary/getScheduleForClass?pupil_id=${encodeURIComponent(pupilId)}&year=${encodeURIComponent(year)}&week=${encodeURIComponent(week)}&class_year_id=${encodeURIComponent(classYearId)}&_=${Date.now()}`;
  if (debug) {
    console.log('[D] Schedule URL:', url);
  }
  const cookiesHeader = await buildCookieHeader();
  if (debug) {
    const maskCookie = (c)=> c.length>20 ? c.slice(0,10)+'...'+c.slice(-5) : c;
    console.log('[D] Cookie header parts:', cookiesHeader.split('; ').map(maskCookie));
  }
  const res = await fetch(url, {
    headers: {
      'User-Agent': fp.userAgent,
      'Accept': 'text/html, */*; q=0.01',
      'Accept-Language': 'en-US,en;q=0.5',
      'Accept-Encoding': 'gzip, deflate, br, zstd',
      'X-CSRF-TOKEN': csrf, // now raw
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': `${BASE}/diary`,
      'Connection': 'keep-alive',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
      'TE': 'trailers',
      'Cookie': cookiesHeader
    }
  });
  if (debug) {
    console.log('[D] Schedule request headers:', {
      'User-Agent': fp.userAgent,
      'X-CSRF-TOKEN': csrf.slice(0,10)+'...',
      'CookieKeys': cookiesHeader.split('; ').map(c=>c.split('=')[0])
    });
    console.log('[D] Schedule response status:', res.status);
  }
  if (!res.ok) {
    const text = await res.text().catch(()=> '');
    if (debug) {
      console.log('[D] Failure body snippet:', text.slice(0,300));
    }
    if (res.status === 401 && !forceLogin) {
      if (debug) console.log('[D] 401 received – retrying once with forced login');
      sessionCache.csrf = null; // invalidate
      return await fetchSchedule({ pupilId, classYearId, week, year, outFile, forceLogin: true, debug });
    }
    throw new Error(`Schedule request failed: ${res.status} ${text.slice(0,200)}`);
  }
  const html = await res.text();
  if (debug) {
    console.log('[D] HTML length:', html.length);
    console.log('[D] HTML snippet:', html.slice(0,200).replace(/\n/g,' '));
  }
  await writeFile(outFile, html, 'utf8');
  console.log(`[*] Saved schedule HTML to ${outFile}`);
  return html;
}

function buildCookieHeader() {
  return new Promise((resolve, reject) => {
    jar.getCookies(BASE, (err, cookies) => {
      if (err) return reject(err);
      resolve(cookies.map(c=>`${c.key}=${c.value}`).join('; '));
    });
  });
}

export async function main() {
  if (process.env.SHKOLO_DEBUG || process.argv.includes('--debug')) {
    console.error('[env-debug] Raw env PUPIL_ID=', process.env.PUPIL_ID, ' CLASS_YEAR_ID=', process.env.CLASS_YEAR_ID);
  }
  const argv = yargs(hideBin(process.argv))
  .option('pupil', { type: 'string', describe: 'pupil_id', default: process.env.PUPIL_ID })
  .option('class-year', { type: 'string', describe: 'class_year_id', default: process.env.CLASS_YEAR_ID })
    .option('week', { type: 'number', describe: 'Week number', default: nowISOWeek() })
    .option('year', { type: 'number', describe: 'Two-digit year used by endpoint', default: new Date().getFullYear() % 100 })
    .option('out', { type: 'string', describe: 'Output HTML file', default: 'schedule.html' })
    .option('force-login', { type: 'boolean', describe: 'Force new login ignoring cached session', default: false })
    .option('debug', { type: 'boolean', describe: 'Verbose debug output', default: !!process.env.SHKOLO_DEBUG })
    .option('username', { type: 'string', describe: 'Login username (overrides SHKOLO_USERNAME)' })
    .option('password', { type: 'string', describe: 'Login password (overrides SHKOLO_PASSWORD)' })
    .help()
    .argv;
  const { pupil: pupilId, classYear: classYearId, week, year, out: outFile, forceLogin, debug, username, password } = argv;
  // Allow passing credentials via CLI instead of env
  if (username) process.env.SHKOLO_USERNAME = username;
  if (password) process.env.SHKOLO_PASSWORD = password;
  if (!pupilId || !classYearId) {
    const envLocHint = 'shkolo-programa-api/.env';
    console.error('Missing --pupil and/or --class-year (or env PUPIL_ID / CLASS_YEAR_ID)');
    if (!process.env.PUPIL_ID) console.error(`[hint] PUPIL_ID not set (check ${envLocHint})`);
    if (!process.env.CLASS_YEAR_ID) console.error(`[hint] CLASS_YEAR_ID not set (check ${envLocHint})`);
    process.exit(1);
  }
  try {
    await fetchSchedule({ pupilId, classYearId, week, year, outFile, forceLogin, debug });
  } catch (e) {
    console.error('[!] Error:', e.message);
    if (debug) {
      console.error('[D] Stack:', e.stack);
    }
    process.exit(1);
  }
}

// Run CLI only when executed directly, not when imported.
// Cross-platform direct-run detection (Windows paths, spaces, etc.)
try {
  const thisFilePath = fileURLToPath(import.meta.url);
  if (process.argv[1] && thisFilePath === process.argv[1]) {
    await main();
  }
} catch (_) {
  // Fallback: still attempt to run if no argv[1]
  if (process.argv.length <= 2) {
    await main();
  }
}