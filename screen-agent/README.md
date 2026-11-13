# screen-agent

Claude operates a dedicated Chrome window on your Windows PC and, when a task needs it, the desktop.

- **Chrome** is driven through the browser toolset (`browser_toolset_20260801`): Claude reads the page
  structure, clicks elements by reference, fills forms, and manages tabs. This is the reliable path, and the
  one Claude is told to prefer.
- **The desktop** is driven through the computer toolset (`computer_toolset_20260801`): screenshots of
  the primary monitor plus mouse and keyboard. It handles what a web page can't: Windows dialogs, file
  pickers, other apps.

Model: `claude-opus-5-5`, effort `medium` by default.

## Files

| File | What it does |
|---|---|
| `agent.py` | Entry point and agent loop (the SDK's tool runner), console chat, logging |
| `browser.py` | Chrome driver: Playwright connected to your Chrome over the DevTools port |
| `page_tools.js` | Runs inside the page: builds the element tree with `ref_N` ids, page text, hit-testing |
| `desktop.py` | Windows driver: `mss` screenshots, `pyautogui` mouse and keys, `SendInput` for accented text |
| `safety.py` | Approval prompts and URL rules |
| `keys.py`, `imaging.py` | Key-name translation; screenshot sizing and the limits the API enforces |
| `launch_chrome.ps1` | Starts the agent's own Chrome, with a separate profile |

## Setup (once)

1. Python 3.11 or newer from python.org (tick "Add python.exe to PATH").
2. In a terminal in this folder:
   ```bash
   python -m venv .venv
   ```
   ```bash
   .venv\Scripts\activate
   ```
   ```bash
   pip install -r requirements.txt
   ```
   You don't need `playwright install`: the agent drives your installed Chrome, not a bundled browser.
3. An API key from console.anthropic.com, saved for your user:
   ```bash
   setx ANTHROPIC_API_KEY "sk-ant-..."
   ```
   Open a new terminal afterwards so it picks up the key.

## Every session

```bash
powershell -ExecutionPolicy Bypass -File .\launch_chrome.ps1
```
```bash
python agent.py "Find the opening hours of the Museu do Ipiranga this Saturday"
```

A second Chrome window opens with an empty profile. That is the agent's Chrome; your normal Chrome is
untouched. If a site needs a login, Claude stops and asks. You sign in yourself in that window, then type
`continue` in the console. Logins you make there stay in that profile, so sign in only to accounts you're
comfortable letting the agent use.

After each answer you can type a follow-up in the console, or press Enter to quit.

### Options

| Flag | Default | Meaning |
|---|---|---|
| `--approve risky\|all\|none` | `risky` | When to ask before acting (below) |
| `--allow-domain example.com` | any site | Sites Claude may open without asking; repeat the flag for more |
| `--no-desktop` | desktop on | Chrome only. A good way to start |
| `--effort low…max` | `medium` | Deeper thinking costs more tokens; `high` for hard multistep tasks |
| `--max-steps N` | 80 | Model turns per task before it pauses for you |

## Safety

- **Stop at any time:** Ctrl+C in the console, or move the mouse into the top-left corner of the screen.
- **Approvals (`risky` mode):**
  - Browser: asks before clicking anything labelled like buy, pay, send, delete, confirm or accept, in
    English or Portuguese (comprar, pagar, enviar, excluir, confirmar, aceito…).
  - Browser: asks before pressing Enter inside a form, and before opening a site outside `--allow-domain`
    when you set one.
  - Desktop: asks before every click, keystroke and typed text, and names the window it would act on.
  - Answers: `y` run, `n` refuse (Claude is told), `a` stop asking for this task, `q` stop the agent.
- Claude is also instructed to stop and ask before consequential steps, never to type passwords or card
  numbers, and to treat page content as data, not instructions. The keyword list is a second line of
  defence, not a guarantee. Watch the first runs closely.
- `javascript_exec`, `file_upload`, `read_console` and `read_network` are disabled. Only `http` and
  `https` URLs are allowed.
- Every screenshot and action is saved under `runs/<date-time>/` for review.

## What was tested, and what wasn't

Tested on Linux against a real Chromium, using a local test page:
- Every browser action Claude uses: refs, form filling with accented text, the approval prompts,
  dismissing alerts, new-tab detection, stale refs, URL scheme checks, screenshots and zoom.
- The agent loop, against a mocked API: request shape, `toolset_name` on results, halting a batch after
  the first failure, and passing reasoning blocks back on follow-ups.
- The Windows driver, with stand-ins for the Windows APIs: coordinate scaling, key mapping, Unicode typing
  and approvals.

**Not yet run on a real Windows machine or against the live API.** Your first runs are the real test.
Start with `--no-desktop`, then try the desktop on something harmless such as Notepad.

## Troubleshooting

- **"Could not reach Chrome at http://127.0.0.1:9222":** run `launch_chrome.ps1`. If it still fails, close
  every window of the agent Chrome and run the script again.
- **Clicks land in the wrong place on the desktop:** make sure only the primary monitor is used. Setting
  Windows display scaling to 100% removes one variable.
- **Nothing happens in an admin window:** Windows blocks input from a normal process into elevated
  windows. Don't run the agent as admin to get around this; leave those windows to yourself.
- **Costs:** screenshots are most of the input tokens. Old ones are cleared server-side and the
  conversation is cached. `runs/<date-time>/log.jsonl` records input, output and cache-read tokens for every
  step, so you can see the real cost of your tasks (Opus 5.5: $4 / $20 per million input / output tokens).
  `--no-desktop` and prompts that point Claude at `read_page` instead of screenshots keep it lower.
