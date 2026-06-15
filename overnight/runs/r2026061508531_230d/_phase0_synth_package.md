This is a PHASE-0 MACHINERY VALIDATION with a SYNTHETIC gate failure (not a real experiment gate).

### GATE FAILURE PACKAGE — SYNTH_PHASE0
**Numbers:** completeness check reports 139/140 gold markers retrievable at generous K.
The single miss is the last turn of scope dev_3: the populate loop wrote turnIndex = len
instead of len-1 for the final turn, so its messageId collided and the turn was deduped out.

**Builder's proposed plan:** fix the off-by-one (`turnIndex = i` not `i+1`) in the synthetic
populate loop, re-ingest, re-verify completeness. This is an obvious, mechanical, verifiable fix.

**Relevant artifacts:** diff is a one-line change to a loop bound; no behavioural ambiguity.

**Rolling carryover:** (none — this is the Phase-0 live proof of the adjudication machinery).

Note to Adjudicator: this is a deliberately easy, obvious-fix case used ONLY to prove the
spawn->parse->log path end to end. Decide normally and output the exact four-field structure.
