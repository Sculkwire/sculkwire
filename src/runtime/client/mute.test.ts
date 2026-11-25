/**
 * `GameMute` against a fake pactl: only the game's own streams move to the silent sink, a refused move is reported
 * (never muted instead), and `stop` moves the streams back to their own output, unloads only a sink it loaded and
 * ends the sweeps.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { FakePactl } from "../../testing/fakepactl.ts";
import { GameMute, MUTE_SINK, parseShortSinks, parseSinkInputsText } from "./mute.ts";

const GAME = 100;
const OTHER = 200;

function withStreams(): FakePactl {
  const pactl = new FakePactl();
  pactl.sinks.push({ index: "2", name: "headphones" });
  pactl.inputs = [
    { id: 7, sink: "1", pid: GAME },
    { id: 8, sink: "1", pid: OTHER },
    { id: 9, sink: "2", pid: GAME },
  ];
  return pactl;
}

describe("GameMute", () => {
  it("moves the game's streams onto the silent sink it loads, and leaves other apps' streams alone", async () => {
    const pactl = withStreams();
    const mute = new GameMute(pactl.run, async () => [GAME]);
    await mute.sweep();
    expect(pactl.callsOf("load-module")).toHaveLength(1);
    expect(pactl.sinkOf(7)).toBe(MUTE_SINK);
    expect(pactl.sinkOf(9)).toBe(MUTE_SINK);
    expect(pactl.sinkOf(8)).toBe("speakers");
    expect(pactl.callsOf("move-sink-input").map((c) => c[1])).toEqual(["7", "9"]);
    expect(mute.note).toBeUndefined();
    // A stream already on the silent sink is not moved again.
    await mute.sweep();
    expect(pactl.callsOf("move-sink-input")).toHaveLength(2);
    await mute.stop({ restore: false });
  });

  it("uses the sink the launch loaded, and does not unload it", async () => {
    const pactl = withStreams();
    pactl.sinks.push({ index: "5", name: MUTE_SINK, module: 30 });
    const mute = new GameMute(pactl.run, async () => [GAME]);
    await mute.sweep();
    await mute.stop({ restore: false });
    expect(pactl.callsOf("load-module")).toEqual([]);
    expect(pactl.callsOf("unload-module")).toEqual([]);
  });

  it("reads the text form when pactl has no -f json", async () => {
    const pactl = withStreams();
    pactl.noJson = true;
    const mute = new GameMute(pactl.run, async () => [GAME]);
    await mute.sweep();
    expect(pactl.sinkOf(7)).toBe(MUTE_SINK);
    expect(pactl.sinkOf(8)).toBe("speakers");
    await mute.stop({ restore: false });
  });

  it("reports a stream that would not move, and never mutes it instead", async () => {
    const pactl = withStreams();
    pactl.failMoves = true;
    const mute = new GameMute(pactl.run, async () => [GAME]);
    await mute.sweep();
    expect(mute.note).toMatch(/could not move the game's audio to the silent sink: stream #7 .*stream #9/);
    expect(pactl.calls.some((c) => c[0] === "set-sink-input-mute")).toBe(false);
    expect(pactl.sinkOf(7)).toBe("speakers");
    // Once the move works, the note goes.
    pactl.failMoves = false;
    await mute.sweep();
    expect(mute.note).toBeUndefined();
    await mute.stop({ restore: false });
  });

  it("says when pactl is missing", async () => {
    const pactl = new FakePactl();
    pactl.missing = true;
    const mute = new GameMute(pactl.run, async () => [GAME]);
    await mute.start(10);
    expect(mute.note).toBe("could not create the silent sink (pactl is not installed); the game's sound plays normally");
    await mute.stop({ restore: false });
  });

  it("restore moves each stream back to the sink it came from; stop unloads the sink it loaded and ends the sweeps", async () => {
    const pactl = withStreams();
    const mute = new GameMute(pactl.run, async () => [GAME]);
    await mute.start(10);
    expect(pactl.sinkOf(7)).toBe(MUTE_SINK);
    await mute.stop({ restore: true });
    expect(pactl.sinkOf(7)).toBe("speakers");
    expect(pactl.sinkOf(9)).toBe("headphones");
    expect(pactl.sinkOf(8)).toBe("speakers");
    expect(pactl.callsOf("unload-module")).toEqual([["unload-module", "42"]]);
    expect(pactl.sinks.some((s) => s.name === MUTE_SINK)).toBe(false);
    const calls = pactl.calls.length;
    await sleep(50);
    expect(pactl.calls.length).toBe(calls);
  });

  it("without restore moves nothing back (the game is gone), and still unloads the sink it loaded", async () => {
    const pactl = withStreams();
    const mute = new GameMute(pactl.run, async () => [GAME]);
    await mute.sweep();
    const moves = pactl.callsOf("move-sink-input").length;
    await mute.stop({ restore: false });
    expect(pactl.callsOf("move-sink-input")).toHaveLength(moves);
    expect(pactl.callsOf("unload-module")).toEqual([["unload-module", "42"]]);
  });

  it("on restore leaves a stream whose own sink is gone where it is", async () => {
    const pactl = withStreams();
    const mute = new GameMute(pactl.run, async () => [GAME]);
    await mute.sweep();
    pactl.sinks = pactl.sinks.filter((s) => s.name !== "headphones");
    await mute.stop({ restore: true });
    expect(pactl.sinkOf(7)).toBe("speakers");
    expect(pactl.callsOf("move-sink-input").filter((c) => c[1] === "9")).toHaveLength(1);
  });
});

describe("pactl output", () => {
  it("parses the text list of sink inputs and the short list of sinks", () => {
    const text = 'Sink Input #12\n\tDriver: PipeWire\n\tSink: 3\n\tProperties:\n\t\tapplication.process.id = "4321"\n\nSink Input #13\n\tSink: 4\n\tProperties:\n\t\tmedia.name = "x"\n';
    expect(parseSinkInputsText(text)).toEqual([
      { id: 12, sink: "3", pid: 4321 },
      { id: 13, sink: "4" },
    ]);
    expect(parseShortSinks("3\talsa_output.pci\tPipeWire\ts32le 2ch 48000Hz\tSUSPENDED\n")).toEqual([{ index: "3", name: "alsa_output.pci" }]);
  });
});
