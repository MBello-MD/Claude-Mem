"""Windows desktop driver for computer_toolset_20260801 (primary monitor only).

Screenshots: mss. Mouse: pyautogui. Keyboard: pyautogui for keys, Windows SendInput for text, so
accented characters (ç, ã, é) type correctly whatever the keyboard layout.
Moving the mouse into the top-left corner of the screen stops the agent (pyautogui fail-safe).
"""

from __future__ import annotations

import sys
import time
import ctypes
from ctypes import wintypes
from pathlib import Path

if sys.platform != "win32":
    raise ImportError("desktop.py drives a Windows desktop; run the agent with --no-desktop elsewhere")

# Physical pixels everywhere: must run before anything touches the screen.
try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)  # per-monitor DPI aware
except Exception:
    ctypes.windll.user32.SetProcessDPIAware()

import mss
import pyautogui
from PIL import Image

from anthropic.tools import ToolError
from anthropic.tools.computer import (
    BetaScreenshotResult,
    BetaComputerCursorPositionResult,
    BetaAbstractComputerToolset20260801,
)

import keys
import imaging

pyautogui.FAILSAFE = True
pyautogui.PAUSE = 0.05

user32 = ctypes.windll.user32

# ---------- SendInput (unicode text and wheel) ----------

INPUT_MOUSE, INPUT_KEYBOARD = 0, 1
KEYEVENTF_KEYUP, KEYEVENTF_UNICODE = 0x0002, 0x0004
MOUSEEVENTF_WHEEL, MOUSEEVENTF_HWHEEL = 0x0800, 0x1000
WHEEL_DELTA = 120


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [("dx", wintypes.LONG), ("dy", wintypes.LONG), ("mouseData", wintypes.DWORD),
                ("dwFlags", wintypes.DWORD), ("time", wintypes.DWORD), ("dwExtraInfo", ctypes.c_size_t)]


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", wintypes.WORD), ("wScan", wintypes.WORD), ("dwFlags", wintypes.DWORD),
                ("time", wintypes.DWORD), ("dwExtraInfo", ctypes.c_size_t)]


class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [("uMsg", wintypes.DWORD), ("wParamL", wintypes.WORD), ("wParamH", wintypes.WORD)]


class _U(ctypes.Union):
    _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT), ("hi", HARDWAREINPUT)]


class INPUT(ctypes.Structure):
    _anonymous_ = ("u",)
    _fields_ = [("type", wintypes.DWORD), ("u", _U)]


def _send(*inputs: INPUT) -> None:
    arr = (INPUT * len(inputs))(*inputs)
    if user32.SendInput(len(inputs), arr, ctypes.sizeof(INPUT)) != len(inputs):
        raise ToolError("Windows blocked the input (is an elevated/admin window in front?)")


def _type_unicode(text: str) -> None:
    for ch in text:
        if ch == "\n":
            pyautogui.press("enter")
            continue
        if ch == "\r":
            continue
        if ch == "\t":
            pyautogui.press("tab")
            continue
        units = ch.encode("utf-16-le")
        for i in range(0, len(units), 2):
            code = int.from_bytes(units[i:i + 2], "little")
            down = INPUT(type=INPUT_KEYBOARD, ki=KEYBDINPUT(0, code, KEYEVENTF_UNICODE, 0, 0))
            up = INPUT(type=INPUT_KEYBOARD, ki=KEYBDINPUT(0, code, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, 0, 0))
            _send(down, up)
        time.sleep(0.008)


def _wheel(direction: str, clicks: int) -> None:
    flag = MOUSEEVENTF_HWHEEL if direction in ("left", "right") else MOUSEEVENTF_WHEEL
    sign = 1 if direction in ("up", "right") else -1
    for _ in range(clicks):
        delta = ctypes.c_int32(sign * WHEEL_DELTA).value & 0xFFFFFFFF
        _send(INPUT(type=INPUT_MOUSE, mi=MOUSEINPUT(0, 0, delta, flag, 0, 0)))
        time.sleep(0.03)


def foreground_title() -> str:
    hwnd = user32.GetForegroundWindow()
    n = user32.GetWindowTextLengthW(hwnd)
    buf = ctypes.create_unicode_buffer(n + 1)
    user32.GetWindowTextW(hwnd, buf, n + 1)
    return buf.value


def foreground_window() -> int:
    return user32.GetForegroundWindow()


def restore_foreground(hwnd: int) -> None:
    """Give focus back to the window that had it before the approval prompt took it (best effort)."""
    if not hwnd:
        return
    user32.keybd_event(0x12, 0, 0, 0)       # tap Alt: lets this process change the foreground window
    user32.keybd_event(0x12, 0, 2, 0)
    user32.SetForegroundWindow(hwnd)
    time.sleep(0.15)


# ---------- the toolset ----------

