function invalid(message) { const error = new Error(message); error.status = 400; throw error; }
function string(value, limit, required = false) {
  if (typeof value !== 'string' || value.length > limit || (required && !value.trim()))
    invalid('Texto no válido');
  return value;
}
const statuses = new Set(['pending','approved','scheduled']);
const types = new Set(['Publicación','Carrusel','Historia','Reel']);
const channels = new Set(['Instagram','Facebook','Instagram + Facebook']);
export function validateBrand(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Marca no válida');
  const brand = {};
  for (const field of ['name','tagline','phone','website']) brand[field] = string(value[field] ?? '',field === 'website' ? 2000 : 200);
  if (brand.website) { let url; try { url=new URL(brand.website); } catch { invalid('Web de marca no válida'); }
    if (!['http:','https:'].includes(url.protocol)) invalid('Web de marca no válida'); }
  brand.color = string(value.color ?? '#0b315f',7);
  if (!/^#[a-f0-9]{6}$/i.test(brand.color)) invalid('Color no válido');
  brand.logo = string(value.logo ?? '',450000);
  if (brand.logo) {
    const match=/^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(brand.logo);
    if (!match || match[2].length % 4 !== 0) invalid('Usa un logotipo PNG o JPEG');
    const bytes=Buffer.from(match[2],'base64');
    if (bytes.length > 300000 || (match[1] === 'png' ? bytes.subarray(0,8).toString('hex') !== '89504e470d0a1a0a' : bytes.subarray(0,3).toString('hex') !== 'ffd8ff')) invalid('Logotipo no válido');
  }
  return brand;
}
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
  const propertyIds = new Set(), references = new Set();
  const properties = data.properties.map(item => {
    if (!item || !Number.isSafeInteger(item.id) || item.id < 1 || propertyIds.has(item.id)) invalid('ID de inmueble no válido');
    propertyIds.add(item.id);
    const result = {id:item.id};
    for (const field of ['reference','title','location','price','built','useful','beds','baths','floor','extras'])
      result[field] = string(item[field] || '', field === 'extras' ? 2000 : 200, field === 'title');
    if (result.reference.trim()) { const ref=result.reference.trim().toLowerCase(); if (references.has(ref)) invalid('Referencia de inmueble duplicada'); references.add(ref); }
    result.url = string(item.url || '',2000);
    if (result.url) {
      let url; try { url = new URL(result.url); } catch { invalid('URL no válida'); }
      if (!['http:','https:'].includes(url.protocol)) invalid('URL no válida');
    }
    if (!Number.isSafeInteger(item.photos) || item.photos < 0 || item.photos > 10000) invalid('Fotos no válidas');
    result.photos = item.photos;
    return result;
  });
  const selectedPropertyId=data.selectedPropertyId ?? null;
  if (selectedPropertyId !== null && (!Number.isSafeInteger(selectedPropertyId) || !propertyIds.has(selectedPropertyId))) invalid('Inmueble seleccionado no válido');
  for (const item of content) if (item.propertyRef?.startsWith('inmueble:') && !propertyIds.has(Number(item.propertyRef.slice(9)))) invalid('Contenido vinculado a un inmueble inexistente');
  return {version:input.version,data:{content,properties,workflowStep:data.workflowStep,
    ...(data.selectedPropertyId !== undefined ? {selectedPropertyId} : {}),
    ...(data.brand !== undefined ? {brand:validateBrand(data.brand)} : {})}};
}
