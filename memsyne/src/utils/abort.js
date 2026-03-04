/**
 * Utilities for handling request lifetimes. Upstream OpenAI requests are wired
 * to abort only when the downstream client actually disconnects.
 */
function createAbortControllerFromRequest(request) {
  const controller = new AbortController();
  let completed = false;

  const abortWithReason = (message) => {
    if (!completed && !controller.signal.aborted) {
      controller.abort(new Error(message));
    }
  };

  const onAborted = () => {
    abortWithReason("Client disconnected.");
  };

  const onClose = () => {
    // IncomingMessage emits close after the request stream finishes as well,
    // so only treat it as a disconnect when Node marked the request aborted.
    if (request.raw.aborted) {
      abortWithReason("Client disconnected.");
    }
  };

  request.raw.once("aborted", onAborted);
  request.raw.once("close", onClose);

  return {
    signal: controller.signal,
    complete() {
      completed = true;
      request.raw.off("aborted", onAborted);
      request.raw.off("close", onClose);
    },
    abort() {
      abortWithReason("Request aborted.");
      this.complete();
    },
  };
}

export { createAbortControllerFromRequest };
