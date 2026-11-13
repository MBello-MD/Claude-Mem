// Runs inside the page (Playwright page.evaluate). One entry point, several modes.
// Elements Claude may target get a data-agent-ref="ref_N" attribute; N comes from a counter kept on the
// Python side and never repeats, so a ref from an old page can't silently hit a new element.
(args) => {
  const W = window;
  W.__agentRefN = Math.max(W.__agentRefN || 0, args.next || 0);

  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK", "BR"]);
  const INTER_TAGS = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "SUMMARY", "OPTION"]);
  const INTER_ROLES = new Set(["button", "link", "checkbox", "radio", "tab", "menuitem", "menuitemcheckbox",
    "menuitemradio", "switch", "combobox", "textbox", "searchbox", "option", "slider", "spinbutton",
    "treeitem", "listbox"]);
  // Roles whose name already says everything inside them: don't descend.
  const LEAF_ROLES = new Set(["button", "link", "heading", "option", "menuitem", "tab", "checkbox", "radio",
    "textbox", "searchbox", "combobox", "img", "switch", "slider", "spinbutton"]);
  const TAG_ROLE = { A: "link", BUTTON: "button", SELECT: "combobox", TEXTAREA: "textbox", SUMMARY: "button",
    OPTION: "option", NAV: "navigation", MAIN: "main", FORM: "form", DIALOG: "dialog", TABLE: "table",
    IFRAME: "iframe", VIDEO: "video", AUDIO: "audio" };

  const clean = (s, n) => (s || "").replace(/\s+/g, " ").trim().slice(0, n || 120);

  function role(el) {
    const r = el.getAttribute("role");
    if (r) return r;
    const t = el.tagName;
    if (/^H[1-6]$/.test(t)) return "heading";
    if (t === "IMG") return el.getAttribute("alt") ? "img" : "";
    if (t === "INPUT") {
      const ty = (el.type || "text").toLowerCase();
      if (ty === "checkbox" || ty === "radio") return ty;
      if (["button", "submit", "reset", "image"].includes(ty)) return "button";
      if (ty === "range") return "slider";
      if (ty === "number") return "spinbutton";
      if (ty === "search") return "searchbox";
      return "textbox";
    }
    return TAG_ROLE[t] || "";
  }

  function interactive(el) {
    if (INTER_TAGS.has(el.tagName)) {
      if (el.tagName === "A" && !el.hasAttribute("href") && !el.hasAttribute("onclick")) return false;
      if (el.tagName === "INPUT" && el.type === "hidden") return false;
      return true;
    }
    const r = el.getAttribute("role");
    if (r && INTER_ROLES.has(r)) return true;
    if (el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable)) return true;
    if (el.hasAttribute("onclick")) return true;
    const ti = el.getAttribute("tabindex");
    return ti !== null && +ti >= 0;
  }

  function name(el) {
    const aria = el.getAttribute("aria-label");
    if (aria) return clean(aria);
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const t = by.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean)
        .map((e) => e.innerText).join(" ");
      if (clean(t)) return clean(t);
    }
    const t = el.tagName;
    if (t === "IMG") return clean(el.getAttribute("alt"));
    if (t === "INPUT" || t === "TEXTAREA" || t === "SELECT") {
      if (el.labels && el.labels[0]) return clean(el.labels[0].innerText);
      if (["button", "submit", "reset"].includes(el.type)) return clean(el.value);
      return clean(el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("name"));
    }
    const r = role(el);
    if (LEAF_ROLES.has(r) || interactive(el)) return clean(el.innerText || el.getAttribute("title"));
    return clean(el.getAttribute("title"));
  }

  function hidden(el) {
    const s = getComputedStyle(el);
    return s.display === "none" || s.visibility === "hidden" || s.visibility === "collapse";
  }
  function hasBox(el) { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
  function inView(el) {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  }

  function refOf(el) {
    let r = el.getAttribute("data-agent-ref");
    if (!r) { r = "ref_" + (++W.__agentRefN); el.setAttribute("data-agent-ref", r); }
    return r;
  }

  function describe(el) {
    let s = role(el) || el.tagName.toLowerCase();
    if (s === "heading") s += " " + (el.tagName.match(/^H([1-6])$/) || [, ""])[1];
    const n = name(el);
    if (n) s += ' "' + n.replace(/"/g, "'") + '"';
    const t = el.tagName;
    if (t === "INPUT" || t === "TEXTAREA") {
      const ty = (el.type || "text").toLowerCase();
      if (ty === "checkbox" || ty === "radio") s += el.checked ? " (checked)" : " (unchecked)";
      else if (ty === "password") s += " (password field)";
      else if (el.value) s += ' value="' + clean(el.value, 80).replace(/"/g, "'") + '"';
      if (!["text", "checkbox", "radio", "search", "number"].includes(ty) && t === "INPUT") s += " type=" + ty;
    }
    if (t === "SELECT" && el.selectedOptions[0]) s += ' selected="' + clean(el.selectedOptions[0].text, 80) + '"';
    if (t === "A" && el.getAttribute("href")) s += ' href="' + el.getAttribute("href").slice(0, 150) + '"';
    if (el.disabled || el.getAttribute("aria-disabled") === "true") s += " (disabled)";
    if (el.getAttribute("aria-expanded")) s += " expanded=" + el.getAttribute("aria-expanded");
    return s;
  }

  const kids = (el) => (el.shadowRoot ? [...el.shadowRoot.children, ...el.children] : [...el.children]);
  const byRef = (r) => document.querySelector('[data-agent-ref="' + r + '"]');
  const done = (extra) => Object.assign({ next: W.__agentRefN }, extra);

  if (args.mode === "read") {
    const filter = args.filter || "visible";
    const maxDepth = args.depth || 15;
    let root = document.body || document.documentElement;
    if (args.ref) { root = byRef(args.ref); if (!root) return done({ error: "stale" }); }
    const out = [];
    let len = 0, truncated = false;
    const emit = (line) => {
      if (truncated) return;
      if (len + line.length + 1 > 50000) { truncated = true; return; }
      out.push(line); len += line.length + 1;
    };
    const walk = (el, level) => {
      if (truncated || level > maxDepth || SKIP.has(el.tagName)) return;
      if (filter !== "all" && hidden(el)) return;
      const inter = interactive(el);
      const r = role(el);
      let include;
      if (filter === "interactive") include = inter && hasBox(el);
      else if (filter === "all") include = inter || !!r;
      else include = (inter || !!r) && hasBox(el) && inView(el);
      if (include) emit("  ".repeat(level) + describe(el) + " [" + refOf(el) + "]");
      if (include && LEAF_ROLES.has(r)) return;
      if (!include && !inter && filter !== "interactive" && (filter === "all" || inView(el))) {
        for (const n of el.childNodes) {
          if (n.nodeType === 3) {
            const t = clean(n.textContent, 300);
            if (t) emit("  ".repeat(level) + 'text "' + t.replace(/"/g, "'") + '"');
          }
        }
      }
      for (const c of kids(el)) walk(c, include ? level + 1 : level);
    };
    walk(root, 0);
    return done({ text: out.join("\n"), truncated });
  }

  if (args.mode === "text") {
    const main = document.querySelector("main, [role=main], article");
    const src = main && main.innerText.trim().length > 200 ? main : document.body;
    const t = (src ? src.innerText : "").trim();
    return done({ text: t.slice(0, 50000), truncated: t.length > 50000 });
  }

  if (args.mode === "point") {  // what is under a viewport coordinate (used by the safety gate)
    let el = document.elementFromPoint(args.x, args.y);
    if (!el) return done({ text: "" });
    const target = el.closest("a,button,input,select,textarea,summary,[role],[onclick]") || el;
    return done({ text: describe(target) + " " + clean(target.innerText, 80) });
  }

  if (args.mode === "describe_ref") {
    const el = byRef(args.ref);
    return done({ text: el ? describe(el) + " " + clean(el.innerText, 80) : "", stale: !el });
  }

  if (args.mode === "focus") {
    const el = document.activeElement;
    if (!el || el === document.body) return done({ text: "", in_form: false });
    return done({ text: describe(el), in_form: !!(el.form || el.closest("form")) });
  }

  return done({ error: "unknown mode" });
}
