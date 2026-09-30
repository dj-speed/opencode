import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import { batch, createContext, createEffect, onCleanup, Show, useContext, type JSX, type ParentProps } from "solid-js"
import { useTheme } from "../context/theme"
import { MouseButton, Renderable, RGBA } from "@opentui/core"
import { createStore } from "solid-js/store"
import { useToast } from "./toast"
import { Flag } from "@opencode-ai/core/flag/flag"
import { useBindings, useOpencodeModeStack } from "../keymap"
import { useClipboard } from "../context/clipboard"
import { useTuiConfig } from "../config"

export function Dialog(
  props: ParentProps<{
    size?: "medium" | "large" | "xlarge"
    onClose: () => void
  }>,
) {
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()
  const renderer = useRenderer()

  let dismiss = false
  const width = () => {
    if (props.size === "xlarge") return 116
    if (props.size === "large") return 88
    return 60
  }

  return (
    <box
      onMouseDown={() => {
        dismiss = !!renderer.getSelection()
      }}
      onMouseUp={() => {
        if (dismiss) {
          dismiss = false
          return
        }
        props.onClose?.()
      }}
      width={dimensions().width}
      height={dimensions().height}
      alignItems="center"
      position="absolute"
      zIndex={3000}
      paddingTop={dimensions().height / 4}
      left={0}
      top={0}
      backgroundColor={RGBA.fromInts(0, 0, 0, 150)}
    >
      <box
        onMouseUp={(e: { stopPropagation(): void }) => {
          // A selection release must bubble up to the copy-on-select handler in
          // DialogProvider; the backdrop's dismiss flag keeps it from closing the dialog.
          if (renderer.getSelection()?.getSelectedText()) return
          dismiss = false
          e.stopPropagation()
        }}
        width={width()}
        maxWidth={dimensions().width - 2}
        backgroundColor={theme.backgroundPanel}
        paddingTop={1}
      >
        {props.children}
      </box>
    </box>
  )
}

function init() {
  const [store, setStore] = createStore({
    stack: [] as {
      element: JSX.Element | (() => JSX.Element)
      onClose?: () => void
      autoFocus: boolean
    }[],
    // Whether the top dialog owns the keyboard. Autofocus dialogs start focused;
    // non-autofocus dialogs start unfocused so the background input keeps focus
    // and stays typable until the user presses the focus key.
    focused: true,
    size: "medium" as "medium" | "large" | "xlarge",
  })

  const renderer = useRenderer()
  const modeStack = useOpencodeModeStack()
  const tuiConfig = useTuiConfig()

  createEffect(() => {
    if (store.stack.length === 0) return
    const popMode = modeStack.push("modal")
    onCleanup(popMode)
  })

  let focus: Renderable | null
  let version = 0
  function restoreFocus() {
    if (!focus) return
    if (focus.isDestroyed) return
    function find(item: Renderable) {
      for (const child of item.getChildren()) {
        if (child === focus) return true
        if (find(child)) return true
      }
      return false
    }
    const found = find(renderer.root)
    if (!found) return
    focus.focus()
  }
  function refocus() {
    const pending = version
    setTimeout(() => {
      if (pending !== version) return
      if (store.stack.length > 0) return
      restoreFocus()
    }, 1)
  }

  // Toggle keyboard ownership for a non-autofocus dialog. Focusing blurs the
  // background renderable so the dialog's own inputs can take focus; unfocusing
  // hands focus back to whatever was focused before the dialog opened.
  function toggleFocus() {
    const top = store.stack.at(-1)
    if (!top || top.autoFocus) return
    if (store.focused) {
      setStore("focused", false)
      setTimeout(restoreFocus, 1)
      return
    }
    renderer.currentFocusedRenderable?.blur()
    setStore("focused", true)
  }

  function close() {
    if (renderer.getSelection()) renderer.clearSelection()
    const current = store.stack.at(-1)
    const pending = version
    current?.onClose?.()
    if (pending !== version || store.stack.at(-1) !== current) return
    version++
    batch(() => {
      setStore("focused", false)
      setStore("stack", store.stack.slice(0, -1))
    })
    refocus()
  }

  useBindings(() => ({
    enabled: store.stack.length > 0 && store.focused && !renderer.getSelection()?.getSelectedText(),
    bindings: [
      {
        key: "escape",
        desc: "Close dialog",
        group: "Dialog",
        cmd: close,
      },
      {
        key: "ctrl+c",
        desc: "Close dialog",
        group: "Dialog",
        cmd: close,
      },
    ],
  }))

  useBindings(() => {
    const top = store.stack.at(-1)
    if (!top || top.autoFocus) return { commands: [], bindings: [] }
    return {
      commands: [
        {
          name: "dialog.focus",
          title: "Focus or unfocus dialog",
          category: "Dialog",
          run: toggleFocus,
        },
      ],
      bindings: tuiConfig.keybinds.get("dialog.focus"),
    }
  })

  return {
    clear() {
      const stack = store.stack
      const pending = version
      for (const item of stack) {
        if (item.onClose) item.onClose()
      }
      if (pending !== version) return
      version++
      batch(() => {
        setStore("size", "medium")
        setStore("focused", false)
        setStore("stack", [])
      })
      refocus()
    },
    replace(input: () => JSX.Element, onClose?: () => void, options?: { autoFocus?: boolean }) {
      const stack = store.stack
      const pending = version
      if (stack.length === 0) {
        focus = renderer.currentFocusedRenderable
      }
      for (const item of stack) {
        if (item.onClose) item.onClose()
      }
      if (pending !== version) return
      version++
      const autoFocus = options?.autoFocus !== false
      if (autoFocus) renderer.currentFocusedRenderable?.blur()
      setStore("size", "medium")
      setStore("focused", autoFocus)
      setStore("stack", [
        {
          element: input,
          onClose,
          autoFocus,
        },
      ])
    },
    get stack() {
      return store.stack
    },
    get focused() {
      return store.focused
    },
    get size() {
      return store.size
    },
    setSize(size: "medium" | "large" | "xlarge") {
      setStore("size", size)
    },
  }
}

export type DialogContext = ReturnType<typeof init>

const ctx = createContext<DialogContext>()

export function DialogProvider(props: ParentProps) {
  const value = init()
  const renderer = useRenderer()
  const toast = useToast()
  const clipboard = useClipboard()

  function copySelection() {
    const text = renderer.getSelection()?.getSelectedText()
    if (!text || !clipboard.write) return false
    void clipboard.write(text).then(
      () => toast.show({ message: "Copied to clipboard", variant: "info" }),
      (error) => toast.error(error),
    )
    renderer.clearSelection()
    return true
  }

  return (
    <ctx.Provider value={value}>
      {props.children}
      <box
        position="absolute"
        zIndex={3000}
        onMouseDown={(evt: { button: number; preventDefault(): void; stopPropagation(): void }) => {
          if (!Flag.OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT) return
          if (evt.button !== MouseButton.RIGHT) return

          if (!copySelection()) return
          evt.preventDefault()
          evt.stopPropagation()
        }}
        onMouseUp={!Flag.OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT ? copySelection : undefined}
      >
        <Show when={value.stack.length}>
          <Dialog onClose={() => value.clear()} size={value.size}>
            {(() => {
              const element = value.stack.at(-1)!.element
              return typeof element === "function" ? element() : element
            })()}
          </Dialog>
        </Show>
      </box>
    </ctx.Provider>
  )
}

export function useDialog() {
  const value = useContext(ctx)
  if (!value) {
    throw new Error("useDialog must be used within a DialogProvider")
  }
  return value
}
