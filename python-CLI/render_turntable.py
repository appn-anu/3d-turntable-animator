#!/usr/bin/env python3
"""Render a turntable MP4 + GIF from a vertex-coloured PLY mesh.

This script uses Open3D's EGL headless OffscreenRenderer, so it works on
machines without a real display.  The resulting files are encoded with
ffmpeg.
"""

import argparse
import math
import os
import shutil
import subprocess
import sys
import tempfile

import numpy as np
import open3d as o3d


AXIS_BG = {
    "white": np.array([1.0, 1.0, 1.0, 1.0], dtype=np.float32),
    "black": np.array([0.0, 0.0, 0.0, 1.0], dtype=np.float32),
}


def parse_args():
    parser = argparse.ArgumentParser(description="Turntable render of a PLY mesh")
    parser.add_argument("--ply", default="wheat_cutout.ply", help="input mesh")
    parser.add_argument("--output", default="wheat_turntable", help="output stem")
    parser.add_argument("--width", type=int, default=1280)
    parser.add_argument("--height", type=int, default=1280)
    parser.add_argument("--bg", choices=list(AXIS_BG), default="white")
    parser.add_argument("--axis", choices=["x", "y", "z"], default="z",
                        help="rotation axis for the turntable")
    parser.add_argument("--no-gif", action="store_true",
                        help="only render MP4, skip GIF encoding")
    parser.add_argument("--duration", type=float, default=12.0, help="loop length in seconds")
    parser.add_argument("--fps", type=float, default=30.0, help="frame rate for MP4")
    parser.add_argument("--fov", type=float, default=60.0, help="vertical field of view in degrees")
    parser.add_argument("--margin", type=float, default=1.5, help="camera distance margin around bbox")
    args = parser.parse_args()

    # yuv420p requires even width/height; libx264 fails otherwise.
    for name in ("width", "height"):
        value = getattr(args, name)
        if value % 2:
            value += 1
            setattr(args, name, value)
            print(f"  note: {name} rounded up to {value} (yuv420p needs even dimensions)")

    return args


def rotate_x(angle):
    c = math.cos(angle)
    s = math.sin(angle)
    return np.array([
        [1.0, 0.0, 0.0],
        [0.0, c, -s],
        [0.0, s, c],
    ], dtype=np.float64)


def rotate_y(angle):
    c = math.cos(angle)
    s = math.sin(angle)
    return np.array([
        [c, 0.0, s],
        [0.0, 1.0, 0.0],
        [-s, 0.0, c],
    ], dtype=np.float64)


def rotate_z(angle):
    c = math.cos(angle)
    s = math.sin(angle)
    return np.array([
        [c, -s, 0.0],
        [s, c, 0.0],
        [0.0, 0.0, 1.0],
    ], dtype=np.float64)


def run_ffmpeg(frame_dir, fps, width, height, stem, make_gif=True):
    """Encode an MP4 (and optionally a GIF) from the numbered PNG frames."""
    frames = sorted(f for f in os.listdir(frame_dir) if f.endswith(".png"))
    if not frames:
        raise RuntimeError("No frames were captured")

    pattern = os.path.join(frame_dir, "%04d.png")
    mp4_out = f"{stem}.mp4"
    gif_out = f"{stem}.gif"

    # H.264 MP4 - maximally PowerPoint-friendly.
    cmd_mp4 = [
        "ffmpeg", "-y",
        "-framerate", str(fps),
        "-i", pattern,
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-r", str(fps),
        mp4_out,
    ]
    print("  ->", " ".join(cmd_mp4))
    subprocess.run(cmd_mp4, check=True)

    if not make_gif:
        return mp4_out, None

    # Optimised looping GIF (10 fps keeps size reasonable).
    cmd_gif = [
        "ffmpeg", "-y",
        "-framerate", str(fps),
        "-i", pattern,
        "-vf",
        (
            "fps=10,"
            "split[s0][s1];[s0]palettegen=128[p];[s1][p]paletteuse=dither=bayer"
        ),
        "-loop", "0",
        gif_out,
    ]
    print("  ->", " ".join(cmd_gif))
    subprocess.run(cmd_gif, check=True)

    return mp4_out, gif_out


