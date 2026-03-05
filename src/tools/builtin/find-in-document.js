import { AppError } from "../../errors/app-error.js";

const findInDocumentTool = {
  type: "function",
  function: {
    name: "find_in_document",
    description:
      "Find relevant passages within a cached document and return excerpt offsets for targeted chunk reads.",
    parameters: {
      type: "object",
      properties: {
        document_id: {
          type: "string",
          description: "Document handle returned by get_url_content.",
        },
        query: {
          type: "string",
          description: "Search term or phrase to locate in the document.",
        },
      },
      required: ["document_id", "query"],
      additionalProperties: false,
    },
  },
};

function createFindInDocumentHandler({ documentCache }) {
  return async function handleFindInDocument({ args, logger }) {
    const documentId = typeof args.document_id === "string" ? args.document_id.trim() : "";
    const query = typeof args.query === "string" ? args.query.trim() : "";

    if (!documentId) {
      throw new AppError({
        statusCode: 400,
        code: "invalid_tool_arguments",
        type: "invalid_request_error",
        message: "document_id must be a non-empty string.",
      });
    }

    if (!query) {
      throw new AppError({
        statusCode: 400,
        code: "invalid_tool_arguments",
        type: "invalid_request_error",
        message: "query must be a non-empty string.",
      });
    }

    return documentCache.findPassages({
      documentId,
      query,
      logger,
    });
  };
}

export { findInDocumentTool, createFindInDocumentHandler };
