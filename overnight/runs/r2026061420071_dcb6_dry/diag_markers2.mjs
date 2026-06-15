import fs from "node:fs";
const COL = "bench_r2026061420071_dcb6_dry_e1";
const QURL = "http://127.0.0.1:6344";
const ds = JSON.parse(fs.readFileSync("overnight/runs/r2026061420071_dcb6_dry/dataset.json","utf8"));
const qs = [...ds.dev, ...ds.heldout, ds.gate2.question].filter(q=>q.requiredMarkers?.length>0);

// scroll all points, split by deleted
let live=[], dead=[], next=null, withScopeKey=0, liveCount=0;
do {
  const body = { limit:256, with_payload:true, with_vector:false };
  if (next) body.offset=next;
  const r = await fetch(`${QURL}/collections/${COL}/points/scroll`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  const j = await r.json();
  for (const p of j.result.points){
    const rec = { text:p.payload?.text||"", scopeKey:p.payload?.metadata?.scopeKey };
    if (p.payload?.deleted) dead.push(rec); else { live.push(rec); liveCount++; if(rec.scopeKey) withScopeKey++; }
  }
  next=j.result.next_page_offset;
} while(next);

const liveBlob = live.map(r=>r.text).join("\n");
const deadBlob = dead.map(r=>r.text).join("\n");

// per-question: marker in a LIVE point? in a live point WITH matching scopeKey?
let inLive=0, inLiveScoped=0, onlyDead=0;
for (const q of qs){
  const m = q.requiredMarkers[0];
  const liveHit = liveBlob.includes(m);
  const scopedHit = live.some(r=>r.scopeKey===q.scope && r.text.includes(m));
  if (liveHit) inLive++; else if (deadBlob.includes(m)) onlyDead++;
  if (scopedHit) inLiveScoped++;
}
console.log(JSON.stringify({
  live_points: liveCount, dead_points: dead.length,
  live_points_with_scopeKey: withScopeKey,
  questions: qs.length,
  marker_in_a_live_point: inLive,
  marker_in_live_point_with_matching_scopeKey: inLiveScoped,
  marker_only_in_deleted_point: onlyDead,
}, null, 2));
