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
  return {ready,save,html,renderCompanies};
})();
