/** Measured Bedrock player facts that the controller, the skills, the task steps and the fight simulator share. */

/** The player's eye above the feet (Bedrock, standing). */
export const EYE_HEIGHT = 1.62;
/**
 * Player melee reach as a horizontal centre distance on level ground: measured on retail a swing struck at 3.0 and never
 * at 3.1 (see `STRIKE_REACH` in `skills/pack.ts` for the table).
 */
export const PLAYER_REACH = 3.0;
/** Walking speed in blocks per second (measured 4.32, the same in every direction, backward too). */
export const WALK_SPEED = 4.32;
