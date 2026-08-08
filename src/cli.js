'use strict';

// Pure argument parser for the `ostinato` command. Kept free of Electron imports
// so it can be unit tested with `node --test` without launching a browser.

const DEFAULTS = {
  width: 1280,
  height: 720,
  zoom: 1
};

// Options that take a value. The map records how the raw string is converted;
// an entry returning `undefined` means "invalid value" and produces an error.
const VALUE_OPTIONS = {
  '--width': { key: 'width', parse: positiveInt },
  '--height': { key: 'height', parse: positiveInt },
  '--x': { key: 'x', parse: integer },
  '--y': { key: 'y', parse: integer },
  '--html': { key: 'html', parse: identity },
  '--html-file': { key: 'htmlFile', parse: identity },
  '--title': { key: 'title', parse: identity },
  '--zoom': { key: 'zoom', parse: positiveFloat },
  '--js': { key: null, parse: identity },
  '--js-file': { key: null, parse: identity },
  '--playwright': { key: null, parse: identity },
  '--playwright-file': { key: null, parse: identity }
};

// Scripts are collected into a single ordered list rather than one bucket per
// option, so `--js a.js --playwright b.js --js c.js` runs in the written order.
const SCRIPT_OPTIONS = {
  '--js': { kind: 'js', inline: true },
  '--js-file': { kind: 'js', inline: false },
  '--playwright': { kind: 'playwright', inline: true },
  '--playwright-file': { kind: 'playwright', inline: false }
};

const BOOLEAN_OPTIONS = {
  '--always-on-top': 'alwaysOnTop',
  '--navigation': 'navigation',
  '--new-window': 'newWindow',
  '--menubar': 'menubar',
  '--frame': 'frame',
  '--restore': 'restore',
  '--js-every-load': 'jsEveryLoad',
  '--open-devtools': 'openDevtools',
  '--help': 'help',
  '--version': 'version'
};

const SHORT_OPTIONS = {
  '-h': '--help',
  '-v': '--version'
};

function identity(value) {
  return value;
}

function integer(value) {
  return /^-?\d+$/.test(value) ? Number(value) : undefined;
}

function positiveInt(value) {
  const parsed = integer(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

function positiveFloat(value) {
  if (!/^\d+(\.\d+)?$/.test(value)) return undefined;
  const parsed = Number(value);
  return parsed > 0 ? parsed : undefined;
}

// Parses argv (already stripped of the executable/script entries).
// Never throws: unrecognised input is reported through `errors` so the caller
// can print help and exit with a message instead of a stack trace.
function parseCli(argv) {
  const result = {
    ...DEFAULTS,
    x: undefined,
    y: undefined,
    html: undefined,
    htmlFile: undefined,
    title: undefined,
    alwaysOnTop: false,
    navigation: false,
    newWindow: false,
    menubar: false,
    frame: false,
    restore: false,
    jsEveryLoad: false,
    openDevtools: false,
    help: false,
    version: false,
    scripts: [],
    targets: [],
    // Which value options were actually written on the command line. Defaults
    // are indistinguishable from an explicit `--width 1280` otherwise, and the
    // window has to know whether to prefer the remembered size.
    provided: {},
    errors: []
  };

  let onlyTargetsFromHere = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (onlyTargetsFromHere) {
      result.targets.push(arg);
      continue;
    }

    // `--` ends option parsing so a file literally named `--menubar` can be opened.
    if (arg === '--') {
      onlyTargetsFromHere = true;
      continue;
    }

    // A bare `-` is the stdin target, not an option.
    if (arg !== '-' && arg.startsWith('-')) {
      const equalsAt = arg.indexOf('=');
      const rawName = equalsAt === -1 ? arg : arg.slice(0, equalsAt);
      const name = SHORT_OPTIONS[rawName] || rawName;
      const inlineValue = equalsAt === -1 ? undefined : arg.slice(equalsAt + 1);

      if (BOOLEAN_OPTIONS[name]) {
        if (inlineValue !== undefined) {
          result.errors.push(`${name} does not take a value`);
          continue;
        }
        result[BOOLEAN_OPTIONS[name]] = true;
        continue;
      }

      const option = VALUE_OPTIONS[name];
      if (!option) {
        result.errors.push(`unknown option: ${rawName}`);
        continue;
      }

      let raw = inlineValue;
      if (raw === undefined) {
        index += 1;
        raw = argv[index];
      }
      if (raw === undefined) {
        result.errors.push(`${name} requires a value`);
        continue;
      }

      const parsed = option.parse(raw);
      if (parsed === undefined) {
        result.errors.push(`invalid value for ${name}: ${raw}`);
        continue;
      }

      const script = SCRIPT_OPTIONS[name];
      if (script) {
        result.scripts.push(
          script.inline ? { kind: script.kind, source: parsed } : { kind: script.kind, file: parsed }
        );
        continue;
      }

      result[option.key] = parsed;
      result.provided[option.key] = true;
      continue;
    }

    result.targets.push(arg);
  }

  // `--html` / `--html-file` are alternative ways of naming the page to show, so
  // treat them as mutually exclusive with each other but let a positional target
  // win nothing silently -- an explicit combination is almost certainly a mistake.
  if (result.html !== undefined && result.htmlFile !== undefined) {
    result.errors.push('--html and --html-file cannot be combined');
  }
  if ((result.html !== undefined || result.htmlFile !== undefined) && result.targets.length > 0) {
    result.errors.push('--html / --html-file cannot be combined with a positional target');
  }
  if (result.targets.filter((target) => target === '-').length > 1) {
    result.errors.push('stdin (-) can only be given once');
  }

  return result;
}

function helpText(version) {
  return `ostinato ${version}

A frameless browser window for leaving a page playing.

Usage:
  ostinato [options] [target ...]

Targets:
  https://example.com     open as a URL
  ./slides.pdf            open a local file
  -                       read HTML from standard input

Options:
  --width <px>            window width (default ${DEFAULTS.width})
  --height <px>           window height (default ${DEFAULTS.height})
  --x <px> --y <px>       window position (default: centred)
  --html <string>         show an HTML string
  --html-file <path>      show an HTML file
  --title <string>        pin the window title
  --always-on-top         keep the window above others
  --zoom <factor>         zoom factor (default ${DEFAULTS.zoom})
  --navigation            start with the navigation bar shown
  --frame                 keep the normal OS window frame
  --new-window            open a new window even if one is already running
  --menubar               run as a menu bar / tray application
  --restore               reopen the pages from the previous session
  --js <code>             run JavaScript after the page loads
  --js-file <path>        run JavaScript from a file after the page loads
  --playwright <code>     run Playwright-compatible code after the page loads
  --playwright-file <path>  run Playwright-compatible code from a file
  --js-every-load         re-run the scripts after every navigation
  --open-devtools         open developer tools on start
  -h, --help              show this help
  -v, --version           show the version

Scripts run in the order they appear on the command line. Without
--js-every-load they run once for the pages named on the command line and
again on "Restart", but not for pages reached by following links.
`;
}

module.exports = { parseCli, helpText, DEFAULTS };
