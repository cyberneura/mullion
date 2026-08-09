'use strict';

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

// Decides what a command line target means (URL / local file / stdin) and, for
// files, which viewer should handle it. Pure apart from the injected `exists`
// probe, so `node --test` can cover the ambiguous cases without touching disk.

const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i;

// Schemes we hand to the WebContentsView as-is. Anything else with a scheme
// (mailto:, slack:, ...) belongs to the OS, not to us.
const WEB_SCHEMES = new Set(['http:', 'https:', 'file:', 'about:', 'data:', 'chrome:', 'devtools:']);

const FILE_KINDS = {
  '.pdf': 'pdf',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.webp': 'image',
  '.avif': 'image',
  '.bmp': 'image',
  '.svg': 'image',
  '.mp4': 'video',
  '.webm': 'video',
  '.mov': 'video',
  '.m4v': 'video',
  '.mp3': 'audio',
  '.m4a': 'audio',
  '.wav': 'audio',
  '.ogg': 'audio',
  '.flac': 'audio',
  '.html': 'html',
  '.htm': 'html',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.csv': 'csv',
  '.tsv': 'csv',
  '.txt': 'text',
  '.md': 'text',
  '.log': 'text'
};

// Hostname-ish first segment: `example.com`, `localhost:3000`, `192.168.0.1`.
// Requires a dot or an explicit port so a bare word stays a file name.
const HOSTLIKE_PATTERN = /^(localhost|[a-z0-9-]+(\.[a-z0-9-]+)+)(:\d+)?(\/|\?|#|$)/i;

// The same shape but with the port mandatory. `localhost:3000` and
// `example.com:8080` both satisfy the generic scheme pattern below (`.` and `-`
// are legal scheme characters), so they have to be recognised as hosts first or
// they would be handed to the OS as a `localhost:` / `example.com:` scheme.
const HOSTLIKE_WITH_PORT_PATTERN = /^(localhost|[a-z0-9-]+(\.[a-z0-9-]+)+):\d+(\/|\?|#|$)/i;

function expandHome(target) {
  if (target === '~') return os.homedir();
  if (target.startsWith('~/')) return path.join(os.homedir(), target.slice(2));
  return target;
}

function fileKindFor(filePath) {
  return FILE_KINDS[path.extname(filePath).toLowerCase()] || 'other';
}

// `exists` is injectable purely for tests; production always probes the disk.
function classifyTarget(raw, { cwd = process.cwd(), exists = fs.existsSync } = {}) {
  const target = String(raw);

  if (target === '-') {
    return { kind: 'stdin' };
  }

  if (HOSTLIKE_WITH_PORT_PATTERN.test(target)) {
    return { kind: 'url', url: new URL(`https://${target}`).href };
  }

  if (SCHEME_PATTERN.test(target)) {
    let parsed;
    try {
      parsed = new URL(target);
    } catch {
      return { kind: 'invalid', reason: `not a valid URL: ${target}` };
    }
    if (WEB_SCHEMES.has(parsed.protocol)) {
      return { kind: 'url', url: parsed.href };
    }
    // Windows drive letters (`C:\...`) parse as a URL with protocol `c:`.
    if (/^[a-z]:[\\/]/i.test(target)) {
      return asFile(target, cwd);
    }
    return { kind: 'external', url: parsed.href };
  }

  const expanded = expandHome(target);

  // An explicit path prefix is never a host name, so skip the disk probe.
  if (expanded.startsWith('/') || expanded.startsWith('./') || expanded.startsWith('../')) {
    return asFile(expanded, cwd);
  }

  // Ambiguous bare word: `report.json` could be a file or a domain. A file that
  // is actually there wins; otherwise fall back to the host-shaped guess so
  // `mullion example.com` works without a scheme.
  const absolute = path.resolve(cwd, expanded);
  if (exists(absolute)) {
    return asFile(expanded, cwd);
  }
  if (HOSTLIKE_PATTERN.test(expanded)) {
    return { kind: 'url', url: new URL(`https://${expanded}`).href };
  }
  return asFile(expanded, cwd);
}

function asFile(target, cwd) {
  const filePath = path.resolve(cwd, expandHome(target));
  return {
    kind: 'file',
    filePath,
    fileKind: fileKindFor(filePath),
    url: pathToFileURL(filePath).href
  };
}

// Human-readable label for a target, used for the window/tab title before the
// page reports one of its own.
function labelFor(target) {
  if (!target) return 'Mullion';
  if (target.kind === 'file') return path.basename(target.filePath);
  if (target.kind === 'stdin') return 'stdin';
  if (target.kind === 'url' || target.kind === 'external') {
    try {
      return new URL(target.url).host || target.url;
    } catch {
      return target.url;
    }
  }
  return 'Mullion';
}

module.exports = { classifyTarget, labelFor, fileKindFor, FILE_KINDS, HOSTLIKE_PATTERN, SCHEME_PATTERN };
