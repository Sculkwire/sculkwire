/**
 * `DecisionModel` over HTTP for the TypeSafe System One API (`POST <base>/v1/systemone`). The same request works
 * against OpenRouter, ZenMux and a local Kev server.
 */
import { z } from "zod";
import { cacheDir } from "../core/paths.ts";
import type { Answer, Decision, DecisionModel, DecisionState, Question } from "./types.ts";

export type DecisionErrorKind = "auth" | "not_found" | "unreachable" | "timeout" | "aborted" | "http" | "bad_response";

export class DecisionError extends Error {
  readonly kind: DecisionErrorKind;
  readonly status?: number;
  constructor(kind: DecisionErrorKind, message: string, status?: number) {
    super(message);
    this.name = "DecisionError";
    this.kind = kind;
    this.status = status;
  }
}

/** Where `sculk setup` puts the Kev checkout. */
export const KEV_REPO = "https://github.com/jaredpalmer/kev";
export const KEV_WEIGHTS = "jaredpalmer/kev-0.8b";
export const KEV_DIR = cacheDir("kev");

/** Double-quotes a path with characters a shell would split or expand; the result pastes into sh, PowerShell and cmd. */
const shellPath = (path: string): string => (/[\s"'$&|;()<>^%!`,]/.test(path) ? `"${path}"` : path);

/** The commands that clone Kev into `dir` and install its server dependencies, one per line. */
export function kevInstallCommands(dir = KEV_DIR): string[] {
  return [`git clone ${KEV_REPO} ${shellPath(dir)}`, `uv sync --directory ${shellPath(dir)} --extra serve`];
}

/**
 * The command that starts a local Kev server on `port` from the checkout in `dir`. `uv --directory` instead of
 * `cd <dir> && ...` keeps it one command, which pastes unchanged into sh, PowerShell 5.1 (no `&&`) and cmd.
 */
export function kevStartCommand(port = 8009, dir = KEV_DIR): string {
  return `uv run --directory ${shellPath(dir)} --extra serve python -m kev.serve --run ${KEV_WEIGHTS} --port ${port}`;
}

export interface DecisionClientOptions {
  /** Short label, e.g. `openrouter typesafe/jev-1.14`. */
  label: string;
  /** API base without `/v1/systemone`, e.g. `https://openrouter.ai/api` or `http://127.0.0.1:8009`. */
  baseUrl: string;
  model: string;
  apiKey?: string;
  images: boolean;
  /** True for a server on this machine: a refused connection then names the Kev start command. */
  local?: boolean;
  /** Per-request limit (default 10 s). */
  timeoutMs?: number;
}

/** `<base>/v1/systemone`, accepting a base that already ends in `/v1/systemone` or `/v1`. */
export function systemOneUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "").replace(/\/v1\/systemone$/, "").replace(/\/v1$/, "");
  return `${base}/v1/systemone`;
}

const REFUSED = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ECONNRESET"]);

/** Walks `cause` chains and `AggregateError`s (Node reports refused dual-stack connects as one). */
function connectionRefused(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if ("code" in err && typeof err.code === "string" && REFUSED.has(err.code)) return true;
  if (err instanceof AggregateError && err.errors.some(connectionRefused)) return true;
  return "cause" in err && connectionRefused(err.cause);
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function portOf(url: string): number {
  const u = new URL(url);
  return u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
}

const probabilities = z.record(z.string(), z.number());
const answerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("choice"), choice: z.string(), confidence: z.number().optional(), probabilities }),
  z.object({ type: z.literal("noul"), noul: z.number() }),
  z.object({ type: z.literal("score"), score: z.number(), confidence: z.number().optional(), probabilities }),
  z.object({
    type: z.literal("box"),
    box: z.object({ top: z.number(), bottom: z.number(), left: z.number(), right: z.number() }),
    confidence: z.number().optional(),
  }),
]);
const responseSchema = z.object({ answers: z.record(z.string(), z.unknown()) });
const errorSchema = z.object({
  error: z.union([z.string(), z.object({ message: z.string() })]).optional(),
  message: z.string().optional(),
  detail: z.unknown().optional(),
});

