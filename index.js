// dsh-session-dispatch — model-facing tools that drive top-level DSH conversations.
//
// Five tools:
//   conversation_create  create a workspace conversation (an independent Session)
//   conversation_send    deliver a prompt into it (queue, or steer the running turn)
//   conversation_wait    wait for its current/next assistant turn to end
//   conversation_read    read the latest reply and turn state
//   conversation_list    list conversations that are live in this host process
//
// Packaging rules this file follows:
//   * Host services arrive through Cordis `inject`; nothing is hard-coded.
//   * `@deepseek-ai/*` packages are imported lazily inside apply(), so the module
//     itself is plain ESM and can be unit-tested with bare `node test.mjs`.
//   * No absolute machine paths: the optional debug log lives under os.tmpdir()
//     and can be moved or disabled with DSH_DISPATCH_LOG.

import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** Cordis plugin name. */
export const name = "session-dispatch";

/** Host services this plugin needs. */
export const inject = ["tools", "sessionController", "sessions", "agents"];

const TOOL = {
  create: "conversation_create",
  send: "conversation_send",
  wait: "conversation_wait",
  read: "conversation_read",
  list: "conversation_list"
};

const DEFAULT_WAIT_MS = 120_000;
const MAX_WAIT_MS = 600_000;
const MIN_WAIT_MS = 1_000;
const DEFAULT_MAX_CHARS = 4_000;
const MAX_MAX_CHARS = 20_000;
const DEFAULT_START_GRACE_MS = 8_000;
const MIN_START_GRACE_MS = 5;

const clampInt = (value, lo, hi, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(n)));
};

const envInt = (key, fallback, lo, hi) => {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  return clampInt(raw, lo, hi, fallback);
};

// ---------------------------------------------------------------------------
// Debug log — never a fixed home path, never required, never fatal.
// ---------------------------------------------------------------------------

let logTarget;

/** Resolve the debug log path. `null` means logging is disabled. */
export function debugLogPath() {
  if (logTarget !== undefined) return logTarget;
  const raw = process.env.DSH_DISPATCH_LOG;
  if (raw !== undefined) {
    const value = raw.trim();
    logTarget = value === "" || /^(0|off|none|false|no)$/i.test(value) ? null : path.resolve(value);
  } else {
    logTarget = path.join(tmpdir(), "dsh-session-dispatch.log");
  }
  return logTarget;
}

function dbg(tag, payload) {
  try {
    const target = debugLogPath();
    if (!target) return;
    mkdirSync(path.dirname(target), { recursive: true });
    const body = typeof payload === "string" ? payload : JSON.stringify(payload);
    appendFileSync(target, `[${new Date().toISOString()}] ${tag} ${body}\n`);
  } catch {
    // Debug logging must never break a tool call.
  }
}

// ---------------------------------------------------------------------------
// Small pure helpers (exported so test.mjs can cover them directly).
// ---------------------------------------------------------------------------

/** Concatenate the text parts of one message. */
export function textOf(message) {
  const parts = message && Array.isArray(message.content) ? message.content : [];
  return parts
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

/** Last non-empty assistant text in a session event log. */
export function lastAssistantText(events) {
  let text = "";
  for (const event of events) {
    if (!event || event.type !== "assistant/message") continue;
    const next = textOf(event.data && event.data.message);
    if (next.trim()) text = next;
  }
  return text;
}

/** Derive turn state from a session event log. */
export function turnState(events) {
  let running = false;
  let lastReason = null;
  let turns = 0;
  for (const event of events) {
    if (!event) continue;
    if (event.type === "turn/start") {
      running = true;
      turns += 1;
    } else if (event.type === "turn/end") {
      running = false;
      lastReason = (event.data && event.data.reason && event.data.reason.kind) || "completed";
    }
  }
  return { running, lastReason, turns };
}

/** The `source` recorded for a user message (same shape the UI uses). */
export function userSource() {
  return { kind: "user", rpcId: randomUUID(), clientTimeZone: currentTimeZone() };
}

function currentTimeZone() {
  const explicit = process.env.DSH_DISPATCH_TZ;
  if (explicit) return explicit;
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Always return a string: output schemas type `lastReason` as a string. */
function reasonText(reason) {
  return typeof reason === "string" ? reason : "";
}

function requireNonEmptyString(value, tool, field, hint) {
  if (typeof value !== "string" || value.trim() === "") {
    const extra = hint ? `：${hint}` : "";
    throw new Error(`[${tool}] 缺少必填参数 ${field}${extra}（missing required argument "${field}"）`);
  }
  return value;
}

function optionalNonEmptyString(value, tool, field) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`[${tool}] 参数 ${field} 必须是非空字符串（"${field}" must be a non-empty string）`);
  }
  return value;
}

