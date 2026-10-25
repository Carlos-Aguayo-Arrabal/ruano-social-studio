// Browser-only queue. Render untrusted labels/messages as text, never HTML.
(() => {
 class UploadQueue {
  constructor({container=document.body,concurrency=2,maxTasks=20,maxBytes=256*1024*1024,getUserId=()=>undefined}={}) {
   this.getUserId=getUserId;this.tasks=[];this.active=0;this.concurrency=concurrency;this.maxTasks=maxTasks;this.maxBytes=maxBytes;
   this.panel=document.createElement('section');this.panel.id='uploadPanel';this.panel.setAttribute('aria-label','Subidas');this.panel.style.cssText='position:fixed;right:12px;bottom:16px;z-index:1000;background:white;border:1px solid #aab;padding:12px;border-radius:10px;width:min(360px,94vw);max-height:45vh;overflow:auto;box-shadow:0 4px 24px #0003;font-size:13px';container.append(this.panel);this.render();
  }
  enqueue({url,blob,method='PUT',label='Archivo',key=crypto.randomUUID().replaceAll('-',''),onSuccess=()=>{}}) {
   if(this.tasks.filter(t=>t.blob).length>=this.maxTasks || this.tasks.reduce((n,t)=>n+(t.blob?.size||0),0)+blob.size>this.maxBytes)throw Error('La cola está llena. Descarta o termina las subidas pendientes antes de añadir más.');
   const task={url,blob,method,label,key,userId:this.getUserId(),onSuccess,state:'queued',percent:0,queue:this};
   this.tasks.push(task);this.deferred(task);this.pump();return task;
  }
  deferred(t){t.promise=new Promise((resolve,reject)=>{t.resolve=resolve;t.reject=reject;});t.promise.catch(()=>{});}
  retry(t){if(!t.blob || !['busy','error','cancelled'].includes(t.state) || Date.now()<(t.retryAt||0))return;t.state='queued';t.percent=0;this.deferred(t);this.pump();}
  cancel(t){if(t.state==='uploading'){t.xhr.abort();return;}if(t.state==='queued'){t.state='cancelled';t.message='Cancelada. Puedes reintentar la misma subida.';t.reject(Error('Subida cancelada'));this.render();}}
  discard(t){if(['uploading','queued'].includes(t.state))this.cancel(t);t.blob=null;this.tasks=this.tasks.filter(x=>x!==t);this.render();}
  pump(){for(const t of this.tasks){if(this.active>=this.concurrency)break;if(t.state==='queued')this.start(t);}this.render();}
  start(t){
   this.active++;t.state='uploading';t.message='Subiendo';const xhr=t.xhr=new XMLHttpRequest();let finished=false;
   const finish=(state,message,data)=>{
    if(finished)return;finished=true;this.active--;t.state=state;t.message=message;t.xhr=null;
    if(state==='done'){t.percent=100;t.blob=null;try{t.onSuccess(data);}catch{t.message='Guardada; vuelve a abrir la ficha para actualizarla';}t.resolve(data);}
    else t.reject(Object.assign(Error(message),{status:xhr.status,cancelled:state==='cancelled'}));
    // Keep a bounded history; failed/cancelled files remain for explicit retry.
    while(this.tasks.filter(x=>x.state==='done').length>5){const old=this.tasks.find(x=>x.state==='done');this.tasks.splice(this.tasks.indexOf(old),1);}
    this.pump();
   };
   xhr.open(t.method,t.url);xhr.timeout=300000;xhr.setRequestHeader('Idempotency-Key',t.key);if(t.userId)xhr.setRequestHeader('X-Upload-User',t.userId);xhr.setRequestHeader('Content-Type',t.blob.type||'application/octet-stream');
   xhr.upload.onprogress=e=>{t.percent=e.lengthComputable?Math.floor(100*e.loaded/e.total):null;this.render();};
   xhr.onload=()=>{
    let data;try{data=JSON.parse(xhr.responseText);}catch{data={};}
    if(xhr.status>=200&&xhr.status<300)return finish('done','Guardada',data);
    if(xhr.status===429){t.retryAt=Date.now()+Math.min(60,Math.max(1,Number(xhr.getResponseHeader('Retry-After'))||2))*1000;setTimeout(()=>this.render(),Math.max(0,t.retryAt-Date.now()));return finish('busy','Servidor ocupado. Espera y pulsa Reintentar; no se duplicará el archivo.');}
    const messages={401:'Sesión caducada. Inicia sesión y vuelve a intentarlo.',403:'No tienes permiso para guardar en esta empresa.',409:'El archivo no coincide con la subida anterior. Comprueba la ficha.',413:'El archivo supera el tamaño permitido.'};
    finish('error',data.code==='UPLOAD_IDENTITY_CHANGED'?'La cuenta ha cambiado. Recarga la página y comprueba la ficha antes de volver a subir.':messages[xhr.status]||'No se pudo guardar. Puedes reintentar sin duplicar el archivo.');
   };
   xhr.onerror=()=>finish('error','Conexión interrumpida. Reintenta para comprobar o completar la subida sin duplicarla.');
   xhr.ontimeout=()=>finish('error','Se agotó el tiempo de espera. Puedes reintentar sin duplicar.');
   xhr.onabort=()=>finish('cancelled','Cancelada. Si llegó a guardarse, el reintento recuperará el mismo archivo.');
   xhr.send(t.blob);
  }
  render(){
   this.panel.hidden=this.tasks.length===0;this.panel.replaceChildren();
   const heading=document.createElement('strong');heading.textContent='Subidas';this.panel.append(heading);
   for(const t of this.tasks){
    const row=document.createElement('div');row.dataset.uploadState=t.state;row.style.cssText='padding-top:10px;border-top:1px solid #ddd;margin-top:8px';
    const label=document.createElement('div');label.textContent=t.label;
    const status=document.createElement('div');status.setAttribute('role','status');status.textContent=t.state==='queued'?'En cola':t.state==='uploading'?(t.percent===100?'Transferido; esperando confirmación de guardado':`Subiendo ${t.percent===null?'':t.percent+'%'}`):t.message;
    row.append(label,status);
    if(t.state==='uploading'){const progress=document.createElement('progress');progress.max=100;if(t.percent!==null)progress.value=t.percent;progress.setAttribute('aria-label','Progreso de '+t.label);row.append(progress);}
    const button=(text,action)=>{const b=document.createElement('button');b.type='button';b.textContent=text;b.addEventListener('click',action);row.append(b);return b;};
    if(['uploading','queued'].includes(t.state))button('Cancelar',()=>this.cancel(t));
    if(['busy','error','cancelled'].includes(t.state)&&t.blob)button('Reintentar',()=>this.retry(t)).disabled=Date.now()<(t.retryAt||0);
    if(!['uploading','queued'].includes(t.state))button('Descartar',()=>this.discard(t));
    this.panel.append(row);
   }
  }
 }
 globalThis.RuanoUploadQueue=UploadQueue;
})();
