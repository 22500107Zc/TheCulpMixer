#!/usr/bin/env python3
"""
Reference image-to-3D server for Kiln.

Kiln does not bundle neural weights — they are gigabytes and want a GPU. This
is the other half of the contract instead: a dependency-light HTTP server you
run yourself, so the model, the weights and the images all stay on your
machine.

    python3 tools/kiln-ai-server.py                 # echo backend, for wiring up
    python3 tools/kiln-ai-server.py --backend triposr

Then in Kiln: Create tab -> Local AI model -> Check -> Generate 3D.

THE CONTRACT
------------
    GET  /health    -> {"name": str, "models": [str], "detail": str}
    POST /generate  -> multipart form: image (file), model, prompt, detail
                    <- an OBJ, either as text/plain or as
                       {"format": "obj", "data": "...", "name": str, "seconds": float}

Anything that speaks that works. Swap in Hunyuan3D, TRELLIS, InstantMesh,
Stable Fast 3D or your own pipeline by writing one function.
"""

from __future__ import annotations

import argparse
import cgi
import io
import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# --------------------------------------------------------------------------
# Backends. Each takes PNG/JPEG bytes and returns OBJ text.
# --------------------------------------------------------------------------


class EchoBackend:
    """No model. Returns a box sized to the image's aspect ratio.

    Useful on its own: it proves the wiring end to end before you spend an hour
    installing CUDA, and it needs nothing but the standard library.
    """

    name = "echo (no model)"
    models = ["box"]
    detail = "Placeholder backend — returns a box, so you can verify the connection."

    def generate(self, image_bytes: bytes, model: str, prompt: str, detail: str) -> str:
        width, height = _png_size(image_bytes) or (1, 1)
        aspect = width / max(1, height)
        hx, hy, hz = aspect, 0.2, 1.0
        verts = [
            (-hx, -hy, -hz), (hx, -hy, -hz), (hx, hy, -hz), (-hx, hy, -hz),
            (-hx, -hy, hz), (hx, -hy, hz), (hx, hy, hz), (-hx, hy, hz),
        ]
        faces = [
            (1, 4, 3, 2), (5, 6, 7, 8), (1, 2, 6, 5),
            (2, 3, 7, 6), (3, 4, 8, 7), (4, 1, 5, 8),
        ]
        lines = ["# kiln-ai-server echo backend", "o EchoBox"]
        lines += [f"v {x:.6f} {y:.6f} {z:.6f}" for x, y, z in verts]
        lines += ["f " + " ".join(str(i) for i in face) for face in faces]
        return "\n".join(lines) + "\n"


class TripoSRBackend:
    """Single-image to mesh with TripoSR.

    Install first (a GPU with ~6 GB is comfortable; CPU works but is slow):

        pip install torch torchvision transformers rembg omegaconf einops trimesh
        git clone https://github.com/VAST-AI-Research/TripoSR
        pip install -e TripoSR

    Weights download on first run.
    """

    name = "TripoSR"
    models = ["stabilityai/TripoSR"]
    detail = "Single-image reconstruction."

    def __init__(self) -> None:
        import torch  # noqa: F401  (imported here so --backend echo needs nothing)
        from tsr.system import TSR

        import torch as _torch

        self.device = "cuda" if _torch.cuda.is_available() else "cpu"
        self.model = TSR.from_pretrained(
            "stabilityai/TripoSR",
            config_name="config.yaml",
            weight_name="model.ckpt",
        )
        self.model.renderer.set_chunk_size(8192)
        self.model.to(self.device)
        self.detail = f"TripoSR on {self.device}."

    def generate(self, image_bytes: bytes, model: str, prompt: str, detail: str) -> str:
        from PIL import Image
        import rembg

        image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        image = rembg.remove(image)
        resolution = {"draft": 128, "standard": 256, "high": 320}.get(detail, 256)

        with_torch = self.model([image], device=self.device)
        meshes = self.model.extract_mesh(with_torch, resolution=resolution)
        buffer = io.StringIO()
        meshes[0].export(buffer, file_type="obj")
        return buffer.getvalue()


BACKENDS = {"echo": EchoBackend, "triposr": TripoSRBackend}


def _png_size(data: bytes) -> tuple[int, int] | None:
    """Width and height straight out of a PNG header, no image library needed."""
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    return int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")


# --------------------------------------------------------------------------
# Server
# --------------------------------------------------------------------------


def make_handler(backend, allow_origin: str):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt: str, *args) -> None:
            print(f"  {self.address_string()} {fmt % args}")

        def _cors(self) -> None:
            self.send_header("Access-Control-Allow-Origin", allow_origin)
            self.send_header("Access-Control-Allow-Headers", "content-type, accept")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

        def _send(self, code: int, body: bytes, content_type: str) -> None:
            self.send_response(code)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self._cors()
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self) -> None:  # noqa: N802 - required by BaseHTTPRequestHandler
            self.send_response(204)
            self._cors()
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_GET(self) -> None:  # noqa: N802
            if self.path.rstrip("/") != "/health":
                self._send(404, b"not found", "text/plain")
                return
            payload = {
                "name": backend.name,
                "models": list(backend.models),
                "detail": getattr(backend, "detail", ""),
            }
            self._send(200, json.dumps(payload).encode(), "application/json")

        def do_POST(self) -> None:  # noqa: N802
            if self.path.rstrip("/") != "/generate":
                self._send(404, b"not found", "text/plain")
                return
            try:
                form = cgi.FieldStorage(
                    fp=self.rfile,
                    headers=self.headers,
                    environ={
                        "REQUEST_METHOD": "POST",
                        "CONTENT_TYPE": self.headers.get("Content-Type", ""),
                    },
                )
                if "image" not in form:
                    self._send(400, b'{"error":"no image field"}', "application/json")
                    return
                image_bytes = form["image"].file.read()
                started = time.time()
                obj = backend.generate(
                    image_bytes,
                    form.getvalue("model", ""),
                    form.getvalue("prompt", ""),
                    form.getvalue("detail", "standard"),
                )
                payload = {
                    "format": "obj",
                    "data": obj,
                    "name": f"{backend.name} result",
                    "seconds": round(time.time() - started, 2),
                }
                self._send(200, json.dumps(payload).encode(), "application/json")
            except Exception as exc:  # noqa: BLE001 - report anything to the client
                message = json.dumps({"error": f"{type(exc).__name__}: {exc}"})
                self._send(500, message.encode(), "application/json")

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser(description="Local image-to-3D server for Kiln")
    parser.add_argument("--backend", default="echo", choices=sorted(BACKENDS))
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8017)
    parser.add_argument(
        "--allow-origin",
        default="*",
        help="CORS origin. The Kiln desktop app serves from kiln://app, so leave this alone unless you know you need to.",
    )
    args = parser.parse_args()

    backend = BACKENDS[args.backend]()
    server = ThreadingHTTPServer((args.host, args.port), make_handler(backend, args.allow_origin))
    print(f"Kiln AI server: {backend.name}")
    print(f"Listening on http://{args.host}:{args.port}  (point Kiln's Create tab here)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
