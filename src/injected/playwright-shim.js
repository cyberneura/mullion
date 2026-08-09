// Playwright-compatible surface for `--playwright` / `--playwright-file` code.
//
// This file is not loaded as a module. Its text is spliced into the top of an
// async IIFE that is evaluated inside the page (see scripts.js), so everything
// here must be a declaration that is legal inside an async function body.
//
// Real Playwright drives a browser from the outside over CDP. We are already
// *inside* the page, so the calls are re-implemented against the DOM. That
// covers the scripted-interaction subset people actually paste in (goto, click,
// fill, waitForSelector, locators, evaluate) and deliberately fails loudly on
// the parts that cannot be honoured from in-page, rather than pretending.

const __mullionDefaultTimeout = 30000;

const __mullionSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const __mullionUnsupported = (name) => {
  throw new Error(
    `page.${name}() is not available: Mullion runs Playwright-compatible code inside the page, ` +
      'so it cannot drive the browser process itself.'
  );
};

// Polls `probe` until it returns a truthy value. Playwright's auto-waiting is
// the single most relied-on behaviour of the API, so every selector-taking
// method goes through here instead of assuming the node is already there.
const __mullionWaitFor = async (probe, { timeout = __mullionDefaultTimeout, description }) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() >= deadline) {
      throw new Error(`Timeout ${timeout}ms exceeded while waiting for ${description}`);
    }
    await __mullionSleep(50);
  }
};

const __mullionIsVisible = (element) => {
  if (!element || !element.isConnected) return false;
  if (element.hidden) return false;
  const rects = element.getClientRects();
  if (rects.length === 0) return false;
  const style = window.getComputedStyle(element);
  return style.visibility !== 'hidden' && style.display !== 'none';
};

const __mullionQuery = (selector, index = 0) => {
  const matches = document.querySelectorAll(selector);
  return matches[index] || null;
};

const __mullionResolve = (selector, options = {}) => {
  const index = options.index || 0;
  const state = options.state || 'visible';
  return __mullionWaitFor(
    () => {
      const element = __mullionQuery(selector, index);
      if (state === 'attached') return element;
      if (state === 'detached') return element ? null : true;
      if (state === 'hidden') return element && !__mullionIsVisible(element) ? element : null;
      return element && __mullionIsVisible(element) ? element : null;
    },
    { timeout: options.timeout, description: `selector "${selector}" (${state})` }
  );
};

// Native .click() on the element rather than a synthetic MouseEvent: it is the
// only way to get default behaviour (following links, submitting forms).
const __mullionClick = (element) => {
  element.scrollIntoView({ block: 'center', inline: 'center' });
  element.focus({ preventScroll: true });
  element.click();
};

// Frameworks listen for `input` (React) or `change` (plain forms), so both are
// dispatched. The native value setter is used because React overrides the
// element's own `value` property and would otherwise swallow the assignment.
const __mullionSetValue = (element, value) => {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  const descriptor = Object.getOwnPropertyDescriptor(prototype.prototype, 'value');
  element.focus({ preventScroll: true });
  if (descriptor && descriptor.set) {
    descriptor.set.call(element, value);
  } else {
    element.value = value;
  }
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
};

const __mullionKeyEvent = (element, type, key) => {
  const target = element || document.activeElement || document.body;
  target.dispatchEvent(
    new KeyboardEvent(type, { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, bubbles: true, cancelable: true })
  );
};

const __mullionHandle = (element) => ({
  element,
  click: async () => __mullionClick(element),
  fill: async (value) => __mullionSetValue(element, value),
  textContent: async () => element.textContent,
  innerText: async () => element.innerText,
  innerHTML: async () => element.innerHTML,
  getAttribute: async (name) => element.getAttribute(name),
  isVisible: async () => __mullionIsVisible(element),
  isChecked: async () => Boolean(element.checked),
  hover: async () => element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })),
  focus: async () => element.focus(),
  press: async (key) => {
    __mullionKeyEvent(element, 'keydown', key);
    __mullionKeyEvent(element, 'keyup', key);
  },
  evaluate: async (fn, arg) => fn(element, arg)
});

