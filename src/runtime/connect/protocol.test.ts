import { describe, expect, it } from "vitest";
import { commandRequest, parseMessage } from "./protocol.ts";
import { toCommandResult } from "./server.ts";

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
