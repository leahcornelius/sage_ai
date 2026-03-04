/**
 * Application errors are normalized into this shape so routes can always emit
 * OpenAI-compatible error payloads without guessing at status codes.
 */
class AppError extends Error {
  constructor({
    statusCode = 500,
    code = "internal_error",
    type = "server_error",
    message = "Internal server error.",
    param = null,
    details = null,
    cause = undefined,
  } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.type = type;
    this.param = param;
    this.details = details;
  }
}

function isAppError(error) {
  return error instanceof AppError;
}

export { AppError, isAppError };
