#!/usr/bin/env bash
# version を上げて main に push し、その push で始まった Release ワークフローを
# 完了まで watch する。`pnpm release [patch|minor|major]` から呼ばれる (省略時は patch)。
#
# 処理の流れ:
#   1. 作業ツリーがクリーン かつ HEAD == origin/main であることを検証
#   2. package.json の version を bump 種別に応じて採番
#   3. version を書き換えて commit & push
#   4. push で始まった run を探して watch し、Release が公開されたことを確かめる
#
# リリースを始めるのは push (release.yml の on: push) であって、このスクリプトではない。
# push の後でこのスクリプトが落ちてもビルドは走るし、同じ version をもう一度 push しても
# workflow は公開済みと判断して何もしない。
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

# gh の存在と認証を、何かを書き換える前に確認する。リリース自体は push で始まるので
# gh が無くてもビルドは止まらないが、下の preflight も watch もできなくなる。
# push してから気づくより、その前に言う。
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

# 公開済みの version をもう一度採番しても、workflow は plan で何もせずに終わるだけで
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

echo "Waiting for the release build of v${VERSION} ..."

# push で始まった run は API に出てくるまで少し遅れるので、ポーリングして拾う。
# 「最新の run」ではなく「今 push した bump コミットを head に持つ push の run」を探す:
# 待っている間に別の push や dispatch が挟まっても、他の run を watch してしまわない。
RELEASE_SHA=$(git rev-parse HEAD)

# ここは「まだ run が出てこない」状態を待つループなので、失敗は空文字として扱う
# (`|| true` が無いと、API の一時エラーで set -e がループごと殺す)。
# 60 回 x 2 秒 = 最大 2 分。run 一覧 API は反映が遅れることがあり、短いと誤判定する。
RUN_ID=""
for _ in $(seq 1 60); do
  sleep 2
  RUN_ID=$(gh run list --workflow=release.yml --branch main --event push --limit 20 \
    --json databaseId,headSha \
    --jq "[.[] | select(.headSha == \"${RELEASE_SHA}\")] | .[0].databaseId // \"\"" \
    2>/dev/null || true)
  if [ -n "${RUN_ID}" ]; then
    break
  fi
done
if [ -z "${RUN_ID}" ]; then
  # 見つからないだけで、run 自体は動いている可能性が高い (watch できないだけ)。
  echo "Error: could not find the workflow run within 2 minutes." >&2
  echo "  The build may still be running. Check it with:" >&2
  echo "    gh run list --workflow=release.yml" >&2
  exit 1
fi
echo "Watching run ${RUN_ID} ..."
gh run watch "${RUN_ID}" --exit-status

# run の成功は「公開された」を意味しない。plan が release=false を返した run
# (後から push された新しい version に先に公開された等) も、build 以降が skip されて
# 成功で終わる。公開済み (draft ではない) Release があることを確かめてから Done と言う。
if [ "$(gh release view "v${VERSION}" --json isDraft --jq '.isDraft' 2>/dev/null || true)" != "false" ]; then
  echo "Error: the run succeeded but v${VERSION} is not published. See why in the plan job:" >&2
  echo "  gh run view ${RUN_ID} --log" >&2
  exit 1
fi

echo "Done: https://github.com/cyberneura/mullion/releases/tag/v${VERSION}"
echo
echo "The Homebrew cask in cyberneura/homebrew-tap follows the latest release on its own"
echo "(the tap checks every hour)."
