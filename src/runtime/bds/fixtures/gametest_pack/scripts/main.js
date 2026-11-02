// sculkwire GameTest fixture (MIT): one test that passes, one that fails with a known message,
// and `/scriptevent` probes for the debugger: `sculkwire:warn <text>` (console.warn), `sculkwire:throw <text>`
// (uncaught error with a stack frame), `sculkwire:busy <ms>` (CPU work for the profiler).
import { system } from "@minecraft/server";
import { register } from "@minecraft/server-gametest";

register("sculkwire", "passes", (test) => {
  test.succeed();
})
  .structureName("sculkwire:platform")
  .maxTicks(40)
  .tag("sculkwire");

register("sculkwire", "fails", (test) => {
  test.fail("sculkwire fixture: expected failure");
})
  .structureName("sculkwire:platform")
  .maxTicks(40)
  .tag("sculkwire");

function busyWork(ms) {
  const end = Date.now() + ms;
  let x = 0;
  while (Date.now() < end) x += Math.sqrt(x + 1);
  return x;
}

system.afterEvents.scriptEventReceive.subscribe((event) => {
  if (event.id === "sculkwire:warn") console.warn(`sculkwire fixture: ${event.message}`);
  if (event.id === "sculkwire:throw") throw new Error(`sculkwire fixture: ${event.message}`);
  if (event.id === "sculkwire:busy") busyWork(Number(event.message) || 200);
});
