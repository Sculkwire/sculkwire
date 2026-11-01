/**
 * Minecraft Script Debugger protocol messages, after Mojang/minecraft-debugger `src/protocol-events.ts` (MIT).
 * Version history: 1 initial, 2 targetModuleUuid, 3 plugin list/target selection, 4 passcode, 5 profiler captures,
 * 6 breakpoints as request, 7 debugger requests, 8 Cereal serialization (flat outgoing payloads),
 * 9 native stat descriptors, 10 empty tabs, 11 per-tab diagnostics activation.
 */

export const PROTOCOL = {
  SupportTargetModuleUuid: 2,
  SupportTargetSelection: 3,
  SupportPasscode: 4,
  SupportProfilerCaptures: 5,
  SupportBreakpointsAsRequest: 6,
  SupportDebuggerRequests: 7,
  SupportCerealSerialization: 8,
  SupportNativeDescriptors: 9,
  SupportEmptyTabs: 10,
  SupportDiagnosticsSetActive: 11,
} as const;

/** Highest protocol version this implementation speaks. */
export const MAX_PROTOCOL_VERSION = PROTOCOL.SupportDiagnosticsSetActive;

/** Default port of `script debugger listen` / `/script debugger connect`. */
export const DEFAULT_DEBUGGER_PORT = 19144;

export interface PluginDetails {
  name: string;
  module_uuid: string;
}

export interface ProtocolEventMessage {
  type: "ProtocolEvent";
  version: number;
  plugins?: PluginDetails[];
  require_passcode?: boolean;
}

/** vscode-debugadapter LogLevel numbering used by Minecraft prints: 0 verbose, 1 log, 2 warn, 3 error, 4 stop. */
export type PrintLevel = "verbose" | "log" | "warn" | "error" | "stop";
export const PRINT_LEVELS: readonly PrintLevel[] = ["verbose", "log", "warn", "error", "stop"];

export interface StatDataModel {
  name: string;
  children?: StatDataModel[];
  /** Last value is this tick's; earlier ones are previous ticks. */
  values?: (number | string)[];
  should_aggregate: boolean;
}

export interface StatEventMessage {
  type: "StatEvent2";
  tick: number;
  stats: StatDataModel[];
}

export interface ProfilerCaptureMessage {
  type: "ProfilerCapture";
  capture_base_path: string;
  /** Base64 of a V8 `.cpuprofile` JSON document. */
  capture_data: string;
}
