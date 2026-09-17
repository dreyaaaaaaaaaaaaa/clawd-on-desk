"use strict";

// Multi-pet companions: one extra desktop pet per agent listed in
// prefs.multiPet.pets, living in the same process as the main pet.
//
// Architecture (see docs/project/theme-state-ui.md → Multi Pet):
//
//   agent-runtime → primary state.js (owns the sessions Map, snapshots, recap,
//   permissions — unchanged)
//        │ getDisplayAgentFilter(): main pet shows every agent WITHOUT a companion
//        │ onForeignOneshotState(): attention / error / notification / sweeping
//        │                          raised for a companion's agent are handed here
//        │ onSessionsChanged():     companions re-resolve their own display state
//        ▼
//   CompanionPet (per agent)
//        ├── theme      = its own theme-loader context (Cloudling, …)
//        ├── state      = its own state.js instance (presentation only: it never
//        │                receives updateSession; it reads the primary's sessions
//        │                through ctx.getExternalSessions + its agent filter)
//        ├── projection = its own displayed-visual projection (renderer ACKs)
//        ├── tick       = its own tick.js (eye tracking, idle animations, sleep)
//        └── windows    = render window (click-through) + hit window (input)
//
// Deliberately NOT reused from the main pet: mini mode, free roam, session HUD
// anchoring, permission bubbles, accessories/tint, viewport virtualization.
// Companions are plain always-on-top overlays that can be dragged anywhere.

const initState = require("./state");
const initTick = require("./tick");
const createPetGeometryMain = require("./pet-geometry-main");
const { createDisplayedVisualProjection } = require("./displayed-visual-projection");
const { collectRequiredAssetFiles } = require("./theme-schema");
const { resolveIdleVisualChoice } = require("./idle-visual");
const { createHitWindowActivationController } = require("./win-hit-window-activation");
const { isTrustedMainFrameEvent } = require("./pet-interaction-ipc");
const { createDragSnapshot, computeAnchoredDragBounds, computeFinalDragBounds } = require("./drag-position");
const { keepOutOfTaskbar } = require("./taskbar");
const { ONESHOT_STATES } = require("./state-priority");

const SOUND_COOLDOWN_MS = 10000;
const COMPANION_GAP_PX = 24;
const noop = () => {};

function isLiveWindow(win) {
  return !!(win && typeof win.isDestroyed === "function" && !win.isDestroyed());
}

function liveWebContents(win) {
  if (!isLiveWindow(win)) return null;
  const wc = win.webContents;
  if (!wc || (typeof wc.isDestroyed === "function" && wc.isDestroyed())) return null;
  return wc;
}

function readMultiPetPrefs(settingsController) {
  const raw = settingsController.get("multiPet");
  const enabled = !!(raw && raw.enabled === true);
  const pets = raw && raw.pets && typeof raw.pets === "object" ? raw.pets : {};
  const positions = raw && raw.positions && typeof raw.positions === "object" ? raw.positions : {};
  return { enabled, pets, positions };
}