const SESSION_ID_HINT = "目标会话 id，可先调用 conversation_create 或 conversation_list 获取";

function errorText(error) {
  return error && error.stack ? error.stack : String(error);
}

// ---------------------------------------------------------------------------
// Plugin registration.
// ---------------------------------------------------------------------------

/**
 * Register the five tools on a Cordis-like context.
 *
 * @param {object} ctx Cordis context with `tools.register`, `on`, and `get`.
 * @param {Function} defineTool `defineTool` from `@deepseek-ai/dsh-tools`.
 */
export function registerTools(ctx, defineTool) {
  if (!ctx || !ctx.tools || typeof ctx.tools.register !== "function") {
    throw new Error("[session-dispatch] 宿主缺少 tools.register 服务（host is missing the tools service）");
  }
  if (typeof defineTool !== "function") {
    throw new Error("[session-dispatch] 缺少 defineTool，无法注册工具（defineTool from @deepseek-ai/dsh-tools is required）");
  }

  const get = (service) => (typeof ctx.get === "function" ? ctx.get(service) : undefined);
  const controller = get("sessionController") ?? ctx.sessionController;
  const sessions = get("sessions") ?? ctx.sessions;
  const agents = get("agents") ?? ctx.agents;

  const liveSession = (sessionId) =>
    sessions && typeof sessions.get === "function" ? sessions.get(sessionId) : undefined;

  const liveEvents = (sessionId) => {
    const session = liveSession(sessionId);
    if (!session || typeof session.snapshotEvents !== "function") return null;
    try {
      return session.snapshotEvents(0);
    } catch {
      return null;
    }
  };

  const cwdOfSession = (session) => {
    const headerCwd = session && session.header && session.header.cwd;
    return typeof headerCwd === "string" && headerCwd.length ? headerCwd : null;
  };

  const callingCwd = (exec) => {
    const agent = exec && exec.agent;
    const session = agent && agent.session;
    return cwdOfSession(session) || (agent && typeof agent.cwd === "string" ? agent.cwd : undefined);
  };

  dbg("apply", {
    hasController: Boolean(controller),
    hasSessions: Boolean(sessions),
    hasAgents: Boolean(agents)
  });

  ctx.tools.register(defineTool({
    name: TOOL.create,
    description: "Create a new top-level conversation — an independent Session with its own fresh context — in the current workspace, and return its sessionId. It is exactly like one the human starts by hand: it appears in the workspace conversation list and the human can open and chat in it directly. Follow with conversation_send to deliver the brief, conversation_wait to await the turn, and conversation_read to read the reply.",
    parameters: {
      cwd: { type: "string", description: "Absolute working directory for the new conversation. Defaults to the calling session's working directory." },
      agentPreset: { type: "string", description: "Optional agent preset id for the new conversation. Defaults to the host default." }
    },
    output: {
      schema: { type: "object", additionalProperties: false, properties: { sessionId: { type: "string", required: true } } },
      render: (_args, value) => [{ type: "text", text: `已创建对话 sessionId: ${value.sessionId}` }]
    },
    async execute(args = {}, exec) {
      if (!controller || typeof controller.create !== "function") {
        throw new Error(`[${TOOL.create}] 宿主缺少 sessionController.create 服务（host has no sessionController.create）`);
      }
      const cwdArg = optionalNonEmptyString(args.cwd, TOOL.create, "cwd");
      const preset = optionalNonEmptyString(args.agentPreset, TOOL.create, "agentPreset");
      try {
        const request = {};
        const cwd = cwdArg || callingCwd(exec);
        if (cwd) request.cwd = cwd;
        if (preset) request.agentPreset = preset;
        dbg("create.request", request);
        const created = await controller.create(request);
        if (!created || typeof created.sessionId !== "string" || created.sessionId === "") {
          throw new Error("controller.create returned no sessionId");
        }
        dbg("create.ok", { sessionId: created.sessionId });
        return { sessionId: created.sessionId };
      } catch (error) {
        throw new Error(`[${TOOL.create}] ${errorText(error)}`);
      }
    }
  }));

  ctx.tools.register(defineTool({
    name: TOOL.send,
    description: "Send a text message into an existing conversation, as if the human typed it into that conversation's composer. With mode=steer the message is injected into the turn that is currently running; without it the message is queued and starts the next turn.",
    parameters: {
      sessionId: { type: "string", required: true, description: "Target conversation session id." },
      text: { type: "string", required: true, description: "Message text to deliver." },
      mode: { type: "string", description: "Use \"steer\" to inject into the running turn; omit to queue a new turn." }
    },
    output: {
      schema: { type: "object", additionalProperties: false, properties: { accepted: { type: "boolean", required: true }, path: { type: "string", required: true } } },
      render: (_args, value) => [{ type: "text", text: value.accepted ? `已送达（${value.path}）` : "未被接受" }]
    },
    async execute(args = {}) {
      const sessionId = requireNonEmptyString(args.sessionId, TOOL.send, "sessionId", SESSION_ID_HINT);
      const text = requireNonEmptyString(args.text, TOOL.send, "text", "要发送的文本不能为空");
      if (args.mode !== undefined && args.mode !== null && args.mode !== "steer") {
        throw new Error(`[${TOOL.send}] 参数 mode 只接受 "steer" 或省略（mode must be "steer" or omitted）`);
      }

      const content = [{ type: "text", text }];
      const request = { sessionId, content, requestId: randomUUID() };
      if (args.mode === "steer") request.mode = "steer";
      const failures = [];

      // Preferred: controller.commands.prompt — the same path the Web UI uses,
      // bypassing SessionController.prompt(request, signal)'s wire validation.
      if (controller && controller.commands && typeof controller.commands.prompt === "function") {
        try {
          const ack = await controller.commands.prompt(request, { ...userSource(), rpcId: request.requestId });
          dbg("send.commands.ok", ack);
          return { accepted: !ack || ack.accepted !== false, path: "commands" };
        } catch (error) {
          failures.push(`commands: ${errorText(error)}`);
          dbg("send.commands.error", errorText(error));
        }
      }

      // Next: the Remote layer prompt(request, signal) (needs a real AbortSignal).
      if (controller && typeof controller.prompt === "function") {
        try {
          const ack = await controller.prompt(request, new AbortController().signal);
          dbg("send.controller.ok", ack);
          return { accepted: !ack || ack.accepted !== false, path: "controller" };
        } catch (error) {
          failures.push(`controller: ${errorText(error)}`);
          dbg("send.controller.error", errorText(error));
        }
      }

      // Last resort: deliver a followup straight to the live Agent.
      try {
        const { createUserMessage } = await import("@deepseek-ai/dsh-llm");
        const agent = agents && typeof agents.get === "function" ? agents.get(sessionId) : undefined;
        if (!agent) throw new Error(`no live agent for ${sessionId}`);
        const message = createUserMessage({ content, source: userSource() });
        if (request.mode === "steer" && typeof agent.steer === "function") agent.steer(message);
        else agent.followup(message);
        dbg("send.agent.ok", { sessionId });
        return { accepted: true, path: "agent.followup" };
      } catch (error) {
        failures.push(`agent: ${errorText(error)}`);
      }

      throw new Error(`[${TOOL.send}] 发送失败（sessionId=${sessionId}）：${failures.join("; ")}`);
    }
  }));

  ctx.tools.register(defineTool({
    name: TOOL.wait,
    description: "Wait until the target conversation finishes its current (or next) assistant turn. Returns state=idle once the turn ended, or state=timeout if it is still running when the budget runs out.",
    parameters: {
      sessionId: { type: "string", required: true, description: "Target conversation session id." },
      timeoutMs: { type: "number", description: `Max wait in milliseconds (default ${DEFAULT_WAIT_MS}, max ${MAX_WAIT_MS}).` }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          state: { type: "string", required: true },
          lastReason: { type: "string", required: true, description: "End reason of the last finished turn; empty string when no turn has finished." },
          running: { type: "boolean", required: true }
        }
      },
      render: (_args, value) => [{ type: "text", text: `state=${value.state}${value.lastReason ? ` reason=${value.lastReason}` : ""}` }]
    },
    async execute(args = {}) {
      const sessionId = requireNonEmptyString(args.sessionId, TOOL.wait, "sessionId", SESSION_ID_HINT);
      const budget = clampInt(args.timeoutMs, MIN_WAIT_MS, MAX_WAIT_MS, DEFAULT_WAIT_MS);
      const events = liveEvents(sessionId);
      const before = events ? turnState(events) : null;
      const settled = before && !before.running && before.turns > 0 ? reasonText(before.lastReason) : "";
      const startGrace = envInt("DSH_DISPATCH_START_GRACE_MS", DEFAULT_START_GRACE_MS, MIN_START_GRACE_MS, 60_000);

      return await new Promise((resolve) => {
        let done = false;
        let sawStart = Boolean(before && before.running);
        let budgetTimer;
        let startTimer;
        let dispose = () => {};

        const finish = (state, reason) => {
          if (done) return;
          done = true;
          clearTimeout(budgetTimer);
          clearTimeout(startTimer);
          try {
            if (typeof dispose === "function") dispose();
          } catch {
            // Observer already gone.
          }
          // Never emit null/undefined here: the output schema says string.
          const lastReason = reasonText(reason);
          dbg("wait.finish", { sessionId, state, lastReason });
          resolve({ state, lastReason, running: state !== "idle" });
        };

        dispose = ctx.on("session/event", (session, event) => {
          if (!session || session.id !== sessionId || !event) return;
          if (event.type === "turn/start") {
            sawStart = true;
            clearTimeout(startTimer);
            return;
          }
          if (event.type === "turn/end") {
            finish("idle", event.data && event.data.reason && event.data.reason.kind);
          }
        }, { global: true });

        budgetTimer = setTimeout(() => finish("timeout"), budget);
        startTimer = setTimeout(() => {
          if (!sawStart) finish("idle", settled);
        }, startGrace);
      });
    }
  }));

  ctx.tools.register(defineTool({
    name: TOOL.read,
    description: "Read the latest state and reply of a conversation from its live session log. Returns the last assistant message text, whether a turn is still running, the turn count, and the last turn's end reason. Returns live=false when the session is not live in this host process.",
    parameters: {
      sessionId: { type: "string", required: true, description: "Target conversation session id." },
      maxChars: { type: "number", description: `Max characters of reply text to return (default ${DEFAULT_MAX_CHARS}, max ${MAX_MAX_CHARS}).` }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          live: { type: "boolean", required: true },
          running: { type: "boolean", required: true },
          turns: { type: "number", required: true },
          lastTurnReason: { type: "string", required: true },
          text: { type: "string", required: true },
          truncated: { type: "boolean", required: true }
        }
      },
      render: (_args, value) => [{ type: "text", text: value.text || (value.live ? "（还没有回复）" : "会话不在本进程内（live=false）") }]
    },
    async execute(args = {}) {
      const sessionId = requireNonEmptyString(args.sessionId, TOOL.read, "sessionId", SESSION_ID_HINT);
      const max = clampInt(args.maxChars, 500, MAX_MAX_CHARS, DEFAULT_MAX_CHARS);
      const events = liveEvents(sessionId);
      if (!events) {
        return { live: false, running: false, turns: 0, lastTurnReason: "", text: "", truncated: false };
      }
      const state = turnState(events);
      let text = lastAssistantText(events);
      const truncated = text.length > max;
      if (truncated) text = `${text.slice(0, max)}\n…（已截断）`;
      return {
        live: true,
        running: state.running,
        turns: state.turns,
        lastTurnReason: reasonText(state.lastReason),
        text,
        truncated
      };
    }
  }));

  ctx.tools.register(defineTool({
    name: TOOL.list,
    description: "List conversations that are live in this host process, with their working directory and last turn state.",
    parameters: {
      cwd: { type: "string", description: "Optional: only list conversations whose working directory equals this absolute path." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          conversations: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                sessionId: { type: "string", required: true },
                cwd: { type: "string" },
                running: { type: "boolean", required: true },
                turns: { type: "number", required: true }
              }
            }
          }
        }
      },
      render: (_args, value) => [{
        type: "text",
        text: value.conversations.length === 0
          ? "（本进程内没有存活对话）"
          : value.conversations.map((c) => `${c.sessionId}  running=${c.running}  turns=${c.turns}  ${c.cwd || ""}`).join("\n")
      }]
    },
    async execute(args = {}) {
      const want = optionalNonEmptyString(args.cwd, TOOL.list, "cwd") || null;
      const list = sessions && typeof sessions.list === "function" ? sessions.list() : [];
      const conversations = [];
      for (const session of list) {
        if (!session || typeof session.id !== "string") continue;
        const cwd = cwdOfSession(session);
        if (want && cwd !== want) continue;
        let events = null;
        try {
          events = session.snapshotEvents(0);
        } catch {
          // Session not ready yet.
        }
        const state = events ? turnState(events) : { running: false, turns: 0 };
        conversations.push({
          sessionId: session.id,
          ...(cwd ? { cwd } : {}),
          running: state.running,
          turns: state.turns
        });
      }
      return { conversations };
    }
  }));
}

/**
 * Cordis entry point.
 *
 * `options.defineTool` is an escape hatch for tests; production profiles leave it
 * unset and the helper is imported from the host DSH runtime.
 */
export async function apply(ctx, options = {}) {
  let defineTool = options && typeof options === "object" ? options.defineTool : undefined;
  if (typeof defineTool !== "function") {
    ({ defineTool } = await import("@deepseek-ai/dsh-tools"));
  }
  registerTools(ctx, defineTool);
}
