import { describe, expect, it } from "vitest";
import { firewallCheck } from "./cli.ts";

describe("firewallCheck", () => {
  it("adds no check off Windows or when detection could not run", () => {
    expect(firewallCheck(undefined)).toBeUndefined();
  });

  it("is an optional check, ok when the rules are present", () => {
    expect(firewallCheck(true)).toMatchObject({ name: "firewall", level: "optional", ok: true, detail: "Windows Firewall rules for the Bedrock Dedicated Server are in place" });
    expect(firewallCheck(false)).toEqual({
      name: "firewall",
      level: "optional",
      ok: false,
      detail: "no Windows Firewall rules for the Bedrock Dedicated Server, Windows asks once for each server folder (bds-instances\\slot-0 and up)",
      fix: "sculk setup",
    });
  });
});
