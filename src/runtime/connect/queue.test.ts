import { describe, expect, it } from "vitest";
import { RequestQueue, TimeoutError } from "./queue.ts";

/** Requests register after an await; let them settle in. */
const tick = () => new Promise<void>((r) => setImmediate(r));

describe("RequestQueue", () => {
  it("holds requests beyond the in-flight cap until a slot frees, in order", async () => {
    const q = new RequestQueue<string>(2);
    const sent: string[] = [];
    const results = ["a", "b", "c"].map((id) => q.request(id, () => sent.push(id), 5_000));
    await tick();
    expect(sent).toEqual(["a", "b"]);
    expect(q.waiting).toBe(1);
    q.settle("a", "A");
    await expect(results[0]).resolves.toBe("A");
    await tick();
    expect(sent).toEqual(["a", "b", "c"]);
    q.settle("c", "C");
    q.settle("b", "B");
    await expect(Promise.all(results)).resolves.toEqual(["A", "B", "C"]);
    expect(q.inFlight).toBe(0);
  });

  it("times out an unanswered request and frees its slot", async () => {
    const q = new RequestQueue<string>(1);
    const first = q.request("x", () => {}, 20, "cmd");
    await expect(first).rejects.toBeInstanceOf(TimeoutError);
    const second = q.request("y", () => {}, 1_000);
    await tick();
    expect(q.settle("y", "ok")).toBe(true);
    await expect(second).resolves.toBe("ok");
    expect(q.settle("x", "late")).toBe(false);
  });

  it("close rejects pending and waiting requests and every later one", async () => {
    const q = new RequestQueue<string>(1);
    const a = q.request("a", () => {}, 5_000);
    const b = q.request("b", () => {}, 5_000);
    q.close(new Error("gone"));
    await expect(a).rejects.toThrow("gone");
    await expect(b).rejects.toThrow("gone");
    await expect(q.request("c", () => {}, 5_000)).rejects.toThrow("gone");
  });
});
