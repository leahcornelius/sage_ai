class CircuitBreakerRegistry {
  constructor({
    failureThreshold = 5,
    windowMs = 60_000,
    cooldownMs = 30_000,
    now = () => Date.now(),
  } = {}) {
    this.failureThreshold = Number.isInteger(failureThreshold) && failureThreshold > 0 ? failureThreshold : 5;
    this.windowMs = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 60_000;
    this.cooldownMs = Number.isFinite(cooldownMs) && cooldownMs > 0 ? cooldownMs : 30_000;
    this.now = now;
    this.states = new Map();
  }

  getState(adapterName) {
    if (!this.states.has(adapterName)) {
      this.states.set(adapterName, {
        failures: 0,
        windowStartedAt: this.now(),
        openUntil: 0,
      });
    }
    return this.states.get(adapterName);
  }

  isOpen(adapterName) {
    const state = this.getState(adapterName);
    return state.openUntil > this.now();
  }

  markSuccess(adapterName) {
    const state = this.getState(adapterName);
    state.failures = 0;
    state.windowStartedAt = this.now();
    state.openUntil = 0;
  }

  markFailure(adapterName) {
    const state = this.getState(adapterName);
    const now = this.now();
    if (now - state.windowStartedAt > this.windowMs) {
      state.windowStartedAt = now;
      state.failures = 0;
    }

    state.failures += 1;
    if (state.failures >= this.failureThreshold) {
      state.openUntil = now + this.cooldownMs;
      state.failures = 0;
      state.windowStartedAt = now;
    }
  }
}

export { CircuitBreakerRegistry };
