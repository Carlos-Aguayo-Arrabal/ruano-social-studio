import test from 'node:test';import assert from 'node:assert/strict';import {rssWindow} from '../lib/soak-analysis.mjs';
test('RSS analysis measures stable, increasing and insufficient windows without claiming leak causality',()=>{
 const stable=Array.from({length:301},(_,i)=>({at:10000+i*1000,rssBytes:90*1048576}));const s=rssWindow(stable,10000,310000);assert.equal(s.slopeMiBPerMinute,0);assert.equal(s.deltaMedianBytes,0);assert.equal(s.samples,301);
 const rising=stable.map((s,i)=>({...s,rssBytes:(90+i/60)*1048576}));const r=rssWindow(rising,10000,310000);assert.ok(Math.abs(r.slopeMiBPerMinute-1)<.00001);assert.ok(r.deltaMedianBytes>3*1048576);
 assert.equal(rssWindow([],0,100).insufficient,true);assert.equal(rssWindow([{at:1,rssBytes:NaN}],0,100).samples,0);
});
