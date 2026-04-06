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

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || processingTabs.has(tab.id)) {
    return;
  }

  processingTabs.add(tab.id);

  try {
    // Clear any stale badge from a previous flashBadge whose setTimeout may not
    // have fired (MV3 service worker can go idle before the timer elapses).
    await clearBadge(tab.id);

    if (!supportsInjection(tab.url)) {
      await flashBadge(tab.id, UNSUPPORTED_BADGE_TEXT, ERROR_BADGE_COLOR, 1600);
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
  const tabId = sender.tab && sender.tab.id;
  if (!tabId) {
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
      captureVisibleTabForSender(tabId, sendResponse);
      return true;
    default:
      sendResponse({ ok: false });
      return;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  injectedTabs.delete(tabId);
  dispatchBestEffort(clearBadge(tabId));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' || changeInfo.url) {
    injectedTabs.delete(tabId);
    dispatchBestEffort(clearBadge(tabId));
  }
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

async function captureVisibleTabForSender(_tabId, sendResponse) {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
    sendResponse({ ok: true, dataUrl });
  } catch (error) {
    console.debug('Frame of Reference: captureVisibleTab failed', error);
    sendResponse({ ok: false, dataUrl: null });
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

async function updateBadge(tabId) {
  await Promise.all([
    chrome.action.setBadgeBackgroundColor({ tabId, color: ACTIVE_BADGE_COLOR }),
    chrome.action.setBadgeText({ tabId, text: ACTIVE_BADGE_TEXT }),
    chrome.action.setTitle({ tabId, title: ACTIVE_ACTION_TITLE })
  ]);
}

async function clearBadge(tabId) {
  try {
    await Promise.all([
      chrome.action.setBadgeText({ tabId, text: '' }),
      chrome.action.setTitle({ tabId, title: DEFAULT_ACTION_TITLE })
    ]);
  } catch (_error) {
    // Tab may no longer exist.
  }
}

async function flashBadge(tabId, text, color, durationMs) {
  try {
    await Promise.all([
      chrome.action.setBadgeBackgroundColor({ tabId, color }),
      chrome.action.setBadgeText({ tabId, text })
    ]);
    // Note: setTimeout in MV3 service workers may not fire if the worker goes
    // idle before the delay elapses. Badge clearing is best-effort here; using
    // chrome.alarms would be more reliable but requires an extra permission.
    setTimeout(() => {
      dispatchBestEffort(clearBadge(tabId));
    }, durationMs);
  } catch (_error) {
    // Best-effort badge flash.
  }
}
