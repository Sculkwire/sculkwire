/**
 * manifest.json rules (each measured against the game): format_version, header, modules,
 * UUID uniqueness across packs, pack dependencies by uuid + version, `@minecraft/*` script modules against
 * what the target game ships, capabilities, subpacks, BP <-> RP linkage.
 */
import type { Severity } from "../core/diagnostic.ts";
import { isPlainObject, type JsonObject } from "../core/json.ts";
import { type Channel, compareDotted, compareTuples } from "../core/version.ts";
import type { Context, Pack } from "./context.ts";

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const MODULE_TYPES: Record<string, true> = {
  data: true,
  resources: true,
  script: true,
  skin_pack: true,
  world_template: true,
  client_data: true,
  interface: true,
  javascript: true,
};
const CAPABILITIES: Record<string, true> = {
  chemistry: true,
  editorExtension: true,
  experimental_custom_ui: true,
  raytraced: true,
  pbr: true,
  script_eval: true,
};
/** npm libraries that are not native modules: they must be bundled into the script, not declared. */
export const NPM_ONLY: Record<string, true> = {
  "@minecraft/vanilla-data": true,
  "@minecraft/math": true,
  "@minecraft/core-build-tasks": true,
};


export interface ManifestOptions {
  channel: Channel;
  /** Target game version ([1, 26, 50, 4]); enables the min_engine_version check. */
  gameVersion?: number[];
  /** Newest version known without game metadata (bundled schemas); a newer min_engine_version is a warning. */
  gameVersionEstimate?: number[];
  /** Script modules the target game ships (name -> version -> uuid); enables module version checks. */
  scriptModules?: Map<string, Map<string, string | undefined>>;
}

function obj(v: unknown): JsonObject | undefined {
  return isPlainObject(v) ? v : undefined;
}

function versionOk(v: unknown, fmt: number): boolean {
  if (Array.isArray(v)) return v.length === 3 && v.every((x) => Number.isInteger(x) && (x as number) >= 0);
  return typeof v === "string" && fmt >= 3 && SEMVER.test(v);
}

function vtuple(v: unknown): number[] | undefined {
  if (Array.isArray(v)) return v.every((x) => typeof x === "number") ? (v as number[]) : undefined;
  if (typeof v === "string") {
    const parts = v.match(/\d+/g)?.slice(0, 3).map(Number);
    return parts?.length === 3 ? parts : undefined;
  }
  return undefined;
}

function fmtVersion(v: unknown): string {
  return Array.isArray(v) ? v.join(".") : JSON.stringify(v);
}

const M = "manifest.json";

/** Report at `pointer` in the pack's manifest.json. */
function report(ctx: Context, pack: Pack, pointer: string, severity: Severity, code: string, message: string, hint?: string): Promise<void> {
  return ctx.at(pack, M, pointer, hint ? { severity, code, message, hint } : { severity, code, message });
}

