/** Installed BDS builds as a knowledge store source: `sculk knowledge update` updates them, `knowledge status` lists them. */
import type { StoreSource } from "../../knowledge/store.ts";
import { listInstalled, updateBds } from "./install.ts";

export const bdsStoreSource: StoreSource = {
  source: "BDS",
  step: "bds",
  update: async (channel, progress) => (await updateBds(channel, progress))?.version ?? "not installed",
  inUse: async (channel) => (await listInstalled(channel))[0]?.version,
  latest: (pin) => pin?.bds?.version,
};
