'use strict';

const ACTIVE_BADGE_TEXT = 'ON';
const SUCCESS_BADGE_TEXT = 'OK';
const UNSUPPORTED_BADGE_TEXT = 'NO';
const ERROR_BADGE_TEXT = 'ERR';
const ACTIVE_BADGE_COLOR = '#0f766e';
const ERROR_BADGE_COLOR = '#7f1d1d';
const PICKER_SCRIPT = 'content/picker.js';
const ACTIVE_ACTION_TITLE =
  'Frame of Reference is active. Hover to target, use ArrowUp/ArrowDown to refine, click or press Enter to copy, press Esc to cancel.';
const DEFAULT_ACTION_TITLE = 'Frame of Reference: click to pick an element';
const MESSAGE_TYPE_STATE = 'frameofreference:state';
const MESSAGE_TYPE_RESULT = 'frameofreference:result';
const MESSAGE_TYPE_CAPTURE = 'frameofreference:capture';
const RESULT_KINDS = new Set(['copied', 'cancelled', 'error']);
const SUPPORTED_PROTOCOL_PREFIXES = ['http://', 'https://'];
const CAPTURE_RESPONSE_TIMEOUT_MS = 5000;
const BADGE_CLEAR_ALARM_PREFIX = 'frameofreference-clear-badge:';
const BADGE_CLEAR_ALARM_SEPARATOR = ':';
const BADGE_CLEAR_ALARM_GRACE_MS = 5000;

// Tracks tabs that already have the picker script injected to avoid redundant
// evaluation. These sets are intentionally ephemeral — a service worker restart
// clears them. This is benign because re-injection is idempotent (the IIFE guard
// at the top of picker.js prevents re-initialization). Worst case on restart is
// one redundant executeScript call.
const injectedTabs = new Set();

// Guards against concurrent clicks on the same tab. Like injectedTabs, this set
// is cleared on service worker restart. If the worker restarts mid-flight, the
// finally block won't run for that tab, but the next click will work normally
// since the set starts empty.
const processingTabs = new Set();
const badgeClearTimers = new Map();
const badgeClearAlarms = new Map();
const badgeGenerations = new Map();

