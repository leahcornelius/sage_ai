import { createHash, randomUUID } from "node:crypto";

import { AppError } from "../errors/app-error.js";
import { excerptText, textLength } from "../logging/safe-debug.js";

function createDocumentCache({ config, logger }) {
  const cacheLogger = logger.child({ component: "document-cache" });
  const documents = new Map();
  const searchResults = new Map();

  const ttlMs = config.tools.documentCache.ttlMs;
  const maxDocuments = config.tools.documentCache.maxDocuments;
  const maxDocumentBytes = config.tools.documentCache.maxDocumentBytes;

  function putSearchResults({ query, results }) {
    pruneExpired();

    const mappedResults = Array.isArray(results)
      ? results.map((result, index) => {
          const url = typeof result?.url === "string" ? result.url.trim() : "";
          if (!url) {
            return null;
          }

          const resultId = createStableResultId({
            query,
            url,
            index,
          });
          searchResults.set(resultId, {
            url,
            title: typeof result?.title === "string" ? result.title : "",
            createdAt: Date.now(),
            expiresAt: Date.now() + ttlMs,
          });

          return {
            result_id: resultId,
            url,
            title: typeof result?.title === "string" ? result.title : "",
            snippet: typeof result?.snippet === "string" ? result.snippet : "",
          };
        })
      : [];

    return mappedResults.filter(Boolean);
  }

  function resolveResultUrl(resultId) {
    if (typeof resultId !== "string" || !resultId.trim()) {
      return null;
    }

    pruneExpired();
    const lookup = searchResults.get(resultId);
    if (!lookup) {
      return null;
    }
    lookup.expiresAt = Date.now() + ttlMs;
    return lookup.url;
  }

  function putDocument({ url, title, text, metadata, source, logger: requestLogger }) {
    const operationLogger = requestLogger || cacheLogger;
    pruneExpired();

    const normalizedText = normalizeDocumentText(text);
    const rawBytes = Buffer.byteLength(normalizedText, "utf8");
    const truncatedText = truncateToUtf8Bytes(normalizedText, maxDocumentBytes);
    const truncatedBytes = Buffer.byteLength(truncatedText, "utf8");
    const wasTruncated = rawBytes > truncatedBytes;
    const now = Date.now();

    if (wasTruncated) {
      operationLogger.debug(
        {
          url: excerptText(url, 200),
          source,
          rawBytes,
          truncatedBytes,
          maxDocumentBytes,
        },
        "Document content exceeded cache size limit and was truncated"
      );
    }

    const documentId = `doc_${randomUUID()}`;
    const entry = {
      documentId,
      url,
      title: typeof title === "string" ? title : "",
      text: truncatedText,
      source: source || null,
      metadata: metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {},
      createdAt: now,
      lastAccessedAt: now,
      expiresAt: now + ttlMs,
    };

    documents.set(documentId, entry);
    evictOverflow();

    return {
      documentId,
      textLength: textLength(truncatedText),
      storedBytes: truncatedBytes,
      truncated: wasTruncated,
    };
  }

  function getDocument(documentId) {
    if (typeof documentId !== "string" || !documentId.trim()) {
      throw invalidDocumentIdError();
    }

    pruneExpired();
    const entry = documents.get(documentId);
    if (!entry) {
      throw new AppError({
        statusCode: 400,
        code: "document_not_found",
        type: "invalid_request_error",
        message: "document_id is not found or has expired.",
      });
    }

    entry.lastAccessedAt = Date.now();
    entry.expiresAt = Date.now() + ttlMs;
    return entry;
  }

  function readChunk({ documentId, offset, maxTokens, logger: requestLogger }) {
    const operationLogger = requestLogger || cacheLogger;
    const entry = getDocument(documentId);
    const safeOffset = Number.isInteger(offset) && offset >= 0 ? offset : 0;
    const boundedOffset = Math.min(safeOffset, entry.text.length);
    const chunkChars = tokenBudgetToChunkChars(maxTokens);
    const chunk = entry.text.slice(boundedOffset, boundedOffset + chunkChars);
    const nextOffset = boundedOffset + chunk.length;
    const hasMore = nextOffset < entry.text.length;

    operationLogger.debug(
      {
        documentId,
        offset: boundedOffset,
        maxTokens,
        chunkChars,
        chunkLength: chunk.length,
        totalLength: entry.text.length,
        hasMore,
      },
      "Read document chunk from cache"
    );

    return {
      document_id: documentId,
      offset: boundedOffset,
      max_tokens: maxTokens,
      text: chunk,
      next_offset: hasMore ? nextOffset : null,
      has_more: hasMore,
      total_length: entry.text.length,
      source_url: entry.url,
    };
  }

  function findPassages({ documentId, query, logger: requestLogger }) {
    const operationLogger = requestLogger || cacheLogger;
    const entry = getDocument(documentId);
    const normalizedQuery = typeof query === "string" ? query.trim().toLowerCase() : "";
    if (!normalizedQuery) {
      throw new AppError({
        statusCode: 400,
        code: "invalid_tool_arguments",
        type: "invalid_request_error",
        message: "query must be a non-empty string.",
      });
    }

    const lowerText = entry.text.toLowerCase();
    const matches = [];
    const maxMatches = 5;
    const maxScannedMatches = 20;
    let cursor = 0;
    let scanned = 0;

    while (cursor < lowerText.length && scanned < maxScannedMatches && matches.length < maxMatches) {
      const foundAt = lowerText.indexOf(normalizedQuery, cursor);
      if (foundAt === -1) {
        break;
      }

      const start = Math.max(0, foundAt - 220);
      const end = Math.min(entry.text.length, foundAt + normalizedQuery.length + 380);
      const snippet = entry.text.slice(start, end).trim();
      matches.push({
        offset: start,
        excerpt: addEllipses(snippet, start > 0, end < entry.text.length),
      });

      cursor = foundAt + normalizedQuery.length;
      scanned += 1;
    }

    if (matches.length === 0) {
      const fallback = entry.text.slice(0, 500).trim();
      if (fallback) {
        matches.push({
          offset: 0,
          excerpt: addEllipses(fallback, false, entry.text.length > fallback.length),
        });
      }
    }

    const hasMoreMatches =
      matches.length > 0 && lowerText.indexOf(normalizedQuery, cursor) !== -1;
    if (hasMoreMatches) {
      operationLogger.debug(
        {
          documentId,
          query: excerptText(query),
          returnedMatches: matches.length,
          maxMatches,
        },
        "find_in_document truncated additional matches beyond response limit"
      );
    }

    return {
      document_id: documentId,
      query,
      match_count: matches.length,
      truncated: hasMoreMatches,
      matches,
      total_length: entry.text.length,
      source_url: entry.url,
    };
  }

  function pruneExpired() {
    const now = Date.now();
    for (const [documentId, entry] of documents.entries()) {
      if (entry.expiresAt <= now) {
        documents.delete(documentId);
      }
    }
    for (const [resultId, entry] of searchResults.entries()) {
      if (entry.expiresAt <= now) {
        searchResults.delete(resultId);
      }
    }
  }

  function evictOverflow() {
    while (documents.size > maxDocuments) {
      const oldest = Array.from(documents.entries()).sort(
        (a, b) => a[1].lastAccessedAt - b[1].lastAccessedAt
      )[0];
      if (!oldest) {
        return;
      }
      documents.delete(oldest[0]);
    }
  }

  return {
    putSearchResults,
    resolveResultUrl,
    putDocument,
    getDocument,
    readChunk,
    findPassages,
  };
}

