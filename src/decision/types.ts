/**
 * Decision models (TypeSafe System One API: Jev in the cloud, Kev served locally) answer typed questions about a
 * state with probabilities. They do not generate text. sculkwire uses them as the fast layer of `player_act play`.
 */

export type Question =
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { type: "noul"; instructions: string }
  | { type: "score"; instructions: string; criteria: string[] }
  /** Where something is in an image of the state (needs a model with images). */
  | { type: "box"; instructions: string };

/** Edges of a box as fractions of the image's width (`left`, `right`) and height (`top`, `bottom`). */
export interface BoxEdges {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export type Answer =
  | { type: "choice"; choice: string; confidence?: number; probabilities: Record<string, number> }
  | { type: "noul"; noul: number }
  | { type: "score"; score: number; confidence?: number; probabilities: Record<string, number> }
  | { type: "box"; box: BoxEdges; confidence?: number };

/** Text, or text and images (`data:` URLs), as the API's `state`. Images need a model that accepts them (Jev). */
export type DecisionState = string | (string | { type: "image_url"; image_url: { url: string } })[];

export interface Decision {
  answers: Record<string, Answer>;
  /** Round trip as measured by sculkwire. */
  latencyMs: number;
}

export interface DecisionModel {
  /** Short label for traces and status, e.g. `openrouter typesafe/jev-1.14` or `local kev-latest`. */
  readonly label: string;
  /** True when `state` may contain images. */
  readonly images: boolean;
  decide(state: DecisionState, questions: Record<string, Question>, options?: { signal?: AbortSignal }): Promise<Decision>;
}
