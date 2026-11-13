"""Key-name translation shared by the desktop driver (pyautogui) and the browser driver (Playwright).

Claude writes keys the way xdotool does ("Return", "ctrl+s", "Page_Down", "super"), sometimes as a
space-separated sequence ("ctrl+a Delete"). `parse` turns that into a list of combos, each a list of
canonical names; the canonical names are exactly pyautogui's, and `to_playwright` maps them for Chrome.
"""

from __future__ import annotations

import re

_CANON = {
    "return": "enter", "enter": "enter", "kp_enter": "enter",
    "escape": "esc", "esc": "esc",
    "backspace": "backspace", "back_space": "backspace",
    "delete": "delete", "del": "delete",
    "tab": "tab", "space": "space", "spacebar": "space",
    "page_up": "pageup", "pageup": "pageup", "prior": "pageup",
    "page_down": "pagedown", "pagedown": "pagedown", "next": "pagedown",
    "home": "home", "end": "end", "insert": "insert",
    "up": "up", "arrowup": "up", "down": "down", "arrowdown": "down",
    "left": "left", "arrowleft": "left", "right": "right", "arrowright": "right",
    "ctrl": "ctrl", "control": "ctrl", "control_l": "ctrl", "control_r": "ctrl",
    "alt": "alt", "alt_l": "alt", "alt_r": "alt", "option": "alt",
    "shift": "shift", "shift_l": "shift", "shift_r": "shift",
    "super": "win", "super_l": "win", "super_r": "win", "win": "win", "windows": "win",
    "meta": "win", "cmd": "win", "command": "win",
    "caps_lock": "capslock", "capslock": "capslock",
    "print": "printscreen", "printscreen": "printscreen", "menu": "apps",
    "plus": "+", "minus": "-",
}

MODIFIERS = {"ctrl", "alt", "shift", "win"}


def canonical(name: str) -> str:
    raw = name.strip()
    low = raw.lower()
    if low in _CANON:
        return _CANON[low]
    if re.fullmatch(r"f([1-9]|1[0-9]|2[0-4])", low):
        return low
    if len(raw) == 1:
        return low if raw.isalpha() else raw
    raise ValueError(f"Unknown key name: {name!r}")


def parse(text: str) -> list[list[str]]:
    """'ctrl+shift+t Return' -> [['ctrl', 'shift', 't'], ['enter']]"""
    combos: list[list[str]] = []
    for chunk in text.split():
        if chunk == "+":
            parts = ["+"]
        elif chunk.endswith("++"):
            parts = chunk[:-2].split("+") + ["+"]
        else:
            parts = chunk.split("+")
        combos.append([canonical(p) for p in parts if p])
    if not combos:
        raise ValueError("No key given")
    return combos


def parse_modifiers(text: str | None) -> list[str]:
    """Click modifiers ('shift', 'ctrl+shift') -> canonical modifier names."""
    if not text:
        return []
    mods = [canonical(p) for p in re.split(r"[+\s,]+", text) if p]
    bad = [m for m in mods if m not in MODIFIERS]
    if bad:
        raise ValueError(f"Not a modifier key: {', '.join(bad)}")
    return mods


_PLAYWRIGHT = {
    "enter": "Enter", "esc": "Escape", "backspace": "Backspace", "delete": "Delete", "tab": "Tab",
    "space": "Space", "pageup": "PageUp", "pagedown": "PageDown", "home": "Home", "end": "End",
    "insert": "Insert", "up": "ArrowUp", "down": "ArrowDown", "left": "ArrowLeft", "right": "ArrowRight",
    "ctrl": "Control", "alt": "Alt", "shift": "Shift", "win": "Meta", "capslock": "CapsLock",
    "printscreen": "PrintScreen", "apps": "ContextMenu",
}


def to_playwright(name: str) -> str:
    if name in _PLAYWRIGHT:
        return _PLAYWRIGHT[name]
    if re.fullmatch(r"f\d{1,2}", name):
        return name.upper()
    return name
