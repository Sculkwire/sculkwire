/**
 * Windows Firewall rules for the Bedrock Dedicated Server. BDS binds its UDP ports on all interfaces, and no
 * server.properties option makes it loopback-only, so Windows Firewall asks for permission the first time each
 * `bedrock_server.exe` path listens. Instances run in numbered slots (`slotDir`), so a rule per slot executable keeps
 * Windows from asking during a run. sculkwire itself reaches the server only through stdin and loopback, which the
 * firewall does not filter. Everything here is a no-op off Windows.
 */
import { win32 } from "node:path";
import { run, type RunResult } from "../../core/process.ts";
import { serverExecutable } from "./files.ts";
import { slotDir } from "./instance.ts";

/** Slots 0 to 3 get rules: one per server that can run at the same time in usual use. */
export const FIREWALL_SLOTS = 4;

/** The name of every rule sculkwire owns; deleting by this name removes them all. */
export const FIREWALL_RULE = "sculkwire BDS";

/** How long the elevated step may take, the UAC prompt included. */
const ELEVATION_TIMEOUT_MS = 120_000;
/** How long a detection or elevation check may take. */
const QUERY_TIMEOUT_MS = 30_000;
/** Win32 ERROR_CANCELLED: the user answered No on the UAC prompt. */
const ERROR_CANCELLED = 1223;

/** The server executables the rules cover: slots 0 to 3, absolute Windows paths. */
export function firewallPrograms(slot: (n: number) => string = slotDir): string[] {
  return Array.from({ length: FIREWALL_SLOTS }, (_, n) => win32.resolve(slot(n), serverExecutable("windows")));
}

export interface FirewallRule {
  program: string;
  action: "allow" | "block";
  profile: string;
}

/**
 * Two inbound rules per executable. A rule has to exist for whichever profile the network has, or Windows asks again,
 * so every profile is covered: allow on private and domain networks, block on public ones. The test server runs in
 * offline mode with cheats on, so it is not opened on public networks.
 */
export function firewallRules(programs: readonly string[]): FirewallRule[] {
  return programs.flatMap((program) => [
    { program, action: "allow" as const, profile: "private,domain" },
    { program, action: "block" as const, profile: "public" },
  ]);
}

/** The netsh arguments (after `netsh`) that add one rule. The program comes last, so rules share the longest start. */
export function addRuleArgs(rule: FirewallRule): string {
  // Windows paths cannot contain a double quote; one here would end the netsh value early.
  if (rule.program.includes('"')) throw new Error(`invalid program path: ${rule.program}`);
  return `advfirewall firewall add rule name="${FIREWALL_RULE}" dir=in enable=yes action=${rule.action} profile=${rule.profile} program="${rule.program}"`;
}

export const DELETE_RULES_ARGS = `advfirewall firewall delete rule name="${FIREWALL_RULE}"`;
export const SHOW_RULES_ARGS = `advfirewall firewall show rule name="${FIREWALL_RULE}" verbose`;

/**
 * A PowerShell single-quoted string literal. PowerShell also reads the typographic single quotes as quote characters
 * (a user name like O’Brien), so those are doubled as well.
 */
export function psLiteral(text: string): string {
  return `'${text.replace(/['\u2018\u2019\u201A\u201B]/g, "$&$&")}'`;
}

/**
 * PowerShell that starts netsh with an exact command line (`argsExpression` is a PowerShell string expression) and
 * its output redirected, for the show script. Netsh reads its command line itself, and PowerShell's own quoting of
 * native arguments differs between versions, so the line goes through `ProcessStartInfo` untouched.
 */
function netshStart(argsExpression: string, redirect: boolean): string {
  return [
    `$psi = New-Object Diagnostics.ProcessStartInfo 'netsh.exe', ${argsExpression}`,
    "$psi.UseShellExecute = $false",
    "$psi.CreateNoWindow = $true",
    ...(redirect ? ["$psi.RedirectStandardOutput = $true", "$psi.StandardOutputEncoding = [Text.Encoding]::UTF8"] : []),
    "$p = [Diagnostics.Process]::Start($psi)",
  ].join("\n");
}