function checkAnswers(body: unknown, questions: Record<string, Question>, url: string): Record<string, Answer> {
  const parsed = responseSchema.safeParse(body);
  if (!parsed.success) throw new DecisionError("bad_response", `${url} answered without an \`answers\` object`);
  const out: Record<string, Answer> = {};
  for (const [key, question] of Object.entries(questions)) {
    const answer = answerSchema.safeParse(parsed.data.answers[key]);
    if (!answer.success || answer.data.type !== question.type) {
      throw new DecisionError("bad_response", `${url} returned no valid ${question.type} answer for question "${key}"`);
    }
    out[key] = answer.data;
  }
  return out;
}

async function errorText(res: Response): Promise<string> {
  const text = (await res.text().catch(() => "")).trim();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return text.slice(0, 300);
  }
  const body = errorSchema.safeParse(json);
  if (!body.success) return text.slice(0, 300);
  const { error, message, detail } = body.data;
  const msg = typeof error === "string" ? error : (error?.message ?? message ?? detail);
  if (msg === undefined) return text.slice(0, 300);
  return typeof msg === "string" ? msg : JSON.stringify(msg);
}

/** A System One client. Errors are `DecisionError`s whose message says what to fix. */
export function createDecisionModel(options: DecisionClientOptions): DecisionModel {
  const url = systemOneUrl(options.baseUrl);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;

  return {
    label: options.label,
    images: options.images,
    async decide(state: DecisionState, questions: Record<string, Question>, opts: { signal?: AbortSignal } = {}): Promise<Decision> {
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
      const started = performance.now();
      let res: Response;
      try {
        // TypeSafe serves images and Box questions only to requests that opt in with this header.
        const visual = typeof state !== "string" && state.some((part) => typeof part !== "string");
        const send = visual || Object.values(questions).some((q) => q.type === "box") ? { ...headers, "typesafe-danger-zone-images": "true" } : headers;
        res = await fetch(url, { method: "POST", headers: send, body: JSON.stringify({ model: options.model, state, questions }), signal });
      } catch (err) {
        if (opts.signal?.aborted) throw new DecisionError("aborted", `decision request to ${options.label} was cancelled`);
        if (timeout.aborted) throw new DecisionError("timeout", `${options.label} did not answer within ${timeoutMs} ms (${url})`);
        if (connectionRefused(err)) {
          throw new DecisionError(
            "unreachable",
            options.local
              ? `local decision server is not running at ${url}. Start it (Kev: ${KEV_REPO}): ${kevStartCommand(portOf(url))}`
              : `cannot connect to ${url}: ${messageOf(err)}`,
          );
        }
        throw new DecisionError("unreachable", `request to ${url} failed: ${messageOf(err)}`);
      }
      if (!res.ok) {
        const detail = await errorText(res);
        const suffix = detail ? ` (${detail})` : "";
        if (res.status === 401 || res.status === 403) {
          throw new DecisionError("auth", `${options.label} rejected the API key with ${res.status}${suffix}. Set a valid key with \`sculk setup\``, res.status);
        }
        if (res.status === 404) {
          throw new DecisionError("not_found", `${url} answered 404${suffix}. Check the decision model URL and model id (${options.model})`, res.status);
        }
        throw new DecisionError("http", `${options.label} answered ${res.status}${suffix}`, res.status);
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        if (opts.signal?.aborted) throw new DecisionError("aborted", `decision request to ${options.label} was cancelled`);
        if (timeout.aborted) throw new DecisionError("timeout", `${options.label} did not answer within ${timeoutMs} ms (${url})`);
        throw new DecisionError("bad_response", `${url} answered with invalid JSON`);
      }
      const answers = checkAnswers(body, questions, url);
      return { answers, latencyMs: Math.round((performance.now() - started) * 10) / 10 };
    },
  };
}
