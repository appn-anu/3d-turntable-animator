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
    local stem128="outputs/wheat_1280x1280_${bg}"

    echo "=================================================="
    echo "Rendering 1280 x 1280 on $bg background"
    echo "=================================================="
    .venv/bin/python render_turntable.py \
        --ply wheat_cutout.ply \
        --width 1280 --height 1280 \
        --bg "$bg" \
        --output "$stem128"

    echo "Down-scaling to 640 x 640 ..."

    ffmpeg -y -i "${stem128}.mp4" \
        -vf "scale=640:640:flags=lanczos" \
        -c:v libx264 -pix_fmt yuv420p \
        "outputs/wheat_640x640_${bg}.mp4"

    ffmpeg -y -i "${stem128}.mp4" \
        -vf "fps=10,scale=640:640:flags=lanczos,split[s0][s1];[s0]palettegen=128[p];[s1][p]paletteuse=dither=bayer" \
        -loop 0 \
        "outputs/wheat_640x640_${bg}.gif"
}

for bg in white black; do
    render_bg "$bg"
done

echo ""
echo "All done. Outputs:"
ls -lh outputs/
