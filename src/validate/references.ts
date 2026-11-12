/**
 * Cross-file references: everything a file names (textures, geometry, animations, loot tables, functions,
 * sound events, entity/item/block ids, ...) must exist in the add-on or in vanilla. Every finding carries the
 * range of the referencing JSON value.
 */
import type { Severity } from "../core/diagnostic.ts";
import { isPlainObject, type JsonObject } from "../core/json.ts";
import { IMAGE_EXT, SOUND_EXT } from "./classify.ts";
import type { Context, Pack } from "./context.ts";
import { pointerJoin } from "./jsonc.ts";

export type RefKind =
  | "entity"
  | "client_entity"
  | "attachable"
  | "item"
  | "block"
  | "geometry"
  | "render_controller"
  | "animation_rp"
  | "animation_controller_rp"
  | "animation_bp"
  | "animation_controller_bp"
  | "texture_file"
  | "item_texture"
  | "terrain_texture"
  | "loot_table"
  | "trade_table"
  | "sound_event"
  | "sound_file"
  | "function"
  | "particle"
  | "lang"
  | "rp_item"
  | "block_rp";

/** kind -> name -> where it is defined. */
export type Index = Map<RefKind, Map<string, { pack: Pack; rel: string }[]>>;
/** Vanilla names per kind (serializable). */
export type VanillaNames = Partial<Record<RefKind | "biome" | "effect" | "enchantment" | "feature" | "dimension", Set<string>>>;

