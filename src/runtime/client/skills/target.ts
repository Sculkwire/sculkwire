/** Naming a target: an entity id or a mob type, and the way away from a set of threats. */
import { horizontalDistance, yawTo } from "../geometry.ts";
import type { Vec3 } from "../types.ts";

/** An entity id (the script `Entity.id`, a signed integer) rather than a type name. */
export function isEntityId(s: string): boolean {
  return /^-?\d+$/.test(s);
}

export function typeIdOf(type: string): string {
  return type.includes(":") ? type : `minecraft:${type}`;
}

/** The yaw that points away from the threats, the nearest and most dangerous weighing most. */
export function escapeYaw(me: Vec3, threats: readonly { location: Vec3; weight: number }[]): number | undefined {
  let x = 0;
  let z = 0;
  for (const t of threats) {
    const d = Math.max(0.5, horizontalDistance(me, t.location));
    x += ((me.x - t.location.x) / d) * (t.weight / (d * d));
    z += ((me.z - t.location.z) / d) * (t.weight / (d * d));
  }
  if (Math.hypot(x, z) < 1e-9) return undefined;
  return yawTo(me, { x: me.x + x, y: me.y, z: me.z + z });
}
