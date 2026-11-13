"""Screenshot sizing. The API rejects images that are too large instead of shrinking them, so every image
is resized here first, and the scale factor is kept so Claude's coordinates can be mapped back."""

from __future__ import annotations

import io
import math
import base64

from PIL import Image

# Limits for the models that take the 2026-08-01 toolsets.
MAX_LONG_EDGE = 2576
MAX_VISUAL_TOKENS = 4784  # ceil(w/28) * ceil(h/28)
# Accuracy is best at or below 1920x1080, so screenshots are brought down to this by default.
TARGET_LONG_EDGE = 1920
# Keep the encoded image comfortably under the per-image upload limit.
MAX_BYTES = 3_500_000


def visual_tokens(w: int, h: int) -> int:
    return math.ceil(w / 28) * math.ceil(h / 28)


def fit_size(w: int, h: int, target_long_edge: int = TARGET_LONG_EDGE) -> tuple[int, int]:
    """The largest size <= (w, h), same aspect ratio, inside every limit."""
    s = min(1.0, target_long_edge / max(w, h), MAX_LONG_EDGE / max(w, h))
    nw, nh = max(1, round(w * s)), max(1, round(h * s))
    while visual_tokens(nw, nh) > MAX_VISUAL_TOKENS:
        s *= 0.98
        nw, nh = max(1, round(w * s)), max(1, round(h * s))
    return nw, nh


def fit_into(img: Image.Image, box_w: int, box_h: int) -> Image.Image:
    """Scale (up or down) to fit inside box_w x box_h, keeping the aspect ratio. Used for zoom."""
    s = min(box_w / img.width, box_h / img.height)
    nw, nh = max(1, round(img.width * s)), max(1, round(img.height * s))
    nw, nh = min(nw, MAX_LONG_EDGE), min(nh, MAX_LONG_EDGE)
    while visual_tokens(nw, nh) > MAX_VISUAL_TOKENS:
        nw, nh = max(1, round(nw * 0.98)), max(1, round(nh * 0.98))
    return img.resize((nw, nh), Image.LANCZOS) if (nw, nh) != img.size else img


def shrink(img: Image.Image, target_long_edge: int = TARGET_LONG_EDGE) -> tuple[Image.Image, float, float]:
    """Resize to fit the limits. Returns (image, sx, sy) where screenshot_px = real_px * s."""
    nw, nh = fit_size(img.width, img.height, target_long_edge)
    sx, sy = nw / img.width, nh / img.height
    if (nw, nh) != img.size:
        img = img.resize((nw, nh), Image.LANCZOS)
    return img, sx, sy


def encode(img: Image.Image) -> tuple[str, str]:
    """(base64 data, media type). PNG unless it is too heavy, then JPEG."""
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="PNG", optimize=True)
    if buf.tell() <= MAX_BYTES:
        return base64.b64encode(buf.getvalue()).decode(), "image/png"
    for quality in (85, 70, 55):
        buf = io.BytesIO()
        img.convert("RGB").save(buf, format="JPEG", quality=quality)
        if buf.tell() <= MAX_BYTES:
            break
    return base64.b64encode(buf.getvalue()).decode(), "image/jpeg"
