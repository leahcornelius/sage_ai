import { AppError, isAppError } from "./app-error.js";

/**
 * Converts internal and upstream failures into OpenAI-style error payloads.
 */
function coerceToAppError(error) {
  if (isAppError(error)) {
    return error;
  }

  if (error?.name === "AbortError") {
    return new AppError({
      statusCode: 499,
      code: "client_aborted",
      type: "client_error",
      message: "The client closed the request before completion.",
      cause: error,
    });
  }

  const upstream = error?.error && typeof error.error === "object" ? error.error : error;
  const statusCode =
    Number.isInteger(error?.status) ? error.status : Number.isInteger(error?.statusCode) ? error.statusCode : null;

  if (statusCode) {
    return new AppError({
      statusCode,
      code: upstream?.code || error?.code || "upstream_error",
      type: upstream?.type || error?.type || (statusCode >= 500 ? "server_error" : "invalid_request_error"),
      message: upstream?.message || error?.message || "Upstream request failed.",
      param: upstream?.param || error?.param || null,
      details: upstream,
      cause: error,
    });
  }

  return new AppError({
    statusCode: 500,
    code: "internal_error",
    type: "server_error",
    message: error?.message || "Internal server error.",
    cause: error,
  });
}

function toOpenAIErrorPayload(error) {
  const appError = coerceToAppError(error);
  return {
    error: {
      message: appError.message,
      type: appError.type,
      param: appError.param,
      code: appError.code,
    },
  };
}

export { coerceToAppError, toOpenAIErrorPayload };
