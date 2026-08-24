/** @jsxImportSource @opentui/solid */

import { Plugin } from "@opencode-ai/plugin/tui"
import { createSignal, onCleanup, Show } from "solid-js"
import { TaskManager } from "./manager.js"
import { taskProjectPath } from "./paths.js"
import { TaskStore } from "./store.js"
import { watchTaskStore } from "./tui-watch.js"
import type { BackgroundTask } from "./types.js"
import { terminalStatuses } from "./types.js"

const ROUTE = "background-tasks"

type TuiApi = Plugin.Context

type TaskPanelController = {
  move: (offset: number) => void
  refresh: () => void
  kill: (force: boolean) => void
  close: () => void
}

let activePanel: TaskPanelController | undefined

function pluginRoute(name: string, data?: Record<string, unknown>) {
  return { type: "plugin" as const, name, data }
}

function onRoute(api: TuiApi) {
  const current = api.ui.router.current()
  return current.type === "plugin" && current.name === ROUTE
}

function navigateBack(api: TuiApi) {
  const current = api.ui.router.current()
  if (current.type === "session") {
    api.ui.router.navigate({ type: "session", sessionID: current.sessionID })
    return
  }
  api.ui.router.navigate({ type: "home" })
}

function formatAge(task: BackgroundTask) {
  const started = task.startedAt ?? task.createdAt
  const elapsed = Math.max(0, (task.finishedAt ?? Date.now()) - started)
  const seconds = Math.floor(elapsed / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${seconds % 60}s`
}

function statusColor(task: BackgroundTask, api: TuiApi) {
  const theme = api.theme
  if (task.status === "completed") return theme.success
  if (task.status === "failed") return theme.error
  if (task.status === "killed" || task.status === "stopping") return theme.warning
  return theme.info
}

function ShellIndicator(props: { api: TuiApi; count: () => number }) {
  const theme = () => props.api.theme

  return (
    <Show when={props.count() > 0}>
      <box width="100%" flexShrink={0} paddingLeft={2}>
        <text fg={theme().textMuted}>
          {props.count()} shell{props.count() === 1 ? "" : "s"} · /tasks to manage
        </text>
      </box>
    </Show>
  )
}

function TaskDetails(props: { api: TuiApi; store: TaskStore; task: BackgroundTask }) {
  const [task, setTask] = createSignal(props.task)
  const [output, setOutput] = createSignal("")
  const theme = () => props.api.theme

  const refresh = () => {
    const current = props.store.getSync(props.task.id)
    if (!current) return
    const refreshed = props.store.refreshSync(current)
    setTask(refreshed)
    setOutput(props.store.tailSync(refreshed.id, 1000))
  }

  refresh()
  onCleanup(watchTaskStore(props.store, refresh))

  return (
    <box flexGrow={1} flexDirection="column" paddingLeft={1} paddingRight={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme().text}>
          <b>Shell details</b>
        </text>
        <Show when={onRoute(props.api)}>
          <text fg={theme().textMuted}>{props.task.label ?? props.task.id}</text>
        </Show>
      </box>
      <box paddingTop={1} gap={1}>
        <box flexDirection="row" gap={2}>
          <text fg={theme().textMuted} width={10}>Status:</text>
          <text fg={statusColor(task(), props.api)}>{task().status}</text>
        </box>
        <box flexDirection="row" gap={2}>
          <text fg={theme().textMuted} width={10}>Runtime:</text>
          <text fg={theme().text}>{formatAge(task())}</text>
        </box>
        <box flexDirection="row" gap={2}>
          <text fg={theme().textMuted} width={10}>Command:</text>
          <text fg={theme().text} wrapMode="char">{task().command}</text>
        </box>
        <text fg={theme().textMuted}>Output:</text>
        <text fg={theme().text} wrapMode="char">{output() || "No output available"}</text>
      </box>
      <box flexGrow={1} />
      <text fg={theme().textMuted}>← to go back · Esc/Enter/Space to close · x to stop</text>
    </box>
  )
}

function TaskPanel(props: { api: TuiApi }) {
  const directory = props.api.location?.directory ?? process.cwd()
  const store = new TaskStore(taskProjectPath({ directory }))
  const manager = new TaskManager(store)
  const [selected, setSelected] = createSignal(0)
  const theme = () => props.api.theme

  const [tasks, setTasks] = createSignal<BackgroundTask[]>([])
  const [error, setError] = createSignal<string>()

  const refresh = () => {
    try {
      store.initializeSync()
      const next = store
        .listSync()
        .map((task) => store.refreshSync(task))
        .filter((task) => !terminalStatuses.has(task.status))
      setTasks(next)
      setSelected((index) => Math.min(index, Math.max(0, next.length - 1)))
      setError()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const move = (offset: number) => {
    const count = tasks().length
    if (!count) return
    setSelected((index) => (index + offset + count) % count)
  }

  const selectedTask = () => tasks()[selected()]

  const kill = (force: boolean) => {
    const task = selectedTask()
    if (!task || terminalStatuses.has(task.status)) return
    props.api.ui.dialog.clear()
    try {
      manager.killSync(task.id, force)
      refresh()
    } catch (error) {
      props.api.ui.toast.show({ title: "Background task", message: String(error), variant: "error" })
    }
  }

  activePanel = { move, refresh: () => void refresh(), kill, close: () => navigateBack(props.api) }
  onCleanup(() => {
    activePanel = undefined
  })

  refresh()
  onCleanup(watchTaskStore(store, refresh))

  return (
    <box position="absolute" zIndex={2500} left={0} top={0} width="100%" height="100%" padding={1}>
      <box flexGrow={1} flexDirection="column" border={true} borderColor={theme().border} padding={1}>
        <box flexGrow={1} minHeight={0} paddingTop={1}>
          <Show when={!error()} fallback={<text fg={theme().error}>Task store error: {error()}</text>}>
            <Show
              when={tasks().length > 0}
              fallback={<text fg={theme().textMuted}>No background tasks.</text>}
            >
              <Show when={tasks().length > 1}>
                <text fg={theme().textMuted}>Shell {selected() + 1} of {tasks().length} · j/k to switch</text>
              </Show>
              <Show when={selectedTask()} keyed>
                {(task) => <TaskDetails api={props.api} store={store} task={task} />}
              </Show>
            </Show>
          </Show>
        </box>
      </box>
    </box>
  )
}

export default Plugin.define({
  id: "opencode2-shell-tasks",
  setup: (api) => {
    const directory = api.location?.directory ?? process.cwd()
    const store = new TaskStore(taskProjectPath({ directory }))
    const disposers: Array<() => void> = []
    const [shellCount, setShellCount] = createSignal(0)

    const refreshShellCount = () => {
      try {
        store.initializeSync()
        const count = store
          .listSync()
          .map((task) => store.refreshSync(task))
          .filter((task) => !terminalStatuses.has(task.status)).length
        setShellCount(count)
      } catch {
        setShellCount(0)
      }
    }

    refreshShellCount()
    disposers.push(watchTaskStore(store, refreshShellCount))

    disposers.push(
      api.ui.slot({
        append: "prompt.footer.status",
        render: () => <ShellIndicator api={api} count={shellCount} />,
      }),
    )

    disposers.push(
      api.ui.router.register({
        name: ROUTE,
        render: () => <TaskPanel api={api} />,
      }),
    )

    api.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "background-tasks.open",
          title: "Open background tasks",
          group: "Tasks",
          palette: true,
          slash: { name: "tasks" },
          bind: false,
          run() {
            const current = api.ui.router.current()
            api.ui.router.navigate(pluginRoute(ROUTE, { returnRoute: current }))
            api.ui.dialog.clear()
          },
        },
      ],
    }))

    api.keymap.layer(() => ({
      enabled: () => onRoute(api),
      commands: [
        {
          id: "background-tasks.close",
          title: "Close background tasks",
          group: "Tasks",
          bind: "left,q,escape,enter,space",
          run() {
            activePanel?.close()
          },
        },
        {
          id: "background-tasks.down",
          title: "Select next background task",
          group: "Tasks",
          bind: "j,down",
          run() {
            activePanel?.move(1)
          },
        },
        {
          id: "background-tasks.up",
          title: "Select previous background task",
          group: "Tasks",
          bind: "k,up",
          run() {
            activePanel?.move(-1)
          },
        },
        {
          id: "background-tasks.kill",
          title: "Stop selected background task",
          group: "Tasks",
          bind: "x",
          run() {
            activePanel?.kill(false)
          },
        },
        {
          id: "background-tasks.force-kill",
          title: "Force stop selected background task",
          group: "Tasks",
          bind: "X",
          run() {
            activePanel?.kill(true)
          },
        },
        {
          id: "background-tasks.refresh",
          title: "Refresh background tasks",
          group: "Tasks",
          bind: "r",
          run() {
            activePanel?.refresh()
          },
        },
      ],
    }))

    return () => {
      activePanel = undefined
      for (const dispose of disposers) dispose()
    }
  },
})
