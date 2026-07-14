# 3D Point Cloud Turntable Renderer

Renders looping turntable MP4/GIF videos from the `wheat_cutout.ply` 3D scan.
It works with both meshed scans and raw point clouds, and it runs headless
courtesy of Open3D's EGL renderer and ffmpeg.

## Installation

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

You will also need `ffmpeg` (used for encoding MP4 and GIF files).  The
scripts set `OPEN3D_HEADLESS=1` so Open3D can render without a real display.

## Usage

### Quick 480x480 MP4 preview

```bash
./run_one_preview.sh          # white background, Z-axis spin
./run_one_preview.sh black    # black background
./run_one_preview.sh white y  # white background, Y-axis spin
```

The preview outputs a single MP4 to `outputs/preview_480x480_<bg>_axis<axis>.mp4`.

### Full render - 8 outputs

```bash
./run_render.sh
```

This renders a 1280x1280 turntable for each background colour, then
lanczos-downscales the result to 640x640.  The final files in `outputs/` are:

- `wheat_1280x1280_white.mp4`
- `wheat_1280x1280_black.mp4`
- `wheat_1280x1280_white.gif`
- `wheat_1280x1280_black.gif`
- `wheat_640x640_white.mp4`
- `wheat_640x640_black.mp4`
- `wheat_640x640_white.gif`
- `wheat_640x640_black.gif`

### Custom render

For full control, call `render_turntable.py` directly:

```bash
OPEN3D_HEADLESS=1 .venv/bin/python render_turntable.py \
    --ply wheat_cutout.ply \
    --width 800 --height 800 \
    --bg black \
    --axis z \
    --duration 12 \
    --output my_render
```

Common options:

- `--ply PATH` - input PLY file (mesh or point cloud)
- `--bg white|black` - background colour
- `--axis x|y|z` - turntable rotation axis (`z` by default)
- `--width`, `--height` - output resolution
- `--duration SECONDS` - length of one loop
- `--fps 30` - frame rate for the MP4
- `--no-gif` - render only the MP4, skip GIF encoding
- `--margin 1.5` - camera distance multiplier around the bounding box

## Notes

- Point clouds are detected automatically and rendered with a scaled point size
  to avoid visible gaps at higher resolutions.
- Meshes still use lit shading and per-vertex colours.
- The turntable always centres the scan at the origin before rotating.
