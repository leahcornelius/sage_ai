# RUN_STATUS.md — overnight retrieval loop

- run id: r2026061323573_9362
- phase: run
- loop PID: 17528
- bench Sage PID: 34552 (port 8799)
- bench collection: bench_r2026061323573_9362_e1 (epoch 1)
- restartCount: 0
- iteration: 110 / 1000
- best: s20_e16_g20_c4000 utility=0.6659
- grid-best: s1_e10_g20_c400 utility=0.5192
- checkpoint spend (CONSERVATIVE est, upper-bound): $0.10 / $40 ceiling
- checkpoint runs: 1 / 60
- checkpoint model: gpt-5.2 (rates in $3/1M, out $15/1M)
- run dir: C:\Users\Admin\Documents\Code\Sage\overnight\runs\r2026061323573_9362
- stdout/err: C:\Users\Admin\Documents\Code\Sage\overnight\runs\r2026061323573_9362\logs\loop.out.log / C:\Users\Admin\Documents\Code\Sage\overnight\runs\r2026061323573_9362\logs\loop.err.log
- sage logs: C:\Users\Admin\Documents\Code\Sage\overnight\runs\r2026061323573_9362\logs\sage.out.log / sage.err.log

## resume
```powershell
node overnight/harness/loop.js --phase run --run r2026061323573_9362
```
## stop
```powershell
Stop-Process -Id 17528 -Force   # the loop
Stop-Process -Id 34552 -Force   # the bench Sage
docker rm -f qdrant_bench redis_bench falkordb_bench   # throwaway backends
```