export async function checkManifests(ctx: Context, packs: readonly Pack[], opts: ManifestOptions): Promise<void> {
  const supported = opts.scriptModules;
  const uuidToModule = new Map<string, string>();
  for (const [name, versions] of supported ?? []) for (const u of versions.values()) if (u) uuidToModule.set(u, name);
  const byUuid = new Map<string, Pack>();
  for (const p of packs) if (p.info.uuid) byUuid.set(p.info.uuid.toLowerCase(), p);
  const seen = new Map<string, { pack: Pack; pointer: string }[]>();

  for (const pack of packs) {
    const err = (pointer: string, code: string, message: string, hint?: string) => report(ctx, pack, pointer, "error", code, message, hint);
    const warn = (pointer: string, code: string, message: string) => report(ctx, pack, pointer, "warning", code, message);
    const doc = await ctx.json(pack, M);
    if (!doc || doc.value === undefined) continue; // unreadable: reported by the json check
    const m = obj(doc.value);
    if (!m) {
      await err("", "manifest.not-object", "manifest.json must be a JSON object");
      continue;
    }
    let fmt = m.format_version;
    if (fmt !== 1 && fmt !== 2 && fmt !== 3) {
      await err("/format_version", "manifest.format-version", `format_version must be 1, 2 or 3, got ${JSON.stringify(fmt)}`);
      fmt = 2;
    } else if (fmt === 1) await warn("/format_version", "manifest.format-version-legacy", "format_version 1 is legacy; use 2 or 3");
    const fv = fmt as number;
    const header = obj(m.header);
    if (!header) {
      await err("/header", "manifest.header-missing", "missing header object");
      continue;
    }
    for (const key of ["name", "uuid", "version"]) {
      if (!(key in header)) await err("/header", "manifest.header-field-missing", `header.${key} is required`);
    }
    if (!("description" in header)) await warn("/header", "manifest.description-missing", "header.description is missing");
    const hid = header.uuid;
    if ("uuid" in header && !(typeof hid === "string" && UUID.test(hid)))
      await err("/header/uuid", "manifest.uuid-invalid", `invalid UUID ${JSON.stringify(hid)}`);
    if ("version" in header && !versionOk(header.version, fv))
      await err(
        "/header/version",
        "manifest.version-invalid",
        `version must be [major, minor, patch]${fv >= 3 ? " or a semver string" : ""}, got ${JSON.stringify(header.version)}`,
      );
    const mev = header.min_engine_version;
    if (pack.kind === "behavior" || pack.kind === "resource" || pack.kind === "world_template") {
      if (mev === undefined && pack.kind !== "world_template") {
        await ctx.at(pack, M, "/header", {
          severity: fv >= 2 ? "error" : "warning",
          code: "manifest.min-engine-missing",
          message: "header.min_engine_version is required",
        });
      } else if (mev !== undefined) {
        const t = vtuple(mev);
        if (!t || (Array.isArray(mev) && !versionOk(mev, 2))) {
          await err("/header/min_engine_version", "manifest.min-engine-invalid", `min_engine_version must be [1, minor, patch], got ${JSON.stringify(mev)}`);
        } else if (opts.gameVersion && compareTuples(t, opts.gameVersion.slice(0, 3)) > 0) {
          await err(
            "/header/min_engine_version",
            "manifest.min-engine-too-new",
            `min_engine_version ${t.join(".")} is newer than Minecraft ${opts.gameVersion.join(".")} (${opts.channel}); the pack will not load`,
            `lower it to ${opts.gameVersion.slice(0, 3).join(", ")} or older`,
          );
        } else if (!opts.gameVersion && opts.gameVersionEstimate && compareTuples(t, opts.gameVersionEstimate) > 0) {
          await ctx.at(pack, M, "/header/min_engine_version", {
            severity: "warning",
            code: "manifest.min-engine-too-new",
            message: `min_engine_version ${t.join(".")} is newer than ${opts.gameVersionEstimate.join(".")}, the newest version known offline; the pack will not load in older games`,
            hint: "pass samplesRoot (or gameVersion) to check against the exact target game",
          });
        } else if (compareTuples(t, [1, 13, 0]) < 0) {
          await warn("/header/min_engine_version", "manifest.min-engine-legacy", `min_engine_version ${t.join(".")} enables legacy behavior; use a current version`);
        }
      }
    }
    if (typeof hid === "string") {
      const list = seen.get(hid.toLowerCase()) ?? [];
      list.push({ pack, pointer: "/header/uuid" });
      seen.set(hid.toLowerCase(), list);
    }

    let modules = m.modules;
    if (!Array.isArray(modules) || modules.length === 0) {
      await err("/modules", "manifest.modules-missing", "modules must be a non-empty array");
      modules = [];
    }
    const types = new Set<unknown>();
    let hasScript = false;
    for (let i = 0; i < (modules as unknown[]).length; i++) {
      const mp = `/modules/${i}`;
      const mod = obj((modules as unknown[])[i]);
      if (!mod) {
        await err(mp, "manifest.module-invalid", "module must be an object");
        continue;
      }
      const t = mod.type;
      if (typeof t !== "string" || !MODULE_TYPES[t]) await err(`${mp}/type`, "manifest.module-type", `unknown module type ${JSON.stringify(t)}`);
      types.add(t);
      const mid = mod.uuid;
      if (!(typeof mid === "string" && UUID.test(mid))) await err(`${mp}/uuid`, "manifest.uuid-invalid", `invalid UUID ${JSON.stringify(mid)}`);
      else {
        const list = seen.get(mid.toLowerCase()) ?? [];
        list.push({ pack, pointer: `${mp}/uuid` });
        seen.set(mid.toLowerCase(), list);
      }
      if (!versionOk(mod.version, fv)) await err(`${mp}/version`, "manifest.version-invalid", `invalid module version ${JSON.stringify(mod.version)}`);
      if (t === "script" || t === "javascript") {
        hasScript = true;
        if (t === "javascript") await warn(`${mp}/type`, "manifest.javascript-legacy", "module type 'javascript' is legacy; use 'script'");
        if (mod.language !== "javascript")
          await err(`${mp}${"language" in mod ? "/language" : ""}`, "manifest.script-language", 'script modules need "language": "javascript"');
        const entry = mod.entry;
        if (typeof entry !== "string")
          await err(mp, "manifest.script-entry-missing", "script module needs an entry file (e.g. scripts/main.js)");
        else if (!pack.fileSet.has(entry))
          await err(`${mp}/entry`, "manifest.script-entry-missing", `script entry '${entry}' does not exist in the pack`);
        else if (!entry.startsWith("scripts/"))
          await err(`${mp}/entry`, "manifest.script-entry-location", "script entry must be inside the scripts/ folder");
      }
    }
    if (types.has("data") && types.has("resources"))
      await err("/modules", "manifest.mixed-modules", "a pack cannot mix 'data' and 'resources' modules");

    let deps = m.dependencies ?? [];
    if (!Array.isArray(deps)) {
      await err("/dependencies", "manifest.dependencies-invalid", "dependencies must be an array");
      deps = [];
    }
    const scriptDeps: string[] = [];
    for (let i = 0; i < (deps as unknown[]).length; i++) {
      const dp = `/dependencies/${i}`;
      const dep = obj((deps as unknown[])[i]);
      if (!dep) {
        await err(dp, "manifest.dependency-invalid", "dependency must be an object");
        continue;
      }
      let name = dep.module_name;
      const duuid = dep.uuid;
      if (name === undefined && typeof duuid === "string" && uuidToModule.has(duuid)) name = uuidToModule.get(duuid);
      if (typeof name === "string") {
        scriptDeps.push(name);
        await scriptDependency(ctx, pack, dp, name, dep.version, "module_name" in dep, hasScript, opts);
        continue;
      }
      if (!(typeof duuid === "string" && UUID.test(duuid))) {
        await err(`${dp}${"uuid" in dep ? "/uuid" : ""}`, "manifest.dependency-invalid", `dependency needs a valid uuid or module_name, got ${JSON.stringify(duuid)}`);
        continue;
      }
      if (!versionOk(dep.version, fv)) await err(`${dp}/version`, "manifest.version-invalid", `invalid dependency version ${JSON.stringify(dep.version)}`);
      const other = byUuid.get(duuid.toLowerCase());
      if (!other) await warn(dp, "manifest.dependency-external", `depends on pack ${duuid}, which is not part of this project`);
      else if (other === pack) await err(dp, "manifest.dependency-self", "pack depends on itself");
      else {
        const want = vtuple(dep.version);
        const have = vtuple(other.info.version);
        if (!want || !have || compareTuples(want, have) !== 0) {
          await err(
            `${dp}/version`,
            "manifest.dependency-version",
            `depends on ${other.info.name ?? duuid} version ${fmtVersion(dep.version)} but that pack is version ${other.info.version ?? "?"}`,
          );
        }
      }
    }
    if (hasScript && scriptDeps.length === 0)
      await warn("/modules", "manifest.script-no-dependencies", "script module without any @minecraft/* dependency");

    const caps = m.capabilities;
    if (caps !== undefined) {
      if (!Array.isArray(caps)) await err("/capabilities", "manifest.capabilities-invalid", "capabilities must be an array of strings");
      else
        for (let i = 0; i < caps.length; i++) {
          const c = caps[i];
          if (typeof c !== "string" || !CAPABILITIES[c]) await warn(`/capabilities/${i}`, "manifest.capability-unknown", `unknown capability ${JSON.stringify(c)}`);
          if (c === "script_eval" && !hasScript) await warn(`/capabilities/${i}`, "manifest.capability-unused", "script_eval without a script module");
        }
    }
    const subpacks = m.subpacks;
    if (Array.isArray(subpacks)) {
      for (let i = 0; i < subpacks.length; i++) {
        const folder = obj(subpacks[i])?.folder_name;
        if (typeof folder === "string" && !pack.files.some((f) => f.startsWith(`subpacks/${folder}/`)))
          await err(`/subpacks/${i}/folder_name`, "manifest.subpack-missing", `subpacks/${folder}/ does not exist`);
      }
    }
  }

  for (const [uid, where] of seen) {
    if (where.length < 2) continue;
    const first = where[0] as { pack: Pack; pointer: string };
    for (const w of where.slice(1)) {
      await ctx.at(w.pack, M, w.pointer, {
        severity: "error",
        code: "manifest.uuid-duplicate",
        message: `UUID ${uid} is also used at ${ctx.label(first.pack, M)}#${first.pointer}; every pack and module needs its own UUID`,
        related: [{ file: ctx.label(first.pack, M), message: "first use" }],
      });
    }
  }

  const bps = packs.filter((p) => p.kind === "behavior" && p.manifest);
  const rps = packs.filter((p) => p.kind === "resource" && p.manifest);
  if (bps.length === 1 && rps.length === 1) {
    const bp = bps[0] as Pack;
    const rp = rps[0] as Pack;
    const ids = [bp.info.uuid, rp.info.uuid].map((u) => u?.toLowerCase());
    const linked = [bp, rp].some((p) =>
      (Array.isArray(p.manifest?.dependencies) ? (p.manifest?.dependencies as unknown[]) : []).some((d) => {
        const u = obj(d)?.uuid;
        return typeof u === "string" && ids.includes(u.toLowerCase());
      }),
    );
    if (!linked) {
      await ctx.at(bp, M, Array.isArray(bp.manifest?.dependencies) ? "/dependencies" : "/header", {
        severity: "warning",
        code: "manifest.pack-link",
        message: "behavior pack and resource pack do not depend on each other; the RP will not be applied automatically",
      });
    }
  }
}

