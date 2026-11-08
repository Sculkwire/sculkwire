/**
 * Decision model settings: `config.json` in `configDir()` (`~/.config/sculkwire/config.json` on Linux), overridden by
 * environment variables. The default provider is `none`: only `player_act play` and the `game_launch` join recovery
 * use a decision model, both as an optional advisor.
 */
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { configDir } from "../core/paths.ts";
import { createDecisionModel, DecisionError } from "./client.ts";
import type { DecisionModel } from "./types.ts";

export const PROVIDER_IDS = ["none", "openrouter", "zenmux", "local"] as const;
export type Provider = (typeof PROVIDER_IDS)[number];
export type ModelProvider = Exclude<Provider, "none">;

export interface ProviderInfo {
  title: string;
  baseUrl: string;
  model: string;
  images: boolean;
  /** Environment variable holding the API key (cloud providers). */
  keyEnv?: string;
  keyUrl?: string;
}

export const PROVIDERS: Record<ModelProvider, ProviderInfo> = {
  openrouter: {
    title: "Jev through OpenRouter",
    baseUrl: "https://openrouter.ai/api",
    model: "typesafe/jev-1.14",
    images: true,
    keyEnv: "OPENROUTER_API_KEY",
    keyUrl: "https://openrouter.ai/settings/keys",
  },
  zenmux: {
    title: "Jev through ZenMux",
    baseUrl: "https://zenmux.ai/api",
    model: "typesafe/jev-1.14",
    images: true,
    keyEnv: "ZENMUX_API_KEY",
    keyUrl: "https://zenmux.ai/settings/keys",
  },
  local: { title: "Kev served on this machine", baseUrl: "http://127.0.0.1:8009", model: "kev-latest", images: false },
};

const decisionSchema = z.object({
  provider: z.enum(PROVIDER_IDS),
  model: z.string().min(1).optional(),
  baseUrl: z.string().min(1).optional(),
  apiKey: z.string().min(1).optional(),
});
export type DecisionConfig = z.infer<typeof decisionSchema>;

/** The whole file. Unknown top-level keys are kept when sculkwire rewrites it. */
const fileSchema = z.looseObject({ decision: decisionSchema.optional() });
export type ConfigFile = z.infer<typeof fileSchema>;

export function configPath(): string {
  return configDir("config.json");
}

/** The config file, or `{}` when it does not exist. Throws on invalid JSON or an invalid `decision` section. */
export async function readConfig(path = configPath()): Promise<ConfigFile> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return {};
    throw err;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = fileSchema.safeParse(json);
  if (!parsed.success) throw new Error(`${path}: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join(", ")}`);
  return parsed.data;
}

/**
 * Replace the `decision` section, keeping the rest of the file. Mode 0600 when the file holds a key; Windows ignores
 * the mode, and the file is protected by the ACL of the user's `%APPDATA%` folder instead.
 */
export async function saveDecisionConfig(decision: DecisionConfig, path = configPath()): Promise<string> {
  const file = await readConfig(path);
  const clean = decisionSchema.parse(decision);
  const next: ConfigFile = { ...file, decision: clean };
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  const secret = clean.apiKey !== undefined;
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: secret ? 0o600 : 0o644 });
  if (secret) await chmod(tmp, 0o600);
  await rename(tmp, path);
  return path;
}

export interface ResolvedDecision {
  provider: Provider;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  images: boolean;
  /** Where the provider came from. */
  source: "env" | "file" | "default";
  /** Why no model can be built, when that is so. */
  missing?: string;
}

const nonEmpty = (v: string | undefined): string | undefined => (v?.trim() ? v.trim() : undefined);

/**
 * Settings after environment overrides: `SCULKWIRE_DECISION` (provider), `SCULKWIRE_DECISION_URL`,
 * `SCULKWIRE_DECISION_MODEL`, and `OPENROUTER_API_KEY` / `ZENMUX_API_KEY` for the matching provider.
 */
