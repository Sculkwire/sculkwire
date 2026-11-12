import { describe, expect, it } from "vitest";
import { belongsToInstall, chordKeys, encodeCommand, parseHelperLine, parseProcessList, virtualKey } from "./windows.ts";

describe("Windows helpers", () => {
  it("reads pid and path per game process, including processes without a path", () => {
    const text = "4120\tC:\\XboxGames\\Minecraft for Windows\\Content\\Minecraft.Windows.exe\r\n5032\t\r\n";
    expect(parseProcessList(text)).toEqual([
      { pid: 4120, path: "C:\\XboxGames\\Minecraft for Windows\\Content\\Minecraft.Windows.exe" },
      { pid: 5032, path: "" },
    ]);
  });

  it("tells Stable and Preview apart by path, so the other edition is never managed", () => {
    const stable = "C:\\XboxGames\\Minecraft for Windows\\Content\\Minecraft.Windows.exe";
    const preview = "C:\\XboxGames\\Minecraft Preview for Windows\\Content\\Minecraft.Windows.exe";
    const stableInstall = { gameDir: "C:\\XboxGames\\Minecraft for Windows\\Content", preview: false };
    expect(belongsToInstall(stable, stableInstall)).toBe(true);
    expect(belongsToInstall(preview, stableInstall)).toBe(false);
    expect(belongsToInstall(preview, { preview: true })).toBe(true);
    expect(belongsToInstall(stable, { preview: true })).toBe(false);
  });

  it("maps xdotool key names to virtual keys, case-insensitively, and names the valid keys for an unknown one", () => {
    expect(virtualKey("w")).toBe(0x57);
    expect(virtualKey("W")).toBe(0x57);
    expect(virtualKey("7")).toBe(0x37);
    expect(virtualKey("slash")).toBe(0xbf);
    expect(virtualKey("/")).toBe(0xbf);
    expect(virtualKey("escape")).toBe(0x1b);
    expect(virtualKey("F12")).toBe(0x7b);
    expect(virtualKey("F24")).toBe(0x87);
    expect(virtualKey("KP_5")).toBe(0x65);
    expect(virtualKey("KP_Enter")).toBe(0x10d);
    expect(() => virtualKey("Hyper_L")).toThrow(/unknown key 'Hyper_L'. Valid keys: Return, .*Escape.*a-z, 0-9, F1-F24/);
    expect(() => virtualKey("F25")).toThrow(/unknown key/);
  });

  it("maps every key the player controller holds", () => {
    for (const k of ["w", "a", "s", "d", "space", "Shift_L", "Control_L", "1", "9"]) expect(() => virtualKey(k)).not.toThrow();
    expect([virtualKey("Shift_L"), virtualKey("Control_L"), virtualKey("space")]).toEqual([0xa0, 0xa2, 0x20]);
  });

  it("splits chords into keys pressed in order", () => {
    expect(chordKeys("ctrl+a")).toEqual([0xa2, 0x41]);
    expect(chordKeys("ctrl+shift+Tab")).toEqual([0xa2, 0xa0, 0x09]);
    expect(chordKeys("Return")).toEqual([0x0d]);
    expect(() => chordKeys("ctrl+")).toThrow(/malformed key chord/);
    expect(() => chordKeys("ctrl+nope")).toThrow(/unknown key 'nope'/);
  });

  it("encodes helper requests one per line, with text as base64 UTF-8", () => {
    expect(encodeCommand(1, { verb: "probe" })).toBe("1 probe");
    expect(encodeCommand(2, { verb: "down", key: 0x57 })).toBe("2 down 87");
    expect(encodeCommand(3, { verb: "bup", button: 3 })).toBe("3 bup 3");
    expect(encodeCommand(4, { verb: "move", x: -12.6, y: 4.2 })).toBe("4 move -13 4");
    expect(encodeCommand(5, { verb: "at", x: 640, y: 360 })).toBe("5 at 640 360");
    const text = encodeCommand(6, { verb: "text", text: "héllo\n/connect ✓" });
    expect(text).not.toMatch(/\n/);
    expect(Buffer.from(text.split(" ")[2] ?? "", "base64").toString("utf8")).toBe("héllo\n/connect ✓");
  });

  it("parses helper answers and foreground reports, ignoring other output", () => {
    expect(parseHelperLine("7 ok\r")).toEqual({ kind: "reply", id: 7, status: "ok" });
    expect(parseHelperLine("8 blocked")).toEqual({ kind: "reply", id: 8, status: "blocked" });
    expect(parseHelperLine("9 err the game window was not found")).toEqual({ kind: "error", id: 9, message: "the game window was not found" });
    expect(parseHelperLine("fg 0")).toEqual({ kind: "foreground", foreground: false });
    expect(parseHelperLine("fg 1")).toEqual({ kind: "foreground", foreground: true });
    expect(parseHelperLine("WARNING: something")).toBeUndefined();
  });
});
