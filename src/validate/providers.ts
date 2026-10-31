import { ensureRockideSchemas } from "../knowledge/rockide.ts";
import { ensureBedrockSamples } from "../knowledge/samples.ts";
import { ensureTypings } from "../knowledge/typings.ts";
import { validateDefaults } from "./index.ts";

/**
 * Feed the validator from the knowledge cache: vanilla samples (engine schemas, command list, calibration),
 * rockide/schemas (newest release, checked at most daily) and the `@minecraft/*` typings matching each pack's
 * manifest. A failed fetch degrades to the remaining schema source.
 */
export function useKnowledgeProviders(): void {
  validateDefaults.resolveSamples = async (channel) => {
    try {
      return (await ensureBedrockSamples({ channel })).root;
    } catch (err) {
      process.stderr.write(`sculkwire: vanilla samples unavailable (${(err as Error).message}); using rockide schemas only\n`);
      return undefined;
    }
  };
  validateDefaults.resolveRockide = async () => {
    try {
      const r = await ensureRockideSchemas();
      const used = { root: r.root, release: r.release, commit: r.commit, latest: r.latest };
      return r.stale ? { ...used, note: `cached release ${r.release}; update failed: ${r.stale}` } : used;
    } catch (err) {
      const note = `unavailable (${(err as Error).message}); using engine schemas only`;
      process.stderr.write(`sculkwire: rockide/schemas ${note}\n`);
      return { note };
    }
  };
  validateDefaults.resolveTypings = async (modules, channel) => {
    try {
      return (await ensureTypings({ channel, modules })).nodeModulesDir;
    } catch (err) {
      process.stderr.write(`sculkwire: Script API typings unavailable (${(err as Error).message})\n`);
      return undefined;
    }
  };
}
