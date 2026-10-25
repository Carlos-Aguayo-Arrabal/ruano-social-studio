// Lint the actual generated modules before paying for a Docker workload.
import {readFile,access} from 'node:fs/promises';
import {parse} from 'acorn';
import {fileURLToPath} from 'node:url';
import {resolve,sep} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)),source=await readFile(new URL('./test-soak.mjs',import.meta.url),'utf8');
const ast=parse(source,{ecmaVersion:'latest',sourceType:'module'});let common;const templates=[];
function visit(n){
 if(!n||typeof n!=='object')return;
 if(n.type==='VariableDeclarator'&&n.id.name==='common')common=n.init.quasis[0].value.cooked;
 if(n.type==='CallExpression'&&n.callee.name==='client'&&n.arguments[0]?.type==='BinaryExpression')templates.push({node:n.arguments[0].right,prefix:true});
 if(n.type==='CallExpression'&&n.callee.name==='tool'&&n.arguments[1]?.type==='TemplateLiteral')templates.push({node:n.arguments[1],prefix:false});
 for(const v of Object.values(n))if(Array.isArray(v))v.forEach(visit);else if(v&&typeof v==='object')visit(v);
}
visit(ast);
if(!common||templates.length<5)throw Error('Review generated module layout');
for(const [phaseMs,idleSeconds] of [[60000,0],[300000,120]])for(const {node:n,prefix} of templates){
 let code=prefix?common:'';
 for(let i=0;i<n.quasis.length;i++){
  code+=n.quasis[i].value.cooked;const e=n.expressions[i];
  if(e){if(e.name==='phaseMs')code+=phaseMs;else if(e.type==='BinaryExpression'&&e.left.name==='idleSeconds'&&e.operator==='*'&&e.right.value===1000)code+=idleSeconds*1000;else throw Error('Review generated expression');}
 }
 const module=parse(code,{ecmaVersion:'latest',sourceType:'module'});
 for(const item of module.body)if(item.type==='ImportDeclaration'){
  const path=item.source.value;if(path.startsWith('node:'))continue;
  const target=resolve(root,path);if(!path.startsWith('./lib/')||!target.startsWith(root+ (root.endsWith(sep)?'':sep)))throw Error('Generated import escapes container /app: '+path);
  await access(target);
 }
}
console.log('Generated workload/recovery module syntax and container imports verified ('+templates.length+' modules, both profiles)');
