# tui-prompt-focus — top-anchored, explicitly-focused permission/question prompts

> STATUS: IN FLIGHT — fork of `anomalyco/opencode`, base tag `v1.18.32`
> (matches the installed brew binary). Branch `feat/tui-prompt-focus`.

## Goal (owner-approved)
1. Move the built-in `PermissionPrompt` and `QuestionPrompt` from the bottom of
   the session view (they currently squeeze/shift the conversation block) to the
   TOP, rendered above the message scrollbox. The conversation stays
   bottom-anchored; no reflow.
2. The popups must not grab the keyboard when they appear. While a
   permission/question is pending the input stays visible and typable
   (Enter queues the draft). A new configurable key focuses the popup:
   - new keybinds `permission.prompt.focus` / `question.prompt.focus`,
     default `ctrl+shift+p`, overridable in `tui.json`.
   - All popup keys (arrows/h/l, enter, escape, `ctrl+f` fullscreen,
     `ctrl+c`->reject) only work while focused. Escape keeps today's
     reject/dismiss semantics once focused. Pressing the focus key again
     unfocuses back to the input.
   - While unfocused the popup shows a "press <key> to answer" hint.
3. Extend the host dialog stack with a non-autofocus option
   (`dialog.replace(render, onClose, { autoFocus: false })`) and use it for the
   event-driven dialogs of the LLM permission parser (bash/webfetch/task/
   external_directory) so those do not steal focus either.
   The option alone is NOT enough: `DialogSelect`/`DialogPrompt` self-focus
   their filter/textarea and register un-gated keys, so the host now also skips
   that self-focus and gates their keybindings behind the dialog focus state,
   with a new `dialog.focus` keybind (default `ctrl+shift+p`) to enter/leave a
   non-autofocus dialog. The prompt blur effect keys off `dialog.focused`.
   NOTE: the parser plugin lives in `opencode-config` (separate branch); its
   side is still just `api.ui.dialog.replace(render, onClose, { autoFocus: false })`
   (+ local type cast against the pinned `@opencode-ai/plugin`). Coordinate at
   ship; do not edit that repo from here.

## Code map (packages/tui/src)
- `routes/session/index.tsx` — move the permission/question <Show> blocks above
  the scrollbox; `visible`/`disabled` memos: pending must not hide/disable the
  prompt (keep `!session()?.parentID`). Register the focus keybind(s).
- `routes/session/permission.tsx` — `focused` signal (default false); gate the
  interactive bindings/commands behind it; focus binding + hint; blur the
  session prompt on focus and refocus on unfocus/resolve/unmount.
- `routes/session/question.tsx` — push `QUESTION_MODE` only while focused
  (currently pushed onMount); same hint/gating.
- `config/keybind.ts` — add the two definitions (default `ctrl+shift+p`).
- `ui/dialog.tsx` (+ `plugin/adapters.tsx`, `packages/plugin/src/tui.ts`) —
  non-autofocus dialogs + a `focused` state and `dialog.focus` toggle;
  `ui/dialog-select.tsx` / `ui/dialog-prompt.tsx` skip self-focus and gate keys
  on that state; `component/prompt/index.tsx` blur effect keys off dialog focus
  (line ~636-645), not `dialog.stack.length > 0` alone.

## Verify
- `bun test` (packages/tui) + `tsgo --noEmit`; add regression tests
  (`packages/tui/test`, `testRender` harness): Enter while unfocused does NOT
  reply; focus key + Enter replies; question prompt equivalent.
- Manual: `bun run dev` from the repo root — edit permission (built-in),
  bash (parser dialog), question flow; check top position, no text shift,
  typing/queueing, focus key, `ctrl+f` fullscreen, palette unaffected.

## Build & install (ship time — NOT from this worktree)
- `bun run --cwd packages/cli build --single` ->
  `packages/cli/dist/cli-darwin-arm64/bin/lildax`
- install as `~/.local/bin/opencode` (shadows brew; rollback = delete the file).
- Re-base/rebuild after `brew upgrade opencode`.
