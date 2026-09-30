/** @jsxImportSource @opentui/solid */
import { TextareaRenderable } from "@opentui/core"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup } from "solid-js"
import { tmpdir } from "../../fixture/fixture"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"
import type { DialogContext } from "../../../src/ui/dialog"

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

async function mount(root: string) {
  const state = path.join(root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  const [
    { DialogProvider, useDialog },
    { DialogSelect: DialogSelectComp },
    { KVProvider },
    { ThemeProvider },
    { TuiConfigProvider },
    { ToastProvider },
    { OpencodeKeymapProvider, registerOpencodeKeymap },
  ] = await Promise.all([
    import("../../../src/ui/dialog"),
    import("../../../src/ui/dialog-select"),
    import("../../../src/context/kv"),
    import("../../../src/context/theme"),
    import("../../../src/config"),
    import("../../../src/ui/toast"),
    import("../../../src/keymap"),
  ])

  let dialog!: DialogContext
  let editor!: TextareaRenderable

  function Capture() {
    dialog = useDialog()
    return <box />
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig({ keybinds: {}, leader_timeout: 1000 })
    const off = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(off)
    return (
      <TestTuiContexts directory={root} paths={{ home: root, state, worktree: root }}>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={config}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <ToastProvider>
                  <DialogProvider>
                    <Capture />
                    <textarea
                      ref={(value: TextareaRenderable) => {
                        editor = value
                      }}
                      initialValue="draft"
                    />
                  </DialogProvider>
                </ToastProvider>
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { kittyKeyboard: true })
  return { app, dialog: () => dialog, editor: () => editor, DialogSelect: DialogSelectComp }
}

test("non-autofocus dialog does not capture keys until focused", async () => {
  await using tmp = await tmpdir()
  const picked: string[] = []
  const h = await mount(tmp.path)
  try {
    await wait(() => !!h.editor() && !!h.dialog())
    const editor = h.editor()
    const dialog = h.dialog()
    editor.focus()
    dialog.replace(
      () => (
        <h.DialogSelect
          title="Probe"
          options={[{ title: "A", value: "a", onSelect: () => picked.push("a") }] as never}
        />
      ),
      undefined,
      { autoFocus: false },
    )

    await wait(() => h.app.renderer.currentFocusedEditor === editor)
    expect(h.app.renderer.currentFocusedEditor).toBe(editor)
    expect(dialog.focused).toBe(false)

    // Unfocused: Enter belongs to the session input, not the dialog.
    h.app.mockInput.pressEnter()
    await Bun.sleep(30)
    expect(picked).toEqual([])

    // Focus key hands the keyboard to the dialog.
    h.app.mockInput.pressKey("p", { ctrl: true, shift: true })
    await wait(() => dialog.focused)
    expect(dialog.focused).toBe(true)
    await wait(() => h.app.renderer.currentFocusedEditor !== editor)

    h.app.mockInput.pressEnter()
    await wait(() => picked.length > 0)
    expect(picked).toEqual(["a"])

    // Focus key again returns the keyboard to the input.
    h.app.mockInput.pressKey("p", { ctrl: true, shift: true })
    await wait(() => !dialog.focused)
    await wait(() => h.app.renderer.currentFocusedEditor === editor)
    expect(h.app.renderer.currentFocusedEditor).toBe(editor)
  } finally {
    h.app.renderer.destroy()
  }
})
