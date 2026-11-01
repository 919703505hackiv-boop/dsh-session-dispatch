// Self-test for dsh-session-dispatch — plain Node, no DSH runtime, no dependencies.
//
//   node test.mjs
//
// It fakes the Cordis context surface (tools.register / on / get) and the host
// services, then drives every tool's execute() directly. The two regressions we
// care about most:
//   * missing sessionId must fail loudly instead of becoming "undefined";
//   * conversation_wait must always return lastReason as a string (never null),
//     otherwise DSH's output-schema validation throws a type error.

process.env.DSH_DISPATCH_LOG = "off";
process.env.DSH_DISPATCH_START_GRACE_MS = "20";

import assert from "node:assert/strict";

const mod = await import("./index.js");
const {
  apply,
  registerTools,
  debugLogPath,
  inject,
  lastAssistantText,
  name,
  textOf,
  turnState,
  userSource
} = mod;

const EXPECTED_TOOLS = [
  "conversation_create",
  "conversation_list",
  "conversation_read",
  "conversation_send",
  "conversation_wait"
];

const defineTool = (spec) => spec;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let passed = 0;

function makeCtx({ services = {} } = {}) {
  const tools = new Map();
  const handlers = [];
  const ctx = {
    tools: {
      register(tool) {
        assert.equal(typeof tool.name, "string");
        assert.ok(!tools.has(tool.name), `duplicate tool name: ${tool.name}`);
        tools.set(tool.name, tool);
      }
    },
    on(event, handler, options) {
      assert.equal(event, "session/event");
      assert.deepEqual(options, { global: true });
      handlers.push(handler);
      return () => {
        const index = handlers.indexOf(handler);
        if (index >= 0) handlers.splice(index, 1);
      };
    },
    get(service) {
      return services[service];
    },
    ...services
  };
  return { ctx, tools, handlers };
}

function baseServices(overrides = {}) {
  return {
    sessionController: {
      async create(request) {
        return { sessionId: "session-default", request };
      },
      commands: {
        async prompt() {
          return { accepted: true };
        }
      },
      async prompt() {
        throw new Error("controller.prompt should not be reached when commands.prompt works");
      }
    },
    sessions: {
      get() {
        return undefined;
      },
      list() {
        return [];
      }
    },
    agents: {
      get() {
        return undefined;
      }
    },
    ...overrides
  };
}

const tests = [];
const test = (label, fn) => tests.push([label, fn]);

// ---------------------------------------------------------------------------
// 1. Registration
// ---------------------------------------------------------------------------
test("apply() registers exactly the five conversation tools", async () => {
  assert.equal(name, "session-dispatch");
  assert.deepEqual(inject, ["tools", "sessionController", "sessions", "agents"]);

  const { ctx, tools } = makeCtx({ services: baseServices() });
  await apply(ctx, { defineTool });

  assert.deepEqual([...tools.keys()].sort(), [...EXPECTED_TOOLS].sort());
  for (const [toolName, tool] of tools) {
    assert.equal(typeof tool.description, "string", `${toolName} description`);
    assert.ok(tool.description.length > 20, `${toolName} description is useful`);
    assert.equal(typeof tool.parameters, "object", `${toolName} parameters`);
    assert.equal(typeof tool.execute, "function", `${toolName} execute`);
    assert.equal(typeof tool.output.render, "function", `${toolName} render`);
  }
});

test("registerTools() rejects a missing defineTool or tools service", () => {
  const { ctx } = makeCtx({ services: baseServices() });
  assert.throws(() => registerTools(ctx, undefined), /defineTool/);
  assert.throws(() => registerTools({}, defineTool), /tools\.register/);
});

test("conversation_wait output schema types lastReason as a required string", async () => {
  const { ctx, tools } = makeCtx({ services: baseServices() });
  await apply(ctx, { defineTool });
  const schema = tools.get("conversation_wait").output.schema;
  assert.equal(schema.properties.lastReason.type, "string");
  assert.equal(schema.properties.lastReason.required, true);
});

