/**
 * Linux: keep the game's audio on a silent PulseAudio/PipeWire sink while sculkwire mutes it.
 *
 * The launch sets PULSE_SINK, but WirePlumber's stream restore remembers a target per application name and that
 * remembered target wins, so the game's streams can still reach the user's real output. `GameMute` therefore watches
 * the sink inputs: every stream whose `application.process.id` is one of the game's pids and that is not on the silent
 * sink is moved there with `pactl move-sink-input`. The stored target can also pull another process onto the silent
 * sink: the user's own Minecraft, started while a muted game runs, shares the application name. A stream of another
 * process found on the silent sink is moved to the default sink (where it would play without sculkwire); every other
 * stream of other processes is never touched, the default sink is never changed, and sculkwire never mutes a stream
 * (`set-sink-input-mute` persists per application name).
 *
 * A move persists in WirePlumber as the application's target. A game sculkwire stops stays on the silent sink until
 * it exited (no sound during the stop); the sink is unloaded afterwards, so the stored target names a sink that no
 * longer exists and the next start falls back to the default output. A game the user opened keeps running after a
 * detach, so `stop({ restore: true })` moves its streams back to the sinks they came from, and WirePlumber stores the
 * user's own target again.
 */
import { errorMessage } from "../../core/errors.ts";

/** Runs `pactl` with these arguments and resolves to its stdout; rejects when it fails. */
export type Pactl = (args: readonly string[]) => Promise<string>;

/** The silent sink's name: the game's streams go here. */
export const MUTE_SINK = "sculkwire_muted_game";

/** How often `GameMute` looks for game streams that are not on the silent sink. */
export const MUTE_SWEEP_MS = 2_000;

export interface SinkInput {
  id: number;
  /** The sink's index, as pactl prints it. */
  sink: string;
  /** `application.process.id`, when the stream has one. */
  pid?: number;
}

export interface Sink {
  index: string;
  name: string;
}