function createStableResultId({ query, url, index }) {
  const queryValue = typeof query === "string" ? query.trim().toLowerCase() : "";
  const seed = `${queryValue}|${url}|${index}`;
  return `sr_${createHash("sha256").update(seed).digest("hex").slice(0, 16)}`;
}

function normalizeDocumentText(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.replace(/\s+/g, " ").trim();
}

function truncateToUtf8Bytes(value, maxBytes) {
  const input = String(value || "");
  if (Buffer.byteLength(input, "utf8") <= maxBytes) {
    return input;
  }

  const suffix = " ...[truncated]";
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  if (maxBytes <= suffixBytes) {
    return truncateUtf8WithoutSuffix(input, maxBytes);
  }

  const prefix = truncateUtf8WithoutSuffix(input, maxBytes - suffixBytes);
  return `${prefix}${suffix}`;
}

function truncateUtf8WithoutSuffix(input, maxBytes) {
  if (Buffer.byteLength(input, "utf8") <= maxBytes) {
    return input;
  }

  let low = 0;
  let high = input.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = input.slice(0, mid);
    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return input.slice(0, low);
}

function tokenBudgetToChunkChars(maxTokens) {
  if (maxTokens >= 16_384) {
    return 5_000;
  }
  if (maxTokens >= 8_192) {
    return 3_000;
  }
  return 1_200;
}

function addEllipses(value, prefix, suffix) {
  const safe = value.trim();
  if (!safe) {
    return "";
  }
  if (prefix && suffix) {
    return `...${safe}...`;
  }
  if (prefix) {
    return `...${safe}`;
  }
  if (suffix) {
    return `${safe}...`;
  }
  return safe;
}

function invalidDocumentIdError() {
  return new AppError({
    statusCode: 400,
    code: "invalid_tool_arguments",
    type: "invalid_request_error",
    message: "document_id must be a non-empty string.",
  });
}

export { createDocumentCache };
