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

const __ostinatoDefaultTimeout = 30000;

const __ostinatoSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const __ostinatoUnsupported = (name) => {
  throw new Error(
    `page.${name}() is not available: Ostinato runs Playwright-compatible code inside the page, ` +
      'so it cannot drive the browser process itself.'
  );
};

// Polls `probe` until it returns a truthy value. Playwright's auto-waiting is
// the single most relied-on behaviour of the API, so every selector-taking
// method goes through here instead of assuming the node is already there.
const __ostinatoWaitFor = async (probe, { timeout = __ostinatoDefaultTimeout, description }) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() >= deadline) {
      throw new Error(`Timeout ${timeout}ms exceeded while waiting for ${description}`);
    }
    await __ostinatoSleep(50);
  }
};

const __ostinatoIsVisible = (element) => {
  if (!element || !element.isConnected) return false;
  if (element.hidden) return false;
  const rects = element.getClientRects();
  if (rects.length === 0) return false;
  const style = window.getComputedStyle(element);
  return style.visibility !== 'hidden' && style.display !== 'none';
};

const __ostinatoQuery = (selector, index = 0) => {
  const matches = document.querySelectorAll(selector);
  return matches[index] || null;
};

const __ostinatoResolve = (selector, options = {}) => {
  const index = options.index || 0;
  const state = options.state || 'visible';
  return __ostinatoWaitFor(
    () => {
      const element = __ostinatoQuery(selector, index);
      if (state === 'attached') return element;
      if (state === 'detached') return element ? null : true;
      if (state === 'hidden') return element && !__ostinatoIsVisible(element) ? element : null;
      return element && __ostinatoIsVisible(element) ? element : null;
    },
    { timeout: options.timeout, description: `selector "${selector}" (${state})` }
  );
};

// Native .click() on the element rather than a synthetic MouseEvent: it is the
// only way to get default behaviour (following links, submitting forms).
const __ostinatoClick = (element) => {
  element.scrollIntoView({ block: 'center', inline: 'center' });
  element.focus({ preventScroll: true });
  element.click();
};

// Frameworks listen for `input` (React) or `change` (plain forms), so both are
// dispatched. The native value setter is used because React overrides the
// element's own `value` property and would otherwise swallow the assignment.
const __ostinatoSetValue = (element, value) => {
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

const __ostinatoKeyEvent = (element, type, key) => {
  const target = element || document.activeElement || document.body;
  target.dispatchEvent(
    new KeyboardEvent(type, { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, bubbles: true, cancelable: true })
  );
};

const __ostinatoHandle = (element) => ({
  element,
  click: async () => __ostinatoClick(element),
  fill: async (value) => __ostinatoSetValue(element, value),
  textContent: async () => element.textContent,
  innerText: async () => element.innerText,
  innerHTML: async () => element.innerHTML,
  getAttribute: async (name) => element.getAttribute(name),
  isVisible: async () => __ostinatoIsVisible(element),
  isChecked: async () => Boolean(element.checked),
  hover: async () => element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })),
  focus: async () => element.focus(),
  press: async (key) => {
    __ostinatoKeyEvent(element, 'keydown', key);
    __ostinatoKeyEvent(element, 'keyup', key);
  },
  evaluate: async (fn, arg) => fn(element, arg)
});

const __ostinatoLocator = (selector, index = 0) => ({
  selector,
  first: () => __ostinatoLocator(selector, 0),
  last: () => __ostinatoLocator(selector, Math.max(document.querySelectorAll(selector).length - 1, 0)),
  nth: (n) => __ostinatoLocator(selector, n),
  count: async () => document.querySelectorAll(selector).length,
  all: async () => Array.from(document.querySelectorAll(selector)).map((_, i) => __ostinatoLocator(selector, i)),
  elementHandle: async (options) => __ostinatoHandle(await __ostinatoResolve(selector, { ...options, index })),
  waitFor: async (options) => {
    await __ostinatoResolve(selector, { ...options, index });
  },
  click: async (options) => __ostinatoClick(await __ostinatoResolve(selector, { ...options, index })),
  fill: async (value, options) => __ostinatoSetValue(await __ostinatoResolve(selector, { ...options, index }), value),
  type: async (text, options) => {
    const element = await __ostinatoResolve(selector, { ...options, index });
    for (const character of String(text)) {
      __ostinatoSetValue(element, element.value + character);
      if (options && options.delay) await __ostinatoSleep(options.delay);
    }
  },
  press: async (key, options) => {
    const element = await __ostinatoResolve(selector, { ...options, index });
    __ostinatoKeyEvent(element, 'keydown', key);
    __ostinatoKeyEvent(element, 'keyup', key);
  },
  hover: async (options) => {
    const element = await __ostinatoResolve(selector, { ...options, index });
    element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  },
  check: async (options) => {
    const element = await __ostinatoResolve(selector, { ...options, index });
    if (!element.checked) __ostinatoClick(element);
  },
  uncheck: async (options) => {
    const element = await __ostinatoResolve(selector, { ...options, index });
    if (element.checked) __ostinatoClick(element);
  },
  selectOption: async (value, options) => {
    const element = await __ostinatoResolve(selector, { ...options, index });
    element.value = typeof value === 'object' && value !== null ? value.value : value;
    element.dispatchEvent(new Event('change', { bubbles: true }));
  },
  textContent: async (options) => (await __ostinatoResolve(selector, { ...options, index, state: 'attached' })).textContent,
  innerText: async (options) => (await __ostinatoResolve(selector, { ...options, index })).innerText,
  getAttribute: async (name, options) =>
    (await __ostinatoResolve(selector, { ...options, index, state: 'attached' })).getAttribute(name),
  inputValue: async (options) => (await __ostinatoResolve(selector, { ...options, index })).value,
  isVisible: async () => __ostinatoIsVisible(__ostinatoQuery(selector, index)),
  isChecked: async () => Boolean((__ostinatoQuery(selector, index) || {}).checked),
  scrollIntoViewIfNeeded: async (options) => {
    const element = await __ostinatoResolve(selector, { ...options, index });
    element.scrollIntoView({ block: 'center' });
  }
});

