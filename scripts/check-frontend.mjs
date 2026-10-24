import { readFile } from 'node:fs/promises';
import { parse } from 'acorn';
const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
let count=0;
for(const [,source] of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
  if(source.trim()){parse(source,{ecmaVersion:'latest'});count++;}
}
if(count!==1)throw Error('Unexpected frontend script layout: review syntax check');
console.log('Frontend JavaScript syntax verified');
