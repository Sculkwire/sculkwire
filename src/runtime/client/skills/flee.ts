/**
 * `flee`: get away from threats. Faces the escape direction and sprints (sprint-jumping on open ground, jumping over
 * steps), steering away from the weighted sum of the threats' positions and turning aside when blocked.
 */
import { angleDiff, horizontalDistance } from "../geometry.ts";
import type { PlayerController } from "../player.ts";
import type { EntityInfo } from "../types.ts";
import { navigate } from "../nav/navigate.ts";
import { isHostile, mobInfo } from "./mobs.ts";
import { escapeYaw, isEntityId, typeIdOf } from "./target.ts";
import type { SkillResult } from "./types.ts";

export interface FleeArgs {
  /** Entity id or type to get away from. Default: every hostile mob within 24 blocks. */
  from?: string;
  /** Done once every threat is at least this far (default 12). */
  distance?: number;
  timeoutMs?: number;
}

/** A threat at hand this long while running means the player is cornered: give up so `play` can fight back. */
const CORNERED_MS = 1500;

export async function flee(pc: PlayerController, args: FleeArgs, signal?: AbortSignal): Promise<SkillResult> {
  const h = pc.hands;
  const started = h.now();
  const deadline = started + (args.timeoutMs ?? 8000);
  const want = args.distance ?? 12;
  const from = args.from;
  const fits = (e: EntityInfo) => e.typeId !== "minecraft:player" && (from ? (isEntityId(from) ? e.id === from : e.typeId === typeIdOf(from)) : isHostile(e.typeId));
  const threats = async (): Promise<EntityInfo[]> => {
    if (from && isEntityId(from)) {
      const e = await pc.world.entity(from);
      return e ? [e] : [];
    }
    if (pc.world.entities) return (await pc.world.entities(24)).filter(fits);
    const e = await pc.world.nearest(from ? typeIdOf(from) : undefined, 24);
    return e && fits(e) ? [e] : [];
  };
  let list = await threats();
  if (list.length === 0) return { ok: true, message: "nothing to flee from" };
  let refreshed = h.now();
  let heading = 0;
  let detour = 0;
  let moved = { at: h.now(), x: Number.NaN, z: Number.NaN };
  let lastJump = 0;
  /** Since when a threat has been at hand: running is not working (a corner, a dead end). */
  let caughtSince: number | undefined;
  /** Turns aside since the last free run: after two, plan a path instead. */
  let turns = 0;
  const lookAhead = () => h.look({ widthDeg: 20, aim: () => ({ yaw: heading + detour, pitch: 5 }) });
  lookAhead();
  try {
    for (;;) {
      const now = h.now();
      if (now - refreshed > 300) {
        list = await threats();
        refreshed = now;
      }
      const s = await pc.world.state();
      const nearest = Math.min(...list.map((e) => horizontalDistance(s.location, e.location)));
      if (list.length === 0 || nearest >= want) return { ok: true, message: `got ${list.length ? nearest.toFixed(1) : "away"} blocks from the threat(s) in ${((now - started) / 1000).toFixed(1)} s` };
      if (now > deadline) return { ok: false, message: `still ${nearest.toFixed(1)} blocks from a threat after ${((now - started) / 1000).toFixed(1)} s` };
      if (nearest < 2.5) caughtSince ??= now;
      else caughtSince = undefined;
      if (caughtSince !== undefined && now - caughtSince > CORNERED_MS) return { ok: false, message: `cornered: a threat stayed within 2.5 blocks for ${CORNERED_MS} ms` };
      const away = escapeYaw(
        s.location,
        list.map((e) => ({ location: e.location, weight: 0.3 + mobInfo(e.typeId).damage / 10 })),
      );
      if (away !== undefined) heading = away;
      // Blocked: jump first, then turn aside (alternating sides, wider each time).
      if (!(Math.hypot(s.location.x - moved.x, s.location.z - moved.z) < 0.4)) {
        moved = { at: now, x: s.location.x, z: s.location.z };
        // Free again: drift back toward the straight escape line.
        detour *= 0.9;
        turns = 0;
      } else if (now - moved.at > 350 && s.onGround) {
        await h.jump(120);
        if (now - moved.at > 900) {
          detour = detour <= 0 ? Math.min(120, -detour + 50) : -detour;
          moved = { at: now, x: s.location.x, z: s.location.z };
          turns++;
        }
      }
      if (turns >= 2 && pc.world.query) {
        // Boxed in: find a way over the blocks to a spot 10 blocks along the escape line.
        const rad = (heading * Math.PI) / 180;
        const spot = { x: s.location.x - Math.sin(rad) * 10, z: s.location.z + Math.cos(rad) * 10 };
        await navigate(pc, spot, { radius: 2, timeoutMs: Math.min(4000, Math.max(1000, deadline - now)) }, signal);
        turns = 0;
        detour = 0;
        lookAhead();
        continue;
      }
      const view = pc.camera.view()?.yaw ?? s.rotation.y;
      const aligned = Math.abs(angleDiff(view, heading + detour)) < 35;
      await h.walk(heading + detour, aligned);
      // Sprint-jump on the straight: faster than sprinting alone.
      if (aligned && s.onGround && s.sprinting && now - lastJump > 700) {
        lastJump = now;
        await h.jump(100);
      }
      await h.sleep(25, signal);
    }
  } finally {
    await h.stop();
  }
}