async function scriptDependency(
  ctx: Context,
  pack: Pack,
  dp: string,
  name: string,
  version: unknown,
  hasModuleName: boolean,
  hasScript: boolean,
  opts: ManifestOptions,
): Promise<void> {
  const at = (pointer: string, severity: Severity, code: string, message: string, hint?: string) => report(ctx, pack, pointer, severity, code, message, hint);
  const namePtr = hasModuleName ? `${dp}/module_name` : dp;
  if (!hasScript) await at(dp, "warning", "manifest.script-dependency-unused", `dependency on ${name} but the pack has no script module`);
  if (NPM_ONLY[name]) {
    await at(namePtr, "error", "manifest.script-module-npm-only", `${name} is an npm library, not a native module`, "bundle it into your script (esbuild/rolldown) and remove the dependency");
    return;
  }
  if (typeof version !== "string") {
    await at(`${dp}/version`, "error", "manifest.script-module-version", `${name} version must be a string like "2.0.0"`);
    return;
  }
  const supported = opts.scriptModules;
  if (!supported) return; // no game metadata: names and versions cannot be judged
  const ok = supported.get(name);
  if (!ok) {
    await at(namePtr, "error", "manifest.script-module-unknown", `unknown script module ${JSON.stringify(name)}`);
    return;
  }
  if (ok.has(version)) {
    if (version.endsWith("-beta"))
      await at(
        `${dp}/version`,
        "warning",
        "manifest.script-module-beta",
        `${name} ${version} is a beta API: the world needs the Beta APIs experiment and it breaks on the next game update`,
      );
    return;
  }
  const stable = [...ok.keys()].filter((v) => !v.endsWith("-beta")).sort(compareDotted);
  const beta = [...ok.keys()].filter((v) => v.endsWith("-beta"));
  const target = opts.gameVersion ? `Minecraft ${opts.gameVersion.join(".")}` : "the target game";
  const hint = `${target} ships ${name} up to ${stable[stable.length - 1] ?? "none"}${beta.length ? `, beta ${beta.join(", ")}` : ""}`;
  await at(
    `${dp}/version`,
    opts.channel === "preview" ? "warning" : "error",
    "manifest.script-module-version",
    `${name} ${version} is not shipped by ${target} (${opts.channel})`,
    hint,
  );
}
