#!/usr/bin/env bash
# Regenerate docs/demo.gif from docs/demo.html using headless Chrome + ffmpeg.
# Each frame is a deterministic render of docs/demo.html?t=<ms>.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)" # -> chrome-extension/
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
PORT="${PORT:-8754}"
T="${T:-6600}"     # loop duration (ms), must match demo.html
FPS="${FPS:-8}"
STEP=$((1000 / FPS))
FRAMES="/tmp/adhan_frames"
UDD="/tmp/adhan_cdp"
OUT="$HERE/docs/demo.gif"

# Clean leftovers from any interrupted run (Chrome may still hold the profile dir).
pkill -f "$UDD" 2>/dev/null || true
sleep 0.4
rm -rf "$FRAMES" "$UDD" 2>/dev/null || true
mkdir -p "$FRAMES" "$UDD"

python3 -m http.server "$PORT" --directory "$HERE" >/tmp/adhan_demo_server.log 2>&1 &
SRV=$!
trap 'kill "$SRV" 2>/dev/null || true; pkill -f "$UDD" 2>/dev/null || true' EXIT
until curl -s -o /dev/null "http://localhost:$PORT/docs/demo.html"; do sleep 0.3; done

# headless=new doesn't reliably self-exit after --screenshot, so we launch in
# the background, poll for the frame file, then kill it. Per-frame we clear the
# profile lock so the next launch isn't blocked.
i=0
for ((t=0; t<T; t+=STEP)); do
  printf -v n "%03d" "$i"
  rm -f "$UDD"/Singleton* 2>/dev/null || true
  rm -f "$FRAMES/f_$n.png"
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --window-size=900,560 --user-data-dir="$UDD" --no-first-run --no-default-browser-check \
    --screenshot="$FRAMES/f_$n.png" \
    "http://localhost:$PORT/docs/demo.html?t=$t" >/dev/null 2>&1 &
  CPID=$!
  for _ in $(seq 1 60); do [ -s "$FRAMES/f_$n.png" ] && break; sleep 0.1; done
  sleep 0.3
  kill "$CPID" 2>/dev/null || true
  wait "$CPID" 2>/dev/null || true
  i=$((i + 1))
done

ffmpeg -y -framerate "$FPS" -i "$FRAMES/f_%03d.png" \
  -vf "scale=760:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer" \
  -loop 0 "$OUT" >/tmp/adhan_ffmpeg.log 2>&1

echo "wrote $OUT ($i frames @ ${FPS}fps)"
