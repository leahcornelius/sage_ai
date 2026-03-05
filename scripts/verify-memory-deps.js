import fs from "node:fs";
import path from "node:path";
import process from "node:process";

async function main() {
  const pkg = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));
  const mem0Version = pkg.dependencies?.mem0ai || null;
  const zepVersion = pkg.dependencies?.["@getzep/zep-cloud"] || null;
  const redisVersion = pkg.dependencies?.ioredis || null;

  if (!mem0Version || !zepVersion || !redisVersion) {
    throw new Error("Missing required memory dependencies in package.json.");
  }

  const mem0 = await import("mem0ai");
  if (typeof mem0.MemoryClient !== "function") {
    throw new Error("mem0ai does not export MemoryClient.");
  }

  const typeFile = path.resolve("node_modules/mem0ai/dist/index.d.ts");
  const types = fs.readFileSync(typeFile, "utf8");
  if (!types.includes("apiKey: string")) {
    throw new Error("mem0ai ClientOptions missing required apiKey field.");
  }
  if (!types.includes("host?: string")) {
    throw new Error("mem0ai ClientOptions missing optional host field.");
  }

  console.log("Memory dependency verification passed.");
  console.log(`mem0ai=${mem0Version}`);
  console.log(`@getzep/zep-cloud=${zepVersion}`);
  console.log(`ioredis=${redisVersion}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
