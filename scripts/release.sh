#!/usr/bin/env bash
# GitHub Actions の Release ワークフローを起動し、完了まで watch する。
# `pnpm release [patch|minor|major]` から呼ばれる (省略時は patch)。
#
# 処理の流れ:
#   1. 作業ツリーがクリーン かつ HEAD == origin/main であることを検証
#   2. package.json の version を bump 種別に応じて採番
#   3. version を書き換えて commit & push
#   4. workflow をトリガーして watch
#
# version を毎回インクリメントするのは、公開済みの tag に対して再実行すると
# Release の作成でぶつかるため。採番を自動化することで「bump し忘れて落ちる」
# 事故を構造的に無くす。
#
# gh CLI (認証済み) が必要。
set -euo pipefail

cd "$(dirname "$0")/.."

BUMP="${1:-patch}"
case "${BUMP}" in
  patch | minor | major) ;;
  *)
    echo "Usage: pnpm release [patch|minor|major]  (default: patch)" >&2
    exit 1
    ;;
esac

# gh の存在と認証を、何かを書き換える前に確認する。push した後で gh が使えないと、
# bump コミットだけが main に載って workflow が起動されず、次回実行が別 version を
# 採番してしまう (公開されない version が main に取り残される)。
if ! command -v gh >/dev/null 2>&1; then
  echo "Error: gh CLI not found. Install it and run 'gh auth login'." >&2
  exit 1
fi
if ! gh auth status >/dev/null 2>&1; then
  echo "Error: gh is not authenticated. Run 'gh auth login'." >&2
  exit 1
fi

# 採番は main のクリーンな状態からのみ行う。ローカルの未コミット変更が紛れ込んだり、
# origin/main とズレたままビルドするのを防ぐ (ビルドは origin/main の内容で走るため)。
if [ "$(git branch --show-current)" != "main" ]; then
  echo "Error: not on the 'main' branch. Switch to main first." >&2
  exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "Error: working tree is not clean. Commit or stash your changes first." >&2
  exit 1
fi
# refspec を明示して origin/main を確実に更新する。先頭の + は clone 既定の refspec と
# 同じ強制更新で、force push 後も fetch 自体は成功させ、ズレは下の HEAD 比較で検出する。
git fetch origin +main:refs/remotes/origin/main
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  echo "Error: local HEAD does not match origin/main. Push (or pull) first." >&2
  exit 1
fi

# 現行 version を読み、bump 種別に応じて次の version を計算する。厳密な X.Y.Z
# だけを受け付ける ("1.2" や "1.2.3.4" を弾くため正規表現で全体を検証する)。
CURRENT=$(node -p "require('./package.json').version")
VERSION=$(node -e '
  const cur = process.argv[1];
  const bump = process.argv[2];
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(cur)) {
    console.error("Error: current version is not X.Y.Z: " + cur);
    process.exit(1);
  }
  const [maj, min, pat] = cur.split(".").map(Number);
  const next = bump === "major" ? [maj + 1, 0, 0]
    : bump === "minor" ? [maj, min + 1, 0]
    : [maj, min, pat + 1];
  process.stdout.write(next.join("."));
' "${CURRENT}" "${BUMP}")

# 公開済みの version をもう一度採番しても、workflow 側の存在チェックで落ちるだけで
# bump コミットは main に残る。ここで先に気づけるようにしておく。
#
# 「無い」と言い切れるのは 404 のときだけ。gh の非ゼロ終了をまとめて「無い」と
# 読むと、認証切れや rate limit のときに素通りして push まで進んでしまう。
if RELEASE_LOOKUP=$(gh api "repos/{owner}/{repo}/releases/tags/v${VERSION}" 2>&1); then
  echo "Error: release v${VERSION} already exists. Someone released out of band." >&2
  echo "  Bump package.json past it and commit before running this again." >&2
  exit 1
elif ! printf '%s' "${RELEASE_LOOKUP}" | grep -q "HTTP 404"; then
  echo "Error: could not check whether v${VERSION} exists:" >&2
  echo "  ${RELEASE_LOOKUP}" >&2
  exit 1
fi

# タグ単体が残っている場合も、ここで止める。workflow 側にも同じ確認があるが、
# あちらが弾くのは push の後なので、main に公開されない version の bump だけが
# 取り残される — この preflight が防ぐつもりでいる状態そのものになる。
if TAG_LOOKUP=$(gh api "repos/{owner}/{repo}/git/ref/tags/v${VERSION}" 2>&1); then
  echo "Error: tag v${VERSION} already exists without a release." >&2
  echo "  Delete it (git push origin :refs/tags/v${VERSION}) or bump past it." >&2
  exit 1
elif ! printf '%s' "${TAG_LOOKUP}" | grep -q "HTTP 404"; then
  echo "Error: could not check whether tag v${VERSION} exists:" >&2
  echo "  ${TAG_LOOKUP}" >&2
  exit 1
fi

# draft はタグを持たないので上のどちらにも掛からない。workflow 側の preflight と
# 同じ理由でここでも見る (失敗した run の中途半端なアセットを再利用しない)。
if DRAFT_LOOKUP=$(gh release view "v${VERSION}" --json isDraft 2>&1); then
  echo "Error: a draft release v${VERSION} is left over." >&2
  echo "  Delete it (gh release delete v${VERSION}) or bump past it." >&2
  exit 1
