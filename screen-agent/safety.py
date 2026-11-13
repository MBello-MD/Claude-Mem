"""The approval gate and the URL policy.

Modes:
  risky (default)  Browser: asks before clicks on things that look like buy/pay/send/delete/confirm,
                   before Enter inside a form, and before leaving the allowed domains (if you set any).
                   Desktop: asks before every action that changes something (clicks, typing, keys).
  all              Asks before every action that changes something, browser and desktop.
  none             Never asks. Only for tasks you are watching.

At a prompt: y = run it, n = refuse it (Claude is told you declined), a = stop asking for the rest of
this task, q = stop the agent.
"""

from __future__ import annotations

import re
from urllib.parse import urlparse

from anthropic.tools import ToolError

RISKY_WORDS = re.compile(
    r"\b(buy|purchase|pay|payment|checkout|check out|place order|order now|subscribe|donate|send|submit|"
    r"post|publish|reply|delete|remove|erase|cancel subscription|confirm|accept|agree|sign|transfer|book now|"
    r"comprar|compre|pagar|pagamento|finalizar|fechar pedido|assinar|enviar|envie|publicar|responder|excluir|"
    r"apagar|remover|confirmar|aceitar|aceito|concordo|transferir|pix|reservar)\b",
    re.IGNORECASE,
)

READ_ONLY = {
    "screenshot", "zoom", "read_page", "find", "get_page_text", "list_tabs", "wait", "cursor_position",
    "mouse_move", "hover", "scroll", "scroll_to", "switch_tab", "new_tab",
}
CLICKS = {"left_click", "right_click", "middle_click", "double_click", "triple_click"}


def normalize_url(url: str) -> str:
    """Add https:// to a bare host; refuse every scheme but http(s) (javascript:, data:, file:, chrome:...)."""
    target = url.strip()
    if "://" not in target:
        # "javascript:..." / "data:..." have a scheme but no "//"; "localhost:8080/x" is a host and port
        if re.match(r"^[a-z][a-z0-9+.-]*:(?!\d)", target, re.IGNORECASE):
            raise ToolError("Only http and https URLs are allowed.")
        target = "https://" + target
    if urlparse(target).scheme.lower() not in ("http", "https"):
        raise ToolError("Only http and https URLs are allowed.")
    return target


class Gate:
    def __init__(self, mode: str = "risky", allowed_domains: list[str] | None = None):
        self.mode = mode
        self.allowed = [d.lower().lstrip(".") for d in (allowed_domains or [])]
        self.browser = None            # set by agent.py once the browser is up (for describing targets)
        self.desktop_hooks = None      # (foreground_window, restore_foreground, foreground_title) on Windows
        self._skip_rest = False

    def new_task(self) -> None:
        self._skip_rest = False

    # ----- asking -----

    def _ask(self, what: str) -> bool:
        if self._skip_rest:
            return True
        hwnd = self.desktop_hooks[0]() if self.desktop_hooks else 0
        try:
            while True:
                ans = input(f"\n  APPROVE? {what}\n  [y]es / [n]o / [a]ll for this task / [q]uit > ").strip().lower()
                if ans in ("y", "yes", "s", "sim"):
                    return True
                if ans in ("n", "no", "nao", "não"):
                    return False
                if ans == "a":
                    self._skip_rest = True
                    return True
                if ans == "q":
                    raise KeyboardInterrupt("Stopped at approval prompt")
        finally:
            if self.desktop_hooks:
                self.desktop_hooks[1](hwnd)   # give focus back to the window the agent was using

    # ----- browser -----

    def confirm_browser(self, ctx) -> bool:
        member, inp = ctx.member, ctx.input
        if self.mode == "none" or member in READ_ONLY or member == "navigate":
            return True   # navigate is checked by url_policy
        where = f" on {ctx.tab_url}" if ctx.tab_url else ""
        if self.mode == "all":
            return self._ask(f"browser {member} {self._short(inp)}{where}")
        # risky mode
        if member in CLICKS:
            label = self.browser.describe(inp.tab_id, inp.target) if self.browser else ""
            if RISKY_WORDS.search(label):
                return self._ask(f"browser {member} on: {label[:160]}{where}")
            return True
        if member == "key" and re.search(r"\b(return|enter|kp_enter)\b", inp.text, re.I):
            in_form, label = self.browser.focus_in_form(inp.tab_id) if self.browser else (False, "")
            if in_form:
                return self._ask(f"press {inp.text} in a form field ({label[:100]}){where}")
            return True
        if member in ("javascript_exec", "file_upload"):
            return self._ask(f"browser {member} {self._short(inp)}{where}")
        return True

    def url_policy(self, ctx, url: str) -> None:
        target = normalize_url(url)
        parsed = urlparse(target)
        if parsed.scheme not in ("http", "https"):
            raise ToolError("Only http and https URLs are allowed.")
        host = (parsed.hostname or "").lower()
        if not host:
            raise ToolError("That URL has no host.")
        if self.mode == "none" or not self.allowed:
            return
        if any(host == d or host.endswith("." + d) for d in self.allowed):
            return
        if not self._ask(f"navigate to {host} (not in your allowed domains): {url[:200]}"):
            raise ToolError("The user declined navigating to this site.")

    # ----- desktop -----

    def confirm_desktop(self, ctx) -> bool:
        member = ctx.member
        if self.mode == "none" or member in READ_ONLY:
            return True
        window = self.desktop_hooks[2]() if self.desktop_hooks else "?"
        return self._ask(f"desktop {member} {self._short(ctx.input)} in window: {window[:80]!r}")

    @staticmethod
    def _short(inp) -> str:
        try:
            d = inp.model_dump(exclude_none=True)
        except Exception:
            d = dict(inp)
        s = ", ".join(f"{k}={v!r}" for k, v in d.items())
        return s if len(s) < 160 else s[:157] + "..."
