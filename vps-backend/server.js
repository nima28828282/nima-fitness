/* Standalone payment backend for ورز, meant to run on a VPS with a fixed
   public IP — the one thing Netlify Functions can't offer, and the one
   thing ZarinPal's IP allowlist needs. Everything else (the marketing
   site, the app itself, /pay.html and /pay-result.html) still lives on
   Netlify; only these two endpoints move here. pay.html and
   pay-result.html call this server's URL directly (see BACKEND_URL in
   those files) instead of /.netlify/functions/*.

   Zero npm dependencies on purpose — just Node's built-in http module —
   so there's nothing to install on the VPS: copy this folder over and
   run `node server.js` (after copying .env.example to .env and filling
   in real values). Put this behind Nginx/Caddy with a real TLS
   certificate — browsers won't call a plain-http API from an https page. */

const http = require('http');

// --- tiny built-in .env loader (KEY=VALUE lines, # comments, blank lines
// skipped; anything already in the real environment wins) ---
(function loadDotEnv() {
  const fs = require('fs');
  const path = require('path');
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
})();

const SUBSCRIPTION_PRICE_RIALS = 890000; // 89,000 تومان
const SUBSCRIPTION_DESCRIPTION = 'اشتراک یک‌ماهه ورز';
const SUBSCRIPTION_DAYS = 30;

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error('Missing required env var: ' + name);
  return v;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) { req.destroy(); reject(new Error('body_too_large')); }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': process.env.CORS_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(body);
}

async function handleZarinpalRequest(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: 'invalid_body' }); }

  let phone = String(body.phone || '').replace(/[^\d]/g, '');
  if (!/^0?9\d{9}$/.test(phone)) return sendJson(res, 400, { error: 'invalid_phone' });
  if (phone.length === 10) phone = '0' + phone;

  let merchantId, siteUrl;
  try {
    merchantId = required('ZARINPAL_MERCHANT_ID');
    siteUrl = required('SITE_URL');
  } catch (e) {
    return sendJson(res, 500, { error: 'not_configured', message: e.message });
  }

  const sandbox = process.env.ZARINPAL_SANDBOX === '1';
  const requestUrl = sandbox
    ? 'https://sandbox.zarinpal.com/pg/v4/payment/request.json'
    : 'https://api.zarinpal.com/pg/v4/payment/request.json';
  const callbackUrl = siteUrl.replace(/\/$/, '') + '/pay-result.html?phone=' + encodeURIComponent(phone);

  try {
    const zRes = await fetch(requestUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        merchant_id: merchantId,
        amount: SUBSCRIPTION_PRICE_RIALS,
        callback_url: callbackUrl,
        description: SUBSCRIPTION_DESCRIPTION,
        metadata: { mobile: phone }
      })
    });
    const data = await zRes.json();
    if (data && data.data && data.data.code === 100 && data.data.authority) {
      const startPayBase = sandbox
        ? 'https://sandbox.zarinpal.com/pg/StartPay/'
        : 'https://www.zarinpal.com/pg/StartPay/';
      return sendJson(res, 200, { redirectUrl: startPayBase + data.data.authority });
    }
    return sendJson(res, 502, { error: 'zarinpal_rejected', details: data });
  } catch (e) {
    return sendJson(res, 502, { error: 'zarinpal_unreachable', message: String(e) });
  }
}

