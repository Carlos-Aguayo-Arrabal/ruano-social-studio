'use strict';
window.RSS = (() => {
  let organization, version, loading = true, saving = false, blocked = false;
  let committed, organizations = [];
  const html = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  async function request(path, options = {}) {
    const response = await fetch(path,{...options,credentials:'same-origin',headers:{'Content-Type':'application/json',...options.headers}});
    if (response.status === 401) { location.assign('/login'); throw new Error('Sesión caducada'); }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'No se pudo guardar');
    return result;
  }
  function busy(value) { document.querySelector('.app-shell')?.setAttribute('inert', value ? '' : 'false');
    if (!value) document.querySelector('.app-shell')?.removeAttribute('inert'); }
  async function ready() {
    busy(true);
    try {
      const me = await request('/api/me'); organizations = me.organizations;
      if (!organizations.length) throw new Error('Tu usuario aún no tiene una empresa asignada. Contacta con el administrador.');
      organization = organizations[0];
      const state = await request(`/api/organizations/${organization.id}/state`);
      version = state.version; committed = structuredClone(state.data); loading = false;
      document.querySelector('.company-switcher strong').textContent = organization.name;
      document.querySelector('#activeCompanyName').textContent = organization.name;
      return structuredClone(committed);
    } catch(error) {
      document.body.replaceChildren(); const p = document.createElement('p'); p.textContent = error.message; document.body.append(p);
      throw error;
    } finally { if (!loading) busy(false); }
  }
  async function save(data) {
    if (organization.role === 'viewer') throw new Error('Tu cuenta tiene permiso de solo lectura.');
    if (blocked || saving || loading) throw new Error('Espera al guardado o recarga la página.');
    saving = true; busy(true);
    try {
      const result = await request(`/api/organizations/${organization.id}/state`,{
        method:'PUT',body:JSON.stringify({version,data})});
      version = result.version; committed = structuredClone(result.data);
    } catch(error) {
      blocked = true;
      const warning = document.createElement('div'); warning.setAttribute('role','alert');
      warning.style.cssText = 'position:fixed;inset:0;z-index:10000;background:#fff;padding:40px;display:grid;place-content:center';
      const p = document.createElement('p'); p.textContent = error.message + ' No se ha confirmado el guardado.';
      const exportButton = document.createElement('button'); exportButton.textContent = 'Descargar mis cambios';
      exportButton.onclick = () => { const url = URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
        const a = document.createElement('a'); a.href = url; a.download = 'social-studio-cambios.json'; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000); };
      const reload = document.createElement('button'); reload.textContent = 'Recargar datos del servidor'; reload.onclick = () => location.reload();
      warning.append(p,exportButton,reload); document.body.append(warning);
      throw error;
    } finally { saving = false; if (!blocked) busy(false); }
  }
  function renderCompanies() {
    const list = document.querySelector('#companiesList'); list.replaceChildren();
    for (const org of organizations) {
      const card = document.createElement('article'); card.className = 'company-card';
      const text = document.createElement('h2'); text.textContent = org.name;
      const button = document.createElement('button'); button.className = 'secondary-button';
      button.textContent = org.id === organization.id ? 'Activa · '+org.role : 'Seleccionar';
      button.disabled = org.id === organization.id;
      button.onclick = async () => {
        if (saving || blocked) return;
        busy(true);
        try {
          const state = await request(`/api/organizations/${org.id}/state`);
          organization = org; version = state.version; committed = structuredClone(state.data);
          window.dispatchEvent(new CustomEvent('rss:organization',{detail:structuredClone(state.data)}));
          document.querySelector('.company-switcher strong').textContent = org.name;
          const heading = document.querySelector('#activeCompanyName'); if (heading) heading.textContent = org.name;
          renderCompanies();
        } catch(error) { alert(error.message); } finally { busy(false); }
      };
      card.append(text,button); list.append(card);
    }
  }
  return {ready,save,html,renderCompanies,organization:()=>({...organization}),exportPropertyUrl:id=>`/api/organizations/${organization.id}/properties/${id}/export`};
})();

