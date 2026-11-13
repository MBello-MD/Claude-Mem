"""Chrome driver for browser_toolset_20260801.

Connects to a Chrome you started yourself (launch_chrome.ps1) over the DevTools port, using Playwright.
The SDK base class does the protocol work (input parsing, toolset_name, batch halting, the confirm hook
and the URL policy); this class only performs the actions.
"""

from __future__ import annotations

import io
import re
import time
from pathlib import Path

from PIL import Image
from playwright.sync_api import Page, sync_playwright
from playwright.sync_api import Error as PlaywrightError

from anthropic.tools import ToolError
from anthropic.tools.browser import (
    BetaBrowserState,
    BetaDialogDismissed,
    BetaScreenshotResult,
    BetaBrowserNavigateResult,
    BetaAbstractBrowserToolset20260801,
)

import keys
import imaging
from safety import normalize_url

PAGE_TOOLS = (Path(__file__).parent / "page_tools.js").read_text(encoding="utf-8")
REF_RE = re.compile(r"^ref_\d+$")
STALE = "Error: {ref} is stale or not found on the current page. Re-read the page to get fresh references."


class ChromeBrowser(BetaAbstractBrowserToolset20260801):
    def __init__(self, cdp_url: str, *, confirm, url_policy, run_dir: Path | None = None):
        super().__init__(confirm=confirm, url_policy=url_policy)
        self._pw = sync_playwright().start()
        try:
            self._browser = self._pw.chromium.connect_over_cdp(cdp_url)
        except PlaywrightError as e:
            self._pw.stop()
            raise SystemExit(
                f"Could not reach Chrome at {cdp_url}. Start it first with launch_chrome.ps1.\n{e}"
            ) from None
        self._ctx = self._browser.contexts[0] if self._browser.contexts else self._browser.new_context()
        self._ids: dict[Page, str] = {}
        self._n = 0
        self._ref_next = 0          # refs never repeat, across pages and tabs
        self._changes: list = []
        self._scale: dict[Page, tuple[float, float]] = {}
        self._run_dir = run_dir
        for p in self._ctx.pages:
            self._register(p, announce=False)
        self._ctx.on("page", lambda p: self._register(p, announce=True))
        self._active: Page = self._ctx.pages[-1] if self._ctx.pages else self._ctx.new_page()

    # ---------- tabs ----------

    def _register(self, page: Page, announce: bool) -> None:
        if page in self._ids:
            return
        self._n += 1
        tid = f"tab-{self._n}"
        self._ids[page] = tid
        page.on("dialog", self._on_dialog)
        page.on("close", self._on_close)
        if announce:
            self._changes.append({"type": "tab_opened", "tab_id": tid})
            self._active = page  # Chrome shows a newly opened tab in front

    def _on_dialog(self, dialog) -> None:
        # Native alert/confirm/prompt: dismiss, and tell the model it happened.
        self._changes.append(BetaDialogDismissed(kind=dialog.type, message=(dialog.message or "")[:500]))
        try:
            dialog.accept() if dialog.type == "beforeunload" else dialog.dismiss()
        except PlaywrightError:
            pass

    def _on_close(self, page: Page) -> None:
        self._ids.pop(page, None)
        self._scale.pop(page, None)
        if page is self._active and self._ids:
            self._active = list(self._ids)[-1]

    def _page(self, tab_id: str | None) -> Page:
        if tab_id is None:
            if self._active.is_closed():
                raise ToolError("The active tab was closed. Use list_tabs or new_tab.")
            return self._active
        for p, tid in self._ids.items():
            if tid == tab_id:
                return p
        raise ToolError(f"No open tab with id {tab_id!r}. Use list_tabs to see the open tabs.")

    def _entry(self, page: Page) -> dict:
        try:
            title = page.title()
        except PlaywrightError:
            title = ""
        return {"tab_id": self._ids[page], "title": title[:4096], "url": page.url[:4096], "active": page is self._active}

    def _activate(self, page: Page) -> None:
        self._active = page
        try:
            page.bring_to_front()
        except PlaywrightError:
            pass

    def _browser_state(self, context) -> BetaBrowserState:
        # Changes first: every tab they mention is registered already, so it is in the tab list below.
        # A tab that registers while the list is built reports its tab_opened on the next call.
        changes, self._changes = self._changes[-200:], []
        tabs = [self._entry(p) for p in list(self._ids) if not p.is_closed()][:100]
        if tabs and not any(t["active"] for t in tabs):
            tabs[-1]["active"] = True
        return BetaBrowserState(tabs=tabs, state_changes=changes)

    # ---------- helpers ----------

    def _js(self, page: Page, **args) -> dict:
        args["next"] = self._ref_next
        result = page.evaluate(PAGE_TOOLS, args)
        self._ref_next = max(self._ref_next, int(result.get("next", 0)))
        return result

    def _settle(self, page: Page) -> None:
        try:
            page.wait_for_load_state("domcontentloaded", timeout=3000)
        except PlaywrightError:
            pass
        page.wait_for_timeout(400)

    def _locator(self, page: Page, ref: str):
        if not REF_RE.match(ref or ""):
            raise ToolError(f"Not a valid ref: {ref!r}")
        loc = page.locator(f'[data-agent-ref="{ref}"]')
        if loc.count() == 0:
            raise ToolError(STALE.format(ref=ref))
        return loc.first

    def _xy(self, page: Page, x: int, y: int) -> tuple[float, float]:
        sx, sy = self._scale.get(page, (1.0, 1.0))
        return x / sx, y / sy

    def _point(self, page: Page, target) -> tuple[float, float]:
        """Viewport point (CSS px) for a coordinate or ref target."""
        if target.type == "coordinate":
            return self._xy(page, target.x, target.y)
        loc = self._locator(page, target.ref)
        loc.scroll_into_view_if_needed(timeout=5000)
        box = loc.bounding_box()
        if not box:
            raise ToolError(f"{target.ref} is not visible on the page.")
        return box["x"] + box["width"] / 2, box["y"] + box["height"] / 2

    def describe(self, tab_id: str | None, target) -> str:
        """Short description of what a click would hit. Used by the safety gate."""
        try:
            page = self._page(tab_id)
            if target.type == "ref":
                return self._js(page, mode="describe_ref", ref=target.ref).get("text", "")
            x, y = self._xy(page, target.x, target.y)
            return self._js(page, mode="point", x=x, y=y).get("text", "")
        except Exception:
            return ""

    def focus_in_form(self, tab_id: str | None) -> tuple[bool, str]:
        try:
            r = self._js(self._page(tab_id), mode="focus")
            return bool(r.get("in_form")), r.get("text", "")
        except Exception:
            return False, ""

    def _click(self, input, button: str, count: int) -> str | None:
        page = self._page(input.tab_id)
        mods = [keys.to_playwright(m) for m in keys.parse_modifiers(input.modifiers)]
        x, y = self._point(page, input.target)
        for m in mods:
            page.keyboard.down(m)
        try:
            page.mouse.click(x, y, button=button, click_count=count, delay=30)
        finally:
            for m in reversed(mods):
                page.keyboard.up(m)
        self._settle(page)
        return None

    def _save(self, img: Image.Image, kind: str) -> None:
        if self._run_dir:
            img.save(self._run_dir / f"{time.strftime('%H%M%S')}-{int(time.time()*1000)%1000:03d}-browser-{kind}.png")

    # ---------- members ----------

    def navigate(self, context, input) -> BetaBrowserNavigateResult:
        page = self._page(input.tab_id)
        target = input.url.strip()
        if target in ("back", "forward", "reload"):
            resp = {"back": page.go_back, "forward": page.go_forward, "reload": page.reload}[target](
                wait_until="domcontentloaded", timeout=30000)
        else:
            target = normalize_url(target)  # second check, independent of the gate
            resp = page.goto(target, wait_until="domcontentloaded", timeout=30000)
        self._settle(page)
        return BetaBrowserNavigateResult(url=page.url, status=resp.status if resp else None, title=page.title())

    def screenshot(self, context, input) -> BetaScreenshotResult:
        page = self._page(input.tab_id)
        img = Image.open(io.BytesIO(page.screenshot(type="png", scale="css", timeout=15000)))
        img, sx, sy = imaging.shrink(img)
        self._scale[page] = (sx, sy)
        self._save(img, "screenshot")
        data, media = imaging.encode(img)
        return BetaScreenshotResult(data=data, media_type=media)

    def zoom(self, context, input) -> BetaScreenshotResult:
        page = self._page(input.tab_id)
        if len(input.region) != 4:
            raise ToolError("region must be [x0, y0, x1, y1]")
        x0, y0 = self._xy(page, input.region[0], input.region[1])
        x1, y1 = self._xy(page, input.region[2], input.region[3])
        if x1 <= x0 or y1 <= y0:
            raise ToolError("region must have x1 > x0 and y1 > y0")
        raw = page.screenshot(type="png", scale="device", timeout=15000,
                              clip={"x": x0, "y": y0, "width": x1 - x0, "height": y1 - y0})
        vp = page.viewport_size or page.evaluate("() => ({width: innerWidth, height: innerHeight})")
        box_w, box_h = imaging.fit_size(vp["width"], vp["height"])
        img = imaging.fit_into(Image.open(io.BytesIO(raw)), box_w, box_h)
        self._save(img, "zoom")
        data, media = imaging.encode(img)
        return BetaScreenshotResult(data=data, media_type=media)

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

    def hover(self, context, input):
        page = self._page(input.tab_id)
        page.mouse.move(*self._point(page, input.target), steps=5)
        return None

    def left_click_drag(self, context, input):
        page = self._page(input.tab_id)
        page.mouse.move(*self._xy(page, input.from_.x, input.from_.y))
        page.mouse.down()
        page.mouse.move(*self._xy(page, input.target.x, input.target.y), steps=15)
        page.mouse.up()
        self._settle(page)
        return None

    def left_mouse_down(self, context, input):
        page = self._page(input.tab_id)
        page.mouse.move(*self._xy(page, input.target.x, input.target.y))
        page.mouse.down()
        return None

    def left_mouse_up(self, context, input):
        page = self._page(input.tab_id)
        page.mouse.move(*self._xy(page, input.target.x, input.target.y))
        page.mouse.up()
        return None

    def mouse_move(self, context, input):
        page = self._page(input.tab_id)
        page.mouse.move(*self._xy(page, input.target.x, input.target.y), steps=5)
        return None

    def scroll(self, context, input):
        page = self._page(input.tab_id)
        page.mouse.move(*self._xy(page, input.target.x, input.target.y))
        px = 100 * max(1, min(10, input.scroll_amount or 3))
        dx, dy = {"up": (0, -px), "down": (0, px), "left": (-px, 0), "right": (px, 0)}[input.scroll_direction]
        page.mouse.wheel(dx, dy)
        page.wait_for_timeout(400)
        return None

    def scroll_to(self, context, input):
        page = self._page(input.tab_id)
        self._locator(page, input.target.ref).scroll_into_view_if_needed(timeout=5000)
        return None

    def type(self, context, input):
        page = self._page(input.tab_id)
        page.keyboard.type(input.text, delay=15)
        return None

    def key(self, context, input):
        page = self._page(input.tab_id)
        try:
            combos = keys.parse(input.text)
        except ValueError as e:
            raise ToolError(str(e)) from None
        for _ in range(max(1, min(100, input.repeat or 1))):
            for combo in combos:
                page.keyboard.press("+".join(keys.to_playwright(k) for k in combo))
        self._settle(page)
        return None

    def hold_key(self, context, input):
        page = self._page(input.tab_id)
        try:
            names = [keys.to_playwright(k) for combo in keys.parse(input.text) for k in combo]
        except ValueError as e:
            raise ToolError(str(e)) from None
        for k in names:
            page.keyboard.down(k)
        try:
            page.wait_for_timeout(1000 * max(0.0, min(30.0, input.duration)))
        finally:
            for k in reversed(names):
                page.keyboard.up(k)
        return None

    def wait(self, context, input):
        self._page(input.tab_id).wait_for_timeout(1000 * max(0.0, min(30.0, input.duration)))
        return None

    def form_input(self, context, input):
        page = self._page(input.tab_id)
        loc = self._locator(page, input.target.ref)
        tag, typ = loc.evaluate("e => [e.tagName.toLowerCase(), (e.type || '').toLowerCase()]")
        value = input.value
        if tag == "select":
            try:
                loc.select_option(label=str(value), timeout=5000)
            except PlaywrightError:
                loc.select_option(value=str(value), timeout=5000)
        elif typ in ("checkbox", "radio"):
            checked = value if isinstance(value, bool) else str(value).lower() in ("true", "1", "yes", "on")
            loc.set_checked(checked, timeout=5000)
        else:
            if isinstance(value, float) and value.is_integer():
                value = int(value)
            loc.fill(str(value), timeout=5000)
        return None

    def read_page(self, context, input) -> str:
        page = self._page(input.tab_id)
        if input.ref and not REF_RE.match(input.ref):
            raise ToolError(f"Not a valid ref: {input.ref!r}")
        r = self._js(page, mode="read", filter=input.filter, depth=max(1, input.depth or 15), ref=input.ref)
        if r.get("error") == "stale":
            raise ToolError(STALE.format(ref=input.ref))
        text = r.get("text") or "(nothing matched on this page)"
        if r.get("truncated"):
            text += "\n[Output truncated at 50,000 characters. Use ref or a smaller depth to narrow it.]"
        return text

    def find(self, context, input) -> str:
        page = self._page(input.tab_id)
        lines = [l.strip() for l in self._js(page, mode="read", filter="all", depth=40).get("text", "").splitlines()]
        words = [w for w in re.findall(r"\w+", input.query.lower()) if len(w) > 1]
        scored = []
        for line in lines:
            if "[ref_" not in line:
                continue
            low = line.lower()
            score = sum(1 for w in words if w in low)
            if score:
                scored.append((score, line))
        scored.sort(key=lambda t: -t[0])
        if not scored:
            return f"No elements matched {input.query!r}. Try read_page or a screenshot."
        return "\n".join(line for _, line in scored[:20])

    def get_page_text(self, context, input) -> str:
        r = self._js(self._page(input.tab_id), mode="text")
        return (r.get("text") or "(the page has no visible text)") + (
            "\n[Truncated at 50,000 characters.]" if r.get("truncated") else "")

    def new_tab(self, context, input) -> dict:
        page = self._ctx.new_page()   # the "page" event registers it and reports tab_opened
        self._register(page, announce=True)
        self._activate(page)
        return self._entry(page)

    def list_tabs(self, context, input) -> list[dict]:
        return [self._entry(p) for p in list(self._ids) if not p.is_closed()]

    def switch_tab(self, context, input) -> dict:
        page = self._page(input.tab_id)
        self._activate(page)
        return self._entry(page)

    def close_tab(self, context, input) -> None:
        page = self._page(input.tab_id)
        page.close()
        if self._ids and (self._active is page or self._active.is_closed()):
            self._activate(list(self._ids)[-1])
        return None

    def close(self) -> None:
        try:
            self._pw.stop()  # disconnects; your Chrome window stays open
        finally:
            super().close()
