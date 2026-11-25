/**
 * A fake `pactl` for mute tests: sinks and sink inputs in memory, answering the commands `GameMute` and the launcher
 * run, recording every call. Unknown commands reject, so a test fails on any pactl call it did not expect.
 */
import { MUTE_SINK, type Pactl } from "../runtime/client/mute.ts";

export interface FakeSinkInput {
  id: number;
  /** Sink index. */
  sink: string;
  pid: number;
}

export class FakePactl {
  sinks: { index: string; name: string; module?: number }[] = [{ index: "1", name: "speakers" }];
  inputs: FakeSinkInput[] = [];
  calls: string[][] = [];
  /** `-f json` is unknown (pactl before 16): only the text form answers. */
  noJson = false;
  /** Every `move-sink-input` fails, as for a stream the server refuses to move. */
  failMoves = false;
  /** pactl is not installed: every call rejects with ENOENT. */
  missing = false;
  #nextModule = 42;
  #nextSink = 5;

  readonly run: Pactl = async (args) => {
    this.calls.push([...args]);
    if (this.missing) throw Object.assign(new Error("spawn pactl ENOENT"), { code: "ENOENT" });
    const cmd = args.join(" ");
    if (cmd === "list short sinks") return this.sinks.map((s) => `${s.index}\t${s.name}\tPipeWire\tfloat32le 2ch 48000Hz\tRUNNING`).join("\n") + "\n";
    if (cmd === "-f json list sink-inputs") {
      if (this.noJson) throw new Error("pactl: unrecognized option '-f'");
      return JSON.stringify(this.inputs.map((i) => ({ index: i.id, sink: Number(i.sink), properties: { "application.process.id": String(i.pid) } })));
    }
    if (cmd === "list sink-inputs") {
      return this.inputs
        .map((i) => `Sink Input #${i.id}\n\tDriver: PipeWire\n\tSink: ${i.sink}\n\tMute: no\n\tProperties:\n\t\tapplication.name = "Minecraft"\n\t\tapplication.process.id = "${i.pid}"\n`)
        .join("\n");
    }
    if (args[0] === "load-module" && args[1] === "module-null-sink" && args[2] === `sink_name=${MUTE_SINK}`) {
      const module = this.#nextModule++;
      this.sinks.push({ index: String(this.#nextSink++), name: MUTE_SINK, module });
      return `${module}\n`;
    }
    if (args[0] === "unload-module") {
      this.sinks = this.sinks.filter((s) => s.module !== Number(args[1]));
      return "";
    }
    if (args[0] === "move-sink-input") {
      if (this.failMoves) throw new Error("Failure: No such entity");
      const input = this.inputs.find((i) => i.id === Number(args[1]));
      // `@DEFAULT_SINK@` is the first sink, the user's output.
      const sink = args[2] === "@DEFAULT_SINK@" ? this.sinks[0] : this.sinks.find((s) => s.name === args[2] || s.index === args[2]);
      if (!input || !sink) throw new Error("Failure: No such entity");
      input.sink = sink.index;
      return "";
    }
    throw new Error(`unexpected pactl ${cmd}`);
  };

  /** The sink a stream is on, by name. */
  sinkOf(id: number): string | undefined {
    const input = this.inputs.find((i) => i.id === id);
    return this.sinks.find((s) => s.index === input?.sink)?.name;
  }

  /** The calls whose first argument is `verb`. */
  callsOf(verb: string): string[][] {
    return this.calls.filter((c) => c[0] === verb);
  }
}
