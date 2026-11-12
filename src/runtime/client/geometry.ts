/** Angles and distances in Bedrock's frame (yaw 0 = +Z, 90 = -X; pitch + looks down). */
import type { Vec3 } from "./types.ts";

/** Signed smallest difference `to - from` in degrees, in (-180, 180]. */
export function angleDiff(from: number, to: number): number {
  const d = (((to - from) % 360) + 540) % 360 - 180;
  return d === -180 ? 180 : d;
}

/** Yaw that faces `to` from `from` (Bedrock: 0 = +Z, 90 = -X). */
export function yawTo(from: Vec3, to: Vec3): number {
  return (Math.atan2(-(to.x - from.x), to.z - from.z) * 180) / Math.PI;
}

/** Pitch that looks from the eye at `to` (+ is down). */
export function pitchTo(eye: Vec3, to: Vec3): number {
  const horizontal = Math.hypot(to.x - eye.x, to.z - eye.z);
  return (-Math.atan2(to.y - eye.y, horizontal) * 180) / Math.PI;
}

export function horizontalDistance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

export function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** The bottom centre of the block cell holding `at`. */
export function blockCenter(at: Vec3): Vec3 {
  return { x: Math.floor(at.x) + 0.5, y: Math.floor(at.y), z: Math.floor(at.z) + 0.5 };
}

/** A block position as a command writes it: `x y z`, each rounded down. */
export function xyz(at: Vec3): string {
  return `${Math.floor(at.x)} ${Math.floor(at.y)} ${Math.floor(at.z)}`;
}