const __mullionLocator = (selector, index = 0) => ({
  selector,
  first: () => __mullionLocator(selector, 0),
  last: () => __mullionLocator(selector, Math.max(document.querySelectorAll(selector).length - 1, 0)),
  nth: (n) => __mullionLocator(selector, n),
  count: async () => document.querySelectorAll(selector).length,
  all: async () => Array.from(document.querySelectorAll(selector)).map((_, i) => __mullionLocator(selector, i)),
  elementHandle: async (options) => __mullionHandle(await __mullionResolve(selector, { ...options, index })),
  waitFor: async (options) => {
    await __mullionResolve(selector, { ...options, index });
  },
  click: async (options) => __mullionClick(await __mullionResolve(selector, { ...options, index })),
  fill: async (value, options) => __mullionSetValue(await __mullionResolve(selector, { ...options, index }), value),
  type: async (text, options) => {
    const element = await __mullionResolve(selector, { ...options, index });
    for (const character of String(text)) {
      __mullionSetValue(element, element.value + character);
      if (options && options.delay) await __mullionSleep(options.delay);
    }
  },
  press: async (key, options) => {
    const element = await __mullionResolve(selector, { ...options, index });
    __mullionKeyEvent(element, 'keydown', key);
    __mullionKeyEvent(element, 'keyup', key);
  },
  hover: async (options) => {
    const element = await __mullionResolve(selector, { ...options, index });
    element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  },
  check: async (options) => {
    const element = await __mullionResolve(selector, { ...options, index });
    if (!element.checked) __mullionClick(element);
  },
  uncheck: async (options) => {
    const element = await __mullionResolve(selector, { ...options, index });
    if (element.checked) __mullionClick(element);
  },
  selectOption: async (value, options) => {
    const element = await __mullionResolve(selector, { ...options, index });
    element.value = typeof value === 'object' && value !== null ? value.value : value;
    element.dispatchEvent(new Event('change', { bubbles: true }));
  },
  textContent: async (options) => (await __mullionResolve(selector, { ...options, index, state: 'attached' })).textContent,
  innerText: async (options) => (await __mullionResolve(selector, { ...options, index })).innerText,
  getAttribute: async (name, options) =>
    (await __mullionResolve(selector, { ...options, index, state: 'attached' })).getAttribute(name),
  inputValue: async (options) => (await __mullionResolve(selector, { ...options, index })).value,
  isVisible: async () => __mullionIsVisible(__mullionQuery(selector, index)),
  isChecked: async () => Boolean((__mullionQuery(selector, index) || {}).checked),
  scrollIntoViewIfNeeded: async (options) => {
    const element = await __mullionResolve(selector, { ...options, index });
    element.scrollIntoView({ block: 'center' });
  }
});

const page = {
  // A same-document navigation would abandon this script mid-run, so goto() is
  // deliberately terminal: the caller gets no promise resolution afterwards.
  goto: async (url) => {
    window.location.href = url;
    await __mullionSleep(__mullionDefaultTimeout);
  },
  url: () => window.location.href,
  title: async () => document.title,
  content: async () => document.documentElement.outerHTML,
  waitForTimeout: (ms) => __mullionSleep(ms),
  waitForSelector: async (selector, options) => __mullionHandle(await __mullionResolve(selector, options)),
  waitForFunction: async (fn, arg, options) =>
    __mullionWaitFor(() => fn(arg), { timeout: options && options.timeout, description: 'function to return true' }),
  waitForLoadState: async () => {
    if (document.readyState === 'complete') return;
    await new Promise((resolve) => window.addEventListener('load', resolve, { once: true }));
  },
  locator: (selector) => __mullionLocator(selector),
  getByTestId: (id) => __mullionLocator(`[data-testid="${id}"]`),
  $: async (selector) => {
    const element = __mullionQuery(selector);
    return element ? __mullionHandle(element) : null;
  },
  $$: async (selector) => Array.from(document.querySelectorAll(selector)).map(__mullionHandle),
  $eval: async (selector, fn, arg) => fn(await __mullionResolve(selector, { state: 'attached' }), arg),
  $$eval: async (selector, fn, arg) => fn(Array.from(document.querySelectorAll(selector)), arg),
  evaluate: async (fn, arg) => (typeof fn === 'function' ? fn(arg) : eval(fn)),
  evaluateHandle: async (fn, arg) => (typeof fn === 'function' ? fn(arg) : eval(fn)),
  click: async (selector, options) => __mullionClick(await __mullionResolve(selector, options)),
  dblclick: async (selector, options) => {
    const element = await __mullionResolve(selector, options);
    __mullionClick(element);
    element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  },
  fill: async (selector, value, options) => __mullionSetValue(await __mullionResolve(selector, options), value),
  type: async (selector, text, options) => __mullionLocator(selector).type(text, options),
  press: async (selector, key, options) => __mullionLocator(selector).press(key, options),
  hover: async (selector, options) => __mullionLocator(selector).hover(options),
  check: async (selector, options) => __mullionLocator(selector).check(options),
  uncheck: async (selector, options) => __mullionLocator(selector).uncheck(options),
  selectOption: async (selector, value, options) => __mullionLocator(selector).selectOption(value, options),
  textContent: async (selector, options) => __mullionLocator(selector).textContent(options),
  innerText: async (selector, options) => __mullionLocator(selector).innerText(options),
  inputValue: async (selector, options) => __mullionLocator(selector).inputValue(options),
  getAttribute: async (selector, name, options) => __mullionLocator(selector).getAttribute(name, options),
  isVisible: async (selector) => __mullionIsVisible(__mullionQuery(selector)),
  isChecked: async (selector) => Boolean((__mullionQuery(selector) || {}).checked),
  focus: async (selector, options) => (await __mullionResolve(selector, options)).focus(),
  reload: async () => window.location.reload(),
  goBack: async () => window.history.back(),
  goForward: async () => window.history.forward(),
  setDefaultTimeout: () => {},
  setViewportSize: () => __mullionUnsupported('setViewportSize'),
  screenshot: () => __mullionUnsupported('screenshot'),
  pdf: () => __mullionUnsupported('pdf'),
  close: async () => {},
  keyboard: {
    press: async (key) => {
      __mullionKeyEvent(null, 'keydown', key);
      __mullionKeyEvent(null, 'keyup', key);
    },
    down: async (key) => __mullionKeyEvent(null, 'keydown', key),
    up: async (key) => __mullionKeyEvent(null, 'keyup', key),
    type: async (text, options) => {
      const element = document.activeElement;
      for (const character of String(text)) {
        if (element && 'value' in element) __mullionSetValue(element, element.value + character);
        __mullionKeyEvent(element, 'keydown', character);
        __mullionKeyEvent(element, 'keyup', character);
        if (options && options.delay) await __mullionSleep(options.delay);
      }
    },
    insertText: async (text) => {
      const element = document.activeElement;
      if (element && 'value' in element) __mullionSetValue(element, element.value + text);
    }
  },
  mouse: {
    move: async (x, y) => document.elementFromPoint(x, y)?.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y })),
    click: async (x, y) => {
      const element = document.elementFromPoint(x, y);
      if (element) __mullionClick(element);
    },
    down: async () => {},
    up: async () => {},
    wheel: async (deltaX, deltaY) => window.scrollBy(deltaX, deltaY)
  }
};

