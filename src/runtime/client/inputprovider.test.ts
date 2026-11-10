import { describe, expect, it } from "vitest";
import { inputProvider, registerInputProvider, type InputProvider } from "./inputprovider.ts";

function fakeProvider(name: string): InputProvider {
  return {
    name,
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
    close: () => undefined,
  };
}

describe("input provider registry", () => {
  it("has none by default, holds one at a time and removes it again", () => {
    expect(inputProvider()).toBeUndefined();
    const first = fakeProvider("first");
    const remove = registerInputProvider(first);
    expect(inputProvider()).toBe(first);
    expect(() => registerInputProvider(fakeProvider("second"))).toThrow(/already installed \(first\)/);
    remove();
    expect(inputProvider()).toBeUndefined();
  });
});