const page = {
  // A same-document navigation would abandon this script mid-run, so goto() is
  // deliberately terminal: the caller gets no promise resolution afterwards.
  goto: async (url) => {
    window.location.href = url;
    await __ostinatoSleep(__ostinatoDefaultTimeout);
  },
  url: () => window.location.href,
  title: async () => document.title,
  content: async () => document.documentElement.outerHTML,
  waitForTimeout: (ms) => __ostinatoSleep(ms),
  waitForSelector: async (selector, options) => __ostinatoHandle(await __ostinatoResolve(selector, options)),
  waitForFunction: async (fn, arg, options) =>
    __ostinatoWaitFor(() => fn(arg), { timeout: options && options.timeout, description: 'function to return true' }),
  waitForLoadState: async () => {
    if (document.readyState === 'complete') return;
    await new Promise((resolve) => window.addEventListener('load', resolve, { once: true }));
  },
  locator: (selector) => __ostinatoLocator(selector),
  getByTestId: (id) => __ostinatoLocator(`[data-testid="${id}"]`),
  $: async (selector) => {
    const element = __ostinatoQuery(selector);
    return element ? __ostinatoHandle(element) : null;
  },
  $$: async (selector) => Array.from(document.querySelectorAll(selector)).map(__ostinatoHandle),
  $eval: async (selector, fn, arg) => fn(await __ostinatoResolve(selector, { state: 'attached' }), arg),
  $$eval: async (selector, fn, arg) => fn(Array.from(document.querySelectorAll(selector)), arg),
  evaluate: async (fn, arg) => (typeof fn === 'function' ? fn(arg) : eval(fn)),
  evaluateHandle: async (fn, arg) => (typeof fn === 'function' ? fn(arg) : eval(fn)),
  click: async (selector, options) => __ostinatoClick(await __ostinatoResolve(selector, options)),
  dblclick: async (selector, options) => {
    const element = await __ostinatoResolve(selector, options);
    __ostinatoClick(element);
    element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  },
  fill: async (selector, value, options) => __ostinatoSetValue(await __ostinatoResolve(selector, options), value),
  type: async (selector, text, options) => __ostinatoLocator(selector).type(text, options),
  press: async (selector, key, options) => __ostinatoLocator(selector).press(key, options),
  hover: async (selector, options) => __ostinatoLocator(selector).hover(options),
  check: async (selector, options) => __ostinatoLocator(selector).check(options),
  uncheck: async (selector, options) => __ostinatoLocator(selector).uncheck(options),
  selectOption: async (selector, value, options) => __ostinatoLocator(selector).selectOption(value, options),
  textContent: async (selector, options) => __ostinatoLocator(selector).textContent(options),
  innerText: async (selector, options) => __ostinatoLocator(selector).innerText(options),
  inputValue: async (selector, options) => __ostinatoLocator(selector).inputValue(options),
  getAttribute: async (selector, name, options) => __ostinatoLocator(selector).getAttribute(name, options),
  isVisible: async (selector) => __ostinatoIsVisible(__ostinatoQuery(selector)),
  isChecked: async (selector) => Boolean((__ostinatoQuery(selector) || {}).checked),
  focus: async (selector, options) => (await __ostinatoResolve(selector, options)).focus(),
  reload: async () => window.location.reload(),
  goBack: async () => window.history.back(),
  goForward: async () => window.history.forward(),
  setDefaultTimeout: () => {},
  setViewportSize: () => __ostinatoUnsupported('setViewportSize'),
  screenshot: () => __ostinatoUnsupported('screenshot'),
  pdf: () => __ostinatoUnsupported('pdf'),
  close: async () => {},
  keyboard: {
    press: async (key) => {
      __ostinatoKeyEvent(null, 'keydown', key);
      __ostinatoKeyEvent(null, 'keyup', key);
    },
    down: async (key) => __ostinatoKeyEvent(null, 'keydown', key),
    up: async (key) => __ostinatoKeyEvent(null, 'keyup', key),
    type: async (text, options) => {
      const element = document.activeElement;
      for (const character of String(text)) {
        if (element && 'value' in element) __ostinatoSetValue(element, element.value + character);
        __ostinatoKeyEvent(element, 'keydown', character);
        __ostinatoKeyEvent(element, 'keyup', character);
        if (options && options.delay) await __ostinatoSleep(options.delay);
      }
    },
    insertText: async (text) => {
      const element = document.activeElement;
      if (element && 'value' in element) __ostinatoSetValue(element, element.value + text);
    }
  },
  mouse: {
    move: async (x, y) => document.elementFromPoint(x, y)?.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y })),
    click: async (x, y) => {
      const element = document.elementFromPoint(x, y);
      if (element) __ostinatoClick(element);
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

const __ostinatoModules = {
  playwright: { chromium, firefox, webkit, devices, expect },
  'playwright-core': { chromium, firefox, webkit, devices, expect },
  '@playwright/test': { test, expect, chromium, firefox, webkit, devices }
};

const require = (name) => {
  const module = __ostinatoModules[name];
  if (!module) throw new Error(`Cannot require("${name}") inside Ostinato: only Playwright modules are shimmed.`);
  return module;
};
