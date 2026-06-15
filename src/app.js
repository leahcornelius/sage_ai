import Fastify from "fastify";
import cors from "@fastify/cors";

import { coerceToAppError, toOpenAIErrorPayload } from "./errors/openai-error-response.js";
import { createAuthHook } from "./http/hooks/auth.js";
import { registerRequestLogging } from "./http/hooks/request-logging.js";
import { registerHealthRoutes } from "./http/routes/health.js";
import { registerModelRoutes } from "./http/routes/models.js";
import { registerChatCompletionRoutes } from "./http/routes/chat-completions.js";
import { registerAdminRoutes } from "./http/routes/admin.js";

/**
 * Builds the Fastify app with injected services so routes stay thin and tests
 * can substitute fake implementations without touching real network services.
 */
async function buildApp({ config, logger, services }) {
  const app = Fastify({
    loggerInstance: logger,
    disableRequestLogging: true,
  });

  app.decorate("sageConfig", config);
  app.decorate("sageServices", services);

  app.setErrorHandler(async (error, request, reply) => {
    const appError = coerceToAppError(error);

    if (reply.sent) {
      request.log.error({ err: error }, "Unhandled error after the response was already sent");
      return;
    }

    const logMethod = appError.statusCode >= 500 ? "error" : "warn";
    request.log[logMethod](
      {
        err: error,
        statusCode: appError.statusCode,
        code: appError.code,
      },
      "Request failed"
    );

    reply.status(appError.statusCode).send(toOpenAIErrorPayload(appError));
  });

  await registerRequestLogging(app);

  if (config.server.corsOrigin) {
    await app.register(cors, {
      origin: config.server.corsOrigin,
    });
  }

  await app.register(registerHealthRoutes);

  await app.register(
    async function registerV1Routes(v1) {
      v1.addHook("onRequest", createAuthHook(config));
      await v1.register(registerModelRoutes);
      await v1.register(registerChatCompletionRoutes);
    },
    { prefix: "/v1" }
  );

  // Guarded, localhost-only benchmark admin routes. Disabled by default; only the
  // dedicated overnight benchmark instance enables them (SAGE_ADMIN_ENABLED=true).
  if (config.admin?.enabled) {
    await app.register(registerAdminRoutes);
    logger.warn(
      { host: config.server.host },
      "SAGE_ADMIN_ENABLED=true: localhost-only /admin routes are registered (benchmark mode)"
    );
  }

  return app;
}

export { buildApp };