// ---------------------------------------------------------------------------
// 2. conversation_create
// ---------------------------------------------------------------------------
test("conversation_create passes cwd/agentPreset and validates them", async () => {
  const requests = [];
  const services = baseServices({
    sessionController: {
      async create(request) {
        requests.push(request);
        return { sessionId: "session-1" };
      }
    }
  });
  const { ctx, tools } = makeCtx({ services });
  await apply(ctx, { defineTool });
  const create = tools.get("conversation_create");

  assert.deepEqual(await create.execute({ cwd: "C:/work/demo", agentPreset: "preset-a" }, {}), {
    sessionId: "session-1"
  });
  assert.deepEqual(requests[0], { cwd: "C:/work/demo", agentPreset: "preset-a" });

  await assert.rejects(create.execute({ cwd: 42 }, {}), /conversation_create.*cwd/);
  await assert.rejects(create.execute({ agentPreset: "" }, {}), /agentPreset/);

  const broken = baseServices({
    sessionController: {
      async create() {
        return {};
      }
    }
  });
  const brokenCtx = makeCtx({ services: broken });
  await apply(brokenCtx.ctx, { defineTool });
  await assert.rejects(brokenCtx.tools.get("conversation_create").execute({}, {}), /no sessionId/);
});

test("conversation_create inherits the calling session's cwd", async () => {
  const requests = [];
  const services = baseServices({
    sessionController: {
      async create(request) {
        requests.push(request);
        return { sessionId: "session-2" };
      }
    }
  });
  const { ctx, tools } = makeCtx({ services });
  await apply(ctx, { defineTool });

  await tools.get("conversation_create").execute({}, {
    agent: { session: { header: { cwd: "C:/work/caller" } } }
  });
  assert.deepEqual(requests[0], { cwd: "C:/work/caller" });
});

// ---------------------------------------------------------------------------
// 3. conversation_send
// ---------------------------------------------------------------------------
test("conversation_send rejects missing, empty, or mistyped arguments", async () => {
  const { ctx, tools } = makeCtx({ services: baseServices() });
  await apply(ctx, { defineTool });
  const send = tools.get("conversation_send");

  await assert.rejects(send.execute({ text: "hi" }, {}), (error) => {
    assert.match(error.message, /conversation_send/);
    assert.match(error.message, /sessionId/);
    assert.match(error.message, /conversation_create/);
    return true;
  });
  await assert.rejects(send.execute({ sessionId: "s-1" }, {}), /text/);
  await assert.rejects(send.execute({ sessionId: "s-1", text: "   " }, {}), /text/);
  await assert.rejects(send.execute({ sessionId: "s-1", text: "hi", mode: "broadcast" }, {}), /mode/);
});

test("conversation_send uses commands.prompt and reports path=commands", async () => {
  const sent = [];
  const services = baseServices({
    sessionController: {
      commands: {
        async prompt(request, source) {
          sent.push({ request, source });
          return { accepted: true };
        }
      }
    }
  });
  const { ctx, tools } = makeCtx({ services });
  await apply(ctx, { defineTool });
  const send = tools.get("conversation_send");

  assert.deepEqual(await send.execute({ sessionId: "s-1", text: "hello" }, {}), {
    accepted: true,
    path: "commands"
  });
  assert.equal(sent[0].request.sessionId, "s-1");
  assert.deepEqual(sent[0].request.content, [{ type: "text", text: "hello" }]);
  assert.equal(typeof sent[0].request.requestId, "string");
  assert.equal(sent[0].source.kind, "user");
  assert.equal(sent[0].source.rpcId, sent[0].request.requestId);
  assert.equal(typeof sent[0].source.clientTimeZone, "string");

  await send.execute({ sessionId: "s-1", text: "steer me", mode: "steer" }, {});
  assert.equal(sent[1].request.mode, "steer");
});

test("conversation_send aggregates all delivery failures", async () => {
  const services = baseServices({
    sessionController: {
      commands: {
        async prompt() {
          throw new Error("commands nope");
        }
      },
      async prompt() {
        throw new Error("controller nope");
      }
    }
  });
  const { ctx, tools } = makeCtx({ services });
  await apply(ctx, { defineTool });

  await assert.rejects(tools.get("conversation_send").execute({ sessionId: "s-9", text: "hi" }, {}), (error) => {
    assert.match(error.message, /conversation_send/);
    assert.match(error.message, /commands: .*commands nope/);
    assert.match(error.message, /controller: .*controller nope/);
    assert.match(error.message, /agent:/);
    return true;
  });
});

