import { world } from "@minecraft/server";
import { ActionFormData } from "@minecraft/server-ui";

world.afterEvents.worldLoad.subscribe(() => {
  world.notAFunction("x");
  new ActionFormData().title("hi");
});
