(() => {
  'use strict';

  if (globalThis.__FRAMEOFREFERENCE_PICKER__) {
    return;
  }

  // Elements that are structural, hidden from the user, or otherwise not useful picker targets.
  const SKIP_TAGS = new Set(['html', 'body', 'head', 'script', 'style', 'meta', 'link', 'noscript', 'template']);

  // Native controls usually reflect the user's intent more accurately than nested child nodes.
  const INTERACTIVE_TAGS = new Set(['a', 'button', 'input', 'label', 'option', 'select', 'summary', 'textarea']);

  // ARIA roles that should receive the same targeting bias as native interactive controls.
  const INTERACTIVE_ROLES = new Set([
    'button',
    'checkbox',
    'combobox',
    'link',
    'menuitem',
    'option',
    'radio',
    'switch',
    'tab',
    'textbox'
  ]);

  // Semantic elements are more useful for copy output than generic wrappers.
  const SEMANTIC_TAGS = new Set([
    'article',
    'aside',
    'audio',
    'canvas',
    'details',
    'dialog',
    'figcaption',
    'figure',
    'footer',
    'form',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'header',
    'img',
    'li',
    'main',
    'nav',
    'p',
    'section',
    'table',
    'tbody',
    'td',
    'th',
    'thead',
    'tr',
    'video'
  ]);

  // Container tags that can add helpful parent-region context to the copied reference.
  const CONTEXT_TAGS = new Set([
    'article',
    'aside',
    'audio',
    'canvas',
    'dialog',
    'figure',
    'fieldset',
    'footer',
    'form',
    'header',
    'li',
    'main',
    'nav',
    'section',
    'table',
    'tbody',
    'td',
    'th',
    'thead',
    'tr',
    'video'
  ]);

  // Inline or text-heavy tags that often benefit from being promoted to a larger container.
  const TEXTISH_TAGS = new Set(['blockquote', 'code', 'em', 'i', 'p', 'pre', 'small', 'span', 'strong']);

  // Common layout wrappers that can become a better target than tiny descendants.
  const CONTAINER_TAGS = new Set([
    'article',
    'aside',
    'details',
    'dialog',
    'div',
    'fieldset',
    'figure',
    'form',
    'li',
    'main',
    'nav',
    'section'
  ]);

  // Roles that hint a generic element is acting as a meaningful content region.
  const CONTAINER_ROLE_HINTS = new Set([
    'article',
    'complementary',
    'dialog',
    'form',
    'group',
    'main',
    'navigation',
    'region',
    'search',
    'tabpanel'
  ]);

  // Input types that map to a "button" role.
  const BUTTON_INPUT_TYPES = new Set(['button', 'submit', 'reset']);

  // Tags that can have an associated <label> element.
  const LABELABLE_TAGS = new Set(['input', 'select', 'textarea', 'meter', 'progress']);

  // SVG element tags that should receive a scoring penalty (low signal as pick targets).
  const SVG_TAGS = new Set(['svg', 'path', 'use']);

  // Generic wrapper tags that should receive a scoring penalty when lacking id/role.
  const GENERIC_WRAPPER_TAGS = new Set(['div', 'span']);

  const STRONG_CONTAINER_CLASS_RE =
    /(?:^|[-_])(card|panel|surface|section|container|wrapper|content|box|tile|group|dialog|modal|sheet)(?:$|[-_])/i;
  const VISUAL_CONTAINER_CLASS_RE = /(?:^|[-_])(bg|border|rounded|shadow|ring)(?:$|[-_]|\/)/i;
  const LOW_SIGNAL_CLASS_RE =
    /^(?:p[trblxy]?-\S+|m[trblxy]?-\S+|w-\S+|h-\S+|min-\S+|max-\S+|gap-\S+|space-[xy]-\S+|flex|grid|block|inline|text-\S+|font-\S+|leading-\S+|tracking-\S+)$/i;
  const ALPHANUMERIC_CLASS_RE = /^[A-Za-z0-9_-]+$/;
  const LEADING_DIGIT_RE = /^\d/;
  const CLID_SUFFIX_RE = /clid$/i;

  const NOISY_QUERY_PARAM_KEYS = new Set([
    'fbclid',
    'gclid',
    'dclid',
    'msclkid',
    'twclid',
    'igshid',
    'srsltid',
    'yclid',
    '_ga',
    '_gl',
    '_hsenc',
    '_hsmi',
    'mc_cid',
    'mc_eid',
    'ref',
    'ref_src'
  ]);

  // --- Target Candidate Scoring Weights ---
  // Centralised so the heuristic is easy to tune without hunting through method bodies.
  const TARGET_SCORING = {
    STACK_CANDIDATE_DEPTH: 4,
    ANCESTOR_CANDIDATE_DEPTH: 6,
    STACK_INDEX_BASE: 28,
    STACK_INDEX_DECAY: 8,
    ANCESTOR_DEPTH_BASE: 18,
    ANCESTOR_DEPTH_DECAY: 3,
    ANCHOR_BONUS: 18,
    INTERACTIVE_BOOST: 52,
    PREFERRED_CONTAINER_BOOST: 34,
    CONTAINER_LIKE_BOOST: 26,
    MEANINGFUL_BOOST: 18,
    ID_BOOST: 24,
    TEST_ATTR_BOOST: 28,
    ROLE_BOOST: 20,
    LABEL_ATTR_BOOST: 10,
    STABLE_ATTR_BOOST: 12,
    ACCESSIBLE_NAME_BOOST: 8,
    ASSOCIATED_LABEL_BOOST: 14,
    SEMANTIC_TAG_BOOST: 8,
    TEXT_LIKE_PENALTY: -16,
    GENERIC_TAG_PENALTY: -6,
    SVG_PENALTY: -28,
    LEAF_NODE_PENALTY: -6,
    TEXT_ANCESTOR_BOOST: 12,
    AREA_THRESHOLDS: [
      { ratio: 0.82, penalty: -80 },
      { ratio: 0.65, penalty: -44 },
      { ratio: 0.45, penalty: -24 }
    ],
    TINY_AREA_RATIO: 0.00008,
    TINY_AREA_PENALTY: -8
  };

  // --- Traversal Depth Limits ---
  const MAX_TARGET_PATH_DEPTH = 7;
  const MAX_CONTAINER_SEARCH_DEPTH = 5;
  const MAX_CONTEXT_SEARCH_DEPTH = 6;
  const CONTAINER_SIZE_THRESHOLD_PX = 24;

  // --- Toast Positioning Layout ---
  const TOAST_LAYOUT = {
    OFFSET_Y: 8,
    ESTIMATED_HEIGHT: 32,
    MIN_TOP_MARGIN: 4,
    MIN_SIDE_MARGIN: 8,
    MIN_RIGHT_CLEARANCE: 80,
    CENTER_OFFSET: 32
  };

  // --- Exact Selector Scoring Weights ---
  const SELECTOR_SCORING = {
    UNIQUE_MATCH_BONUS: 1000,
    MULTI_MATCH_BASE: 120,
    MULTI_MATCH_DECAY: 24,
    LENGTH_DIVISOR: 4,
    DOT_PENALTY: 1.5,
    CHILD_COMBINATOR_PENALTY: 2,
    NTH_OF_TYPE_PENALTY: -8,
    SHADOW_PIERCING_BONUS: 6,
    ID_OR_TEST_ATTR_BONUS: 18,
    STABLE_ATTR_BONUS: 10,
    LABEL_ATTR_BONUS: 10,
    CLASS_BASE_SCORE: 154,
    CLASS_INDEX_DECAY: 6,
    CLASS_COMBINATION_DECAY: 4,
    BARE_TAG_SCORE: 38,
    LOCATOR_SINGLE_CLASS_SCORE: 42,
    LOCATOR_MULTI_CLASS_SCORE: 46
  };

  // --- Selector Indicator Substrings ---
  // Used by isStrongFastExactCandidate and scoreExactSelector to classify selectors.
  const ID_OR_TEST_INDICATORS = ['#', '[data-testid', '[data-test', '[data-qa'];
  const STABLE_ATTR_INDICATORS = ['[part=', '[data-component', '[data-slot', '[data-name', '[data-value', '[slot='];
  const LABEL_ATTR_INDICATORS = ['[aria-label', '[name=', '[title=', '[placeholder='];
  const STRONG_SELECTOR_INDICATORS = [...ID_OR_TEST_INDICATORS, ...STABLE_ATTR_INDICATORS, ...LABEL_ATTR_INDICATORS];

  // --- Attribute-Based Selector Score Tables ---
  // Used by the unified _buildAttributeBasedSelectors method.
  // Each entry defines the attribute, the score when bare (no tag prefix),
  // the score with tag prefix, and whether the value needs clipping.
  const EXACT_SCORE_TABLE = {
    id: { bare: 240, tagged: 236, bareOnly: true },
    dataTestId: { bare: 226, tagged: 222 },
    name: { bare: 210, tagged: 206 },
    ariaLabel: { bare: 204, tagged: 200, clip: 80 },
    title: { bare: 184, tagged: 180, clip: 80 },
    placeholder: { bare: 176, tagged: 172, clip: 80 },
    href: { tagged: 170, maxLength: 120 },
    src: { tagged: 168, maxLength: 120 },
    role: { bare: 160, tagged: 156, requiresExplicit: true },
    type: { bare: 150, tagged: 146, inputOnly: true }
  };

  const LOCATOR_SCORE_TABLE = {
    id: { tagged: 100, tagOnly: true },
    dataTestId: { tagged: 94 },
    name: { tagged: 84 },
    ariaLabel: { tagged: 82, clip: 80 },
    placeholder: { tagged: 74, clip: 80 },
    title: { tagged: 70, clip: 80 },
    role: { tagged: 64, requiresExplicit: true },
    type: { tagged: 54, inputOnly: true }
  };

  // --- Allocation-Free Counting Helpers ---

  function countOccurrences(str, char) {
    let count = 0;
    for (let i = 0; i < str.length; i += 1) {
      if (str[i] === char) {
        count += 1;
      }
    }
    return count;
  }

  function countSubstring(str, sub) {
    let count = 0;
    let pos = 0;
    while ((pos = str.indexOf(sub, pos)) !== -1) {
      count += 1;
      pos += sub.length;
    }
    return count;
  }

  class FrameOfReferencePicker {
    constructor() {
      this.active = false;
      this.currentRawTarget = null;
      this.currentTarget = null;
      this.currentTargetIndex = -1;
      this.targetPath = [];
      this.pendingPointer = null;
      this.rafId = 0;
      this.refinementLocked = false;
      this.forceOutlineRefresh = false;
      this._shadowHost = null;
      this._shadowRoot = null;
      this.overlayRoot = null;
      this.scrims = null;
      this.outline = null;
      this.toast = null;
      this.previousHtmlCursor = null;
      this.previousBodyCursor = null;
      this._originalPushState = null;
      this._originalReplaceState = null;
      this._rectCache = null;
      this._queryCache = null;
      this._toastTimerId = 0;
      this._feedbackTimerId = 0;
      this._feedbackResolve = null;
      this._copyInFlight = false;
      this._listenersAttached = false;

      this.handlePointerMove = this.handlePointerMove.bind(this);
      this.handlePointerDown = this.handlePointerDown.bind(this);
      this.handleClick = this.handleClick.bind(this);
      this.handleKeydown = this.handleKeydown.bind(this);
      this.handleViewportChange = this.handleViewportChange.bind(this);
      this.handleNavigation = this.handleNavigation.bind(this);
      this.flushRefresh = this.flushRefresh.bind(this);
    }

    // --- Lifecycle & State ---

    toggle() {
      if (this.active) {
        this.deactivate();
        return;
      }

      this.activate();
    }

    resetTargetState() {
      this.currentRawTarget = null;
      this.currentTarget = null;
      this.currentTargetIndex = -1;
      this.targetPath = [];
      this.pendingPointer = null;
      this.refinementLocked = false;
      this._copyInFlight = false;
    }

    activate() {
      if (this.active) {
        return;
      }

      this.ensureUi();
      this.active = true;
      this.resetTargetState();
      this.forceOutlineRefresh = true;
      this.overlayRoot.style.display = 'block';
      this.captureCursor();
      this.attachListeners();
      window.addEventListener('popstate', this.handleNavigation);
      this.interceptHistoryNavigation();
      this.notifyState(true);
    }

    deactivate() {
      if (!this.active) {
        return;
      }

      this.active = false;
      this.resetTargetState();
      this.forceOutlineRefresh = false;
      this.detachListeners();
      window.removeEventListener('popstate', this.handleNavigation);
      this.restoreHistoryNavigation();
      this.cancelRefresh();
      clearTimeout(this._feedbackTimerId);
      this._feedbackTimerId = 0;
      if (this._feedbackResolve) {
        this._feedbackResolve();
        this._feedbackResolve = null;
      }
      this.hideOutline();
      this.hideToast();
      this.restoreCursor();
      this.destroyUi();
      this.notifyState(false);
    }

    attachListeners() {
      if (this._listenersAttached) {
        return;
      }
      this._listenersAttached = true;
      document.addEventListener('pointermove', this.handlePointerMove, true);
      document.addEventListener('pointerdown', this.handlePointerDown, true);
      document.addEventListener('click', this.handleClick, true);
      document.addEventListener('keydown', this.handleKeydown, true);
      window.addEventListener('scroll', this.handleViewportChange, { capture: true, passive: true });
      window.addEventListener('resize', this.handleViewportChange, { capture: true, passive: true });
    }

    detachListeners() {
      if (!this._listenersAttached) {
        return;
      }
      this._listenersAttached = false;
      document.removeEventListener('pointermove', this.handlePointerMove, true);
      document.removeEventListener('pointerdown', this.handlePointerDown, true);
      document.removeEventListener('click', this.handleClick, true);
      document.removeEventListener('keydown', this.handleKeydown, true);
      window.removeEventListener('scroll', this.handleViewportChange, { capture: true, passive: true });
      window.removeEventListener('resize', this.handleViewportChange, { capture: true, passive: true });
    }

    captureCursor() {
      this.previousHtmlCursor = {
        value: document.documentElement.style.getPropertyValue('cursor'),
        priority: document.documentElement.style.getPropertyPriority('cursor')
      };

      this.previousBodyCursor = document.body
        ? {
            value: document.body.style.getPropertyValue('cursor'),
            priority: document.body.style.getPropertyPriority('cursor')
          }
        : null;

      document.documentElement.style.setProperty('cursor', 'crosshair', 'important');
      if (document.body) {
        document.body.style.setProperty('cursor', 'crosshair', 'important');
      }
    }

    restoreCursor() {
      if (this.previousHtmlCursor) {
        this.restoreCursorStyle(document.documentElement.style, this.previousHtmlCursor);
      } else {
        document.documentElement.style.removeProperty('cursor');
      }

      if (document.body) {
        if (this.previousBodyCursor) {
          this.restoreCursorStyle(document.body.style, this.previousBodyCursor);
        } else {
          document.body.style.removeProperty('cursor');
        }
      }
    }

    restoreCursorStyle(style, snapshot) {
      if (snapshot.value) {
        style.setProperty('cursor', snapshot.value, snapshot.priority);
      } else {
        style.removeProperty('cursor');
      }
    }

    // --- UI Overlay (Shadow DOM isolated) ---
    //
    // Static styles live in a <style> element injected into the closed shadow root.
    // Only dynamic properties (display, transform, width, height, top, left,
    // opacity, border-color) are set as inline styles by JS methods.

    ensureUi() {
      if (this._shadowHost) {
        return;
      }

      const shadowHost = document.createElement('div');
      shadowHost.id = 'frameofreference-picker-host';
      shadowHost.setAttribute('aria-hidden', 'true');
      shadowHost.style.position = 'fixed';
      shadowHost.style.inset = '0';
      shadowHost.style.pointerEvents = 'none';
      shadowHost.style.zIndex = '2147483647';
      shadowHost.style.margin = '0';
      shadowHost.style.padding = '0';

      let shadowRoot;
      try {
        shadowRoot = shadowHost.attachShadow({ mode: 'closed' });
      } catch (_error) {
        // Fallback: if shadow DOM is unavailable, append directly.
        shadowRoot = shadowHost;
      }

      const styleSheet = document.createElement('style');
      styleSheet.textContent = [
        '#frameofreference-picker-overlay {',
        '  position: fixed; inset: 0; pointer-events: none;',
        '  display: none; margin: 0; padding: 0;',
        '  contain: layout style paint;',
        '}',
        '[data-part] {',
        '  position: fixed; pointer-events: none; box-sizing: border-box;',
        '  margin: 0; padding: 0; display: none;',
        '  transform: translate3d(0px, 0px, 0px);',
        '  will-change: transform, width, height;',
        '}',
        '[data-part="scrim"] {',
        '  background: rgba(75, 85, 99, 0.22);',
        '}',
        '#frameofreference-picker-outline {',
        '  border: 2px solid #ef4444;',
        '  background: transparent;',
        '  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.22);',
        '  transition: border-color 0.15s ease;',
        '}',
        '[data-part="toast"] {',
        '  position: fixed; pointer-events: none; display: none;',
        '  padding: 4px 12px; border-radius: 6px;',
        '  background: rgba(0, 0, 0, 0.78); color: #fff;',
        '  font-size: 13px; font-family: system-ui, -apple-system, sans-serif;',
        '  font-weight: 500; line-height: 1.4; white-space: nowrap;',
        '  z-index: 2147483647; transition: opacity 0.3s ease; opacity: 0;',
        '}'
      ].join('\n');

      const overlayRoot = document.createElement('div');
      overlayRoot.id = 'frameofreference-picker-overlay';

      const topMask = document.createElement('div');
      const leftMask = document.createElement('div');
      const rightMask = document.createElement('div');
      const bottomMask = document.createElement('div');
      const outline = document.createElement('div');

      topMask.setAttribute('data-part', 'scrim');
      leftMask.setAttribute('data-part', 'scrim');
      rightMask.setAttribute('data-part', 'scrim');
      bottomMask.setAttribute('data-part', 'scrim');
      outline.id = 'frameofreference-picker-outline';
      outline.setAttribute('data-part', 'outline');

      overlayRoot.appendChild(topMask);
      overlayRoot.appendChild(leftMask);
      overlayRoot.appendChild(rightMask);
      overlayRoot.appendChild(bottomMask);
      overlayRoot.appendChild(outline);

      // In-page copy feedback toast
      const toast = document.createElement('div');
      toast.setAttribute('data-part', 'toast');
      toast.textContent = 'Copied!';
      overlayRoot.appendChild(toast);

      shadowRoot.appendChild(styleSheet);
      shadowRoot.appendChild(overlayRoot);
      document.documentElement.appendChild(shadowHost);

      this._shadowHost = shadowHost;
      this._shadowRoot = shadowRoot;
      this.overlayRoot = overlayRoot;
      this.scrims = {
        top: topMask,
        left: leftMask,
        right: rightMask,
        bottom: bottomMask
      };
      this.outline = outline;
      this.toast = toast;
    }

    destroyUi() {
      if (!this._shadowHost) {
        return;
      }

      this._shadowHost.remove();
      this._shadowHost = null;
      this._shadowRoot = null;
      this.overlayRoot = null;
      this.scrims = null;
      this.outline = null;
      this.toast = null;
    }

    // --- Event Handlers ---

    suppressEvent(event) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    }

    handlePointerMove(event) {
      if (!this.active) {
        return;
      }

      // Skip scheduling a refresh if the pointer barely moved (within 2px).
      // This eliminates micro-movement noise without adding timestamp tracking.
      const prev = this.pendingPointer;
      if (prev && Math.abs(event.clientX - prev.clientX) < 2 && Math.abs(event.clientY - prev.clientY) < 2) {
        return;
      }

      this.pendingPointer = {
        clientX: event.clientX,
        clientY: event.clientY
      };

      this.scheduleRefresh();
    }

    handlePointerDown(event) {
      if (!this.active || event.button !== 0) {
        return;
      }

      this.suppressEvent(event);
    }

    async handleClick(event) {
      if (!this.active || event.button !== 0) {
        return;
      }

      this.suppressEvent(event);

      if (this._copyInFlight) {
        return;
      }

      this._rectCache = new WeakMap();

      try {
        const previousRawTarget = this.currentRawTarget;
        const fallbackRawTarget = this.resolveEventTarget(event) || previousRawTarget;
        const resolution = this.resolveTargetsAtPoint(event.clientX, event.clientY, fallbackRawTarget);
        if (resolution.primaryTarget) {
          this.setCurrentTargetResolution(resolution, {
            preserveRefinement: resolution.rawTarget === previousRawTarget
          });
        }

        const primaryTarget = this.currentTarget || resolution.primaryTarget;
        if (!primaryTarget) {
          return;
        }

        await this.copyCurrentTarget(primaryTarget);
      } finally {
        this._rectCache = null;
      }
    }

    handleKeydown(event) {
      if (!this.active) {
        return;
      }

      if (event.key === 'Escape') {
        this.suppressEvent(event);

        this.deactivate();
        this.notifyResult('cancelled');
        return;
      }

      if (event.key === 'ArrowUp') {
        this.suppressEvent(event);

        this.refineCurrentTarget(1);
        return;
      }

      if (event.key === 'ArrowDown') {
        this.suppressEvent(event);

        this.refineCurrentTarget(-1);
        return;
      }

      if (event.key === 'Enter') {
        this.suppressEvent(event);

        void this.copyCurrentTarget();
      }
    }

    handleViewportChange() {
      if (!this.active) {
        return;
      }

      if (!this.pendingPointer && !this.currentTarget) {
        return;
      }

      this.forceOutlineRefresh = true;
      this.scheduleRefresh();
    }

    handleNavigation() {
      if (!this.active) {
        return;
      }

      this.deactivate();
      this.notifyResult('cancelled');
    }

    // Intercept history.pushState/replaceState to detect SPA navigations,
    // since there is no native 'pushstate'/'replacestate' event.
    //
    // Risk: if another script patches history *after* the picker activates,
    // restoreHistoryNavigation() will overwrite that script's patch by
    // restoring the pre-activation original. This is an inherent limitation
    // of monkey-patching, mitigated by the picker's short active window.
    interceptHistoryNavigation() {
      this._originalPushState = history.pushState;
      this._originalReplaceState = history.replaceState;
      const self = this;
      history.pushState = function (...args) {
        self._originalPushState.apply(this, args);
        self.handleNavigation();
      };
      history.replaceState = function (...args) {
        self._originalReplaceState.apply(this, args);
        self.handleNavigation();
      };
    }

    restoreHistoryNavigation() {
      if (this._originalPushState) {
        history.pushState = this._originalPushState;
        this._originalPushState = null;
      }
      if (this._originalReplaceState) {
        history.replaceState = this._originalReplaceState;
        this._originalReplaceState = null;
      }
    }

    scheduleRefresh() {
      if (this.rafId) {
        return;
      }

      this.rafId = window.requestAnimationFrame(this.flushRefresh);
    }

    cancelRefresh() {
      if (!this.rafId) {
        return;
      }

      window.cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }

    flushRefresh() {
      this.rafId = 0;
      if (!this.active) {
        return;
      }

      this._rectCache = new WeakMap();

      try {
        if (!this.pendingPointer) {
          if (this.currentTarget) {
            this.updateOutline();
          }
          return;
        }

        const resolution = this.resolveTargetsAtPoint(
          this.pendingPointer.clientX,
          this.pendingPointer.clientY,
          this.currentRawTarget
        );
        const rawTarget = resolution.rawTarget;
        const previousRawTarget = this.currentRawTarget;
        const previousTarget = this.currentTarget;
        const shouldPreserveRefinement = rawTarget !== null && rawTarget === previousRawTarget;
        const forceOutlineRefresh = this.forceOutlineRefresh;

        this.setCurrentTargetResolution(resolution, {
          preserveRefinement: shouldPreserveRefinement
        });

        const shouldUpdate =
          forceOutlineRefresh || rawTarget !== previousRawTarget || this.currentTarget !== previousTarget;

        this.forceOutlineRefresh = false;

        if (shouldUpdate) {
          this.updateOutline();
        }
      } finally {
        this._rectCache = null;
      }
    }

    setCurrentTargetResolution(resolution, { preserveRefinement = false } = {}) {
      if (!resolution || !resolution.primaryTarget) {
        this.currentRawTarget = null;
        this.currentTarget = null;
        this.currentTargetIndex = -1;
        this.targetPath = [];
        this.refinementLocked = false;
        return;
      }

      const rawTarget = resolution.rawTarget || resolution.primaryTarget;
      const targetPath = resolution.targetPath || this.buildTargetPath(rawTarget);
      if (targetPath.length === 0) {
        targetPath.push(resolution.primaryTarget);
      }

      this.currentRawTarget = rawTarget;
      this.targetPath = targetPath;

      if (
        preserveRefinement &&
        this.refinementLocked &&
        this.currentTarget &&
        targetPath.includes(this.currentTarget)
      ) {
        this.currentTargetIndex = targetPath.indexOf(this.currentTarget);
        this.currentTarget = targetPath[this.currentTargetIndex];
        return;
      }

      const preferredTarget = resolution.primaryTarget;
      const preferredIndex = targetPath.indexOf(preferredTarget);
      this.currentTargetIndex = preferredIndex >= 0 ? preferredIndex : 0;
      this.currentTarget = targetPath[this.currentTargetIndex] || preferredTarget || rawTarget;
      this.refinementLocked = false;
    }

    // --- Target Resolution & Scoring ---

    resolveTargetsAtPoint(clientX, clientY, fallbackRawTarget = null) {
      const stack = this.getSelectableElementsAtPoint(clientX, clientY);
      const initialRawTarget = stack[0] || fallbackRawTarget || null;
      if (!initialRawTarget) {
        return {
          rawTarget: null,
          primaryTarget: null,
          targetPath: []
        };
      }

      const primaryTarget = this.chooseBestTargetCandidate(initialRawTarget, stack);
      const rawTarget = this.findAnchorElementForTarget(primaryTarget, stack, initialRawTarget);

      return {
        rawTarget,
        primaryTarget,
        targetPath: this.buildTargetPath(rawTarget || primaryTarget)
      };
    }

    getSelectableElementsAtPoint(clientX, clientY) {
      const selectable = [];
      const seenElements = new Set();
      const visitedRoots = new Set();
      const addSelectable = (element) => {
        if (!(element instanceof Element)) {
          return;
        }
        if (seenElements.has(element) || this.isOwnedElement(element) || !this.isSelectableElement(element)) {
          return;
        }

        seenElements.add(element);
        selectable.push(element);
      };

      const visitRoot = (root) => {
        if (!root || visitedRoots.has(root)) {
          return;
        }

        visitedRoots.add(root);

        const stack = this.getElementsAtPointFromRoot(root, clientX, clientY);
        for (const element of stack) {
          if (!(element instanceof Element)) {
            continue;
          }

          if (element.shadowRoot) {
            visitRoot(element.shadowRoot);
          }

          addSelectable(element);
        }
      };

      visitRoot(document);

      return selectable;
    }

    getElementsAtPointFromRoot(root, clientX, clientY) {
      if (!root) {
        return [];
      }

      if (typeof root.elementsFromPoint === 'function') {
        return root.elementsFromPoint(clientX, clientY);
      }

      if (typeof root.elementFromPoint === 'function') {
        const element = root.elementFromPoint(clientX, clientY);
        return element ? [element] : [];
      }

      return [];
    }

    chooseBestTargetCandidate(anchorElement, stack) {
      const preferredContainer = this.findPreferredContainer(anchorElement);
      const candidateMap = new Map();
      const stackSlice = stack.length > 0 ? stack.slice(0, TARGET_SCORING.STACK_CANDIDATE_DEPTH) : [anchorElement];

      this._populateCandidateMap(candidateMap, stackSlice, TARGET_SCORING.ANCESTOR_CANDIDATE_DEPTH);

      this._recordCandidate(candidateMap, anchorElement, 0, 0);

      const promotedTarget = this.promoteTarget(anchorElement, preferredContainer);
      if (promotedTarget) {
        this._recordCandidate(candidateMap, promotedTarget, 0, 0);
      }

      if (preferredContainer) {
        this._recordCandidate(candidateMap, preferredContainer, 0, 1);
      }

      const anchorRect = this.getCachedRect(anchorElement);

      const rankedCandidates = Array.from(candidateMap.values())
        .map((meta) => ({
          ...meta,
          score: this.scoreTargetCandidate(meta.element, anchorElement, meta, preferredContainer, anchorRect)
        }))
        .sort(
          (left, right) =>
            right.score - left.score || left.stackIndex - right.stackIndex || left.ancestorDepth - right.ancestorDepth
        );

      return rankedCandidates[0] ? rankedCandidates[0].element : promotedTarget || anchorElement;
    }

    _populateCandidateMap(candidateMap, stackSlice, maxDepth) {
      for (let stackIndex = 0; stackIndex < stackSlice.length; stackIndex += 1) {
        let current = stackSlice[stackIndex];
        for (let depth = 0; current && depth < maxDepth; depth += 1) {
          this._recordCandidate(candidateMap, current, stackIndex, depth);
          current = this.getParentElement(current);
        }
      }
    }

    _recordCandidate(candidateMap, element, stackIndex, ancestorDepth) {
      if (!element || this.isOwnedElement(element) || !this.isSelectableElement(element)) {
        return;
      }

      const existing = candidateMap.get(element);
      if (existing && existing.stackIndex <= stackIndex && existing.ancestorDepth <= ancestorDepth) {
        return;
      }

      candidateMap.set(element, {
        element,
        stackIndex,
        ancestorDepth
      });
    }

    scoreTargetCandidate(element, anchorElement, meta, preferredContainer, anchorRect) {
      const S = TARGET_SCORING;
      const tag = element.tagName.toLowerCase();
      const role = (element.getAttribute('role') || '').toLowerCase();
      const rect = this.getCachedRect(element);
      const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
      const areaRatio = (rect.width * rect.height) / viewportArea;
      const hasStableAttributes = this.getStableAttributeEntries(element).length > 0;
      const isInteractive = this.isInteractiveElement(element);
      const isTextLike = this.isTextLikeElement(element);
      const hasAccessibleNameSignal = Boolean(
        element.getAttribute('aria-label') ||
        element.getAttribute('aria-labelledby') ||
        element.getAttribute('title') ||
        element.getAttribute('placeholder') ||
        element.getAttribute('alt')
      );

      let score = 0;
      score += Math.max(0, S.STACK_INDEX_BASE - meta.stackIndex * S.STACK_INDEX_DECAY);
      score += Math.max(0, S.ANCESTOR_DEPTH_BASE - meta.ancestorDepth * S.ANCESTOR_DEPTH_DECAY);

      if (element === anchorElement) {
        score += S.ANCHOR_BONUS;
      }

      if (isInteractive) {
        score += S.INTERACTIVE_BOOST;
      }

      if (preferredContainer && element === preferredContainer) {
        score += S.PREFERRED_CONTAINER_BOOST;
      }

      if (
        anchorElement &&
        element !== anchorElement &&
        this.isContainerLikeElement(element, anchorElement, anchorRect)
      ) {
        score += S.CONTAINER_LIKE_BOOST;
      }

      if (this.isMeaningfulElement(element)) {
        score += S.MEANINGFUL_BOOST;
      }

      if (element.id) {
        score += S.ID_BOOST;
      }

      if (this.getTestAttributeName(element)) {
        score += S.TEST_ATTR_BOOST;
      }

      if (role) {
        score += S.ROLE_BOOST;
      }

      if (
        element.hasAttribute('aria-label') ||
        element.hasAttribute('aria-labelledby') ||
        element.hasAttribute('name') ||
        element.hasAttribute('title') ||
        element.hasAttribute('placeholder')
      ) {
        score += S.LABEL_ATTR_BOOST;
      }

      if (hasStableAttributes) {
        score += S.STABLE_ATTR_BOOST;
      }

      if (hasAccessibleNameSignal) {
        score += S.ACCESSIBLE_NAME_BOOST;
      }

      if (this.hasAssociatedLabel(element)) {
        score += S.ASSOCIATED_LABEL_BOOST;
      }

      if (SEMANTIC_TAGS.has(tag)) {
        score += S.SEMANTIC_TAG_BOOST;
      }

      if (isTextLike && !isInteractive) {
        score += S.TEXT_LIKE_PENALTY;
      }

      if (GENERIC_WRAPPER_TAGS.has(tag) && !element.id && !role) {
        score += S.GENERIC_TAG_PENALTY;
      }

      if (SVG_TAGS.has(tag)) {
        score += S.SVG_PENALTY;
      }

      for (const threshold of S.AREA_THRESHOLDS) {
        if (areaRatio > threshold.ratio) {
          score += threshold.penalty;
          break;
        }
      }

      if (areaRatio < S.TINY_AREA_RATIO && !isInteractive) {
        score += S.TINY_AREA_PENALTY;
      }

      if (anchorElement && isTextLike && element !== anchorElement && element.contains(anchorElement)) {
        score += S.TEXT_ANCESTOR_BOOST;
      }

      if (
        element.childElementCount === 0 &&
        !isInteractive &&
        !element.id &&
        !role &&
        !element.getAttribute('aria-label')
      ) {
        score += S.LEAF_NODE_PENALTY;
      }

      return score;
    }

    findAnchorElementForTarget(target, stack, fallbackRawTarget) {
      if (!target) {
        return fallbackRawTarget || null;
      }

      for (const element of stack) {
        if (target === element || target.contains(element)) {
          return element;
        }
      }

      if (fallbackRawTarget && (fallbackRawTarget === target || target.contains(fallbackRawTarget))) {
        return fallbackRawTarget;
      }

      return target;
    }

    buildTargetPath(element) {
      const path = [];
      let current = element;
      for (let depth = 0; current && depth < MAX_TARGET_PATH_DEPTH; depth += 1) {
        if (this.isSelectableElement(current) && !path.includes(current)) {
          path.push(current);
        }
        current = this.getParentElement(current);
      }

      return path;
    }

    refineCurrentTarget(direction) {
      if (this.targetPath.length === 0) {
        return;
      }

      const currentIndex = this.currentTargetIndex >= 0 ? this.currentTargetIndex : 0;
      const nextIndex = Math.max(0, Math.min(this.targetPath.length - 1, currentIndex + direction));
      if (nextIndex === currentIndex) {
        return;
      }

      this.currentTargetIndex = nextIndex;
      this.currentTarget = this.targetPath[nextIndex];
      this.refinementLocked = true;
      this.updateOutline();
    }

    async copyCurrentTarget(target = this.currentTarget) {
      if (!target || this._copyInFlight) {
        return;
      }

      this._copyInFlight = true;

      try {
        const capture = this.buildCapture(target);
        let copiedWithScreenshot = false;

        // Attempt dual clipboard write: text + cropped screenshot.
        // This is best-effort — any failure silently falls back to text-only.
        const imageBlob = await this.captureElementScreenshot(target);
        if (imageBlob) {
          copiedWithScreenshot = await this.copyTextAndImage(capture.clipboardText, imageBlob);
        }

        // Fall back to text-only if screenshot was unavailable or dual write failed.
        if (!copiedWithScreenshot) {
          const copied = await this.copyText(capture.clipboardText);
          if (!copied) {
            this.deactivate();
            this.notifyResult('error');
            return;
          }
        }

        this.flashOutlineSuccess();
        this.showToast(target, copiedWithScreenshot ? 'Copied with screenshot!' : 'Copied!');

        // Allow brief visual feedback before deactivating. The timer ID is
        // stored so deactivate() can cancel it if the user navigates away.
        await new Promise((resolve) => {
          this._feedbackResolve = resolve;
          this._feedbackTimerId = setTimeout(resolve, 600);
        });
        this._feedbackResolve = null;

        this.deactivate();
        this.notifyResult('copied');
      } finally {
        this._copyInFlight = false;
      }
    }

    resolveEventTarget(event) {
      const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
      for (const item of path) {
        if (!(item instanceof Element)) {
          continue;
        }
        if (this.isOwnedElement(item)) {
          continue;
        }
        if (this.isSelectableElement(item)) {
          return item;
        }
      }

      return this.targetAtPoint(event.clientX, event.clientY);
    }

    targetAtPoint(clientX, clientY) {
      return this.getSelectableElementsAtPoint(clientX, clientY)[0] || null;
    }

    isOwnedElement(element) {
      if (!this._shadowHost) {
        return false;
      }
      return element === this._shadowHost || this._shadowHost.contains(element);
    }

    isSelectableElement(element) {
      if (!(element instanceof Element)) {
        return false;
      }

      const tag = element.tagName.toLowerCase();
      if (SKIP_TAGS.has(tag)) {
        return false;
      }

      const rect = this.getCachedRect(element);
      return rect.width > 0 && rect.height > 0;
    }

    promoteTarget(element, preferredContainer) {
      if (!element) {
        return null;
      }

      let current = element;
      for (let depth = 0; current && depth < MAX_TARGET_PATH_DEPTH; depth += 1) {
        if (this.isInteractiveElement(current)) {
          return current;
        }
        current = this.getParentElement(current);
      }

      if (preferredContainer === undefined) {
        preferredContainer = this.findPreferredContainer(element);
      }
      if (preferredContainer) {
        return preferredContainer;
      }

      current = element;
      for (let depth = 0; current && depth < MAX_TARGET_PATH_DEPTH; depth += 1) {
        if (this.isMeaningfulElement(current)) {
          return current;
        }
        current = this.getParentElement(current);
      }

      return element;
    }

    isInteractiveElement(element) {
      const tag = element.tagName.toLowerCase();
      if (INTERACTIVE_TAGS.has(tag)) {
        return true;
      }

      const role = element.getAttribute('role');
      if (role && INTERACTIVE_ROLES.has(role.toLowerCase())) {
        return true;
      }

      return element.getAttribute('contenteditable') === 'true';
    }

    findPreferredContainer(element) {
      if (!this.isTextLikeElement(element)) {
        return null;
      }

      let current = this.getParentElement(element);
      for (let depth = 0; current && depth < MAX_CONTAINER_SEARCH_DEPTH; depth += 1) {
        if (this.isContainerLikeElement(current, element)) {
          return current;
        }
        current = this.getParentElement(current);
      }

      return null;
    }

    getParentElement(element) {
      if (!element) {
        return null;
      }

      if (element.parentElement) {
        return element.parentElement;
      }

      const rootNode = element.getRootNode();
      if (rootNode instanceof ShadowRoot) {
        return rootNode.host || null;
      }

      return null;
    }

    isTextLikeElement(element) {
      const tag = element.tagName.toLowerCase();
      if (TEXTISH_TAGS.has(tag)) {
        return true;
      }

      return (
        tag === 'div' &&
        element.childElementCount === 0 &&
        this.normalizeWhitespace(element.textContent || '').length > 0
      );
    }

    isContainerLikeElement(element, originalElement, originalRect) {
      const tag = element.tagName.toLowerCase();
      const role = (element.getAttribute('role') || '').toLowerCase();
      const rect = this.getCachedRect(element);
      if (!originalRect) {
        originalRect = this.getCachedRect(originalElement);
      }

      if (!CONTAINER_TAGS.has(tag) && !CONTAINER_ROLE_HINTS.has(role)) {
        return false;
      }

      if (rect.width <= 0 || rect.height <= 0) {
        return false;
      }

      const hasStrongClass = Array.prototype.some.call(element.classList, (item) =>
        STRONG_CONTAINER_CLASS_RE.test(item)
      );
      const hasVisualClass = Array.prototype.some.call(element.classList, (item) =>
        VISUAL_CONTAINER_CLASS_RE.test(item)
      );
      const isClearlyLarger =
        rect.width >= originalRect.width + CONTAINER_SIZE_THRESHOLD_PX ||
        rect.height >= originalRect.height + CONTAINER_SIZE_THRESHOLD_PX;

      if (hasStrongClass) {
        return true;
      }

      if (hasVisualClass && element.childElementCount >= 1 && isClearlyLarger) {
        return true;
      }

      return CONTAINER_ROLE_HINTS.has(role) && element.childElementCount >= 1 && isClearlyLarger;
    }

    isMeaningfulElement(element) {
      const tag = element.tagName.toLowerCase();
      if (SEMANTIC_TAGS.has(tag)) {
        return true;
      }

      if (element.hasAttribute('role')) {
        return true;
      }

      return Boolean(element.id || this.getTestAttributeName(element) || element.getAttribute('aria-label'));
    }

    // --- Rect Caching ---

    getCachedRect(element) {
      if (this._rectCache) {
        const cached = this._rectCache.get(element);
        if (cached !== undefined) {
          return cached;
        }

        const rect = element.getBoundingClientRect();
        this._rectCache.set(element, rect);
        return rect;
      }

      return element.getBoundingClientRect();
    }

    // --- Outline & Toast ---

    updateOutline() {
      if (!this.outline || !this.scrims || !this.currentTarget) {
        this.hideOutline();
        return;
      }

      const rect = this.getCachedRect(this.currentTarget);
      if (rect.width <= 0 || rect.height <= 0) {
        this.hideOutline();
        return;
      }

      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const left = Math.max(0, Math.round(rect.left));
      const top = Math.max(0, Math.round(rect.top));
      const right = Math.min(viewportWidth, Math.round(rect.right));
      const bottom = Math.min(viewportHeight, Math.round(rect.bottom));
      const width = Math.max(0, right - left);
      const height = Math.max(0, bottom - top);

      this.scrims.top.style.display = 'block';
      this.scrims.top.style.transform = 'translate3d(0px, 0px, 0)';
      this.scrims.top.style.width = `${viewportWidth}px`;
      this.scrims.top.style.height = `${top}px`;

      this.scrims.left.style.display = 'block';
      this.scrims.left.style.transform = `translate3d(0px, ${top}px, 0)`;
      this.scrims.left.style.width = `${left}px`;
      this.scrims.left.style.height = `${height}px`;

      this.scrims.right.style.display = 'block';
      this.scrims.right.style.transform = `translate3d(${right}px, ${top}px, 0)`;
      this.scrims.right.style.width = `${Math.max(0, viewportWidth - right)}px`;
      this.scrims.right.style.height = `${height}px`;

      this.scrims.bottom.style.display = 'block';
      this.scrims.bottom.style.transform = `translate3d(0px, ${bottom}px, 0)`;
      this.scrims.bottom.style.width = `${viewportWidth}px`;
      this.scrims.bottom.style.height = `${Math.max(0, viewportHeight - bottom)}px`;

      this.outline.style.display = 'block';
      this.outline.style.transform = `translate3d(${left}px, ${top}px, 0)`;
      this.outline.style.width = `${width}px`;
      this.outline.style.height = `${height}px`;
    }

    hideOutline() {
      if (!this.outline || !this.scrims) {
        return;
      }

      this.scrims.top.style.display = 'none';
      this.scrims.left.style.display = 'none';
      this.scrims.right.style.display = 'none';
      this.scrims.bottom.style.display = 'none';
      this.outline.style.display = 'none';
    }

    flashOutlineSuccess() {
      if (!this.outline) {
        return;
      }
      this.outline.style.borderColor = '#22c55e';
    }

    showToast(targetElement, message = 'Copied!') {
      if (!this.toast || !this.outline) {
        return;
      }

      this.toast.textContent = message;

      const rect = this.getCachedRect(targetElement);
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      // Position toast just below the selected element, centered horizontally.
      let toastTop = Math.round(rect.bottom) + TOAST_LAYOUT.OFFSET_Y;
      let toastLeft = Math.round(rect.left + rect.width / 2);

      // Clamp to viewport.
      if (toastTop + TOAST_LAYOUT.ESTIMATED_HEIGHT > viewportHeight) {
        toastTop = Math.max(TOAST_LAYOUT.MIN_TOP_MARGIN, Math.round(rect.top) - TOAST_LAYOUT.ESTIMATED_HEIGHT);
      }
      toastLeft = Math.max(
        TOAST_LAYOUT.MIN_SIDE_MARGIN,
        Math.min(viewportWidth - TOAST_LAYOUT.MIN_RIGHT_CLEARANCE, toastLeft - TOAST_LAYOUT.CENTER_OFFSET)
      );

      this.toast.style.top = `${toastTop}px`;
      this.toast.style.left = `${toastLeft}px`;
      this.toast.style.display = 'block';
      this.toast.style.opacity = '1';

      this._toastTimerId = setTimeout(() => {
        if (this.toast) {
          this.toast.style.opacity = '0';
        }
      }, 400);
    }

    hideToast() {
      if (!this.toast) {
        return;
      }
      clearTimeout(this._toastTimerId);
      this._toastTimerId = 0;
      this.toast.style.display = 'none';
      this.toast.style.opacity = '0';

      // Reset outline color for next activation.
      if (this.outline) {
        this.outline.style.borderColor = '#ef4444';
      }
    }

    // --- Element Analysis ---

    summarizeElement(element) {
      const tag = element.tagName.toLowerCase();
      const dataTestAttribute = this.getTestAttributeName(element);
      const summary = {
        tag,
        text: this.extractElementText(element),
        id: element.id || '',
        className: element.getAttribute('class') || '',
        role: this.getElementRole(element),
        name: element.getAttribute('name') || '',
        type: element.getAttribute('type') || '',
        ariaLabel: element.getAttribute('aria-label') || '',
        dataTestAttribute,
        dataTestId: dataTestAttribute ? element.getAttribute(dataTestAttribute) || '' : '',
        href: element.getAttribute('href') || '',
        src: element.getAttribute('src') || '',
        placeholder: element.getAttribute('placeholder') || '',
        title: element.getAttribute('title') || '',
        value: 'value' in element ? String(element.value || '') : '',
        checked: 'checked' in element ? String(Boolean(element.checked)) : ''
      };

      const classes = summary.className
        ? summary.className
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 3)
            .map((item) => `.${item}`)
            .join('')
        : '';

      summary.descriptor = `${tag}${summary.id ? `#${summary.id}` : ''}${classes}`;
      return summary;
    }

    getTestAttributeName(element) {
      if (element.hasAttribute('data-testid')) {
        return 'data-testid';
      }

      if (element.hasAttribute('data-test')) {
        return 'data-test';
      }

      if (element.hasAttribute('data-qa')) {
        return 'data-qa';
      }

      if (element.hasAttribute('data-cy')) {
        return 'data-cy';
      }

      return '';
    }

    getElementRole(element) {
      const explicitRole = this.normalizeWhitespace(element.getAttribute('role') || '').toLowerCase();
      if (explicitRole) {
        return explicitRole;
      }

      const tag = element.tagName.toLowerCase();
      if (tag === 'a' && element.hasAttribute('href')) {
        return 'link';
      }

      if (tag === 'button' || tag === 'summary') {
        return 'button';
      }

      if (tag === 'select') {
        return 'combobox';
      }

      if (tag === 'textarea') {
        return 'textbox';
      }

      if (tag === 'option') {
        return 'option';
      }

      if (tag === 'nav') {
        return 'navigation';
      }

      if (tag === 'main') {
        return 'main';
      }

      if (tag === 'aside') {
        return 'complementary';
      }

      // Per spec, <header> has role "banner" only when not nested inside
      // <article>, <aside>, <main>, <nav>, or <section>. For LLM output
      // descriptiveness, we always return "banner" as a simplification.
      if (tag === 'header') {
        return 'banner';
      }

      // Same sectioning caveat as <header> — always returning "contentinfo"
      // for descriptiveness.
      if (tag === 'footer') {
        return 'contentinfo';
      }

      // <form> has implicit role "form" only when it has an accessible name.
      if (
        tag === 'form' &&
        (element.hasAttribute('aria-label') || element.hasAttribute('aria-labelledby') || element.hasAttribute('name'))
      ) {
        return 'form';
      }

      if (tag === 'img' && element.hasAttribute('alt')) {
        return 'img';
      }

      // Media elements have no formal ARIA role mapping, but returning the tag
      // name as a descriptive role produces far better Target: lines
      // (e.g., "Target: video ..." instead of "Target: video").
      if (tag === 'video' || tag === 'audio' || tag === 'canvas') {
        return tag;
      }

      // The <search> element was added to HTML in 2023.
      if (tag === 'search') {
        return 'search';
      }

      if (tag !== 'input') {
        return '';
      }

      const inputType = (element.getAttribute('type') || 'text').toLowerCase();
      if (inputType === 'checkbox') {
        return 'checkbox';
      }

      if (inputType === 'radio') {
        return 'radio';
      }

      if (inputType === 'range') {
        return 'slider';
      }

      if (inputType === 'search') {
        return 'searchbox';
      }

      if (BUTTON_INPUT_TYPES.has(inputType)) {
        return 'button';
      }

      return 'textbox';
    }

    extractElementText(element) {
      const candidates = [
        element.getAttribute('aria-label') || '',
        this.getAriaLabelledByText(element),
        this.getAssociatedLabelText(element),
        element.getAttribute('alt') || '',
        element.getAttribute('placeholder') || '',
        element.getAttribute('title') || '',
        this.getValueLabelText(element),
        this.getMediaDescription(element),
        element.innerText || element.textContent || ''
      ];

      for (const candidate of candidates) {
        const normalized = this.normalizeWhitespace(candidate);
        if (normalized) {
          return normalized;
        }
      }

      return '';
    }

    getAssociatedLabelText(element) {
      const root = this.getQueryRoot(element);
      const id = element.id;
      if (id && typeof root.querySelector === 'function') {
        try {
          const label = root.querySelector(`label[for="${this.escapeAttributeValue(id)}"]`);
          if (label) {
            return label.innerText || label.textContent || '';
          }
        } catch (_error) {
          // ID contains characters that break CSS selectors.
        }
      }

      const closestLabel = element.closest('label');
      if (closestLabel) {
        return closestLabel.innerText || closestLabel.textContent || '';
      }

      return '';
    }

    getAriaLabelledByText(element) {
      const labelledBy = this.normalizeWhitespace(element.getAttribute('aria-labelledby') || '');
      if (!labelledBy) {
        return '';
      }

      const root = this.getQueryRoot(element);
      const labels = [];
      for (const id of labelledBy.split(/\s+/)) {
        const escapedId = CSS.escape(id);
        const localMatch = typeof root.querySelector === 'function' ? root.querySelector(`#${escapedId}`) : null;
        const documentMatch = root !== document ? document.querySelector(`#${escapedId}`) : null;
        const label = localMatch || documentMatch;
        if (!label) {
          continue;
        }

        const text = this.normalizeWhitespace(label.innerText || label.textContent || '');
        if (text) {
          labels.push(text);
        }
      }

      return labels.join(' ');
    }

    getValueLabelText(element) {
      if (!('value' in element)) {
        return '';
      }

      const tag = element.tagName.toLowerCase();
      const type = (element.getAttribute('type') || '').toLowerCase();
      if (tag === 'input' && BUTTON_INPUT_TYPES.has(type)) {
        return String(element.value || '');
      }

      return '';
    }

    hasAssociatedLabel(element) {
      const tag = element.tagName.toLowerCase();
      if (!LABELABLE_TAGS.has(tag)) {
        return false;
      }

      if (element.closest('label')) {
        return true;
      }

      const id = element.id;
      if (!id) {
        return false;
      }

      const root = this.getQueryRoot(element);
      if (typeof root.querySelector !== 'function') {
        return false;
      }

      try {
        return Boolean(root.querySelector(`label[for="${this.escapeAttributeValue(id)}"]`));
      } catch (_error) {
        return false;
      }
    }

    // --- Media Element Description ---

    // Builds a compact human-readable description for media elements using only
    // DOM attributes and properties already loaded in browser memory. Zero
    // network requests, zero downloads, zero file storage.
    getMediaDescription(element) {
      const tag = (element.tagName || '').toLowerCase();

      if (tag === 'picture') {
        const img = element.querySelector('img');
        return img ? img.getAttribute('alt') || '' : '';
      }

      if (tag !== 'video' && tag !== 'audio' && tag !== 'canvas') {
        return '';
      }

      if (tag === 'canvas') {
        const w = element.getAttribute('width');
        const h = element.getAttribute('height');
        const dims = w && h ? ` (${w}x${h})` : '';
        return `canvas${dims}`;
      }

      // Video or audio element.
      const parts = [];

      // Primary label: filename from the source URL.
      const filename =
        this.extractFilenameFromUrl(element.currentSrc || '') ||
        this.extractFilenameFromUrl(element.getAttribute('src') || '');
      if (filename) {
        parts.push(filename);
      }

      // Append dimensions for video (from intrinsic size or attributes).
      if (tag === 'video') {
        const vw = element.videoWidth || Number(element.getAttribute('width')) || 0;
        const vh = element.videoHeight || Number(element.getAttribute('height')) || 0;
        if (vw > 0 && vh > 0) {
          parts.push(`${vw}x${vh}`);
        }
      }

      // Append informative boolean state flags.
      const flags = [];
      if (element.muted) {
        flags.push('muted');
      }
      if (element.loop) {
        flags.push('loop');
      }
      if (element.autoplay) {
        flags.push('autoplay');
      }
      if (flags.length > 0) {
        parts.push(flags.join(', '));
      }

      if (parts.length === 0) {
        return '';
      }

      return parts.join(', ');
    }

    // Extracts the filename (basename) from a URL string without making any
    // network request. Purely string parsing on an already-loaded attribute value.
    extractFilenameFromUrl(url) {
      if (!url) {
        return '';
      }

      try {
        const pathname = new URL(url, location.href).pathname;
        const basename = pathname.split('/').pop() || '';
        // Filter out generic basenames that provide no useful context.
        if (!basename || basename === 'index.html' || basename === 'index.htm') {
          return '';
        }
        return basename;
      } catch (_error) {
        return '';
      }
    }

    getStableAttributeEntries(element) {
      const candidates = [
        { name: 'part', seedScore: 168 },
        { name: 'data-component', seedScore: 160 },
        { name: 'data-slot', seedScore: 152 },
        { name: 'data-name', seedScore: 148 },
        { name: 'data-value', seedScore: 142 },
        { name: 'data-state', seedScore: 136 },
        { name: 'data-variant', seedScore: 132 },
        { name: 'data-size', seedScore: 128 },
        { name: 'slot', seedScore: 124 }
      ];

      return candidates
        .map((entry) => {
          const value = this.normalizeWhitespace(element.getAttribute(entry.name) || '');
          if (!value || value.length > 80) {
            return null;
          }

          return {
            ...entry,
            value
          };
        })
        .filter(Boolean);
    }

    findContextElement(element) {
      let current = this.getParentElement(element);
      for (let depth = 0; current && depth < MAX_CONTEXT_SEARCH_DEPTH; depth += 1) {
        const tag = current.tagName.toLowerCase();
        if (CONTEXT_TAGS.has(tag) || current.id || current.getAttribute('role')) {
          return current;
        }
        current = this.getParentElement(current);
      }

      return element.parentElement;
    }

    // --- Capture & Clipboard ---

    buildCapture(primaryTarget) {
      // Initialize a transient query cache shared across exact + locator paths
      // to avoid redundant DOM queries during the capture phase.
      this._queryCache = new Map();

      try {
        return this._buildCaptureInner(primaryTarget);
      } finally {
        this._queryCache = null;
      }
    }

    _buildCaptureInner(primaryTarget) {
      const path = this.buildCompactPath();
      const contextElement = this.findContextElement(primaryTarget);
      const primarySummary = this.summarizeElement(primaryTarget);
      const contextSummary = contextElement ? this.summarizeElement(contextElement) : null;
      const warnings = this.buildWarnings(primaryTarget);
      const primaryLabel = this.getPrimaryLabel(primarySummary);
      const exactReference = this.buildExactReference(primaryTarget);
      const locatorCandidates = this.buildLocatorCandidates(primaryTarget, primarySummary, contextElement);
      const region = contextSummary ? this.describeContext(contextElement, contextSummary) : '';
      const shouldIncludeLocatorFallback =
        exactReference && locatorCandidates[0]
          ? this.shouldIncludeLocatorFallback(exactReference, locatorCandidates[0])
          : false;
      const lines = [
        '# Frame of Reference (UI element reference)',
        `Path: ${path} (page route)`,
        this.buildCaptureTargetLine(primarySummary, primaryLabel)
      ];

      if (exactReference) {
        lines.push(`Exact: ${this.formatExactReference(exactReference)} (CSS selector)`);
      }

      if ((!exactReference || shouldIncludeLocatorFallback) && locatorCandidates[0]) {
        lines.push(`Locator: ${this.formatLocatorCandidate(locatorCandidates[0])} (readable fallback)`);
      }

      if (region && contextElement && contextElement !== primaryTarget) {
        lines.push(`Region: ${region} (parent container)`);
      }

      if (warnings.length > 0) {
        lines.push(`Note: ${warnings[0]}`);
      }

      return {
        clipboardText: lines.join('\n'),
        shortLabel: primarySummary.descriptor
      };
    }

    buildCaptureTargetLine(primarySummary, primaryLabel) {
      const targetDescriptor = primarySummary.role || primarySummary.tag;

      if (!primaryLabel) {
        return `Target: ${targetDescriptor} (selected element)`;
      }

      return `Target: ${targetDescriptor} "${primaryLabel}" (selected element)`;
    }

    buildCompactPath() {
      const searchParams = new URLSearchParams(location.search || '');

      // Collect keys to delete first, then remove in a second pass to avoid
      // mutating the iterator during traversal.
      const noisyKeys = [];
      for (const key of searchParams.keys()) {
        if (this.isNoisyQueryParam(key)) {
          noisyKeys.push(key);
        }
      }
      for (const key of noisyKeys) {
        searchParams.delete(key);
      }

      const search = searchParams.toString();
      const path = location.pathname || '/';
      const hash = location.hash || '';
      const host = location.host || location.hostname || '';
      return `${host}${path}${search ? `?${search}` : ''}${hash}` || '/';
    }

    isNoisyQueryParam(key) {
      const normalizedKey = String(key || '').toLowerCase();
      return (
        normalizedKey.startsWith('utm_') ||
        CLID_SUFFIX_RE.test(normalizedKey) ||
        NOISY_QUERY_PARAM_KEYS.has(normalizedKey)
      );
    }

    shouldIncludeLocatorFallback(reference, locatorCandidate) {
      if (!reference || !locatorCandidate || locatorCandidate.matchCount !== 1) {
        return false;
      }

      const exactText = reference.text || '';
      const exactDotCount = countOccurrences(exactText, '.');
      const exactDepthCount = countSubstring(exactText, ' > ');
      const exactIsHeavy =
        exactText.includes(':nth-of-type(') || exactText.length > 96 || exactDotCount >= 4 || exactDepthCount >= 2;

      if (!exactIsHeavy) {
        return false;
      }

      return locatorCandidate.text.length + 14 < exactText.length;
    }

    // --- Selector Building ---

    // Shared helper: adds a selector to a list if not already present,
    // optionally appending an :nth-of-type variant for sibling disambiguation.
    _addUniqueSelector(seen, list, selector, seedScore, element, allowSiblingNth) {
      if (!selector || seen.has(selector)) {
        return;
      }

      seen.add(selector);
      list.push({ selector, seedScore });

      if (!allowSiblingNth) {
        return;
      }

      const nthSelector = this.makeSiblingSpecificSelector(element, selector);
      if (!nthSelector || seen.has(nthSelector)) {
        return;
      }

      seen.add(nthSelector);
      list.push({
        selector: nthSelector,
        seedScore: seedScore + 4
      });
    }

    // Unified method: generates attribute-based selector candidates from a score table.
    // Both buildExactNodeOptions and buildSelectorVariants delegate here.
    _buildAttributeBasedSelectors(element, summary, scoreTable, options) {
      const { seen, list, allowSiblingNth = true } = options;
      const tag = summary.tag;

      const addPair = (attr, bare, tagged, value, opts = {}) => {
        if (!value) {
          return;
        }
        if (opts.maxLength && value.length > opts.maxLength) {
          return;
        }
        if (opts.requiresExplicit && !element.hasAttribute('role')) {
          return;
        }
        if (opts.inputOnly && tag !== 'input') {
          return;
        }

        const clipped = opts.clip ? this.clipText(value, opts.clip) : value;
        const escaped = this.escapeAttributeValue(clipped);
        const selectorBody = `[${attr}="${escaped}"]`;
        const nth = allowSiblingNth;

        if (bare !== undefined && !opts.tagOnly) {
          this._addUniqueSelector(seen, list, selectorBody, bare, element, nth);
        }
        if (tagged !== undefined) {
          this._addUniqueSelector(seen, list, `${tag}${selectorBody}`, tagged, element, nth);
        }
      };

      const t = scoreTable;

      if (t.id && summary.id) {
        if (t.id.bareOnly || t.id.bare !== undefined) {
          this._addUniqueSelector(seen, list, `#${CSS.escape(summary.id)}`, t.id.bare || t.id.tagged, element, false);
        }
        if (t.id.tagged !== undefined) {
          this._addUniqueSelector(seen, list, `${tag}#${CSS.escape(summary.id)}`, t.id.tagged, element, false);
        }
      }

      if (t.dataTestId && summary.dataTestId && summary.dataTestAttribute) {
        addPair(summary.dataTestAttribute, t.dataTestId.bare, t.dataTestId.tagged, summary.dataTestId);
      }

      if (t.name) {
        addPair('name', t.name.bare, t.name.tagged, summary.name);
      }

      if (t.ariaLabel) {
        addPair('aria-label', t.ariaLabel.bare, t.ariaLabel.tagged, summary.ariaLabel, { clip: t.ariaLabel.clip });
      }

      if (t.title) {
        addPair('title', t.title.bare, t.title.tagged, summary.title, { clip: t.title.clip });
      }

      if (t.placeholder) {
        addPair('placeholder', t.placeholder.bare, t.placeholder.tagged, summary.placeholder, {
          clip: t.placeholder.clip
        });
      }

      if (t.href && summary.href) {
        addPair('href', t.href.bare, t.href.tagged, summary.href, { maxLength: t.href.maxLength });
      }

      if (t.src && summary.src) {
        addPair('src', t.src.bare, t.src.tagged, summary.src, { maxLength: t.src.maxLength });
      }

      if (t.role && summary.role) {
        addPair('role', t.role.bare, t.role.tagged, summary.role, { requiresExplicit: t.role.requiresExplicit });
      }

      if (t.type && summary.type) {
        addPair('type', t.type.bare, t.type.tagged, summary.type, { inputOnly: t.type.inputOnly });
      }
    }

    buildExactReference(element) {
      const segments = [];
      let current = element;
      while (current) {
        const bestSelector = this.buildBestExactSelector(current);
        if (!bestSelector) {
          return null;
        }

        segments.unshift(bestSelector);

        const rootNode = current.getRootNode();
        if (!(rootNode instanceof ShadowRoot)) {
          break;
        }

        current = rootNode.host || null;
      }

      return {
        text: `${location.hostname || location.host || 'page'}##${segments
          .map((segment) => segment.selector)
          .join(' >>> ')}`,
        matchCount: segments.length > 1 ? 1 : segments[0].matchCount
      };
    }

    formatExactReference(reference) {
      if (!reference) {
        return '';
      }

      if (reference.matchCount === 1) {
        return reference.text;
      }

      return `${reference.text} (${reference.matchCount} matches)`;
    }

    buildBestExactSelector(element) {
      const root = this.getQueryRoot(element);
      const matchCache = new Map();
      const countCache = new Map();
      const getMatches = (selector) => {
        if (matchCache.has(selector)) {
          return matchCache.get(selector);
        }

        const matches = this.findCssMatches(root, selector);
        matchCache.set(selector, matches);
        countCache.set(selector, matches.length);
        return matches;
      };
      // Count-only path: reuses cached arrays when available, otherwise avoids
      // Array.from() allocation when only the count is needed for scoring.
      const getMatchCount = (selector) => {
        if (countCache.has(selector)) {
          return countCache.get(selector);
        }

        const count = this.countCssMatches(root, selector);
        countCache.set(selector, count);
        return count;
      };

      const chain = [];
      let current = element;
      for (let depth = 0; current && depth < 6; depth += 1) {
        chain.push(this.buildExactNodeOptions(current, getMatches, getMatchCount));
        if (depth > 0 && this.hasStrongSelectorAnchor(this.summarizeElement(current))) {
          break;
        }
        current = current.parentElement;
      }

      if (chain.length === 0) {
        return null;
      }

      const candidateMap = new Map();
      const validateCandidates = (candidates) => {
        return candidates
          .map((candidate) => {
            const matches = getMatches(candidate.selector);
            if (matches.length === 0 || !matches.includes(element)) {
              return null;
            }

            return {
              selector: candidate.selector,
              matchCount: matches.length,
              score: this.scoreExactSelector(candidate.selector, candidate.seedScore, matches.length)
            };
          })
          .filter(Boolean)
          .sort(
            (left, right) =>
              right.score - left.score ||
              left.matchCount - right.matchCount ||
              left.selector.length - right.selector.length
          );
      };
      const addCandidate = (selector, seedScore) => {
        if (!selector) {
          return;
        }

        const existing = candidateMap.get(selector);
        if (!existing || existing.seedScore < seedScore) {
          candidateMap.set(selector, { selector, seedScore });
        }
      };

      let beam = chain[0].options.slice(0, 8).map((option) => ({
        selector: option.selector,
        seedScore: option.seedScore
      }));
      for (const candidate of beam) {
        addCandidate(candidate.selector, candidate.seedScore);
      }

      const immediateCandidate = validateCandidates(beam)[0];
      if (this.isStrongFastExactCandidate(immediateCandidate)) {
        return immediateCandidate;
      }

      for (let depth = 1; depth < chain.length; depth += 1) {
        beam = this._beamSearchStep(beam, chain[depth].options.slice(0, 4), depth, candidateMap);

        const earlyCandidate = validateCandidates(beam)[0];
        if (this.isStrongFastExactCandidate(earlyCandidate)) {
          return earlyCandidate;
        }
      }

      const validated = validateCandidates(Array.from(candidateMap.values()));

      return validated[0] || null;
    }

    _beamSearchStep(beam, ancestorOptions, depth, candidateMap) {
      const nextMap = new Map();

      const addNext = (selector, seedScore) => {
        if (!selector) {
          return;
        }

        const existing = nextMap.get(selector);
        if (!existing || existing.seedScore < seedScore) {
          nextMap.set(selector, { selector, seedScore });
        }
      };

      for (const base of beam.slice(0, 10)) {
        for (const option of ancestorOptions) {
          addNext(`${option.selector} > ${base.selector}`, base.seedScore + option.seedScore - depth * 6);
          addNext(`${option.selector} ${base.selector}`, base.seedScore + option.seedScore - depth * 10);
        }
      }

      const result = Array.from(nextMap.values())
        .sort((left, right) => right.seedScore - left.seedScore || left.selector.length - right.selector.length)
        .slice(0, 12);

      for (const candidate of result) {
        const existing = candidateMap.get(candidate.selector);
        if (!existing || existing.seedScore < candidate.seedScore) {
          candidateMap.set(candidate.selector, candidate);
        }
      }

      return result;
    }

    isStrongFastExactCandidate(candidate) {
      if (!candidate || candidate.matchCount !== 1) {
        return false;
      }

      return (
        candidate.selector.length <= 48 ||
        STRONG_SELECTOR_INDICATORS.some((indicator) => candidate.selector.includes(indicator))
      );
    }

    buildExactNodeOptions(element, getMatches, getMatchCount) {
      const summary = this.summarizeElement(element);
      const tag = summary.tag;
      const options = [];
      const seen = new Set();

      // Generate attribute-based selectors using the unified method.
      this._buildAttributeBasedSelectors(element, summary, EXACT_SCORE_TABLE, {
        seen,
        list: options,
        allowSiblingNth: true,
        allowNthOfType: true
      });

      // Stable data attributes (data-component, data-slot, etc.)
      for (const entry of this.getStableAttributeEntries(element)) {
        this._addUniqueSelector(
          seen,
          options,
          `[${entry.name}="${this.escapeAttributeValue(entry.value)}"]`,
          entry.seedScore,
          element,
          true
        );
        this._addUniqueSelector(
          seen,
          options,
          `${tag}[${entry.name}="${this.escapeAttributeValue(entry.value)}"]`,
          entry.seedScore - 4,
          element,
          true
        );
      }

      // Class-based selectors (uses count-only path to avoid full array allocation).
      for (const entry of this.buildExactClassSelectors(element, tag, getMatchCount || getMatches)) {
        this._addUniqueSelector(seen, options, entry.selector, entry.seedScore, element, true);
      }

      // Bare tag as last resort.
      this._addUniqueSelector(seen, options, tag, SELECTOR_SCORING.BARE_TAG_SCORE, element, true);

      return {
        summary,
        options: options
          .sort((left, right) => right.seedScore - left.seedScore || left.selector.length - right.selector.length)
          .slice(0, 10)
      };
    }

    buildExactClassSelectors(element, tag, getMatchCount) {
      const classNames = Array.from(element.classList).filter(Boolean);
      if (classNames.length === 0) {
        return [];
      }

      const metrics = classNames
        .map((name) => {
          const selector = `.${CSS.escape(name)}`;
          const matchCount = getMatchCount(selector);
          return {
            name,
            selector,
            matchCount,
            score: this.scoreExactClassToken(name, matchCount)
          };
        })
        .sort(
          (left, right) =>
            left.matchCount - right.matchCount || right.score - left.score || left.name.length - right.name.length
        )
        .slice(0, 8);

      const selected = [];
      const results = [];
      const seen = new Set();
      const addResult = (selector, seedScore) => {
        if (!selector || seen.has(selector)) {
          return;
        }
        seen.add(selector);
        results.push({ selector, seedScore });
      };

      for (let index = 0; index < metrics.length; index += 1) {
        const metric = metrics[index];
        selected.push(metric.name);
        const escapedClasses = selected.map((name) => `.${CSS.escape(name)}`).join('');
        const bareSelector = escapedClasses;
        const tagSelector = `${tag}${escapedClasses}`;
        const bareCount = getMatchCount(bareSelector);
        const tagCount = getMatchCount(tagSelector);
        const baseScore =
          SELECTOR_SCORING.CLASS_BASE_SCORE -
          index * SELECTOR_SCORING.CLASS_INDEX_DECAY -
          Math.max(0, selected.length - 1) * SELECTOR_SCORING.CLASS_COMBINATION_DECAY;

        addResult(bareSelector, baseScore + Math.max(0, 12 - bareCount));
        addResult(tagSelector, baseScore + 2 + Math.max(0, 12 - tagCount));
      }

      if (classNames.length <= 8) {
        const fullSelector = classNames.map((name) => `.${CSS.escape(name)}`).join('');
        addResult(fullSelector, 118);
        addResult(`${tag}${fullSelector}`, 122);
      }

      return results
        .sort((left, right) => right.seedScore - left.seedScore || left.selector.length - right.selector.length)
        .slice(0, 8);
    }

    scoreExactClassToken(token, matchCount) {
      let score = 0;
      score += matchCount === 1 ? 24 : Math.max(0, 16 - matchCount);

      if (token.length <= 18) {
        score += 8;
      } else if (token.length <= 32) {
        score += 4;
      } else {
        score -= 2;
      }

      if (ALPHANUMERIC_CLASS_RE.test(token)) {
        score += 4;
      }

      if (STRONG_CONTAINER_CLASS_RE.test(token)) {
        score += 3;
      }

      if (VISUAL_CONTAINER_CLASS_RE.test(token)) {
        score += 2;
      }

      if (LOW_SIGNAL_CLASS_RE.test(token)) {
        score -= 2;
      }

      return score;
    }

    scoreExactSelector(selector, seedScore, matchCount) {
      const S = SELECTOR_SCORING;
      let score = seedScore;
      score +=
        matchCount === 1 ? S.UNIQUE_MATCH_BONUS : Math.max(0, S.MULTI_MATCH_BASE - matchCount * S.MULTI_MATCH_DECAY);
      score -= selector.length / S.LENGTH_DIVISOR;
      score -= countOccurrences(selector, '.') * S.DOT_PENALTY;
      score -= countSubstring(selector, ' > ') * S.CHILD_COMBINATOR_PENALTY;

      if (selector.includes(':nth-of-type(')) {
        score += S.NTH_OF_TYPE_PENALTY;
      }

      if (selector.includes(' >>> ')) {
        score += S.SHADOW_PIERCING_BONUS;
      }

      if (ID_OR_TEST_INDICATORS.some((ind) => selector.includes(ind))) {
        score += S.ID_OR_TEST_ATTR_BONUS;
      }

      if (STABLE_ATTR_INDICATORS.some((ind) => selector.includes(ind))) {
        score += S.STABLE_ATTR_BONUS;
      }

      if (LABEL_ATTR_INDICATORS.some((ind) => selector.includes(ind))) {
        score += S.LABEL_ATTR_BONUS;
      }

      return score;
    }

    buildLocatorCandidates(element, summary, contextElement) {
      const candidates = [];
      const label = this.getPrimaryLabel(summary);
      const contextSelectors =
        contextElement && contextElement !== element ? this.buildContextSelectorOptions(contextElement) : [];
      const hierarchySelectors = this.buildHierarchySelectorVariants(element);
      const baseSelectors = this.buildSelectorVariants(element, summary, {
        allowNthOfType: true,
        classLimit: 2
      });

      if (summary.role && label) {
        const clippedLabel = this.clipText(label, 80);
        this.addLocatorCandidate(candidates, element, {
          kind: 'role-name',
          text: `role=${summary.role} name="${this.escapeAttributeValue(clippedLabel)}"`,
          role: summary.role,
          name: clippedLabel,
          priority: 96
        });
      }

      if (label && (summary.tag === 'button' || summary.tag === 'a')) {
        const clippedLabel = this.clipText(label, 80);
        this.addLocatorCandidate(candidates, element, {
          kind: 'tag-text',
          text: `${summary.tag} text="${this.escapeAttributeValue(clippedLabel)}"`,
          tag: summary.tag,
          textValue: clippedLabel,
          priority: 78
        });
      }

      for (const variant of hierarchySelectors) {
        this.addLocatorCandidate(candidates, element, {
          kind: 'css',
          text: variant.selector,
          selector: variant.selector,
          priority: variant.priority
        });
      }

      for (const variant of baseSelectors) {
        this.addLocatorCandidate(candidates, element, {
          kind: 'css',
          text: variant.selector,
          selector: variant.selector,
          priority: variant.priority
        });
      }

      for (const contextSelector of contextSelectors.slice(0, 2)) {
        for (const variant of baseSelectors.slice(0, 4)) {
          this.addLocatorCandidate(candidates, element, {
            kind: 'css',
            text: `${contextSelector} > ${variant.selector}`,
            selector: `${contextSelector} > ${variant.selector}`,
            priority: variant.priority - 10
          });

          this.addLocatorCandidate(candidates, element, {
            kind: 'css',
            text: `${contextSelector} ${variant.selector}`,
            selector: `${contextSelector} ${variant.selector}`,
            priority: variant.priority - 14
          });
        }
      }

      if (candidates.length === 0) {
        this.addLocatorCandidate(candidates, element, {
          kind: 'css',
          text: `${summary.tag}:nth-of-type(${this.getNthOfType(element)})`,
          selector: `${summary.tag}:nth-of-type(${this.getNthOfType(element)})`,
          priority: 1
        });
      }

      return candidates
        .sort((left, right) => right.score - left.score || left.text.length - right.text.length)
        .slice(0, 3);
    }

    addLocatorCandidate(candidates, targetElement, candidate) {
      if (!candidate.text || candidates.some((item) => item.text === candidate.text)) {
        return;
      }

      const matches = this.findLocatorMatches(targetElement, candidate);
      if (matches.length === 0 || !matches.includes(targetElement)) {
        return;
      }

      candidates.push({
        ...candidate,
        matchCount: matches.length,
        score: this.scoreLocatorCandidate(candidate, matches.length)
      });
    }

    findLocatorMatches(targetElement, candidate) {
      const root = this.getQueryRoot(targetElement);
      if (candidate.kind === 'role-name') {
        return this.findRoleNameMatches(root, candidate.role, candidate.name);
      }

      if (candidate.kind === 'tag-text') {
        return this.findTagTextMatches(root, candidate.tag, candidate.textValue);
      }

      if (candidate.kind === 'css') {
        return this.findCssMatches(root, candidate.selector);
      }

      return [];
    }

    getQueryRoot(element) {
      const rootNode = element.getRootNode();
      return rootNode instanceof ShadowRoot ? rootNode : document;
    }

    findCssMatches(root, selector) {
      // Check the transient query cache (active during buildCapture) to avoid
      // redundant querySelectorAll calls when exact and locator paths share
      // the same selector.
      if (this._queryCache) {
        const cacheKey = `${root === document ? 'd' : 's'}::${selector}`;
        const cached = this._queryCache.get(cacheKey);
        if (cached !== undefined) {
          return cached;
        }

        try {
          const result = Array.from(root.querySelectorAll(selector));
          this._queryCache.set(cacheKey, result);
          return result;
        } catch (_error) {
          this._queryCache.set(cacheKey, []);
          return [];
        }
      }

      try {
        return Array.from(root.querySelectorAll(selector));
      } catch (_error) {
        return [];
      }
    }

    // Lightweight match count: avoids Array.from() allocation when only the
    // count is needed. Returns the actual count or `limit` (whichever is smaller)
    // so callers that only care about "1 vs many" can pass limit=2.
    // When the query cache is active, derives the count from cached arrays to
    // avoid a second querySelectorAll call.
    countCssMatches(root, selector, limit) {
      if (this._queryCache) {
        const cacheKey = `${root === document ? 'd' : 's'}::${selector}`;
        const cached = this._queryCache.get(cacheKey);
        if (cached !== undefined) {
          const count = cached.length;
          return limit !== undefined && count > limit ? limit : count;
        }
      }

      try {
        const nodeList = root.querySelectorAll(selector);
        const count = nodeList.length;
        return limit !== undefined && count > limit ? limit : count;
      } catch (_error) {
        return 0;
      }
    }

    findRoleNameMatches(root, role, name) {
      const selector = this.getRoleQuerySelector(role);
      return Array.from(root.querySelectorAll(selector)).filter((element) => {
        if (this.getElementRole(element) !== role) {
          return false;
        }

        return this.getPrimaryLabel(this.summarizeElement(element)) === name;
      });
    }

    findTagTextMatches(root, tag, textValue) {
      return Array.from(root.querySelectorAll(tag)).filter((element) => {
        return this.getPrimaryLabel(this.summarizeElement(element)) === textValue;
      });
    }

    getRoleQuerySelector(role) {
      switch (role) {
        case 'button':
          return 'button, input[type="button"], input[type="submit"], input[type="reset"], summary, [role="button"]';
        case 'checkbox':
          return 'input[type="checkbox"], [role="checkbox"]';
        case 'combobox':
          return 'select, [role="combobox"]';
        case 'link':
          return 'a[href], [role="link"]';
        case 'option':
          return 'option, [role="option"]';
        case 'radio':
          return 'input[type="radio"], [role="radio"]';
        case 'searchbox':
          return 'input[type="search"], [role="searchbox"]';
        case 'slider':
          return 'input[type="range"], [role="slider"]';
        case 'textbox':
          return 'textarea, input:not([type]), input[type="email"], input[type="number"], input[type="password"], input[type="search"], input[type="tel"], input[type="text"], input[type="url"], [role="textbox"]';
        default:
          return `[role="${this.escapeAttributeValue(role)}"]`;
      }
    }

    scoreLocatorCandidate(candidate, matchCount) {
      let score = candidate.priority || 0;

      if (matchCount === 1) {
        score += 120;
      } else {
        score += Math.max(0, 32 - matchCount * 4);
      }

      if (candidate.kind === 'role-name') {
        score += 8;
      }

      if (candidate.kind === 'css' && candidate.selector.includes(':nth-of-type(')) {
        score -= 12;
      }

      if (candidate.kind === 'css' && candidate.selector.includes(' > ')) {
        score -= 4;
      }

      if (candidate.kind === 'css' && candidate.selector.includes(' ')) {
        score -= 3;
      }

      score -= Math.floor(candidate.text.length / 28);
      return score;
    }

    formatLocatorCandidate(candidate) {
      const suffix = candidate.matchCount === 1 ? 'unique' : `${candidate.matchCount} matches`;
      return `${candidate.text} (${suffix})`;
    }

    getPrimaryLabel(summary) {
      return this.firstNonEmpty(summary.ariaLabel, summary.text, summary.placeholder, summary.title, summary.name);
    }

    firstNonEmpty(...values) {
      for (const value of values) {
        const normalized = this.normalizeWhitespace(value);
        if (normalized) {
          return normalized;
        }
      }

      return '';
    }

    describeContext(contextElement, contextSummary) {
      const kind = contextSummary.role || contextSummary.tag;
      const label = this.firstNonEmpty(
        contextSummary.ariaLabel,
        this.findContextHeading(contextElement),
        contextSummary.title,
        contextSummary.id
      );

      if (label) {
        return `${kind} "${this.clipText(label, 80)}"`;
      }

      return kind;
    }

    findContextHeading(contextElement) {
      const heading = contextElement.querySelector('h1, h2, h3, h4, h5, h6, [role="heading"], legend');
      if (!heading) {
        return '';
      }

      return this.normalizeWhitespace(heading.innerText || heading.textContent || '');
    }

    clipText(value, maxLength) {
      const normalized = this.normalizeWhitespace(value);
      if (normalized.length <= maxLength) {
        return normalized;
      }

      return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}\u2026`;
    }

    buildWarnings(element) {
      const warnings = [];
      if (element.tagName.toLowerCase() === 'iframe') {
        warnings.push(
          'The selected element is an iframe element. To capture inside-frame UI, click inside the frame while Frame of Reference is active there.'
        );
      }

      const rootNode = element.getRootNode();
      if (rootNode instanceof ShadowRoot) {
        warnings.push('The selected element is inside a shadow root.');
      }

      if (window.top !== window) {
        warnings.push('This capture was made inside an iframe.');
      }

      return warnings;
    }

    buildContextSelectorOptions(element) {
      const selectors = [];
      let current = element;
      for (let depth = 0; current && depth < 3; depth += 1) {
        const summary = this.summarizeElement(current);
        const variants = this.buildSelectorVariants(current, summary, {
          allowNthOfType: false,
          classLimit: 1
        });

        for (const variant of variants.slice(0, 2)) {
          if (!selectors.includes(variant.selector)) {
            selectors.push(variant.selector);
          }
        }

        current = current.parentElement;
      }

      return selectors;
    }

    buildHierarchySelectorVariants(element) {
      const chain = [];
      let current = element;
      for (let depth = 0; current && depth < 4; depth += 1) {
        const summary = this.summarizeElement(current);
        chain.push({
          element: current,
          summary,
          variants: this.buildSelectorVariants(current, summary, {
            allowNthOfType: depth === 0,
            classLimit: depth === 0 ? 2 : 1
          })
        });

        if (depth > 0 && this.hasStrongSelectorAnchor(summary)) {
          break;
        }

        current = current.parentElement;
      }

      if (chain.length === 0) {
        return [];
      }

      const selectors = [];
      const seen = new Set();
      const addSelector = (selector, priority) => {
        if (!selector || seen.has(selector)) {
          return;
        }

        seen.add(selector);
        selectors.push({ selector, priority });
      };

      const leafVariants = chain[0].variants.slice(0, 4);
      for (const variant of leafVariants) {
        addSelector(variant.selector, variant.priority);
      }

      for (let depth = 1; depth < chain.length; depth += 1) {
        const ancestorVariants = chain[depth].variants.slice(0, 2);
        for (const ancestorVariant of ancestorVariants) {
          for (const leafVariant of leafVariants.slice(0, 3)) {
            addSelector(
              `${ancestorVariant.selector} > ${leafVariant.selector}`,
              ancestorVariant.priority + leafVariant.priority - depth * 6
            );

            addSelector(
              `${ancestorVariant.selector} ${leafVariant.selector}`,
              ancestorVariant.priority + leafVariant.priority - depth * 10
            );

            const exactPath = [ancestorVariant.selector];
            for (let middle = depth - 1; middle >= 1; middle -= 1) {
              const middleTag = chain[middle].summary.tag;
              if (middleTag === 'div' || middleTag === 'span') {
                continue;
              }
              exactPath.push(middleTag);
            }
            exactPath.push(leafVariant.selector);

            if (exactPath.length > 2) {
              addSelector(exactPath.join(' > '), ancestorVariant.priority + leafVariant.priority - depth * 5);
            }
          }
        }
      }

      return selectors;
    }

    hasStrongSelectorAnchor(summary) {
      return Boolean(summary.id || summary.dataTestId || summary.name || summary.ariaLabel || summary.title);
    }

    buildSelectorVariants(
      element,
      summary = this.summarizeElement(element),
      { allowNthOfType = true, classLimit = 2 } = {}
    ) {
      const tag = summary.tag;
      const variants = [];
      const seen = new Set();

      // Generate attribute-based selectors using the unified method.
      this._buildAttributeBasedSelectors(element, summary, LOCATOR_SCORE_TABLE, {
        seen,
        list: variants,
        allowSiblingNth: true,
        classLimit,
        allowNthOfType
      });

      const usefulClasses = this.getUsefulClasses(element, classLimit);
      if (usefulClasses.length > 0) {
        this._addUniqueSelector(
          seen,
          variants,
          `${tag}.${CSS.escape(usefulClasses[0])}`,
          SELECTOR_SCORING.LOCATOR_SINGLE_CLASS_SCORE,
          element,
          true
        );
      }

      if (usefulClasses.length > 1) {
        this._addUniqueSelector(
          seen,
          variants,
          `${tag}${usefulClasses
            .slice(0, 2)
            .map((item) => `.${CSS.escape(item)}`)
            .join('')}`,
          SELECTOR_SCORING.LOCATOR_MULTI_CLASS_SCORE,
          element,
          true
        );
      }

      if (allowNthOfType) {
        this._addUniqueSelector(seen, variants, `${tag}:nth-of-type(${this.getNthOfType(element)})`, 8, element, false);
      }

      return variants;
    }

    makeSiblingSpecificSelector(element, selector) {
      if (!selector || selector.includes(':nth-of-type(')) {
        return '';
      }

      const parent = element.parentElement;
      if (!parent) {
        return '';
      }

      try {
        if (parent.querySelectorAll(`:scope > ${selector}`).length <= 1) {
          return '';
        }
      } catch (_error) {
        return '';
      }

      return `${selector}:nth-of-type(${this.getNthOfType(element)})`;
    }

    getUsefulClasses(element, limit) {
      const scored = [];
      for (const item of element.classList) {
        const score = this.scoreClassToken(item);
        if (score > 0) {
          scored.push({ item, score });
        }
      }
      scored.sort((left, right) => right.score - left.score || left.item.length - right.item.length);
      const result = [];
      for (let i = 0; i < scored.length && i < limit; i += 1) {
        result.push(scored[i].item);
      }
      return result;
    }

    scoreClassToken(token) {
      if (!token) {
        return -1;
      }

      if (token.includes('&') || token.includes(':')) {
        return -5;
      }

      if (token.includes('[') && !token.startsWith('rounded-[')) {
        return -4;
      }

      let score = 0;

      if (STRONG_CONTAINER_CLASS_RE.test(token)) {
        score += 7;
      }

      if (VISUAL_CONTAINER_CLASS_RE.test(token)) {
        score += 5;
      }

      if (LOW_SIGNAL_CLASS_RE.test(token)) {
        score -= 4;
      }

      if (LEADING_DIGIT_RE.test(token)) {
        score -= 2;
      }

      if (token.length > 40) {
        score -= 2;
      }

      return score;
    }

    getNthOfType(element) {
      let index = 1;
      let sibling = element;

      while (sibling.previousElementSibling) {
        sibling = sibling.previousElementSibling;
        if (sibling.tagName === element.tagName) {
          index += 1;
        }
      }

      return index;
    }

    normalizeWhitespace(value) {
      return String(value || '')
        .replace(/\s+/g, ' ')
        .trim();
    }

    escapeAttributeValue(value) {
      return String(value)
        .replace(/\\/g, '\\\\')
        .replace(/\0/g, '\\0')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\f/g, '\\f')
        .replace(/\]/g, '\\]')
        .replace(/"/g, '\\"');
    }

    // --- Screenshot Capture ---

    // Maximum element area (as fraction of viewport) for screenshot capture.
    // Elements larger than 50% of the viewport are skipped since they provide
    // limited visual value at high memory cost.
    static SCREENSHOT_MAX_VIEWPORT_FRACTION = 0.5;

    // Captures a cropped screenshot of the target element's bounding rect.
    // The entire flow is in-memory: captureVisibleTab returns a data URL string,
    // which is loaded into an Image, cropped on an off-screen Canvas, and exported
    // as a PNG Blob. No files touch the disk at any point.
    async captureElementScreenshot(target) {
      try {
        const rect = target.getBoundingClientRect();
        if (!rect || rect.width <= 0 || rect.height <= 0) {
          return null;
        }

        // Skip screenshots inside iframes — getBoundingClientRect returns coords
        // relative to the iframe viewport, but captureVisibleTab captures the entire
        // tab. The crop would be offset by the iframe's position in the parent document.
        if (window.top !== window) {
          return null;
        }

        // Skip very large elements that would produce oversized screenshots.
        const viewportArea = window.innerWidth * window.innerHeight;
        const elementArea = rect.width * rect.height;
        if (elementArea > viewportArea * FrameOfReferencePicker.SCREENSHOT_MAX_VIEWPORT_FRACTION) {
          return null;
        }

        // Hide the overlay so it doesn't appear in the screenshot. The
        // try/finally ensures the overlay is always restored, regardless of
        // whether the rAF, sendMessage, or cropScreenshot steps throw or reject.
        let response;
        try {
          if (this.overlayRoot) {
            this.overlayRoot.style.display = 'none';
          }

          // Wait one frame for the paint to flush before capturing.
          await new Promise((resolve) => requestAnimationFrame(resolve));

          response = await new Promise((resolve) => {
            try {
              chrome.runtime.sendMessage({ type: 'frameofreference:capture' }, (resp) => {
                void chrome.runtime.lastError;
                resolve(resp);
              });
            } catch (_error) {
              resolve(null);
            }
          });
        } finally {
          if (this.overlayRoot) {
            this.overlayRoot.style.display = 'block';
          }
        }

        if (!response || !response.ok || !response.dataUrl) {
          return null;
        }

        return await this.cropScreenshot(response.dataUrl, rect);
      } catch (error) {
        console.debug('Frame of Reference: screenshot capture failed', error);
        return null;
      }
    }

    // Crops a full-tab screenshot (data URL) to the target element's bounding rect,
    // accounting for devicePixelRatio. Returns a PNG Blob or null.
    async cropScreenshot(dataUrl, rect) {
      const dpr = window.devicePixelRatio || 1;
      const cropX = Math.round(rect.left * dpr);
      const cropY = Math.round(rect.top * dpr);
      const cropW = Math.round(rect.width * dpr);
      const cropH = Math.round(rect.height * dpr);

      if (cropW <= 0 || cropH <= 0) {
        return null;
      }

      // Load the data URL into an Image element (in-memory, no DOM insertion).
      const img = await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = reject;
        image.src = dataUrl;
      });

      // Clamp crop region to image bounds — the element may be partially
      // off-screen, making the computed rect extend beyond the captured area.
      const clampedX = Math.max(0, Math.min(cropX, img.naturalWidth));
      const clampedY = Math.max(0, Math.min(cropY, img.naturalHeight));
      const clampedW = Math.min(cropW, img.naturalWidth - clampedX);
      const clampedH = Math.min(cropH, img.naturalHeight - clampedY);

      if (clampedW <= 0 || clampedH <= 0) {
        return null;
      }

      // Create an off-screen canvas and draw the cropped region.
      const canvas = document.createElement('canvas');
      canvas.width = clampedW;
      canvas.height = clampedH;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        return null;
      }

      ctx.drawImage(img, clampedX, clampedY, clampedW, clampedH, 0, 0, clampedW, clampedH);

      // Export the canvas as a PNG Blob.
      return new Promise((resolve) => {
        canvas.toBlob((blob) => resolve(blob || null), 'image/png');
      });
    }

    // Writes both text and an image to the clipboard in a single ClipboardItem.
    // Returns true on success. Falls back gracefully — the caller should use
    // copyText() if this returns false.
    async copyTextAndImage(text, imageBlob) {
      if (!navigator.clipboard || typeof navigator.clipboard.write !== 'function') {
        return false;
      }

      try {
        const textBlob = new Blob([text], { type: 'text/plain' });
        const item = new ClipboardItem({
          'text/plain': textBlob,
          'image/png': imageBlob
        });
        await navigator.clipboard.write([item]);
        return true;
      } catch (error) {
        console.debug('Frame of Reference: dual clipboard write failed', error);
        return false;
      }
    }

    // --- Clipboard ---

    async copyText(text) {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        try {
          await navigator.clipboard.writeText(text);
          return true;
        } catch (_error) {
          // Fall through.
        }
      }

      return this.copyTextFallback(text);
    }

    // Fallback clipboard method using the deprecated document.execCommand('copy').
    // Retained for restrictive iframe contexts where the Clipboard API is blocked
    // by permissions policy. The primary path uses navigator.clipboard.writeText;
    // this is defense-in-depth only.
    copyTextFallback(text) {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', 'readonly');
      textarea.setAttribute('aria-hidden', 'true');
      textarea.setAttribute('tabindex', '-1');
      textarea.style.position = 'fixed';
      textarea.style.top = '-9999px';
      textarea.style.left = '-9999px';
      textarea.style.opacity = '0';
      textarea.style.pointerEvents = 'none';

      (document.body || document.documentElement).appendChild(textarea);
      textarea.focus();
      textarea.select();

      try {
        return document.execCommand('copy');
      } finally {
        textarea.remove();
      }
    }

    // --- Communication ---

    notifyState(active) {
      this.sendRuntimeMessage({
        type: 'frameofreference:state',
        active
      });
    }

    notifyResult(kind) {
      this.sendRuntimeMessage({
        type: 'frameofreference:result',
        kind
      });
    }

    sendRuntimeMessage(message) {
      try {
        chrome.runtime.sendMessage(message);
      } catch (error) {
        // Expected when the extension context is invalidated (e.g., after update
        // or disable). Log unexpected errors at debug level for diagnostics —
        // console.debug is hidden by default in Chrome's console.
        if (typeof error?.message === 'string' && !error.message.includes('Extension context invalidated')) {
          console.debug('Frame of Reference: sendRuntimeMessage failed', error);
        }
      }
    }
  }

  globalThis.__FRAMEOFREFERENCE_PICKER__ = new FrameOfReferencePicker();
})();
