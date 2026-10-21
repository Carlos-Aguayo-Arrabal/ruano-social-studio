import http from 'node:http';
import crypto from 'node:crypto';
import { readFile, writeFile, mkdir, rename, unlink, copyFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
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

// Copia de seguridad del estado en cada arranque; se guardan las 10 últimas
try {
  await copyFile(stateFile, join(dataDir, `state.backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
  const backups = (await readdir(dataDir)).filter(f => f.startsWith('state.backup-')).sort();
  for (const f of backups.slice(0, -10)) await unlink(join(dataDir, f));
} catch {}
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

async function handleApi(req, res, url) {
  if (url.pathname === '/api/reviews' && req.method === 'GET') {
    const id = safeBrandId(url.searchParams.get('brand'));
    return sendJson(res, id ? 200 : 400, id ? await readReviews(id) : { error: 'Empresa no válida' });
  }

  if (url.pathname.startsWith('/api/ai/')) return handleAi(req, res, url);

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
      await withLock('state', async () => {
        // Protección: un navegador sin la lista de empresas no puede borrar las marcas ni los datos de las demás
        const current = parseJson(await readFile(stateFile, 'utf8').catch(() => ''), {});
        for (const k of ['ruanoBrands', 'ruanoActiveBrand', 'ruanoBrandData']) if (!(k in data) && k in current) data[k] = current[k];
        await writeAtomic(stateFile, JSON.stringify(data));
      });
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
  <title>Acceso · Momentun Digital</title>
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
  <div class="logo">M</div>
  <h1>Momentun Digital</h1>
  <p>Acceso privado al estudio de contenidos para redes sociales de inmobiliarias.</p>
  ${error ? '<div class="error">Usuario o contraseña incorrectos.</div>' : ''}
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
  const st = parseJson(await readFile(stateFile, 'utf8').catch(() => ''), {});
  const brands = parseJson(st.ruanoBrands, []);
  const brand = brands.find(b => b && b.reviewToken === token);
  if (!brand || !safeBrandId(brand.id)) return null;
  const active = st.ruanoActiveBrand || brands[0]?.id;
  const src = brand.id === active ? st : (parseJson(st.ruanoBrandData, {})[brand.id] || {});
  return { brand, content: parseJson(src.ruanoContent, []), properties: parseJson(src.ruanoProperties, []) };
}
const reviewHits = new Map();
async function handleReview(req, res, url) {
  const m = url.pathname.match(/^\/api\/review\/([a-f0-9]{24})(?:\/(photo\/(\d{1,20})|(\d{1,20})))?$/);
  if (!m) return sendJson(res, 404, { error: 'No encontrado' });
  const hits = (reviewHits.get(m[1]) || []).filter(t => Date.now() - t < 3600_000); hits.push(Date.now()); reviewHits.set(m[1], hits);
  if (hits.length > 600) return sendJson(res, 429, { error: 'Demasiadas peticiones. Inténtalo más tarde.' });
  const data = await brandByToken(m[1]);
  if (!data) return sendJson(res, 404, { error: 'Enlace no válido' });
  if (m[3]) {
    const prop = data.properties.find(p => String(p.id) === m[3]);
    const ph = prop && (await readManifest(String(prop.id))).photos?.[0];
    if (!ph || !safeId(ph.id)) return sendJson(res, 404, { error: 'Sin foto' });
    for (const [ext, type] of [['webp', 'image/webp'], ['jpg', 'image/jpeg']]) {
      try { return send(res, 200, await readFile(join(photosDir, String(prop.id), `${ph.id}.${ext}`)), { 'Content-Type': type, 'Cache-Control': 'private, max-age=3600' }); } catch {}
    }
    return sendJson(res, 404, { error: 'Sin foto' });
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
        review: rv && rv.at >= (x.updatedAt || 0) ? rv : null, photo: prop ? `/api/review/${m[1]}/photo/${prop.id}` : null };
    });
  const b = data.brand;
  return sendJson(res, 200, { brand: { name: b.name, color: b.color, color2: b.color2, logo: b.logo || '' }, items });
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
.card img{width:100%;max-height:340px;object-fit:cover;display:block;background:#e9eef2}
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

  // Rutas públicas de revisión (el enlace secreto hace de llave)
  if (/^\/r\/[a-f0-9]{24}$/.test(url.pathname)) {
    return send(res, 200, reviewPage(), { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex' });
  }
  if (url.pathname.startsWith('/api/review/')) {
    try { return await handleReview(req, res, url); }
    catch (err) { console.error('Revisión', err.message); return sendJson(res, err instanceof SyntaxError ? 400 : 500, { error: 'No se pudo completar' }); }
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
  console.log(`Momentun Digital Studio escuchando en el puerto ${port}`);
});
