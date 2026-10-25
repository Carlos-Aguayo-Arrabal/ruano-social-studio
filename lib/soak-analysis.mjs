// Descriptive statistics, not a leak detector or a production-capacity promise.
export function rssWindow(samples,start,end){
 const rows=samples.filter(s=>Number.isFinite(s.at)&&Number.isFinite(s.rssBytes)&&s.at>=start&&s.at<=end);
 if(rows.length<2)return {samples:rows.length,insufficient:true};
 const origin=rows[0].at,xs=rows.map(s=>(s.at-origin)/60000),ys=rows.map(s=>s.rssBytes/1048576),mean=a=>a.reduce((n,v)=>n+v,0)/a.length;
 const mx=mean(xs),my=mean(ys),variance=xs.reduce((n,x)=>n+(x-mx)**2,0);
 const median=a=>[...a].sort((a,b)=>a-b)[Math.floor(a.length/2)];
 const window=Math.min(60000,(end-start)/3),first=rows.filter(s=>s.at<=rows[0].at+window),last=rows.filter(s=>s.at>=rows.at(-1).at-window);
 const initialMedianBytes=median(first.map(s=>s.rssBytes)),finalMedianBytes=median(last.map(s=>s.rssBytes));
 return {samples:rows.length,durationMs:rows.at(-1).at-origin,initialMedianBytes,finalMedianBytes,deltaMedianBytes:finalMedianBytes-initialMedianBytes,slopeMiBPerMinute:variance?xs.reduce((n,x,i)=>n+(x-mx)*(ys[i]-my),0)/variance:0,minBytes:Math.min(...rows.map(s=>s.rssBytes)),maxBytes:Math.max(...rows.map(s=>s.rssBytes))};
}
