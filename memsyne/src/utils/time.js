function toUnixSeconds(value, fallback = 0) {
  if (Number.isInteger(value)) {
    return value;
  }

  const parsed = Date.parse(value);
  if (!Number.isNaN(parsed)) {
    return Math.floor(parsed / 1000);
  }

  return fallback;
}

export { toUnixSeconds };