// Playwright scripts are usually wrapped in a runner. These stubs let the two
// common copy-paste shapes -- a `test(...)` block and a codegen `chromium.launch()`
// script -- run unchanged against the page we already have open.
const context = {
  newPage: async () => page,
  pages: () => [page],
  close: async () => {},
  setDefaultTimeout: () => {},
  addCookies: async () => {},
  clearCookies: async () => {}
};

const browser = {
  newContext: async () => context,
  newPage: async () => page,
  contexts: () => [context],
  close: async () => {}
};

const chromium = { launch: async () => browser, connect: async () => browser, launchPersistentContext: async () => context };
const firefox = chromium;
const webkit = chromium;
const devices = {};

// Assertions run for their side effect of throwing; the failure surfaces in the
// script error reported back to the main process.
const expect = (actual) => {
  const check = (condition, message) => {
    if (!condition) throw new Error(`Assertion failed: ${message}`);
  };
  const api = {
    toBe: (expected) => check(actual === expected, `expected ${String(expected)}, got ${String(actual)}`),
    toEqual: (expected) => check(JSON.stringify(actual) === JSON.stringify(expected), 'values are not equal'),
    toBeTruthy: () => check(Boolean(actual), 'value is not truthy'),
    toBeFalsy: () => check(!actual, 'value is not falsy'),
    toContain: (expected) => check(String(actual).includes(expected), `"${String(actual)}" does not contain "${expected}"`),
    toBeVisible: async () => check(await actual.isVisible(), 'element is not visible'),
    toHaveText: async (expected) => check((await actual.textContent()) === expected, 'text does not match'),
    toHaveCount: async (expected) => check((await actual.count()) === expected, 'count does not match')
  };
  api.not = {
    toBe: (expected) => check(actual !== expected, `expected not ${String(expected)}`),
    toBeVisible: async () => check(!(await actual.isVisible()), 'element is visible'),
    toBeTruthy: () => check(!actual, 'value is truthy')
  };
  return api;
};

// `test()` runs the body immediately -- there is no suite to schedule it into.
const test = async (name, fn) => (typeof name === 'function' ? name({ page, context, browser }) : fn({ page, context, browser }));
test.describe = async (name, fn) => (typeof name === 'function' ? name() : fn());
test.beforeEach = async (fn) => fn({ page, context, browser });
test.afterEach = async (fn) => fn({ page, context, browser });
test.skip = async () => {};

const __mullionModules = {
  playwright: { chromium, firefox, webkit, devices, expect },
  'playwright-core': { chromium, firefox, webkit, devices, expect },
  '@playwright/test': { test, expect, chromium, firefox, webkit, devices }
};

const require = (name) => {
  const module = __mullionModules[name];
  if (!module) throw new Error(`Cannot require("${name}") inside Mullion: only Playwright modules are shimmed.`);
  return module;
};
