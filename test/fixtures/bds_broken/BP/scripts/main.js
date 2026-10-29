import { world } from "@minecraft/server";

world.afterEvents.worldLoad.subscribe(() => {
  world.sendMessage("mcbe fixture loaded");
});

throw new Error("mcbe fixture: deliberate script error");
