import http from 'node:http';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
const username = process.env.APP_USERNAME;
const password = process.env.APP_PASSWORD;
const sessionSecret = process.env.APP_SESSION_SECRET;
const isProduction = process.env.NODE_ENV === 'production';

if (!username || !password || !sessionSecret) {
  console.error('Faltan APP_USERNAME, APP_PASSWORD o APP_SESSION_SECRET.');
  process.exit(1);
}

const indexHtml = await readFile(join(__dirname, 'index.html'));
const sessionDurationMs = 12 * 60 * 60 * 1000;

function securityHeaders(extra = {}) {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cache-Control': 'no-store',
    ...extra,
  };
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, securityHeaders(headers));
  res.end(body);
}

function parseCookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || '')
      .split(';')
      .map(v => v.trim())
      .filter(Boolean)
      .map(v => {
        const i = v.indexOf('=');
        return [v.slice(0, i), decodeURIComponent(v.slice(i + 1))];
      })
  );
}

function sign(value) {
  return crypto.createHmac('sha256', sessionSecret).update(value).digest('base64url');
}

function createSession() {
  const payload = Buffer.from(JSON.stringify({
    user: username,
    exp: Date.now() + sessionDurationMs,
  })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function validSession(req) {
  const token = parseCookies(req).ruano_session;
  if (!token) return false;
  const [payload, signature] = token.split('.');
  if (!payload || !signature || !safeEqual(signature, sign(payload))) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data.user === username && Number(data.exp) > Date.now();
  } catch {
    return false;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 10_000) {
        reject(new Error('Petición demasiado grande'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

const loginPage = (error = '') => `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Acceso · Ruano Social Studio</title>
  <style>
    *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f7fa;color:#172438;font-family:Arial,sans-serif;padding:20px}
    main{width:min(420px,100%);background:#fff;border:1px solid #e2e8ef;border-radius:18px;padding:34px;box-shadow:0 18px 55px rgba(16,42,71,.1)}
    .logo{width:58px;height:58px;border-radius:50%;display:grid;place-items:center;background:#0b315f;color:#fff;font:700 30px Georgia;margin-bottom:22px}
    h1{font-family:Georgia,serif;color:#132d4d;margin:0 0 8px}p{color:#718095;font-size:14px;line-height:1.5}
    label{display:grid;gap:7px;margin-top:17px;font-size:13px;font-weight:700;color:#425168}
    input{width:100%;border:1px solid #d5dee7;border-radius:10px;padding:12px;font:inherit}
    input:focus{outline:3px solid #e1edf8;border-color:#5d8ebb}
    button{width:100%;border:0;border-radius:10px;padding:13px;margin-top:22px;background:#0d447f;color:#fff;font-weight:700;cursor:pointer}
    .error{background:#fdecec;color:#a33b3b;border-radius:9px;padding:10px;margin-top:15px;font-size:13px}
  </style>
</head>
<body><main>
  <div class="logo">R</div>
  <h1>Ruano Social Studio</h1>
  <p>Acceso privado al planificador de contenidos de Ruano Inmobiliaria.</p>
  ${error ? '<div class="error">Usuario o contraseña incorrectos.</div>' : ''}
  <form method="post" action="/login">
    <label>Usuario<input name="username" autocomplete="username" required autofocus></label>
    <label>Contraseña<input name="password" type="password" autocomplete="current-password" required></label>
    <button type="submit">Entrar</button>
  </form>
</main></body></html>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/health') {
    return send(res, 200, 'ok', { 'Content-Type': 'text/plain; charset=utf-8' });
  }

  if (url.pathname === '/login' && req.method === 'GET') {
    if (validSession(req)) {
      res.writeHead(302, { Location: '/' });
      return res.end();
    }
    return send(res, 200, loginPage(url.searchParams.has('error')), {
      'Content-Type': 'text/html; charset=utf-8',
    });
  }

  if (url.pathname === '/login' && req.method === 'POST') {
    try {
      const form = new URLSearchParams(await readBody(req));
      const ok = safeEqual(form.get('username') || '', username)
        && safeEqual(form.get('password') || '', password);
      if (!ok) {
        res.writeHead(303, { Location: '/login?error=1' });
        return res.end();
      }
      const secure = isProduction ? '; Secure' : '';
      res.writeHead(303, {
        Location: '/',
        'Set-Cookie': `ruano_session=${encodeURIComponent(createSession())}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure}`,
      });
      return res.end();
    } catch {
      return send(res, 400, 'Petición no válida');
    }
  }

  if (url.pathname === '/logout') {
    res.writeHead(303, {
      Location: '/login',
      'Set-Cookie': 'ruano_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
    });
    return res.end();
  }

  if (!validSession(req)) {
    res.writeHead(302, { Location: '/login' });
    return res.end();
  }

  if ((url.pathname === '/' || url.pathname === '/index.html') && req.method === 'GET') {
    return send(res, 200, indexHtml, { 'Content-Type': 'text/html; charset=utf-8' });
  }

  return send(res, 404, 'No encontrado', { 'Content-Type': 'text/plain; charset=utf-8' });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Ruano Social Studio escuchando en el puerto ${port}`);
});
