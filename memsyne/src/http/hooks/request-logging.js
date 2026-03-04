/**
 * Logs a concise request summary after every response rather than dumping raw
 * request bodies into the logs.
 */
async function registerRequestLogging(app) {
  app.addHook("onRequest", async (request) => {
    request.sageStartedAt = process.hrtime.bigint();
    const streamRequested =
      request.body && typeof request.body === "object" && !Array.isArray(request.body)
        ? request.body.stream === true
        : undefined;

    request.log.debug(
      {
        route: request.routeOptions?.url || request.url,
        method: request.method,
        requestId: request.id,
        ip: request.ip,
        contentType: request.headers["content-type"],
        contentLength: request.headers["content-length"],
        streamRequested,
      },
      "Request received"
    );
  });

  app.addHook("onResponse", async (request, reply) => {
    const startedAt = request.sageStartedAt || process.hrtime.bigint();
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

    request.log.info(
      {
        route: request.routeOptions?.url || request.url,
        method: request.method,
        statusCode: reply.statusCode,
        durationMs: Number(durationMs.toFixed(2)),
      },
      "Request completed"
    );

    request.log.debug(
      {
        route: request.routeOptions?.url || request.url,
        method: request.method,
        statusCode: reply.statusCode,
        durationMs: Number(durationMs.toFixed(2)),
        aborted: Boolean(request.raw.aborted),
        responseContentType: reply.getHeader("content-type"),
      },
      "Request response details"
    );
  });
}

export { registerRequestLogging };
