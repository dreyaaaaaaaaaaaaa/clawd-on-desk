"use strict";

const { describe, it, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const themeLoader = require("../src/theme-loader");
const { createTranslator } = require("../src/i18n");
const prefs = require("../src/prefs");
const { registerPetInteractionIpc } = require("../src/pet-interaction-ipc");

themeLoader.init(path.join(__dirname, "..", "src"));
const clawdTheme = themeLoader.loadTheme("clawd");
const cloudlingTheme = themeLoader.loadTheme("cloudling");

function makeCtx(overrides = {}) {
  const rendererEvents = [];
  const soundsPlayed = [];
  const ctx = {
    lang: "en",
    theme: clawdTheme,
    doNotDisturb: false,
    miniTransitioning: false,
    miniMode: false,
    mouseOverPet: false,
    idlePaused: false,
    forceEyeResend: false,
    eyePauseUntil: 0,
    mouseStillSince: Date.now(),
    miniSleepPeeked: false,
    playSound: (name) => { soundsPlayed.push(name); },
    sendToRenderer: (channel, ...args) => { rendererEvents.push([channel, ...args]); },
    syncHitWin: () => {},
    sendToHitWin: () => {},
    miniPeekIn: () => {},
    miniPeekOut: () => {},
    buildContextMenu: () => {},
    buildTrayMenu: () => {},
    pendingPermissions: [],
    resolvePermissionEntry: () => {},
    focusTerminalWindow: () => {},
    showKimiNotifyBubble: () => {},
    clearKimiNotifyBubbles: () => {},
    processKill: () => { const e = new Error("ESRCH"); e.code = "ESRCH"; throw e; },
    getCursorScreenPoint: () => ({ x: 100, y: 100 }),
    ...overrides,
  };
  ctx._rendererEvents = rendererEvents;
  ctx._soundsPlayed = soundsPlayed;
  ctx.t = createTranslator(() => ctx.lang);
  return ctx;
}

function stateChanges(ctx) {
  return ctx._rendererEvents.filter(([ch]) => ch === "state-change").map(([, state]) => state);
}

describe("multi-pet: primary display agent filter", () => {
  let api;
  let ctx;
  let savedDebounceEnv;

  beforeEach(() => {
    savedDebounceEnv = process.env.CLAWD_COMPLETION_DEBOUNCE_MS;
    process.env.CLAWD_COMPLETION_DEBOUNCE_MS = "0";
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  });

  afterEach(() => {
    if (api) api.cleanup();
    api = null;
    mock.timers.reset();
    if (savedDebounceEnv === undefined) delete process.env.CLAWD_COMPLETION_DEBOUNCE_MS;
    else process.env.CLAWD_COMPLETION_DEBOUNCE_MS = savedDebounceEnv;
  });

  it("ignores sessions of agents that belong to a companion when resolving display", () => {
    ctx = makeCtx({ getDisplayAgentFilter: () => (agentId) => agentId !== "codex" });
    api = require("../src/state")(ctx);

    api.updateSession("codex-1", "working", "PreToolUse", { agentId: "codex" });
    assert.strictEqual(api.sessions.get("codex-1").state, "working", "bookkeeping still records the Codex session");
    assert.strictEqual(api.getCurrentState(), "idle", "main pet must stay idle while only Codex works");
    assert.ok(!stateChanges(ctx).includes("working"), "no working visual for a foreign agent");

    api.updateSession("cc-1", "working", "PreToolUse", { agentId: "claude-code" });
    assert.strictEqual(api.getCurrentState(), "working", "main pet reacts to Claude Code");
    mock.timers.tick(clawdTheme.timings.minDisplay.working + 10);

    api.updateSession("cc-1", "attention", "Stop", { agentId: "claude-code" });
    assert.strictEqual(api.getCurrentState(), "attention", "main pet celebrates Claude's completion");
    mock.timers.tick(clawdTheme.timings.autoReturn.attention + clawdTheme.timings.minDisplay.attention + 10);
    assert.strictEqual(api.getCurrentState(), "idle", "main pet returns to idle even though Codex still works");
  });

  it("hands foreign one-shots to onForeignOneshotState instead of playing them", () => {
    const routed = [];
    ctx = makeCtx({
      getDisplayAgentFilter: () => (agentId) => agentId !== "codex",
      onForeignOneshotState: (agentId, state, svg, options) => { routed.push({ agentId, state, svg, options }); },
    });
    api = require("../src/state")(ctx);

    api.updateSession("codex-1", "attention", "Stop", { agentId: "codex" });
    assert.deepStrictEqual(routed.map((r) => [r.agentId, r.state]), [["codex", "attention"]]);
    assert.strictEqual(api.getCurrentState(), "idle");
    assert.deepStrictEqual(ctx._soundsPlayed, [], "completion sound belongs to the companion, not the main pet");

    routed.length = 0;
    api.updateSession("cc-1", "attention", "Stop", { agentId: "claude-code" });
    assert.deepStrictEqual(routed, [], "own agent one-shots are not routed");
    assert.strictEqual(api.getCurrentState(), "attention");
    assert.deepStrictEqual(ctx._soundsPlayed, ["complete"]);
  });

  it("routes a debounced completion (promoteCompletion) by the session's agent", () => {
    process.env.CLAWD_COMPLETION_DEBOUNCE_MS = "500";
    const routed = [];
    ctx = makeCtx({
      getDisplayAgentFilter: () => (agentId) => agentId !== "codex",
      onForeignOneshotState: (agentId, state) => { routed.push([agentId, state]); },
    });
    api = require("../src/state")(ctx);

    api.updateSession("cc-1", "working", "PreToolUse", { agentId: "claude-code" });
    api.updateSession("cc-1", "attention", "Stop", { agentId: "claude-code" });
    mock.timers.tick(600);
    assert.deepStrictEqual(routed, [], "Claude completion stays on the main pet");
    const claudeState = api.getCurrentState();
    assert.ok(claudeState === "attention" || claudeState === "working", `unexpected ${claudeState}`);
  });

  it("does not route anything when no filter is installed (single-pet mode)", () => {
    const routed = [];
    ctx = makeCtx({
      onForeignOneshotState: (agentId, state) => { routed.push([agentId, state]); },
    });
    api = require("../src/state")(ctx);
    api.updateSession("codex-1", "attention", "Stop", { agentId: "codex" });
    assert.deepStrictEqual(routed, []);
    assert.strictEqual(api.getCurrentState(), "attention");
  });

  it("notifies onSessionsChanged after every session mutation", () => {
    let calls = 0;
    ctx = makeCtx({ onSessionsChanged: () => { calls += 1; } });
    api = require("../src/state")(ctx);
    api.updateSession("codex-1", "working", "PreToolUse", { agentId: "codex" });
    assert.ok(calls >= 1);
    const before = calls;
    api.updateSession("codex-1", "working", "PostToolUse", { agentId: "codex" });
    assert.ok(calls > before, "even a same-state event re-notifies (companions dedupe themselves)");
  });
});

describe("multi-pet: companion presentation state over external sessions", () => {
  let primary;
  let companion;
  let primaryCtx;
  let companionCtx;
  let savedDebounceEnv;

  beforeEach(() => {
    savedDebounceEnv = process.env.CLAWD_COMPLETION_DEBOUNCE_MS;
    process.env.CLAWD_COMPLETION_DEBOUNCE_MS = "0";
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    companionCtx = makeCtx({
      theme: cloudlingTheme,
      getExternalSessions: () => primary.sessions,
      getDisplayAgentFilter: () => (agentId) => agentId === "codex",
    });
    companion = require("../src/state")(companionCtx);
    primaryCtx = makeCtx({
      getDisplayAgentFilter: () => (agentId) => agentId !== "codex",
      onForeignOneshotState: (agentId, state, svg, options) => companion.setState(state, svg, options),
      onSessionsChanged: () => {
        const resolved = companion.resolveDisplayState();
        companion.setState(resolved, companion.getSvgOverride(resolved));
      },
    });
    primary = require("../src/state")(primaryCtx);
  });

  afterEach(() => {
    primary.cleanup();
    companion.cleanup();
    mock.timers.reset();
    if (savedDebounceEnv === undefined) delete process.env.CLAWD_COMPLETION_DEBOUNCE_MS;
    else process.env.CLAWD_COMPLETION_DEBOUNCE_MS = savedDebounceEnv;
  });

  it("shows Codex work on the companion only, Claude work on the main pet only", () => {
    primary.updateSession("codex-1", "working", "PreToolUse", { agentId: "codex" });
    assert.strictEqual(companion.getCurrentState(), "working", "Cloudling works");
    assert.strictEqual(primary.getCurrentState(), "idle", "Clawd idle");
    assert.ok(companion.getCurrentSvg().startsWith("cloudling-"), `companion uses its own theme assets: ${companion.getCurrentSvg()}`);

    primary.updateSession("cc-1", "thinking", "UserPromptSubmit", { agentId: "claude-code" });
    assert.strictEqual(primary.getCurrentState(), "thinking", "Clawd thinking");
    assert.strictEqual(companion.getCurrentState(), "working", "Cloudling unaffected");
    mock.timers.tick(clawdTheme.timings.minDisplay.thinking + 10);

    // Claude finishes while Codex keeps working.
    primary.updateSession("cc-1", "attention", "Stop", { agentId: "claude-code" });
    assert.strictEqual(primary.getCurrentState(), "attention");
    assert.strictEqual(companion.getCurrentState(), "working");
    mock.timers.tick(clawdTheme.timings.autoReturn.attention + clawdTheme.timings.minDisplay.attention + 10);
    assert.strictEqual(primary.getCurrentState(), "idle", "Clawd back to idle");
    assert.strictEqual(companion.getCurrentState(), "working", "Cloudling still working");

    // Codex finishes: companion celebrates, main pet untouched.
    mock.timers.tick(cloudlingTheme.timings.minDisplay.working + 10);
    primary.updateSession("codex-1", "attention", "Stop", { agentId: "codex" });
    assert.strictEqual(companion.getCurrentState(), "attention", "Cloudling celebrates");
    assert.deepStrictEqual(companionCtx._soundsPlayed, ["complete"], "companion plays its own sound");
    assert.strictEqual(primary.getCurrentState(), "idle");
    mock.timers.tick(cloudlingTheme.timings.autoReturn.attention + cloudlingTheme.timings.minDisplay.attention + 10);
    assert.strictEqual(companion.getCurrentState(), "idle", "Cloudling back to idle");
  });

  it("keeps a companion error visual on the companion", () => {
    primary.updateSession("codex-1", "error", "PostToolUseFailure", { agentId: "codex" });
    assert.strictEqual(companion.getCurrentState(), "error");
    assert.strictEqual(primary.getCurrentState(), "idle");
  });
});

describe("multi-pet: prefs schema", () => {
  it("normalizes multiPet with defaults Claude→main pet, Codex→Cloudling", () => {
    const defaults = prefs.getDefaults();
    assert.deepStrictEqual(defaults.multiPet, { enabled: false, pets: { codex: "cloudling" }, positions: {} });
  });

  it("drops malformed entries and rounds positions", () => {
    const entry = prefs.SCHEMA.multiPet;
    const out = entry.normalize({
      enabled: "yes",
      pets: { codex: "cloudling", "bad id!": "clawd", gemini: 42 },
      positions: { codex: { x: 10.4, y: "nope" }, "claude-code": { x: 1.6, y: 2.2 } },
    }, entry.defaultFactory());
    assert.deepStrictEqual(out, {
      enabled: false,
      pets: { codex: "cloudling" },
      positions: { "claude-code": { x: 2, y: 2 } },
    });
    assert.deepStrictEqual(entry.normalize(null, entry.defaultFactory()), entry.defaultFactory());
  });

  it("round-trips through validate()", () => {
    const validated = prefs.validate({
      ...prefs.getDefaults(),
      multiPet: { enabled: true, pets: { codex: "cloudling" }, positions: { codex: { x: 5, y: 6 } } },
    });
    assert.deepStrictEqual(validated.multiPet, {
      enabled: true,
      pets: { codex: "cloudling" },
      positions: { codex: { x: 5, y: 6 } },
    });
  });
});

describe("multi-pet: pet interaction IPC sender gate", () => {
  function makeRegistration(isOwnedSender) {
    const listeners = new Map();
    const calls = [];
    const ipcMain = {
      on: (channel, fn) => { listeners.set(channel, fn); },
      removeListener: (channel) => { listeners.delete(channel); },
    };
    const noop = () => {};
    registerPetInteractionIpc({
      ipcMain,
      isOwnedSender,
      showContextMenu: () => calls.push("show-context-menu"),
      moveWindowForDrag: () => calls.push("drag-move"),
      setIdlePaused: noop,
      isMiniTransitioning: () => false,
      getCurrentState: () => "idle",
      getCurrentSvg: () => null,
      sendToRenderer: noop,
      recoverVisiblePetAfterRendererLoad: noop,
      setDragLocked: (v) => calls.push(`drag-lock:${v}`),
      setMouseOverPet: noop,
      cancelRoam: noop,
      beginDragSnapshot: noop,
      clearDragSnapshot: noop,
      syncHitWin: noop,
      isMiniMode: () => false,
      checkMiniModeSnap: noop,
      hasPetWindow: () => false,
      getPetWindowBounds: () => null,
      getCurrentPixelSize: () => ({ width: 1, height: 1 }),
      computeDragEndBounds: () => null,
      applyPetWindowBounds: noop,
      flushRuntimeStateToPrefs: noop,
      reassertWinTopmost: noop,
      scheduleHwndRecovery: noop,
      repositionFloatingBubbles: noop,
      exitMiniMode: noop,
      getFocusableLocalHudSessionIds: () => [],
      focusLog: noop,
      showDashboard: noop,
      focusSession: noop,
      revealSessionHud: noop,
      setLowPowerIdlePaused: noop,
      statPath: async () => ({ isDirectory: () => true }),
      openTerminalAt: async () => ({ ok: false }),
    });
    return { listeners, calls };
  }

  it("ignores drag/menu events from windows it does not own", () => {
    const owned = { id: "own" };
    const foreign = { id: "companion" };
    const { listeners, calls } = makeRegistration((event) => event.sender === owned);
    listeners.get("drag-move")({ sender: foreign });
    listeners.get("drag-lock")({ sender: foreign }, true);
    listeners.get("show-context-menu")({ sender: foreign });
    assert.deepStrictEqual(calls, []);
    listeners.get("drag-move")({ sender: owned });
    listeners.get("drag-lock")({ sender: owned }, true);
    assert.deepStrictEqual(calls, ["drag-move", "drag-lock:true"]);
  });

  it("keeps legacy behavior when no gate is supplied", () => {
    const { listeners, calls } = makeRegistration(undefined);
    listeners.get("drag-move")({ sender: { id: "anyone" } });
    assert.deepStrictEqual(calls, ["drag-move"]);
  });
});

describe("multi-pet: companion pet body click", () => {
  const { createCompanionPetManager } = require("../src/companion-pets");

  class FakeWebContents {
    constructor() { this.handlers = {}; }
    on(event, cb) { this.handlers[event] = cb; }
    send() {}
    reload() {}
    isDestroyed() { return false; }
    get mainFrame() { return this; }
  }
  class FakeWindow {
    constructor(opts) {
      this.webContents = new FakeWebContents();
      this.bounds = { x: opts.x || 0, y: opts.y || 0, width: opts.width || 8, height: opts.height || 8 };
    }
    on() {}
    setFocusable() {}
    setIgnoreMouseEvents() {}
    setAlwaysOnTop() {}
    setShape() {}
    setSkipTaskbar() {}
    loadFile() {}
    isDestroyed() { return false; }
    getBounds() { return this.bounds; }
    setBounds(b) { Object.assign(this.bounds, b); }
    isVisible() { return false; }
    showInactive() {}
    hide() {}
    close() {}
    destroy() {}
    getNativeWindowHandle() { return Buffer.alloc(8); }
  }

  function makeManager(overrides = {}) {
    themeLoader.init(path.join(__dirname, "..", "src"), null);
    const store = {
      multiPet: { enabled: true, pets: { codex: "cloudling" }, positions: {} },
      size: "medium", themeVariant: {}, themeOverrides: {}, soundMuted: true, soundVolume: 1,
    };
    const listeners = new Map();
    const ipcMain = {
      on: (channel, cb) => { listeners.set(channel, [...(listeners.get(channel) || []), cb]); },
      removeListener: () => {},
    };
    const manager = createCompanionPetManager({
      BrowserWindow: FakeWindow,
      ipcMain,
      screen: { on() {}, removeListener() {}, getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
      isWin: false,
      themeLoader,
      settingsController: { get: (k) => store[k], subscribeKey: () => () => {}, applyUpdate: () => {} },
      getPrimarySessions: () => new Map(),
      getCurrentPixelSize: () => ({ width: 200, height: 200 }),
      getPrimaryWorkAreaSafe: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
      getPrimaryPetBounds: () => ({ x: 1500, y: 800, width: 200, height: 200 }),
      preloadPath: "p", hitPreloadPath: "h", indexHtmlPath: "i", hitHtmlPath: "hh",
      ...overrides,
    });
    manager.start();
    const companion = manager._companions.get("codex");
    const emit = (channel, sender) => {
      for (const cb of listeners.get(channel) || []) cb({ sender, senderFrame: sender });
    };
    return { manager, companion, emit };
  }

  it("creates the Codex companion from prefs", () => {
    const { companion } = makeManager();
    assert.ok(companion, "companion for codex should exist");
    assert.equal(companion.themeId, "cloudling");
  });

  it("reveals the Session HUD on a plain click from the companion's own hit window", () => {
    const revealSessionHud = mock.fn();
    const { companion, emit } = makeManager({ revealSessionHud });
    emit("pet-interaction:reveal-session-hud", companion.hitWin.webContents);
    assert.equal(revealSessionHud.mock.callCount(), 1);
  });

  it("ignores reveal-session-hud from a window it does not own", () => {
    const revealSessionHud = mock.fn();
    const { emit } = makeManager({ revealSessionHud });
    emit("pet-interaction:reveal-session-hud", new FakeWebContents());
    assert.equal(revealSessionHud.mock.callCount(), 0);
  });
});
