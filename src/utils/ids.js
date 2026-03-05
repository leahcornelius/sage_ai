import { randomUUID } from "node:crypto";

function createSyntheticId(prefix = "sage") {
  return `${prefix}-${randomUUID()}`;
}

export { createSyntheticId };
