import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { validateState } from '../state.mjs';
const html = await readFile(new URL('../index.html',import.meta.url),'utf8');
const client = await readFile(new URL('../saas-client.js',import.meta.url),'utf8');
const inline = /<script>\s*([\s\S]*?)<\/script>/.exec(html)[1];
const idA='aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',idB='bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const content={id:1,title:'<img src=x onerror="window.attacked=true">',caption:'<script>window.attacked=true</script>',type:'Publicación',channel:'Instagram',status:'pending',date:'2026-10-04',icon:'⌂'};
async function preview({failSave=false}={}) {
  const dom=new JSDOM(html,{url:'http://localhost',runScripts:'outside-only',pretendToBeVisual:true});
  const window=dom.window;window.structuredClone=structuredClone;
  window.HTMLCanvasElement.prototype.getContext=()=>({});
  window.alert=()=>{};
  const writes=[];
  window.fetch=async(path,options={})=>{
    let body;
    if(path==='/api/me')body={user:{email:'test@example.test'},organizations:[{id:idA,name:'Empresa A',role:'owner'},{id:idB,name:'Empresa B',role:'owner'}]};
    else if(options.method==='PUT'){
      writes.push({path,body:JSON.parse(options.body)});
      if(failSave)return {ok:false,status:409,json:async()=>({error:'Conflicto de versión'})};
      body={version:1,data:JSON.parse(options.body).data};
    }else body={version:0,data:{content:path.includes(idA)?[content]:[],properties:[],workflowStep:1}};
    return {ok:true,status:200,json:async()=>body};
  };
  window.eval(client);window.eval(inline);
  await new Promise(resolve=>setTimeout(resolve,25));
  return {window,writes,close:()=>window.close()};
}
test('browser loads server data without demos, renders text safely and persists approval',async()=>{
  const page=await preview();try{
    const document=page.window.document;
    assert.equal(document.querySelector('.app-shell').hasAttribute('inert'),false);
    assert.equal(document.querySelector('#pendingCount').textContent,'1');
    assert.equal(document.querySelector('#reviewList img'),null);
    assert.equal(page.window.attacked,undefined);
    assert.match(document.querySelector('#reviewList').textContent,/<img src=x/);
    document.querySelector('[data-approve]').click();
    await new Promise(resolve=>setTimeout(resolve,25));
    assert.equal(page.writes.length,1);
    assert.equal(page.writes[0].body.data.content[0].status,'approved');
    assert.equal(document.querySelector('#approvedCount').textContent,'1');
  }finally{page.close()}
});
test('changing organization replaces content and does not import browser storage',async()=>{
  const page=await preview();try{
    page.window.localStorage.setItem('ruanoContent',JSON.stringify([content]));
    const buttons=page.window.document.querySelectorAll('#companiesList button');
    buttons[1].click();await new Promise(resolve=>setTimeout(resolve,25));
    assert.equal(page.window.document.querySelector('.company-switcher strong').textContent,'Empresa B');
    assert.equal(page.window.document.querySelector('#pendingCount').textContent,'0');
    assert.equal(page.writes.length,0);
  }finally{page.close()}
});
test('save conflict blocks further editing and offers export rather than reporting success',async()=>{
  const page=await preview({failSave:true});try{
    page.window.document.querySelector('[data-approve]').click();await new Promise(resolve=>setTimeout(resolve,25));
    assert.equal(page.window.document.querySelector('.app-shell').hasAttribute('inert'),true);
    const alert=page.window.document.querySelector('[role=alert]');
    assert.match(alert.textContent,/No se ha confirmado el guardado/);
    assert.match(alert.textContent,/Descargar mis cambios/);
  }finally{page.close()}
});

test('verified property fields persist, generate linked drafts without invented data and remain editable',async()=>{
 const page=await preview();try{
  const d=page.window.document;
  d.querySelector('#importListing').click();
  const form=d.querySelector('#propertyForm');
  for(const [key,value] of Object.entries({title:'Vivienda de prueba <segura>',reference:'TEST-1',location:'Almería',price:'165.000 €',beds:'2',url:'https://example.test/vivienda',extras:'Terraza confirmada'}))form.elements.namedItem(key).value=value;
  form.dispatchEvent(new page.window.Event('submit',{bubbles:true,cancelable:true}));
  await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(page.writes.at(-1).body.data.properties[0].beds,'2');
  assert.equal(d.querySelector('#propertiesList segura'),null);
  d.querySelector('[data-generate-pack]').click();await new Promise(resolve=>setTimeout(resolve,25));
  const data=page.writes.at(-1).body.data;
  assert.deepEqual(validateState({version:0,data}).data,data);
  const pack=data.content.filter(x=>x.propertyRef);
  assert.equal(pack.length,4);assert.equal(new Set(pack.map(x=>x.type)).size,4);
  for(const item of pack){assert.match(item.caption,/Terraza confirmada/);assert.match(item.caption,/165.000/);assert.doesNotMatch(item.caption,/Baños|piscina/);assert.equal(item.status,'pending')}
  d.querySelector('[data-edit]').click();const composer=d.querySelector('#composerForm');
  composer.elements.details.value='Texto revisado por la agencia';
  composer.dispatchEvent(new page.window.Event('submit',{bubbles:true,cancelable:true}));await new Promise(resolve=>setTimeout(resolve,25));
  assert.ok(page.writes.at(-1).body.data.content.some(x=>x.caption==='Texto revisado por la agencia'));
  d.querySelectorAll('#companiesList button')[1].click();await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(d.querySelector('#propertyModal').classList.contains('open'),false);
  assert.match(d.querySelector('#propertiesList').textContent,/Aún no hay inmuebles/);
 }finally{page.close()}
});
