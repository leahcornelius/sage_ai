import assert from "node:assert/strict";
import test from "node:test";
import pino from "pino";

import { createModelService } from "../src/services/model-service.js";

const logger = pino({ level: "silent" });

test("model service filters upstream models through the allowlist", async () => {
  const service = createModelService({
    openaiClient: {
      models: {
        list: async () => ({
          data: [{ id: "gpt-4.1-mini" }, { id: "gpt-5.2" }],
        }),
      },
    },
    config: {
      openai: {
        modelAllowlist: ["gpt-5.2"],
        modelCacheTtlMs: 60_000,
      },
    },
    logger,
  });

  const models = await service.listModels();
  assert.deepEqual(models.map((model) => model.id), ["gpt-5.2"]);
});

test("model service falls back to stale cache when refresh fails", async () => {
  let shouldFail = false;
  const service = createModelService({
    openaiClient: {
      models: {
        list: async () => {
          if (shouldFail) {
            throw new Error("Upstream is down");
          }
          return { data: [{ id: "gpt-5.2" }] };
        },
      },
    },
    config: {
      openai: {
        modelAllowlist: null,
        modelCacheTtlMs: 1,
      },
    },
    logger,
  });

  const firstFetch = await service.listModels();
  assert.equal(firstFetch.length, 1);

  shouldFail = true;
  const secondFetch = await service.listModels({ forceRefresh: true });
  assert.equal(secondFetch.length, 1);
  assert.equal(secondFetch[0].id, "gpt-5.2");
});