// ---------------------------------------------------------------------------
// 4. conversation_wait (the lastReason type regression)
// ---------------------------------------------------------------------------
test("conversation_wait returns idle with lastReason='' when turn/end has no reason", async () => {
  const services = baseServices({
    sessions: {
      get(sessionId) {
        if (sessionId !== "s-1") return undefined;
        return { id: "s-1", snapshotEvents: () => [{ type: "turn/start" }] };
      },
      list: () => []
    }
  });
  const { ctx, tools, handlers } = makeCtx({ services });
  await apply(ctx, { defineTool });

  const promise = tools.get("conversation_wait").execute({ sessionId: "s-1", timeoutMs: 5000 }, {});
  await sleep(10);
  assert.equal(handlers.length, 1);
  handlers[0]({ id: "s-1" }, { type: "turn/end" });

  const result = await promise;
  assert.deepEqual(result, { state: "idle", lastReason: "", running: false });
  assert.equal(typeof result.lastReason, "string");
  assert.equal(handlers.length, 0, "session/event observer is disposed");
});

test("conversation_wait never returns null/undefined lastReason on timeout", async () => {
  // A running turn that never ends, with the minimum budget: the timeout branch
  // is exactly where the old code used to leave lastReason as null.
  const services = baseServices({
    sessions: {
      get: () => ({ id: "s-running", snapshotEvents: () => [{ type: "turn/start" }] }),
      list: () => []
    }
  });
  const { ctx, tools } = makeCtx({ services });
  await apply(ctx, { defineTool });

  const result = await tools.get("conversation_wait").execute({ sessionId: "s-running", timeoutMs: 1000 }, {});
  assert.equal(result.state, "timeout");
  assert.equal(result.running, true);
  assert.equal(typeof result.lastReason, "string");
  assert.equal(result.lastReason, "");
});

test("conversation_wait treats a session with no events as idle after the grace period", async () => {
  const { ctx, tools } = makeCtx({ services: baseServices() });
  await apply(ctx, { defineTool });

  const result = await tools.get("conversation_wait").execute({ sessionId: "s-missing", timeoutMs: 5000 }, {});
  assert.equal(result.state, "idle");
  assert.equal(result.running, false);
  assert.equal(typeof result.lastReason, "string");
  assert.equal(result.lastReason, "");
});

test("conversation_wait returns the reason of a turn that ends while waiting", async () => {
  const services = baseServices({
    sessions: {
      get: () => ({ id: "s-2", snapshotEvents: () => [{ type: "turn/start" }] }),
      list: () => []
    }
  });
  const { ctx, tools, handlers } = makeCtx({ services });
  await apply(ctx, { defineTool });

  const promise = tools.get("conversation_wait").execute({ sessionId: "s-2", timeoutMs: 5000 }, {});
  await sleep(10);
  handlers[0]({ id: "s-2" }, { type: "turn/end", data: { reason: { kind: "error" } } });

  const result = await promise;
  assert.equal(result.state, "idle");
  assert.equal(result.lastReason, "error");
  assert.equal(result.running, false);
});

test("conversation_wait returns the settled reason after the start grace when already idle", async () => {
  const services = baseServices({
    sessions: {
      get: () => ({
        id: "s-3",
        snapshotEvents: () => [{ type: "turn/start" }, { type: "turn/end", data: { reason: { kind: "completed" } } }]
      }),
      list: () => []
    }
  });
  const { ctx, tools } = makeCtx({ services });
  await apply(ctx, { defineTool });

  const result = await tools.get("conversation_wait").execute({ sessionId: "s-3", timeoutMs: 5000 }, {});
  assert.equal(result.state, "idle");
  assert.equal(result.lastReason, "completed");
  assert.equal(result.running, false);
});