async function handleZarinpalVerify(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: 'invalid_body' }); }

  const authority = String(body.authority || '');
  let phone = String(body.phone || '').replace(/[^\d]/g, '');
  if (!authority || !phone) return sendJson(res, 400, { error: 'missing_fields' });
  if (phone.length === 10) phone = '0' + phone;

  let merchantId, supabaseUrl, serviceKey;
  try {
    merchantId = required('ZARINPAL_MERCHANT_ID');
    supabaseUrl = required('SUPABASE_URL');
    serviceKey = required('SUPABASE_SERVICE_ROLE_KEY');
  } catch (e) {
    return sendJson(res, 500, { error: 'not_configured', message: e.message });
  }

  const sandbox = process.env.ZARINPAL_SANDBOX === '1';
  const verifyUrl = sandbox
    ? 'https://sandbox.zarinpal.com/pg/v4/payment/verify.json'
    : 'https://api.zarinpal.com/pg/v4/payment/verify.json';

  let verifyData;
  try {
    const zRes = await fetch(verifyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ merchant_id: merchantId, amount: SUBSCRIPTION_PRICE_RIALS, authority })
    });
    verifyData = await zRes.json();
  } catch (e) {
    return sendJson(res, 502, { error: 'zarinpal_unreachable', message: String(e) });
  }

  const code = verifyData && verifyData.data && verifyData.data.code;
  if (code !== 100 && code !== 101) {
    return sendJson(res, 200, { ok: false, code, details: verifyData });
  }
  const refId = verifyData.data.ref_id;

  let userId;
  try {
    const profRes = await fetch(
      supabaseUrl.replace(/\/$/, '') + '/rest/v1/profiles?phone=eq.' + encodeURIComponent(phone) + '&select=id',
      { headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey } }
    );
    const profRows = await profRes.json();
    if (!Array.isArray(profRows) || !profRows.length) {
      return sendJson(res, 404, { ok: false, error: 'no_account_for_phone', refId });
    }
    userId = profRows[0].id;
  } catch (e) {
    return sendJson(res, 502, { ok: false, error: 'supabase_unreachable', message: String(e), refId });
  }

  let baseDate = new Date();
  try {
    const subRes = await fetch(
      supabaseUrl.replace(/\/$/, '') + '/rest/v1/subscriptions?user_id=eq.' + userId + '&select=current_period_end',
      { headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey } }
    );
    const subRows = await subRes.json();
    if (Array.isArray(subRows) && subRows[0] && subRows[0].current_period_end) {
      const existingEnd = new Date(subRows[0].current_period_end);
      if (existingEnd > baseDate) baseDate = existingEnd;
    }
  } catch (e) {
    // not fatal — fall through with baseDate = now
  }
  const newPeriodEnd = new Date(baseDate.getTime() + SUBSCRIPTION_DAYS * 86400000);

  try {
    const upsertRes = await fetch(
      supabaseUrl.replace(/\/$/, '') + '/rest/v1/subscriptions?on_conflict=user_id',
      {
        method: 'POST',
        headers: {
          apikey: serviceKey,
          Authorization: 'Bearer ' + serviceKey,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=representation'
        },
        body: JSON.stringify([{
          user_id: userId,
          status: 'active',
          current_period_end: newPeriodEnd.toISOString(),
          last_payment_ref_id: String(refId)
        }])
      }
    );
    if (!upsertRes.ok) {
      const errBody = await upsertRes.text();
      return sendJson(res, 502, { ok: false, error: 'subscription_write_failed', details: errBody, refId });
    }
  } catch (e) {
    return sendJson(res, 502, { ok: false, error: 'subscription_write_failed', message: String(e), refId });
  }

  return sendJson(res, 200, { ok: true, refId, periodEnd: newPeriodEnd.toISOString() });
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': process.env.CORS_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }
  const url = req.url.split('?')[0];
  if (req.method === 'GET' && url === '/api/health') {
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url === '/api/zarinpal-request') {
    return handleZarinpalRequest(req, res).catch((e) => sendJson(res, 500, { error: 'internal', message: String(e) }));
  }
  if (req.method === 'POST' && url === '/api/zarinpal-verify') {
    return handleZarinpalVerify(req, res).catch((e) => sendJson(res, 500, { error: 'internal', message: String(e) }));
  }
  sendJson(res, 404, { error: 'not_found' });
});

const port = process.env.PORT || 3000;
server.listen(port, () => console.log('vaarz payment backend listening on port ' + port));
