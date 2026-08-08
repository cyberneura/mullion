# Ostinato — notes for agents

Electron app. Read `README.md` first for what the thing does.

## Ground rules

- CommonJS, no build step. There is no bundler and no TypeScript; keep it that way.
- The renderer pages (`navigation.*`, `handle.*`) run **sandboxed** with
  `contextIsolation: true`. Everything they can do goes through the named
  commands in `src/navigation-preload.js`. Do not add a generic
  "send any channel" bridge.
- Never build renderer HTML with `innerHTML`. Page titles and URLs are
  attacker-controlled; `textContent` + `createElement` only.
- Remote pages live in their own session partition (`persist:ostinato-content`)
  so nothing they store reaches the UI views.

## Testing

`src/cli.js`, `src/targets.js`, and `src/scripts.js` have no Electron imports so
they can run under `node --test`. Keep new pure logic in those files rather than
in `main.js`, and add cases to `test/`.

```shell
pnpm test     # node --test
pnpm check    # node --check on every source file
```

There is no CI. `pnpm test` and `pnpm check` are the gate.

The app itself cannot be launched headlessly in the agent environment, and
macOS packaging cannot be verified on Linux — say so instead of claiming a
run happened.

## Things that are easy to get wrong

- **Script injection scope.** `--js` / `--playwright` run for the command line
  targets and on Restart, not on every navigation. Widening that silently would
  leak the user's automation onto every site they browse to.
- **`buildInjection` needs the newline before `})()`** or a script ending in a
  `//` comment loses its terminator. There is a test for it.
- **The Playwright shim is spliced into an async function body**, not required
  as a module. Only declarations are legal at its top level.
- **Layout is owned by the main process.** `relayout()` sizes every view; the
  renderer only hides the rows it was told to hide.