def main():
    args = parse_args()

    if not os.path.exists(args.ply):
        print(f"Error: {args.ply} not found", file=sys.stderr)
        sys.exit(1)

    print(f"Loading {args.ply} ...")
    mesh = o3d.io.read_triangle_mesh(args.ply)
    is_point_cloud = (len(mesh.triangles) == 0)

    if is_point_cloud:
        geometry = o3d.geometry.PointCloud()
        geometry.points = mesh.vertices
        if mesh.has_vertex_colors():
            geometry.colors = mesh.vertex_colors
        if mesh.has_vertex_normals():
            geometry.normals = mesh.vertex_normals
    else:
        geometry = mesh
        geometry.compute_vertex_normals()

    if geometry.is_empty():
        print("Error: geometry is empty", file=sys.stderr)
        sys.exit(1)

    # Center the plant at the origin so rotation is clean.
    bbox = geometry.get_axis_aligned_bounding_box()
    center = bbox.get_center()
    geometry.translate(-center, relative=True)

    size = bbox.get_max_bound() - bbox.get_min_bound()
    max_size = float(np.max(size))
    print(f"  centered bbox size = {size}")
    print(f"  geometry type: {'point cloud' if is_point_cloud else 'mesh'}")

    # Camera distance chosen so the whole plant fits comfortably.
    fov_rad = math.radians(args.fov)
    distance = (max_size / (2.0 * math.tan(fov_rad / 2.0))) * args.margin

    n_frames = int(round(args.duration * args.fps))
    print(f"Rendering {n_frames} frames at {args.width}x{args.height} ({args.bg} bg)")

    renderer = o3d.visualization.rendering.OffscreenRenderer(args.width, args.height)

    material = o3d.visualization.rendering.MaterialRecord()
    if is_point_cloud:
        # Point clouds need an unlit shader; the per-point colours are used
        # automatically.  The point size is scaled to avoid visible gaps.
        material.shader = "defaultUnlit"
        material.point_size = max(2.0, min(5.0, args.width / 320.0))
        print(f"  point size: {material.point_size}")
    else:
        material.shader = "defaultLit"
        material.sRGB_color = True

    renderer.scene.add_geometry("plant", geometry, material)
    renderer.scene.set_background(AXIS_BG[args.bg])

    # Directional sun light only matters for lit meshes.
    if not is_point_cloud:
        renderer.scene.scene.set_sun_light([0.5, 1.0, 1.0], [1.0, 1.0, 1.0], 120000.0)
        renderer.scene.scene.enable_sun_light(True)

    frames_dir = tempfile.mkdtemp(prefix=f"turntable_{args.width}_{args.bg}_")
    try:
        center_pt = np.zeros(3, dtype=np.float64)

        # Pick a camera orbit around the requested axis so the object stays
        # roughly upright in the frame.
        if args.axis == "x":
            base_eye = np.array([0.0, distance, 0.0], dtype=np.float64)
            up = np.array([1.0, 0.0, 0.0], dtype=np.float64)
            rot = rotate_x
        elif args.axis == "y":
            base_eye = np.array([0.0, 0.0, distance], dtype=np.float64)
            up = np.array([0.0, 1.0, 0.0], dtype=np.float64)
            rot = rotate_y
        else:  # z (default)
            base_eye = np.array([distance, 0.0, 0.0], dtype=np.float64)
            up = np.array([0.0, 0.0, 1.0], dtype=np.float64)
            rot = rotate_z

        for i in range(n_frames):
            angle = 2.0 * math.pi * i / n_frames
            eye = rot(angle) @ base_eye

            renderer.setup_camera(args.fov, center_pt, eye, up)
            img = renderer.render_to_image()
            out_png = os.path.join(frames_dir, f"{i:04d}.png")
            o3d.io.write_image(out_png, img)

            if (i + 1) % 60 == 0 or i == n_frames - 1:
                print(f"  frame {i + 1}/{n_frames}")

        if args.no_gif:
            print("Encoding MP4 ...")
        else:
            print("Encoding MP4 + GIF ...")
        mp4, gif = run_ffmpeg(
            frames_dir, args.fps, args.width, args.height, args.output,
            make_gif=not args.no_gif,
        )
        print(f"Wrote {mp4}")
        if gif:
            print(f"Wrote {gif}")
    finally:
        shutil.rmtree(frames_dir, ignore_errors=True)


if __name__ == "__main__":
    main()
