import http from 'node:http';
import crypto from 'node:crypto';
import { readFile, writeFile, mkdir, rename, unlink, copyFile, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import nodemailer from 'nodemailer';
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
// Librería para montar el MP4 del reel en el navegador (se sirve desde aquí, sin depender de un CDN)
const mp4MuxerJs = await readFile(join(__dirname, 'node_modules', 'mp4-muxer', 'build', 'mp4-muxer.mjs')).catch(() => null);
// Logo oficial de Ruano (va incrustado en index.html); se usa en la revisión si la marca no tiene otro
const DEFAULT_LOGO = (indexHtml.toString('utf8').match(/id="officialLogo" src="(data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+)"/) || [])[1] || '';

// Datos persistentes: en producción /app/data es un volumen de Easypanel
const dataDir = process.env.DATA_DIR || join(__dirname, 'data');
const stateFile = join(dataDir, 'state.json');
const photosDir = join(dataDir, 'photos');
await mkdir(photosDir, { recursive: true });

// Copia de seguridad del estado en cada arranque; se guardan las 10 últimas
try {
  await copyFile(stateFile, join(dataDir, `state.backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
  const backups = (await readdir(dataDir)).filter(f => f.startsWith('state.backup-')).sort();
  for (const f of backups.slice(0, -10)) await unlink(join(dataDir, f));
} catch {}
const MAX_STATE_BYTES = 5 * 1024 * 1024;

// ─── Almacén por empresa (store.json): cada empresa con sus inmuebles y contenidos.
// Los navegadores envían solo lo que cambian (altas, cambios y bajas por elemento) y el servidor lo combina,
// así dos personas pueden trabajar a la vez sin pisarse. Se crea a partir del state.json antiguo la primera vez.
const storeFile = join(dataDir, 'store.json');
let storeCache = null;
function migrateLegacyState(st) {
  const parse = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };
  const brands = parse(st.ruanoBrands, []).filter(b => b && /^[A-Za-z0-9_-]{1,40}$/.test(b.id || ''));
  const bd = parse(st.ruanoBrandData, {}), active = st.ruanoActiveBrand || brands[0]?.id, data = {};
  for (const b of brands) {
    const src = b.id === active ? st : (bd[b.id] || {});
    data[b.id] = { content: parse(src.ruanoContent, []).filter(x => x && x.id != null), properties: parse(src.ruanoProperties, []).filter(x => x && x.id != null) };
  }
  return { version: 2, v: 1, brands, data };
}
async function readStore() {
  if (storeCache) return storeCache;
  try { storeCache = JSON.parse(await readFile(storeFile, 'utf8')); }
  catch (err) {
    if (err.code !== 'ENOENT') throw err;
    const legacy = await readFile(stateFile, 'utf8').catch(() => '');
    storeCache = migrateLegacyState(legacy ? JSON.parse(legacy) : {});
    if (legacy) {
      await copyFile(stateFile, join(dataDir, `state.pre-store-${Date.now()}.json`)).catch(() => {});
      await writeAtomic(storeFile, JSON.stringify(storeCache));
      console.log(`Datos convertidos al formato por empresa: ${storeCache.brands.length} empresas`);
    }
  }
  storeCache.brands ||= []; storeCache.data ||= {};
  return storeCache;
}
async function writeStore(st) { st.v = (st.v || 0) + 1; st.savedAt = new Date().toISOString(); storeCache = st; await writeAtomic(storeFile, JSON.stringify(st)); }
const brandDataOf = (st, id) => st.data[id] || { content: [], properties: [] };
async function propertyBrand(propId) {
  const st = await readStore();
  for (const [id, d] of Object.entries(st.data)) if ((d.properties || []).some(p => String(p.id) === String(propId))) return id;
  return null;
}

// ─── Usuarios: el administrador (APP_USERNAME/APP_PASSWORD) y los usuarios de cada agencia (users.json) ───
const usersFile = join(dataDir, 'users.json');
let usersCache = [];
try { usersCache = JSON.parse(await readFile(usersFile, 'utf8')); } catch {}
const hashPassword = (pw, salt) => new Promise((ok, ko) => crypto.scrypt(String(pw), salt, 64, (e, k) => (e ? ko(e) : ok(k.toString('hex')))));
const OWNER = { id: 'owner', username, name: 'Administrador', role: 'admin', brands: [] };
const canBrand = (user, id) => !!user && (user.role === 'admin' || (user.brands || []).includes(id));
const publicUser = u => ({ id: u.id, username: u.username, name: u.name || u.username, role: u.role, brands: u.brands || [], disabled: !!u.disabled, owner: u.id === 'owner' });
async function saveUsers(list) { usersCache = list; await writeAtomic(usersFile, JSON.stringify(list, null, 1)); }
async function authenticate(u, pw) {
  if (safeEqual(u, username) && safeEqual(pw, password)) return OWNER;
  const user = usersCache.find(x => x.username.toLowerCase() === String(u).toLowerCase() && !x.disabled);
  const hash = await hashPassword(pw, user ? user.salt : 'no-existe-este-usuario');
  return user && safeEqual(hash, user.hash) ? user : null;
}
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

// ===== Textos con Claude =====
// La clave va en la variable de entorno ANTHROPIC_API_KEY (Easypanel → Entorno). Sin clave, la IA queda desactivada.
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
const AI_MODEL = 'claude-opus-5-5';
const AI_MAX_PER_HOUR = 60;
const aiCalls = [];

const AI_SYSTEM = `Eres el redactor de redes sociales de Ruano Inmobiliaria, una agencia de Almería (España). Escribes en español de España, claro y cercano, para Instagram y Facebook.

Reglas que no se pueden saltar:
- Usa solo los datos de la ficha. No inventes metros, precios, estancias, orientación, vistas, distancias, servicios cercanos ni ningún otro dato. Si un dato no está, no lo menciones.
- Si la ficha incluye el certificado energético, menciónalo en la publicación.
- No escribas hashtags: la aplicación los añade después.
- No uses lenguaje discriminatorio ni dirijas el anuncio a un perfil de comprador por origen, edad, sexo, religión u otras características personales.
- Emojis con moderación (como mucho uno por párrafo) y sin abusar de mayúsculas.
- La primera línea de cada texto debe enganchar por sí sola (en Instagram solo se ven unos 125 caracteres antes del "más").
- Cierra con una llamada a la acción usando el contacto que se indica.

Formatos:
- publicacion: texto para el pie de una publicación de feed, de 500 a 1100 caracteres, en párrafos cortos. Incluye la referencia.
- carrusel: pie del carrusel (300 a 700 caracteres) y, al final, una línea "Diapositivas:" seguida de 6 a 9 líneas numeradas con el texto breve que irá sobre cada foto (de portada a cierre).
- historias: de 3 a 5 pantallas, una por línea y numeradas ("1. ..."), con frases muy cortas; la última pide escribir o usar el enlace.
- reel: guion con "Gancho:" (primeros 3 segundos), "Escenas:" (una línea por escena con el texto en pantalla) y "Cierre:", más una línea "Texto:" con un pie breve de 150 a 300 caracteres.`;

const CAMPAIGN_BRIEF = {
  nuevo: 'Presentación de un inmueble recién publicado.',
  precio: 'Bajada de precio: destaca el precio anterior y el nuevo y el ahorro, sin presionar.',
  puertas: 'Jornada de puertas abiertas: invita a visitar el día y la hora indicados y a reservar hora.',
  reservado: 'El inmueble está reservado: anúncialo sin dar el precio e invita a quien busque algo parecido en la zona a escribir.',
  vendido: 'El inmueble se ha vendido o alquilado: celébralo sin dar el precio y ofrece una valoración gratuita a propietarios de la zona.',
};
const TONES = { cercano: 'cercano y cálido', profesional: 'profesional y sobrio', lujo: 'elegante, propio de vivienda de alto standing', dinamico: 'dinámico y directo, para público joven' };
const CAPTION_KEYS = ['publicacion', 'carrusel', 'historias', 'reel'];

const clip = (v, n) => String(v ?? '').slice(0, n).trim();
function propertySheet(p = {}) {
  const rows = [
    ['Referencia', clip(p.reference, 40)], ['Título', clip(p.title, 200)], ['Operación', clip(p.operation, 20)],
    ['Zona', clip(p.location, 120)], ['Precio', clip(p.price, 40)], ['Precio anterior', clip(p.oldPrice, 40)],
    ['Superficie construida', clip(p.built, 30)], ['Superficie útil', clip(p.useful, 30)], ['Dormitorios', clip(p.beds, 30)],
    ['Baños', clip(p.baths, 30)], ['Planta', clip(p.floor, 60)], ['Extras', clip(p.extras, 600)], ['Otros datos', clip(p.other, 300)],
  ].filter(([, v]) => v);
  const desc = clip(p.description, 6000);
  return rows.map(([k, v]) => `- ${k}: ${v}`).join('\n') + (desc ? `\n- Descripción:\n${desc}` : '');
}

function aiAllowed() {
  const now = Date.now();
  while (aiCalls.length && now - aiCalls[0] > 3600_000) aiCalls.shift();
  if (aiCalls.length >= AI_MAX_PER_HOUR) return false;
  aiCalls.push(now);
  return true;
}

// Las instrucciones se escriben para Ruano; con otra empresa se cambia el nombre y la zona
function systemFor(base, brand) {
  const name = clip(brand?.name, 80), zone = clip(brand?.zone, 60);
  if (!name) return base;
  return base
    .replace('Ruano Inmobiliaria, una agencia de Almería (España)', `${name}, una inmobiliaria de ${zone || 'España'}${zone ? ' (España)' : ''}`)
    .replace('Ruano Inmobiliaria (Almería)', zone ? `${name} (${zone})` : name);
}

async function askClaude(userText, schema, brand) {
  const response = await anthropic.beta.messages.create({
    model: AI_MODEL,
    max_tokens: 16000,
    // Si Claude rechaza la petición, la API la reintenta con el modelo de respaldo recomendado
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
    system: systemFor(AI_SYSTEM, brand),
    messages: [{ role: 'user', content: userText }],
  });
  if (response.stop_reason === 'refusal') throw Object.assign(new Error('Claude no ha podido redactar este texto. Revisa la ficha e inténtalo de nuevo.'), { status: 422 });
  if (response.stop_reason === 'max_tokens') throw Object.assign(new Error('El texto ha salido demasiado largo. Inténtalo de nuevo.'), { status: 502 });
  const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
  return JSON.parse(text);
}

// ===== IA gratuita: Ollama en el propio VPS =====
// Se usa si no hay ANTHROPIC_API_KEY. Servicio "ollama" del proyecto emprendeia en Easypanel.
const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://emprendeia_ollama:11434').replace(/\/$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:3b';
const ollama = { reachable: false, hasModel: false, pulling: false, error: '' };

async function checkOllama() {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(5000) });
    const d = await r.json();
    ollama.reachable = true;
    ollama.hasModel = (d.models || []).some(m => m.name === OLLAMA_MODEL || m.model === OLLAMA_MODEL);
    ollama.error = '';
    if (!ollama.hasModel && !ollama.pulling) pullOllamaModel();
  } catch (err) {
    ollama.reachable = false;
    ollama.error = err.message;
  }
}

// Descarga el modelo la primera vez (unos 2 GB); se guarda en el volumen de Ollama
async function pullOllamaModel() {
  ollama.pulling = true;
  console.log(`Descargando el modelo ${OLLAMA_MODEL} en Ollama…`);
  try {
    const r = await fetch(`${OLLAMA_URL}/api/pull`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_MODEL, stream: false }), signal: AbortSignal.timeout(60 * 60_000),
    });
    console.log('Descarga del modelo:', r.status, (await r.text()).slice(0, 200));
  } catch (err) {
    console.error('No se pudo descargar el modelo:', err.message);
  } finally {
    ollama.pulling = false;
    checkOllama();
  }
}
if (!anthropic) { checkOllama(); setInterval(checkOllama, 60_000).unref(); }

// Instrucciones cortas y directas para un modelo pequeño que corre en CPU
const OLLAMA_SYSTEM = `Eres redactor de redes sociales de Ruano Inmobiliaria (Almería). Escribe en español de España, correcto y natural.

OBLIGATORIO:
1. Usa solo los datos de la ficha. No inventes nada.
2. Incluye siempre el precio (si lo hay) y la referencia en la publicación.
3. NO escribas hashtags (#).
4. NO digas para quién es ideal la vivienda (familias, parejas, estudiantes, etc.).
5. Como mucho 2 emojis en todo el texto.
6. Termina con una llamada a la acción y el contacto.

FORMATOS:
- publicacion: 3 o 4 párrafos cortos (400-800 caracteres). Primera frase atractiva.
- carrusel: un párrafo de 300-500 caracteres y después "Diapositivas:" con 5 a 7 líneas numeradas, una por foto.
- historias: de 3 a 5 líneas numeradas ("1. ...", "2. ..."), cada una en su propia línea, de menos de 70 caracteres.
- reel: líneas "Gancho:", "Escenas:" (varias líneas cortas), "Cierre:" y "Texto:" con un pie de 150-300 caracteres.`;

// Limpieza de lo que el modelo pequeño a veces se salta
const IDEAL_FOR = /(?:\b(?:ideal|perfect[oa]|pensad[oa])\s+)?\bpara\s+(?:una?\s+|tu\s+|su\s+)?(?:familias?|parejas?|estudiantes|jóvenes|jubilad[oa]s|niños|personas|adultos|inversores|matrimonios)\b[^,.!\n]*/giu;
function tidyText(t, kind) {
  let out = String(t || '')
    .replace(/(^|\s)#[\p{L}\p{N}_]+/gu, '')                      // hashtags
    .replace(/\b([\p{L}]{3,})\s+\1\b/giu, '$1')                    // "dúplex dúplex"
    .replace(IDEAL_FOR, '')                                        // "ideal para familias…"
    .replace(/(^|[.!?]\s*|\n)\s*,\s*/g, '$1')                       // coma suelta que queda al quitarlo
    .replace(/\.{2,}/g, '.')
    .replace(/(^|[.!?]\s+|¡|\n)(\p{Ll})/gu, (m, a, c) => a + c.toUpperCase()); // mayúscula tras quitarlo
  // Como mucho 3 emojis
  let n = 0; out = out.replace(/\p{Extended_Pictographic}️?/gu, e => (++n <= 3 ? e : '')).replace(/[ \t]{2,}/g, ' ');
  if (kind === 'historias' || kind === 'carrusel' || kind === 'reel') {
    out = out.replace(/(?<=\D)\s*(\d{1,2})\.\s*(?=\p{L}|¡|¿|\p{Extended_Pictographic})/gu, '\n$1. ') // "1. … 2. …" en líneas
      .replace(/\s*(Gancho:|Escenas:|Cierre:|Texto:|Diapositivas:)/g, '\n$1')
      .replace(/(?<=^|\s)\d{1,2}\.\s*$/, '').trim();                // número suelto al final (no "REF. 2414.")
  }
  if (kind === 'historias') {
    // Como mucho 5 pantallas, sin líneas vacías y numeradas de nuevo
    const items = out.split('\n').map(l => l.replace(/^\d{1,2}\.\s*/, '').trim()).filter(l => l.length > 2).slice(0, 5);
    out = items.map((l, i) => `${i + 1}. ${l}`).join('\n');
  }
  if (kind === 'carrusel' && !/Diapositivas:/i.test(out)) {
    out += '\n\nDiapositivas:\n1. Portada con precio y zona\n2. Salón\n3. Cocina\n4. Dormitorios\n5. Baños\n6. Detalles y extras\n7. Contacto y referencia';
  }
  return out.replace(/\s+([,.!])/g, '$1').replace(/([.!?])[.,]+/g, '$1').replace(/\n{3,}/g, '\n\n').split('\n').map(l => l.trim()).join('\n').trim();
}

// La publicación siempre acaba con referencia, precio y contacto, aunque el modelo pequeño los olvide
function ensureEssentials(texts, property = {}, campaign, contact) {
  if (!texts.publicacion) return texts;
  const ref = clip(property.reference, 40), price = ['reservado', 'vendido'].includes(campaign) ? '' : clip(property.price, 40);
  const lines = [];
  if (ref && !texts.publicacion.includes(ref)) lines.push(`REF. ${ref}`);
  if (price && !texts.publicacion.includes(price.replace(/\s*€.*/, ''))) lines.push(price);
  const tail = [lines.join(' · '), !texts.publicacion.includes(contact.split('·')[0].trim()) ? `Más información: ${contact}` : ''].filter(Boolean).join('\n');
  if (tail) texts.publicacion = `${texts.publicacion.trim()}\n\n${tail}`;
  return texts;
}

// El modelo pequeño responde mejor con un texto por petición: se piden uno a uno y se juntan
async function askOllama(userText, schema, brand) {
  const keys = Object.keys(schema.properties || {});
  if (keys.length <= 1) return askOllamaOne(userText, schema, brand);
  const out = {};
  for (const k of keys) {
    const one = { type: 'object', properties: { [k]: schema.properties[k] }, required: [k], additionalProperties: false };
    Object.assign(out, await askOllamaOne(userText.replace(/Textos que necesito: [^\n]*/, `Texto que necesito ahora: ${k}`), one, brand));
  }
  return out;
}

async function askOllamaOne(userText, schema, brand) {
  const r = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL, stream: false, format: schema, keep_alive: '15m',
      options: { temperature: 0.4, num_ctx: 4096 },
      messages: [{ role: 'system', content: systemFor(OLLAMA_SYSTEM, brand) }, { role: 'user', content: userText }],
    }),
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!r.ok) throw Object.assign(new Error('La IA del servidor ha devuelto un error. Inténtalo de nuevo.'), { status: 502 });
  const d = await r.json();
  const out = JSON.parse(d.message?.content || '{}');
  for (const k of Object.keys(schema.properties || {})) {
    if (typeof out[k] !== 'string' || out[k].trim().length < 20) {
      console.error('Ollama: respuesta vacía o incompleta', k, d.done_reason, String(d.message?.content).slice(0, 200));
      throw Object.assign(new Error('La IA del servidor ha devuelto un texto vacío. Inténtalo de nuevo.'), { status: 502 });
    }
    out[k] = tidyText(out[k], k === 'texto' ? 'publicacion' : k);
  }
  return out;
}

const aiProvider = () => (anthropic ? 'claude' : ollama.reachable && ollama.hasModel ? 'ollama' : null);

async function generateAi(userText, schema, brand) {
  const provider = aiProvider();
  if (provider === 'ollama') {
    try { return await askOllama(userText, schema, brand); }
    catch (err) {
      if (err.status) throw err;
      if (err.name === 'TimeoutError') throw Object.assign(new Error('La IA del servidor ha tardado demasiado. Inténtalo con menos textos.'), { status: 504 });
      if (err instanceof SyntaxError) throw Object.assign(new Error('La IA del servidor ha devuelto un texto incompleto. Inténtalo de nuevo.'), { status: 502 });
      throw Object.assign(new Error('No se pudo conectar con la IA del servidor (Ollama).'), { status: 502 });
    }
  }
  if (provider === 'claude') {
    try { return await askClaude(userText, schema, brand); }
    catch (err) {
      if (err instanceof Anthropic.AuthenticationError) throw Object.assign(new Error('La clave de Claude no es válida. Revísala en Easypanel.'), { status: 503 });
      if (err instanceof Anthropic.RateLimitError) throw Object.assign(new Error('Claude está saturado ahora mismo. Inténtalo en un minuto.'), { status: 429 });
      if (err instanceof Anthropic.APIConnectionError) throw Object.assign(new Error('No se pudo conectar con Claude. Inténtalo de nuevo.'), { status: 502 });
      if (err instanceof Anthropic.APIError) { console.error('Claude', err.status, err.message); throw Object.assign(new Error('Claude ha devuelto un error. Inténtalo de nuevo.'), { status: 502 }); }
      throw err;
    }
  }
  throw Object.assign(new Error('La IA no está disponible ahora mismo.'), { status: 503 });
}

// Trabajos en cola, de uno en uno (el VPS no tiene tarjeta gráfica): el navegador consulta el estado
const aiJobs = new Map();
let aiQueue = Promise.resolve();
function startAiJob(run) {
  const id = crypto.randomBytes(9).toString('hex');
  const job = { status: 'queued', created: Date.now() };
  aiJobs.set(id, job);
  for (const [k, j] of aiJobs) if (Date.now() - j.created > 3600_000) aiJobs.delete(k);
  aiQueue = aiQueue.then(async () => {
    job.status = 'running'; job.started = Date.now();
    try { job.result = await run(); job.status = 'done'; }
    catch (err) { job.status = 'error'; job.error = err.status ? err.message : 'No se pudo redactar con la IA.'; if (!err.status) console.error('IA', err); }
  });
  return id;
}

async function handleAi(req, res, url) {
  if (url.pathname === '/api/ai/status') {
    const provider = aiProvider();
    return sendJson(res, 200, {
      enabled: Boolean(provider), provider, model: provider === 'claude' ? AI_MODEL : provider === 'ollama' ? OLLAMA_MODEL : null,
      preparing: !anthropic && ollama.pulling, reachable: anthropic ? true : ollama.reachable,
    });
  }
  const jm = url.pathname.match(/^\/api\/ai\/jobs\/([a-f0-9]{18})$/);
  if (jm) {
    const job = aiJobs.get(jm[1]);
    if (!job) return sendJson(res, 404, { error: 'Trabajo no encontrado' });
    const ahead = job.status === 'queued' ? [...aiJobs.values()].filter(j => j.status !== 'done' && j.status !== 'error' && j.created < job.created).length : 0;
    return sendJson(res, 200, { status: job.status, result: job.result, error: job.error, ahead });
  }
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Método no permitido' });
  if (!aiProvider()) return sendJson(res, 503, { error: !anthropic && ollama.pulling ? 'La IA se está preparando (descargando el modelo). Inténtalo en unos minutos.' : 'La IA no está disponible ahora mismo.' });
  if (!aiAllowed()) return sendJson(res, 429, { error: 'Has llegado al límite de textos con IA de esta hora. Inténtalo más tarde.' });
  const body = JSON.parse((await readRaw(req, 64 * 1024)).toString('utf8'));
  const tone = TONES[body.tone] || TONES.cercano;
  const contact = clip(body.contact, 120) || 'pisosenalmeria.es';
  if (url.pathname === '/api/ai/captions') {
    const keys = (Array.isArray(body.types) ? body.types : []).filter(k => CAPTION_KEYS.includes(k));
    if (!keys.length) return sendJson(res, 400, { error: 'No se ha pedido ningún texto' });
    const brief = CAMPAIGN_BRIEF[body.campaign] || CAMPAIGN_BRIEF.nuevo;
    const extra = body.campaign === 'puertas' && body.openHouse ? `\nFecha y hora de la jornada: ${clip(body.openHouse, 80)}` : '';
    const schema = { type: 'object', properties: Object.fromEntries(keys.map(k => [k, { type: 'string' }])), required: keys, additionalProperties: false };
    const must = [body.property?.price && !['reservado', 'vendido'].includes(body.campaign) ? `precio ${clip(body.property.price, 40)}` : '', body.property?.reference ? `referencia REF. ${clip(body.property.reference, 40)}` : ''].filter(Boolean).join(' y ');
    const prompt = `Campaña: ${brief}${extra}${must ? `\nDatos que deben aparecer en la publicación: ${must}.` : ''}\nTono: ${tone}\nContacto para el cierre: ${contact}\nTextos que necesito: ${keys.join(', ')}\n\nFicha del inmueble:\n${propertySheet(body.property)}`;
    return sendJson(res, 202, { job: startAiJob(async () => ({ texts: ensureEssentials(await generateAi(prompt, schema, body.brand), body.property, body.campaign, contact) })) });
  }
  if (url.pathname === '/api/ai/rewrite') {
    const kind = CAPTION_KEYS.includes(body.kind) ? body.kind : 'publicacion';
    const prompt = `Mejora este texto de tipo "${kind}" manteniendo los datos y el formato indicado para ese tipo.\nTono: ${tone}\nContacto para el cierre: ${contact}\n${clip(body.instructions, 300) ? `Indicaciones: ${clip(body.instructions, 300)}\n` : ''}\nTexto actual:\n${clip(body.text, 4000)}\n\nFicha del inmueble:\n${propertySheet(body.property)}`;
    const schema = { type: 'object', properties: { texto: { type: 'string' } }, required: ['texto'], additionalProperties: false };
    return sendJson(res, 202, { job: startAiJob(async () => ({ text: (await generateAi(prompt, schema, body.brand)).texto })) });
  }
  return sendJson(res, 404, { error: 'No encontrado' });
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

async function handleApi(req, res, url, user) {
  if (url.pathname.startsWith('/api/meta/') || url.pathname.startsWith('/api/media/')) return handleMeta(req, res, url, user);
  const deny = () => sendJson(res, 403, { error: 'No tienes acceso a esta empresa' });
  const brandParam = () => { const id = safeBrandId(url.searchParams.get('brand')); return id && canBrand(user, id) ? id : null; };
  if (url.pathname === '/api/me') return sendJson(res, 200, publicUser(user));

  // Sincronización por partes
  if (url.pathname === '/api/sync' && req.method === 'GET') {
    const st = await readStore(), brands = st.brands.filter(b => canBrand(user, b.id));
    return sendJson(res, 200, { user: publicUser(user), v: st.v, brands, data: Object.fromEntries(brands.map(b => [b.id, brandDataOf(st, b.id)])) });
  }
  if (url.pathname === '/api/sync' && req.method === 'POST') {
    const body = JSON.parse((await readRaw(req, MAX_STATE_BYTES)).toString('utf8') || '{}');
    const result = await withLock('store', async () => {
      const st = await readStore(), denied = [];
      const okId = id => /^[A-Za-z0-9_-]{1,40}$/.test(String(id ?? ''));
      for (const b of body.brands?.upsert || []) {
        if (!b || !safeBrandId(b.id)) continue;
        const i = st.brands.findIndex(x => x.id === b.id);
        if (i >= 0) { if (canBrand(user, b.id)) st.brands[i] = b; else denied.push(b.id); }
        else if (user.role === 'admin') { st.brands.push(b); st.data[b.id] ||= { content: [], properties: [] }; }
        else denied.push(b.id);
      }
      for (const id of body.brands?.remove || []) {
        if (user.role !== 'admin') { denied.push(id); continue; }
        st.brands = st.brands.filter(x => x.id !== id); delete st.data[id];
      }
      for (const [bid, ch] of Object.entries(body.data || {})) {
        if (!st.brands.some(b => b.id === bid) || !canBrand(user, bid)) { denied.push(bid); continue; }
        const d = (st.data[bid] ||= { content: [], properties: [] });
        for (const key of ['content', 'properties']) {
          const c = ch?.[key]; if (!c) continue;
          const list = (d[key] ||= []);
          const gone = new Set((c.remove || []).map(String));
          if (gone.size) d[key] = list.filter(x => !gone.has(String(x.id)));
          for (const item of c.upsert || []) {
            if (!item || !okId(item.id)) continue;
            const i = d[key].findIndex(x => String(x.id) === String(item.id));
            if (i >= 0 && key === 'content') for (const f of META_FIELDS) if (d[key][i][f] != null && (item[f] == null || (f === 'metaStatus' && ['published', 'publishing'].includes(d[key][i][f]) && item[f] !== d[key][i][f]))) item[f] = d[key][i][f];
            if (i >= 0) d[key][i] = item; else if (key === 'content') d[key].unshift(item); else d[key].unshift(item);
          }
        }
      }
      await writeStore(st);
      return { v: st.v, denied };
    });
    return sendJson(res, 200, { ok: true, ...result });
  }
  if (url.pathname === '/api/state') return sendJson(res, 409, { error: 'La app se ha actualizado: recarga la página (Ctrl+F5) para seguir guardando.' });

  // Usuarios (solo administradores)
  if (url.pathname === '/api/users' || url.pathname.startsWith('/api/users/')) {
    if (user.role !== 'admin') return sendJson(res, 403, { error: 'Solo un administrador puede gestionar usuarios' });
    const um = url.pathname.match(/^\/api\/users(?:\/([a-f0-9]{12}))?$/);
    if (!um) return sendJson(res, 404, { error: 'No encontrado' });
    if (!um[1] && req.method === 'GET') return sendJson(res, 200, [publicUser(OWNER), ...usersCache.map(publicUser)]);
    const body = req.method === 'DELETE' ? {} : JSON.parse((await readRaw(req, 8192)).toString('utf8') || '{}');
    const st = await readStore(), validBrands = (body.brands || []).filter(id => st.brands.some(b => b.id === id));
    const role = body.role === 'admin' ? 'admin' : 'agency';
    if (!um[1] && req.method === 'POST') {
      const uname = String(body.username || '').trim().toLowerCase();
      if (!/^[a-z0-9._-]{3,30}$/.test(uname)) return sendJson(res, 400, { error: 'Usuario: 3 a 30 letras o números, sin espacios' });
      if (uname === String(username).toLowerCase() || usersCache.some(u => u.username === uname)) return sendJson(res, 400, { error: 'Ese usuario ya existe' });
      if (String(body.password || '').length < 8) return sendJson(res, 400, { error: 'La contraseña debe tener al menos 8 caracteres' });
      if (role === 'agency' && !validBrands.length) return sendJson(res, 400, { error: 'Elige al menos una empresa para este usuario' });
      const salt = crypto.randomBytes(16).toString('hex');
      const u = { id: crypto.randomBytes(6).toString('hex'), username: uname, name: clip(body.name, 60) || uname, role, brands: role === 'admin' ? [] : validBrands, salt, hash: await hashPassword(body.password, salt), pv: 0, createdAt: Date.now() };
      await saveUsers([...usersCache, u]);
      return sendJson(res, 200, publicUser(u));
    }
    const i = usersCache.findIndex(u => u.id === um[1]);
    if (i < 0) return sendJson(res, 404, { error: 'Usuario no encontrado' });
    const list = [...usersCache];
    if (req.method === 'DELETE') { list.splice(i, 1); await saveUsers(list); return sendJson(res, 200, { ok: true }); }
    if (req.method === 'POST') {
      const u = { ...list[i] };
      if (body.name != null) u.name = clip(body.name, 60) || u.username;
      if (body.role) { u.role = role; }
      if (body.brands) u.brands = u.role === 'admin' ? [] : validBrands;
      if (body.disabled != null) { u.disabled = !!body.disabled; u.pv = (u.pv || 0) + 1; }
      if (body.password != null) {
        if (String(body.password).length < 8) return sendJson(res, 400, { error: 'La contraseña debe tener al menos 8 caracteres' });
        u.salt = crypto.randomBytes(16).toString('hex'); u.hash = await hashPassword(body.password, u.salt); u.pv = (u.pv || 0) + 1;
      }
      list[i] = u; await saveUsers(list);
      return sendJson(res, 200, publicUser(u));
    }
    return sendJson(res, 405, { error: 'Método no permitido' });
  }
  // Contactos recibidos desde la web: listar, marcar como atendido o borrar
  if (url.pathname === '/api/stats' && req.method === 'GET') {
    const id = brandParam();
    if (!id) return deny();
    await flushStats();
    return sendJson(res, 200, await readStats(id));
  }
  if (url.pathname === '/api/notify' && req.method === 'GET') {
    const id = brandParam();
    if (!id) return deny();
    const b = (await readStore()).brands.find(x => x.id === id) || {};
    const ch = notifyChannels(b);
    return sendJson(res, 200, { email: ch.email ? ch.email.replace(/^(.).*(@.*)$/, '$1•••$2') : '', telegram: !!ch.telegram, smtp: !!mailer, telegramBot: !!process.env.TELEGRAM_BOT_TOKEN });
  }
  if (url.pathname === '/api/notify/test' && req.method === 'POST') {
    const id = brandParam();
    if (!id) return deny();
    const b = (await readStore()).brands.find(x => x.id === id);
    if (!b) return sendJson(res, 400, { error: 'Empresa no válida' });
    const ch = notifyChannels(b);
    if (!ch.email && !ch.telegram) return sendJson(res, 400, { error: 'No hay ningún aviso configurado todavía.' });
    try { const out = await notifyLead(b, { name: 'Contacto de prueba', phone: '600 000 000', email: '', message: 'Esto es una prueba de los avisos de Momentun Digital Studio.', ref: '', title: '' }, originOf(req)); const bad = (out || []).filter(o => o.status === 'rejected').map(o => o.reason?.message); if (bad.length) return sendJson(res, 502, { error: bad.join(' · ') }); return sendJson(res, 200, { ok: true, email: !!ch.email, telegram: !!ch.telegram }); }
    catch (err) { return sendJson(res, 502, { error: err.message }); }
  }
  if (url.pathname === '/api/leads' && req.method === 'GET') {
    const id = brandParam();
    return sendJson(res, id ? 200 : 400, id ? await readLeads(id) : { error: 'Empresa no válida' });
  }
  const lm = url.pathname.match(/^\/api\/leads\/([A-Za-z0-9_-]{1,40})\/([a-f0-9]{16})$/);
  if (lm) {
    if (!canBrand(user, lm[1])) return deny();
    const file = join(leadsDir, `${lm[1]}.json`);
    const changes = req.method === 'POST' ? JSON.parse((await readRaw(req, 4096)).toString('utf8') || '{}') : null;
    if (req.method !== 'POST' && req.method !== 'DELETE') return sendJson(res, 405, { error: 'Método no permitido' });
    const found = await withLock(`leads-${lm[1]}`, async () => {
      const all = await readLeads(lm[1]);
      const i = all.findIndex(l => l.id === lm[2]);
      if (i < 0) return false;
      if (req.method === 'DELETE') all.splice(i, 1);
      else all[i].status = changes.status === 'done' ? 'done' : 'new';
      await writeAtomic(file, JSON.stringify(all));
      return true;
    });
    return sendJson(res, found ? 200 : 404, found ? { ok: true } : { error: 'Contacto no encontrado' });
  }
  if (url.pathname === '/api/reviews' && req.method === 'GET') {
    const id = brandParam();
    return sendJson(res, id ? 200 : 400, id ? await readReviews(id) : { error: 'Empresa no válida' });
  }

  if (url.pathname.startsWith('/api/ai/')) return handleAi(req, res, url);


  // /api/photos/:ref  y  /api/photos/:ref/:id(.webp|.jpg)
  const m = url.pathname.match(/^\/api\/photos\/([^/]+)(?:\/([^/.]+)(\.(?:jpg|webp))?)?$/);
  if (!m) return sendJson(res, 404, { error: 'No encontrado' });
  const ref = safeRef(decodeURIComponent(m[1]));
  if (!ref) return sendJson(res, 400, { error: 'Referencia no válida' });
  const dir = join(photosDir, ref);
  if (user.role !== 'admin') { const owner = await propertyBrand(ref); if (owner && !canBrand(user, owner)) return deny(); }

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

  // Portada ya diseñada (logo, pie, título y precio) que la app sube al ver la foto 1
  if (m[2] === 'cover') {
    if (req.method === 'GET') return sendCover(res, ref, 'private, max-age=60', url.searchParams.has('raw'));
    if (req.method === 'PUT') {
      const body = await readRaw(req, MAX_PHOTO_BYTES);
      const isJpg = body.length > 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff;
      if (!isJpg) return sendJson(res, 400, { error: 'La portada debe ser JPG' });
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'cover.jpg'), body);
      return sendJson(res, 200, { ok: true, bytes: body.length });
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

// Portada diseñada si existe; si no, la primera foto del inmueble
async function sendCover(res, ref, cache, raw = false) {
  const manifest = await readManifest(ref);
  if (!manifest.photos?.length) return sendJson(res, 404, { error: 'Sin foto' });
  const dir = join(photosDir, ref);
  // raw: la primera foto tal cual (miniatura de la ficha del inmueble), sin el diseño de portada
  if (!raw) try { return send(res, 200, await readFile(join(dir, 'cover.jpg')), { 'Content-Type': 'image/jpeg', 'Cache-Control': cache }); } catch {}
  const ph = manifest.photos[0];
  if (safeId(ph.id)) {
    for (const [ext, type] of [['webp', 'image/webp'], ['jpg', 'image/jpeg']]) {
      try { return send(res, 200, await readFile(join(dir, `${ph.id}.${ext}`)), { 'Content-Type': type, 'Cache-Control': cache }); } catch {}
    }
  }
  return sendJson(res, 404, { error: 'Sin foto' });
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

function createSession(user = OWNER) {
  const payload = Buffer.from(JSON.stringify({ uid: user.id, user: user.username, pv: user.pv || 0, exp: Date.now() + sessionDurationMs })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function currentUser(req) {
  const token = parseCookies(req).ruano_session;
  if (!token) return null;
  const [payload, signature] = token.split('.');
  if (!payload || !signature || !safeEqual(signature, sign(payload))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!(Number(data.exp) > Date.now())) return null;
    if ((data.uid === 'owner' || !data.uid) && data.user === username) return OWNER;
    const u = usersCache.find(x => x.id === data.uid && !x.disabled);
    return u && (u.pv || 0) === (data.pv || 0) ? u : null; // al cambiar la contraseña se cierran sus sesiones
  } catch {
    return null;
  }
}
const validSession = req => !!currentUser(req);

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
  <title>Acceso · Momentun Digital</title>
  <style>
    *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f7fa;color:#172438;font-family:Arial,sans-serif;padding:20px}
    main{width:min(420px,100%);background:#fff;border:1px solid #e2e8ef;border-radius:18px;padding:34px;box-shadow:0 18px 55px rgba(16,42,71,.1)}
    .logo{width:58px;height:58px;border-radius:14px;display:grid;place-items:center;background:#fff;border:1px solid #dbe3ee;box-shadow:0 4px 14px rgba(11,49,95,.12);margin-bottom:22px}
    h1{font-family:Georgia,serif;color:#132d4d;margin:0 0 8px}p{color:#718095;font-size:14px;line-height:1.5}
    label{display:grid;gap:7px;margin-top:17px;font-size:13px;font-weight:700;color:#425168}
    input{width:100%;border:1px solid #d5dee7;border-radius:10px;padding:12px;font:inherit}
    input:focus{outline:3px solid #e1edf8;border-color:#5d8ebb}
    button{width:100%;border:0;border-radius:10px;padding:13px;margin-top:22px;background:#0d447f;color:#fff;font-weight:700;cursor:pointer}
    .error{background:#fdecec;color:#a33b3b;border-radius:9px;padding:10px;margin-top:15px;font-size:13px}
  </style>
</head>
<body><main>
  <div class="logo" title="Momentun Digital"><svg viewBox="0 0 48 48" width="38" height="38" aria-hidden="true"><path d="M8 36V14l11 13 11-13v22" fill="none" stroke="#0b315f" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/><path d="M30 24l10-10" stroke="#2aa7a1" stroke-width="5" stroke-linecap="round"/><path d="M33 13h8v8" fill="none" stroke="#2aa7a1" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
  <h1>Momentun Digital</h1>
  <p>Acceso privado al estudio de contenidos para redes sociales de inmobiliarias.</p>
  ${error ? `<div class="error">${error === 'lock' ? 'Demasiados intentos fallidos. Espera 15 minutos y vuelve a intentarlo.' : 'Usuario o contraseña incorrectos.'}</div>` : ''}
  <form method="post" action="/login">
    <label>Usuario<input name="username" autocomplete="username" required autofocus></label>
    <label>Contraseña<input name="password" type="password" autocomplete="current-password" required></label>
    <button type="submit">Entrar</button>
  </form>
</main>
<script>try{if(location.hash.startsWith('#importar='))sessionStorage.setItem('ruanoPendingImport',location.hash.slice(10))}catch(e){}</script>
</body></html>`;

// ===== Revisión por el cliente: enlace público por empresa, sin usuario ni contraseña =====
const reviewsDir = join(dataDir, 'reviews');
await mkdir(reviewsDir, { recursive: true });
const safeBrandId = id => (/^[A-Za-z0-9_-]{1,40}$/.test(id || '') ? id : null);
const parseJson = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };
async function readReviews(id) { try { return JSON.parse(await readFile(join(reviewsDir, `${id}.json`), 'utf8')); } catch { return {}; } }
// Marca, contenidos e inmuebles de la empresa a la que pertenece el enlace
async function brandByToken(token) {
  if (!/^[a-f0-9]{24}$/.test(token || '')) return null;
  const st = await readStore();
  const brand = st.brands.find(b => b && b.reviewToken === token);
  if (!brand || !safeBrandId(brand.id)) return null;
  const d = brandDataOf(st, brand.id);
  return { brand, content: d.content || [], properties: d.properties || [] };
}
const reviewHits = new Map();
const loginFails = new Map();
// Easypanel (Traefik) añade la IP real al FINAL de X-Forwarded-For; lo anterior lo puede escribir el propio visitante
const clientIp = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',').pop().trim();
async function handleReview(req, res, url) {
  const m = url.pathname.match(/^\/api\/review\/([a-f0-9]{24})(?:\/(photo\/(\d{1,20})|(\d{1,20})))?$/);
  if (!m) return sendJson(res, 404, { error: 'No encontrado' });
  const hits = (reviewHits.get(m[1]) || []).filter(t => Date.now() - t < 3600_000); hits.push(Date.now()); reviewHits.set(m[1], hits);
  if (hits.length > 600) return sendJson(res, 429, { error: 'Demasiadas peticiones. Inténtalo más tarde.' });
  const data = await brandByToken(m[1]);
  if (!data) return sendJson(res, 404, { error: 'Enlace no válido' });
  if (m[3]) {
    const prop = data.properties.find(p => String(p.id) === m[3]);
    const ref = prop && safeRef(String(prop.id));
    if (!ref) return sendJson(res, 404, { error: 'Sin foto' });
    return sendCover(res, ref, 'private, max-age=300');
  }
  const reviews = await readReviews(data.brand.id);
  if (m[4]) {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Método no permitido' });
    const item = data.content.find(x => x && String(x.id) === m[4]);
    if (!item) return sendJson(res, 404, { error: 'Publicación no encontrada' });
    const body = JSON.parse((await readRaw(req, 8 * 1024)).toString('utf8') || '{}');
    const review = { status: body.action === 'approve' ? 'approved' : 'changes', comment: clip(body.comment, 600), at: Date.now() };
    if (review.status === 'changes' && !review.comment) return sendJson(res, 400, { error: 'Explica qué quieres cambiar' });
    await withLock(`review-${data.brand.id}`, async () => {
      const all = await readReviews(data.brand.id); all[item.id] = review;
      await writeAtomic(join(reviewsDir, `${data.brand.id}.json`), JSON.stringify(all));
    });
    return sendJson(res, 200, { review });
  }
  const since = Date.now() - 21 * 864e5;
  const items = data.content
    .filter(x => x && (x.status === 'pending' || (x.status === 'approved' && new Date(`${x.date}T12:00:00`).getTime() >= since)))
    .sort((a, b) => String(a.date).localeCompare(String(b.date))).slice(0, 80)
    .map(x => {
      const prop = data.properties.find(p => String(p.reference) === String(x.propertyRef));
      const rv = reviews[x.id];
      return { id: x.id, title: clip(x.title, 200), type: clip(x.type, 30), channel: clip(x.channel, 40), date: clip(x.date, 10), caption: clip(x.caption, 5000),
        review: rv && rv.at >= (x.updatedAt || 0) ? rv : null, photo: prop ? `/api/review/${m[1]}/photo/${prop.id}?v=${Math.floor(Date.now() / 300000)}` : null };
    });
  const b = data.brand;
  return sendJson(res, 200, { brand: { name: b.name, color: b.color, color2: b.color2, logo: b.logo || (b.id === 'ruano' ? DEFAULT_LOGO : '') }, items });
}
const reviewPage = () => `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Revisión de publicaciones</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f4f7fa;color:#172438;font-family:Arial,Helvetica,sans-serif}
header{background:var(--c,#0b315f);color:#fff;padding:22px 18px}header .in{max-width:760px;margin:0 auto;display:flex;gap:14px;align-items:center}
.logo{width:58px;height:58px;border-radius:12px;background:#fff;display:grid;place-items:center;overflow:hidden;flex:none;color:var(--c,#0b315f);font:700 26px Georgia,serif}.logo img{max-width:100%;max-height:100%;object-fit:contain}
h1{font:700 22px Georgia,serif;margin:0}header p{margin:4px 0 0;opacity:.85;font-size:13px}
main{max-width:760px;margin:0 auto;padding:18px}.intro{font-size:14px;color:#506176;line-height:1.5;margin:0 0 16px}
.summary{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px}.summary span{background:#fff;border:1px solid #e2e8ef;border-radius:999px;padding:6px 12px;font-size:12px;font-weight:700}
.card{background:#fff;border:1px solid #e2e8ef;border-radius:14px;overflow:hidden;margin-bottom:14px;box-shadow:0 6px 20px rgba(16,42,71,.06)}
.card img{width:100%;height:auto;max-height:620px;object-fit:contain;display:block;background:#e9eef2}
.body{padding:14px 16px}.meta{display:flex;gap:8px;flex-wrap:wrap;align-items:center;font-size:11px;color:#718095;margin-bottom:6px}
.tag{background:#eef3fb;color:var(--c2,#0d447f);font-weight:700;border-radius:6px;padding:3px 7px}
h2{font-size:16px;margin:4px 0 8px}.caption{white-space:pre-wrap;font-size:14px;line-height:1.5;margin:0;color:#25344a}
.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}button{border:0;border-radius:10px;padding:11px 16px;font-weight:700;font-size:14px;cursor:pointer}
.ok{background:#218a68;color:#fff}.ch{background:#fff;border:1px solid #d5dee7;color:#172438}.state{margin-top:12px;padding:10px 12px;border-radius:10px;font-size:13px;font-weight:700}
.state.approved{background:#e6f4ee;color:#1b6e53}.state.changes{background:#fdf1e2;color:#9a5b12}.state small{display:block;font-weight:400;margin-top:4px;color:#506176}
textarea{width:100%;margin-top:10px;border:1px solid #d5dee7;border-radius:10px;padding:10px;font:inherit;min-height:80px}
.link{background:none;border:0;color:var(--c2,#0d447f);text-decoration:underline;padding:0;font-weight:600;font-size:12px;margin-top:8px}
.empty{background:#fff;border:1px solid #e2e8ef;border-radius:14px;padding:30px;text-align:center;color:#718095}footer{text-align:center;color:#9aa6b5;font-size:11px;padding:20px}
</style></head><body>
<header><div class="in"><div class="logo" id="logo"></div><div><h1 id="name">Revisión de publicaciones</h1><p>Revisa y aprueba las publicaciones antes de que salgan</p></div></div></header>
<main><p class="intro">Aquí tienes las publicaciones preparadas para tus redes. Pulsa <b>Aprobar</b> si está todo bien o <b>Pedir cambios</b> y explícanos qué quieres cambiar.</p>
<div class="summary" id="summary"></div><div id="list"><div class="empty">Cargando…</div></div></main><footer>Enlace privado: no lo compartas.</footer>
<script>
const token=location.pathname.split('/').pop(),api='/api/review/'+token;
const el=(t,c,txt)=>{const e=document.createElement(t);if(c)e.className=c;if(txt!=null)e.textContent=txt;return e};
const fmt=d=>{try{return new Intl.DateTimeFormat('es-ES',{weekday:'long',day:'numeric',month:'long'}).format(new Date(d+'T12:00:00'))}catch{return d}};
let data;
async function load(){const r=await fetch(api,{cache:'no-store'});if(!r.ok){document.getElementById('list').innerHTML='';document.getElementById('list').append(el('div','empty','Este enlace no es válido o ya no está activo.'));return}
 data=await r.json();const b=data.brand;document.documentElement.style.setProperty('--c',b.color||'#0b315f');document.documentElement.style.setProperty('--c2',b.color2||'#0d447f');
 document.getElementById('name').textContent=b.name;document.title='Revisión · '+b.name;const lg=document.getElementById('logo');lg.textContent='';if(b.logo){const i=el('img');i.src=b.logo;i.alt='';lg.append(i)}else lg.textContent=(b.name||'?')[0].toUpperCase();render()}
function render(){const list=document.getElementById('list');list.innerHTML='';const items=data.items;
 const pend=items.filter(x=>!x.review).length,ok=items.filter(x=>x.review?.status==='approved').length,ch=items.filter(x=>x.review?.status==='changes').length;
 const sm=document.getElementById('summary');sm.innerHTML='';sm.append(el('span','',pend+' por revisar'),el('span','',ok+' aprobadas'),el('span','',ch+' con cambios'));
 if(!items.length){list.append(el('div','empty','No hay publicaciones pendientes de revisar. ¡Gracias!'));return}
 items.forEach(x=>{const c=el('article','card');if(x.photo){const i=el('img');i.src=x.photo;i.alt='';i.loading='lazy';i.onerror=()=>i.remove();c.append(i)}
  const b=el('div','body'),m=el('div','meta');m.append(el('span','tag',x.type),el('span','',fmt(x.date)),el('span','',x.channel||''));b.append(m,el('h2','',x.title),el('p','caption',x.caption||''));
  const a=el('div','actions');
  if(x.review){const s=el('div','state '+x.review.status,x.review.status==='approved'?'✓ Aprobada':'✎ Has pedido cambios');if(x.review.comment)s.append(el('small','','«'+x.review.comment+'»'));b.append(s);
   const again=el('button','link','Cambiar mi respuesta');again.onclick=()=>{x.review=null;render()};b.append(again)}
  else{const ok=el('button','ok','✓ Aprobar'),ch=el('button','ch','✎ Pedir cambios');ok.onclick=()=>send(x,'approve','',ok);
   ch.onclick=()=>{if(b.querySelector('textarea'))return;const t=el('textarea');t.placeholder='¿Qué quieres cambiar?';const go=el('button','ok','Enviar cambios');go.onclick=()=>{if(!t.value.trim()){t.focus();return}send(x,'changes',t.value.trim(),go)};b.append(t,go);t.focus()};a.append(ok,ch);b.append(a)}
  c.append(b);list.append(c)})}
async function send(x,action,comment,btn){btn.disabled=true;try{const r=await fetch(api+'/'+x.id,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,comment})});const d=await r.json();if(!r.ok)throw new Error(d.error||'Error');x.review=d.review;render()}catch(e){alert('No se pudo enviar: '+e.message);btn.disabled=false}}
load();
</script></body></html>`;

// ─── Web pública: página de cada inmueble, página de enlaces para la bio y contactos ───
const leadsDir = join(dataDir, 'leads');
await mkdir(leadsDir, { recursive: true });
const safeWebId = w => (/^[a-f0-9]{16}$/.test(w || '') ? w : null);
const escHtml = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hexColor = (c, d) => (/^#[0-9a-f]{6}$/i.test(c || '') ? c : d);
async function readLeads(id) { try { return JSON.parse(await readFile(join(leadsDir, `${id}.json`), 'utf8')); } catch { return []; } }
async function brandByWebId(webId) {
  if (!safeWebId(webId)) return null;
  const st = await readStore();
  const brand = st.brands.find(b => b && b.webId === webId);
  if (!brand || !safeBrandId(brand.id)) return null;
  // Solo los inmuebles visibles en la web; nunca datos internos ni de propietarios
  const properties = (brandDataOf(st, brand.id).properties || []).filter(p => p && p.web !== false && safeRef(String(p.id)));
  return { brand: { ...brand, logo: brand.logo || (brand.id === 'ruano' ? DEFAULT_LOGO : '') }, properties };
}
function contactOf(brand) {
  const footer = String(brand.footer || '');
  const m = footer.match(/\+?\d[\d\s.]{7,}\d/);
  const phone = m ? m[0].replace(/[\s.]/g, '') : '';
  const web = (footer.replace(m ? m[0] : '', '').match(/\b(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/i) || [])[0] || '';
  let wa = String(brand.whatsapp || '').replace(/\D/g, '');
  if (wa.length === 9) wa = '34' + wa;
  return { phone, web, wa: wa.length >= 11 ? wa : '' };
}
function niceTitleSrv(t, p) {
  t = String(t || '').trim();
  const letters = t.replace(/[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/g, '');
  if (letters && letters.replace(/[^A-ZÁÉÍÓÚÜÑ]/g, '').length / letters.length > 0.7) {
    const names = String(p?.location || '').split(/[,\s]+/).filter(w => w.length > 2);
    t = t.toLowerCase().split(' ').map(w => names.find(n => n.toLowerCase() === w) || w).join(' ');
    t = t.charAt(0).toUpperCase() + t.slice(1);
  }
  return t;
}
const WEB_STAMPS = { nuevo: 'Nuevo', precio: 'Nuevo precio', puertas: 'Puertas abiertas', reservado: 'Reservado', vendido: 'Vendido' };
function publicProp(p) {
  const stamp = WEB_STAMPS[p.stamp] ? p.stamp : '';
  return {
    id: String(p.id), ref: clip(p.reference, 20), title: niceTitleSrv(clip(p.title, 160), p), operation: clip(p.operation, 20) || 'Venta',
    location: clip(p.location, 80), price: clip(p.price, 30), oldPrice: stamp === 'precio' ? clip(p.oldPrice, 30) : '',
    facts: [p.built, p.useful, p.beds, p.baths, p.floor].map(x => clip(x, 40)).filter(Boolean),
    extras: clip(p.extras, 300), description: clip(p.description, 4000),
    stamp, stampLabel: stamp === 'vendido' && p.operation === 'Alquiler' ? 'Alquilado' : WEB_STAMPS[stamp] || '',
  };
}
const originOf = req => `${String(req.headers['x-forwarded-proto'] || (isProduction ? 'https' : 'http')).split(',')[0]}://${req.headers['x-forwarded-host'] || req.headers.host}`;

function webShell({ brand, title, desc, image, url, body, script = '', head = '' }) {
  const c1 = hexColor(brand.color, '#0b315f'), c2 = hexColor(brand.color2, '#0d447f');
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(title)}</title><meta name="description" content="${escHtml(desc)}">
<meta property="og:type" content="website"><meta property="og:title" content="${escHtml(title)}"><meta property="og:description" content="${escHtml(desc)}"><meta property="og:url" content="${escHtml(url)}">${image ? `<meta property="og:image" content="${escHtml(image)}"><meta name="twitter:card" content="summary_large_image">` : ''}<link rel="canonical" href="${escHtml(url)}">${head}
<style>:root{--c:${c1};--c2:${c2};--ink:#16212e;--muted:#64748b;--line:#e3e8ef;--bg:#f4f6f9}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}a{color:inherit}
.top{display:block;text-decoration:none;background:#fff;border-bottom:1px solid var(--line)}.top .in{max-width:880px;margin:0 auto;padding:12px 16px;display:flex;align-items:center;gap:12px;text-decoration:none}.logo{width:46px;height:46px;border-radius:10px;display:grid;place-items:center;overflow:hidden;background:var(--c);color:#fff;font:700 22px Georgia,serif;flex:none}.logo img{width:100%;height:100%;object-fit:contain;background:#fff}.top b{display:block;font-size:16px}.top small{color:var(--muted);font-size:12.5px}
main{max-width:880px;margin:0 auto;padding:0 0 110px}.card{background:#fff;border:1px solid var(--line);border-radius:16px;padding:20px;margin:14px 16px}
.gal{display:flex;overflow-x:auto;scroll-snap-type:x mandatory;gap:6px;background:#0d1b2a;scrollbar-width:none}.gal::-webkit-scrollbar{display:none}.gal img{flex:0 0 100%;width:100%;aspect-ratio:4/3;object-fit:cover;scroll-snap-align:center;background:#1c2b3c}@media(min-width:760px){.gal{border-radius:0 0 16px 16px}.gal img{flex-basis:78%}}
.galnote{color:var(--muted);font-size:12.5px;text-align:center;margin:8px 0 0}.stamp{display:inline-block;background:var(--c2);color:#fff;font-weight:800;font-size:12px;letter-spacing:.04em;text-transform:uppercase;padding:5px 10px;border-radius:7px;margin-bottom:8px}.stamp.vendido,.stamp.reservado{background:#b4472d}
.kick{color:var(--muted);font-size:13px;font-weight:700;letter-spacing:.06em;text-transform:uppercase}h1{font:700 clamp(25px,5vw,34px)/1.2 Georgia,"Times New Roman",serif;margin:4px 0 10px}.price{display:inline-block;background:var(--c);color:#fff;font-weight:800;font-size:24px;padding:6px 14px;border-radius:10px}.old{color:var(--muted);text-decoration:line-through;margin-left:10px}
.facts{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0 4px;padding:0;list-style:none}.facts li{background:var(--bg);border:1px solid var(--line);border-radius:999px;padding:6px 12px;font-size:14px}.extras{color:var(--muted);font-size:14.5px}.desc{white-space:pre-line}.ref{color:var(--muted);font-size:13px}
h2{font-size:19px;margin:0 0 12px}form{display:grid;gap:11px}label{display:grid;gap:4px;font-size:13.5px;font-weight:600}input,textarea{font:inherit;padding:11px 12px;border:1px solid #cdd6e1;border-radius:10px;background:#fff;width:100%}textarea{min-height:92px;resize:vertical}.consent{display:flex;gap:10px;align-items:flex-start;font-weight:400;font-size:12.5px;color:var(--muted)}.consent input{width:auto;margin-top:3px}.hp{position:absolute;left:-5000px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;border:0;border-radius:12px;padding:13px 18px;font:700 15.5px system-ui,sans-serif;text-decoration:none;cursor:pointer;background:var(--c);color:#fff}.btn.wa{background:#1f9d55}.btn.light{background:#fff;color:var(--c);border:1px solid var(--line)}.btn:disabled{opacity:.6}.ok{background:#eaf7ef;border:1px solid #a7dbbb;color:#1f6b3d;border-radius:12px;padding:14px}.err{color:#b4472d;font-size:13.5px}
.bar{position:fixed;left:0;right:0;bottom:0;background:#fff;border-top:1px solid var(--line);padding:10px 16px calc(10px + env(safe-area-inset-bottom));display:flex;gap:8px;justify-content:center;z-index:5}.bar .btn{flex:1;max-width:280px;padding:12px 10px}
.list{display:grid;gap:12px;margin:0 16px}.item{display:grid;grid-template-columns:120px 1fr;gap:12px;background:#fff;border:1px solid var(--line);border-radius:14px;overflow:hidden;text-decoration:none}.item img,.item .ph{width:120px;height:100%;min-height:104px;object-fit:cover;background:linear-gradient(145deg,#9ac4dc,#316d95)}.item div{padding:11px 12px 11px 0}.item b{display:block;line-height:1.3}.item small{color:var(--muted);display:block;font-size:13px}.item .p{color:var(--c);font-weight:800;margin-top:4px}.item .stamp{font-size:10.5px;padding:3px 7px;margin:0 0 4px}
.hero{text-align:center;padding:26px 16px 8px}.hero .logo{width:84px;height:84px;margin:0 auto 10px;border-radius:18px;font-size:38px}.hero h1{margin:0}.hero p{color:var(--muted);margin:4px 0 0}.links{display:grid;gap:9px;max-width:440px;margin:16px auto 6px;padding:0 16px}.sec{max-width:880px;margin:22px auto 8px;padding:0 16px;font-size:13px;font-weight:800;letter-spacing:.08em;color:var(--muted);text-transform:uppercase}
footer{text-align:center;color:var(--muted);font-size:12.5px;padding:18px 16px}</style></head><body>${body}${script ? `<script>${script}</script>` : ''}</body></html>`;
}
const logoHtml = b => (b.logo ? `<span class="logo"><img src="${escHtml(b.logo)}" alt="${escHtml(b.name)}"></span>` : `<span class="logo">${escHtml((b.name || '?')[0].toUpperCase())}</span>`);
function leadForm(webId, propId, message, brand) {
  const privacy = /^https?:\/\//i.test(brand.privacyUrl || '') ? ` <a href="${escHtml(brand.privacyUrl)}" target="_blank" rel="noopener">Política de privacidad</a>.` : '';
  return `<form id="lead" data-api="/api/lead/${webId}/${propId}"><label>Nombre<input name="name" required maxlength="80" autocomplete="name"></label>
<label>Teléfono<input name="phone" type="tel" maxlength="20" autocomplete="tel" inputmode="tel"></label><label>Email<input name="email" type="email" maxlength="120" autocomplete="email"></label>
<label>Mensaje<textarea name="message" maxlength="1000">${escHtml(message)}</textarea></label><input class="hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
<label class="consent"><input type="checkbox" name="consent" required><span>Acepto que ${escHtml(brand.name)} use mis datos solo para responder a esta solicitud. No se ceden a terceros.${privacy}</span></label>
<p class="err" id="leadErr" hidden></p><button class="btn" type="submit">Enviar solicitud</button></form>`;
}
const LEAD_SCRIPT = `document.addEventListener('click',e=>{const a=e.target.closest('[data-hit]'),h=document.getElementById('hitctx');if(a&&h&&navigator.sendBeacon)navigator.sendBeacon('/api/hit/'+h.dataset.w,new Blob([JSON.stringify({k:a.dataset.hit,p:h.dataset.p})],{type:'text/plain'}))});
const f=document.getElementById('lead');if(f)f.addEventListener('submit',async e=>{e.preventDefault();const b=f.querySelector('button'),er=document.getElementById('leadErr'),d=Object.fromEntries(new FormData(f));d.consent=!!f.elements.consent.checked;
if(!d.phone&&!d.email){er.textContent='Indica un teléfono o un email para poder responderte.';er.hidden=false;return}
b.disabled=true;er.hidden=true;try{const r=await fetch(f.dataset.api,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||'No se pudo enviar');
f.outerHTML='<div class="ok"><b>¡Gracias!</b> Hemos recibido tu solicitud y te contactaremos lo antes posible.</div>'}catch(x){er.textContent=x.message;er.hidden=false;b.disabled=false}});`;

function contactButtons(c, text) {
  return [c.wa && `<a class="btn wa" data-hit="wa" href="https://wa.me/${c.wa}?text=${encodeURIComponent(text)}" target="_blank" rel="noopener">WhatsApp</a>`,
    c.phone && `<a class="btn light" data-hit="tel" href="tel:${escHtml(c.phone)}">Llamar</a>`].filter(Boolean).join('');
}
async function propertyPage(req, data, webId, p) {
  const b = data.brand, c = contactOf(b), x = publicProp(p), origin = originOf(req), url = `${origin}/w/${webId}/${x.id}`;
  const n = (await readManifest(x.id)).photos?.length || 0;
  const gallery = n ? `<div class="gal">${Array.from({ length: Math.min(n, 40) }, (_, i) => `<img src="/w/${webId}/${x.id}/foto/${i}" alt="Foto ${i + 1} de ${escHtml(x.title)}"${i ? ' loading="lazy"' : ''}>`).join('')}</div><p class="galnote">${n} fotos · desliza para verlas</p>` : '';
  const kicker = [x.operation === 'Alquiler' ? 'En alquiler' : 'En venta', x.location].filter(Boolean).join(' · ');
  const askText = `Hola, me interesa la REF. ${x.ref} (${x.title}). ¿Podemos concertar una visita?`;
  const body = `<a class="top" href="/w/${webId}"><div class="in">${logoHtml(b)}<div><b>${escHtml(b.name)}</b><small>${escHtml(b.slogan || b.subline || 'Ver todos los inmuebles')}</small></div></div></a>
<main>${gallery}<section class="card">${x.stampLabel ? `<span class="stamp ${x.stamp}">${escHtml(x.stampLabel)}</span><br>` : ''}<span class="kick">${escHtml(kicker)}</span><h1>${escHtml(x.title)}</h1>
${x.price ? `<span class="price">${escHtml(x.price)}</span>${x.oldPrice ? `<span class="old">${escHtml(x.oldPrice)}</span>` : ''}` : ''}
${x.facts.length ? `<ul class="facts">${x.facts.map(f => `<li>${escHtml(f)}</li>`).join('')}</ul>` : ''}${x.extras ? `<p class="extras">${escHtml(x.extras)}</p>` : ''}
${x.description ? `<p class="desc">${escHtml(x.description)}</p>` : ''}<p class="ref">Referencia ${escHtml(x.ref)}</p></section>
<section class="card" id="visita"><h2>¿Te interesa? Pide información o una visita</h2>${leadForm(webId, x.id, `Me interesa la REF. ${x.ref}. ¿Cuándo podría visitarla?`, b)}</section>
<footer>${escHtml(b.name)}${b.footer ? ` · ${escHtml(b.footer)}` : ''}<br><a href="/w/${webId}">Ver más inmuebles</a></footer></main>
<div class="bar">${contactButtons(c, askText)}<a class="btn" href="#visita">Pedir visita</a></div>`;
  const desc = [x.price, x.facts.slice(0, 3).join(' · '), x.location].filter(Boolean).join(' · ');
  const priceNum = Number(String(x.price).replace(/[^\d]/g, '')) || undefined;
  const ld = { '@context': 'https://schema.org', '@type': 'RealEstateListing', name: x.title, description: (x.description || desc).slice(0, 500), url, image: n ? [`${origin}/w/${webId}/${x.id}/portada.jpg`] : undefined,
    offers: priceNum ? { '@type': 'Offer', price: priceNum, priceCurrency: 'EUR', availability: x.stamp === 'vendido' || x.stamp === 'reservado' ? 'https://schema.org/SoldOut' : 'https://schema.org/InStock', seller: { '@type': 'RealEstateAgent', name: b.name } } : undefined,
    address: x.location ? { '@type': 'PostalAddress', addressLocality: x.location, addressCountry: 'ES' } : undefined };
  const head = `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>`;
  return webShell({ brand: b, title: `${x.title} · ${b.name}`, desc, image: n ? `${origin}/w/${webId}/${x.id}/portada.jpg` : '', url, body: `<div id="hitctx" data-w="${webId}" data-p="${x.id}" hidden></div>` + body, script: LEAD_SCRIPT, head });
}
async function bioPage(req, data, webId) {
  const b = data.brand, c = contactOf(b), origin = originOf(req);
  const items = [];
  for (const p of data.properties.slice(0, 60)) {
    const x = publicProp(p), has = ((await readManifest(x.id)).photos?.length || 0) > 0;
    items.push(`<a class="item" href="/w/${webId}/${x.id}">${has ? `<img src="/w/${webId}/${x.id}/foto/0" alt="" loading="lazy">` : '<span class="ph"></span>'}<div>${x.stampLabel ? `<span class="stamp ${x.stamp}">${escHtml(x.stampLabel)}</span>` : ''}<b>${escHtml(x.title)}</b><small>${escHtml([x.location, `REF. ${x.ref}`].filter(Boolean).join(' · '))}</small>${x.price ? `<div class="p">${escHtml(x.price)}</div>` : ''}</div></a>`);
  }
  const links = [contactButtons(c, `Hola, os escribo desde Instagram.`), c.web && `<a class="btn light" data-hit="web" href="https://${escHtml(c.web.replace(/^https?:\/\//, ''))}" target="_blank" rel="noopener">${escHtml(c.web)}</a>`].filter(Boolean).join('');
  const body = `<main><div class="hero">${logoHtml(b)}<h1>${escHtml(b.name)}</h1><p>${escHtml([b.slogan, b.subline].filter(Boolean).join(' · '))}</p></div>
<div class="links">${links}<a class="btn" href="#vender">¿Quieres vender o alquilar tu vivienda?</a></div>
<p class="sec">Inmuebles disponibles</p><div class="list">${items.join('') || '<p class="card">Pronto publicaremos nuevos inmuebles.</p>'}</div>
<section class="card" id="vender"><h2>¿Vendes, alquilas o buscas vivienda?</h2>${leadForm(webId, 0, 'Hola, me gustaría que me contactarais para…', b)}</section>
<footer>${escHtml(b.name)}${b.footer ? ` · ${escHtml(b.footer)}` : ''}</footer></main>`;
  return webShell({ brand: b, title: b.name, desc: [b.slogan, b.subline, 'Inmuebles disponibles'].filter(Boolean).join(' · '), image: '', url: `${origin}/w/${webId}`, body: `<div id="hitctx" data-w="${webId}" data-p="bio" hidden></div>` + body, script: LEAD_SCRIPT });
}
const leadHits = new Map();
async function handleWeb(req, res, url) {
  const m = url.pathname.match(/^\/w\/([a-f0-9]{16})(?:\/([A-Za-z0-9_-]{1,40})(?:\/(foto\/(\d{1,3})|portada\.jpg))?)?\/?$/);
  if (!m) return send(res, 404, 'No encontrado', { 'Content-Type': 'text/plain; charset=utf-8' });
  const data = await brandByWebId(m[1]);
  if (!data) return send(res, 404, 'Esta página no existe o ya no está disponible.', { 'Content-Type': 'text/plain; charset=utf-8' });
  const html = h => send(res, 200, h, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=60' });
  if (!m[2]) { countHit(data.brand.id, 'view', 'bio', req); return html(await bioPage(req, data, m[1])); }
  const p = data.properties.find(x => String(x.id) === m[2]);
  if (!p) return send(res, 404, 'Este inmueble ya no está disponible.', { 'Content-Type': 'text/plain; charset=utf-8' });
  if (!m[3]) { countHit(data.brand.id, 'view', String(p.id), req); return html(await propertyPage(req, data, m[1], p)); }
  const ref = String(p.id);
  if (m[3] === 'portada.jpg') return sendCover(res, ref, 'public, max-age=600');
  const ph = (await readManifest(ref)).photos?.[Number(m[4])];
  if (!ph || !safeId(ph.id)) return send(res, 404, 'Sin foto', { 'Content-Type': 'text/plain; charset=utf-8' });
  for (const [ext, type] of [['webp', 'image/webp'], ['jpg', 'image/jpeg']]) {
    try { return send(res, 200, await readFile(join(photosDir, ref, `${ph.id}.${ext}`)), { 'Content-Type': type, 'Cache-Control': 'public, max-age=600' }); } catch {}
  }
  return send(res, 404, 'Sin foto', { 'Content-Type': 'text/plain; charset=utf-8' });
}
async function handleLead(req, res, url) {
  const m = url.pathname.match(/^\/api\/lead\/([a-f0-9]{16})\/([A-Za-z0-9_-]{1,40})$/);
  if (!m || req.method !== 'POST') return sendJson(res, 404, { error: 'No encontrado' });
  const ip = clientIp(req);
  const hits = (leadHits.get(ip) || []).filter(t => Date.now() - t < 3600_000);
  if (hits.length >= 6) return sendJson(res, 429, { error: 'Has enviado varias solicitudes seguidas. Inténtalo más tarde o llámanos.' });
  hits.push(Date.now()); leadHits.set(ip, hits);
  const data = await brandByWebId(m[1]);
  if (!data) return sendJson(res, 404, { error: 'Página no disponible' });
  const body = JSON.parse((await readRaw(req, 8 * 1024)).toString('utf8') || '{}');
  if (body.website) return sendJson(res, 200, { ok: true }); // trampa para robots
  const name = clip(body.name, 80), phone = clip(body.phone, 20).replace(/[^\d+ ]/g, ''), email = clip(body.email, 120), message = clip(body.message, 1000);
  if (name.length < 2) return sendJson(res, 400, { error: 'Escribe tu nombre.' });
  if (phone.replace(/\D/g, '').length < 9 && !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) return sendJson(res, 400, { error: 'Indica un teléfono o un email válido.' });
  if (body.consent !== true) return sendJson(res, 400, { error: 'Necesitamos tu consentimiento para responderte.' });
  const p = m[2] === '0' ? null : data.properties.find(x => String(x.id) === m[2]);
  const lead = { id: crypto.randomBytes(8).toString('hex'), at: Date.now(), status: 'new', name, phone, email, message,
    propertyId: p ? String(p.id) : '', ref: p ? clip(p.reference, 20) : '', title: p ? niceTitleSrv(clip(p.title, 160), p) : '', source: p ? 'inmueble' : 'bio' };
  await withLock(`leads-${data.brand.id}`, async () => {
    const all = await readLeads(data.brand.id);
    all.unshift(lead);
    await writeAtomic(join(leadsDir, `${data.brand.id}.json`), JSON.stringify(all.slice(0, 3000)));
  });
  countHit(data.brand.id, 'click', `form:${lead.propertyId || 'bio'}`);
  notifyLead(data.brand, lead, originOf(req)).catch(err => console.error('Aviso de contacto', err.message));
  return sendJson(res, 200, { ok: true });
}

// ─── Avisos de contactos nuevos: email (SMTP) y/o Telegram, según lo configurado ───
// Variables: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM, NOTIFY_EMAIL, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID.
// Cada marca puede tener su propio email (notifyEmail) y chat de Telegram (telegramChatId).
const mailer = process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS
  ? nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 465), secure: Number(process.env.SMTP_PORT || 465) === 465, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } })
  : null;
const notifyChannels = brand => ({
  email: mailer && (/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(brand.notifyEmail || '') ? brand.notifyEmail : process.env.NOTIFY_EMAIL) || '',
  telegram: process.env.TELEGRAM_BOT_TOKEN && (String(brand.telegramChatId || '').match(/^-?\d{5,20}$/) ? brand.telegramChatId : process.env.TELEGRAM_CHAT_ID) || '',
});
async function notifyLead(brand, lead, origin) {
  const ch = notifyChannels(brand);
  if (!ch.email && !ch.telegram) return;
  const what = lead.ref ? `REF. ${lead.ref} · ${lead.title}` : 'Página de enlaces (bio)';
  const lines = [`Nuevo contacto para ${brand.name}`, `Inmueble: ${what}`, `Nombre: ${lead.name}`, lead.phone && `Teléfono: ${lead.phone}`, lead.email && `Email: ${lead.email}`, lead.message && `Mensaje: ${lead.message}`, `Ver en la app: ${origin}/#contactos`].filter(Boolean);
  const jobs = [];
  if (ch.email) jobs.push(mailer.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: ch.email, replyTo: lead.email || undefined, subject: `☏ Nuevo contacto · ${what}`, text: lines.join('\n') }));
  if (ch.telegram) jobs.push(fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: ch.telegram, text: lines.join('\n'), disable_web_page_preview: true }) }).then(r => { if (!r.ok) throw new Error(`Telegram ${r.status}`); }));
  const out = await Promise.allSettled(jobs);
  out.filter(o => o.status === 'rejected').forEach(o => console.error('Aviso de contacto no enviado:', o.reason?.message));
  return out;
}

// ─── Visitas y clics de la web pública (por día), sin cookies ni datos personales ───
const statsDir = join(dataDir, 'stats');
await mkdir(statsDir, { recursive: true });
const BOT_UA = /bot|crawl|spider|slurp|facebookexternalhit|whatsapp|telegram|preview|curl|wget|python|headless|lighthouse/i;
const statsBuf = new Map(), seenHits = new Map();
async function readStats(id) { try { return JSON.parse(await readFile(join(statsDir, `${id}.json`), 'utf8')); } catch { return { days: {} }; } }
function countHit(brandId, kind, key, req) {
  if (req) {
    if (BOT_UA.test(req.headers['user-agent'] || '')) return;
    const k = `${clientIp(req)}|${brandId}|${kind}|${key}`, t = seenHits.get(k);
    if (t && Date.now() - t < 30 * 60_000) return; // la misma persona recargando no cuenta dos veces
    seenHits.set(k, Date.now());
  }
  const day = new Date().toISOString().slice(0, 10), b = statsBuf.get(brandId) || {};
  const d = (b[day] ||= { views: {}, clicks: {} });
  const bucket = kind === 'view' ? d.views : d.clicks;
  bucket[key] = (bucket[key] || 0) + 1;
  statsBuf.set(brandId, b);
}
async function flushStats() {
  for (const [brandId, pending] of [...statsBuf]) {
    statsBuf.delete(brandId);
    await withLock(`stats-${brandId}`, async () => {
      const st = await readStats(brandId);
      for (const [day, d] of Object.entries(pending)) {
        const t = (st.days[day] ||= { views: {}, clicks: {} });
        for (const g of ['views', 'clicks']) for (const [k, n] of Object.entries(d[g])) t[g][k] = (t[g][k] || 0) + n;
      }
      const keep = Object.keys(st.days).sort().slice(-800);
      st.days = Object.fromEntries(keep.map(k => [k, st.days[k]]));
      await writeAtomic(join(statsDir, `${brandId}.json`), JSON.stringify(st));
    }).catch(err => console.error('Estadísticas', err.message));
  }
  const old = Date.now() - 30 * 60_000;
  for (const [k, t] of seenHits) if (t < old) seenHits.delete(k);
}
setInterval(flushStats, 20_000).unref();
async function handleHit(req, res, url) {
  const m = url.pathname.match(/^\/api\/hit\/([a-f0-9]{16})$/);
  if (!m || req.method !== 'POST') return sendJson(res, 404, { error: 'No encontrado' });
  const data = await brandByWebId(m[1]);
  if (!data) return sendJson(res, 404, { error: 'No encontrado' });
  const body = JSON.parse((await readRaw(req, 1024)).toString('utf8') || '{}');
  const kind = ['wa', 'tel', 'web'].includes(body.k) ? body.k : null, pid = /^[A-Za-z0-9_-]{1,40}$/.test(body.p || '') ? body.p : 'bio';
  if (kind) countHit(data.brand.id, 'click', `${kind}:${pid}`, req);
  return send(res, 204, '');
}

// ─── Google: robots.txt y mapa del sitio con las páginas públicas ───
async function publicSites() {
  const st = await readStore(), out = [];
  for (const b of st.brands.filter(b => b && safeWebId(b.webId))) { const d = await brandByWebId(b.webId); if (d) out.push(d); }
  return out;
}
async function sitemap(req) {
  const origin = originOf(req), urls = [];
  for (const d of await publicSites()) {
    urls.push(`${origin}/w/${d.brand.webId}`);
    d.properties.forEach(p => urls.push(`${origin}/w/${d.brand.webId}/${p.id}`));
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(u => `<url><loc>${escHtml(u)}</loc></url>`).join('\n')}\n</urlset>`;
}

// ─── Copia de seguridad diaria (estado, contactos, revisiones y estadísticas); se guardan 14 días ───
const backupsDir = join(dataDir, 'backups');
async function backupNow() {
  const dir = join(backupsDir, new Date().toISOString().slice(0, 10));
  await mkdir(dir, { recursive: true });
  await copyFile(stateFile, join(dir, 'state.json')).catch(() => {});
  await copyFile(storeFile, join(dir, 'store.json')).catch(() => {});
  await copyFile(usersFile, join(dir, 'users.json')).catch(() => {});
  for (const [src, name] of [[leadsDir, 'leads'], [reviewsDir, 'reviews'], [statsDir, 'stats']]) {
    const files = await readdir(src).catch(() => []);
    if (!files.length) continue;
    await mkdir(join(dir, name), { recursive: true });
    for (const f of files) await copyFile(join(src, f), join(dir, name, f)).catch(() => {});
  }
  const days = (await readdir(backupsDir)).filter(f => /^\d{4}-\d{2}-\d{2}$/.test(f)).sort();
  for (const old of days.slice(0, -14)) await rm(join(backupsDir, old), { recursive: true, force: true });
}
setTimeout(() => backupNow().catch(err => console.error('Copia de seguridad', err.message)), 60_000).unref();
setInterval(() => backupNow().catch(err => console.error('Copia de seguridad', err.message)), 24 * 3600_000).unref();


// ═══ Meta (Instagram y Facebook): conexión, medios de cada publicación, publicar y programar ═══
// Variables: META_APP_ID, META_APP_SECRET (de la app de Meta), PUBLIC_URL (por defecto https://studio.momentundigital.com).
// META_GRAPH_URL solo sirve para pruebas con un Meta simulado.
const META_VERSION = process.env.META_GRAPH_VERSION || 'v23.0';
const GRAPH = (process.env.META_GRAPH_URL || `https://graph.facebook.com/${META_VERSION}`).replace(/\/$/, '');
const META_DIALOG = process.env.META_DIALOG_URL || `https://www.facebook.com/${META_VERSION}/dialog/oauth`;
const metaConfigured = () => !!(process.env.META_APP_ID && process.env.META_APP_SECRET);
const PUBLIC_URL = (process.env.PUBLIC_URL || 'https://studio.momentundigital.com').replace(/\/$/, '');
const META_SCOPES = 'pages_show_list,pages_read_engagement,pages_manage_posts,instagram_basic,instagram_content_publish,instagram_manage_insights,business_management';
const metaDir = join(dataDir, 'meta'), mediaDir = join(dataDir, 'media');
await mkdir(metaDir, { recursive: true }); await mkdir(mediaDir, { recursive: true });
const safeKey = k => (/^[A-Za-z0-9_-]{1,40}$/.test(String(k || '')) ? String(k) : null);
async function readMeta(brandId) { try { return JSON.parse(await readFile(join(metaDir, `${brandId}.json`), 'utf8')); } catch { return null; } }
const writeMeta = (brandId, m) => writeAtomic(join(metaDir, `${brandId}.json`), JSON.stringify(m));
const metaPublic = m => m ? { connected: !!m.selected, user: m.user || '', selected: m.selected || null, pages: (m.pages || []).map(x => ({ id: x.id, name: x.name, igId: x.igId || null, igUsername: x.igUsername || null })), connectedAt: m.connectedAt } : { connected: false, pages: [] };
async function graph(method, path, params = {}) {
  const url = new URL(`${GRAPH}/${path.replace(/^\//, '')}`);
  const opt = { method };
  if (method === 'GET') Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : v));
  else opt.body = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)]));
  const r = await fetch(url, opt);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error?.error_user_msg || j.error?.message || `Meta respondió ${r.status}`);
  return j;
}
// Medios: imágenes y vídeo listos para publicar, guardados por publicación
async function mediaList(brandId, key) {
  const files = (await readdir(join(mediaDir, brandId, key)).catch(() => [])).filter(f => /^\d{1,2}\.(jpg|mp4)$/.test(f)).sort((a, b) => parseInt(a) - parseInt(b));
  return files.map(f => ({ file: f, type: f.endsWith('.mp4') ? 'video' : 'image' }));
}
const mediaSig = (brandId, key, file, exp) => sign(`media|${brandId}|${key}|${file}|${exp}`);
const publicMediaUrl = (brandId, key, file) => { const exp = Date.now() + 24 * 3600_000; return `${PUBLIC_URL}/m/${brandId}/${key}/${file}?e=${exp}&s=${mediaSig(brandId, key, file, exp)}`; };
async function handlePublicMedia(req, res, url) {
  const m = url.pathname.match(/^\/m\/([A-Za-z0-9_-]{1,40})\/([A-Za-z0-9_-]{1,40})\/(\d{1,2}\.(?:jpg|mp4))$/);
  const exp = Number(url.searchParams.get('e'));
  if (!m || !(exp > Date.now()) || !safeEqual(url.searchParams.get('s') || '', mediaSig(m[1], m[2], m[3], exp))) return send(res, 404, 'No encontrado', { 'Content-Type': 'text/plain' });
  try { return send(res, 200, await readFile(join(mediaDir, m[1], m[2], m[3])), { 'Content-Type': m[3].endsWith('.mp4') ? 'video/mp4' : 'image/jpeg', 'Cache-Control': 'private, max-age=600' }); }
  catch { return send(res, 404, 'No encontrado', { 'Content-Type': 'text/plain' }); }
}
// Hora de Madrid → instante real (tiene en cuenta el horario de verano)
function madridToMs(date, time) {
  const [y, mo, d] = String(date).split('-').map(Number), [h, mi] = String(time || '13:00').split(':').map(Number);
  if (!y || !mo || !d) return NaN;
  const guess = Date.UTC(y, mo - 1, d, h || 0, mi || 0);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Madrid', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(guess)).map(x => [x.type, x.value]));
  const asMadrid = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  return guess - (asMadrid - guess);
}
const META_FIELDS = ['metaStatus', 'metaError', 'metaLinks', 'metaAt', 'publishedAt', 'metaVerified', 'mediaCleaned'];
async function updateItem(brandId, id, changes) {
  await withLock('store', async () => {
    const st = await readStore(), it = (st.data[brandId]?.content || []).find(x => String(x.id) === String(id));
    if (!it) return;
    Object.assign(it, changes, { updatedAt: Date.now() });
    await writeStore(st);
  });
}
async function waitContainer(id, token) {
  for (let i = 0; i < 60; i++) {
    const r = await graph('GET', id, { fields: 'status_code,status', access_token: token });
    if (r.status_code === 'FINISHED') return;
    if (r.status_code === 'ERROR' || r.status_code === 'EXPIRED') throw new Error(`Meta no pudo procesar el vídeo (${r.status || r.status_code})`);
    await new Promise(ok => setTimeout(ok, Number(process.env.META_POLL_MS || 5000)));
  }
  throw new Error('Meta tarda demasiado en procesar el vídeo');
}
// Mismo criterio que la app: solo el texto publicable
function publishCaption(item){const lines=String(item.caption||'').replace(/\r/g,'').split('\n');
 const tagIdx=lines.findIndex(l=>/^\s*(#[^\s#]+\s*)+$/.test(l)),tags=tagIdx>=0?lines.slice(tagIdx).filter(l=>/#/.test(l)).join(' ').trim():'',body=(tagIdx>=0?lines.slice(0,tagIdx):lines).join('\n');
 let out=body;const m=body.match(/(?:^|\n)\s*Texto:\s*([\s\S]*)$/i);
 if(m)out=m[1];else if(/^\s*(Gancho|Guion):/im.test(body)){const g=body.match(/Gancho:\s*(.+)/i)||body.match(/Guion:\s*(.+)/i);out=(g?g[1]:'')+(item.propertyRef?`\n\nREF. ${item.propertyRef} · Pide información por mensaje`:'')}
 out=out.replace(/\n\s*Diapositivas:[\s\S]*$/i,'').replace(/^\s*(Portada|Cierre):\s*/gim,'');
 if(item.type==='Historia')out=out.replace(/^\s*\d+\.\s*/gm,'');
 if(item.propertyRef&&item.type!=='Historia'&&!/\bREF\.\s*\S/i.test(out))out+=`\n\n📩 Pide información o visita · REF. ${item.propertyRef}`;
 out=out.replace(/\n{3,}/g,'\n\n').trim();return tags?`${out}\n\n${tags}`:out}
const publishing = new Set();
async function publishItem(brandId, item) {
  const key = `${brandId}:${item.id}`;
  if (publishing.has(key)) return;
  publishing.add(key);
  try {
    const meta = await readMeta(brandId), page = meta?.pages?.find(x => x.id === meta.selected), token = meta?.tokens?.[meta?.selected];
    if (!page || !token) throw new Error('La empresa no tiene Instagram/Facebook conectado');
    const media = await mediaList(brandId, String(item.id));
    if (!media.length) throw new Error('Faltan las imágenes o el vídeo: pulsa «Preparar medios»');
    await updateItem(brandId, item.id, { metaStatus: 'publishing', metaError: '' });
    const urls = media.map(m => ({ ...m, url: publicMediaUrl(brandId, String(item.id), m.file) }));
    const images = urls.filter(m => m.type === 'image'), video = urls.find(m => m.type === 'video');
    const caption = publishCaption(item).slice(0, 2200), ch = String(item.channel || ''), links = {};
    const toIG = /instagram/i.test(ch) && page.igId, toFB = /facebook/i.test(ch) || (!toIG && !/instagram/i.test(ch));
    if (/instagram/i.test(ch) && !page.igId) throw new Error('La página de Facebook conectada no tiene una cuenta de Instagram profesional vinculada');
    if (toIG) {
      const ig = page.igId;
      if (item.type === 'Reel') {
        if (!video) throw new Error('Falta el vídeo del reel');
        const c = await graph('POST', `${ig}/media`, { media_type: 'REELS', video_url: video.url, caption, share_to_feed: 'true', access_token: token });
        await waitContainer(c.id, token);
        links.instagram = (await graph('POST', `${ig}/media_publish`, { creation_id: c.id, access_token: token })).id;
      } else if (item.type === 'Historia') {
        const ids = [];
        for (const m of (video ? [video] : images.slice(0, 5))) {
          const c = await graph('POST', `${ig}/media`, { media_type: 'STORIES', [m.type === 'video' ? 'video_url' : 'image_url']: m.url, access_token: token });
          if (m.type === 'video') await waitContainer(c.id, token);
          ids.push((await graph('POST', `${ig}/media_publish`, { creation_id: c.id, access_token: token })).id);
        }
        links.instagram = ids.join(',');
      } else if (images.length > 1) {
        const children = [];
        for (const m of images.slice(0, 10)) children.push((await graph('POST', `${ig}/media`, { image_url: m.url, is_carousel_item: 'true', access_token: token })).id);
        const c = await graph('POST', `${ig}/media`, { media_type: 'CAROUSEL', children: children.join(','), caption, access_token: token });
        links.instagram = (await graph('POST', `${ig}/media_publish`, { creation_id: c.id, access_token: token })).id;
      } else {
        if (!images[0]) throw new Error('Falta la imagen');
        const c = await graph('POST', `${ig}/media`, { image_url: images[0].url, caption, access_token: token });
        links.instagram = (await graph('POST', `${ig}/media_publish`, { creation_id: c.id, access_token: token })).id;
      }
    }
    if (toFB && item.type !== 'Historia') {
      if (video) links.facebook = (await graph('POST', `${page.id}/videos`, { file_url: video.url, description: caption, access_token: token })).id;
      else if (images.length > 1) {
        const ids = [];
        for (const m of images.slice(0, 10)) ids.push((await graph('POST', `${page.id}/photos`, { url: m.url, published: 'false', access_token: token })).id);
        links.facebook = (await graph('POST', `${page.id}/feed`, { message: caption, attached_media: ids.map(id => ({ media_fbid: id })), access_token: token })).id;
      } else links.facebook = (await graph('POST', `${page.id}/photos`, { url: images[0].url, message: caption, access_token: token })).post_id || null;
    }
    // Comprobación: se pide a Meta el enlace de cada publicación para confirmar que existe
    const permalinks = {};
    if (links.instagram) { try { permalinks.instagram = (await graph('GET', String(links.instagram).split(',')[0], { fields: 'permalink', access_token: token })).permalink || ''; } catch {} }
    if (links.facebook) { try { permalinks.facebook = (await graph('GET', links.facebook, { fields: 'permalink_url', access_token: token })).permalink_url || ''; } catch {} }
    await updateItem(brandId, item.id, { metaStatus: 'published', metaError: '', metaLinks: { ...links, permalinks }, metaVerified: !!(permalinks.instagram || permalinks.facebook), metaAt: Date.now(), status: 'published', publishedAt: Date.now() });
    console.log('Publicado en Meta', brandId, item.id, JSON.stringify(links));
  } catch (err) {
    console.error('Error al publicar en Meta', brandId, item.id, err.message);
    await updateItem(brandId, item.id, { metaStatus: 'error', metaError: String(err.message).slice(0, 300) }).catch(() => {});
  } finally { publishing.delete(key); }
}
// Programador: cada minuto publica lo aprobado cuya hora ya ha llegado
async function metaScheduler() {
  if (!metaConfigured()) return;
  const st = await readStore();
  for (const b of st.brands) {
    const meta = await readMeta(b.id);
    if (!meta?.selected) continue;
    for (const it of brandDataOf(st, b.id).content || []) {
      if (it.metaStatus === 'published' && it.metaVerified && !it.mediaCleaned && (it.metaAt || 0) < Date.now() - 7 * 864e5) {
        await rm(join(mediaDir, b.id, String(it.id)), { recursive: true, force: true }); await updateItem(b.id, it.id, { mediaCleaned: true }); continue;
      }
      if (!it.autoPublish || ['published', 'publishing'].includes(it.metaStatus) || it.status === 'published' || !['approved', 'scheduled'].includes(it.status)) continue;
      if (it.metaStatus === 'error' && (it.metaAt || 0) > Date.now() - 6 * 3600_000) continue; // tras un error no se reintenta sin parar
      const due = madridToMs(it.date, it.time);
      if (due <= Date.now() && due > Date.now() - 3 * 864e5) publishItem(b.id, it);
    }
  }
}
setInterval(() => metaScheduler().catch(err => console.error('Programador Meta', err.message)), 60_000).unref();

async function handleMeta(req, res, url, user) {
  const deny = () => sendJson(res, 403, { error: 'No tienes acceso a esta empresa' });
  // Medios de una publicación
  const mm = url.pathname.match(/^\/api\/media\/([A-Za-z0-9_-]{1,40})\/([A-Za-z0-9_-]{1,40})(?:\/(\d{1,2}\.(?:jpg|mp4)))?$/);
  if (mm) {
    const [, brandId, key, file] = mm;
    if (!canBrand(user, brandId)) return deny();
    const dir = join(mediaDir, brandId, key);
    if (file && req.method === 'GET') { try { return send(res, 200, await readFile(join(dir, file)), { 'Content-Type': file.endsWith('.mp4') ? 'video/mp4' : 'image/jpeg', 'Cache-Control': 'private, max-age=60' }); } catch { return sendJson(res, 404, { error: 'No encontrado' }); } }
    if (!file && req.method === 'GET') return sendJson(res, 200, (await mediaList(brandId, key)).map(m => ({ ...m, url: `/api/media/${brandId}/${key}/${m.file}` })));
    if (!file && req.method === 'DELETE') { await rm(dir, { recursive: true, force: true }); return sendJson(res, 200, { ok: true }); }
    if (!file && req.method === 'PUT') {
      const i = Number(url.searchParams.get('i')), video = url.searchParams.get('type') === 'video';
      if (!(i >= 0 && i < 20)) return sendJson(res, 400, { error: 'Posición no válida' });
      const body = await readRaw(req, video ? 120 * 1024 * 1024 : 8 * 1024 * 1024);
      const isJpg = body[0] === 0xff && body[1] === 0xd8, isMp4 = body.toString('ascii', 4, 8) === 'ftyp';
      if (video ? !isMp4 : !isJpg) return sendJson(res, 400, { error: video ? 'El vídeo debe ser MP4' : 'La imagen debe ser JPG' });
      await mkdir(dir, { recursive: true });
      for (const old of await mediaList(brandId, key)) if (parseInt(old.file) === i) await unlink(join(dir, old.file)).catch(() => {});
      await writeFile(join(dir, `${i}.${video ? 'mp4' : 'jpg'}`), body);
      return sendJson(res, 200, { ok: true, bytes: body.length });
    }
    return sendJson(res, 405, { error: 'Método no permitido' });
  }
  const brandId = safeBrandId(url.searchParams.get('brand'));
  if (url.pathname === '/api/meta/status') {
    if (!brandId || !canBrand(user, brandId)) return deny();
    return sendJson(res, 200, { configured: metaConfigured(), ...metaPublic(await readMeta(brandId)) });
  }
  if (url.pathname === '/api/meta/connect') {
    if (!brandId || !canBrand(user, brandId)) return deny();
    if (!metaConfigured()) return sendJson(res, 400, { error: 'Falta configurar la app de Meta (META_APP_ID y META_APP_SECRET) en el servidor' });
    const state = `${brandId}.${user.id}.${Date.now()}`;
    const dialog = new URL(META_DIALOG);
    Object.entries({ client_id: process.env.META_APP_ID, redirect_uri: `${PUBLIC_URL}/api/meta/callback`, state: `${state}.${sign(state)}`, scope: META_SCOPES, response_type: 'code' }).forEach(([k, v]) => dialog.searchParams.set(k, v));
    res.writeHead(302, { Location: dialog.toString() });
    return res.end();
  }
  if (url.pathname === '/api/meta/callback') {
    const back = msg => { res.writeHead(302, { Location: `/#meta=${encodeURIComponent(msg)}` }); return res.end(); };
    const [bId, uid, ts, sig] = String(url.searchParams.get('state') || '').split('.');
    if (!sig || !safeEqual(sig, sign(`${bId}.${uid}.${ts}`)) || Date.now() - Number(ts) > 30 * 60_000 || uid !== user.id || !canBrand(user, bId)) return back('error:El enlace de conexión ha caducado. Vuelve a intentarlo.');
    if (url.searchParams.get('error')) return back('error:Has cancelado la conexión con Meta.');
    try {
      const redirect_uri = `${PUBLIC_URL}/api/meta/callback`;
      const short = await graph('GET', 'oauth/access_token', { client_id: process.env.META_APP_ID, client_secret: process.env.META_APP_SECRET, redirect_uri, code: url.searchParams.get('code') });
      const long = await graph('GET', 'oauth/access_token', { grant_type: 'fb_exchange_token', client_id: process.env.META_APP_ID, client_secret: process.env.META_APP_SECRET, fb_exchange_token: short.access_token });
      const me = await graph('GET', 'me', { fields: 'name', access_token: long.access_token });
      const acc = await graph('GET', 'me/accounts', { fields: 'id,name,access_token,instagram_business_account{id,username}', limit: 100, access_token: long.access_token });
      const pages = (acc.data || []).map(p => ({ id: p.id, name: p.name, igId: p.instagram_business_account?.id || null, igUsername: p.instagram_business_account?.username || null }));
      if (!pages.length) return back('error:Tu usuario de Facebook no administra ninguna página. Crea o vincula la página de la empresa e inténtalo de nuevo.');
      const tokens = Object.fromEntries((acc.data || []).map(p => [p.id, p.access_token]));
      const selected = pages.length === 1 ? pages[0].id : (pages.find(p => p.igId)?.id && pages.filter(p => p.igId).length === 1 ? pages.find(p => p.igId).id : null);
      await writeMeta(bId, { user: me.name || '', pages, tokens, selected, connectedAt: Date.now() });
      return back(selected ? 'ok:Conectado' : 'elegir:Elige qué página usar');
    } catch (err) { console.error('Conexión Meta', err.message); return back(`error:${err.message}`); }
  }
  if (url.pathname === '/api/meta/select' && req.method === 'POST') {
    if (!brandId || !canBrand(user, brandId)) return deny();
    const body = JSON.parse((await readRaw(req, 2048)).toString('utf8') || '{}'), meta = await readMeta(brandId);
    if (!meta?.pages?.some(p => p.id === body.pageId)) return sendJson(res, 400, { error: 'Página no válida' });
    meta.selected = body.pageId; await writeMeta(brandId, meta);
    return sendJson(res, 200, metaPublic(meta));
  }
  if (url.pathname === '/api/meta/disconnect' && req.method === 'POST') {
    if (!brandId || !canBrand(user, brandId)) return deny();
    await rm(join(metaDir, `${brandId}.json`), { force: true });
    return sendJson(res, 200, { ok: true });
  }
  if (url.pathname === '/api/meta/publish' && req.method === 'POST') {
    if (!brandId || !canBrand(user, brandId)) return deny();
    const body = JSON.parse((await readRaw(req, 2048)).toString('utf8') || '{}');
    const it = (brandDataOf(await readStore(), brandId).content || []).find(x => String(x.id) === String(body.contentId));
    if (!it) return sendJson(res, 404, { error: 'Publicación no encontrada' });
    if (it.metaStatus === 'published') return sendJson(res, 400, { error: 'Ya está publicada' });
    publishItem(brandId, it);
    return sendJson(res, 202, { ok: true });
  }
  if (url.pathname === '/api/meta/unpublish' && req.method === 'POST') {
    if (!brandId || !canBrand(user, brandId)) return deny();
    const body = JSON.parse((await readRaw(req, 2048)).toString('utf8') || '{}');
    const it = (brandDataOf(await readStore(), brandId).content || []).find(x => String(x.id) === String(body.contentId));
    if (!it || it.metaStatus !== 'published') return sendJson(res, 400, { error: 'Esta publicación no está publicada desde la app' });
    const meta = await readMeta(brandId), token = meta?.tokens?.[meta?.selected];
    if (!token) return sendJson(res, 400, { error: 'La empresa no tiene Instagram/Facebook conectado' });
    const done = [], failed = [];
    if (it.metaLinks?.facebook) { try { await graph('DELETE', it.metaLinks.facebook, { access_token: token }); done.push('facebook'); } catch (err) { failed.push(`Facebook: ${err.message}`); } }
    for (const id of String(it.metaLinks?.instagram || '').split(',').filter(Boolean)) {
      try { await graph('DELETE', id, { access_token: token }); if (!done.includes('instagram')) done.push('instagram'); }
      catch (err) { failed.push(`Instagram no permite borrarla desde fuera de su app (${err.message}). Ábrela con el enlace y bórrala desde Instagram.`); break; }
    }
    const keep = { ...(it.metaLinks || {}) }; if (done.includes('facebook')) delete keep.facebook; if (done.includes('instagram')) delete keep.instagram;
    const left = keep.facebook || keep.instagram;
    await updateItem(brandId, it.id, left ? { metaLinks: keep, metaError: failed.join(' · ') } : { metaStatus: 'removed', metaLinks: {}, metaVerified: false, metaError: '', status: 'approved', autoPublish: false });
    return sendJson(res, failed.length ? 207 : 200, { removed: done, errors: failed, permalinks: it.metaLinks?.permalinks || {} });
  }
  return sendJson(res, 404, { error: 'No encontrado' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/vendor/mp4-muxer.mjs' && mp4MuxerJs) {
    return send(res, 200, mp4MuxerJs, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=86400' });
  }

  if (url.pathname === '/health') {
    return send(res, 200, 'ok', { 'Content-Type': 'text/plain; charset=utf-8' });
  }

  if (url.pathname === '/login' && req.method === 'GET') {
    if (validSession(req)) {
      res.writeHead(302, { Location: '/' });
      return res.end();
    }
    return send(res, 200, loginPage(url.searchParams.get('error') === '2' ? 'lock' : url.searchParams.has('error')), {
      'Content-Type': 'text/html; charset=utf-8',
    });
  }

  if (url.pathname === '/login' && req.method === 'POST') {
    try {
      // Freno a quien intente adivinar la contraseña: 5 fallos en 15 minutos bloquean esa conexión 15 minutos
      const ip = clientIp(req), fails = (loginFails.get(ip) || []).filter(t => Date.now() - t < 15 * 60_000);
      if (fails.length >= 5) {
        res.writeHead(303, { Location: '/login?error=2' });
        return res.end();
      }
      const form = new URLSearchParams(await readBody(req));
      const user = await authenticate(form.get('username') || '', form.get('password') || '');
      if (!user) {
        fails.push(Date.now()); loginFails.set(ip, fails);
        if (fails.length === 5) console.warn('Acceso bloqueado 15 minutos por intentos fallidos desde', ip);
        res.writeHead(303, { Location: fails.length >= 5 ? '/login?error=2' : '/login?error=1' });
        return res.end();
      }
      loginFails.delete(ip);
      const secure = isProduction ? '; Secure' : '';
      res.writeHead(303, {
        Location: '/',
        'Set-Cookie': `ruano_session=${encodeURIComponent(createSession(user))}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure}`,
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

  // Rutas públicas de revisión (el enlace secreto hace de llave)
  if (/^\/r\/[a-f0-9]{24}$/.test(url.pathname)) {
    return send(res, 200, reviewPage(), { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex' });
  }
  if (url.pathname.startsWith('/api/review/')) {
    try { return await handleReview(req, res, url); }
    catch (err) { console.error('Revisión', err.message); return sendJson(res, err instanceof SyntaxError ? 400 : 500, { error: 'No se pudo completar' }); }
  }
  // Web pública de la inmobiliaria (inmuebles y página de enlaces) y formulario de contacto
  if (url.pathname.startsWith('/m/') && req.method === 'GET') return handlePublicMedia(req, res, url);
  if (url.pathname.startsWith('/w/') && req.method === 'GET') {
    try { return await handleWeb(req, res, url); }
    catch (err) { console.error('Web', err.message); return send(res, 500, 'No se pudo cargar la página', { 'Content-Type': 'text/plain; charset=utf-8' }); }
  }
  if (url.pathname.startsWith('/api/hit/')) {
    try { return await handleHit(req, res, url); } catch { return send(res, 204, ''); }
  }
  if (url.pathname === '/robots.txt') {
    return send(res, 200, `User-agent: *
Allow: /w/
Disallow: /
Sitemap: ${originOf(req)}/sitemap.xml
`, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
  }
  if (url.pathname === '/sitemap.xml') {
    try { return send(res, 200, await sitemap(req), { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' }); }
    catch { return send(res, 500, '', { 'Content-Type': 'text/plain' }); }
  }
  if (url.pathname.startsWith('/api/lead/')) {
    try { return await handleLead(req, res, url); }
    catch (err) { console.error('Contacto', err.message); return sendJson(res, err instanceof SyntaxError ? 400 : 500, { error: 'No se pudo enviar. Inténtalo de nuevo.' }); }
  }

  const user = currentUser(req);
  if (!user) {
    if (url.pathname.startsWith('/api/')) return sendJson(res, 401, { error: 'Sesión caducada' });
    res.writeHead(302, { Location: '/login' });
    return res.end();
  }

  if (url.pathname.startsWith('/api/')) {
    try {
      return await handleApi(req, res, url, user);
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
  console.log(`Momentun Digital Studio escuchando en el puerto ${port}`);
});
