import http from 'node:http';
import crypto from 'node:crypto';
import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
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

// Datos persistentes: en producción /app/data es un volumen de Easypanel
const dataDir = process.env.DATA_DIR || join(__dirname, 'data');
const stateFile = join(dataDir, 'state.json');
const photosDir = join(dataDir, 'photos');
await mkdir(photosDir, { recursive: true });
const MAX_STATE_BYTES = 5 * 1024 * 1024;
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;

const safeRef = r => (/^[A-Za-z0-9_-]{1,40}$/.test(r || '') ? r : null);
const safeId = i => (/^[a-f0-9]{24}$/.test(i || '') ? i : null);

// Serializa las escrituras por clave para que no se pisen
const locks = new Map();
function withLock(key, fn) {
  const run = (locks.get(key) || Promise.resolve()).then(fn, fn);
  locks.set(key, run.catch(() => {}));
  return run;
}

async function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('Petición demasiado grande'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readManifest(ref) {
  try {
    return JSON.parse(await readFile(join(photosDir, ref, 'index.json'), 'utf8'));
  } catch {
    return { photos: [] };
  }
}

const writeManifest = (ref, manifest) =>
  writeAtomic(join(photosDir, ref, 'index.json'), JSON.stringify(manifest));
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

function sendJson(res, status, data) {
  send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8' });
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/state') {
    if (req.method === 'GET') {
      try {
        return send(res, 200, await readFile(stateFile), { 'Content-Type': 'application/json; charset=utf-8' });
      } catch (err) {
        if (err.code === 'ENOENT') return sendJson(res, 200, {});
        throw err;
      }
    }
    if (req.method === 'PUT') {
      const body = await readRaw(req, MAX_STATE_BYTES);
      const data = JSON.parse(body.toString('utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) return sendJson(res, 400, { error: 'Formato no válido' });
      data.savedAt = new Date().toISOString();
      await withLock('state', () => writeAtomic(stateFile, JSON.stringify(data)));
      return sendJson(res, 200, { ok: true, savedAt: data.savedAt });
    }
    return sendJson(res, 405, { error: 'Método no permitido' });
  }

  // /api/photos/:ref  y  /api/photos/:ref/:id(.webp|.jpg)
  const m = url.pathname.match(/^\/api\/photos\/([^/]+)(?:\/([^/.]+)(\.(?:jpg|webp))?)?$/);
  if (!m) return sendJson(res, 404, { error: 'No encontrado' });
  const ref = safeRef(decodeURIComponent(m[1]));
  if (!ref) return sendJson(res, 400, { error: 'Referencia no válida' });
  const dir = join(photosDir, ref);

  if (!m[2]) {
    if (req.method === 'GET') return sendJson(res, 200, await readManifest(ref));
    if (req.method === 'POST') {
      const body = await readRaw(req, MAX_PHOTO_BYTES);
      // Se guardan en WebP (ocupa menos); JPG como alternativa para navegadores sin WebP
      const isWebp = body.length > 12 && body.toString('ascii', 0, 4) === 'RIFF' && body.toString('ascii', 8, 12) === 'WEBP';
      const isJpg = body.length > 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff;
      if (!isWebp && !isJpg) return sendJson(res, 400, { error: 'Solo se admiten fotos WebP o JPG' });
      const id = crypto.randomBytes(12).toString('hex');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${id}.${isWebp ? 'webp' : 'jpg'}`), body);
      await withLock(ref, async () => {
        const manifest = await readManifest(ref);
        manifest.photos.push({ id, adjust: null });
        await writeManifest(ref, manifest);
      });
      return sendJson(res, 201, { id, bytes: body.length });
    }
    if (req.method === 'PUT') {
      // Orden y ajustes; solo se aceptan fotos que ya existen
      const data = JSON.parse((await readRaw(req, 256 * 1024)).toString('utf8'));
      const result = await withLock(ref, async () => {
        const known = new Set((await readManifest(ref)).photos.map(p => p.id));
        const photos = (Array.isArray(data.photos) ? data.photos : [])
          .filter(p => p && known.has(p.id))
          .map(p => ({ id: p.id, adjust: p.adjust && typeof p.adjust === 'object' ? p.adjust : null }));
        await mkdir(dir, { recursive: true });
        await writeManifest(ref, { photos });
        return photos.length;
      });
      return sendJson(res, 200, { ok: true, photos: result });
    }
    return sendJson(res, 405, { error: 'Método no permitido' });
  }

  const id = safeId(m[2]);
  if (!id) return sendJson(res, 400, { error: 'Foto no válida' });
  if (req.method === 'GET') {
    for (const [ext, type] of [['webp', 'image/webp'], ['jpg', 'image/jpeg']]) {
      try {
        return send(res, 200, await readFile(join(dir, `${id}.${ext}`)), {
          'Content-Type': type,
          'Cache-Control': 'private, max-age=31536000, immutable',
        });
      } catch {}
    }
    return sendJson(res, 404, { error: 'Foto no encontrada' });
  }
  if (req.method === 'DELETE') {
    await withLock(ref, async () => {
      const manifest = await readManifest(ref);
      manifest.photos = manifest.photos.filter(p => p.id !== id);
      await writeManifest(ref, manifest);
      await unlink(join(dir, `${id}.webp`)).catch(() => {});
      await unlink(join(dir, `${id}.jpg`)).catch(() => {});
    });
    return sendJson(res, 200, { ok: true });
  }
  return sendJson(res, 405, { error: 'Método no permitido' });
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
</main>
<script>try{if(location.hash.startsWith('#importar='))sessionStorage.setItem('ruanoPendingImport',location.hash.slice(10))}catch(e){}</script>
</body></html>`;

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
    if (url.pathname.startsWith('/api/')) return sendJson(res, 401, { error: 'Sesión caducada' });
    res.writeHead(302, { Location: '/login' });
    return res.end();
  }

  if (url.pathname.startsWith('/api/')) {
    try {
      return await handleApi(req, res, url);
    } catch (err) {
      console.error('Error en', req.method, url.pathname, err.message);
      return sendJson(res, err.status || (err instanceof SyntaxError ? 400 : 500), { error: err.status ? err.message : 'No se pudo completar la operación' });
    }
  }

  if ((url.pathname === '/' || url.pathname === '/index.html') && req.method === 'GET') {
    return send(res, 200, indexHtml, { 'Content-Type': 'text/html; charset=utf-8' });
  }

  return send(res, 404, 'No encontrado', { 'Content-Type': 'text/plain; charset=utf-8' });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Ruano Social Studio escuchando en el puerto ${port}`);
});
