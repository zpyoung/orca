# Session panel layout

Six sections have to fit a **~250px** column (Orca's right sidebar minimum is 220px).
Locked already: context fill % is pinned at the top · read-only plus safe navigation ·
unsupported sections are omitted, not greyed out.

The question: **how do the six sections get organised so the column stays scannable?**

Sections to place — Identity · Usage · Live activity · Context · Files touched · Hooks & MCP

---

## Option A — Accordion, first section open

```
┌────────────────────────────┐
│ ▓▓▓▓▓▓▓▓▓▓▓░░░░░  68%      │ ← pinned, always visible
│ context · opus-5           │
├────────────────────────────┤
│ ▾ Live activity            │
│    ● running               │
│    Bash · 2.1s             │
│    2 subagents             │
├────────────────────────────┤
│ ▸ Usage                    │
│ ▸ Identity                 │
│ ▸ Context                  │
│ ▸ Files touched            │
│ ▸ Hooks & MCP              │
└────────────────────────────┘
```

Everything is reachable without scrolling; you open what you need.
Collapsed state is remembered per section.

---

## Option B — Flat scroll, sticky sub-headers

```
┌────────────────────────────┐
│ ▓▓▓▓▓▓▓▓▓▓▓░░░░░  68%      │ ← pinned
│ context · opus-5           │
├────────────────────────────┤
│ LIVE ACTIVITY              │ ← sticks while scrolling
│  ● running                 │
│  Bash · 2.1s               │
│  2 subagents               │
│                            │
│ USAGE                      │
│  in      12.4k             │
│  out      3.1k             │
│  cache r 891k              │
│  turns      47             │
│                            │
│ IDENTITY                   │
│  session  0be0581d…    ⧉   │
│  branch   zpyoung/sess…    │
│ ⋮ (scrolls)                │
└────────────────────────────┘
```

No clicks, no hidden state — you scroll one continuous column.
Long, but nothing is ever a click away.

---

## Option C — Two sub-tabs

```
┌────────────────────────────┐
│ ▓▓▓▓▓▓▓▓▓▓▓░░░░░  68%      │ ← pinned
│ context · opus-5           │
├────────────────────────────┤
│ [ Now ]  Session           │ ← sub-tabs
├────────────────────────────┤
│ ● running                  │
│ Bash · 2.1s                │
│ 2 subagents                │
│                            │
│ in 12.4k · out 3.1k        │
│ cache r 891k · 47 turns    │
│                            │
│ hooks ✓ · mcp 3            │
└────────────────────────────┘

  "Session" tab holds:
  Identity · Context · Files touched
```

Splits live-and-changing from stable-and-referential.
Each tab is short enough to need no scrolling at all.

---

<agent-option-set>
  <agent-choice id="accordion" title="A — Accordion">All six collapsible, first open. Everything reachable without scrolling; costs a click to see any given section.</agent-choice>
  <agent-choice id="flat" title="B — Flat scroll">One continuous column with sticky headers. Zero interaction, but the column gets long and the bottom sections are rarely seen.</agent-choice>
  <agent-choice id="subtabs" title="C — Two sub-tabs">Now / Session split. Each view fits without scrolling; adds a second navigation layer inside a panel that already lives behind a tab.</agent-choice>
</agent-option-set>

<agent-proceed></agent-proceed>
