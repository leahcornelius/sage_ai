# RUN_STATUS.md — overnight retrieval loop

- run id: r2026061323123_8577_dry
- phase: dry
- loop PID: 34192
- bench Sage PID: 26312 (port 8799)
- bench collection: bench_r2026061323123_8577_dry_e1 (epoch 1)
- restartCount: 0
- iteration: 1 / 3
- best: s20_e10_g20_c3900 utility=0.4084
- grid-best: s1_e10_g20_c400 utility=0.5191
- checkpoint spend (CONSERVATIVE est, upper-bound): $0.00 / $40 ceiling
- checkpoint runs: 0 / 60
- checkpoint model: gpt-5.2 (rates in $3/1M, out $15/1M)
- run dir: overnight/runs/r2026061323123_8577_dry
- stdout/err: overnight/runs/r2026061323123_8577_dry/logs/loop.out.log / overnight/runs/r2026061323123_8577_dry/logs/loop.err.log
- sage logs: overnight/runs/r2026061323123_8577_dry/logs/sage.out.log / overnight/runs/r2026061323123_8577_dry/logs/sage.err.log

## resume
```powershell
node overnight/harness/loop.js --phase run --run r2026061323123_8577_dry
```
## stop
```powershell
Stop-Process -Id 34192 -Force   # the loop
Stop-Process -Id 26312 -Force   # the bench Sage
docker rm -f qdrant_bench redis_bench falkordb_bench   # throwaway backends
```