# GATE_FAILURE.md

Run r2026061420332_f4c0_dry HALTED before launch — a gate did not pass. Nothing was launched.

- failed gate: **Gate 1b — scoped channel did not carry the gold (reframed)**
- reason: Gate1b (reframed, scoped channel) FAILED [scopedGap]. scoped: mrrA=0.832 recallB'(scoped semantic)=0.719 recallC(episodic-only)=0.000 attrib=1.00; headline gap B'-B_unscoped=0.125 (>=0.3); control B_dbsearch_unscoped=0.469 (pureScoping=0.250 pipeline=-0.125). The within-scope payload-filter did not carry the gold in the live pipeline (the offline rank-1-2 evidence did not transfer) or the scoping gap is insufficient. Per the run rule: accept the halt, do NOT fix-and-retry.

## evidence
```json
{
  "configs": {
    "A": {
      "semanticTopK": 5,
      "episodicTopK": 3,
      "graphMaxResults": 20,
      "contextMaxTokens": 2000,
      "scopeFilter": 1
    },
    "Bprime": {
      "semanticTopK": 5,
      "episodicTopK": 0,
      "graphMaxResults": 20,
      "contextMaxTokens": 2000,
      "scopeFilter": 1
    },
    "C": {
      "semanticTopK": 0,
      "episodicTopK": 3,
      "graphMaxResults": 20,
      "contextMaxTokens": 2000,
      "scopeFilter": 0
    },
    "Bunscoped": {
      "semanticTopK": 5,
      "episodicTopK": 0,
      "graphMaxResults": 20,
      "contextMaxTokens": 2000,
      "scopeFilter": 0
    }
  },
  "meanMrrA": 0.8317708333333332,
  "meanRecallBprime": 0.71875,
  "meanRecallC": 0,
  "meanRecallBunscoped": 0.59375,
  "scopedGap": 0.125,
  "controlProbe": {
    "meanRecallBdbsearchUnscoped": 0.46875,
    "pureScopingEffect": 0.25,
    "pipelineEffect": -0.125,
    "note": "measurement-only; raw unscoped db.search; NOT a pass/fail criterion"
  },
  "attribution": 1,
  "recall1Count": 23,
  "multiRecallA": 1,
  "multiRecallBprime": 1,
  "floorCount": 32,
  "thresholds": {
    "contextMaxTokens": 2000,
    "meanMrrAMin": 0.2,
    "meanRecallBMin": 0.5,
    "meanRecallCMax": 0.1,
    "scopedGapMin": 0.3,
    "attributionMin": 0.7
  },
  "criteria": {
    "meanMrrA": true,
    "meanRecallB": true,
    "meanRecallC": true,
    "scopedGap": false,
    "attribution": true
  },
  "perItem": [
    {
      "id": "dev-single-0-0",
      "type": "single",
      "A": {
        "recall": 1,
        "mrr": 1
      },
      "Bprime": {
        "recall": 1,
        "mrr": 1
      },
      "C": {
        "recall": 0
      },
      "Bunscoped": {
        "recall": 1,
        "mrr": 1
      },
      "BdbsearchUnscoped": {
        "recall": 1,
        "mrr": 0.3333333333333333
      }
    },
    {
      "id": "dev-single-0-1",
      "type": "single",
      "A": {
        "recall": 1,
        "mrr": 0.5
      },
      "Bprime": {
        "recall": 1,
        "mrr": 0.5
      },
      "C": {
        "recall": 0
      },
      "Bunscoped": {
        "recall": 1,
        "mrr": 1
      },
      "BdbsearchUnscoped": {
        "recall": 1,
        "mrr": 0.3333333333333333
      }
    },
    {
      "id": "dev-single-0-2",
      "type": "single",
      "A": {
        "recall": 1,
        "mrr": 0.5
      },
      "Bprime": {
        "recall": 1,
        "mrr": 0.5
      },
      "C": {
        "recall": 0
      },
      "Bunscoped": {
        "recall": 0,
        "mrr": 0
      },
      "BdbsearchUnscoped": {
        "recall": 0,
        "mrr": 0
      }
    },
    {
      "id": "dev-temporal-0-0",
      "type": "temporal",
      "A": {
        "recall": 0,
        "mrr": 1
      },
      "Bprime": {
        "recall": 0,
        "mrr": 1
      },
      "C": {
        "recall": 0
      },
      "Bunscoped": {
        "recall": 0,
        "mrr": 1
      },
      "BdbsearchUnscoped": {
        "recall": 0,
        "mrr": 1
      }
    },
    {
      "id": "dev-single-1-0",
      "type": "single",
      "A": {
        "recall": 1,
        "mrr": 1
      },
      "Bprime": {
        "recall": 1,
        "mrr": 1
      },
      "C": {
        "recall": 0
      },
      "Bunscoped": {
        "recall": 1,
        "mrr": 1
      },
      "BdbsearchUnscoped": {
        "recall": 1,
        "mrr": 0.3333333333333333
      }
    },
    {
      "id": "dev-single-1-1",
      "type": "single",
      "A": {
        "recall": 1,
        "mrr": 1
      },
      "Bprime": {
        "recall": 1,
        "mrr": 1
      },
      "C": {
        "recall": 0
      },
      "Bunscoped": {
        "recall": 1,
        "mrr": 0.5
      },
      "BdbsearchUnscoped": {
        "recall": 0,
        "mrr": 0
      }
    },
    {
      "id": "dev-single-1-2",
      "type": "single",
      "A": {
        "recall": 1,
        "mrr": 1
      },
      "Bprime": {
        "recall": 1,
        "mrr": 1
      },
      "C": {
        "recall": 0
      },
      "Bunscoped": {
        "recall": 1,
        "mrr": 1
      },
      "BdbsearchUnscoped": {
        "recall": 1,
        "mrr": 0.5
      }
    },
    {
      "id": "dev-temporal-1-0",
      "type": "temporal",
      "A": {
        "recall": 0,
        "mrr": 1
      },
      "Bprime": {
        "recall": 0,
        "mrr": 1
      },
      "C": {
        "recall": 0
      },
      "Bunscoped": {
        "recall": 0,
        "mrr": 1
      },
      "BdbsearchUnscoped": {
        "recall": 0,
        "mrr": 1
      }
    },
    {
      "id": "dev-single-2-0",
      "type": "single",
      "A": {
        "recall": 1,
        "mrr": 1
      },
      "Bprime": {
        "recall": 1,
        "mrr": 1
      },
      "C": {
        "recall": 0
      },
      "Bunscoped": {
        "recall": 1,
        "mrr": 1
      },
      "BdbsearchUnscoped": {
        "recall": 1,
        "mrr": 1
      }
    },
    {
      "id": "dev-single-2-1",
      "type": "single",
      "A": {
        "recall": 1,
        "mrr": 1
      },
      "Bprime": {
        "recall": 1,
        "mrr": 1
      },
      "C": {
        "recall": 0
      },
      "Bunscoped": {
        "recall": 1,
        "mrr": 1
      },
      "BdbsearchUnscoped": {
        "recall": 1,
        "mrr": 0.25
      }
    },
    {
      "id": "dev-single-2-2",
      "type": "single",
      "A": {
        "recall": 1,
        "mrr": 0.3333333333333333
      },
      "Bprime": {
        "recall": 1,
        "mrr": 0.3333333333333333
      },
      "C": {
        "recall": 0
      },
      "Bunscoped": {
        "recall": 1,
        "mrr": 1
      },
      "BdbsearchUnscoped": {
        "recall": 1,
        "mrr": 0.3333333333333333
      }
    },
    {
      "id": "dev-temporal-2-0",
      "type": "temporal",
      "A": {
        "recall": 0,
        "mrr": 1
      },
      "Bprime": {
        "recall": 0,
        "mrr": 1
      },
      "C": {
        "recall": 0
      },
      "Bunscoped": {
        "recall": 0,
        "mrr": 1
      },
      "BdbsearchUnscoped": {
        "recall": 1,
        "mrr": 0.5
      }
    },
    {
      "id": "dev-single-3-0",
      "type": "single",
      "A": {
        "recall": 1,
        "mrr": 1
      },
      "Bprime": {
        "recall": 1,
        "mrr": 1
      },
      "C": {
        "recall": 0
      },
      "Bunscoped": {
        "recall": 1,
        "mrr": 1
      },
      "BdbsearchUnscoped": {
        "recall": 1,
        "mrr": 0.3333333333333333
      }
    },
    {
      "id": "dev-single-3-1",
      "type": "single",
      "A": {
        "recall": 1,
        "mrr": 1
      },
      "Bprime": {
        "recall": 1,
        "mrr": 1
      },
      "C": {
        "recall": 0
      },
      "Bunscoped": {
        "recall": 1,
        "mrr": 1
      },
      "BdbsearchUnscoped": {
        "recall": 1,
        "mrr": 0.5
      }
    },
    {
      "id": "dev-single-3-2",
      "type": "single",
      "A": {
        "recall": 1,
        "mrr": 1
      },
      "Bprime": {
        "recall": 1,
        "mrr": 1
      },
      "C": {
        "recall": 0
      },
      "Bunscoped": {
        "recall": 1,
        "mrr": 1
      },
      "BdbsearchUnscoped": {
        "recall": 1,
        "mrr": 0.3333333333333333
      }
    },
    {
      "id": "dev-temporal-3-0",
      "type": "temporal",
      "A": {
        "recall": 0,
        "mrr": 1
      },
      "Bprime": {
        "recall": 0,
        "mrr": 1
      },
      "C": {
        "recall": 0
      },
      "Bunscoped": {
        "recall": 0,
        "mrr": 1
      },
      "BdbsearchUnscoped": {
        "recall": 0,
        "mrr": 1
      }
    },
    {
      "id": "dev-single-4-0",
      "type": "single",
      "A": {
        "recall": 1,
        "mrr": 0.2
      },
      "Bprime": {
        "recall": 1,
        "mrr": 0.2
      },
      "C": {
        "recall": 0
      },
      "Bunscoped": {
        "recall": 0,
        "mrr": 0
      },
      "BdbsearchUnscoped": {
        "recall": 0,
        "mrr": 0
      }
    },
    {
      "id": "dev-single-4-1",
      "type": "single",
      "A": {
        "recall": 1,
        "mrr": 1
      },
      "Bprime": {
        "recall": 1,
        "mrr": 1
      },
      "C": {
        "recall": 0
      },
      "Bunscoped": {
        "recall": 1,
        "mrr": 1
      },
      "BdbsearchUnscoped": {
        "recall": 0,
        "mrr": 0
      }
    },
    {
      "id": "dev-single-4-2",
      "type": "single",
      "A": {
        "recall": 0,
        "mrr": 0
      },
      "Bprime": {
        "recall": 0,
        "mrr": 0
      },
      "C": {
        "recall": 0
      },
      "Bunscoped": {
        "recall": 0,
        "mrr": 0
      },
      "BdbsearchUnscoped": {
        "recall": 0,
        "mrr": 0
      }
    },
    {
      "id": "dev-temporal-4-0",
      "type": "temporal",
      "A": {
        "recall": 0,
        "mrr": 1
      },
      "Bprime": {
        "recall": 0,
        "mrr": 1
      },
      "C": {
        "recall": 0
      },
      "Bunscoped": {
        "recall": 0,
        "mrr": 1
      },
      "BdbsearchUnscoped": {
        "recall": 0,
        "mrr": 1
      }
    },
    {
      "id": "dev-single-5-0",
      "type": "single",
      "A": {
        "recall": 1,
        "mrr": 1
      },
      "Bprime": {
        "recall": 1,
        "mrr": 1
      },
      "C": {
        "recall": 0
      },
      "Bunscoped": {
        "recall": 1,
        "mrr": 1
      },
      "BdbsearchUnscoped": {
        "recall": 0,
        "mrr": 0
      }
    },
    {
      "id": "dev-single-5-1",
      "type": "single",
      "A": {
        "recall": 1,
        "mrr": 1
      },
      "Bprime": {
        "recall": 1,
        "mrr": 1
      },
      "C": {
        "recall": 0
      },
      "Bunscoped": {
        "recall": 1,
        "mrr": 1
      },
      "BdbsearchUnscoped": {
        "recall": 1,
        "mrr": 1
      }
    },
    {
      "id": "dev-single-5-2",
      "type": "single",
      "A": {
        "recall": 1,
        "mrr": 1
      },
      "Bprime": {
        "recall": 1,
        "mrr": 1
      },
      "C": {
        "recall": 0
      },
      "Bunscoped": {
        "recall": 1,
        "mrr": 1
      },
      "BdbsearchUnscoped": {
        "recall": 0,
        "mrr": 0
      }
    },
    {
      "id": "dev-temporal-5-0",
      "type": "temporal",
      "A": {
        "recall": 0,
        "mrr": 1
      },
      "Bprime": {
        "recall": 0,
        "mrr": 1
      },
      "C": {
        "recall": 0
      },
      "Bunscoped": {
        "recall": 0,
        "mrr": 0.5
      },
      "BdbsearchUnscoped": {
        "recall": 1,
        "mrr": 0.2
      }
    },
    {
      "id": "dev-single-6-0",
      "type": "single",
      "A": {
        "recall": 1,
        "mrr": 1
      },
      "Bprime": {
        "recall": 1,
        "mrr": 1
      },
      "C": {
        "recall": 0
      },
      "Bunscoped": {
        "recall": 1,
        "mrr": 1
      },
      "BdbsearchUnscoped": {
        "recall": 0,
        "mrr": 0
      }
    },
    {
      "id": "dev-single-6-1",
      "type": "single",
      "A": {
        "recall": 1,
        "mrr": 1
      },
      "Bprime": {
        "recall": 1,
        "mrr": 1
      },
      "C": {
        "recall": 0
      },
      "Bunscoped": {
        "recall": 1,
        "mrr": 1
      },
      "BdbsearchUnscoped": {
        "recall": 1,
        "mrr": 0.3333333333333333
      }
    },
    {
      "id": "dev-single-6-2",
      "type": "single",
      "A": {
        "recall": 1,
        "mrr": 0.5
      },
      "Bprime": {
        "recall": 1,
        "mrr": 0.5
      },
      "C": {
        "recall": 0
      },
      "Bunscoped": {
        "recall": 0,
        "mrr": 0
      },
      "BdbsearchUnscoped": {
        "recall": 0,
        "mrr": 0
      }
    },
    {
      "id": "dev-temporal-6-0",
      "type": "temporal",
      "A": {
        "recall": 0,
        "mrr": 0.3333333333333333
      },
      "Bprime": {
        "recall": 0,
        "mrr": 0.3333333333333333
      },
      "C": {
        "recall": 0
      },
      "Bunscoped": {
        "recall": 0,
        "mrr": 0.5
      },
      "BdbsearchUnscoped": {
        "recall": 0,
        "mrr": 0
      }
    },
    {
      "id": "dev-single-7-0",
      "type": "single",
      "A": {
        "recall": 1,
        "mrr": 1
      },
      "Bprime": {
        "recall": 1,
        "mrr": 1
      },
      "C": {
        "recall": 0
      },
      "Bunscoped": {
        "recall": 1,
        "mrr": 1
      },
      "BdbsearchUnscoped": {
        "recall": 0,
        "mrr": 0
      }
    },
    {
      "id": "dev-single-7-1",
      "type": "single",
      "A": {
        "recall": 1,
        "mrr": 0.25
      },
      "Bprime": {
        "recall": 1,
        "mrr": 0.25
      },
      "C": {
        "recall": 0
      },
      "Bunscoped": {
        "recall": 0,
        "mrr": 0
      },
      "BdbsearchUnscoped": {
        "recall": 0,
        "mrr": 0
      }
    },
    {
      "id": "dev-single-7-2",
      "type": "single",
      "A": {
        "recall": 1,
        "mrr": 1
      },
      "Bprime": {
        "recall": 1,
        "mrr": 1
      },
      "C": {
        "recall": 0
      },
      "Bunscoped": {
        "recall": 1,
        "mrr": 1
      },
      "BdbsearchUnscoped": {
        "recall": 1,
        "mrr": 0.3333333333333333
      }
    },
    {
      "id": "dev-temporal-7-0",
      "type": "temporal",
      "A": {
        "recall": 0,
        "mrr": 1
      },
      "Bprime": {
        "recall": 0,
        "mrr": 1
      },
      "C": {
        "recall": 0
      },
      "Bunscoped": {
        "recall": 0,
        "mrr": 1
      },
      "BdbsearchUnscoped": {
        "recall": 0,
        "mrr": 1
      }
    }
  ],
  "offlinePreview": {
    "scoredQuestions": 60,
    "within5UnscopedRate": 0.8,
    "within5ScopedRate": 1,
    "meanGoldCosine": 0.8539668349017773,
    "cosineFloor": 0.5,
    "note": "Approximate vector-only ranks (no BM25/hybrid). Scoped preview hints at the scopeFilter A/B; Gate 1b is the authoritative check."
  }
}
```

## diagnosis / next step
Review the evidence above and the loop log under logs/. The harness made no
code/config changes to force a pass. Fix the root cause, then re-run the gates
phase: `node overnight/harness/loop.js --phase gates --run r2026061420332_f4c0_dry`.