chrome.action.onClicked.addListener(async (tab) => {
  if (typeof tab.id !== 'number' || processingTabs.has(tab.id)) {
    return;
  }

  processingTabs.add(tab.id);

  try {
    // Clear any stale badge from a previous feedback flash before toggling.
    await clearBadge(tab.id);

    if (!supportsInjection(tab.url)) {
      await flashBadge(tab.id, UNSUPPORTED_BADGE_TEXT, ERROR_BADGE_COLOR, 2500);
      return;
    }

    try {
      await ensurePickerInjected(tab.id);
      const active = await togglePickerSession(tab.id);
      if (active === null) {
        throw new Error('Frame of Reference picker did not initialize.');
      }

      if (active) {
        await updateBadge(tab.id);
        return;
      }

      await clearBadge(tab.id);
    } catch (error) {
      console.error('Frame of Reference failed to start the picker.', error);
      await flashBadge(tab.id, ERROR_BADGE_TEXT, ERROR_BADGE_COLOR, 2000);
    }
  } finally {
    processingTabs.delete(tab.id);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const senderTab = sender.tab;
  const tabId = senderTab && senderTab.id;
  if (typeof tabId !== 'number') {
    sendResponse({ ok: false });
    return;
  }

  switch (message && message.type) {
    case MESSAGE_TYPE_STATE:
      if (message.active) {
        dispatchBestEffort(updateBadge(tabId));
      } else {
        dispatchBestEffort(clearBadge(tabId));
      }
      sendResponse({ ok: true });
      return;
    case MESSAGE_TYPE_RESULT:
      if (RESULT_KINDS.has(message.kind)) {
        dispatchBestEffort(handleSessionResult(tabId, message.kind));
        sendResponse({ ok: true });
        return;
      }
      sendResponse({ ok: false });
      return;
    case MESSAGE_TYPE_CAPTURE:
      // Async: capture the visible tab and respond with the data URL.
      // Return true to keep the message channel open for the async response.
      captureVisibleTabForSender(senderTab, sendResponse);
      return true;
    default:
      sendResponse({ ok: false });
      return;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  injectedTabs.delete(tabId);
  processingTabs.delete(tabId);
  dispatchBestEffort(cleanupTabState(tabId));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' || changeInfo.url) {
    injectedTabs.delete(tabId);
    processingTabs.delete(tabId);
    dispatchBestEffort(cleanupTabState(tabId));
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  const badgeAlarm = getBadgeAlarmPayload(alarm.name);
  if (!badgeAlarm || !canClearBadgeGeneration(badgeAlarm.tabId, badgeAlarm.generation, true)) {
    return;
  }

  dispatchBestEffort(
    clearBadgeForGeneration(badgeAlarm.tabId, badgeAlarm.generation, {
      allowUnknownGeneration: true
    })
  );
});

function supportsInjection(url) {
  if (!url) {
    return false;
  }

  return SUPPORTED_PROTOCOL_PREFIXES.some((prefix) => url.startsWith(prefix));
}

function getAllFramesTarget(tabId) {
  return {
    tabId,
    allFrames: true
  };
}

const noop = () => {};

function dispatchBestEffort(promise) {
  void promise.catch(noop);
}

async function captureVisibleTabForSender(senderTab, sendResponse) {
  let settled = false;
  let timeoutId = 0;
  const respondOnce = (payload) => {
    if (settled) {
      return;
    }

    settled = true;
    clearTimeout(timeoutId);
    sendResponse(payload);
  };

  timeoutId = setTimeout(() => {
    respondOnce({ ok: false, dataUrl: null });
  }, CAPTURE_RESPONSE_TIMEOUT_MS);

  try {
    const currentTab = await chrome.tabs.get(senderTab.id);
    if (
      !currentTab.active ||
      currentTab.windowId !== senderTab.windowId ||
      !supportsInjection(currentTab.url)
    ) {
      respondOnce({ ok: false, dataUrl: null });
      return;
    }

    const dataUrl = await chrome.tabs.captureVisibleTab(senderTab.windowId, { format: 'png' });
    respondOnce({ ok: true, dataUrl });
  } catch (error) {
    console.debug('Frame of Reference: captureVisibleTab failed', error);
    respondOnce({ ok: false, dataUrl: null });
  }
}

async function ensurePickerInjected(tabId) {
  if (injectedTabs.has(tabId)) {
    return;
  }

  await chrome.scripting.executeScript({
    target: getAllFramesTarget(tabId),
    files: [PICKER_SCRIPT]
  });

  injectedTabs.add(tabId);
}

async function togglePickerSession(tabId) {
  const results = await chrome.scripting.executeScript({
    target: getAllFramesTarget(tabId),
    func: () => {
      const picker = globalThis.__FRAMEOFREFERENCE_PICKER__;
      if (!picker || typeof picker.toggle !== 'function') {
        return null;
      }

      picker.toggle();
      return Boolean(picker.active);
    }
  });

  const activeResults = results.map((result) => result.result).filter((result) => typeof result === 'boolean');

  if (activeResults.length === 0) {
    return null;
  }

  return activeResults.some(Boolean);
}

async function closePickerSession(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: getAllFramesTarget(tabId),
      func: () => {
        const picker = globalThis.__FRAMEOFREFERENCE_PICKER__;
        if (!picker || typeof picker.deactivate !== 'function' || !picker.active) {
          return false;
        }

        picker.deactivate();
        return true;
      }
    });
  } catch (error) {
    // Ignore close failures on navigated or inaccessible frames.
    console.debug('Frame of Reference: closePickerSession failed', error);
  }
}

async function handleSessionResult(tabId, kind) {
  try {
    await closePickerSession(tabId);

    if (kind === 'copied') {
      await flashBadge(tabId, SUCCESS_BADGE_TEXT, ACTIVE_BADGE_COLOR, 1200);
      return;
    }

    if (kind === 'cancelled') {
      await clearBadge(tabId);
      return;
    }

    await flashBadge(tabId, ERROR_BADGE_TEXT, ERROR_BADGE_COLOR, 1600);
  } catch (_error) {
    // Tab may have closed or navigated. Badge update is best-effort.
  }
}

async function cleanupTabState(tabId) {
  const generation = beginBadgeUpdate(tabId);

  try {
    await clearBadgeForGeneration(tabId, generation);
  } finally {
    if (isBadgeGenerationCurrent(tabId, generation)) {
      badgeClearTimers.delete(tabId);
      badgeClearAlarms.delete(tabId);
      badgeGenerations.delete(tabId);
    }
  }
}

async function updateBadge(tabId) {
  const generation = beginBadgeUpdate(tabId);
  await cancelBadgeClear(tabId, { generation });
  if (!isBadgeGenerationCurrent(tabId, generation)) {
    return;
  }

  await Promise.all([
    chrome.action.setBadgeBackgroundColor({ tabId, color: ACTIVE_BADGE_COLOR }),
    chrome.action.setBadgeText({ tabId, text: ACTIVE_BADGE_TEXT }),
    chrome.action.setTitle({ tabId, title: ACTIVE_ACTION_TITLE })
  ]);
}

async function clearBadge(tabId) {
  const generation = beginBadgeUpdate(tabId);
  await clearBadgeForGeneration(tabId, generation);
}

