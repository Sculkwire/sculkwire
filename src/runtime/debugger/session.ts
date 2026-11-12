/**
 * Minecraft Script Debugger client (protocol of Mojang/minecraft-debugger, MIT). Two ways to attach:
 * - `connectTo(host, port)`: BDS `script debugger listen <port>` (needs `allow-inbound-script-debugging=true`).
 * - `listen(port)`: we accept; the game dials in with `/script debugger connect <host> <port>`.
 * The session negotiates the protocol version, answers the passcode, resumes the game whenever it reports a stop,
 * and surfaces prints (with `file:line`), stats, profiler captures and notifications as events.
 */
import { EventEmitter } from "node:events";
import { createConnection, createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { encodeFrame, FrameDecoder } from "./framing.ts";
import { parseLocations } from "../gamelog/frames.ts";
import type { PrintEvent } from "./print.ts";
import {
  MAX_PROTOCOL_VERSION,
  PRINT_LEVELS,
  PROTOCOL,
  type PluginDetails,
  type ProfilerCaptureMessage,
  type ProtocolEventMessage,
  type StatEventMessage,
} from "./protocol.ts";
import { decodeCapture, type CpuProfile } from "./profile.ts";

export interface SessionOptions {
  /** Script module uuid (manifest `modules[].uuid` of the script module) to attach to. Default: first plugin. */
  targetModuleUuid?: string;
  /** Answer when the game requires a passcode (`script debugger listen <port> <passcode>`). */
  passcode?: string;
  /** Keep this many prints in memory for `prints(since)`. */
  printBuffer?: number;
}

export interface NotificationEvent {
  message: string;
  level: string;
}

export interface ProtocolInfo {
  /** Version the game announced. */
  gameVersion: number;
  /** Version we answered with (min of both). */
  version: number;
  plugins: PluginDetails[];
  targetModuleUuid?: string;
  requirePasscode: boolean;
}

export interface ProfilerCapture {
  basePath: string;
  profile: CpuProfile;
}

/** Event map: `print`, `notification`, `stat`, `profilerCapture`, `protocol`, `stopped`, `message`, `close`, `error`. */
export class DebuggerSession extends EventEmitter {
  #socket: Socket;
  #decoder = new FrameDecoder();
  #opts: SessionOptions;
  #seq = 0;
  #prints: PrintEvent[] = [];
  #ready: PromiseWithResolvers<ProtocolInfo> = Promise.withResolvers<ProtocolInfo>();
  #closed = false;
  info?: ProtocolInfo;
  lastStats?: StatEventMessage;

  constructor(socket: Socket, opts: SessionOptions = {}) {
    super();
    this.#socket = socket;
    this.#opts = opts;
    // Avoid unhandled rejection when nobody awaits `ready` before the socket dies.
    this.#ready.promise.catch(() => {});
    socket.on("data", (chunk: Buffer) => {
      let messages: unknown[];
      try {
        messages = this.#decoder.push(chunk);
      } catch (err) {
        this.emit("error", err);
        socket.destroy();
        return;
      }
      for (const m of messages) this.#receive(m);
    });
    socket.on("error", (err) => {
      if (this.listenerCount("error") > 0) this.emit("error", err);
    });
    socket.on("close", () => {
      this.#closed = true;
      this.#ready.reject(new Error("debugger connection closed before the protocol handshake"));
      this.emit("close");
    });
  }

  /** Resolves after the protocol handshake. */
  get ready(): Promise<ProtocolInfo> {
    return this.#ready.promise;
  }

  get closed(): boolean {
    return this.#closed;
  }

  get protocolVersion(): number {
    return this.info?.version ?? 0;
  }

  /** Prints with `seq > since`. */
  prints(since = 0): PrintEvent[] {
    return this.#prints.filter((p) => p.seq > since);
  }

  send(message: Record<string, unknown>): void {
    if (!this.#closed) this.#socket.write(encodeFrame(message));
  }

  #receive(envelope: unknown): void {
    this.emit("message", envelope);
    if (!envelope || typeof envelope !== "object" || !("type" in envelope) || envelope.type !== "event") return;
    if (!("event" in envelope) || !envelope.event || typeof envelope.event !== "object") return;
    const event = envelope.event as { type?: unknown } & Record<string, unknown>;
    switch (event.type) {
      case "ProtocolEvent":
        this.#handshake(event as unknown as ProtocolEventMessage);
        break;
      case "PrintEvent": {
        const message = String(event.message ?? "").replace(/[\r\n]+$/, "");
        const level = PRINT_LEVELS[Number(event.logLevel)] ?? "log";
        const print: PrintEvent = { seq: ++this.#seq, time: Date.now(), level, message };
        const [location] = parseLocations(message);
        if (location) print.location = location;
        this.#prints.push(print);
        const max = this.#opts.printBuffer ?? 5000;
        if (this.#prints.length > max) this.#prints.splice(0, this.#prints.length - max);
        this.emit("print", print);
        break;
      }
      case "NotificationEvent":
        this.emit("notification", {
          message: String(event.message ?? ""),
          level: PRINT_LEVELS[Number(event.logLevel)] ?? "log",
        } satisfies NotificationEvent);
        break;
      case "StatEvent2":
        this.lastStats = event as unknown as StatEventMessage;
        this.emit("stat", this.lastStats);
        break;
      case "ProfilerCapture": {
        const msg = event as unknown as ProfilerCaptureMessage;
        try {
          this.emit("profilerCapture", { basePath: msg.capture_base_path, profile: decodeCapture(msg.capture_data) } satisfies ProfilerCapture);
        } catch (err) {
          if (this.listenerCount("error") > 0) this.emit("error", err);
        }
        break;
      }
      case "StoppedEvent":
        // We are not an interactive debugger: never leave the game paused.
        this.emit("stopped", event);
        this.send({ type: "resume" });
        break;
      default:
        break;
    }
  }

  #handshake(event: ProtocolEventMessage): void {
    const gameVersion = Number(event.version) || 1;
    const version = Math.min(gameVersion, MAX_PROTOCOL_VERSION);
    const plugins = Array.isArray(event.plugins) ? event.plugins : [];
    const wanted = this.#opts.targetModuleUuid?.toLowerCase();
    const target =
      version >= PROTOCOL.SupportTargetSelection
        ? (plugins.find((p) => p.module_uuid.toLowerCase() === wanted) ?? plugins[0])?.module_uuid
        : undefined;
    const info: ProtocolInfo = { gameVersion, version, plugins, requirePasscode: event.require_passcode === true };
    if (target) info.targetModuleUuid = target;
    this.info = info;
    const reply: Record<string, unknown> = { type: "protocol", version };
    if (target) reply.target_module_uuid = target;
    if (this.#opts.passcode !== undefined) reply.passcode = this.#opts.passcode;
    this.send(reply);
    // Like the VS Code extension's configurationDone: the game holds script execution after an attach (at
    // auto-attach, until this arrives). Without a script target BDS logs these as "unhandled": harmless.
    this.send({ type: "stopOnException", stopOnException: false });
    this.send({ type: "resume" });
    this.emit("protocol", info);
    this.#ready.resolve(info);
  }

  /**
   * Run a command in the game. No direct reply: the game echoes `Executing command [<cmd>]` as a print, then
   * prints the command's own output (or `Syntax error: …`); collect `print` events after the echo for output.
   */
  command(commandLine: string, dimension = "overworld"): void {
    const command = commandLine.replace(/^\//, "");
    const v = this.protocolVersion;
    if (v < PROTOCOL.SupportProfilerCaptures || v >= PROTOCOL.SupportCerealSerialization) {
      this.send({ type: "minecraftCommand", command, dimension_type: dimension });
    } else {
      this.send({ type: "minecraftCommand", command: { command, dimension_type: dimension } });
    }
  }

  startProfiler(): void {
    this.#requireVersion(PROTOCOL.SupportProfilerCaptures, "profiler");
    const target = this.info?.targetModuleUuid;
    if (this.protocolVersion >= PROTOCOL.SupportCerealSerialization) this.send({ type: "startProfiler", target_module_uuid: target });
    else this.send({ type: "startProfiler", profiler: { target_module_uuid: target } });
  }

  /** Stop the profiler and wait for the capture the game sends back. */
  async stopProfiler(capturesPath = "", timeoutMs = 30_000): Promise<ProfilerCapture> {
    this.#requireVersion(PROTOCOL.SupportProfilerCaptures, "profiler");
    const { promise, resolve, reject } = Promise.withResolvers<ProfilerCapture>();
    const timer = setTimeout(() => {
      this.off("profilerCapture", resolve);
      reject(new Error(`no profiler capture within ${timeoutMs} ms`));
    }, timeoutMs);
    this.once("profilerCapture", (c: ProfilerCapture) => {
      clearTimeout(timer);
      resolve(c);
    });
    const target = this.info?.targetModuleUuid;
    if (this.protocolVersion >= PROTOCOL.SupportCerealSerialization) {
      this.send({ type: "stopProfiler", captures_path: capturesPath, target_module_uuid: target });
    } else {
      this.send({ type: "stopProfiler", profiler: { captures_path: capturesPath, target_module_uuid: target } });
    }
    return promise;
  }

  /** Enable/disable diagnostics stat collectors (protocol >= 11). */
  setDiagnosticsActive(collectorNames: string[], active: boolean): void {
    this.#requireVersion(PROTOCOL.SupportDiagnosticsSetActive, "diagnostics-set-active");
    this.send({ type: "diagnostics-set-active", collector_names: collectorNames, active });
  }

  #requireVersion(min: number, feature: string): void {
    if (this.protocolVersion < min) {
      throw new Error(`${feature} needs debugger protocol >= ${min}; the game speaks ${this.protocolVersion}`);
    }
  }

  close(): void {
    this.#socket.end();
    this.#socket.destroy();
  }
}

export interface ConnectOptions extends SessionOptions {
  /** Keep retrying until this many ms passed (the game's listener may not be up yet). */
  timeoutMs?: number;
}

/** Connect to a game that listens (`script debugger listen <port>`); resolves after the handshake. */
export async function connectTo(host: string, port: number, opts: ConnectOptions = {}): Promise<DebuggerSession> {
  const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
  let lastError: unknown;
  while (Date.now() < deadline) {
    const { promise, resolve, reject } = Promise.withResolvers<Socket>();
    const socket = createConnection({ host, port });
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
    try {
      await promise;
      socket.removeAllListeners("error");
      const session = new DebuggerSession(socket, opts);
      const timer = setTimeout(() => socket.destroy(), Math.max(1000, deadline - Date.now()));
      try {
        await session.ready;
      } finally {
        clearTimeout(timer);
      }
      return session;
    } catch (err) {
      lastError = err;
      socket.destroy();
      // `script debugger listen` keeps its socket open only briefly: retry fast.
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`could not attach the script debugger at ${host}:${port}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

export interface DebuggerListener {
  /** Bound port (useful with port 0). */
  port: number;
  server: Server;
  /** Next game connection, after its handshake. Rejects once the listener is closed. */
  accept(timeoutMs?: number): Promise<DebuggerSession>;
  /** Stop listening, close sessions nobody accepted, and reject every pending `accept` (its timer would keep the process alive). */
  close(): void;
}

/** Listen for a game that dials in (`/script debugger connect <host> <port>`). */
export async function listen(port: number, opts: SessionOptions & { host?: string } = {}): Promise<DebuggerListener> {
  const queue: DebuggerSession[] = [];
  const waiters: { got(s: DebuggerSession): void; fail(err: Error): void }[] = [];
  let closed: Error | undefined;
  const server = createServer((socket) => {
    const session = new DebuggerSession(socket, opts);
    session.ready.then(
      () => {
        if (closed) return session.close();
        const w = waiters.shift();
        if (w) w.got(session);
        else queue.push(session);
      },
      () => {},
    );
  });
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  server.once("error", reject);
  server.listen(port, opts.host ?? "127.0.0.1", () => resolve());
  await promise;
  const bound = (server.address() as AddressInfo).port;
  return {
    port: bound,
    server,
    accept(timeoutMs = 60_000) {
      if (closed) return Promise.reject(closed);
      const ready = queue.shift();
      if (ready) return Promise.resolve(ready);
      const { promise: next, resolve, reject } = Promise.withResolvers<DebuggerSession>();
      const waiter = {
        got: (s: DebuggerSession) => {
          clearTimeout(timer);
          resolve(s);
        },
        fail: (err: Error) => {
          clearTimeout(timer);
          reject(err);
        },
      };
      const timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1);
        reject(new Error(`no game connected to the debugger listener on port ${bound} within ${timeoutMs} ms`));
      }, timeoutMs);
      waiters.push(waiter);
      return next;
    },
    close() {
      if (closed) return;
      closed = new Error(`the debugger listener on port ${bound} is closed`);
      server.close();
      for (const s of queue.splice(0)) s.close();
      for (const w of waiters.splice(0)) w.fail(closed);
    },
  };
}
