# Orca UI Style Guide

UI rules for Orca. Token values live in `src/renderer/src/assets/main.css` (canonical); this file documents _roles and rules_, not values.

The identity is **monochrome and quiet**: neutral grays carry the chrome, color is reserved for state (selection ring, destructive, git decorations). Orca mostly hosts other tools (Monaco, xterm, Markdown previews), so its own UI should recede and frame. When in doubt:

Orca is an Electron desktop app for orchestrating coding agents across git worktrees. Orca's chrome is **monochrome and quiet** — neutral grays carry it, color is reserved for state (selection ring, destructive, git decorations). The native chat transcript is a documented exception, where color is load-bearing rather than decorative — see [Tool activity colors](#tool-activity-colors). The product spends most of its time hosting other people's tools (Monaco, xterm, Markdown previews), so Orca's own UI should recede and frame.

When in doubt:

- Reach for **muted/accent/border** before reaching for color.
- Reach for **CSS variables** before hardcoding hex.
- Match the nearest **shadcn primitive** before writing custom CSS.

## Deep dives

Read only when the task touches the topic:

- [`styleguide/color.md`](./styleguide/color.md): full role table, git decorations, list-row states. Read when picking a surface/foreground pair or styling rows.
- [`styleguide/components.md`](./styleguide/components.md): button, primitive-picker, tooltip, icon, shortcut-chip, form, and scrollbar specs. Read when touching one.
- [`styleguide/native-chat.md`](./styleguide/native-chat.md): chat type scale and colours. Read before any change under `components/native-chat/`.
- [`styleguide/ux-rules.md`](./styleguide/ux-rules.md): rationale for the UX rules below. Read when a rule's application is unclear.
- [`styleguide/ux-review-rubric.md`](./styleguide/ux-review-rubric.md): screen review rubric. Read when reviewing or polishing a screen, screenshot, or prototype.

## Tokens

Role tokens come in pairs: a **surface** and a **foreground** that meets contrast on it. Always use them together — this governs the surface/foreground pairs below.