async function clearBadgeForGeneration(tabId, generation, options = {}) {
  if (!canClearBadgeGeneration(tabId, generation, options.allowUnknownGeneration)) {
    return;
  }

  try {
    await cancelBadgeClear(tabId, {
      generation,
      allowUnknownGeneration: options.allowUnknownGeneration
    });
    if (!canClearBadgeGeneration(tabId, generation, options.allowUnknownGeneration)) {
      return;
    }

    await Promise.all([
      chrome.action.setBadgeText({ tabId, text: '' }),
      chrome.action.setTitle({ tabId, title: DEFAULT_ACTION_TITLE })
    ]);
  } catch (_error) {
    // Tab may no longer exist.
  }
}

async function flashBadge(tabId, text, color, durationMs) {
  const generation = beginBadgeUpdate(tabId);

  try {
    await cancelBadgeClear(tabId, { generation });
    if (!isBadgeGenerationCurrent(tabId, generation)) {
      return;
    }

    await Promise.all([
      chrome.action.setBadgeBackgroundColor({ tabId, color }),
      chrome.action.setBadgeText({ tabId, text })
    ]);
    if (!isBadgeGenerationCurrent(tabId, generation)) {
      return;
    }

    await scheduleBadgeClear(tabId, durationMs, generation);
  } catch (_error) {
    // Best-effort badge flash.
  }
}

function beginBadgeUpdate(tabId) {
  const generation = createBadgeGeneration();
  badgeGenerations.set(tabId, generation);
  return generation;
}

function createBadgeGeneration() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isBadgeGenerationCurrent(tabId, generation) {
  return badgeGenerations.get(tabId) === generation;
}

function canClearBadgeGeneration(tabId, generation, allowUnknownGeneration = false) {
  const currentGeneration = badgeGenerations.get(tabId);
  return currentGeneration === generation || (allowUnknownGeneration && currentGeneration === undefined);
}

function getBadgeAlarmName(tabId, generation) {
  return `${BADGE_CLEAR_ALARM_PREFIX}${tabId}${BADGE_CLEAR_ALARM_SEPARATOR}${generation}`;
}

function getBadgeAlarmPayload(name) {
  if (!name.startsWith(BADGE_CLEAR_ALARM_PREFIX)) {
    return null;
  }

  const payload = name.slice(BADGE_CLEAR_ALARM_PREFIX.length);
  const separatorIndex = payload.indexOf(BADGE_CLEAR_ALARM_SEPARATOR);
  if (separatorIndex <= 0 || separatorIndex === payload.length - 1) {
    return null;
  }

  const tabIdValue = payload.slice(0, separatorIndex);
  const generation = payload.slice(separatorIndex + 1);
  const tabId = Number(tabIdValue);
  if (!Number.isInteger(tabId)) {
    return null;
  }

  return { tabId, generation };
}

async function cancelBadgeClear(tabId, options = {}) {
  const shouldContinue = () =>
    !options.generation || canClearBadgeGeneration(tabId, options.generation, options.allowUnknownGeneration);

  if (!shouldContinue()) {
    return;
  }

  const timerId = badgeClearTimers.get(tabId);
  if (timerId) {
    clearTimeout(timerId);
    badgeClearTimers.delete(tabId);
  }

  const alarmNames = new Set();
  const alarmName = badgeClearAlarms.get(tabId);
  if (alarmName) {
    alarmNames.add(alarmName);
  }
  badgeClearAlarms.delete(tabId);

  try {
    const alarms = await chrome.alarms.getAll();
    if (!shouldContinue()) {
      return;
    }

    for (const alarm of alarms) {
      const badgeAlarm = getBadgeAlarmPayload(alarm.name);
      if (badgeAlarm && badgeAlarm.tabId === tabId) {
        alarmNames.add(alarm.name);
      }
    }
  } catch (error) {
    console.debug('Frame of Reference: badge alarm lookup failed', error);
  }

  if (!shouldContinue()) {
    return;
  }

  await Promise.all(
    [...alarmNames].map(async (name) => {
      if (!shouldContinue()) {
        return;
      }

      try {
        await chrome.alarms.clear(name);
      } catch (error) {
        console.debug('Frame of Reference: badge alarm clear failed', error);
      }
    })
  );
}

async function scheduleBadgeClear(tabId, durationMs, generation) {
  if (!isBadgeGenerationCurrent(tabId, generation)) {
    return;
  }

  const timerId = setTimeout(() => {
    if (!isBadgeGenerationCurrent(tabId, generation)) {
      return;
    }

    badgeClearTimers.delete(tabId);
    dispatchBestEffort(clearBadgeForGeneration(tabId, generation));
  }, durationMs);
  const alarmName = getBadgeAlarmName(tabId, generation);

  badgeClearTimers.set(tabId, timerId);
  badgeClearAlarms.set(tabId, alarmName);
  await chrome.alarms.create(alarmName, {
    when: Date.now() + durationMs + BADGE_CLEAR_ALARM_GRACE_MS
  });
}
