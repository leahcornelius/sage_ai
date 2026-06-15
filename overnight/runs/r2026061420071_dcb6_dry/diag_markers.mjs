import fs from "node:fs";
const COL = "bench_r2026061420071_dcb6_dry_e1";
const QURL = "http://127.0.0.1:6344";
const ds = JSON.parse(fs.readFileSync("overnight/runs/r2026061420071_dcb6_dry/dataset.json","utf8"));

// completeness set: dev + heldout + gate2 question, required markers only
const qs = [...ds.dev, ...ds.heldout, ds.gate2.question].filter(q=>q.requiredMarkers && q.requiredMarkers.length>0);
const required = [...new Set(qs.flatMap(q=>q.requiredMarkers))];

// scroll all points
let liveText = [], oldText = [], next = null, total=0, deleted=0;
do {
  const body = { limit: 256, with_payload: true, with_vector: false };
  if (next) body.offset = next;
  const r = await fetch(`${QURL}/collections/${COL}/points/scroll`, {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  const j = await r.json();
  const pts = j.result.points;
  for (const p of pts){ total++; if(p.payload?.deleted) deleted++; liveText.push(p.payload?.text||""); const mo=p.payload?.metadata?.merged_old_text; if(mo) oldText.push(mo); }
  next = j.result.next_page_offset;
} while (next);

const liveBlob = liveText.join("\n");
const oldBlob = oldText.join("\n");
const inLive = required.filter(m=>liveBlob.includes(m));
const onlyOld = required.filter(m=>!liveBlob.includes(m) && oldBlob.includes(m));
const gone = required.filter(m=>!liveBlob.includes(m) && !oldBlob.includes(m));
console.log(JSON.stringify({
  points_total: total, points_deleted: deleted,
  required_markers: required.length,
  present_in_live_text: inLive.length,
  only_in_merged_old_text: onlyOld.length,
  absent_entirely: gone.length,
  sample_onlyOld: onlyOld.slice(0,5),
  sample_gone: gone.slice(0,5),
}, null, 2));
