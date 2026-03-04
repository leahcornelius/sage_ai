import { timingSafeEqual } from "node:crypto";

import { AppError } from "../errors/app-error.js";

function extractBearerToken(headerValue) {
  if (typeof headerValue !== "string") {
    return null;
  }

  const [scheme, token] = headerValue.split(" ");
  if (!scheme || scheme.toLowerCase() !== "bearer" || !token) {
    return null;
  }

  return token.trim() || null;
}

function authenticateBearerToken(headerValue, expectedToken) {
  const token = extractBearerToken(headerValue);
  if (!token || !secureEquals(token, expectedToken)) {
    throw new AppError({
      statusCode: 401,
      code: "invalid_api_key",
      type: "invalid_request_error",
      message: "Invalid API key provided.",
    });
  }

  return token;
}

function secureEquals(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

export { authenticateBearerToken, extractBearerToken };
