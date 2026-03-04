import { serializeModelList } from "../serializers/openai-models.js";

async function registerModelRoutes(app) {
  app.get("/models", async (request) => {
    const models = await app.sageServices.modelService.listModels({
      logger: request.log,
    });
    return serializeModelList(models);
  });
}

export { registerModelRoutes };
