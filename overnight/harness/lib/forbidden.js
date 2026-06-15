// The mnemosy-ai layer silently refuses to store any text matching this regex
// and swallows the error (SETUP_STATUS #2). Therefore NO generated text may
// contain any of these anywhere. Validate everything before population and fail
// closed if anything matches.
const FORBIDDEN_REGEX = /secret|password|token|api ?key|card|ssn/i;

function isForbidden(value) {
  return FORBIDDEN_REGEX.test(String(value == null ? "" : value));
}

// Walk an arbitrary object/array/string tree and collect every offending string.
function collectForbidden(node, path = "$", out = []) {
  if (node == null) {
    return out;
  }
  if (typeof node === "string") {
    if (isForbidden(node)) {
      out.push({ path, value: node });
    }
    return out;
  }
  if (Array.isArray(node)) {
    node.forEach((item, i) => collectForbidden(item, `${path}[${i}]`, out));
    return out;
  }
  if (typeof node === "object") {
    for (const [key, val] of Object.entries(node)) {
      // keys themselves are static labels, but validate values (and keys, cheaply)
      if (isForbidden(key)) {
        out.push({ path: `${path}.${key} (key)`, value: key });
      }
      collectForbidden(val, `${path}.${key}`, out);
    }
  }
  return out;
}

// Throws with a clear message if anything in the tree matches. Fail-before-population.
function assertNoForbidden(tree, label = "dataset") {
  const hits = collectForbidden(tree);
  if (hits.length > 0) {
    // Redact the matched value: echoing it into the thrown error would leak the very
    // sensitive text we are refusing into logs/telemetry. The path locates the hit.
    const sample = hits
      .slice(0, 8)
      .map((h) => `${h.path} => [redacted]`)
      .join("\n  ");
    throw new Error(
      `Forbidden-word validation FAILED for ${label}: ${hits.length} match(es) of /secret|password|token|api ?key|card|ssn/i:\n  ${sample}`
    );
  }
}

export { FORBIDDEN_REGEX, isForbidden, collectForbidden, assertNoForbidden };