const pidOf = (value: unknown): number | undefined => {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

/** `pactl -f json list sink-inputs`. */
export function parseSinkInputsJson(text: string): SinkInput[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error("pactl printed no list of sink inputs");
  const out: SinkInput[] = [];
  for (const e of parsed as unknown[]) {
    if (!e || typeof e !== "object" || !("index" in e) || !("sink" in e)) continue;
    if (typeof e.index !== "number" || (typeof e.sink !== "number" && typeof e.sink !== "string")) continue;
    const input: SinkInput = { id: e.index, sink: String(e.sink) };
    const props = "properties" in e && e.properties && typeof e.properties === "object" ? e.properties : undefined;
    const pid = props && "application.process.id" in props ? pidOf(props["application.process.id"]) : undefined;
    if (pid !== undefined) input.pid = pid;
    out.push(input);
  }
  return out;
}

/** `pactl list sink-inputs` (the text form, for pactl without `-f json`). */
export function parseSinkInputsText(text: string): SinkInput[] {
  const out: SinkInput[] = [];
  for (const block of text.split(/^(?=Sink Input #)/m)) {
    const id = /^Sink Input #(\d+)/.exec(block)?.[1];
    const sink = /^\s*Sink:\s*(\S+)/m.exec(block)?.[1];
    if (id === undefined || sink === undefined) continue;
    const input: SinkInput = { id: Number(id), sink };
    const pid = pidOf(/^\s*application\.process\.id\s*=\s*"([^"]*)"/m.exec(block)?.[1]);
    if (pid !== undefined) input.pid = pid;
    out.push(input);
  }
  return out;
}

/** `pactl list short sinks`: index, name, module, ... separated by tabs. */
export function parseShortSinks(text: string): Sink[] {
  const out: Sink[] = [];
  for (const line of text.split("\n")) {
    const [index, name] = line.split("\t");
    if (index && name && /^\d+$/.test(index.trim())) out.push({ index: index.trim(), name: name.trim() });
  }
  return out;
}

export async function listSinkInputs(pactl: Pactl): Promise<SinkInput[]> {
  try {
    return parseSinkInputsJson(await pactl(["-f", "json", "list", "sink-inputs"]));
  } catch {
    // pactl before 16 has no `-f json`.
    return parseSinkInputsText(await pactl(["list", "sink-inputs"]));
  }
}

export async function listSinks(pactl: Pactl): Promise<Sink[]> {
  return parseShortSinks(await pactl(["list", "short", "sinks"]));
}

/** Load the silent sink; resolves to the module id to unload later. */
export async function loadMuteSink(pactl: Pactl): Promise<number> {
  const out = await pactl(["load-module", "module-null-sink", `sink_name=${MUTE_SINK}`, "sink_properties=device.description=sculkwire-muted-game"]);
  const id = Number(out.trim());
  if (!Number.isInteger(id)) throw new Error(`pactl load-module printed no module id: ${out.trim()}`);
  return id;
}

const pactlError = (e: unknown): string =>
  e && typeof e === "object" && "code" in e && e.code === "ENOENT" ? "pactl is not installed" : errorMessage(e).split("\n")[0]!;

/** Keeps the game's streams on the silent sink until `stop`, which moves them back (see the file comment). */
export class GameMute {
  readonly #pactl: Pactl;
  readonly #pids: () => Promise<number[]>;
  /** Sink input id -> the name of the sink it was on before sculkwire moved it (undefined: that sink was unknown). */
  readonly #moved = new Map<number, string | undefined>();
  /** The silent sink's module when this watcher loaded it (an attached game); `stop` unloads it. */
  #module?: number;
  #note?: string;
  #timer?: NodeJS.Timeout;
  #sweep?: Promise<void>;
  #stopped = false;

  constructor(pactl: Pactl, pids: () => Promise<number[]>) {
    this.#pactl = pactl;
    this.#pids = pids;
  }

  /** Why the game's sound may reach the speakers, from the newest sweep; undefined while the mute holds. */
  get note(): string | undefined {
    return this.#note;
  }

  /** Sweep once, then every `intervalMs` until `stop`. */
  async start(intervalMs = MUTE_SWEEP_MS): Promise<void> {
    await this.sweep();
    if (this.#stopped) return;
    this.#timer = setInterval(() => void this.sweep(), intervalMs);
    this.#timer.unref();
  }

  /** Move every game stream that is not on the silent sink there. Sweeps never overlap. */
  sweep(): Promise<void> {
    this.#sweep ??= this.#run().finally(() => {
      this.#sweep = undefined;
    });
    return this.#sweep;
  }

  async #run(): Promise<void> {
    if (this.#stopped) return;
    let sinks: Sink[];
    try {
      sinks = await listSinks(this.#pactl);
      if (!sinks.some((s) => s.name === MUTE_SINK)) {
        this.#module = await loadMuteSink(this.#pactl);
        sinks = await listSinks(this.#pactl);
      }
    } catch (e) {
      this.#note = `could not create the silent sink (${pactlError(e)}); the game's sound plays normally`;
      return;
    }
    const muted = sinks.find((s) => s.name === MUTE_SINK);
    if (!muted) {
      this.#note = `the silent sink ${MUTE_SINK} did not appear; the game's sound plays normally`;
      return;
    }
    let inputs: SinkInput[];
    let pids: Set<number>;
    try {
      [inputs, pids] = await Promise.all([listSinkInputs(this.#pactl), this.#pids().then((p) => new Set(p))]);
    } catch (e) {
      this.#note = `could not list the audio streams (${pactlError(e)}); the game's sound may play normally`;
      return;
    }
    const failed: string[] = [];
    for (const input of inputs) {
      if (input.pid === undefined) continue;
      if (!pids.has(input.pid)) {
        // Not the game's: off the silent sink, onto the output it would have played on without sculkwire. Only while
        // the game's pids are known: before the game is found, or after its process is gone while its streams linger,
        // the set is empty and every stream would look foreign, the game's own included.
        if (pids.size > 0 && !this.#stopped && input.sink === muted.index) {
          await this.#pactl(["move-sink-input", String(input.id), "@DEFAULT_SINK@"]).catch(() => undefined);
        }
        continue;
      }
      if (input.sink === muted.index) continue;
      if (this.#stopped) return;
      try {
        await this.#pactl(["move-sink-input", String(input.id), MUTE_SINK]);
        if (!this.#moved.has(input.id)) this.#moved.set(input.id, sinks.find((s) => s.index === input.sink)?.name);
      } catch (e) {
        failed.push(`stream #${input.id} (${pactlError(e)})`);
      }
    }
    this.#note = failed.length ? `could not move the game's audio to the silent sink: ${failed.join(", ")}; its sound plays normally` : undefined;
  }

  /**
   * Stop sweeping and unload the silent sink when this watcher loaded it. A game sculkwire stopped: call this once it
   * exited, without `restore`. A game that keeps running (a detach): `restore` first moves each stream it moved back
   * to its original sink; a stream whose original sink is gone stays, and WirePlumber falls back to the default sink.
   */
  async stop(opts: { restore: boolean }): Promise<void> {
    this.#stopped = true;
    clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#sweep;
    if (opts.restore && this.#moved.size) {
      const [inputs, sinks] = await Promise.all([listSinkInputs(this.#pactl), listSinks(this.#pactl)]).catch(() => [[], []] as [SinkInput[], Sink[]]);
      for (const input of inputs) {
        if (!this.#moved.has(input.id)) continue;
        const original = this.#moved.get(input.id);
        if (original === undefined || !sinks.some((s) => s.name === original)) continue;
        await this.#pactl(["move-sink-input", String(input.id), original]).catch(() => undefined);
      }
    }
    this.#moved.clear();
    if (this.#module !== undefined) {
      await this.#pactl(["unload-module", String(this.#module)]).catch(() => undefined);
      this.#module = undefined;
    }
  }
}