const BUILTIN_TEXTURES: Record<string, true> = { "atlas.terrain": true, "atlas.items": true, "textures/misc/missing_texture": true };
const LOOT_PATH = /^loot_tables\/.+\.json$/;
const TRADE_PATH = /^trading\/.+\.json$/;
const FUNCTION_CMD = /^\s*\/?function\s+([^\s#]+)/;
const RUN_FUNCTION = /\brun\s+function\s+([^\s#]+)/g;
const RECIPE_ITEM_KEYS = ["key", "ingredients", "result", "input", "output", "base", "addition", "template", "unlock", "reagent"];
/** Kinds whose names are namespaced identifiers (`ns:name`). */
const IDENTIFIER_KINDS: RefKind[] = ["entity", "client_entity", "item", "block", "particle", "attachable"];

const LABEL: Record<RefKind, string> = {
  entity: "entity",
  client_entity: "client entity",
  attachable: "attachable",
  item: "item",
  block: "block",
  geometry: "geometry",
  render_controller: "render controller",
  animation_rp: "resource-pack animation",
  animation_controller_rp: "resource-pack animation controller",
  animation_bp: "behavior-pack animation",
  animation_controller_bp: "behavior-pack animation controller",
  texture_file: "texture file",
  item_texture: "item_texture.json key",
  terrain_texture: "terrain_texture.json key",
  loot_table: "loot table",
  trade_table: "trade table",
  sound_event: "sound definition",
  sound_file: "sound file",
  function: "function",
  particle: "particle",
  lang: "lang key",
  rp_item: "resource-pack item",
  block_rp: "blocks.json entry",
};

/** Stable code slug per kind: `reference.<slug>-missing`. */
const SLUG: Record<RefKind, string> = {
  entity: "entity",
  client_entity: "client-entity",
  attachable: "attachable",
  item: "item",
  block: "block",
  geometry: "geometry",
  render_controller: "render-controller",
  animation_rp: "animation",
  animation_controller_rp: "animation-controller",
  animation_bp: "animation",
  animation_controller_bp: "animation-controller",
  texture_file: "texture",
  item_texture: "item-texture",
  terrain_texture: "terrain-texture",
  loot_table: "loot-table",
  trade_table: "trade-table",
  sound_event: "sound-event",
  sound_file: "sound-file",
  function: "function",
  particle: "particle",
  lang: "lang-key",
  rp_item: "item",
  block_rp: "block",
};


function obj(v: unknown): JsonObject | undefined {
  return isPlainObject(v) ? v : undefined;
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** `{root: {description: {...}}}` -> [root object, description]. */
function desc(data: unknown, rootKey: string): [JsonObject | undefined, JsonObject | undefined] {
  const root = obj(obj(data)?.[rootKey]);
  return [root, obj(root?.description)];
}

function stripExt(rel: string, re: RegExp): string {
  return rel.replace(re, "");
}

function* walkStrings(value: unknown, pointer = ""): Generator<[string, string]> {
  if (typeof value === "string") yield [pointer, value];
  else if (Array.isArray(value)) for (let i = 0; i < value.length; i++) yield* walkStrings(value[i], pointerJoin(pointer, i));
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) yield* walkStrings(v, pointerJoin(pointer, k));
}

/** Index what each pack defines. */
export async function indexPacks(ctx: Context, packs: readonly Pack[], idx: Index = new Map()): Promise<Index> {
  const add = (kind: RefKind, name: unknown, pack: Pack, rel: string): void => {
    if (typeof name !== "string" || !name) return;
    let m = idx.get(kind);
    if (!m) idx.set(kind, (m = new Map()));
    let list = m.get(name);
    if (!list) m.set(name, (list = []));
    list.push({ pack, rel });
  };
  for (const pack of packs) {
    const bp = pack.kind === "behavior";
    if (!bp && pack.kind !== "resource") continue;
    for (const rel of pack.files) {
      const top = rel.split("/", 1)[0];
      if (!bp) {
        if (top === "textures" && IMAGE_EXT.test(rel)) add("texture_file", stripExt(rel, IMAGE_EXT), pack, rel);
        else if (top === "sounds" && SOUND_EXT.test(rel)) add("sound_file", stripExt(rel, SOUND_EXT), pack, rel);
        else if (top === "texts" && rel.endsWith("/en_US.lang")) {
          for (const line of ((await ctx.text(pack, rel)) ?? "").split(/\r?\n/)) {
            const eq = line.indexOf("=");
            if (eq > 0 && !line.startsWith("#")) add("lang", line.slice(0, eq).trim(), pack, rel);
          }
        }
      } else if (top === "functions" && rel.toLowerCase().endsWith(".mcfunction")) {
        add("function", rel.slice("functions/".length, -".mcfunction".length), pack, rel);
      }
      if (!rel.toLowerCase().endsWith(".json")) continue;
      const data = await ctx.value(pack, rel);
      const d = obj(data);
      if (!d && !Array.isArray(data)) continue;
      if (bp) {
        if (top === "entities") add("entity", desc(data, "minecraft:entity")[1]?.identifier, pack, rel);
        else if (top === "items") add("item", desc(data, "minecraft:item")[1]?.identifier, pack, rel);
        else if (top === "blocks") add("block", desc(data, "minecraft:block")[1]?.identifier, pack, rel);
        else if (top === "loot_tables") add("loot_table", rel, pack, rel);
        else if (top === "trading") add("trade_table", rel, pack, rel);
        else if (top === "animations") for (const k of Object.keys(obj(d?.animations) ?? {})) add("animation_bp", k, pack, rel);
        else if (top === "animation_controllers")
          for (const k of Object.keys(obj(d?.animation_controllers) ?? {})) add("animation_controller_bp", k, pack, rel);
      } else {
        if (top === "entity") add("client_entity", desc(data, "minecraft:client_entity")[1]?.identifier, pack, rel);
        else if (top === "attachables") add("attachable", desc(data, "minecraft:attachable")[1]?.identifier, pack, rel);
        else if (top === "models" && d) {
          for (const g of arr(d["minecraft:geometry"])) add("geometry", obj(obj(g)?.description)?.identifier, pack, rel);
          for (const k of Object.keys(d)) if (k.startsWith("geometry.")) add("geometry", k.split(":", 1)[0], pack, rel);
        } else if (top === "render_controllers")
          for (const k of Object.keys(obj(d?.render_controllers) ?? {})) add("render_controller", k, pack, rel);
        else if (top === "animations") for (const k of Object.keys(obj(d?.animations) ?? {})) add("animation_rp", k, pack, rel);
        else if (top === "animation_controllers")
          for (const k of Object.keys(obj(d?.animation_controllers) ?? {})) add("animation_controller_rp", k, pack, rel);
        else if (rel === "textures/item_texture.json")
          for (const k of Object.keys(obj(d?.texture_data) ?? {})) add("item_texture", k, pack, rel);
        else if (rel === "textures/terrain_texture.json")
          for (const k of Object.keys(obj(d?.texture_data) ?? {})) add("terrain_texture", k, pack, rel);
        else if (rel === "sounds/sound_definitions.json" && d) {
          const defs = obj(d.sound_definitions) ?? d;
          for (const k of Object.keys(defs)) if (k !== "format_version") add("sound_event", k, pack, rel);
        } else if (top === "particles") add("particle", desc(data, "particle_effect")[1]?.identifier, pack, rel);
        else if (top === "items") add("rp_item", desc(data, "minecraft:item")[1]?.identifier, pack, rel);
        else if (rel === "blocks.json" && d) for (const k of Object.keys(d)) if (k !== "format_version") add("block_rp", k, pack, rel);
      }
    }
  }
  return idx;
}

export interface ReferenceOptions {
  /** Vanilla names; without them, names that might be vanilla are reported as warnings. */
  vanilla?: VanillaNames;
  /** Missing texture/sound files become warnings (generated packs that ship no binaries). */
  assetsOptional?: boolean;
}

export class ReferenceChecker {
  readonly ctx: Context;
  readonly packs: readonly Pack[];
  readonly opts: ReferenceOptions;
  idx: Index = new Map();
  hasRp = false;
  hasBp = false;
  hasLang = false;
  /** Namespaces of identifiers the add-on defines (for judging names without a vanilla index). */
  namespaces = new Set<string>();

  constructor(ctx: Context, packs: readonly Pack[], opts: ReferenceOptions) {
    this.ctx = ctx;
    this.packs = packs;
    this.opts = opts;
  }

  async init(): Promise<void> {
    this.idx = await indexPacks(this.ctx, this.packs);
    this.hasRp = this.packs.some((p) => p.kind === "resource");
    this.hasBp = this.packs.some((p) => p.kind === "behavior");
    this.hasLang = (this.idx.get("lang")?.size ?? 0) > 0;
    for (const k of IDENTIFIER_KINDS) {
      for (const name of this.idx.get(k)?.keys() ?? []) {
        const ns = name.split(":", 1)[0];
        if (name.includes(":") && ns && ns !== "minecraft") this.namespaces.add(ns.toLowerCase());
      }
    }
  }

  defined(kind: RefKind, name: string): boolean {
    return this.idx.get(kind)?.has(name) === true;
  }

  known(kind: RefKind, name: string): boolean {
    return this.defined(kind, name) || this.opts.vanilla?.[kind]?.has(name) === true;
  }

  /** Severity for a missing name: game-measured legacy policy, softened when vanilla cannot be checked. */
  severityFor(kind: RefKind, name: string): { severity: Severity; unverified?: string } {
    if (name.startsWith("minecraft:")) return { severity: "warning" };
    if (kind === "function") return { severity: "error" };
    const tokens = name.toLowerCase().split(/[^a-z0-9]+/);
    const ours = tokens.some((t) => this.namespaces.has(t));
    if (kind === "texture_file" || kind === "sound_file") {
      // Samples ship few or no binary assets, so absence from vanilla proves little. A missing file is the
      // add-on's when it names the add-on's namespace or sits in a folder the add-on itself populates.
      const dir = name.slice(0, name.lastIndexOf("/") + 1);
      const ownDir = dir !== "" && this.packs.some((p) => p.kind === "resource" && p.files.some((f) => f.startsWith(dir)));
      if (ours || ownDir) return { severity: "error" };
      return {
        severity: "warning",
        unverified: this.opts.vanilla
          ? "not in the vanilla samples, which omit many engine assets; check the name if this is not a built-in file"
          : "no vanilla index: pass samplesRoot (--samples) to check vanilla names",
      };
    }
    if (this.opts.vanilla) return { severity: "error" };
    if (IDENTIFIER_KINDS.includes(kind) ? name.includes(":") : ours) return { severity: "error" };
    return { severity: "warning", unverified: "no vanilla index: pass samplesRoot (--samples) to check vanilla names" };
  }

  async missing(pack: Pack, rel: string, pointer: string, kind: RefKind, name: string, severity?: Severity): Promise<void> {
    // Without a vanilla index `minecraft:` names cannot be judged (with one they are warnings: engine aliases).
    if (!this.opts.vanilla && name.startsWith("minecraft:")) return;
    if ((kind === "loot_table" || kind === "trade_table") && this.packs.some((p) => p.fileSet.has(name))) {
      await this.ctx.at(pack, rel, pointer, {
        severity: "error",
        code: `reference.${SLUG[kind]}-missing`,
        message: `${LABEL[kind]} '${name}' exists but the game cannot load it (see its JSON errors)`,
      });
      return;
    }
    const judged = this.severityFor(kind, name);
    let sev = severity ?? judged.severity;
    let prefix = "";
    if ((kind === "texture_file" || kind === "sound_file") && this.opts.assetsOptional) {
      sev = "warning";
      prefix = "missing asset: ";
    }
    const where = this.opts.vanilla ? "the add-on or vanilla" : "the add-on";
    const d = {
      severity: sev,
      code: `reference.${SLUG[kind]}-missing`,
      message: `${prefix}${LABEL[kind]} '${name}' not found in ${where}`,
    };
    await this.ctx.at(
      pack,
      rel,
      pointer,
      judged.unverified && !severity ? { ...d, hint: judged.unverified } : d,
    );
  }

  async need(pack: Pack, rel: string, pointer: string, kind: RefKind, name: unknown, severity?: Severity): Promise<void> {
    if (typeof name === "string" && name && !this.known(kind, name)) await this.missing(pack, rel, pointer, kind, name, severity);
  }

  async item(pack: Pack, rel: string, pointer: string, name: unknown): Promise<void> {
    if (typeof name !== "string" || !name || name.startsWith("tag:")) return;
    let base = name.replace(/:\d+$/, "");
    if (!base.includes(":")) base = `minecraft:${base}`;
    if (this.known("item", base) || this.known("block", base)) return;
    // `<entity id>_spawn_egg` items exist for every spawnable entity.
    if (base.endsWith("_spawn_egg") && this.known("entity", base.slice(0, -"_spawn_egg".length))) return;
    await this.missing(pack, rel, pointer, "item", base);
  }

  async run(): Promise<void> {
    await this.init();
    await this.duplicates();
    for (const pack of this.packs) {
      for (const rel of pack.files) {
        const low = rel.toLowerCase();
        if (pack.kind === "behavior" && low.endsWith(".mcfunction")) await this.mcfunction(pack, rel);
        if (!low.endsWith(".json")) continue;
        const data = await this.ctx.value(pack, rel);
        if (!data || typeof data !== "object") continue;
        if (pack.kind === "behavior") await this.behaviorFile(pack, rel, data);
        else if (pack.kind === "resource" && obj(data)) await this.resourceFile(pack, rel, data as JsonObject);
      }
    }
  }

  async duplicates(): Promise<void> {
    const kinds: [RefKind, Severity, string][] = [
      ["entity", "error", "/minecraft:entity/description/identifier"],
      ["item", "error", "/minecraft:item/description/identifier"],
      ["block", "error", "/minecraft:block/description/identifier"],
      ["client_entity", "warning", "/minecraft:client_entity/description/identifier"],
      ["render_controller", "warning", ""],
      ["geometry", "warning", ""],
      ["animation_rp", "warning", ""],
      ["animation_bp", "warning", ""],
    ];
    for (const [kind, severity, idPointer] of kinds) {
      for (const [name, where] of this.idx.get(kind) ?? []) {
        const uniq = [...new Map(where.map((w) => [this.ctx.label(w.pack, w.rel), w])).entries()].sort((a, b) =>
          a[0].localeCompare(b[0]),
        );
        if (uniq.length < 2) continue;
        const [firstLabel] = uniq[0] as [string, unknown];
        for (const [, w] of uniq.slice(1)) {
          const pointer =
            idPointer ||
            (kind === "render_controller"
              ? pointerJoin("/render_controllers", name)
              : kind === "geometry"
                ? ""
                : pointerJoin("/animations", name));
          await this.ctx.at(w.pack, w.rel, pointer, {
            severity,
            code: `reference.duplicate-${SLUG[kind]}`,
            message: `${LABEL[kind]} '${name}' is also defined in ${firstLabel}`,
          });
        }
      }
    }
  }

  async mcfunction(pack: Pack, rel: string): Promise<void> {
    const lines = (await this.ctx.lines(pack, rel)) ?? [];
    for (let n = 0; n < lines.length; n++) {
      const line = lines[n] as string;
      if (line.trimStart().startsWith("#")) continue;
      const names: string[] = [];
      const m = FUNCTION_CMD.exec(line);
      if (m) names.push(m[1] as string);
      for (const m2 of line.matchAll(RUN_FUNCTION)) names.push(m2[1] as string);
      for (const raw of names) {
        const name = raw.replace(/^"|"$/g, "");
        if (this.known("function", name)) continue;
        const col = line.indexOf(raw) + 1;
        await this.ctx.add(pack, rel, {
          severity: "error",
          code: "reference.function-missing",
          source: "mcfunction",
          message: `function '${name}' not found (no functions/${name}.mcfunction in the behavior pack)`,
          range: { start: { line: n + 1, column: col }, end: { line: n + 1, column: col + raw.length } },
        });
      }
    }
  }

  async behaviorFile(pack: Pack, rel: string, data: object): Promise<void> {
    const top = rel.split("/", 1)[0];
    for (const [pointer, s] of walkStrings(data)) {
      if (LOOT_PATH.test(s)) await this.need(pack, rel, pointer, "loot_table", s);
      else if (TRADE_PATH.test(s)) await this.need(pack, rel, pointer, "trade_table", s);
      else if ((top === "animations" || top === "animation_controllers" || top === "entities") && s.startsWith("/function "))
        await this.need(pack, rel, pointer, "function", s.split(/\s+/)[1]);
    }
    const d = obj(data);
    if (rel === "functions/tick.json" && d) {
      const values = arr(d.values);
      for (let i = 0; i < values.length; i++) await this.need(pack, rel, `/values/${i}`, "function", values[i]);
    }
    if (!d) return;
    if (top === "entities") await this.bpEntity(pack, rel, d);
    else if (top === "items") await this.bpItem(pack, rel, d);
    else if (top === "blocks") await this.bpBlock(pack, rel, d);
    else if (top === "spawn_rules") {
      const [, sd] = desc(d, "minecraft:spawn_rules");
      if (sd) await this.need(pack, rel, "/minecraft:spawn_rules/description/identifier", "entity", sd.identifier);
    } else if (top === "recipes") await this.recipe(pack, rel, d);
    else if (top === "loot_tables") {
      const pools = arr(d.pools);
      for (let pi = 0; pi < pools.length; pi++) {
        const entries = arr(obj(pools[pi])?.entries);
        for (let ei = 0; ei < entries.length; ei++) {
          const e = obj(entries[ei]);
          if (e?.type === "item") await this.item(pack, rel, `/pools/${pi}/entries/${ei}/name`, e.name);
        }
      }
    } else if (top === "trading") {
      for (const [pointer, s] of walkStrings(d)) if (pointer.endsWith("/item")) await this.item(pack, rel, pointer, s);
    }
  }

  async animate(pack: Pack, rel: string, base: string, scripts: JsonObject | undefined, anims: JsonObject): Promise<void> {
    const animate = arr(scripts?.animate);
    for (let i = 0; i < animate.length; i++) {
      const a = animate[i];
      const name = obj(a) ? Object.keys(a as JsonObject)[0] : a;
      if (typeof name === "string" && !(name in anims)) {
        await this.ctx.at(pack, rel, `${base}/scripts/animate/${i}`, {
          severity: "error",
          code: "reference.animate-undeclared",
          message: `animate entry '${name}' is not a key of description.animations`,
        });
      }
    }
  }

  async bpEntity(pack: Pack, rel: string, data: JsonObject): Promise<void> {
    const [, d] = desc(data, "minecraft:entity");
    if (!d) return;
    const base = "/minecraft:entity/description";
    const anims = obj(d.animations) ?? {};
    for (const [k, v] of Object.entries(anims)) {
      if (typeof v === "string")
        await this.need(pack, rel, pointerJoin(`${base}/animations`, k), v.startsWith("controller.") ? "animation_controller_bp" : "animation_bp", v);
    }
    await this.animate(pack, rel, base, obj(d.scripts), anims);
    const ident = d.identifier;
    if (typeof ident !== "string" || ident.startsWith("minecraft:")) return;
    if (this.hasRp && !this.known("client_entity", ident)) {
      await this.ctx.at(pack, rel, `${base}/identifier`, {
        severity: "warning",
        code: "reference.client-entity-missing",
        message: `entity '${ident}' has no client entity in the resource pack (it will render invisible)`,
      });
    }
    if (this.hasLang && !this.defined("lang", `entity.${ident}.name`)) {
      await this.ctx.at(pack, rel, `${base}/identifier`, {
        severity: "warning",
        code: "lang.key-missing",
        message: `lang key 'entity.${ident}.name' missing from texts/en_US.lang`,
        hint: `add 'entity.${ident}.name=<Name>' to texts/en_US.lang`,
      });
    }
  }

  async bpItem(pack: Pack, rel: string, data: JsonObject): Promise<void> {
    const [item, d] = desc(data, "minecraft:item");
    if (!item) return;
    const comps = obj(item.components) ?? {};
    const icon = comps["minecraft:icon"];
    const base = "/minecraft:item/components/minecraft:icon";
    const refs: [string, unknown][] = [];
    if (typeof icon === "string") refs.push([base, icon]);
    else if (obj(icon)) {
      const io = icon as JsonObject;
      if (typeof io.texture === "string") refs.push([`${base}/texture`, io.texture]);
      for (const [k, v] of Object.entries(obj(io.textures) ?? {})) refs.push([pointerJoin(`${base}/textures`, k), v]);
    }
    if (this.hasRp) for (const [p, name] of refs) await this.need(pack, rel, p, "item_texture", name);
    const ident = d?.identifier;
    if (
      this.hasLang &&
      typeof ident === "string" &&
      !ident.startsWith("minecraft:") &&
      !("minecraft:display_name" in comps) &&
      !this.defined("lang", `item.${ident}`) &&
      !this.defined("lang", `item.${ident}.name`)
    ) {
      await this.ctx.at(pack, rel, "/minecraft:item/description/identifier", {
        severity: "warning",
        code: "lang.key-missing",
        message: `lang key 'item.${ident}' missing from texts/en_US.lang and no minecraft:display_name`,
      });
    }
  }

  async bpBlock(pack: Pack, rel: string, data: JsonObject): Promise<void> {
    const [block, d] = desc(data, "minecraft:block");
    if (!block) return;
    const parts: [string, unknown][] = [["/minecraft:block/components", block.components]];
    const perms = arr(block.permutations);
    for (let i = 0; i < perms.length; i++) parts.push([`/minecraft:block/permutations/${i}/components`, obj(perms[i])?.components]);
    let hasDisplay = false;
    for (const [base, c] of parts) {
      const comps = obj(c);
      if (!comps) continue;
      hasDisplay ||= "minecraft:display_name" in comps;
      const geo = comps["minecraft:geometry"];
      const gname = typeof geo === "string" ? geo : obj(geo)?.identifier;
      if (typeof gname === "string" && !gname.startsWith("minecraft:geometry.") && this.hasRp) {
        await this.need(pack, rel, `${base}/minecraft:geometry${typeof geo === "string" ? "" : "/identifier"}`, "geometry", gname);
      }
      const mats = obj(comps["minecraft:material_instances"]);
      if (mats && this.hasRp) {
        for (const [k, m] of Object.entries(mats)) {
          const tex = obj(m)?.texture;
          if (typeof tex === "string")
            await this.need(pack, rel, `${pointerJoin(`${base}/minecraft:material_instances`, k)}/texture`, "terrain_texture", tex);
        }
      }
    }
    const ident = d?.identifier;
    if (
      this.hasLang &&
      typeof ident === "string" &&
      !ident.startsWith("minecraft:") &&
      !hasDisplay &&
      !this.defined("lang", `tile.${ident}.name`)
    ) {
      await this.ctx.at(pack, rel, "/minecraft:block/description/identifier", {
        severity: "warning",
        code: "lang.key-missing",
        message: `lang key 'tile.${ident}.name' missing from texts/en_US.lang and no minecraft:display_name`,
      });
    }
  }

  async recipe(pack: Pack, rel: string, data: JsonObject): Promise<void> {
    for (const [rk, b] of Object.entries(data)) {
      const body = obj(b);
      if (!rk.startsWith("minecraft:recipe_") || !body) continue;
      for (const key of RECIPE_ITEM_KEYS) {
        if (!(key in body)) continue;
        const base = `${pointerJoin("", rk)}/${key}`;
        const val = body[key];
        if (typeof val === "string") {
          await this.item(pack, rel, base, val);
          continue;
        }
        for (const [pointer, s] of walkStrings(val, base)) {
          const leaf = pointer.slice(pointer.lastIndexOf("/") + 1);
          if (
            leaf === "item" ||
            (/^\d+$/.test(leaf) && (key === "ingredients" || key === "result")) ||
            (key === "key" && pointer.split("/").length === 4)
          )
            await this.item(pack, rel, pointer, s);
        }
      }
    }
  }

  async resourceFile(pack: Pack, rel: string, data: JsonObject): Promise<void> {
    const top = rel.split("/", 1)[0];
    if (top === "entity" || top === "attachables") {
      await this.clientDescription(pack, rel, data, top === "entity" ? "minecraft:client_entity" : "minecraft:attachable");
    } else if (rel === "textures/item_texture.json" || rel === "textures/terrain_texture.json") {
      for (const [k, v] of Object.entries(obj(data.texture_data) ?? {}))
        await this.textureValue(pack, rel, `${pointerJoin("/texture_data", k)}/textures`, obj(v)?.textures);
    } else if (rel === "textures/flipbook_textures.json") {
      // flipbook atlas_tile names are free-form; their `flipbook_texture` paths are files
    } else if (rel === "sounds/sound_definitions.json") {
      const nested = obj(data.sound_definitions);
      const defs = nested ?? data;
      const base = nested ? "/sound_definitions" : "";
      for (const [ev, def] of Object.entries(defs)) {
        const sounds = arr(obj(def)?.sounds);
        for (let i = 0; i < sounds.length; i++) {
          const s = sounds[i];
          const name = obj(s) ? (s as JsonObject).name : s;
          const p = `${pointerJoin(base, ev)}/sounds/${i}${obj(s) ? "/name" : ""}`;
          if (typeof name === "string" && name) await this.need(pack, rel, p, "sound_file", name);
        }
      }
    } else if (rel === "sounds.json") {
      for (const [pointer, s] of walkStrings(data)) {
        const parts = pointer.split("/");
        const last = parts[parts.length - 1];
        if (s && (parts.slice(0, -1).includes("events") || last === "sound") && last !== "pitch" && last !== "volume")
          await this.need(pack, rel, pointer, "sound_event", s);
      }
    } else if (rel === "blocks.json") {
      for (const [b, def] of Object.entries(data)) {
        const dd = obj(def);
        if (!dd) continue;
        for (const key of ["textures", "carried_textures"]) {
          const t = dd[key];
          const p = `${pointerJoin("", b)}/${key}`;
          if (typeof t === "string") await this.need(pack, rel, p, "terrain_texture", t);
          else if (obj(t)) for (const [face, v] of Object.entries(t as JsonObject)) await this.need(pack, rel, pointerJoin(p, face), "terrain_texture", v);
        }
      }
    } else if (top === "particles") {
      const [, pd] = desc(data, "particle_effect");
      const tex = obj(pd?.basic_render_parameters)?.texture;
      if (typeof tex === "string" && !BUILTIN_TEXTURES[tex])
        await this.need(pack, rel, "/particle_effect/description/basic_render_parameters/texture", "texture_file", tex);
    } else if (top === "items") {
      const [item] = desc(data, "minecraft:item");
      const icon = obj(item?.components)?.["minecraft:icon"];
      if (typeof icon === "string") await this.need(pack, rel, "/minecraft:item/components/minecraft:icon", "item_texture", icon);
    }
  }

  async textureValue(pack: Pack, rel: string, pointer: string, v: unknown): Promise<void> {
    if (typeof v === "string") {
      if (!BUILTIN_TEXTURES[v]) await this.need(pack, rel, pointer, "texture_file", v);
    } else if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) await this.textureValue(pack, rel, `${pointer}/${i}`, v[i]);
    } else if (typeof obj(v)?.path === "string") {
      await this.textureValue(pack, rel, `${pointer}/path`, (v as JsonObject).path);
    }
  }

  async clientDescription(pack: Pack, rel: string, data: JsonObject, root: string): Promise<void> {
    const [, d] = desc(data, root);
    if (!d) return;
    const base = `${pointerJoin("", root)}/description`;
    for (const [k, v] of Object.entries(obj(d.geometry) ?? {})) await this.need(pack, rel, pointerJoin(`${base}/geometry`, k), "geometry", v);
    const rcs = arr(d.render_controllers);
    for (let i = 0; i < rcs.length; i++) {
      const rc = rcs[i];
      const name = typeof rc === "string" ? rc : obj(rc) ? Object.keys(rc as JsonObject)[0] : undefined;
      await this.need(pack, rel, `${base}/render_controllers/${i}`, "render_controller", name);
    }
    const anims = obj(d.animations) ?? {};
    for (const [k, v] of Object.entries(anims)) {
      if (typeof v === "string")
        await this.need(pack, rel, pointerJoin(`${base}/animations`, k), v.startsWith("controller.") ? "animation_controller_rp" : "animation_rp", v);
    }
    for (const [k, v] of Object.entries(obj(d.textures) ?? {})) {
      if (typeof v === "string" && !BUILTIN_TEXTURES[v]) await this.need(pack, rel, pointerJoin(`${base}/textures`, k), "texture_file", v);
    }
    for (const [k, v] of Object.entries(obj(d.particle_effects) ?? {}))
      await this.need(pack, rel, pointerJoin(`${base}/particle_effects`, k), "particle", v);
    for (const [k, v] of Object.entries(obj(d.sound_effects) ?? {}))
      await this.need(pack, rel, pointerJoin(`${base}/sound_effects`, k), "sound_event", v);
    const egg = obj(d.spawn_egg);
    if (typeof egg?.texture === "string") await this.need(pack, rel, `${base}/spawn_egg/texture`, "item_texture", egg.texture);
    await this.animate(pack, rel, base, obj(d.scripts), anims);
    const ident = d.identifier;
    if (root === "minecraft:client_entity" && this.hasBp && typeof ident === "string" && !this.known("entity", ident)) {
      await this.ctx.at(pack, rel, `${base}/identifier`, {
        severity: "warning",
        code: "reference.entity-missing",
        message: `client entity '${ident}' has no behavior-pack entity in the add-on${this.opts.vanilla ? " or vanilla" : ""}`,
      });
    }
  }
}

/** Run every reference rule over the packs. */
export async function checkReferences(ctx: Context, packs: readonly Pack[], opts: ReferenceOptions): Promise<void> {
  await new ReferenceChecker(ctx, packs, opts).run();
}
