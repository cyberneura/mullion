---
name: release
description: "Bump the minor version, release, and update the Homebrew cask"
allowed-tools: Bash(git:*), Bash(gh:*), Bash(pnpm:*), Bash(shasum:*), Bash(node:*), Bash(curl:*)
---

# Task

Release Mullion. Do everything end to end, from the version bump to updating the Homebrew cask.

If the argument (`$ARGUMENTS`) specifies `patch` / `minor` / `major`, use it;
**if nothing is specified, use `minor`**. Below, `<BUMP>` refers to that value, and `<VERSION>` to the
version after the bump (e.g. `0.2.0`).

The background is in the "Releasing" section of `CLAUDE.md`. Read it first if you are
changing the release mechanism itself.

---

## Step 1: Check the preconditions

```shell
git branch --show-current   # must be main
git status --porcelain      # must be empty
git fetch origin +main:refs/remotes/origin/main
git rev-parse HEAD origin/main   # must match
gh auth status
```

If any of these is not satisfied, **do nothing, report to the user, and stop**.
`scripts/release.sh` runs the same checks, but failing here first makes it easier to explain the situation.

Then run the gates locally (they also run in the workflow, but this fails fast without waiting for CI):

```shell
pnpm check && pnpm test
```

---

## Step 2: Bump and start the build

```shell
pnpm release <BUMP>
```

This single command does everything: assigns the version → commits `chore: release v<VERSION>` → pushes
to main → dispatches `release.yml` → watches it until completion. Do not run
`npm version` or `git tag` yourself. The workflow creates the tag right before publishing.

**It takes 15–30 minutes because of signing and notarization**. That exceeds the Bash tool's limit (10 minutes), so
launch it with `run_in_background: true` and wait for the completion notification. To check progress along the way:

```shell
gh run list --workflow=release.yml --limit 3
```

If it fails, `scripts/release.sh` writes in its output that "the bump commit is still on main".
Pass that message on to the user as-is, and do not revert main on your own or
delete tags or draft releases (what to delete next is the user's decision).

On success it prints `https://github.com/cyberneura/mullion/releases/tag/v<VERSION>`.

---

## Step 3: Verify the release

Confirm that it was published and that exactly one asset is attached:

```shell
gh release view "v<VERSION>" --json isDraft,tagName,assets,url
```

`isDraft` must be `false`, and the assets must be exactly one `mullion-<VERSION>-universal.dmg`.
If it is still a draft, the publish job failed. In that case, do not proceed to Step 4; report instead.

---

## Step 4: Update the Homebrew cask

The cask lives in a separate repository (`cyberneura/homebrew-tap`, locally
`~/workspace/homebrew-tap`), and `version` and `sha256` are written by hand. If you forget, nothing
fails; `brew install --cask` just keeps serving the old version, so always do this step.

Compute the sha256 by **actually downloading the published asset** (it also appears in the workflow
run summary, but taking it from the exact file users receive is more reliable):

```shell
gh release download "v<VERSION>" --repo cyberneura/mullion \
  --pattern "mullion-<VERSION>-universal.dmg" --dir "$TMPDIR/mullion-release" --clobber
shasum -a 256 "$TMPDIR/mullion-release/mullion-<VERSION>-universal.dmg"
```

After bringing main up to date in `~/workspace/homebrew-tap`, rewrite **only** the 2 lines
`version` and `sha256` in `Casks/mullion.rb` (do not touch `url`, since it embeds `version`.
If the file name pattern has changed, that means `build.artifactName` changed;
do not rewrite anything and report to the user).

```shell
git -C ~/workspace/homebrew-tap fetch origin && git -C ~/workspace/homebrew-tap pull --ff-only
```

After rewriting, confirm the diff is 2 lines, then commit directly to main and push
(no PR needed):

```shell
git -C ~/workspace/homebrew-tap diff
git -C ~/workspace/homebrew-tap commit -am "Update mullion cask to v<VERSION>"
git -C ~/workspace/homebrew-tap push origin main
```

---

## Step 5: Report

Tell the user:

- The published version and the Release URL
- The sha256 of the dmg
- The commit that updated the cask

Only if asked to confirm the installation too, suggest the following (do not run it on your own, since
it replaces the version already installed):

```shell
brew update && brew upgrade --cask mullion
```
