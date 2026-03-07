"use strict";

const DEFAULT_API_URL = "http://books.chess.localhost";
const BADGE_SYNCING = "#4CAF50";
const BADGE_IDLE = "#9E9E9E";
const BADGE_ERROR = "#F44336";

let state = {
  enabled: true,
  lastFen: null,
  lastOrientation: null,
  lastSyncTime: null,
  boardPresent: false,
  apiUrl: DEFAULT_API_URL,
  orientationMode: "auto",
};

let chessableTabId = null;
let boardPollTimer = null;

let locked = false;
let lockFen = null;
let lastSentPlacement = null;

function getApiUrl() {
  return state.apiUrl;
}

async function loadConfig() {
  try {
    const result = await chrome.storage.sync.get({
      apiUrl: DEFAULT_API_URL,
      enabled: true,
      orientationMode: "auto",
    });
    if (result.apiUrl === "http://localhost:5000") {
      result.apiUrl = DEFAULT_API_URL;
      await chrome.storage.sync.set({ apiUrl: DEFAULT_API_URL });
    }
    state.apiUrl = result.apiUrl;
    state.enabled = result.enabled;
    state.orientationMode = result.orientationMode;
  } catch {
    // storage unavailable, keep defaults
  }
}

function setBadge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

async function syncFen(fen, force) {
  const url = `${getApiUrl()}/api/board/set-fen`;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fen, force }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      console.warn("[chessable-sync] set-fen failed:", resp.status, url, body);
      setBadge("!", BADGE_ERROR);
      return false;
    }
    console.debug("[chessable-sync] synced:", fen);
    state.lastSyncTime = Date.now();
    setBadge("ON", BADGE_SYNCING);
    return true;
  } catch (err) {
    console.warn("[chessable-sync] set-fen error:", url, err.message);
    setBadge("!", BADGE_ERROR);
    return false;
  }
}

async function syncOrientation(orientation) {
  const url = `${getApiUrl()}/api/board/orientation`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orientation }),
    });
  } catch {
    // orientation sync is best-effort
  }
}

// --- Reverse sync: poll physical board, forward to content script ---

function startBoardPoll() {
  stopBoardPoll();
  boardPollTimer = setInterval(pollPhysicalBoard, 500);
}

function stopBoardPoll() {
  if (boardPollTimer) {
    clearInterval(boardPollTimer);
    boardPollTimer = null;
  }
}

function resetLock() {
  locked = false;
  lockFen = null;
  lastSentPlacement = null;
}

async function pollPhysicalBoard() {
  if (!state.enabled || !state.boardPresent || chessableTabId === null) return;
  try {
    const resp = await fetch(`${getApiUrl()}/api/board/fen`, { signal: AbortSignal.timeout(2000) });
    if (!resp.ok) return;
    const data = await resp.json();
    const placement = data.fen ? data.fen.split(" ")[0] : null;
    if (!placement) return;

    if (locked) {
      if (placement === lockFen) {
        console.debug("[chessable-sync] physical board complied, unlocking");
        resetLock();
      }
      return;
    }

    if (placement === state.lastFen) {
      lastSentPlacement = null;
      return;
    }

    if (placement === lastSentPlacement) return;

    lastSentPlacement = placement;
    chrome.tabs.sendMessage(chessableTabId, { type: "PHYSICAL_FEN", placement }).catch(() => {});
  } catch {
    // poll failure, ignore
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.tab) chessableTabId = sender.tab.id;

  if (!state.enabled && msg.type !== "GET_STATE" && msg.type !== "SET_CONFIG") {
    sendResponse({ ok: false, reason: "disabled" });
    return false;
  }

  switch (msg.type) {
    case "FEN_UPDATE": {
      const promises = [];

      if (msg.fenChanged) {
        state.lastFen = msg.fen;

        if (msg.rollback) {
          locked = true;
          lockFen = msg.fen;
          console.debug("[chessable-sync] rollback detected, locking to", lockFen);
          promises.push(syncFen(msg.fen, true));
        } else {
          const fromPhysical = msg.fen === lastSentPlacement;
          resetLock();
          if (!fromPhysical) {
            locked = true;
            lockFen = msg.fen;
            promises.push(syncFen(msg.fen, true));
          }
        }
      }

      if (!state.boardPresent) {
        state.boardPresent = true;
        setBadge("ON", BADGE_SYNCING);
        startBoardPoll();
      }

      if (state.orientationMode === "auto" && msg.orientation && msg.orientation !== state.lastOrientation) {
        state.lastOrientation = msg.orientation;
        promises.push(syncOrientation(msg.orientation));
      }

      Promise.all(promises).then(() => sendResponse({ ok: true }));
      return true;
    }

    case "BOARD_FOUND":
      state.boardPresent = true;
      setBadge("ON", BADGE_SYNCING);
      startBoardPoll();
      sendResponse({ ok: true });
      return false;

    case "BOARD_LOST":
      state.boardPresent = false;
      state.lastFen = null;
      resetLock();
      stopBoardPoll();
      setBadge("", BADGE_IDLE);
      sendResponse({ ok: true });
      return false;

    case "RECONNECT": {
      resetLock();
      stopBoardPoll();
      if (chessableTabId !== null) {
        chrome.tabs.sendMessage(chessableTabId, { type: "RECONNECT" }, (resp) => {
          sendResponse(resp || { ok: false });
        });
        return true;
      }
      sendResponse({ ok: false, reason: "no tab" });
      return false;
    }

    case "HEARTBEAT":
      if (state.boardPresent && !boardPollTimer) {
        startBoardPoll();
      }
      sendResponse({ ok: true });
      return false;

    case "CONTENT_READY":
      sendResponse({ ok: true });
      return false;

    case "GET_STATE":
      sendResponse({
        enabled: state.enabled,
        lastFen: state.lastFen,
        lastOrientation: state.lastOrientation,
        lastSyncTime: state.lastSyncTime,
        boardPresent: state.boardPresent,
        apiUrl: state.apiUrl,
        orientationMode: state.orientationMode,
      });
      return false;

    case "SET_CONFIG":
      if (msg.apiUrl !== undefined) state.apiUrl = msg.apiUrl;
      if (msg.enabled !== undefined) state.enabled = msg.enabled;
      if (msg.orientationMode !== undefined) {
        state.orientationMode = msg.orientationMode;
        const target = msg.orientationMode === "auto" ? state.lastOrientation : msg.orientationMode;
        if (target) {
          state.lastOrientation = target;
          syncOrientation(target);
        }
      }
      chrome.storage.sync.set({
        apiUrl: state.apiUrl,
        enabled: state.enabled,
        orientationMode: state.orientationMode,
      });
      if (!state.enabled) {
        setBadge("OFF", BADGE_IDLE);
      } else if (state.boardPresent) {
        setBadge("ON", BADGE_SYNCING);
      } else {
        setBadge("", BADGE_IDLE);
      }
      sendResponse({ ok: true });
      return false;

    default:
      sendResponse({ ok: false, reason: "unknown message type" });
      return false;
  }
});

loadConfig().then(() => {
  setBadge(state.enabled ? "" : "OFF", BADGE_IDLE);
});
