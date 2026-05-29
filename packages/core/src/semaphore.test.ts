import { describe, it, expect } from "vitest";
import { createSemaphore } from "./semaphore.js";

describe("semaphore", () => {
  it("never lets more than `limit` holders run at once", async () => {
    const sem = createSemaphore(2);
    let active = 0;
    let peak = 0;
    const task = async () => {
      const release = await sem.acquire();
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      release();
    };
    await Promise.all(Array.from({ length: 10 }, task));
    expect(peak).toBe(2);
  });
});