/** Programs as their longest common prefix and suffix, written once, and the part of each program between them. */
export function splitPrograms(programs: readonly string[]): { prefix: string; suffix: string; middles: string[] } {
  const [first = "", ...rest] = programs;
  let prefix = first;
  for (const program of rest) while (!program.startsWith(prefix)) prefix = prefix.slice(0, -1);
  // The suffix is taken from what follows the prefix, so the two never overlap.
  const tails = programs.map((program) => program.slice(prefix.length));
  let suffix = tails[0] ?? "";
  for (const tail of tails) while (!tail.endsWith(suffix)) suffix = suffix.slice(1);
  return { prefix, suffix, middles: tails.map((tail) => tail.slice(0, tail.length - suffix.length)) };
}

/**
 * The PowerShell that replaces sculkwire's rules: delete them all by name, then add each one. Exits with the number
 * of failed adds. It runs elevated through `Start-Process -Verb RunAs`, which goes through ShellExecuteEx, whose
 * parameter string is limited to about 2048 characters; the script travels base64 encoded as UTF-16, so it is kept
 * compact: the common prefix and suffix of the programs and the common start of the netsh lines are written once, and
 * each group of rules with the same action and profile is one loop over the middles. Netsh gets a single-string `-ArgumentList`, which Start-Process passes as
 * the command line unchanged, so the `name="..."` and `program="..."` quoting stays exact.
 */
export function applyRulesScript(rules: readonly FirewallRule[]): string {
  const { prefix, suffix } = splitPrograms([...new Set(rules.map((rule) => rule.program))]);
  const groups = new Map<string, { rule: FirewallRule; middles: string[] }>();
  for (const rule of rules) {
    const key = `${rule.action} ${rule.profile}`;
    const middle = rule.program.slice(prefix.length, rule.program.length - suffix.length);
    const group = groups.get(key);
    if (group) group.middles.push(middle);
    else groups.set(key, { rule, middles: [middle] });
  }
  const marker = "\u0000";
  const parts = [...groups.values()].map(({ rule, middles }) => {
    const [head = "", tail = ""] = addRuleArgs({ ...rule, program: marker }).split(marker);
    return { head, tail, middles };
  });
  const start = splitPrograms(parts.map((part) => part.head)).prefix;
  return [
    "$ErrorActionPreference='Stop'",
    `$p=${psLiteral(prefix)};$s=${psLiteral(suffix)};$h=${psLiteral(start)};$f=0`,
    "function N($a){(Start-Process netsh -ArgumentList $a -NoNewWindow -Wait -PassThru).ExitCode}",
    // Deleting rules that do not exist fails; that is the first run.
    `$null=N ${psLiteral(DELETE_RULES_ARGS)}`,
    ...parts.map(
      ({ head, tail, middles }) =>
        `foreach($m in @(${middles.map(psLiteral).join(",")})){if(N ($h+${psLiteral(head.slice(start.length))}+$p+$m+$s+${psLiteral(tail)})){$f++}}`,
    ),
    "exit $f",
  ].join("\n");
}

/**
 * The PowerShell that prints sculkwire's rules (`netsh ... show rule ... verbose`), which needs no admin rights. The
 * console code page is set to UTF-8 first, so netsh writes a path with non-ASCII letters the way it was added.
 */
export function showRulesScript(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    // Without a console the setter throws; detection then reads whatever code page netsh wrote.
    "try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }",
    netshStart(psLiteral(SHOW_RULES_ARGS), true),
    "$out = $p.StandardOutput.ReadToEnd()",
    "$p.WaitForExit()",
    "[Console]::Out.Write($out)",
    "exit $p.ExitCode",
  ].join("\n");
}

/** The PowerShell that exits 0 when this process runs elevated (as an administrator). */
export const ELEVATED_SCRIPT =
  "if (([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { exit 0 } else { exit 1 }";

/** `-EncodedCommand` text: base64 of the script as UTF-16LE. */
export function encodePowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

/** Arguments for `powershell.exe` that run `script` without a profile or prompts. */
export function powerShellArgs(script: string): string[] {
  return ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowerShell(script)];
}

/**
 * The PowerShell that runs `script` in an elevated PowerShell: one UAC prompt, a hidden window, and a wait for it to
 * finish. The script travels inside the command line as `-EncodedCommand`, so no temp file exists that another process
 * could swap before it runs elevated, and no quoting passes through cmd. `-Verb RunAs` goes through ShellExecuteEx,
 * whose parameter string is limited to about 2048 characters, so `script` must stay short (see `applyRulesScript`).
 * A declined prompt exits 1223.
 */
