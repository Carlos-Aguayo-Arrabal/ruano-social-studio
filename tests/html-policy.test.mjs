import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parse} from 'acorn';
test('H03: dynamic HTML sinks must pass directly through DOMPurify',async()=>{
 const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
 const source=[...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(x=>x[1]).find(x=>x.trim());
 let sanitized=0;
 const purifier=n=>n?.type==='CallExpression'&&n.callee?.type==='MemberExpression'&&n.callee.object.name==='DOMPurify'&&n.callee.property.name==='sanitize';
 function visit(n){if(!n||typeof n!=='object')return;
  if(n.type==='AssignmentExpression'&&n.left.type==='MemberExpression'&&['innerHTML','outerHTML'].includes(n.left.property.name)){assert.ok(purifier(n.right),'Raw HTML assignment must be reviewed');sanitized++;}
  if(n.type==='CallExpression'&&n.callee.type==='MemberExpression'){
   if(['insertAdjacentHTML','write','writeln'].includes(n.callee.property.name))assert.ok(purifier(n.arguments.at(-1)),'Raw document/HTML write must be reviewed');
  }
  for(const v of Object.values(n))if(Array.isArray(v))v.forEach(visit);else if(v&&typeof v==='object')visit(v);
 }
 visit(parse(source,{ecmaVersion:'latest'}));assert.equal(sanitized,1,'Keep one auditable sanitizer boundary');
});
