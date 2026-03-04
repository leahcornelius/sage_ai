import pino from "pino";

/**
 * Creates the shared application logger. Pino is also passed directly into
 * Fastify so request logs and service logs share the same output format.
 */
function createLogger(config) {
  const targets = [
    config.logging.pretty
      ? {
          target: "pino-pretty",
          level: config.logging.consoleLevel,
          options: {
            colorize: true,
            translateTime: "SYS:standard",
            ignore: "pid,hostname",
          },
        }
      : {
          target: "pino/file",
          level: config.logging.consoleLevel,
          options: {
            destination: 1,
          },
        },
  ];

  if (config.logging.fileEnabled) {
    targets.push({
      target: "pino/file",
      level: config.logging.fileLevel,
      options: {
        destination: config.logging.filePath,
        mkdir: true,
        append: true,
      },
    });
  }

  const transport = pino.transport({ targets });

  return pino(
    {
      level: resolveBaseLogLevel(config.logging),
      redact: {
        paths: [
          "req.headers.authorization",
          "req.body.messages",
          "authorization",
          "openai.apiKey",
          "auth.apiKey",
          "openaiApiKey",
          "sageApiKey",
          "debug.requestBody",
          "debug.messages",
        ],
        censor: "[Redacted]",
      },
    },
    transport
  );
}

function resolveBaseLogLevel(loggingConfig) {
  const levelWeights = {
    trace: 10,
    debug: 20,
    info: 30,
    warn: 40,
    error: 50,
    fatal: 60,
    silent: 70,
  };

  const levels = [loggingConfig.consoleLevel];
  if (loggingConfig.fileEnabled) {
    levels.push(loggingConfig.fileLevel);
  }

  if (levels.every((level) => level === "silent")) {
    return "silent";
  }

  return levels
    .filter((level) => level !== "silent")
    .sort((a, b) => levelWeights[a] - levelWeights[b])[0];
}

export { createLogger };