**Categorical tokens are the exception.** `--git-graph-lane-1` through `-5` and the `--tool-*` family (see [Tool activity colors](#tool-activity-colors)) are standalone hues, not surface/foreground pairs. A categorical token has no paired foreground, so it must clear a measured contrast floor against every surface it's drawn on instead.

| Role                                                      | Use it for                                                  | Don't use it for                                    |
| --------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------- |
| `background` / `foreground`                               | App canvas, default text                                    | Cards, popovers, sidebar (have their own)           |
| `card` / `card-foreground`                                | Panels lifted off the canvas                                | The canvas itself                                   |
| `popover` / `popover-foreground`                          | Floating menus, dropdowns, hovercards                       | Inline UI                                           |
| `primary` / `primary-foreground`                          | The single affirmative action in a flow (Save, Confirm)     | Decorative accents; hover states; secondary actions |
| `secondary` / `secondary-foreground`                      | Lower-emphasis actions next to a primary                    | The affirmative action                              |
| `muted` / `muted-foreground`                              | De-emphasized text, captions, placeholders, disabled chrome | Body copy; primary actions                          |
| `accent` / `accent-foreground`                            | Hover/active backgrounds for ghost buttons and list rows    | Solid filled buttons (use `secondary` instead)      |
| `destructive` / `destructive-foreground`                  | Delete, discard, irreversible-action buttons; error states  | Cancel buttons (Cancel is not destructive)          |
| `status-warning-background` / `status-warning-foreground` | Attention, parked work, unverifiable host contact           | Confirmed failures; proof that remote work exited   |
| `border`                                                  | All hairlines: dividers, input outlines, card edges         | Heavy emphasis; that's `ring`                       |
| `input`                                                   | Form field background only                                  | Anywhere outside form fields                        |
| `ring`                                                    | Focus-visible outlines, active selection halos              | Persistent decoration                               |
| `sidebar` (+ variants)                                    | The worktree sidebar and its children                       | Other panels                                        |
| `editor-surface`                                          | Background of Monaco / markdown editor panes                | App chrome                                          |

Tokens pair a **surface** with a **foreground** that meets contrast on it; always use them together. Role summary (full table in [color.md](./styleguide/color.md)):

The warning family also provides `--status-warning` for compact marks and `--status-warning-border` for outlines. Pair warning surfaces with their foreground token and explicit status text; lost contact never implies that remote work exited.

### Git decoration colors

For diff status, file-tree decorations, and the changes view, use the git decoration tokens (mirroring VS Code's palette so users transferring from VS Code aren't surprised):

| Token                        | State          |
| ---------------------------- | -------------- |
| `--git-decoration-added`     | Added / new    |
| `--git-decoration-modified`  | Modified       |
| `--git-decoration-deleted`   | Deleted        |
| `--git-decoration-renamed`   | Renamed        |
| `--git-decoration-untracked` | Untracked      |
| `--git-decoration-copied`    | Copied         |
| `--git-decoration-ignored`   | Ignored by git |

Use these _only_ for git status. Don't reuse them for unrelated state colors — that breaks the convention.

### Tool activity colors

The native chat transcript colors tool lines on one axis: five hues answer _what kind of work is this?_ Each category also carries a lucide glyph, so hue is never the sole encoder. Contrast is measured against the app canvas (`#ffffff` light, `#0a0a0a` dark):

| Token           | Light     | on canvas | Dark      | on canvas | Meaning              | Example tools          |
| --------------- | --------- | --------- | --------- | --------- | -------------------- | ---------------------- |
| `--tool-read`   | `#2f6a96` | 5.80:1    | `#8ab4d8` | 9.05:1    | Reading a file       | Read, NotebookRead     |
| `--tool-write`  | `#8a6100` | 5.54:1    | `#e3b341` | 10.17:1   | Modifying your files | Edit, MultiEdit, Write |
| `--tool-exec`   | `#24707a` | 5.72:1    | `#79bfc4` | 9.49:1    | Running a command    | Bash, terminal, shell  |
| `--tool-search` | `#4f4fc4` | 6.47:1    | `#9a9ae6` | 7.67:1    | Locating something   | Grep, Glob             |
| `--tool-net`    | `#6a4fb0` | 6.25:1    | `#b39ddb` | 8.26:1    | Reaching the network | WebFetch, WebSearch    |

`--tool-write` is the only warm hue, and that's deliberate: amber means the agent touched your files. The four cool hues recede into chrome; the one warm hue is the thing worth noticing. An unrecognized tool name takes no category and renders exactly as it does today — neutral, no glyph. Orca hosts agents whose tool vocabularies it doesn't control, so a classifier that guessed would mislabel third-party tools with confident color.

Any tool hue must clear a contrast floor:

- **4.5:1 minimum** against the canvas for **text** drawn in a tool hue, in both themes.
- **3:1 minimum** for **non-text** marks (the category dot on a collapsed tool run) against both `--background` and `--muted` — a dot can land on either.
- **Hue is never the sole encoder.** Every colored role also carries a glyph, position, or weight difference, so desaturating the transcript — or viewing it with red-green color vision deficiency — loses no information.

Use these _only_ for tool activity. Don't reuse them for unrelated state colors, and don't reach for `--git-decoration-*` to color a tool category — that breaks the convention in either direction.

The second axis is content type: `--code-accent` / `--code-accent-surface` mark inline code and file paths in prose, kept deliberately off the tool hues so a path in a sentence can't be misread as a tool category.

### List rows: hover, selected, current

A common point of drift. Use these conventions for any list-style row (worktrees, command palette items, settings nav):

- **Idle:** transparent background.
- **Hover:** `bg-accent` (in the worktree sidebar, `bg-sidebar-accent`).
- **Keyboard-selected (cmdk highlight):** do **not** rely on flat `bg-accent` alone on light popover/dialog surfaces — `--accent` (#f5f5f5) is nearly identical to `--background` (#fff), so the cursor vanishes. Use the jump-palette recipe in `main.css` (`.jump-palette-item[data-selected='true']`): `color-mix` foreground into background (~12%) plus an inset ring. Expose the mix as `--jump-palette-selection-surface` when nested cutouts (status pips) must match. The `data-selected` attribute is set by `cmdk` automatically.
- **Persistent "current" / "active" row** (e.g. the worktree the user is viewing): also `bg-accent`, _plus_ a `data-current="true"` attribute so CSS or future styling can distinguish it from the cmdk highlight.
- **Don't:** hardcode `bg-[#ededed]` / `bg-[#333333]` or invent a "selected" color. Mix from existing tokens (`foreground`/`background`/`accent`) so light/dark stay aligned.

### Color mixing

When you need a tint (e.g. a 12% primary wash on hover), use `color-mix` against the existing token, not a new hex:

```css
background: color-mix(in srgb, var(--primary) 12%, var(--background));
```

This keeps light/dark parity automatic.

## Typography

- Sans is `Geist`, never `Inter` or system sans. Mono is `var(--font-mono)` for paths, code, terminal-adjacent UI, and anything literal.
- Body letter-spacing is set globally on `body`; don't override per component.
- Use Tailwind's scale. Common: 14px body/default buttons, 13px sidebar items and dense rows, 12px sub-text and paths, 11px uppercase meta/captions.
- Use `text-2xs` (11px) and `text-3xs` (10px), not `text-[11px]` / `text-[10px]`.
- Category labels: 11px, `font-semibold`, `uppercase`, `tracking-wider` (0.05em).
- Native chat has its own lint-enforced scale and colours: see [native-chat.md](./styleguide/native-chat.md).

## Radius and elevation

- Radii derive from `--radius` in `main.css`. Buttons and inputs use `rounded-md`, `Card` uses `rounded-xl`, badges use `rounded-full`. Match the existing primitive's radius; don't introduce a new one.
- Three elevation levels, no fourth: (1) `border` hairline, the default for almost everything; (2) `shadow-xs` + single-token border for outline buttons and embedded cards; (3) `shadow-floating`, reserved for popovers and popups that escape the editor surface. Needing more than floating usually means you want the focus `ring`.

## Components

- Use the primitives in `src/renderer/src/components/ui/` before anything custom. Never reimplement headless behavior; extend the existing wrapper. Keep `data-slot` on roots, merge with `cn()` passing caller `className` last, and use CVA for multiple variants ([conventions](./styleguide/components.md#primitive-conventions)).
- **Buttons:** `default` = the single affirmative action; `secondary` next to it; `outline` for toolbar/standalone; `ghost` for icon buttons and row triggers; `link` inline in prose; `destructive` never for Cancel. Match the size to the row height.
- **Picking a primitive:** `Tooltip` (icon labels), `HoverCard` (rich preview), `DropdownMenu` (click menu), `ContextMenu` (right-click), `Popover` (click-revealed form/picker), `Dialog` (blocking decision only), `Sheet` (edge panel), `Select` (known list), `Command` in `Popover` (search), `repo-multi-combobox` pattern (searchable multi-select), `sonner` (transient confirmation), inline text + `Badge` (persistent status). Don't style one primitive to act like another ([table](./styleguide/components.md#picking-the-right-primitive)).
- Every dialog asking the user to trust, approve, run, or remove code (including plugin provenance/approval) uses `DialogContent surface="security"` so plugin themes can't restyle it; add `scrollable` when the whole dialog scrolls. Trust decisions outside a dialog (agent approval card, certificate override) go in `SecuritySurface`.
- Above a modal, only toast close buttons remain clickable. Dismissing a toast must leave the modal open, with focus and unsaved input intact.
- **Tooltips** only name controls: never for visibly labeled controls, interactive content, or critical messages (those go inline). Use the app-root `TooltipProvider`, `<TooltipTrigger asChild>`, and `side="top" sideOffset={4}` by default ([spec](./styleguide/components.md#tooltips)).
- **Icons:** `lucide-react` only, default `size-4`, default stroke, color inherited from text. Loading is `<Loader2 className="size-4 animate-spin" />` ([spec](./styleguide/components.md#icons)).
- **Shortcut chips:** always `<ShortcutKeyCombo />` (or `<DropdownMenuShortcut>` in menus), never a one-off `<kbd>` or keys baked into label strings. The label MUST match the platform's actual binding. Never on Cancel, Dismiss, or `link` actions ([spec](./styleguide/components.md#keyboard-shortcut-chips)).
- **Forms:** follow `settings/SettingsFormControls.tsx`; errors via `aria-invalid`, never a hand-painted ring ([spec](./styleguide/components.md#form-anatomy)).
- **Scrollbars:** use `.scrollbar-sleek`, `.scrollbar-editor`, or `.worktree-sidebar-scrollbar` (sidebar only); don't write a fourth ([spec](./styleguide/components.md#scrollbars)).

## UX rules

These apply to every UI change. Rationale: [ux-rules.md](./styleguide/ux-rules.md). Reviewing a screen: [ux-review-rubric.md](./styleguide/ux-review-rubric.md).

- **UI copy must not overclaim.** Never imply the app took an action, made a decision, or observed a fact without real state or result data. Use neutral process language while pending; reserve result verbs ("skipped", "protected", "found", "verified", "deleted") for actual results. Copy is typo-free, concise, specific, and free of filler ("please", "simply", "just").
- **Match in-flight feedback to duration:** 0–100 ms none; 100 ms–1 s disabled only; 1–3 s disabled + spinner or label swap; 3 s+ or multi-step stage labels/progress. Pre-reserve space for label/icon swaps (`width`, not `min-width`). Bind disabled immediately; defer visible loading ~200 ms so local stays clean and SSH gets feedback.
- **Match siblings:** adjacent components in the same flow share icons, shortcut conventions, and submit semantics. Diverge only for a real role difference, or fix both. With no sibling, match the surrounding chrome.
- **Keep the back-out path quiet:** Cancel, Dismiss, Close, and Discard are not destructive: ghost, no color, no shortcut chip, no animated affordance. Esc still works.
- Primary action obvious; common workflows in 1–2 actions; default focus on the likely field or primary action; Enter submits it, Esc backs out.
- Respect reduced motion per element: `motion-reduce:` for movement, still-but-working states for spinners (`LoadingSpinner`), and `motionSafeScrollBehavior()` for scripted scrolls.
- Missing data shows a direct action to acquire it. Toasts for transient results; inline persistent errors when the user must read, retry, copy, or act.

## Cross-platform

Every UI change must hold up on macOS, Linux, and Windows, in light and dark mode.

- Never hardcode `e.metaKey`: choose `metaKey` on Mac and `ctrlKey` elsewhere via `navigator.userAgent.includes('Mac')`. Menu accelerators use `CmdOrCtrl`.
- Labels show `⌘` / `⇧` on Mac and `Ctrl+` / `Shift+` elsewhere, matching the actual binding.
- On Mac, keep hit targets out of the traffic-light gutter (`titlebar-traffic-light-pad`).
- Loading, focus, and animation must hold up under 50–200 ms of SSH latency; verify under simulated latency or real SSH, not local only.

## When this guide is silent

If you have a UI question this doc doesn't answer:

1. Look at adjacent code in `src/renderer/src/components/` for the closest sibling, and follow its lead.
2. Check `src/renderer/src/components/ui/` for a primitive that already encodes the pattern.
3. If it's a token question, `main.css` is canonical — use what's there, or add a new one in both light and dark.
4. If none of those resolve it, ask the user before inventing.
