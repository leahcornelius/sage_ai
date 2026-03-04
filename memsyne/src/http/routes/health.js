async function registerHealthRoutes(app) {
  app.get("/health", async () => ({ status: "ok" }));
}

export { registerHealthRoutes };
