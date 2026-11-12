import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findStdbuf, LineSplitter, serverCommand } from "./server.ts";

describe("findStdbuf", () => {
  // findStdbuf runs on Linux only (Windows starts bedrock_server.exe without it) and always looks with Linux rules: a
  // `:`-separated PATH and the execute bit. A Windows host has neither (`C:\…` splits at the drive colon), as in which.test.ts.
  it.skipIf(process.platform === "win32")("takes an executable stdbuf on PATH first", () => {
    const dir = mkdtempSync(join(tmpdir(), "sculkwire-stdbuf-"));
    try {
      writeFileSync(join(dir, "stdbuf"), "");
      chmodSync(join(dir, "stdbuf"), 0o755);
      const seen: string[] = [];
      const exists = (path: string): boolean => (seen.push(path), true);
      expect(findStdbuf({ PATH: `/nonexistent:${dir}` }, exists)).toBe(join(dir, "stdbuf"));
      expect(seen).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to /usr/bin/stdbuf when that file exists, else none", () => {
    const seen: string[] = [];
    const exists = (path: string): boolean => (seen.push(path), true);
    expect(findStdbuf({ PATH: "" }, exists)).toBe("/usr/bin/stdbuf");
    expect(seen).toEqual(["/usr/bin/stdbuf"]);
    expect(findStdbuf({}, () => false)).toBeUndefined();
  });
});

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
