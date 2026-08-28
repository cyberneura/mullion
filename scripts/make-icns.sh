#!/usr/bin/env bash
# resources/icon.png から resources/icon.icns を作る (macOS 専用)。
#
# なぜ要るのか: electron-builder は icns が無ければ icon.png から自前で生成するが、
# その生成物は小さい表現 (16pt / 32pt) が壊れる。Finder のリスト表示や「情報を見る」の
# 小アイコンが、アイコンではなく色のノイズになる (CYBERNEURA-DEV-601)。
# 大きい表現は PNG のまま埋め込まれるので、Dock やアイコン表示では気付けない。
#
# icns の古い型のうち is32 / il32 は RGB を PackBits 系の RLE で持つ
# (s8mk は 8bit のマスクで RLE ではない)。ここでは Apple の iconutil に作らせて、
# その符号化を自前で持たないようにする。
# 生成物は package.json の build.mac.icon が名指しで参照する。
set -euo pipefail

cd "$(dirname "$0")/.."

if [ "$(uname -s)" != "Darwin" ]; then
  echo "make-icns.sh は macOS でしか動かない (sips / iconutil が要る)" >&2
  exit 1
fi

SRC=resources/icon.png
OUT=resources/icon.icns
WORK=$(mktemp -d)
# 途中で失敗しても一時ディレクトリを残さない
trap 'rm -rf "$WORK"' EXIT
SET="$WORK/icon.iconset"
mkdir -p "$SET"

# iconutil が要求するファイル名は固定。1x と 2x の両方を入れないと、
# その寸法の表現が欠けて macOS が別のサイズから縮小し、また眠い絵になる。
for spec in "16 icon_16x16.png" "32 icon_16x16@2x.png" \
            "32 icon_32x32.png" "64 icon_32x32@2x.png" \
            "128 icon_128x128.png" "256 icon_128x128@2x.png" \
            "256 icon_256x256.png" "512 icon_256x256@2x.png" \
            "512 icon_512x512.png" "1024 icon_512x512@2x.png"; do
  size=${spec%% *}
  name=${spec#* }
  sips -z "$size" "$size" "$SRC" --out "$SET/$name" > /dev/null
done

iconutil --convert icns --output "$OUT" "$SET"

echo "wrote $OUT ($(wc -c < "$OUT") bytes)"
