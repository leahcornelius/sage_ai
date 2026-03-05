async function registerHealthRoutes(app) {
  app.get("/health", async (request) => {
    const memoryHealth = typeof app.sageServices.memoryService?.getSubsystemHealth === "function"
      ? await app.sageServices.memoryService.getSubsystemHealth({
        logger: request.log,
        requestId: request.id,
      })
      : {
        mem0: { status: "disabled" },
        zep: { status: "disabled" },
        redis: { status: "disabled" },
        mnemosyne: { status: "disabled" },
      };

    return {
      status: "ok",
      memory: memoryHealth,
    };
  });
}

export { registerHealthRoutes };