export function elevateScript(script: string): string {
  return [
    "try {",
    `$p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList ${psLiteral(powerShellArgs(script).join(" "))} -ErrorAction Stop`,
    "exit $p.ExitCode",
    "} catch {",
    "$e = $_.Exception",
    `while ($e) { if ($e -is [ComponentModel.Win32Exception] -and $e.NativeErrorCode -eq ${ERROR_CANCELLED}) { exit ${ERROR_CANCELLED} }; $e = $e.InnerException }`,
    "[Console]::Error.WriteLine($_.Exception.Message)",
    "exit 1",
    "}",
  ].join("\n");
}

/**
 * Whether `netsh ... show rule` output lists every program. Its labels are localized, so only the paths are compared,
 * ignoring case as Windows does. Letters outside ASCII are left out on both sides: netsh may write them in the
 * console's code page, and a path that then never matched would make setup ask for elevation on every run.
 */
export function rulesPresent(output: string, programs: readonly string[]): boolean {
  const comparable = (text: string): string => text.toLowerCase().replace(/[^\x20-\x7e\r\n]/g, "");
  const text = comparable(output);
  return programs.every((program) => text.includes(comparable(program)));
}

export type FirewallResult =
  | { status: "present" }
  | { status: "added" }
  | { status: "declined"; message: string }
  | { status: "failed"; message: string }
  | { status: "skipped"; message: string };

export interface FirewallDeps {
  platform?: NodeJS.Platform;
  /** The child-process runner. Default: `run` from `src/core/process.ts`. */
  run?: (command: string, args: readonly string[], options: { timeoutMs: number }) => Promise<RunResult>;
  /** Slot folders. Default: `slotDir`. */
  slot?: (n: number) => string;
  /** Called once right before the elevation request, so the user knows why Windows asks. */
  onElevate?: () => void;
}

function describeFailure(r: RunResult): string {
  if (r.timedOut) return "the elevated step did not finish within 2 minutes";
  const text = r.stderr.trim() || r.stdout.trim();
  return text ? text.split(/\r?\n/).at(-1)!.trim() : `PowerShell exited with code ${r.code}`;
}

/**
 * Whether sculkwire's firewall rules cover every slot executable. Needs no admin rights. Undefined off Windows and when
 * detection could not run (PowerShell missing, timed out, or failing without output).
 */
export async function firewallRulesPresent(deps: FirewallDeps = {}): Promise<boolean | undefined> {
  if ((deps.platform ?? process.platform) !== "win32") return undefined;
  const r = await (deps.run ?? run)("powershell.exe", powerShellArgs(showRulesScript()), { timeoutMs: QUERY_TIMEOUT_MS });
  if (r.startError || r.timedOut || (r.code !== 0 && !r.stdout.trim())) return undefined;
  return rulesPresent(r.stdout, firewallPrograms(deps.slot));
}

/**
 * Adds the firewall rules for the slot executables on Windows, asking for elevation at most once. Present rules mean
 * nothing to do (no prompt, so running setup again never asks again). Fails open: a declined or impossible elevation
 * (no desktop, CI, timeout) is a result, never an exception.
 */
export async function ensureFirewallRules(deps: FirewallDeps = {}): Promise<FirewallResult> {
  if ((deps.platform ?? process.platform) !== "win32") return { status: "skipped", message: "Windows Firewall exists only on Windows" };
  const exec = deps.run ?? run;
  const powershell = (script: string, timeoutMs = QUERY_TIMEOUT_MS) => exec("powershell.exe", powerShellArgs(script), { timeoutMs });

  // Detection that could not run counts as absent: adding the rules says why if PowerShell is missing.
  if (await firewallRulesPresent(deps)) return { status: "present" };
  const apply = applyRulesScript(firewallRules(firewallPrograms(deps.slot)));
  const elevated = (await powershell(ELEVATED_SCRIPT)).code === 0;
  let result: RunResult;
  if (elevated) result = await powershell(apply, ELEVATION_TIMEOUT_MS);
  else {
    deps.onElevate?.();
    result = await powershell(elevateScript(apply), ELEVATION_TIMEOUT_MS);
    if (result.code === ERROR_CANCELLED) return { status: "declined", message: "permission was declined" };
  }
  if (await firewallRulesPresent(deps)) return { status: "added" };
  return { status: "failed", message: result.code === 0 ? "netsh did not add the rules" : describeFailure(result) };
}
