// Shared input boundaries; storage identifiers are never filesystem paths.
export const resourceId = value => {
  const id = String(value ?? '');
  return /^[A-Za-z0-9_-]{1,40}$/.test(id) && !['__proto__', 'prototype', 'constructor'].includes(id) ? id : null;
};

export function parseCookies(req) {
  const cookies = Object.create(null);
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const name = part.slice(0, i).trim();
    try { cookies[name] = decodeURIComponent(part.slice(i + 1).trim()); }
    catch { delete cookies[name]; } // A malformed cookie is not a valid session.
  }
  return cookies;
}

const types = ['Publicación', 'Carrusel', 'Historia', 'Reel'];
const statuses = ['pending', 'approved', 'scheduled', 'published'];
const channels = ['Instagram', 'Facebook', 'Instagram + Facebook'];
const icons = ['⌂', '◉', '≡', '▶', '€', '☺', '☀', '◇', '✦', '⭐'];
export function normalizeContent(item) {
  const out = { ...item };
  out.type = types.includes(out.type) ? out.type : 'Publicación';
  out.channel = channels.includes(out.channel) ? out.channel : 'Instagram';
  out.status = statuses.includes(out.status) ? out.status : 'pending';
  out.icon = icons.includes(out.icon) ? out.icon : ({ 'Publicación': '⌂', Carrusel: '≡', Historia: '◉', Reel: '▶' })[out.type];
  return out;
}