export function resolveDecision(file: ConfigFile, env: NodeJS.ProcessEnv = process.env): ResolvedDecision {
  const envProvider = nonEmpty(env.SCULKWIRE_DECISION);
  if (envProvider !== undefined && !(PROVIDER_IDS as readonly string[]).includes(envProvider)) {
    throw new Error(`SCULKWIRE_DECISION=${envProvider} is not one of ${PROVIDER_IDS.join(", ")}`);
  }
  const provider = PROVIDER_IDS.find((p) => p === envProvider) ?? file.decision?.provider ?? "none";
  const source = envProvider ? "env" : file.decision ? "file" : "default";
  if (provider === "none") return { provider, images: false, source };
  const info = PROVIDERS[provider];
  // File values only apply to the provider they were written for.
  const saved = file.decision?.provider === provider ? file.decision : undefined;
  const apiKey = (info.keyEnv ? nonEmpty(env[info.keyEnv]) : undefined) ?? saved?.apiKey;
  const resolved: ResolvedDecision = {
    provider,
    model: nonEmpty(env.SCULKWIRE_DECISION_MODEL) ?? saved?.model ?? info.model,
    baseUrl: nonEmpty(env.SCULKWIRE_DECISION_URL) ?? saved?.baseUrl ?? info.baseUrl,
    apiKey,
    images: info.images,
    source,
  };
  if (info.keyEnv && !apiKey) resolved.missing = `${info.title} needs an API key: set ${info.keyEnv} or run \`sculk setup\``;
  return resolved;
}

/** Build the client for resolved settings, or undefined when the provider is `none` or a key is missing. */
export function modelFor(resolved: ResolvedDecision, timeoutMs?: number): DecisionModel | undefined {
  if (resolved.provider === "none" || resolved.missing || !resolved.model || !resolved.baseUrl) return undefined;
  return createDecisionModel({
    label: `${resolved.provider} ${resolved.model}`,
    baseUrl: resolved.baseUrl,
    model: resolved.model,
    apiKey: resolved.apiKey,
    images: resolved.images,
    local: resolved.provider === "local",
    timeoutMs,
  });
}

/** The configured decision model, or undefined when the provider is `none` or not fully configured. */
export async function loadDecisionModel(): Promise<DecisionModel | undefined> {
  return modelFor(resolveDecision(await readConfig()));
}

export interface DecisionStatus {
  provider: Provider;
  model?: string;
  baseUrl?: string;
  source: ResolvedDecision["source"];
  configPath: string;
  /** A model can be built from the settings. */
  configured: boolean;
  /** One tiny probe was answered. */
  reachable: boolean;
  /** Round trip of the probe. */
  latencyMs?: number;
  images: boolean;
  /** What is wrong and how to fix it, when not reachable. */
  error?: string;
}

/** Settings plus one tiny probe question (skipped with `probe: false`). Never throws for a bad model setup. */
export async function decisionStatus(options: { probe?: boolean; timeoutMs?: number } = {}): Promise<DecisionStatus> {
  const path = configPath();
  let resolved: ResolvedDecision;
  try {
    resolved = resolveDecision(await readConfig(path));
  } catch (err) {
    return {
      provider: "none",
      source: "file",
      configPath: path,
      configured: false,
      reachable: false,
      images: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  const status: DecisionStatus = {
    provider: resolved.provider,
    model: resolved.model,
    baseUrl: resolved.baseUrl,
    source: resolved.source,
    configPath: path,
    configured: false,
    reachable: false,
    images: resolved.images,
  };
  const model = modelFor(resolved, options.timeoutMs ?? 15_000);
  if (!model) {
    status.error = resolved.missing ?? "no decision model configured (optional, only `player_act play` uses one). Run `sculk setup` to add one";
    return status;
  }
  status.configured = true;
  if (options.probe === false) return status;
  try {
    const decision = await model.decide("sculkwire status probe", { ok: { type: "noul", instructions: "Is this a probe?" } });
    status.reachable = true;
    status.latencyMs = decision.latencyMs;
  } catch (err) {
    status.error = err instanceof DecisionError || err instanceof Error ? err.message : String(err);
  }
  return status;
}
