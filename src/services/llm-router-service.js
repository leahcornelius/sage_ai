import {
  APIConnectionError,
  APIConnectionTimeoutError,
  InternalServerError,
  NotFoundError,
  AuthenticationError,
  PermissionDeniedError,
  BadRequestError,
  UnprocessableEntityError,
} from "openai/core/error";

function createLlmRouterService({
  localClient,
  cloudClient,
  config,
  logger,
}) {
  const routerLogger = logger.child({ service: "llm-router" });
  const warmupTimeoutMs = config.llm.localStreamWarmupMs;

  async function createChatCompletion(payload, { signal, logger: requestLogger, requestId } = {}) {
    const operationLogger = requestLogger || routerLogger;
    try {
      return await localClient.chat.completions.create(payload, { signal });
    } catch (error) {
      if (!isRetryableError(error)) {
        throw error;
      }
      operationLogger.warn(
        {
          err: error,
          requestId,
          llmFallbackUsed: true,
          stage: "non_stream",
        },
        "Local LLM call failed; retrying against cloud fallback"
      );
      return cloudClient.chat.completions.create(payload, { signal });
    }
  }

  async function streamChatCompletion(payload, { signal, logger: requestLogger, requestId } = {}) {
    const operationLogger = requestLogger || routerLogger;

    try {
      return await createPrimaryStream({
        client: localClient,
        payload,
        signal,
        warmupTimeoutMs,
        logger: operationLogger,
        requestId,
      });
    } catch (error) {
      if (!isRetryableError(error) || error?.streamStarted) {
        throw error;
      }

      operationLogger.warn(
        {
          err: error,
          requestId,
          llmFallbackUsed: true,
          stage: "stream",
        },
        "Primary stream failed before first chunk; switching to cloud fallback stream"
      );
      return cloudClient.chat.completions.create(
        {
          ...payload,
          stream: true,
        },
        { signal }
      );
    }
  }

  return {
    createChatCompletion,
    streamChatCompletion,
    isRetryableError,
  };
}

async function createPrimaryStream({
  client,
  payload,
  signal,
  warmupTimeoutMs,
}) {
  const stream = await client.chat.completions.create(
    {
      ...payload,
      stream: true,
    },
    { signal }
  );

  const iterator = stream[Symbol.asyncIterator]();
  const firstChunk = await nextWithTimeout(iterator, warmupTimeoutMs);
  if (firstChunk.done) {
    return {
      async *[Symbol.asyncIterator]() {},
    };
  }

  return {
    async *[Symbol.asyncIterator]() {
      yield firstChunk.value;
      while (true) {
        let nextResult;
        try {
          nextResult = await iterator.next();
        } catch (error) {
          error.streamStarted = true;
          throw error;
        }
        if (nextResult.done) {
          break;
        }
        yield nextResult.value;
      }
    },
  };
}

async function nextWithTimeout(iterator, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      iterator.next(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`Local stream warmup exceeded ${timeoutMs}ms`);
          error.name = "TimeoutError";
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function isRetryableError(error) {
  if (!error) {
    return false;
  }
  if (error instanceof APIConnectionError || error instanceof APIConnectionTimeoutError) {
    return true;
  }
  if (error instanceof InternalServerError) {
    return true;
  }

  if (
    error instanceof BadRequestError
    || error instanceof NotFoundError
    || error instanceof AuthenticationError
    || error instanceof PermissionDeniedError
    || error instanceof UnprocessableEntityError
  ) {
    return false;
  }

  const status = Number(error?.status);
  if (Number.isInteger(status)) {
    if (status >= 500) {
      return true;
    }
    if ([400, 401, 403, 404, 422].includes(status)) {
      return false;
    }
  }

  return false;
}

export { createLlmRouterService, isRetryableError };