// ---------------------------------------------------------------------------
// 5. conversation_read / conversation_list
// ---------------------------------------------------------------------------
test("conversation_read returns the latest reply, truncates, and handles live=false", async () => {
  const reply = "x".repeat(600);
  const services = baseServices({
    sessions: {
      get(sessionId) {
        if (sessionId !== "s-1") return undefined;
        return {
          id: "s-1",
          snapshotEvents: () => [
            { type: "turn/start" },
            { type: "assistant/message", data: { message: { content: [{ type: "text", text: reply }] } } },
            { type: "turn/end", data: { reason: { kind: "completed" } } }
          ]
        };
      },
      list: () => []
    }
  });
  const { ctx, tools } = makeCtx({ services });
  await apply(ctx, { defineTool });
  const read = tools.get("conversation_read");

  const live = await read.execute({ sessionId: "s-1", maxChars: 500 }, {});
  assert.equal(live.live, true);
  assert.equal(live.running, false);
  assert.equal(live.turns, 1);
  assert.equal(live.lastTurnReason, "completed");
  assert.equal(live.truncated, true);
  assert.ok(live.text.startsWith("x".repeat(500)));
  assert.match(live.text, /已截断/);

  const missing = await read.execute({ sessionId: "s-404" }, {});
  assert.deepEqual(missing, { live: false, running: false, turns: 0, lastTurnReason: "", text: "", truncated: false });
  assert.equal(typeof missing.lastTurnReason, "string");
});

test("conversation_list filters by cwd and reports turn state", async () => {
  const sessions = [
    {
      id: "s-a",
      header: { cwd: "C:/work/a" },
      snapshotEvents: () => [{ type: "turn/start" }]
    },
    {
      id: "s-b",
      header: { cwd: "C:/work/b" },
      snapshotEvents: () => []
    }
  ];
  const services = baseServices({
    sessions: {
      get: () => undefined,
      list: () => sessions
    }
  });
  const { ctx, tools } = makeCtx({ services });
  await apply(ctx, { defineTool });
  const list = tools.get("conversation_list");

  const all = await list.execute({}, {});
  assert.equal(all.conversations.length, 2);
  assert.deepEqual(all.conversations[0], { sessionId: "s-a", cwd: "C:/work/a", running: true, turns: 1 });

  const filtered = await list.execute({ cwd: "C:/work/b" }, {});
  assert.deepEqual(filtered.conversations, [{ sessionId: "s-b", cwd: "C:/work/b", running: false, turns: 0 }]);
  await assert.rejects(list.execute({ cwd: 7 }, {}), /cwd/);
});

// ---------------------------------------------------------------------------
// 6. Pure helpers
// ---------------------------------------------------------------------------
test("turnState/lastAssistantText/textOf ignore malformed events", () => {
  assert.deepEqual(turnState([null, { type: "turn/start" }]), { running: true, lastReason: null, turns: 1 });
  assert.deepEqual(turnState([{ type: "turn/start" }, { type: "turn/end", data: {} }]), {
    running: false,
    lastReason: "completed",
    turns: 1
  });
  assert.equal(textOf({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }, { type: "image" }] }), "ab");
  assert.equal(textOf(null), "");
  assert.equal(lastAssistantText([
    { type: "assistant/message", data: { message: { content: [{ type: "text", text: "first" }] } } },
    { type: "assistant/message", data: { message: { content: [{ type: "text", text: "  " }] } } }
  ]), "first");
});

test("userSource() carries a string time zone and a fresh rpcId", () => {
  const a = userSource();
  const b = userSource();
  assert.equal(a.kind, "user");
  assert.equal(typeof a.clientTimeZone, "string");
  assert.ok(a.clientTimeZone.length > 0);
  assert.notEqual(a.rpcId, b.rpcId);
});

test("debug logging can be turned off and has no hard-coded home path", () => {
  assert.equal(debugLogPath(), null);
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
for (const [label, fn] of tests) {
  try {
    await fn();
  } catch (error) {
    console.error(`✗ ${label}`);
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
  }
  passed += 1;
  console.log(`✓ ${label}`);
}

console.log(`\n${passed}/${tests.length} 通过（dsh-session-dispatch 自测全部通过）`);
