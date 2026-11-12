import { win32 } from "node:path";
import { describe, expect, it } from "vitest";
import type { RunResult } from "../../core/process.ts";
import {
  addRuleArgs,
  applyRulesScript,
  DELETE_RULES_ARGS,
  elevateScript,
  encodePowerShell,
  ensureFirewallRules,
  FIREWALL_SLOTS,
  firewallPrograms,
  firewallRules,
  firewallRulesPresent,
  powerShellArgs,
  psLiteral,
  rulesPresent,
  showRulesScript,
  splitPrograms,
} from "./firewall.ts";

const DATA = "C:\\Users\\me\\O'Brien Test\\AppData\\Local\\sculkwire";
const slot = (n: number) => win32.join(DATA, "bds-instances", `slot-${n}`);
const programs = firewallPrograms(slot);

/** Every single-quoted PowerShell literal in a script, unescaped. */
function literals(script: string): string[] {
  return [...script.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1]!.replaceAll("''", "'"));
}

function decode(base64: string): string {
  return Buffer.from(base64, "base64").toString("utf16le");
}

/** `netsh show rule ... verbose` output in another language: only the paths are stable. */
function showOutput(paths: readonly string[]): string {
  return paths
    .map((p) => `\r\nRegelname:                            sculkwire BDS\r\n----------------------------------------------------------------------\r\nAktiviert:                            Ja\r\nRichtung:                             Eingehend\r\nProgramm:                             ${p}\r\nAktion:                               Zulassen\r\n`)
    .join("")
    .concat("Ok.\r\n");
}

function result(code: number | null, stdout = "", stderr = ""): RunResult {
  return { code, stdout, stderr, output: stdout + stderr, timedOut: false };
}

describe("firewallPrograms", () => {
  it("lists the server executable of slots 0 to 3", () => {
    expect(FIREWALL_SLOTS).toBe(4);
    expect(programs).toEqual([0, 1, 2, 3].map((n) => `${DATA}\\bds-instances\\slot-${n}\\bedrock_server.exe`));
  });
});

describe("firewallRules", () => {
  it("allows private and domain networks and blocks public ones, per executable", () => {
    const rules = firewallRules(programs);
    expect(rules).toHaveLength(8);
    for (const program of programs) {
      expect(rules.filter((r) => r.program === program)).toEqual([
        { program, action: "allow", profile: "private,domain" },
        { program, action: "block", profile: "public" },
      ]);
    }
  });

  it("builds the netsh add command with the quoted path", () => {
    expect(addRuleArgs({ program: programs[0]!, action: "block", profile: "public" })).toBe(
      `advfirewall firewall add rule name="sculkwire BDS" dir=in enable=yes action=block profile=public program="${programs[0]}"`,
    );
    expect(() => addRuleArgs({ program: 'C:\\a"b\\bedrock_server.exe', action: "allow", profile: "public" })).toThrow();
  });
});

describe("psLiteral", () => {
  it("doubles straight and typographic single quotes", () => {
    expect(psLiteral("O'Brien")).toBe("'O''Brien'");
    expect(psLiteral("O\u2019Brien")).toBe("'O\u2019\u2019Brien'");
    expect(psLiteral("plain path")).toBe("'plain path'");
  });
});

describe("splitPrograms", () => {
  const rebuild = ({ prefix, suffix, middles }: ReturnType<typeof splitPrograms>) => middles.map((m) => prefix + m + suffix);

  it("rebuilds every program from the common prefix, its middle and the common suffix", () => {
    const split = splitPrograms(programs);
    expect(split.prefix).toBe(`${DATA}\\bds-instances\\slot-`);
    expect(split.suffix).toBe("\\bedrock_server.exe");
    expect(split.middles).toEqual(["0", "1", "2", "3"]);
    expect(rebuild(split)).toEqual(programs);
  });

  it("works without a common suffix and for a single program", () => {
    const list = ["C:\\a\\x.exe", "C:\\a\\b\\y.dll"];
    expect(splitPrograms(list).suffix).toBe("");
    expect(rebuild(splitPrograms(list))).toEqual(list);
    expect(rebuild(splitPrograms([programs[0]!]))).toEqual([programs[0]]);
  });
});

