function printMemories(memories, query = null) {
  if (query) {
    console.log(`Recalled ${memories.length} memories for query: "${query}":`);
  } else {
    console.log(`Recalled ${memories.length} memories.`);
  }

  // Results are ranked by composite multi-signal score
  let entry;
  for (const mem of memories) {
    entry = mem.entry;
    console.log("----");
    console.log("[confidenceTag] (score) {importance} <priorityScore> text");
    console.log(`[${entry.confidenceTag}] (${mem.score.toFixed(2)}) {${entry.importance}} <${entry.priorityScore}> ${entry.text}`);
    console.log(`  Entry times: Ingested: ${new Date(entry.ingestedAt).toLocaleString()}, Created: ${new Date(entry.createdAt).toLocaleString()}, Updated: ${new Date(entry.updatedAt).toLocaleString()}`);
    console.log(`  Has ${entry.linkedMemories?.length || 0} linked memories & been accessed ${entry.accessCount} times.`);
    console.log(`  Scope is ${entry.scope}, domain is ${entry.domain}, mem type is ${entry.memoryType}`);
    // Example output:
    // [Grounded] (0.87) {0.7} <0.45> My name is Sage.

    if (entry.reasoningChain) {
      console.log(`  Reasoning: ${entry.reasoningChain}`);
      // Example reasoning chain:
      // Reasoning: My name is Sage. -> because -> user said
      // Reasoning: deployed service -> because -> config changed -> therefore -> restart needed
    }

    if (entry.graphContext?.length) {
      console.log(`  Graph context: ${entry.graphContext.join(", ")}`);
      // Example graph context:
      // Graph context: GitHub Actions, staging-server, port 443, Redis 7.2
    }
  }
}

export { printMemories };
