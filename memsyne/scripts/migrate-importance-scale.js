import { config as loadDotEnv } from "dotenv";
import path from "node:path";

loadDotEnv({
  path: path.resolve(process.cwd(), ".env.local"),
  override: false,
  quiet: true,
});

const vectorDbUrl = (process.env.MNEMOSYNE_VECTOR_DB_URL || "http://localhost:6333").replace(
  /\/+$/,
  ""
);
const sharedCollection = process.env.MNEMOSYNE_COLLECTION_NAME || "testing_container";
const privateCollection = process.env.MNEMOSYNE_PRIVATE_COLLECTION_NAME || "memory_private";
const markerCollection = "sage_meta";
const markerId = "migration_importance_v1";

async function main() {
  const marker = await getPoint(markerCollection, markerId);
  if (marker) {
    console.log("importance migration already completed:", marker.payload?.completed_at || "unknown");
    return;
  }

  const sharedUpdatedCount = await migrateCollection(sharedCollection);
  const privateUpdatedCount = await migrateCollection(privateCollection);
  await ensureCollection(markerCollection, 1);
  await putMarker({
    completed_at: new Date().toISOString(),
    shared_updated_count: sharedUpdatedCount,
    private_updated_count: privateUpdatedCount,
  });

  console.log(
    `importance migration complete: shared=${sharedUpdatedCount}, private=${privateUpdatedCount}`
  );
}

async function migrateCollection(collectionName) {
  const collectionExists = await hasCollection(collectionName);
  if (!collectionExists) {
    console.log(`collection ${collectionName} does not exist; skipping`);
    return 0;
  }

  let updatedCount = 0;
  let offset = null;
  while (true) {
    const response = await qdrantRequest(`/collections/${collectionName}/points/scroll`, {
      method: "POST",
      body: {
        limit: 256,
        with_payload: true,
        with_vector: false,
        ...(offset !== null ? { offset } : {}),
      },
    });

    const points = Array.isArray(response?.result?.points) ? response.result.points : [];
    for (const point of points) {
      const importance = point?.payload?.importance;
      if (typeof importance !== "number" || importance <= 1 || importance > 10) {
        continue;
      }

      const normalized = Number((importance / 10).toFixed(4));
      await qdrantRequest(`/collections/${collectionName}/points/payload`, {
        method: "POST",
        body: {
          wait: true,
          points: [point.id],
          payload: {
            importance: normalized,
          },
        },
      });
      updatedCount += 1;
    }

    offset = response?.result?.next_page_offset ?? null;
    if (offset === null) {
      break;
    }
  }

  return updatedCount;
}

async function hasCollection(collectionName) {
  const response = await fetch(`${vectorDbUrl}/collections/${collectionName}`, {
    method: "GET",
  });
  if (response.status === 404) {
    return false;
  }
  if (!response.ok) {
    throw new Error(`failed to fetch collection ${collectionName}: ${response.status}`);
  }
  return true;
}

async function ensureCollection(collectionName, vectorSize) {
  const exists = await hasCollection(collectionName);
  if (exists) {
    return;
  }

  const response = await fetch(`${vectorDbUrl}/collections/${collectionName}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      vectors: {
        size: vectorSize,
        distance: "Cosine",
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`failed to create collection ${collectionName}: ${response.status}`);
  }
}

async function getPoint(collectionName, id) {
  const exists = await hasCollection(collectionName);
  if (!exists) {
    return null;
  }
  const response = await fetch(`${vectorDbUrl}/collections/${collectionName}/points/${id}`, {
    method: "GET",
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`failed to get marker point: ${response.status}`);
  }

  const data = await response.json();
  return data?.result || null;
}

async function putMarker(payload) {
  await qdrantRequest(`/collections/${markerCollection}/points`, {
    method: "PUT",
    body: {
      wait: true,
      points: [
        {
          id: markerId,
          vector: [0],
          payload,
        },
      ],
    },
  });
}

async function qdrantRequest(pathname, { method, body }) {
  const response = await fetch(`${vectorDbUrl}${pathname}`, {
    method,
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Qdrant ${method} ${pathname} failed: ${response.status} ${text}`);
  }
  return response.json();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
