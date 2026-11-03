import { describe, expect, it } from "vitest";
import { commandRequest, parseMessage } from "./protocol.ts";
import { RequestQueue, TimeoutError } from "./queue.ts";
import { toCommandResult } from "./server.ts";

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

describe("/connect protocol", () => {
  it("round-trips a command request id and maps a response with a negative status but valid output", () => {
    const req = commandRequest("/option get websockets_enabled");
    const text = JSON.stringify({
      header: { version: 17104896, requestId: req.header.requestId, messagePurpose: "commandResponse" },
      body: { statusCode: -2147352576, statusMessage: "websockets_enabled is: true" },
    });
    const msg = parseMessage(text);
    expect(msg?.header.requestId).toBe(req.header.requestId);
    const r = toCommandResult(msg!);
    expect(r.statusMessage).toBe("websockets_enabled is: true");
    expect(r.statusCode).toBe(-2147352576);
  });

  it("rejects non-messages", () => {
    expect(parseMessage("not json")).toBeUndefined();
    expect(parseMessage(JSON.stringify({ body: {} }))).toBeUndefined();
  });
});
