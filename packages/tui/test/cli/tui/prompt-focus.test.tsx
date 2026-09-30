/** @jsxImportSource @opentui/solid */
import { createSignal, onCleanup, type JSX } from "solid-js"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import type { PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2"
import { tmpdir } from "../../fixture/fixture"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "../../fixture/tui-sdk"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { ArgsProvider } from "../../../src/context/args"
import { KVProvider } from "../../../src/context/kv"
import { SDKProvider } from "../../../src/context/sdk"
import { PermissionProvider } from "../../../src/context/permission"
import { ProjectProvider } from "../../../src/context/project"
import { ExitProvider } from "../../../src/context/exit"
import { SyncProvider } from "../../../src/context/sync"
import { LocationProvider } from "../../../src/context/location"
import { ThemeProvider } from "../../../src/context/theme"
import { ToastProvider } from "../../../src/ui/toast"
import { TuiConfigProvider } from "../../../src/config"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/keymap"
import { PermissionPrompt } from "../../../src/routes/session/permission"
import { QuestionPrompt } from "../../../src/routes/session/question"

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

async function mount(
  root: string,
  content: (ctx: { focused: () => boolean; setFocused: (value: boolean) => void }) => JSX.Element,
  override?: (url: URL) => Response | undefined,
) {
  const state = path.join(root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  const events = createEventSource()
  const calls = createFetch(override, events)
  const [focused, setFocused] = createSignal(false)

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig({ keybinds: {}, leader_timeout: 1000 })
    const off = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(off)
    return (
      <TestTuiContexts directory={root} paths={{ home: root, state, worktree: root }}>
        <ArgsProvider>
          <KVProvider>
            <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={events.source}>
              <PermissionProvider>
                <ProjectProvider>
                  <ExitProvider exit={() => {}}>
                    <SyncProvider>
                      <OpencodeKeymapProvider keymap={keymap}>
                        <TuiConfigProvider config={config}>
                          <ThemeProvider mode="dark">
                            <ToastProvider>
                              <LocationProvider location={{ directory }}>
                                {content({ focused, setFocused })}
                              </LocationProvider>
                            </ToastProvider>
                          </ThemeProvider>
                        </TuiConfigProvider>
                      </OpencodeKeymapProvider>
                    </SyncProvider>
                  </ExitProvider>
                </ProjectProvider>
              </PermissionProvider>
            </SDKProvider>
          </KVProvider>
        </ArgsProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { kittyKeyboard: true })
  return { app, focused, setFocused }
}

test("permission prompt keys only respond while focused", async () => {
  await using tmp = await tmpdir()
  const replies: string[] = []
  const request: PermissionRequest = {
    id: "perm-1",
    sessionID: "ses-1",
    permission: "bash",
    patterns: [],
    metadata: {},
    always: [],
  }
  const harness = await mount(
    tmp.path,
    (ctx) => (
      <PermissionPrompt
        request={request}
        directory={directory}
        focused={ctx.focused()}
        onFocus={() => ctx.setFocused(true)}
      />
    ),
    (url) => {
      if (url.pathname.endsWith("/reply")) {
        replies.push(url.pathname)
        return json(true)
      }
      return undefined
    },
  )
  try {
    // Let the binding layers register before asserting the unfocused case.
    await Bun.sleep(50)
    harness.app.mockInput.pressEnter()
    await Bun.sleep(30)
    expect(replies).toEqual([])

    harness.setFocused(true)
    await Bun.sleep(30)
    harness.app.mockInput.pressEnter()
    await wait(() => replies.length > 0)
    expect(replies).toEqual(["/permission/perm-1/reply"])
  } finally {
    harness.app.renderer.destroy()
  }
})

test("question prompt keys only respond while focused", async () => {
  await using tmp = await tmpdir()
  const replies: string[] = []
  const request: QuestionRequest = {
    id: "q-1",
    sessionID: "ses-1",
    questions: [
      {
        header: "Fruit",
        question: "Pick one",
        options: [
          { label: "Apple", description: "a red fruit" },
          { label: "Banana", description: "a yellow fruit" },
        ],
        multiple: false,
        custom: false,
      },
    ],
  }
  const harness = await mount(
    tmp.path,
    (ctx) => (
      <QuestionPrompt
        request={request}
        directory={directory}
        focused={ctx.focused()}
        onFocus={() => ctx.setFocused(true)}
      />
    ),
    (url) => {
      if (url.pathname.endsWith("/reply")) {
        replies.push(url.pathname)
        return json(true)
      }
      return undefined
    },
  )
  try {
    await Bun.sleep(50)
    harness.app.mockInput.pressEnter()
    await Bun.sleep(30)
    expect(replies).toEqual([])

    harness.setFocused(true)
    await Bun.sleep(30)
    harness.app.mockInput.pressEnter()
    await wait(() => replies.length > 0)
    expect(replies).toEqual(["/question/q-1/reply"])
  } finally {
    harness.app.renderer.destroy()
  }
})
