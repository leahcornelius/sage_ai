import { toUnixSeconds } from "../../utils/time.js";

function serializeModel(model) {
  return {
    id: model.id,
    object: model.object || "model",
    created: toUnixSeconds(model.created, 0),
    owned_by: model.owned_by || "openai",
  };
}

function serializeModelList(models) {
  return {
    object: "list",
    data: models.map((model) => serializeModel(model)),
  };
}

export { serializeModel, serializeModelList };