function createCompanionPetManager(deps = {}) {
  const BrowserWindow = deps.BrowserWindow;
  const ipcMain = deps.ipcMain;
  const screen = deps.screen;
  const Menu = deps.Menu || null;
  const isWin = !!deps.isWin;
  const isMac = !!deps.isMac;
  const isLinux = !!deps.isLinux;
  const linuxWindowType = deps.linuxWindowType;
  const topmostLevel = deps.topmostLevel || "pop-up-menu";
  const themeLoader = deps.themeLoader;
  const settingsController = deps.settingsController;
  const getPrimarySessions = deps.getPrimarySessions || (() => new Map());
  const getDoNotDisturb = deps.getDoNotDisturb || (() => false);
  const getCurrentPixelSize = deps.getCurrentPixelSize || (() => ({ width: 200, height: 200 }));
  const getPrimaryWorkAreaSafe = deps.getPrimaryWorkAreaSafe || (() => null);
  const getNearestWorkArea = deps.getNearestWorkArea || (() => getPrimaryWorkAreaSafe());
  const getPrimaryPetBounds = deps.getPrimaryPetBounds || (() => null);
  const isPetHidden = deps.isPetHidden || (() => false);
  const isQuitting = deps.isQuitting || (() => false);
  const flashTaskbar = deps.flashTaskbar || noop;
  const t = deps.t || ((key) => key);
  const debugLog = deps.debugLog || noop;
  const logWarn = deps.logWarn || ((...args) => console.warn(...args));
  const openSettings = deps.openSettings || noop;
  const focusAgentSessions = deps.focusAgentSessions || noop;
  const resolveAgentDisplayName = deps.resolveAgentDisplayName || ((id) => id);
  const getCursorScreenPoint = deps.getCursorScreenPoint
    || (() => (screen ? screen.getCursorScreenPoint() : { x: 0, y: 0 }));
  const preloadPath = deps.preloadPath;
  const hitPreloadPath = deps.hitPreloadPath;
  const indexHtmlPath = deps.indexHtmlPath;
  const hitHtmlPath = deps.hitHtmlPath;

  const companions = new Map(); // agentId -> companion
  let enabled = false;
  let unsubscribeMultiPet = null;
  let unsubscribeSize = null;
  let unsubscribeThemeOverrides = null;
  let displayListenersBound = false;

  // ── Theme loading ──
  function loadCompanionTheme(themeId) {
    const variantMap = settingsController.get("themeVariant") || {};
    const overrideMap = settingsController.get("themeOverrides") || {};
    const theme = themeLoader.loadTheme(themeId, {
      strict: true,
      variant: variantMap[themeId] || "default",
      overrides: overrideMap[themeId] || null,
    });
    return { theme, context: themeLoader.createThemeContext(theme) };
  }

  function isOneshotDisabledForTheme(themeId, stateKey) {
    if (!themeId || !stateKey) return false;
    const overrides = settingsController.get("themeOverrides");
    const themeMap = overrides && overrides[themeId];
    const stateMap = themeMap && themeMap.states;
    const entry = (stateMap && stateMap[stateKey]) || (themeMap && themeMap[stateKey]);
    return !!(entry && entry.disabled === true);
  }

  // ── Geometry helpers ──
  function clampToWorkArea(x, y, width, height) {
    const wa = getNearestWorkArea(x + width / 2, y + height / 2) || getPrimaryWorkAreaSafe();
    if (!wa) return { x, y };
    const maxX = wa.x + wa.width - width;
    const maxY = wa.y + wa.height - height;
    return {
      x: Math.round(Math.max(wa.x, Math.min(maxX, x))),
      y: Math.round(Math.max(wa.y, Math.min(maxY, y))),
    };
  }

  function resolveInitialPosition(agentId, size, index) {
    const { positions } = readMultiPetPrefs(settingsController);
    const saved = positions[agentId];
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      return clampToWorkArea(saved.x, saved.y, size.width, size.height);
    }
    // Default: line up next to the main pet — to its right when there is
    // room, otherwise to its left — so "Clawd on the left, Cloudling on the
    // right" is what a fresh multi-pet launch looks like.
    const primary = getPrimaryPetBounds();
    const wa = (primary && getNearestWorkArea(primary.x + primary.width / 2, primary.y + primary.height / 2))
      || getPrimaryWorkAreaSafe()
      || { x: 0, y: 0, width: 1280, height: 720 };
    const step = (size.width + COMPANION_GAP_PX) * (index + 1);
    if (primary) {
      const rightX = primary.x + primary.width + COMPANION_GAP_PX + step - (size.width + COMPANION_GAP_PX);
      if (rightX + size.width <= wa.x + wa.width) {
        return clampToWorkArea(rightX, primary.y + primary.height - size.height, size.width, size.height);
      }
      return clampToWorkArea(primary.x - step, primary.y + primary.height - size.height, size.width, size.height);
    }
    return clampToWorkArea(
      wa.x + wa.width - size.width - 20 - step,
      wa.y + wa.height - size.height - 20,
      size.width,
      size.height
    );
  }

  function persistPosition(agentId, bounds) {
    const current = settingsController.get("multiPet") || {};
    const next = {
      enabled: current.enabled === true,
      pets: { ...(current.pets || {}) },
      positions: { ...(current.positions || {}), [agentId]: { x: bounds.x, y: bounds.y } },
    };
    try {
      const result = settingsController.applyUpdate("multiPet", next);
      if (result && typeof result.then === "function") result.catch(noop);
    } catch (err) {
      logWarn("Clawd: companion position persist failed:", err && err.message);
    }
  }

  // ── Companion factory ──
  function createCompanion(agentId, themeId, index) {
    debugLog(`[COMPANION] Creating companion for agent=${agentId} theme=${themeId}`);
    let loaded;
    try {
      loaded = loadCompanionTheme(themeId);
    } catch (err) {
      logWarn(`Clawd: companion pet for ${agentId} could not load theme "${themeId}":`, err && err.message);
      return null;
    }
    const theme = loaded.theme;
    const themeContext = loaded.context;
    const size = getCurrentPixelSize();
    const position = resolveInitialPosition(agentId, size, index);

    const companion = {
      agentId,
      themeId,
      theme,
      themeContext,
      win: null,
      hitWin: null,
      state: null,
      tick: null,
      projection: null,
      geometry: null,
      activation: null,
      dnd: false,
      idlePaused: false,
      mouseOverPet: false,
      forceEyeResend: false,
      eyePauseUntil: null,
      dragLocked: false,
      dragSnapshot: null,
      menuOpen: false,
      lastSoundAt: 0,
      lastResolvedKey: null,
      disposed: false,
      ipcDisposers: [],
      displayName: resolveAgentDisplayName(agentId) || agentId,
    };

    // ── renderer / hit-window messaging ──
    function sendRaw(channel, ...args) {
      const wc = liveWebContents(companion.win);
      if (!wc) return false;
      wc.send(channel, ...args);
      return true;
    }
    function sendToHitWin(channel, ...args) {
      const wc = liveWebContents(companion.hitWin);
      if (wc) wc.send(channel, ...args);
    }

    function inferVisualSource(displayState, file) {
      return displayState === "idle" && companion.state && file !== companion.state.getCurrentSvg()
        ? "idle-animation"
        : "state";
    }

    function requestDisplayedVisual(displayState, file, options = {}) {
      if (!companion.projection) return null;
      return companion.projection.request({
        themeId: theme._id,
        logicalState: options.logicalState || (companion.state ? companion.state.getCurrentState() : displayState),
        displayState,
        file,
        hitBox: companion.state ? companion.state.resolveHitBoxForSvg(file) : null,
        source: options.source || inferVisualSource(displayState, file),
        deliver: options.deliver || ((payload) => sendRaw("state-change", payload)),
        onLogicalSettlement: options.onLogicalSettlement,
      });
    }

    function sendToRenderer(channel, ...args) {
      if (channel === "state-change") {
        return requestDisplayedVisual(args[0], args[1], args[2] || {});
      }
      return sendRaw(channel, ...args);
    }

    function getDisplayedVisualTuple() {
      const committed = companion.projection && companion.projection.getSnapshot().committed;
      if (committed) return committed;
      return {
        displayState: companion.state ? companion.state.getCurrentState() : "idle",
        file: companion.state ? companion.state.getCurrentSvg() : null,
        hitBox: companion.state ? companion.state.getCurrentHitBox() : null,
        source: "state",
        visualGeneration: 0,
      };
    }

    function isVisualGenerationCurrent(visualGeneration) {
      if (!companion.projection || !Number.isSafeInteger(visualGeneration)) return false;
      const snapshot = companion.projection.getSnapshot();
      const current = snapshot.requested || snapshot.committed;
      return !!(current && current.visualGeneration === visualGeneration);
    }

    function playSound(name) {
      if (settingsController.get("soundMuted") || getDoNotDisturb()) return;
      const now = Date.now();
      if (now - companion.lastSoundAt < SOUND_COOLDOWN_MS) return;
      const url = themeContext.getSoundUrl(name);
      if (!url) return;
      companion.lastSoundAt = now;
      sendRaw("play-sound", { url, volume: settingsController.get("soundVolume") });
    }

    function getPetWindowBounds() {
      return isLiveWindow(companion.win) ? companion.win.getBounds() : null;
    }

    function syncHitWin() {
      if (!isLiveWindow(companion.hitWin) || !isLiveWindow(companion.win)) return false;
      if (companion.dragLocked) return false;
      const bounds = getPetWindowBounds();
      const hit = companion.geometry.getHitRectScreen(bounds);
      if (!hit) return false;
      const x = Math.round(hit.left);
      const y = Math.round(hit.top);
      const width = Math.max(1, Math.round(hit.right - hit.left));
      const height = Math.max(1, Math.round(hit.bottom - hit.top));
      const target = { x, y, width, height };
      const current = companion.hitWin.getBounds();
      if (
        current.x !== target.x || current.y !== target.y
        || current.width !== target.width || current.height !== target.height
      ) {
        companion.hitWin.setBounds(target);
      }
      companion.hitWin.setShape([{ x: 0, y: 0, width, height }]);
      return true;
    }

    // ── state runtime (presentation only) ──
    const stateCtx = {
      get theme() { return companion.theme; },
      get win() { return companion.win; },
      get hitWin() { return companion.hitWin; },
      get doNotDisturb() { return companion.dnd; },
      set doNotDisturb(v) { companion.dnd = !!v; },
      miniMode: false,
      miniTransitioning: false,
      get mouseOverPet() { return companion.mouseOverPet; },
      miniSleepPeeked: false,
      miniPeeked: false,
      get idlePaused() { return companion.idlePaused; },
      set idlePaused(v) { companion.idlePaused = !!v; },
      get forceEyeResend() { return companion.forceEyeResend; },
      set forceEyeResend(v) { companion.forceEyeResend = !!v; },
      get eyePauseUntil() { return companion.eyePauseUntil; },
      set eyePauseUntil(v) { companion.eyePauseUntil = v; },
      get mouseStillSince() { return companion.tick ? companion.tick._mouseStillSince : Date.now(); },
      pendingPermissions: [],
      sendToRenderer,
      sendToHitWin,
      syncHitWin,
      playSound,
      flashTaskbar,
      t,
      miniPeekIn: noop,
      miniPeekOut: noop,
      buildContextMenu: noop,
      buildTrayMenu: noop,
      debugLog: (msg) => debugLog(`[companion:${agentId}] ${msg}`),
      broadcastSessionSnapshot: noop,
      getCursorScreenPoint,
      getIdleVisualChoice: () => resolveIdleVisualChoice(companion.theme, settingsController.get("idleVisual")),
      isOneshotDisabled: (stateKey) => isOneshotDisabledForTheme(companion.theme && companion.theme._id, stateKey),
      // Multi-pet routing: read the primary's sessions, show only this agent.
      getExternalSessions: () => getPrimarySessions(),
      getDisplayAgentFilter: () => (id) => id === agentId,
    };
    companion.state = initState(stateCtx);

    companion.projection = createDisplayedVisualProjection({
      projectActualFile: ({ actualFile, requested }) => {
        if (!collectRequiredAssetFiles(companion.theme).includes(actualFile)) return null;
        return {
          displayState: requested.displayState,
          hitBox: companion.state.resolveHitBoxForSvg(actualFile),
        };
      },
      onCommit: () => { syncHitWin(); },
      onRendererUnresponsive: () => {
        if (companion.disposed || !isLiveWindow(companion.win)) return;
        logWarn(`Clawd: companion renderer (${agentId}) stopped acknowledging visuals — reloading`);
        try { companion.win.webContents.reload(); } catch {}
      },
    });

    companion.geometry = createPetGeometryMain({
      getActiveTheme: () => companion.theme,
      getDisplayedVisual: () => getDisplayedVisualTuple(),
      getCurrentState: () => getDisplayedVisualTuple().displayState,
      getCurrentSvg: () => getDisplayedVisualTuple().file,
      getCurrentHitBox: () => getDisplayedVisualTuple().hitBox,
      getCurrentAccessoryPayloads: () => ({ head: null, mouth: null }),
      getAccessoryMirrored: () => false,
      getMiniMode: () => false,
      getMiniPeekOffset: () => 0,
    });

    const tickCtx = {
      get theme() { return companion.theme; },
      get win() { return companion.win; },
      getPetWindowBounds,
      get currentState() { return companion.state.getCurrentState(); },
      get currentSvg() { return companion.state.getCurrentSvg(); },
      miniMode: false,
      miniTransitioning: false,
      get dragLocked() { return companion.dragLocked; },
      get menuOpen() { return companion.menuOpen; },
      get idlePaused() { return companion.idlePaused; },
      lowPowerIdleMode: false,
      lowPowerIdlePaused: false,
      isAnimating: false,
      miniSleepPeeked: false,
      miniPeeked: false,
      get mouseOverPet() { return companion.mouseOverPet; },
      set mouseOverPet(v) { companion.mouseOverPet = !!v; },
      get forceEyeResend() { return companion.forceEyeResend; },
      set forceEyeResend(v) { companion.forceEyeResend = !!v; },
      forceEyeResendBoostUntil: 0,
      startupRecoveryActive: false,
      get eyePauseUntil() { return companion.eyePauseUntil; },
      set eyePauseUntil(v) { companion.eyePauseUntil = v; },
      sendToRenderer,
      sendToHitWin,
      isVisualGenerationCurrent,
      setState: (...args) => companion.state.setState(...args),
      applyState: (...args) => companion.state.applyState(...args),
      getIdleVisualChoice: stateCtx.getIdleVisualChoice,
      getEffectiveAccessoryIds: () => ({ head: null, mouth: null }),
      miniPeekIn: noop,
      miniPeekOut: noop,
      getObjRect: (bounds) => companion.geometry.getObjRect(bounds),
      getHitRectScreen: (bounds) => companion.geometry.getHitRectScreen(bounds),
      getAssetPointerPayload: (bounds, point) => companion.geometry.getAssetPointerPayload(bounds, point),
      roam: null,
    };
    companion.tick = initTick(tickCtx);

    // ── Display resolution over the shared sessions ──
    companion.resolveNow = function resolveNow() {
      if (companion.disposed) return;
      const resolved = companion.state.resolveDisplayState();
      const svg = companion.state.getSvgOverride(resolved);
      const key = `${resolved}|${svg || ""}`;
      if (key === companion.lastResolvedKey) return;
      companion.lastResolvedKey = key;
      // A one-shot in progress auto-returns through the same resolver; do not
      // cut it short with a direct re-resolve.
      if (ONESHOT_STATES.has(companion.state.getCurrentState())) return;
      companion.state.setState(resolved, svg);
    };

    companion.playOneshot = function playOneshot(state, svgOverride, options) {
      if (companion.disposed) return;
      companion.state.setState(state, svgOverride, options || {});
    };

    // ── Windows ──
    const rendererConfig = themeContext.getRendererConfig();
    if (rendererConfig) {
      rendererConfig.idleDefaultVisual = stateCtx.getIdleVisualChoice();
    }
    const win = new BrowserWindow({
      width: size.width,
      height: size.height,
      x: position.x,
      y: position.y,
      show: false,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      resizable: false,
      skipTaskbar: true,
      hasShadow: false,
      fullscreenable: false,
      enableLargerThanScreen: true,
      ...(isLinux ? { type: linuxWindowType } : {}),
      ...(isMac ? { type: "panel", roundedCorners: false } : {}),
      webPreferences: {
        preload: preloadPath,
        backgroundThrottling: false,
        additionalArguments: ["--theme-config=" + JSON.stringify(rendererConfig)],
      },
    });
    companion.win = win;
    win.setFocusable(false);
    win.setIgnoreMouseEvents(true);
    if (isWin) win.setAlwaysOnTop(true, topmostLevel);
    keepOutOfTaskbar(win);
    win.on("close", (event) => {
      if (!isQuitting() && !companion.disposed) event.preventDefault();
    });
    win.webContents.on("render-process-gone", (_event, details) => {
      if (isQuitting() || companion.disposed) return;
      logWarn(`Clawd: companion renderer (${agentId}) crashed: ${details && details.reason}`);
      if (details && details.reason === "killed") return;
      try { win.webContents.reload(); } catch {}
    });
    win.webContents.on("did-finish-load", () => {
      if (companion.disposed) return;
      syncRendererAfterLoad();
    });
    win.loadFile(indexHtmlPath);

    const hitConfig = themeContext.getHitRendererConfig();
    companion.activation = isWin
      ? createHitWindowActivationController({
        isWin,
        onError: (err) => logWarn("Clawd: companion hit-window activation failed:", err && err.message),
      })
      : null;
    const windowsHitWindowFocusable = isWin && !(companion.activation && companion.activation.available);
    const hitWin = new BrowserWindow({
      ...(isWin ? { show: false } : {}),
      width: 8,
      height: 8,
      x: position.x,
      y: position.y,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      resizable: false,
      skipTaskbar: true,
      hasShadow: false,
      fullscreenable: false,
      enableLargerThanScreen: true,
      ...(isLinux ? { type: linuxWindowType } : {}),
      ...(isMac ? { type: "panel", roundedCorners: false } : {}),
      focusable: isWin ? windowsHitWindowFocusable : !isLinux,
      webPreferences: {
        preload: hitPreloadPath,
        backgroundThrottling: false,
        additionalArguments: [
          "--hit-theme-config=" + JSON.stringify(hitConfig),
          "--hit-platform=" + process.platform,
        ],
      },
    });
    companion.hitWin = hitWin;
    debugLog(`[COMPANION] Hit window created for ${agentId}`);
    hitWin.setShape([{ x: 0, y: 0, width: 8, height: 8 }]);
    hitWin.setIgnoreMouseEvents(false);
    if (isMac) hitWin.setFocusable(false);
    if (isWin && companion.activation) {
      const prepared = companion.activation.prepare(hitWin);
      if (prepared === false && !windowsHitWindowFocusable) hitWin.setFocusable(true);
    }
    keepOutOfTaskbar(hitWin);
    if (isWin) hitWin.setAlwaysOnTop(true, topmostLevel);
    hitWin.on("close", (event) => {
      if (!isQuitting() && !companion.disposed) event.preventDefault();
    });
    hitWin.webContents.on("did-finish-load", () => {
      if (companion.disposed) return;
      sendToHitWin("theme-config", themeContext.getHitRendererConfig());
      sendToHitWin("hit-state-sync", {
        currentState: companion.state.getCurrentState(),
        miniMode: false,
        dndEnabled: companion.dnd,
      });
      syncHitWin();
    });
    hitWin.webContents.on("render-process-gone", (_event, details) => {
      if (isQuitting() || companion.disposed) return;
      companion.dragLocked = false;
      companion.dragSnapshot = null;
      if (details && details.reason === "killed") return;
      try { hitWin.webContents.reload(); } catch {}
    });
    hitWin.loadFile(hitHtmlPath);

    function syncRendererAfterLoad() {
      const urls = ["complete", "confirm"]
        .map((name) => themeContext.getSoundUrl(name))
        .filter(Boolean);
      if (urls.length) sendRaw("preload-sounds", urls);
      companion.projection.reset({
        themeId: theme._id,
        logicalState: companion.state.getCurrentState(),
        detail: "companion-renderer-load",
      });
      companion.lastResolvedKey = null;
      if (companion.dnd) {
        sendRaw("dnd-change", true);
        companion.state.applyState("sleeping");
      } else {
        // Fresh document: re-render whatever we were showing (first load:
        // idle), then settle on the agent's current display state.
        const prev = companion.state.getCurrentState();
        companion.state.applyState(prev, companion.state.getSvgOverride(prev));
        companion.resolveNow();
      }
      if (isLiveWindow(win)) {
        if (isPetHidden()) {
          hideWindows();
        } else {
          showWindows();
        }
        companion.tick.startMainTick();
      }
    }

    function showWindows() {
      if (isLiveWindow(win) && !win.isVisible()) {
        win.showInactive();
        keepOutOfTaskbar(win);
        if (isWin) win.setAlwaysOnTop(true, topmostLevel);
      }
      if (isLiveWindow(hitWin) && !hitWin.isVisible()) {
        hitWin.showInactive();
        keepOutOfTaskbar(hitWin);
        if (isWin) hitWin.setAlwaysOnTop(true, topmostLevel);
      }
      syncHitWin();
    }
    function hideWindows() {
      if (isLiveWindow(hitWin) && hitWin.isVisible()) hitWin.hide();
      if (isLiveWindow(win) && win.isVisible()) win.hide();
    }
    companion.showWindows = showWindows;
    companion.hideWindows = hideWindows;

    // ── Drag / reactions / clicks (IPC from this companion's windows only) ──
    function isOwnSender(event) {
      return isTrustedMainFrameEvent(event, liveWebContents(win))
        || isTrustedMainFrameEvent(event, liveWebContents(hitWin));
    }
    function on(channel, listener) {
      const gated = (event, ...args) => {
        if (companion.disposed || !isOwnSender(event)) return undefined;
        return listener(event, ...args);
      };
      ipcMain.on(channel, gated);
      companion.ipcDisposers.push(() => ipcMain.removeListener(channel, gated));
    }

    function applyBounds(bounds) {
      if (!isLiveWindow(win)) return;
      win.setBounds({
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
      });
    }

    function resolveDragReactionFile(direction) {
      const drag = companion.theme && companion.theme.reactions && companion.theme.reactions.drag;
      if (!drag || typeof drag !== "object") return null;
      if (direction === "left" && typeof drag.fileLeft === "string") return drag.fileLeft;
      if (direction === "right" && typeof drag.fileRight === "string") return drag.fileRight;
      return typeof drag.file === "string" ? drag.file : null;
    }

    on("drag-lock", (_event, locked) => {
      companion.dragLocked = !!locked;
      if (locked) {
        companion.mouseOverPet = true;
        const bounds = getPetWindowBounds();
        companion.dragSnapshot = bounds
          ? createDragSnapshot(getCursorScreenPoint(), bounds, { width: bounds.width, height: bounds.height })
          : null;
      } else {
        companion.dragSnapshot = null;
        syncHitWin();
      }
    });
    on("drag-move", () => {
      if (!companion.dragLocked || !companion.dragSnapshot || !isLiveWindow(win)) return;
      const bounds = computeAnchoredDragBounds(companion.dragSnapshot, getCursorScreenPoint(), null);
      if (!bounds) return;
      applyBounds(bounds);
      if (isWin) win.setAlwaysOnTop(true, topmostLevel);
      // The hit window follows the render window so pointer capture survives.
      if (isLiveWindow(hitWin)) {
        const hit = companion.geometry.getHitRectScreen(bounds);
        if (hit) {
          hitWin.setBounds({
            x: Math.round(hit.left),
            y: Math.round(hit.top),
            width: Math.max(1, Math.round(hit.right - hit.left)),
            height: Math.max(1, Math.round(hit.bottom - hit.top)),
          });
        }
      }
    });
    on("drag-end", () => {
      try {
        const bounds = getPetWindowBounds();
        if (bounds) {
          const clamped = computeFinalDragBounds(bounds, { width: bounds.width, height: bounds.height }, clampToWorkArea);
          if (clamped) applyBounds(clamped);
          persistPosition(agentId, clamped || bounds);
        }
      } finally {
        companion.dragLocked = false;
        companion.dragSnapshot = null;
        syncHitWin();
      }
    });
    on("start-drag-reaction", (_event, direction) => {
      const normalized = direction === "left" || direction === "right" ? direction : null;
      const file = resolveDragReactionFile(normalized);
      if (!file) return;
      const snapshot = companion.projection.getSnapshot();
      const active = snapshot.requested || snapshot.committed;
      if (active && active.source === "reaction" && active.file === file) {
        sendRaw("start-drag-reaction", null, normalized);
        return;
      }
      requestDisplayedVisual(companion.state.getCurrentState(), file, {
        source: "reaction",
        deliver: (payload) => sendRaw("start-drag-reaction", payload, normalized),
      });
    });
    on("end-drag-reaction", () => sendRaw("end-drag-reaction"));
    on("play-click-reaction", (_event, file, duration) => {
      if (typeof file !== "string" || !collectRequiredAssetFiles(companion.theme).includes(file)) return;
      const safeDuration = Number.isFinite(duration) ? Math.max(0, duration) : 0;
      requestDisplayedVisual(companion.state.getCurrentState(), file, {
        source: "reaction",
        deliver: (payload) => sendRaw("play-click-reaction", payload, safeDuration),
      });
    });
    on("pause-cursor-polling", () => { companion.idlePaused = true; });
    on("resume-from-reaction", () => {
      companion.idlePaused = false;
      sendToRenderer("state-change", companion.state.getCurrentState(), companion.state.getCurrentSvg());
    });
    on("pet-visual-settled", (_event, payload) => { companion.projection.settle(payload); });
    on("pet-visual-ready", () => { syncHitWin(); });
    on("focus-terminal", () => {
      debugLog(`companion-pet ${agentId} focus-terminal clicked`);
      focusAgentSessions(agentId);
    });
    on("show-context-menu", () => { showContextMenu(); });
    // Consumed so the primary's gate never sees them; companions have no mini
    // mode / low-power mode / accessories.
    on("exit-mini-mode", noop);
    on("low-power-idle-paused", noop);
    on("accessory-mirror", noop);
    on("pet-drop-paths", noop);

    function showContextMenu() {
      if (!Menu || !isLiveWindow(hitWin)) return;
      const template = [
        { label: `${companion.displayName} · ${localizedThemeName(companion.theme)}`, enabled: false },
        { type: "separator" },
        { label: t("settings"), click: () => openSettings({ tab: "theme" }) },
        {
          label: t("bringPetToPrimaryDisplay"),
          click: () => {
            const wa = getPrimaryWorkAreaSafe();
            const bounds = getPetWindowBounds();
            if (!wa || !bounds) return;
            const next = {
              x: wa.x + wa.width - bounds.width - 20,
              y: wa.y + wa.height - bounds.height - 20,
              width: bounds.width,
              height: bounds.height,
            };
            applyBounds(next);
            persistPosition(agentId, next);
            syncHitWin();
          },
        },
      ];
      companion.menuOpen = true;
      const menu = Menu.buildFromTemplate(template);
      menu.popup({ window: hitWin, callback: () => { companion.menuOpen = false; } });
    }

    function localizedThemeName(themeObj) {
      const name = themeObj && themeObj.name;
      if (typeof name === "string") return name;
      if (name && typeof name === "object") return name.en || Object.values(name)[0] || themeObj._id;
      return themeObj ? themeObj._id : "";
    }

    companion.applySize = function applySize() {
      if (!isLiveWindow(win)) return;
      const next = getCurrentPixelSize();
      const bounds = getPetWindowBounds();
      if (!bounds || (bounds.width === next.width && bounds.height === next.height)) return;
      // Keep the pet's feet where they were: anchor at the bottom-left corner.
      const pos = clampToWorkArea(bounds.x, bounds.y + bounds.height - next.height, next.width, next.height);
      applyBounds({ x: pos.x, y: pos.y, width: next.width, height: next.height });
      syncHitWin();
    };

    companion.reclamp = function reclamp() {
      const bounds = getPetWindowBounds();
      if (!bounds) return;
      const pos = clampToWorkArea(bounds.x, bounds.y, bounds.width, bounds.height);
      if (pos.x !== bounds.x || pos.y !== bounds.y) {
        applyBounds({ ...bounds, x: pos.x, y: pos.y });
      }
      syncHitWin();
    };

    companion.setDoNotDisturb = function setDoNotDisturb(enabledFlag) {
      if (enabledFlag) companion.state.enableDoNotDisturb();
      else companion.state.disableDoNotDisturb();
    };

    companion.dispose = function dispose() {
      if (companion.disposed) return;
      companion.disposed = true;
      while (companion.ipcDisposers.length) {
        const dispose = companion.ipcDisposers.pop();
        try { dispose(); } catch {}
      }
      try { companion.tick.cleanup(); } catch {}
      try { companion.state.cleanup(); } catch {}
      try { companion.projection.dispose(); } catch {}
      if (companion.activation) { try { companion.activation.dispose(); } catch {} }
      if (isLiveWindow(hitWin)) { try { hitWin.destroy(); } catch {} }
      if (isLiveWindow(win)) { try { win.destroy(); } catch {} }
      companion.hitWin = null;
      companion.win = null;
    };

    return companion;
  }

  // ── Manager surface ──
  function getCompanionAgentIds() {
    return [...companions.keys()];
  }

  function hasCompanion(agentId) {
    return enabled && companions.has(agentId);
  }

  // The main pet displays every agent that has no companion of its own.
  function getPrimaryDisplayAgentFilter() {
    if (!enabled || companions.size === 0) return null;
    return (agentId) => !companions.has(agentId);
  }

  function onForeignOneshotState(agentId, state, svgOverride, options) {
    const companion = companions.get(agentId);
    if (!companion) return false;
    companion.playOneshot(state, svgOverride, options);
    return true;
  }

  function onSessionsChanged() {
    if (!enabled) return;
    for (const companion of companions.values()) companion.resolveNow();
  }

  function refreshAll() {
    for (const companion of companions.values()) {
      companion.lastResolvedKey = null;
      companion.resolveNow();
    }
  }

  function sync() {
    if (!settingsController) return;
    const prefs = readMultiPetPrefs(settingsController);
    const wasEnabled = enabled;
    enabled = prefs.enabled;
    const wanted = enabled ? prefs.pets : {};
    console.log(`[SYNC] enabled=${enabled}, wanted=`, wanted, `current companions:`, [...companions.keys()]);

    // Dispose companions that are gone or re-themed.
    for (const [agentId, companion] of [...companions]) {
      if (!wanted[agentId] || wanted[agentId] !== companion.themeId) {
        companion.dispose();
        companions.delete(agentId);
      }
    }
    // Create the missing ones.
    let index = companions.size;
    for (const [agentId, themeId] of Object.entries(wanted)) {
      if (companions.has(agentId)) continue;
      const companion = createCompanion(agentId, themeId, index);
      if (companion) {
        companions.set(agentId, companion);
        index += 1;
        if (getDoNotDisturb()) companion.setDoNotDisturb(true);
      }
    }
    if (wasEnabled !== enabled || companions.size > 0) {
      // The main pet's agent filter changed: let it re-settle immediately.
      if (typeof deps.onPrimaryFilterChanged === "function") {
        try { deps.onPrimaryFilterChanged(); } catch {}
      }
    }
    refreshAll();
  }

  function setDoNotDisturb(enabledFlag) {
    for (const companion of companions.values()) companion.setDoNotDisturb(!!enabledFlag);
  }

  function syncVisibility() {
    const hidden = isPetHidden();
    for (const companion of companions.values()) {
      if (hidden) companion.hideWindows();
      else companion.showWindows();
    }
  }

  function handleDisplayChange() {
    for (const companion of companions.values()) companion.reclamp();
  }

  function start() {
    if (!settingsController) return;
    unsubscribeMultiPet = settingsController.subscribeKey("multiPet", () => {
      try { sync(); } catch (err) { logWarn("Clawd: multi-pet sync failed:", err && err.message); }
    });
    unsubscribeSize = settingsController.subscribeKey("size", () => {
      for (const companion of companions.values()) companion.applySize();
    });
    unsubscribeThemeOverrides = settingsController.subscribeKey("themeOverrides", () => {
      // Sound/animation overrides are per theme: reload affected companions.
      if (!enabled) return;
      for (const [agentId, companion] of [...companions]) {
        companion.dispose();
        companions.delete(agentId);
      }
      sync();
    });
    if (screen && !displayListenersBound) {
      displayListenersBound = true;
      screen.on("display-metrics-changed", handleDisplayChange);
      screen.on("display-removed", handleDisplayChange);
    }
    sync();
  }

  function cleanup() {
    if (unsubscribeMultiPet) { try { unsubscribeMultiPet(); } catch {} unsubscribeMultiPet = null; }
    if (unsubscribeSize) { try { unsubscribeSize(); } catch {} unsubscribeSize = null; }
    if (unsubscribeThemeOverrides) { try { unsubscribeThemeOverrides(); } catch {} unsubscribeThemeOverrides = null; }
    if (screen && displayListenersBound) {
      displayListenersBound = false;
      try { screen.removeListener("display-metrics-changed", handleDisplayChange); } catch {}
      try { screen.removeListener("display-removed", handleDisplayChange); } catch {}
    }
    for (const companion of companions.values()) companion.dispose();
    companions.clear();
    enabled = false;
  }

  return {
    start,
    sync,
    cleanup,
    isEnabled: () => enabled,
    hasCompanion,
    getCompanionAgentIds,
    getPrimaryDisplayAgentFilter,
    onForeignOneshotState,
    onSessionsChanged,
    setDoNotDisturb,
    syncVisibility,
    handleDisplayChange,
    applySize: () => { for (const companion of companions.values()) companion.applySize(); },
    // Test/diagnostic surface.
    _companions: companions,
  };
}

module.exports = {
  createCompanionPetManager,
  readMultiPetPrefs,
};
