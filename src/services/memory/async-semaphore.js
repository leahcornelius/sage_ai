class AsyncSemaphore {
  constructor(limit) {
    this.limit = Number.isInteger(limit) && limit > 0 ? limit : 1;
    this.inFlight = 0;
    this.waiters = [];
  }

  async acquire() {
    if (this.inFlight < this.limit) {
      this.inFlight += 1;
      return;
    }

    await new Promise((resolve) => {
      this.waiters.push(resolve);
    });
    this.inFlight += 1;
  }

  release() {
    if (this.inFlight > 0) {
      this.inFlight -= 1;
    }

    const waiter = this.waiters.shift();
    if (waiter) {
      waiter();
    }
  }
}

export { AsyncSemaphore };