class WindowsDesktop(BetaAbstractComputerToolset20260801):
    def __init__(self, *, confirm, run_dir: Path | None = None):
        super().__init__(confirm=confirm)
        self._w = user32.GetSystemMetrics(0)   # primary monitor, physical px (it always starts at 0,0)
        self._h = user32.GetSystemMetrics(1)
        nw, nh = imaging.fit_size(self._w, self._h)
        self._sx, self._sy = nw / self._w, nh / self._h
        self._run_dir = run_dir

    # coordinates: screenshot px <-> screen px
    def _to_screen(self, xy) -> tuple[int, int]:
        if xy is None or len(xy) != 2:
            raise ToolError("coordinate must be [x, y]")
        x, y = round(xy[0] / self._sx), round(xy[1] / self._sy)
        if not (0 <= x < self._w and 0 <= y < self._h):
            raise ToolError(f"{list(xy)} is outside the screenshot")
        # keep 1px away from the fail-safe corner so a legitimate click there doesn't stop the agent
        return max(x, 1), max(y, 1)

    def _grab(self, left=0, top=0, width=None, height=None) -> Image.Image:
        region = {"left": left, "top": top, "width": width or self._w, "height": height or self._h}
        with mss.mss() as sct:
            shot = sct.grab(region)
        return Image.frombytes("RGB", shot.size, shot.bgra, "raw", "BGRX")

    def _guard(self, fn, *a, **kw):
        try:
            return fn(*a, **kw)
        except pyautogui.FailSafeException:
            raise KeyboardInterrupt("Fail-safe: mouse moved to the screen corner") from None

    def _click(self, input, button: str, clicks: int):
        mods = self._mods(input.text)
        if input.coordinate is not None:
            self._guard(pyautogui.moveTo, *self._to_screen(input.coordinate), duration=0.1)
        for m in mods:
            pyautogui.keyDown(m)
        try:
            self._guard(pyautogui.click, button=button, clicks=clicks, interval=0.08)
        finally:
            for m in reversed(mods):
                pyautogui.keyUp(m)
        time.sleep(0.3)
        return None

    @staticmethod
    def _mods(text):
        try:
            return keys.parse_modifiers(text)
        except ValueError as e:
            raise ToolError(str(e)) from None

    def _save(self, img: Image.Image, kind: str) -> None:
        if self._run_dir:
            img.save(self._run_dir / f"{time.strftime('%H%M%S')}-{int(time.time()*1000)%1000:03d}-desktop-{kind}.png")

    # members

    def screenshot(self, context, input) -> BetaScreenshotResult:
        self._w, self._h = user32.GetSystemMetrics(0), user32.GetSystemMetrics(1)  # resolution may change
        img, self._sx, self._sy = imaging.shrink(self._grab())
        self._save(img, "screenshot")
        data, media = imaging.encode(img)
        return BetaScreenshotResult(data=data, media_type=media)

    def zoom(self, context, input) -> BetaScreenshotResult:
        if len(input.region) != 4:
            raise ToolError("region must be [x0, y0, x1, y1]")
        x0, y0 = round(input.region[0] / self._sx), round(input.region[1] / self._sy)
        x1, y1 = round(input.region[2] / self._sx), round(input.region[3] / self._sy)
        x0, y0, x1, y1 = max(0, x0), max(0, y0), min(self._w, x1), min(self._h, y1)
        if x1 <= x0 or y1 <= y0:
            raise ToolError("region must have x1 > x0 and y1 > y0, inside the screen")
        box_w, box_h = imaging.fit_size(self._w, self._h)
        img = imaging.fit_into(self._grab(x0, y0, x1 - x0, y1 - y0), box_w, box_h)
        self._save(img, "zoom")
        data, media = imaging.encode(img)
        return BetaScreenshotResult(data=data, media_type=media)

    def cursor_position(self, context, input) -> BetaComputerCursorPositionResult:
        x, y = pyautogui.position()
        return BetaComputerCursorPositionResult(x=round(x * self._sx), y=round(y * self._sy))

    def left_click(self, context, input):
        return self._click(input, "left", 1)

    def right_click(self, context, input):
        return self._click(input, "right", 1)

    def middle_click(self, context, input):
        return self._click(input, "middle", 1)

    def double_click(self, context, input):
        return self._click(input, "left", 2)

    def triple_click(self, context, input):
        return self._click(input, "left", 3)

    def left_click_drag(self, context, input):
        mods = self._mods(input.text)
        start, end = self._to_screen(input.start_coordinate), self._to_screen(input.coordinate)
        self._guard(pyautogui.moveTo, *start, duration=0.1)
        for m in mods:
            pyautogui.keyDown(m)
        try:
            pyautogui.mouseDown(button="left")
            self._guard(pyautogui.moveTo, *end, duration=0.5)
            pyautogui.mouseUp(button="left")
        finally:
            for m in reversed(mods):
                pyautogui.keyUp(m)
        return None

    def mouse_move(self, context, input):
        self._guard(pyautogui.moveTo, *self._to_screen(input.coordinate), duration=0.1)
        return None

    def left_mouse_down(self, context, input):
        self._guard(pyautogui.mouseDown, button="left")
        return None

    def left_mouse_up(self, context, input):
        self._guard(pyautogui.mouseUp, button="left")
        return None

    def scroll(self, context, input):
        mods = self._mods(input.text)
        if input.coordinate is not None:
            self._guard(pyautogui.moveTo, *self._to_screen(input.coordinate), duration=0.1)
        for m in mods:
            pyautogui.keyDown(m)
        try:
            _wheel(input.scroll_direction, max(1, min(30, input.scroll_amount)))
        finally:
            for m in reversed(mods):
                pyautogui.keyUp(m)
        time.sleep(0.3)
        return None

    def type(self, context, input):
        _type_unicode(input.text)
        return None

    def key(self, context, input):
        try:
            combos = keys.parse(input.text)
        except ValueError as e:
            raise ToolError(str(e)) from None
        for _ in range(max(1, min(100, input.repeat or 1))):
            for combo in combos:
                self._guard(pyautogui.hotkey, *combo) if len(combo) > 1 else self._guard(pyautogui.press, combo[0])
        time.sleep(0.2)
        return None

    def hold_key(self, context, input):
        try:
            names = [k for combo in keys.parse(input.text) for k in combo]
        except ValueError as e:
            raise ToolError(str(e)) from None
        for k in names:
            pyautogui.keyDown(k)
        try:
            time.sleep(max(0, min(300, input.duration)))
        finally:
            for k in reversed(names):
                pyautogui.keyUp(k)
        return None

    def wait(self, context, input):
        time.sleep(max(0, min(300, input.duration)))
        return None
