"use strict";

const $ = (id) => document.getElementById(id);

const enabledToggle = $("enabled-toggle");
const toggleLabel = $("toggle-label");
const statusDot = $("status-dot");
const statusText = $("status-text");
const fenDisplay = $("fen-display");
const apiUrlInput = $("api-url");

function setStatus(dotClass, text) {
  statusDot.className = "dot " + dotClass;
  statusText.textContent = text;
}

function renderState(s) {
  enabledToggle.checked = s.enabled;
  toggleLabel.textContent = s.enabled ? "ON" : "OFF";
  apiUrlInput.value = s.apiUrl || "http://localhost:5000";

  if (!s.enabled) {
    setStatus("gray", "Sync disabled");
    fenDisplay.textContent = "--";
    return;
  }

  if (s.boardPresent && s.lastFen) {
    setStatus("green", "Syncing board");
    fenDisplay.textContent = s.lastFen;
  } else if (s.boardPresent) {
    setStatus("green", "Board detected, waiting for position...");
    fenDisplay.textContent = "--";
  } else {
    setStatus("gray", "No board found -- open a Chessable lesson");
    fenDisplay.textContent = "--";
  }
}

function fetchState() {
  chrome.runtime.sendMessage({ type: "GET_STATE" }, (response) => {
    if (response) renderState(response);
  });
}

enabledToggle.addEventListener("change", () => {
  const enabled = enabledToggle.checked;
  chrome.runtime.sendMessage({ type: "SET_CONFIG", enabled }, fetchState);
});

let urlTimer = null;
apiUrlInput.addEventListener("input", () => {
  clearTimeout(urlTimer);
  urlTimer = setTimeout(() => {
    const apiUrl = apiUrlInput.value.replace(/\/+$/, "");
    chrome.runtime.sendMessage({ type: "SET_CONFIG", apiUrl }, fetchState);
  }, 500);
});

fetchState();
setInterval(fetchState, 2000);
