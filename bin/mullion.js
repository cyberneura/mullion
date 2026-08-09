#!/usr/bin/env node
'use strict';

// Launcher for a `pnpm link --global` install. Electron itself is the real
// entry point; this only finds the binary and hands the arguments over.
//
// stdio is inherited so `cat page.html | mullion -` works and so the app's
// console output lands in the terminal the user launched it from.

const { spawn } = require('node:child_process');
const path = require('node:path');

let electron;
try {
  electron = require('electron');
} catch {
  console.error('mullion: electron is not installed. Run `pnpm install` in the mullion checkout.');
  process.exit(1);
}

const child = spawn(electron, [path.join(__dirname, '..'), ...process.argv.slice(2)], { stdio: 'inherit' });

child.on('close', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code === null ? 1 : code);
});
