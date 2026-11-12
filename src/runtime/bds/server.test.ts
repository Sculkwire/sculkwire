import { describe, expect, it } from "vitest";
import { LineSplitter, serverCommand } from "./server.ts";

describe("serverCommand", () => {
  it("line-buffers ./bedrock_server through stdbuf on Linux", () => {
    expect(serverCommand("/data/i1", "linux", "/usr/bin/stdbuf")).toEqual({
      command: "/usr/bin/stdbuf",
      args: ["-oL", "-eL", "./bedrock_server"],
      env: { LD_LIBRARY_PATH: "." },
    });
    expect(serverCommand("/data/i1", "linux")).toEqual({ command: "./bedrock_server", args: [], env: { LD_LIBRARY_PATH: "." } });
  });

  it("runs bedrock_server.exe by absolute path on Windows, without stdbuf or LD_LIBRARY_PATH", () => {
    expect(serverCommand("C:\\Users\\me\\AppData\\Local\\sculkwire\\bds-instances\\i1", "win32", "/usr/bin/stdbuf")).toEqual({
      command: "C:\\Users\\me\\AppData\\Local\\sculkwire\\bds-instances\\i1\\bedrock_server.exe",
      args: [],
      env: {},
    });
  });
});

describe("LineSplitter", () => {
  it("joins lines split across chunks, at CRLF and inside UTF-8 characters", () => {
    const bytes = Buffer.from("[INFO] Starting Server\r\n[INFO] Version: 1.26.63.1\r\n[INFO] Level Name: Café\r\n[INFO] Server started.\r\npartial");
    // Chunk sizes from 1 byte up: chunks end inside lines, between `\r` and `\n`, and inside the two-byte `é`.
    for (let size = 1; size <= 8; size++) {
      const s = new LineSplitter();
      const lines: string[] = [];
      for (let i = 0; i < bytes.length; i += size) lines.push(...s.push(bytes.subarray(i, i + size)));
      expect(lines).toEqual(["[INFO] Starting Server", "[INFO] Version: 1.26.63.1", "[INFO] Level Name: Café", "[INFO] Server started."]);
      expect(s.end()).toEqual(["partial"]);
      expect(s.end()).toEqual([]);
    }
  });

  it("ends a line on LF too and drops a trailing CR at the end of the stream", () => {
    const s = new LineSplitter();
    expect(s.push(Buffer.from("a\nb\r"))).toEqual(["a"]);
    expect(s.end()).toEqual(["b"]);
  });
});
