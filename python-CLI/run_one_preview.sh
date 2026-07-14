#!/usr/bin/env bash
# Quick 480x480 MP4 preview so you can check the turntable before the full run.
#
# Usage:
#   ./run_one_preview.sh               # white background, Z-axis rotation
#   ./run_one_preview.sh black          # black background
#   ./run_one_preview.sh white y        # white background, Y-axis rotation

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [[ ! -d .venv ]]; then
    echo "Virtualenv not found; create it with:"
    echo "  python3 -m venv .venv"
    echo "  .venv/bin/pip install -r requirements.txt"
    exit 1
fi

export OPEN3D_HEADLESS=1

mkdir -p outputs

BG="${1:-white}"
AXIS="${2:-z}"
OUTPUT="outputs/preview_480x480_${BG}_axis${AXIS}"

echo "Rendering 480x480 preview (bg=$BG, axis=$AXIS) -> ${OUTPUT}.mp4"

.venv/bin/python render_turntable.py \
    --ply wheat_table.ply \
    --width 960 --height 540 \
    --bg "$BG" \
    --axis "$AXIS" \
    --duration 3 \
    --fps 10 \
    --fov 80 \
    --margin 1 \
    --no-gif \
    --output "$OUTPUT"

echo ""
echo "Preview ready: ${OUTPUT}.mp4"