(async () => {
const initialState=await RSS.ready();
let content=initialState.content, properties=initialState.properties;
let selectedPropertyId=initialState.selectedPropertyId ?? null;
let activePropertyRef=null, brand=initialState.brand, draftLogo='', brandImage=null;
function selectedProperty(){return properties.find(p=>p.id===selectedPropertyId)}
function restoreSelection(){const p=selectedProperty();activePropertyRef=p?(propertyItems(p)[0]?.propertyRef||propertyKey(p)):null}
function selectProperty(p){selectedPropertyId=p.id;activePropertyRef=propertyItems(p)[0]?.propertyRef||propertyKey(p)}
const html=RSS.html;
let currentFilter='all'; let calendarDate=new Date(new Date().getFullYear(),new Date().getMonth(),1);
const labels={pending:'PENDIENTE',approved:'APROBADO',scheduled:'PROGRAMADO',published:'PUBLICADO'};
const save=()=>RSS.save({content,properties,workflowStep,selectedPropertyId,...(brand?{brand}:{})});
function channelClass(channel){return channel.includes('+')?'both':channel.toLowerCase()}
function platformName(channel){return channel.includes('+')?'Instagram + Facebook':channel}
function renderReviews(){
 const list=document.querySelector('#reviewList'); const pending=content.filter(x=>x.status==='pending').slice(0,3);
 list.innerHTML=pending.length?pending.map(x=>`<div class="review-item"><div class="review-thumb">${html(x.icon)}</div><div class="review-meta"><span class="platform-tag ${html(channelClass(x.channel))}">${html(platformName(x.channel))}</span><h3>${html(x.title)}</h3><small>${html(x.type)} · ${formatDate(x.date)}</small></div><div class="review-actions"><button title="Editar" data-edit="${x.id}">✎</button><button class="approve" title="Aprobar" data-approve="${x.id}">✓</button></div></div>`).join(''):'<p style="color:#718095;font-size:12px">No hay contenidos pendientes.</p>';
}
function renderContent(){
 const q=(document.querySelector('#searchInput')?.value||'').toLowerCase();
 const items=content.filter(x=>(currentFilter==='all'||x.status===currentFilter)&&x.title.toLowerCase().includes(q));
 document.querySelector('#contentGrid').innerHTML=items.map(x=>`<article class="content-card"><div class="content-image">${html(x.icon)}<span class="status-badge status-${x.status}">${labels[x.status]}</span></div><div class="content-body"><span class="platform-tag ${html(channelClass(x.channel))}">${html(platformName(x.channel))}</span><h3>${html(x.title)}</h3><p>${html(x.caption)}</p><div class="content-footer"><span>${html(x.type)} · ${formatDate(x.date)}</span><button data-edit="${x.id}">Editar texto</button>${x.status==='pending'?`<button data-approve="${x.id}">Aprobar ✓</button>`:`<button data-preview-content="${x.id}">Ver contenido →</button>`}</div></div></article>`).join('')||'<p>No se han encontrado contenidos.</p>';
}
function updateCounts(){const today=dateKey(new Date()),end=new Date();end.setDate(end.getDate()+13);['pending','approved','scheduled','published'].forEach(s=>{const el=document.querySelector(`#${s}Count`);if(el)el.textContent=content.filter(x=>x.status===s&&(s!=='scheduled'||(x.date>=today&&x.date<=dateKey(end)))).length})}
function formatDate(d){return new Intl.DateTimeFormat('es-ES',{day:'numeric',month:'short'}).format(new Date(d+'T12:00:00'))}
function dateKey(date){return [date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('-')}
function renderWeek(){
 const today=new Date(),start=new Date(today.getFullYear(),today.getMonth(),today.getDate());start.setDate(start.getDate()-(start.getDay()+6)%7);
 const end=new Date(start);end.setDate(end.getDate()+6);
 document.querySelector('#weekRange').textContent=formatDate(dateKey(start))+' – '+formatDate(dateKey(end));
 document.querySelector('#weekDays').innerHTML=['L','M','X','J','V','S','D'].map((label,i)=>{const d=new Date(start);d.setDate(d.getDate()+i);const key=dateKey(d);return `<div class="day ${key===dateKey(today)?'today':''}"><span>${label}</span><strong>${d.getDate()}</strong>${content.some(x=>x.date===key)?'<i></i>':''}</div>`}).join('');
 const next=content.filter(x=>x.status==='scheduled'&&x.date>=dateKey(today)).sort((a,b)=>a.date.localeCompare(b.date))[0];
 document.querySelector('#nextPost').innerHTML=next?`<div class="next-post"><div><span class="platform-tag">${html(next.channel)}</span><strong>${html(next.title)}</strong><small>${formatDate(next.date)} · Planificación interna</small></div></div>`:'<p>No hay publicaciones programadas.</p>';
}

function renderCalendar(){
 const y=calendarDate.getFullYear(),m=calendarDate.getMonth();document.querySelector('#monthTitle').textContent=new Intl.DateTimeFormat('es-ES',{month:'long',year:'numeric'}).format(calendarDate);
 let first=(new Date(y,m,1).getDay()+6)%7,days=new Date(y,m+1,0).getDate(),prevDays=new Date(y,m,0).getDate(),cells=[];
 for(let i=0;i<42;i++){let num,muted=false,date;if(i<first){num=prevDays-first+i+1;muted=true;date=new Date(y,m-1,num)}else if(i>=first+days){num=i-first-days+1;muted=true;date=new Date(y,m+1,num)}else{num=i-first+1;date=new Date(y,m,num)}const iso=[date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('-');const events=content.filter(x=>x.date===iso);cells.push(`<div class="calendar-day ${muted?'muted':''}">${num}${events.map(e=>`<button type="button" class="calendar-event" data-edit="${e.id}" title="${html(labels[e.status])}">${html(e.title)}</button>`).join('')}</div>`)}document.querySelector('#calendarGrid').innerHTML=cells.join('');
}
async function approve(id){const item=content.find(x=>x.id===Number(id));if(item){if(!item.caption.trim()){showToast('Completa el texto antes de aprobar.');return}item.status='approved';await save();renderAll();showToast(`“${item.title}” ha sido aprobado`)}}
function applyPermissions(){const readOnly=RSS.organization().role==='viewer';document.querySelectorAll('[data-approve],[data-open-composer],[data-edit-property],[data-generate-pack],#importListing,[data-action=go-import],#approvePropertyPack,#finishWorkflow,#workflowNext').forEach(el=>{el.disabled=readOnly;if(readOnly)el.title='Permiso de solo lectura'});document.querySelectorAll('#composerForm input,#composerForm select,#composerForm textarea,#composerSubmit').forEach(el=>el.disabled=readOnly)}
function renderAll(){renderReviews();renderContent();updateCounts();renderCalendar();renderWeek();applyPermissions()}
function showToast(msg){const t=document.querySelector('#toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2600)}
function showView(id){document.querySelectorAll('.view').forEach(v=>v.classList.toggle('active',v.id===id));document.querySelectorAll('.nav-item[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===id));document.querySelector('.sidebar').classList.remove('open');if(id==='content')renderContent();if(id==='calendar')renderCalendar()}
function editContent(id){const item=content.find(x=>x.id===Number(id));if(!item)return;const form=document.querySelector('#composerForm');form.elements.title.value=item.title;form.elements.type.value=item.type;form.elements.channel.value=item.channel;form.elements.date.value=item.date;form.elements.details.value=item.caption;form.dataset.editId=item.id;document.querySelector('.composer h2').textContent='Editar contenido';document.querySelector('#composerSubmit').textContent='Guardar cambios · vuelve a revisión';document.querySelector('#composerModal').classList.add('open')}
function renderCompanies(){RSS.renderCompanies()}
let workflowStep=initialState.workflowStep;
const workflowLabels=['','Pega el enlace del anuncio','Revisa los datos del inmueble','Prepara las fotografías','Revisa y aprueba los contenidos','Confirma las fechas del calendario','Planificación terminada'];
const workflowButtons=['','Empezar con URL →','Continuar con fotografías →','Crear contenidos →','Revisar contenidos →','Ver calendario →','Empezar otra vivienda →'];
async function setWorkflowStep(step){workflowStep=step;await save();updateWorkflow()}
function updateWorkflow(){document.querySelector('#workflowLabel').textContent=workflowLabels[workflowStep];document.querySelector('#workflowNext').textContent=workflowButtons[workflowStep];document.querySelectorAll('[data-flow-view]').forEach((b,i)=>{b.classList.toggle('done',i+1<workflowStep);b.classList.toggle('active',i+1===Math.min(workflowStep,5))});document.querySelector('#contentFlowHelp').style.display=workflowStep===4?'flex':'none';document.querySelector('#calendarFlowHelp').style.display=workflowStep===5?'flex':'none'}
function getProperties(){return properties}
function propertyKey(p){return 'inmueble:'+p.id}
function propertyItems(p){return content.filter(x=>x.propertyRef===propertyKey(p)||x.propertyRef===p.reference)}
function renderProperties(){document.querySelector('#propertiesList').innerHTML=properties.map(p=>`<article class="property-card"><div class="property-main"><div class="property-photo">⌂<small>FOTOS EN EL EDITOR LOCAL</small></div><div class="property-data"><span class="property-status">FICHA MANUAL</span><h3>${html(p.title)}</h3><p>${html(p.location)} · REF. ${html(p.reference)}</p><strong class="property-price">${html(p.price)}</strong><div class="feature-row">${[['Construida',p.built],['Dormitorios',p.beds],['Baños',p.baths],['Planta',p.floor]].filter(x=>x[1]).map(x=>`<span>${x[0]}: ${html(x[1])}</span>`).join('')}</div></div><div class="property-actions"><button class="secondary-button" data-edit-property="${p.id}">Editar ficha</button><button class="primary-button" data-generate-pack="${p.id}">${propertyItems(p).length?'Revisar paquete':'Crear 4 borradores'}</button><button class="secondary-button" data-export-pack="${p.id}">Descargar textos</button><button class="secondary-button" data-load-property="${p.id}">Preparar fotografías</button></div></div><div class="property-pack"><p>Publicación · Carrusel · Historias · Guion de reel. Las fotos se preparan y descargan en este navegador; todavía no se guardan en el servidor.</p></div></article>`).join('')||'<p>Aún no hay inmuebles. Añade una ficha con sus datos verificados.</p>';applyPermissions()}
function openProperty(id){const form=document.querySelector('#propertyForm');form.reset();delete form.dataset.editId;document.querySelector('#propertyFormError').textContent='';const p=properties.find(x=>x.id===Number(id));if(p){for(const [key,value] of Object.entries(p))if(form.elements.namedItem(key))form.elements.namedItem(key).value=value;form.dataset.editId=p.id}else form.elements.url.value=document.querySelector('#listingUrl').value.trim();document.querySelector('#propertyModalTitle').textContent=p?'Editar inmueble':'Añadir inmueble';document.querySelector('#propertyModal').classList.add('open')}
async function importListing(){openProperty()}
function propertyFacts(p){return [['Ubicación',p.location],['Referencia',p.reference],['Precio',p.price],['Superficie construida (m²)',p.built],['Superficie útil (m²)',p.useful],['Dormitorios',p.beds],['Baños',p.baths],['Planta',p.floor],['Características',p.extras]].filter(x=>x[1]).map(x=>x[0]+': '+x[1]).join('\n')}
function propertyCaption(p,type){const facts=propertyFacts(p),link=p.url?'\nAnuncio: '+p.url:'';if(type==='Carrusel')return `Portada: ${p.title}\nFicha para las diapositivas (acompaña cada dato con una foto adecuada):\n${facts}\nCierre: solicita información sobre esta vivienda.${link}`;if(type==='Historia')return `${p.title}\n${facts}\nConsulta disponibilidad y solicita información.${link}`;if(type==='Reel')return `Guion de reel: ${p.title}\nInicio: presenta la vivienda con una fotografía o vídeo real.\nRecorrido: muestra únicamente las características confirmadas:\n${facts}\nCierre: solicita información sobre esta vivienda.${link}`;return `${p.title}\n${facts}\n¿Quieres conocer esta vivienda? Solicita información.${link}`}
async function generatePropertyPack(id){const property=properties.find(p=>p.id===Number(id))||properties.find(p=>propertyKey(p)===activePropertyRef||propertyItems(p).some(x=>x.propertyRef===activePropertyRef))||properties[0];if(!property){showToast('Añade primero un inmueble');return}const existing=propertyItems(property);selectProperty(property);if(existing.length){workflowStep=4;await save();updateWorkflow();showView('content');showToast('Paquete existente. Edita los textos antes de aprobarlos.');return}const now=Date.now(),date=dateKey(new Date());['Publicación','Carrusel','Historia','Reel'].forEach((type,i)=>content.unshift({id:now+i,title:property.title+' · '+type,type,channel:'Instagram + Facebook',status:'pending',propertyRef:activePropertyRef,date,caption:propertyCaption(property,type),icon:type==='Reel'?'▶':'⌂'}));await setWorkflowStep(4);renderAll();renderProperties();showView('content');showToast('4 borradores preparados con los datos de la ficha. Revisa cada texto.')}
function exportPropertyPack(id){const p=properties.find(x=>x.id===Number(id));if(!p)return;if(!propertyItems(p).length){showToast('Crea primero los borradores');return}const a=document.createElement('a');a.href=RSS.exportPropertyUrl(p.id);a.download='inmueble-'+p.id+'-textos.txt';document.body.append(a);a.click();a.remove()}

document.querySelector('#propertyForm').addEventListener('submit',async e=>{e.preventDefault();const form=e.target;try{const fields=new FormData(form),id=Number(form.dataset.editId)||Date.now(),current=properties.find(p=>p.id===id),p={id,photos:current?.photos||0};for(const key of ['title','reference','url','location','price','built','useful','beds','baths','floor','extras'])p[key]=String(fields.get(key)||'').trim();if(properties.some(x=>x.id!==id&&x.reference===p.reference))throw new Error('La referencia ya existe en esta empresa.');if(current&&current.reference!==p.reference&&content.some(x=>x.propertyRef===current.reference))throw new Error('Este paquete antiguo utiliza la referencia. Conserva la referencia para mantener su vínculo.');if(p.url&&!['http:','https:'].includes(new URL(p.url).protocol))throw new Error('Usa un enlace http o https.');if(current)Object.assign(current,p);else properties.unshift(p);selectProperty(p);workflowStep=2;await save();updateWorkflow();renderProperties();document.querySelector('#propertyModal').classList.remove('open');showView('assets');showToast('Ficha guardada. Los borradores existentes conservan su texto para revisión.')}catch(error){document.querySelector('#propertyFormError').textContent=error.message}});

document.addEventListener('click',async e=>{
 try {
 if(e.target.closest('[data-close-property]'))document.querySelector('#propertyModal').classList.remove('open');
 if(e.target.closest('[data-edit-property]'))openProperty(e.target.closest('[data-edit-property]').dataset.editProperty);
 if(e.target.closest('[data-export-pack]'))exportPropertyPack(e.target.closest('[data-export-pack]').dataset.exportPack);
 const nav=e.target.closest('[data-view]');if(nav)showView(nav.dataset.view);
 if(e.target.closest('[data-open-composer]')){const form=document.querySelector('#composerForm');form.reset();delete form.dataset.editId;form.elements.date.value=dateKey(new Date());document.querySelector('.composer h2').textContent='Crear publicación';document.querySelector('#composerSubmit').textContent='Crear borrador';document.querySelector('#composerModal').classList.add('open')}
 if(e.target.closest('.modal-close')||e.target.id==='composerModal'){document.querySelector('#composerModal').classList.remove('open');delete document.querySelector('#composerForm').dataset.editId;document.querySelector('.composer h2').textContent='Crear publicación'}
 const approveBtn=e.target.closest('[data-approve]');if(approveBtn)await approve(approveBtn.dataset.approve);
 if(e.target.closest('[data-go-content]'))showView('content');
 const filter=e.target.closest('[data-filter]');if(filter){currentFilter=filter.dataset.filter;document.querySelectorAll('[data-filter]').forEach(b=>b.classList.toggle('active',b===filter));renderContent()}
 if(e.target.closest('.mobile-menu'))document.querySelector('.sidebar').classList.toggle('open');
 if(e.target.closest('[data-open-ideas]'))showToast('Generación con IA pendiente de conectar. Puedes crear un borrador manual.');
 const edit=e.target.closest('[data-edit]');if(edit)editContent(edit.dataset.edit);
 const preview=e.target.closest('[data-preview-content]');if(preview){const item=content.find(x=>x.id===Number(preview.dataset.previewContent));editContent(item.id)}
 const action=e.target.closest('[data-action]')?.dataset.action;
 if(action==='search'){showView('content');setTimeout(()=>document.querySelector('#searchInput').focus(),0)}
 if(action==='notifications')showToast(`${content.filter(x=>x.status==='pending').length} contenidos esperan tu revisión`);
 if(action==='profile')showToast('Cuenta de usuario autenticada');
 if(action==='week-calendar')showView('calendar');
 if(action==='settings')showToast('Guardado en servidor activo. IA, importación automática y publicación en redes pendientes de conectar.');
 if(action==='add-company')showToast('Solicita al administrador el alta de la empresa y sus usuarios');
 if(action==='manage-brand')openBrand();
 if(action==='go-import')openProperty();
 if(e.target.closest('#importListing'))await importListing();
 if(e.target.closest('[data-generate-pack]'))await generatePropertyPack(e.target.closest('[data-generate-pack]').dataset.generatePack);
 if(e.target.closest('[data-load-property]')){const p=properties.find(x=>x.id===Number(e.target.closest('[data-load-property]').dataset.loadProperty));selectProperty(p);document.querySelector('#photoReference').value=p.reference;await setWorkflowStep(3);showView('assets');document.querySelector('#photoInput').click()}
 const flowView=e.target.closest('[data-flow-view]');if(flowView)showView(flowView.dataset.flowView);
 if(e.target.closest('#workflowNext')){if(workflowStep===1){showView('dashboard');document.querySelector('#listingUrl').focus()}else if(workflowStep===2){const p=selectedProperty();if(!p){showToast('Selecciona un inmueble desde su ficha.');return}document.querySelector('#photoReference').value=p.reference;await setWorkflowStep(3);showView('assets');document.querySelector('#photoInput').click()}else if(workflowStep===3){await generatePropertyPack()}else if(workflowStep===4)showView('content');else if(workflowStep===5)showView('calendar');else{selectedPropertyId=null;activePropertyRef=null;await setWorkflowStep(1);showView('dashboard')}}
 if(e.target.closest('#approvePropertyPack')){if(!activePropertyRef){showToast('Selecciona el paquete desde Inmuebles antes de aprobarlo.');return}const pack=content.filter(x=>x.propertyRef===activePropertyRef);if(!pack.length||pack.some(x=>!x.caption.trim())){showToast('Completa los textos del paquete antes de aprobar.');return}pack.forEach(x=>x.status='approved');await setWorkflowStep(5);renderAll();showView('calendar');showToast('Paquete aprobado. Revisa ahora las fechas')}
 if(e.target.closest('#finishWorkflow')){if(!activePropertyRef){showToast('Selecciona el paquete desde Inmuebles.');return}if(content.some(x=>x.propertyRef===activePropertyRef&&x.status==='pending')){showToast('Aprueba todos los borradores del paquete antes de programar.');return}const pack=content.filter(x=>x.propertyRef===activePropertyRef);if(!pack.length||pack.some(x=>x.date<dateKey(new Date()))){showToast('Revisa las fechas: el paquete no puede programarse en el pasado.');return}pack.forEach(x=>x.status='scheduled');await setWorkflowStep(6);renderAll();showToast('Planificación guardada. No se ha publicado en redes sociales.')}
} catch(error){showToast(error.message)}
});
document.querySelector('#searchInput').addEventListener('input',renderContent);
document.querySelector('#prevMonth').onclick=()=>{calendarDate=new Date(calendarDate.getFullYear(),calendarDate.getMonth()-1,1);renderCalendar()};
document.querySelector('#nextMonth').onclick=()=>{calendarDate=new Date(calendarDate.getFullYear(),calendarDate.getMonth()+1,1);renderCalendar()};
document.querySelector('#composerForm').addEventListener('submit',async e=>{e.preventDefault();try{const f=new FormData(e.target),title=f.get('title'),editId=Number(e.target.dataset.editId);if(editId){const item=content.find(x=>x.id===editId);Object.assign(item,{title,type:f.get('type'),channel:f.get('channel'),date:f.get('date'),caption:String(f.get('details')||'').trim(),status:'pending'});delete e.target.dataset.editId}else content.unshift({id:Date.now(),title,type:f.get('type'),channel:f.get('channel'),status:'pending',date:f.get('date'),caption:String(f.get('details')||'').trim()||`Objetivo: ${f.get('goal')}. Completa el texto antes de aprobarlo.`,icon:f.get('type')==='Reel'?'▶':f.get('type')==='Historia'?'◉':f.get('type')==='Carrusel'?'≡':'⌂'});await save();renderAll();e.target.reset();document.querySelector('.composer h2').textContent='Crear publicación';document.querySelector('#composerModal').classList.remove('open');showView('content');showToast(editId?`“${title}” actualizado`:`Borrador “${title}” creado para revisión`)}catch(error){showToast(error.message)}});
window.addEventListener('rss:organization',event=>{content=event.detail.content;properties=event.detail.properties;workflowStep=event.detail.workflowStep;selectedPropertyId=event.detail.selectedPropertyId??null;brand=event.detail.brand;restoreSelection();document.querySelector('#brandModal').classList.remove('open');renderBrand();photoState.images.forEach(img=>URL.revokeObjectURL(img.src));photoState.generation++;photoState.images=[];photoState.adjustments=[];photoState.active=0;renderGallery();syncAdjustUI();photoCanvas.style.display='none';document.querySelector('#canvasEmpty').style.display='grid';document.querySelector('#downloadPhoto').disabled=true;document.querySelector('#photoInput').value='';document.querySelector('#propertyForm').reset();delete document.querySelector('#propertyForm').dataset.editId;document.querySelector('#propertyModal').classList.remove('open');document.querySelector('#composerForm').reset();delete document.querySelector('#composerForm').dataset.editId;document.querySelector('#composerModal').classList.remove('open');renderAll();renderProperties();updateWorkflow();showView('dashboard')});

function legacyLogo(){return !brand && RSS.organization().name==='Ruano Inmobiliaria'?document.querySelector('#officialLogo').src:''}
function renderBrand(){
 const name=brand?.name||RSS.organization().name,logo=brand?.logo??legacyLogo();
 document.querySelector('#sidebarBrandName').textContent=name;
 document.querySelector('#footerText').value=[brand?.website,brand?.phone].filter(Boolean).join(' · ');
 document.querySelector('#photoReference').value=selectedProperty()?.reference||'';
 document.documentElement.style.setProperty('--navy',brand?.color||'#0b315f');
 brandImage=null;
 for(const selector of ['.brand-mark','.mini-logo']){const el=document.querySelector(selector);el.replaceChildren();if(logo){const img=document.createElement('img');img.src=logo;img.alt=name;img.style.cssText='width:100%;height:100%;object-fit:contain;border-radius:50%';el.append(img)}else el.textContent=name.slice(0,1).toUpperCase()}
 if(logo){const img=new Image();brandImage=img;img.onload=()=>{if(brandImage===img)drawPhoto()};img.src=logo}
}
function previewBrandLogo(){const img=document.querySelector('#brandLogoPreview');img.hidden=!draftLogo;if(draftLogo)img.src=draftLogo;else img.removeAttribute('src')}
function openBrand(){const form=document.querySelector('#brandForm');form.reset();for(const key of ['name','tagline','phone','website','color'])form.elements.namedItem(key).value=brand?.[key]||(key==='color'?'#0b315f':'');draftLogo=brand?.logo??legacyLogo();previewBrandLogo();const readOnly=RSS.organization().role!=='owner';form.querySelectorAll('input,button[type=submit],#removeBrandLogo').forEach(el=>el.disabled=readOnly);document.querySelector('#brandError').textContent=readOnly?'Solo el propietario puede cambiar la marca.':'';document.querySelector('#brandModal').classList.add('open')}
 document.querySelectorAll('[data-close-brand]').forEach(b=>b.onclick=()=>document.querySelector('#brandModal').classList.remove('open'));
 document.querySelector('#removeBrandLogo').onclick=()=>{draftLogo='';document.querySelector('#brandLogoInput').value='';previewBrandLogo()};
 document.querySelector('#brandLogoInput').onchange=async e=>{const file=e.target.files[0];if(!file)return;const error=document.querySelector('#brandError');if(!['image/png','image/jpeg'].includes(file.type)||file.size>300000){error.textContent='Usa PNG o JPEG de hasta 300 KB.';e.target.value='';return}const orgId=RSS.organization().id;try{const value=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('No se pudo leer el logotipo'));reader.readAsDataURL(file)});if(orgId!==RSS.organization().id)return;draftLogo=value;previewBrandLogo();error.textContent=''}catch(e){error.textContent=e.message}};
 document.querySelector('#brandForm').onsubmit=async e=>{e.preventDefault();if(RSS.organization().role!=='owner')return;const f=new FormData(e.target);brand=Object.fromEntries(['name','tagline','phone','website','color'].map(key=>[key,String(f.get(key)||'').trim()]));brand.logo=draftLogo;try{await save();renderBrand();drawPhoto();document.querySelector('#brandModal').classList.remove('open');showToast('Marca guardada para esta empresa')}catch(error){document.querySelector('#brandError').textContent=error.message}};
 document.addEventListener('keydown',e=>{if(e.key==='Escape')document.querySelectorAll('.modal-backdrop.open').forEach(modal=>modal.classList.remove('open'))});

restoreSelection();renderBrand();renderWeek();renderAll();renderCompanies();renderProperties();updateWorkflow();

// Editor de encabezado y pie corporativo
const photoCanvas=document.querySelector('#photoCanvas'),photoCtx=photoCanvas.getContext('2d');
const photoState={images:[],adjustments:[],active:0,generation:0};
const sizes={'4:5':[1080,1350],'1:1':[1080,1080],'9:16':[1080,1920]};
function defaultAdjust(){return{levels:false,brightness:0,contrast:0,saturation:0,rotate:0}}
function formatDeg(v){return Number(v).toFixed(1).replace(/\.0$/,'')+'°'}
function currentAdjust(){if(!photoState.images.length)return null;if(!photoState.adjustments[photoState.active])photoState.adjustments[photoState.active]=defaultAdjust();return photoState.adjustments[photoState.active]}
function syncAdjustUI(){
 const a=photoState.adjustments[photoState.active]||defaultAdjust();
 document.querySelector('#autoLevels').checked=a.levels;
 document.querySelector('#brightness').value=a.brightness;document.querySelector('#brightnessVal').textContent=a.brightness;
 document.querySelector('#contrast').value=a.contrast;document.querySelector('#contrastVal').textContent=a.contrast;
 document.querySelector('#saturation').value=a.saturation;document.querySelector('#saturationVal').textContent=a.saturation;
 document.querySelector('#rotate').value=a.rotate;document.querySelector('#rotateVal').textContent=formatDeg(a.rotate);
}
function coverImage(ctx,img,x,y,w,h){const scale=Math.max(w/img.width,h/img.height),sw=w/scale,sh=h/scale,sx=(img.width-sw)/2,sy=(img.height-sh)/2;ctx.drawImage(img,sx,sy,sw,sh,x,y,w,h)}
// Auto niveles: estiramiento de histograma por canal (recorta 0.5% en cada extremo), calculado una vez y cacheado por foto
function getLeveledSource(img){
 if(img.__leveled)return img.__leveled;
 const w=img.naturalWidth||img.width,h=img.naturalHeight||img.height;
 const off=document.createElement('canvas');off.width=w;off.height=h;
 const octx=off.getContext('2d');octx.drawImage(img,0,0,w,h);
 const data=octx.getImageData(0,0,w,h),px=data.data;
 const hist=[new Uint32Array(256),new Uint32Array(256),new Uint32Array(256)];
 for(let i=0;i<px.length;i+=4){hist[0][px[i]]++;hist[1][px[i+1]]++;hist[2][px[i+2]]++}
 const clip=w*h*.005;
 const bounds=hist.map(hc=>{let lo=0,acc=0;while(lo<255&&acc<clip){acc+=hc[lo];lo++}let hi=255;acc=0;while(hi>0&&acc<clip){acc+=hc[hi];hi--}if(hi<=lo){lo=0;hi=255}return[lo,hi]});
 for(let i=0;i<px.length;i+=4){for(let c=0;c<3;c++){const[lo,hi]=bounds[c];let v=(px[i+c]-lo)*255/(hi-lo);px[i+c]=v<0?0:v>255?255:v}}
 octx.putImageData(data,0,0);
 img.__leveled=off;
 return off;
}
function renderGallery(){
 const gallery=document.querySelector('#photoGallery');
 gallery.innerHTML=photoState.images.map((img,i)=>`<div class="photo-thumb${i===photoState.active?' active':''}" data-select="${i}" role="button" tabindex="0" title="Editar esta foto"><img src="${img.src}"><button type="button" class="thumb-remove" data-remove="${i}" title="Quitar">×</button></div>`).join('');
 gallery.hidden=photoState.images.length===0;
 document.querySelector('#downloadAllCount').textContent=photoState.images.length;
 document.querySelector('#downloadAllPhotos').disabled=photoState.images.length===0;
}
function paintCanvas(img,adjust){
 adjust=adjust||defaultAdjust();
 const [w,h]=sizes[document.querySelector('#photoFormat').value];photoCanvas.width=w;photoCanvas.height=h;photoCtx.clearRect(0,0,w,h);
 const hasHeader=document.querySelector('#headerToggle').checked,hasFooter=document.querySelector('#footerToggle').checked;const headerH=hasHeader?Math.round(h*.115):0,footerH=hasFooter?Math.round(h*.09):0;
 const source=adjust.levels?getLeveledSource(img):img,photoH=h-headerH-footerH;
 photoCtx.save();
 photoCtx.beginPath();photoCtx.rect(0,headerH,w,photoH);photoCtx.clip();
 photoCtx.filter=`brightness(${1+adjust.brightness/100}) contrast(${1+adjust.contrast/100}) saturate(${1+adjust.saturation/100})`;
 if(adjust.rotate){
  const cx=w/2,cy=headerH+photoH/2,k=1.5;
  photoCtx.translate(cx,cy);photoCtx.rotate(adjust.rotate*Math.PI/180);photoCtx.translate(-cx,-cy);
  coverImage(photoCtx,source,cx-(w*k)/2,cy-(photoH*k)/2,w*k,photoH*k);
 }else{
  coverImage(photoCtx,source,0,headerH,w,photoH);
 }
 photoCtx.restore();
 if(hasHeader){photoCtx.fillStyle='#fff';photoCtx.fillRect(0,0,w,headerH);if(brandImage?.complete&&brandImage.naturalWidth){const lh=headerH*.76,lw=Math.min(w*.25,lh*brandImage.naturalWidth/brandImage.naturalHeight);photoCtx.drawImage(brandImage,46,(headerH-lh)/2,lw,lh)}photoCtx.fillStyle=brand?.color||'#0b315f';photoCtx.textAlign='right';photoCtx.font=`600 ${Math.round(headerH*.17)}px Arial`;photoCtx.fillText(brand?.name||RSS.organization().name,w-48,headerH*.47,w*.6);photoCtx.font=`400 ${Math.round(headerH*.12)}px Arial`;photoCtx.fillStyle='#64758a';photoCtx.fillText(brand?.tagline||'',w-48,headerH*.68,w*.6)}
 if(hasFooter){const y=h-footerH;photoCtx.fillStyle=brand?.color||'#0b315f';photoCtx.fillRect(0,y,w,footerH);photoCtx.fillStyle='#fff';photoCtx.textAlign='left';photoCtx.font=`600 ${Math.round(footerH*.18)}px Arial`;photoCtx.fillText(document.querySelector('#footerText').value,45,y+footerH*.58,w*.7);const ref=document.querySelector('#photoReference').value.trim();if(ref){photoCtx.textAlign='right';photoCtx.fillText(ref.toUpperCase(),w-45,y+footerH*.58,w*.2)}}
 return {w,h};
}
function drawPhoto(){
 const img=photoState.images[photoState.active];
 if(!img)return;
 const {w,h}=paintCanvas(img,photoState.adjustments[photoState.active]);
 photoCanvas.style.display='block';document.querySelector('#canvasEmpty').style.display='none';document.querySelector('#downloadPhoto').disabled=false;document.querySelector('#previewSize').textContent=`${w} × ${h} px`;
}
document.querySelector('#photoInput').addEventListener('change',async e=>{
 const files=Array.from(e.target.files);if(!files.length)return;
 const generation=photoState.generation,startIndex=photoState.images.length;let loaded=0;
 files.forEach((file,i)=>{
  photoState.adjustments[startIndex+i]=defaultAdjust();
  const img=new Image();img.onload=()=>{if(generation!==photoState.generation){URL.revokeObjectURL(img.src);return}photoState.images[startIndex+i]=img;loaded++;if(loaded===files.length){photoState.active=photoState.images.length-1;renderGallery();syncAdjustUI();drawPhoto()}};img.src=URL.createObjectURL(file);
 });
 try{await setWorkflowStep(3)}catch(error){showToast(error.message);return}showToast(files.length>1?`${files.length} fotografías cargadas. Continúa para crear contenidos`:'Fotografía cargada. Continúa para crear contenidos');
 e.target.value='';
});
document.querySelector('#photoGallery').addEventListener('click',e=>{
 const remove=e.target.closest('[data-remove]');
 if(remove){const i=Number(remove.dataset.remove);URL.revokeObjectURL(photoState.images[i].src);photoState.images.splice(i,1);photoState.adjustments.splice(i,1);if(photoState.active>=photoState.images.length)photoState.active=Math.max(0,photoState.images.length-1);renderGallery();syncAdjustUI();if(photoState.images.length)drawPhoto();else{photoCanvas.style.display='none';document.querySelector('#canvasEmpty').style.display='grid';document.querySelector('#downloadPhoto').disabled=true}return}
 const select=e.target.closest('[data-select]');
 if(select){photoState.active=Number(select.dataset.select);renderGallery();syncAdjustUI();drawPhoto()}
});
['photoFormat','headerToggle','footerToggle','photoReference','footerText'].forEach(id=>document.querySelector('#'+id).addEventListener('input',drawPhoto));
document.querySelector('#autoLevels').addEventListener('change',e=>{const a=currentAdjust();if(!a)return;a.levels=e.target.checked;drawPhoto()});
['brightness','contrast','saturation'].forEach(id=>document.querySelector('#'+id).addEventListener('input',e=>{const a=currentAdjust();if(!a)return;a[id]=Number(e.target.value);document.querySelector('#'+id+'Val').textContent=e.target.value;drawPhoto()}));
document.querySelector('#rotate').addEventListener('input',e=>{const a=currentAdjust();if(!a)return;a.rotate=Number(e.target.value);document.querySelector('#rotateVal').textContent=formatDeg(e.target.value);drawPhoto()});
document.querySelector('#resetAdjustments').addEventListener('click',()=>{if(!photoState.images.length)return;photoState.adjustments[photoState.active]=defaultAdjust();syncAdjustUI();drawPhoto()});
document.querySelector('#resetPhoto').addEventListener('click',()=>{photoState.images.forEach(img=>URL.revokeObjectURL(img.src));photoState.images=[];photoState.adjustments=[];photoState.active=0;renderGallery();syncAdjustUI();document.querySelector('#photoInput').value='';photoCanvas.style.display='none';document.querySelector('#canvasEmpty').style.display='grid';document.querySelector('#downloadPhoto').disabled=true});
document.querySelector('#downloadPhoto').addEventListener('click',()=>{if(!photoState.images[photoState.active])return;drawPhoto();const a=document.createElement('a');a.download=`ruano-${document.querySelector('#photoReference').value.trim().toLowerCase().replace(/\s+/g,'-')||'publicacion'}.png`;a.href=photoCanvas.toDataURL('image/png');a.click();showToast('Imagen preparada en PNG')});
document.querySelector('#downloadAllPhotos').addEventListener('click',async()=>{
 if(!photoState.images.length)return;
 const btn=document.querySelector('#downloadAllPhotos'),original=btn.textContent;btn.disabled=true;
 const ref=document.querySelector('#photoReference').value.trim().toLowerCase().replace(/\s+/g,'-')||'publicacion',multiple=photoState.images.length>1;
 for(let i=0;i<photoState.images.length;i++){
  btn.textContent=`Descargando ${i+1}/${photoState.images.length}…`;
  paintCanvas(photoState.images[i],photoState.adjustments[i]);
  const a=document.createElement('a');
  a.download=multiple?`ruano-${ref}-${i+1}.png`:`ruano-${ref}.png`;
  a.href=photoCanvas.toDataURL('image/png');
  a.click();
  await new Promise(r=>setTimeout(r,350));
 }
 drawPhoto();btn.textContent=original;btn.disabled=false;
 showToast(`${photoState.images.length} imágenes descargadas. Si el navegador pidió permiso para descargas múltiples, acéptalo la próxima vez.`);
});
})().catch(error=>console.error(error.message));

