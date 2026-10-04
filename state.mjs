function invalid(message) { const error = new Error(message); error.status = 400; throw error; }
function string(value, limit, required = false) {
  if (typeof value !== 'string' || value.length > limit || (required && !value.trim()))
    invalid('Texto no válido');
  return value;
}
const statuses = new Set(['pending','approved','scheduled']);
const types = new Set(['Publicación','Carrusel','Historia','Reel']);
const channels = new Set(['Instagram','Facebook','Instagram + Facebook']);
export function validateState(input) {
  if (!input || !Number.isSafeInteger(input.version) || input.version < 0) invalid('Versión no válida');
  const data = input.data;
  if (!data || !Array.isArray(data.content) || !Array.isArray(data.properties) ||
    data.content.length > 2000 || data.properties.length > 1000 ||
    !Number.isInteger(data.workflowStep) || data.workflowStep < 1 || data.workflowStep > 6)
    invalid('Datos no válidos');
  const ids = new Set();
  const content = data.content.map(item => {
    if (!item || !Number.isSafeInteger(item.id) || item.id < 1 || ids.has(item.id)) invalid('ID no válido');
    ids.add(item.id);
    if (!statuses.has(item.status) || !types.has(item.type) || !channels.has(item.channel))
      invalid('Tipo, canal o estado no válido');
    const date = string(item.date, 10, true);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) ||
      new Date(date).toISOString().slice(0,10) !== date) invalid('Fecha no válida');
    return { id:item.id, title:string(item.title,200,true), caption:string(item.caption,10000),
      status:item.status, type:item.type, channel:item.channel, date,
      icon:string(item.icon || '⌂',8), ...(item.propertyRef ? {propertyRef:string(item.propertyRef,100)} : {}) };
  });
  const propertyIds = new Set();
  const properties = data.properties.map(item => {
    if (!item || !Number.isSafeInteger(item.id) || item.id < 1 || propertyIds.has(item.id)) invalid('ID de inmueble no válido');
    propertyIds.add(item.id);
    const result = {id:item.id};
    for (const field of ['reference','title','location','price','built','useful','beds','baths','floor','extras'])
      result[field] = string(item[field] || '', field === 'extras' ? 2000 : 200, field === 'title');
    result.url = string(item.url || '',2000);
    if (result.url) {
      let url; try { url = new URL(result.url); } catch { invalid('URL no válida'); }
      if (!['http:','https:'].includes(url.protocol)) invalid('URL no válida');
    }
    if (!Number.isSafeInteger(item.photos) || item.photos < 0 || item.photos > 10000) invalid('Fotos no válidas');
    result.photos = item.photos;
    return result;
  });
  return {version:input.version,data:{content,properties,workflowStep:data.workflowStep}};
}
