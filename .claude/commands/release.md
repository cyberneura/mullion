---
name: release
description: "マイナーバージョンを上げてリリースし、Homebrew cask まで更新する"
allowed-tools: Bash(git:*), Bash(gh:*), Bash(pnpm:*), Bash(shasum:*), Bash(node:*), Bash(curl:*)
---

# Task

Mullion をリリースする。バージョンの bump から Homebrew cask の更新までを通しで行う。

引数 (`$ARGUMENTS`) に `patch` / `minor` / `major` が指定されていればそれを使い、
**指定が無ければ `minor`** を使う。以下 `<BUMP>` はその値、`<VERSION>` は bump 後の
バージョン (例 `0.2.0`) を指す。

背景は `CLAUDE.md` の「Releasing」節に書いてある。リリース機構そのものを直す時は
先にそれを読むこと。

---

## Step 1: 前提の確認

```shell
git branch --show-current   # main であること
git status --porcelain      # 空であること
git fetch origin +main:refs/remotes/origin/main
git rev-parse HEAD origin/main   # 一致すること
gh auth status
```

どれかが満たされていなければ、**何もせずユーザーに報告して止まる**。
`scripts/release.sh` も同じ検査をするが、ここで先に落としておくほうが状況を説明しやすい。

続けてローカルでゲートを通す (workflow でも走るが、CI を待たずに落とせる):

```shell
pnpm check && pnpm test
```

---

## Step 2: bump してビルドを起動する

```shell
pnpm release <BUMP>
```

これ 1 コマンドで、version の採番 → `chore: release v<VERSION>` の commit → main への
push → `release.yml` の dispatch → 完了まで watch、までが行われる。自分で
`npm version` や `git tag` を打たないこと。タグは workflow が公開直前に打つ。

**実行時間は署名と公証で 15〜30 分かかる**。Bash ツールの上限 (10 分) を超えるので、
`run_in_background: true` で投げ、完了通知を待つ。途中経過を見たい時は:

```shell
gh run list --workflow=release.yml --limit 3
```

失敗した時は、`scripts/release.sh` が「bump commit は main に載ったまま」の状態を
出力に書いている。そのメッセージをそのままユーザーに伝え、勝手に main を書き戻したり
タグや draft release を消したりしないこと (次に何を消すかはユーザーの判断)。

成功すると `https://github.com/cyberneura/mullion/releases/tag/v<VERSION>` が出る。

---

## Step 3: リリースを検証する

公開されたことと、アセットが 1 つだけ載っていることを確認する:

```shell
gh release view "v<VERSION>" --json isDraft,tagName,assets,url
```

`isDraft` が `false`、アセットが `mullion-<VERSION>-universal.dmg` 1 件であること。
draft のまま残っていれば publish job が落ちている。その場合は Step 4 に進まず報告する。

---

## Step 4: Homebrew cask を更新する

cask は別リポジトリ (`cyberneura/homebrew-tap`, ローカルは
`~/workspace/homebrew-tap`) にあり、`version` と `sha256` は手書き。忘れても何も
失敗せず `brew install --cask` が古い版を配り続けるだけなので、必ずここまでやる。

sha256 は **公開されたアセットを実際に落として計算する** (workflow の run summary にも
出るが、利用者が受け取るファイルそのものから取るほうが確実):

```shell
gh release download "v<VERSION>" --repo cyberneura/mullion \
  --pattern "mullion-<VERSION>-universal.dmg" --dir "$TMPDIR/mullion-release" --clobber
shasum -a 256 "$TMPDIR/mullion-release/mullion-<VERSION>-universal.dmg"
```

`~/workspace/homebrew-tap` で main を最新にしてから、`Casks/mullion.rb` の
`version` と `sha256` の 2 行**だけ**を書き換える (`url` は `version` を埋め込んでいる
ので触らない。ファイル名の形が変わっていたら `build.artifactName` が変わったという
ことなので、書き換えずにユーザーに報告する)。

```shell
git -C ~/workspace/homebrew-tap fetch origin && git -C ~/workspace/homebrew-tap pull --ff-only
```

書き換えたら差分が 2 行であることを確認し、直接 main にコミットして push する
(PR は不要):

```shell
git -C ~/workspace/homebrew-tap diff
git -C ~/workspace/homebrew-tap commit -am "Update mullion cask to v<VERSION>"
git -C ~/workspace/homebrew-tap push origin main
```

---

## Step 5: 報告

ユーザーに以下を伝える:

- 公開した version と Release の URL
- dmg の sha256
- cask を更新した commit

インストールの確認まで頼まれた場合のみ、以下を案内する (勝手に実行しない。既に
入っている版が置き換わるため):

```shell
brew update && brew upgrade --cask mullion
```
