import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { database, withOrganization } from './db.mjs';
import { newToken, tokenHash, sessionToken, verifyPassword, hashPassword, requireSameOrigin, LoginLimiter } from './security.mjs';
import { validateState } from './state.mjs';
import { loginPage } from './login.mjs';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export async function createApp({ pool, origin, production = false }) {
  if (!origin || new URL(origin).origin !== origin || (production && !origin.startsWith('https://')))
    throw new Error('APP_ORIGIN debe ser válido; producción exige HTTPS');
  const html = await readFile(new URL('./index.html', import.meta.url));
  const browserScript = await readFile(new URL('./saas-client.js', import.meta.url));
  const limiter = new LoginLimiter();
  const networkLimiter = new LoginLimiter(100);
  const dummyHash = await hashPassword(newToken());
  function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
    res.writeHead(status, {
      'Content-Type':type, 'X-Content-Type-Options':'nosniff', 'X-Frame-Options':'DENY',
      'Referrer-Policy':'same-origin', 'Cache-Control':'no-store',
      'Permissions-Policy':'camera=(), microphone=(), geolocation=()',
      'Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      ...extra,
    });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  }
  function redirect(res, location, cookie) {
    send(res,303,'','text/plain',{Location:location,...(cookie ? {'Set-Cookie':cookie} : {})});
  }
  async function readBody(req, max = 2_000_000) {
    let size = 0; const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > max) { const error = new Error('Petición demasiado grande'); error.status = 413; throw error; }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  async function identity(req) {
    const token = sessionToken(req); if (!token) return null;
    const {rows} = await pool.query(`SELECT u.id,u.email FROM rss_sessions s JOIN rss_users u ON u.id=s.user_id
      WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active=true`,[tokenHash(token)]);
    return rows[0] || null;
  }
  return http.createServer(async (req,res) => {
    try {
      const url = new URL(req.url,origin);
      if (url.pathname === '/health' && req.method === 'GET') {
        await pool.query('SELECT 1'); return send(res,200,'ok','text/plain');
      }
      if (!['GET','HEAD'].includes(req.method)) requireSameOrigin(req,origin);
      if (url.pathname === '/login' && req.method === 'GET') {
        if (await identity(req)) return redirect(res,'/');
        return send(res,200,loginPage(url.searchParams.has('error')),'text/html; charset=utf-8');
      }
      if (url.pathname === '/login' && req.method === 'POST') {
        const form = new URLSearchParams(await readBody(req,10000));
        const email = (form.get('username') || '').trim().toLowerCase();
        // Do not trust X-Forwarded-For; add edge rate limiting for production.
        const ip = req.socket.remoteAddress || 'unknown';
        if (!networkLimiter.allow(ip) || !limiter.allow(email))
          return send(res,429,{error:'Demasiados intentos. Espera 15 minutos.'});
        const {rows} = await pool.query('SELECT id,password_hash,active FROM rss_users WHERE email=$1',[email]);
        const match = await verifyPassword(form.get('password') || '',rows[0]?.password_hash || dummyHash);
        if (!match || !rows[0]?.active) return redirect(res,'/login?error=1');
        const token = newToken();
        await pool.query("INSERT INTO rss_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '12 hours')",[tokenHash(token),rows[0].id]);
        await pool.query('DELETE FROM rss_sessions WHERE expires_at<now()');
        return redirect(res,'/',`rss_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${production ? '; Secure' : ''}`);
      }
      const user = await identity(req);
      if (!user) {
        if (url.pathname.startsWith('/api/')) return send(res,401,{error:'Debes iniciar sesión'});
        return redirect(res,'/login');
      }
      if (url.pathname === '/logout' && req.method === 'POST') {
        await pool.query('DELETE FROM rss_sessions WHERE token_hash=$1',[tokenHash(sessionToken(req))]);
        return redirect(res,'/login',`rss_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${production ? '; Secure' : ''}`);
      }
      if (url.pathname === '/api/me' && req.method === 'GET') {
        const {rows} = await pool.query(`SELECT o.id,o.name,m.role FROM rss_organizations o
          JOIN rss_memberships m ON m.organization_id=o.id WHERE m.user_id=$1 ORDER BY o.name`,[user.id]);
        return send(res,200,{user:{email:user.email},organizations:rows});
      }
      const downloadRoute = /^\/api\/organizations\/([^/]+)\/properties\/(\d+)\/export$/.exec(url.pathname);
      if (downloadRoute && req.method === 'GET') {
        if (!uuid.test(downloadRoute[1])) return send(res,404,{error:'Empresa no disponible'});
        const result = await withOrganization(pool,user.id,downloadRoute[1],async client => {
          const {rows} = await client.query('SELECT version,data FROM rss_states WHERE organization_id=$1',[downloadRoute[1]]);
          const data=rows[0]?.data, property=data?.properties.find(p=>p.id===Number(downloadRoute[2]));
          if (!property) { const e=new Error('Inmueble no disponible');e.status=404;throw e; }
          const items=data.content.filter(x=>x.propertyRef==='inmueble:'+property.id||x.propertyRef===property.reference);
          if (!items.length) { const e=new Error('Crea primero los borradores');e.status=404;throw e; }
          const fields=[['Referencia',property.reference],['Ubicación',property.location],['Precio',property.price],['Superficie construida (m²)',property.built],['Superficie útil (m²)',property.useful],['Dormitorios',property.beds],['Baños',property.baths],['Planta',property.floor],['Características',property.extras],['Enlace',property.url]].filter(x=>x[1]).map(x=>x[0]+': '+x[1]).join('\n');
          return property.title+'\n'+fields+'\n\n'+items.map(x=>x.type+' · '+x.date+' · '+x.status+'\n'+x.caption).join('\n\n────────\n\n');
        });
        return send(res,200,result,'text/plain; charset=utf-8',{'Content-Disposition':`attachment; filename="inmueble-${downloadRoute[2]}-textos.txt"`});
      }
      const route = /^\/api\/organizations\/([^/]+)\/state$/.exec(url.pathname);
      if (route) {
        if (!uuid.test(route[1])) return send(res,404,{error:'Empresa no disponible'});
        if (!['GET','PUT'].includes(req.method)) return send(res,405,{error:'Método no permitido'});
        const input = req.method === 'PUT' ? validateState(JSON.parse(await readBody(req))) : null;
        const result = await withOrganization(pool,user.id,route[1],async (client,role) => {
          if (input && role === 'viewer') { const e = new Error('Solo lectura'); e.status = 403; throw e; }
          if (input) {
            const updated = await client.query(`UPDATE rss_states SET data=$1::jsonb,version=version+1,updated_at=now()
              WHERE organization_id=$2 AND version=$3 RETURNING version,data`,[JSON.stringify(input.data),route[1],input.version]);
            if (!updated.rows.length) { const e = new Error('Otro usuario ha actualizado los datos. Recarga antes de guardar.'); e.status = 409; throw e; }
            return updated.rows[0];
          }
          const {rows} = await client.query('SELECT version,data FROM rss_states WHERE organization_id=$1',[route[1]]);
          if (!rows.length) throw new Error('Empresa sin estado inicial');
          return rows[0];
        });
        return send(res,200,result);
      }
      if (url.pathname === '/saas-client.js' && req.method === 'GET')
        return send(res,200,browserScript,'text/javascript; charset=utf-8');
      if ((url.pathname === '/' || url.pathname === '/index.html') && req.method === 'GET')
        return send(res,200,html,'text/html; charset=utf-8');
      return send(res,404,{error:'No encontrado'});
    } catch (error) {
      if (res.headersSent) return res.end();
      const status = error.status || (error instanceof SyntaxError ? 400 : 500);
      if (status === 500) console.error('Error interno de Social Studio:',error.code || error.name);
      send(res,status,{error:status === 500 ? 'Error interno. Inténtalo de nuevo.' : error.message});
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.DATABASE_URL) throw new Error('Falta DATABASE_URL');
  const pool = database(process.env.DATABASE_URL);
  const {rows:[role]} = await pool.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user');
  if (role.rolsuper || role.rolbypassrls) throw new Error('Utiliza un usuario PostgreSQL de aplicación sin superusuario ni BYPASSRLS');
  await pool.query('SELECT version FROM rss_states LIMIT 1');
  const server = await createApp({pool,origin:process.env.APP_ORIGIN,production:process.env.NODE_ENV === 'production'});
  server.listen(Number(process.env.PORT || 3000),'0.0.0.0');
  const shutdown = () => server.close(() => pool.end().then(() => process.exit(0)));
  process.once('SIGTERM',shutdown); process.once('SIGINT',shutdown);
}
