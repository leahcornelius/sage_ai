import { AppError } from "../../errors/app-error.js";
import { resolveMaxTokens } from "./brave-web.js";

const readDocumentChunkTool = {
  type: "function",
  function: {
    name: "read_document_chunk",
    description:
      "Read the next chunk of a cached document using document_id and a character offset.",
    parameters: {
      type: "object",
      properties: {
        document_id: {
          type: "string",
          description: "Document handle returned by get_url_content.",
        },
        offset: {
          type: "integer",
          description: "Character offset to read from.",
          minimum: 0,
        },
        max_tokens: {
          type: "integer",
          description: "Chunk size profile.",
          enum: [2048, 8192, 16384],
        },
      },
      required: ["document_id", "offset"],
      additionalProperties: false,
    },
  },
};

function createReadDocumentChunkHandler({ documentCache }) {
  return async function handleReadDocumentChunk({ args, logger }) {
    const documentId = typeof args.document_id === "string" ? args.document_id.trim() : "";
    if (!documentId) {
      throw new AppError({
        statusCode: 400,
        code: "invalid_tool_arguments",
        type: "invalid_request_error",
        message: "document_id must be a non-empty string.",
      });
    }

    const offset = Number.parseInt(args.offset, 10);
    if (!Number.isInteger(offset) || offset < 0) {
      throw new AppError({
        statusCode: 400,
        code: "invalid_tool_arguments",
        type: "invalid_request_error",
        message: "offset must be a non-negative integer.",
      });
    }

    const maxTokens = resolveMaxTokens(args.max_tokens);
    return documentCache.readChunk({
      documentId,
      offset,
      maxTokens,
      logger,
    });
  };
}

export { readDocumentChunkTool, createReadDocumentChunkHandler };