describe("applyRulesScript", () => {
  const script = applyRulesScript(firewallRules(programs));

  it("deletes the old rules by name first, then loops over each action and profile group", () => {
    const lines = script.split("\n");
    const deleteLine = lines.findIndex((l) => l.includes(psLiteral(DELETE_RULES_ARGS)));
    const loops = lines.filter((l) => l.startsWith("foreach("));
    expect(deleteLine).toBeGreaterThan(-1);
    expect(lines.findIndex((l) => l.startsWith("foreach("))).toBeGreaterThan(deleteLine);
    expect(loops).toHaveLength(2);
    expect(loops[0]).toContain("'allow profile=private,domain program=\"'+$p+$m+$s+'\"'");
    expect(loops[1]).toContain("'block profile=public program=\"'+$p+$m+$s+'\"'");
    for (const loop of loops) expect(loop).toContain("@('0','1','2','3')");
    expect(script).toContain(`$h=${psLiteral('advfirewall firewall add rule name="sculkwire BDS" dir=in enable=yes action=')}`);
    expect(script).toContain("Start-Process netsh -ArgumentList $a -NoNewWindow -Wait -PassThru");
    expect(script.endsWith("exit $f")).toBe(true);
  });

  it("writes the path prefix once, with its apostrophe doubled", () => {
    const prefix = psLiteral(`${DATA}\\bds-instances\\slot-`);
    expect(prefix).toContain("O''Brien Test");
    expect(script.split(prefix)).toHaveLength(2);
    expect(decode(powerShellArgs(script).at(-1)!)).toContain(`$p=${prefix}`);
  });

  it("stays within the ShellExecute parameter limit for a long data dir", () => {
    const longData = `C:\\Users\\me\\O'Brien Test\\AppData\\Local\\sculkwire\\data\\${"nested folder\\".repeat(10)}`.slice(0, 120);
    expect(longData).toHaveLength(120);
    const long = firewallPrograms((n) => win32.join(longData, "bds-instances", `slot-${n}`));
    expect(powerShellArgs(applyRulesScript(firewallRules(long))).join(" ").length).toBeLessThan(2000);
  });
});

describe("showRulesScript", () => {
  it("shows sculkwire's rules verbosely", () => {
    expect(literals(showRulesScript())).toContain('advfirewall firewall show rule name="sculkwire BDS" verbose');
  });
});

