---
name: focus-plan
description: Help the owner plan their focus areas from the evidence in My Work. Proposes, as suggestions only, a priority order with reasons, sharper goal sentences, a first draft of notes, and next asks. Use when asked to "help me plan my focus areas", "what should I work on next", "prioritize my focus areas", "sharpen my goals", or when My Work's planning help starts a plan.
---

# Focus Plan

The owner steers their agents through a small number of focus areas. Each area has a name, a one-sentence goal, the owner's own notes on why it matters, and a place in the owner's order. Under each area sit the requests the owner has made, each with its state and its last review.

This skill reads all of that and proposes a plan. **Everything it produces is a suggestion.** Nothing is applied. The owner reads each proposal in My Work and accepts or ignores it, and an accepted proposal is saved by the owner's own action (reorder, edit the goal, edit the notes).

## 1. Read the plan input

When the worker starts this skill it gives the plan input inline:

- `scope`: `all` (every focus area) or `one` (a single area).
- `areas`: each with `focusAreaId`, `name`, `goal`, `notes`, `status` (`kept` or `suggested`), `position` (1 is the owner's top priority), and `requests`. Each request has its `title`, `state`, `percent`, `summary`, `nextStep`, `question` (what its agent is waiting to be told) and `asks`: the owner's own words, verbatim.
- `currentOrder`: the ids of the kept areas in the owner's current order. Empty when `scope` is `one`.

Run by hand, read the same facts from My Work's focus areas and the request-progress reviews before proposing anything.

## 2. Propose

Propose only where you have something better than what is there. An empty list is a good answer for an area that is already clear and moving.

**Priority order** (`reorder`, only when `scope` is `all`, at most one). List every id in `currentOrder` once, in the order you propose. For each area you move, give one line of reasoning from the evidence: what is blocked on the owner, what is close to shipping, what has stalled, what the owner keeps asking for. Do not propose the order the owner already has.

**A sharper goal** (`goal`). Only where the current goal is vague, missing, or no longer matches what the owner asks for in that area. One sentence, at most 300 characters, that says what done looks like. Give the reason in one line.

**A first draft of notes** (`notes`). Only for an area whose `notes` is null. Never draft over the owner's notes. Write why the area matters and what the owner seems to want from it, from the evidence: at most 2000 characters. It is shown as a draft from evidence, so it must quote the owner: put one to four of the owner's asks in `quotes`, word for word, exactly as they appear in that area's `asks`. A quote the owner did not type refuses the draft.

**Next asks** (`next-asks`). Up to three per area: the next thing the owner could ask an agent to do, written as the ask itself, each with one line saying why now. Prefer what unblocks a waiting request or finishes one that is nearly done.

Never invent a request, a state or a quote. Reasons name what the input shows.

**Language.** Write every proposal in the human language most of the owner's asks are written in. Quotes stay as typed.

## 3. Output

Reply with only this JSON:

```json
{
  "proposals": [
    { "kind": "reorder", "focusAreaIds": ["fa_b", "fa_a"], "moves": [{ "focusAreaId": "fa_b", "reason": "Two requests wait on your answer." }] },
    { "kind": "goal", "focusAreaId": "fa_a", "goal": "Every agent chat can be answered from My Work.", "reason": "The current goal names the page, not the outcome." },
    { "kind": "notes", "focusAreaId": "fa_b", "notes": "Why it matters: …", "quotes": ["answer an agent's question and have it reach the agent"] },
    { "kind": "next-asks", "focusAreaId": "fa_a", "asks": [{ "text": "Wire the answer box to the new route.", "reason": "The route shipped; the row still copies." }] }
  ]
}
```

The worker checks each proposal against the input, saves the ones that pass as the plan (`planning`, then `ready` or `failed`), and names the ones it left out. One plan is one run: if it fails, the failure is shown and nothing tries again until the owner asks.
