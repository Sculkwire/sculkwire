import { describe, expect, it } from "vitest";
import { runShutdown } from "../../core/shutdown.ts";
import { inputProvider, registerInputProvider, setBuiltinInputProvider, type InputProvider } from "./inputprovider.ts";

function fakeProvider(name: string): InputProvider & { closed: number } {
  const provider = {
    name,
    closed: 0,
    input: {
      prepare: async () => undefined,
      reachable: async () => true,
      look: async () => undefined,
      move: async () => undefined,
      release: async () => undefined,
      attack: async () => null,
      use: async () => undefined,
    },
    motion: () => undefined,
    pausedReason: () => undefined,
    hold: async () => async () => undefined,
    attach: async () => undefined,
    launched: async () => undefined,
    stopped: async () => undefined,
    close: () => {
      provider.closed++;
    },
  };
  return provider;
}

describe("input provider registry", () => {
  it("is the built-in provider by default and none without one", () => {
    expect(inputProvider()).toBeUndefined();
    const agent = fakeProvider("agent");
    setBuiltinInputProvider(agent);
    expect(inputProvider()).toBe(agent);
    setBuiltinInputProvider(undefined);
    expect(inputProvider()).toBeUndefined();
  });

  it("lets an extension provider replace the built-in one, and falls back when it is removed", () => {
    const agent = fakeProvider("agent");
    const mine = fakeProvider("mine");
    setBuiltinInputProvider(agent);
    const remove = registerInputProvider(mine);
    expect(inputProvider()).toBe(mine);
    remove();
    expect(inputProvider()).toBe(agent);
    setBuiltinInputProvider(undefined);
  });

  it("replaces an earlier extension provider, whose removal changes nothing", () => {
    const agent = fakeProvider("agent");
    const first = fakeProvider("first");
    const second = fakeProvider("second");
    setBuiltinInputProvider(agent);
    const removeFirst = registerInputProvider(first);
    expect(inputProvider()).toBe(first);
    const removeSecond = registerInputProvider(second);
    expect(inputProvider()).toBe(second);
    removeFirst();
    expect(inputProvider()).toBe(second);
    removeSecond();
    expect(inputProvider()).toBe(agent);
    setBuiltinInputProvider(undefined);
    expect(inputProvider()).toBeUndefined();
  });

  // Last in the file: the process runs its shutdown hooks only once.
  it("closes the provider in use and the built-in one once when the process shuts down", async () => {
    const agent = fakeProvider("agent");
    const mine = fakeProvider("mine");
    setBuiltinInputProvider(agent);
    registerInputProvider(mine);
    await runShutdown();
    await runShutdown();
    expect(mine.closed).toBe(1);
    expect(agent.closed).toBe(1);
  });
});
