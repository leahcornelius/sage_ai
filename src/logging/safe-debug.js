const DEFAULT_EXCERPT_LENGTH = 200;

function excerptText(value, maxLength = DEFAULT_EXCERPT_LENGTH) {
  if (typeof value !== "string") {
    return "";
  }

  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }

  return `${compact.slice(0, maxLength)}...`;
}

function textLength(value) {
  return typeof value === "string" ? value.length : 0;
}

function roleSequence(messages) {
  if (!Array.isArray(messages)) {
    return [];
  }

  return messages
    .map((message) => (typeof message?.role === "string" ? message.role : "unknown"))
    .slice(0, 50);
}

function objectKeys(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  return Object.keys(value);
}

export { excerptText, textLength, roleSequence, objectKeys };
