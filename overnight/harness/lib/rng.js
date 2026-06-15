// Deterministic, seeded RNG so the whole benchmark is reproducible.
// mulberry32 — small, fast, good enough for synthetic data generation.

function hashStringToInt(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(seedInt) {
  let a = seedInt >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Crockford-ish base32 without ambiguous I/L/O/U.
const MARKER_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

class Rng {
  constructor(seed) {
    this.seed = seed;
    this._next = mulberry32(typeof seed === "number" ? seed : hashStringToInt(String(seed)));
  }

  random() {
    return this._next();
  }

  // inclusive [min, max]
  int(min, max) {
    return min + Math.floor(this.random() * (max - min + 1));
  }

  choice(arr) {
    return arr[this.int(0, arr.length - 1)];
  }

  shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i -= 1) {
      const j = this.int(0, i);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // High-entropy marker code. `isForbidden` is injected to guarantee no
  // generated marker matches the forbidden-word regex (regenerate on match).
  marker(length, isForbidden) {
    for (let attempt = 0; attempt < 64; attempt += 1) {
      let code = "";
      for (let i = 0; i < length; i += 1) {
        code += MARKER_ALPHABET[this.int(0, MARKER_ALPHABET.length - 1)];
      }
      if (!isForbidden || !isForbidden(code)) {
        return code;
      }
    }
    throw new Error("marker(): exhausted attempts generating a clean marker code");
  }
}

export { Rng, hashStringToInt };
