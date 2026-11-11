import { createRequire } from "node:module";

const pkg = createRequire(import.meta.url)("../../package.json") as { version: string };

export const VERSION: string = pkg.version;

/** The home repository on GitHub (`owner/name`); GitLab carries a read-only mirror. */
export const REPO_SLUG = "Sculkwire/sculkwire";
export const REPO_URL = `https://github.com/${REPO_SLUG}`;
/** The User-Agent of every HTTP request sculkwire makes. */
export const USER_AGENT = `sculkwire/${VERSION} (+${REPO_URL})`;
