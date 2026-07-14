#!/usr/bin/env bash
# Render 8 turntable variants of wheat_cutout.ply:
#   2 resolutions (1280x1280 and 640x640)
#   2 formats (MP4 and GIF)
#   2 backgrounds (white and black)
#
# Uses Open3D's EGL headless renderer, so it works on machines without a real
# display.  Run with:
#   ./run_render.sh

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

render_bg() {
    local bg="$1"
    local stem128="outputs/wheat_1920x1280_${bg}"

    echo "=================================================="
    echo "Rendering 1920 x 1280 on $bg background"
    echo "=================================================="
    .venv/bin/python render_turntable.py \
        --ply wheat_table.ply \
        --width 1920 --height 1280 \
        --bg "$bg" \
        --no-gif \
        --margin 1 \
        --fov 70 \
        --output "$stem128"

    echo "Down-scaling to 960 x 540 ..."

    ffmpeg -y -i "${stem128}.mp4" \
        -vf "scale=960:540:flags=lanczos" \
        -c:v libx264 -pix_fmt yuv420p \
        "outputs/wheat_960x540_${bg}.mp4"
}

for bg in white black; do
    render_bg "$bg"
done

echo ""
echo "All done. Outputs:"
ls -lh outputs/