elif ! printf '%s' "${DRAFT_LOOKUP}" | grep -q "release not found"; then
  echo "Error: could not check whether a draft v${VERSION} exists:" >&2
  echo "  ${DRAFT_LOOKUP}" >&2
  exit 1
fi

echo "Bumping version: ${CURRENT} -> ${VERSION} (${BUMP})"

# package.json のトップレベル version だけを置換する (ファイル全体を再整形しない
# ので diff が 1 行に収まる)。version は先頭付近にあるので誤爆しないが、将来同じ値の
# nested な version キーがそれより前に来ると当たる。
node -e '
  const fs = require("fs");
  const version = process.argv[1];
  const file = "package.json";
  const text = fs.readFileSync(file, "utf8");
  const old = JSON.parse(text).version;
  if (typeof old !== "string") throw new Error("no top-level string version in " + file);
  const esc = old.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const needle = new RegExp("(\"version\"\\s*:\\s*\")" + esc + "(\")");
  const out = text.replace(needle, "$1" + version + "$2");
  if (out === text) throw new Error("version not replaced in " + file);
  fs.writeFileSync(file, out);
' "${VERSION}"

git add package.json
git commit -m "chore: release v${VERSION}"
if ! git push origin HEAD:main; then
  echo "Error: push failed. The local release commit remains." >&2
  echo "  Undo it:  git reset --hard origin/main" >&2
  echo "  Or retry: git push origin HEAD:main" >&2
  exit 1
fi

echo "Triggering release build for v${VERSION} ..."

# workflow_dispatch は run ID を返さないため、起動後にポーリングして拾う。
# 探すのは「今 push した bump コミットを head に持ち、**dispatch より後に作られた**
# run」。SHA だけで絞ると、同じ commit に対する手動 dispatch や再実行が既にあった
# 場合に古い run を拾ってしまい、そちらの成功を見て "Done" と表示しながら本命の run が
# 落ちる、ということが起きる。
RELEASE_SHA=$(git rev-parse HEAD)

# dispatch 直前に、この SHA で既に存在する run の ID を控えておく。
# ここは失敗を握り潰さない。取れなかったのを「1件も無い」と読むと、後のポーリングが
# 古い run を今回のものと取り違え、そちらの成功を見て "Done" と表示しながら本命の run が
# 落ちる、という一番たちの悪い外し方をする。
if ! KNOWN_RUNS=$(gh run list --workflow=release.yml --branch main --limit 50 \
  --json databaseId,headSha \
  --jq "[.[] | select(.headSha == \"${RELEASE_SHA}\") | .databaseId] | join(\" \")" 2>&1); then
  echo "Error: could not list existing workflow runs:" >&2
  echo "  ${KNOWN_RUNS}" >&2
  echo "  v${VERSION} is already pushed to main. Trigger and watch it by hand:" >&2
  echo "    gh workflow run release.yml --ref main" >&2
  exit 1
fi

# `workflow_dispatch` はブランチ名しか受け取らない (SHA を渡す口が無い) ので、dispatch は
# 「その瞬間の main の先端」に対して起きる。ここまでの間に誰かが main を進めていれば、
# 走るのは別の commit で、下のポーリングはそれを今回の run と認めない。
# 完全には閉じられない窓なので、直前にもう一度だけ確かめて短くする。
git fetch origin +main:refs/remotes/origin/main --quiet
if [ "$(git rev-parse origin/main)" != "${RELEASE_SHA}" ]; then
  echo "Error: origin/main moved to $(git rev-parse --short origin/main) after the bump was pushed." >&2
  echo "  The dispatch would build that commit instead of v${VERSION}." >&2
  echo "  Sort out main, then trigger and watch it by hand:" >&2
  echo "    gh workflow run release.yml --ref main" >&2
  exit 1
fi

if ! gh workflow run release.yml --ref main; then
  echo "Error: failed to trigger the workflow. v${VERSION} is already pushed to main." >&2
  echo "  Retry with: gh workflow run release.yml --ref main" >&2
  exit 1
fi

# ここは「まだ run が出てこない」状態を待つループなので、失敗は空文字として扱う。
RUN_ID=""
for _ in $(seq 1 60); do
  sleep 2
  CANDIDATES=$(gh run list --workflow=release.yml --branch main --limit 50 \
    --json databaseId,headSha \
    --jq "[.[] | select(.headSha == \"${RELEASE_SHA}\") | .databaseId] | join(\" \")" \
    2>/dev/null || true)
  for id in ${CANDIDATES}; do
    case " ${KNOWN_RUNS} " in
      *" ${id} "*) ;;            # dispatch 前からあった run は無視する
      *) RUN_ID="${id}"; break ;;
    esac
  done
  if [ -n "${RUN_ID}" ]; then
    break
  fi
done
if [ -z "${RUN_ID}" ]; then
  # 見つからないだけで、run 自体は動いている可能性が高い (watch できないだけ)。
  echo "Error: could not find the triggered workflow run within 2 minutes." >&2
  echo "  The build may still be running. Check it with:" >&2
  echo "    gh run list --workflow=release.yml" >&2
  exit 1
fi
echo "Watching run ${RUN_ID} ..."
gh run watch "${RUN_ID}" --exit-status

echo "Done: https://github.com/cyberneura/mullion/releases/tag/v${VERSION}"
echo
echo "Next: update Casks/mullion.rb in cyberneura/homebrew-tap with the new version"
echo "and sha256. The workflow prints both in its run summary."