describe("elevation", () => {
  it("encodes scripts as base64 UTF-16LE", () => {
    expect(encodePowerShell("O\u2019Brien")).toBe(Buffer.from("O\u2019Brien", "utf16le").toString("base64"));
    const args = powerShellArgs("exit 0");
    expect(args.slice(0, -1)).toEqual(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"]);
    expect(decode(args.at(-1)!)).toBe("exit 0");
  });

  it("runs the rules script elevated through -EncodedCommand, hidden, waiting for it", () => {
    const apply = applyRulesScript(firewallRules(programs));
    const outer = elevateScript(apply);
    expect(outer).toContain("Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList");
    const argumentList = literals(outer).find((l) => l.includes("-EncodedCommand"))!;
    expect(decode(argumentList.split(" ").at(-1)!)).toBe(apply);
    // The outer script is itself passed encoded and must fit a Windows command line.
    expect(powerShellArgs(outer).join(" ").length).toBeLessThan(32_000);
  });
});

describe("rulesPresent", () => {
  it("is true only when every executable path appears, ignoring case and localized labels", () => {
    expect(rulesPresent(showOutput(programs), programs)).toBe(true);
    expect(rulesPresent(showOutput(programs.map((p) => p.toUpperCase())), programs)).toBe(true);
    expect(rulesPresent(showOutput(programs.slice(0, 3)), programs)).toBe(false);
    expect(rulesPresent("Es wurden keine Regeln gefunden, die den angegebenen Kriterien entsprechen.\r\n", programs)).toBe(false);
  });
});

describe("firewallRulesPresent", () => {
  const answer = (r: RunResult) => async () => r;

  it("is undefined off Windows and when detection cannot run", async () => {
    expect(await firewallRulesPresent({ platform: "linux", run: answer(result(0, showOutput(programs))), slot })).toBeUndefined();
    const missing = { ...result(null, "", "powershell.exe failed to start"), startError: new Error("ENOENT") };
    expect(await firewallRulesPresent({ platform: "win32", run: answer(missing), slot })).toBeUndefined();
    expect(await firewallRulesPresent({ platform: "win32", run: answer({ ...result(null), timedOut: true }), slot })).toBeUndefined();
    expect(await firewallRulesPresent({ platform: "win32", run: answer(result(1, "", "error")), slot })).toBeUndefined();
  });

  it("reads netsh's answer, including its failing exit when no rule matches", async () => {
    expect(await firewallRulesPresent({ platform: "win32", run: answer(result(0, showOutput(programs))), slot })).toBe(true);
    expect(await firewallRulesPresent({ platform: "win32", run: answer(result(1, "No rules match the specified criteria.\r\n")), slot })).toBe(false);
  });
});

describe("ensureFirewallRules", () => {
  /** A fake runner: answers by the decoded script, records the scripts it ran. */
  function fake(answers: { present: boolean[]; elevated: boolean; elevate?: RunResult; apply?: RunResult }) {
    const scripts: string[] = [];
    const run = async (command: string, args: readonly string[]) => {
      expect(command).toBe("powershell.exe");
      const script = decode(args.at(-1)!);
      scripts.push(script);
      if (script.includes("show rule")) return result(0, answers.present.shift() ? showOutput(programs) : "No rules match.\r\n");
      if (script.includes("IsInRole")) return result(answers.elevated ? 0 : 1);
      if (script.includes("-Verb RunAs")) return answers.elevate ?? result(0);
      return answers.apply ?? result(0);
    };
    return { run, scripts };
  }

  it("does nothing off Windows", async () => {
    const f = fake({ present: [], elevated: false });
    expect((await ensureFirewallRules({ platform: "linux", run: f.run, slot })).status).toBe("skipped");
    expect(f.scripts).toEqual([]);
  });

  it("asks nothing when the rules are present", async () => {
    const f = fake({ present: [true], elevated: false });
    let asked = false;
    expect(await ensureFirewallRules({ platform: "win32", run: f.run, slot, onElevate: () => (asked = true) })).toEqual({ status: "present" });
    expect(f.scripts).toHaveLength(1);
    expect(asked).toBe(false);
  });

  it("elevates once and reports the rules added", async () => {
    const f = fake({ present: [false, true], elevated: false });
    let asked = 0;
    expect(await ensureFirewallRules({ platform: "win32", run: f.run, slot, onElevate: () => asked++ })).toEqual({ status: "added" });
    expect(asked).toBe(1);
    expect(f.scripts.filter((s) => s.includes("-Verb RunAs"))).toHaveLength(1);
  });

  it("runs the rules directly when already elevated", async () => {
    const f = fake({ present: [false, true], elevated: true });
    let asked = false;
    expect(await ensureFirewallRules({ platform: "win32", run: f.run, slot, onElevate: () => (asked = true) })).toEqual({ status: "added" });
    expect(asked).toBe(false);
    expect(f.scripts.some((s) => s.includes("-Verb RunAs"))).toBe(false);
    expect(f.scripts).toContain(applyRulesScript(firewallRules(programs)));
  });

  it("fails open when the prompt is declined, fails or times out", async () => {
    expect((await ensureFirewallRules({ platform: "win32", run: fake({ present: [false], elevated: false, elevate: result(1223) }).run, slot })).status).toBe("declined");
    expect(await ensureFirewallRules({ platform: "win32", run: fake({ present: [false, false], elevated: false, elevate: result(1, "", "This command cannot be run due to the error: no desktop.") }).run, slot })).toEqual({
      status: "failed",
      message: "This command cannot be run due to the error: no desktop.",
    });
    const timedOut = { ...result(null), timedOut: true };
    expect(await ensureFirewallRules({ platform: "win32", run: fake({ present: [false, false], elevated: false, elevate: timedOut }).run, slot })).toEqual({
      status: "failed",
      message: "the elevated step did not finish within 2 minutes",
    });
  });
});
