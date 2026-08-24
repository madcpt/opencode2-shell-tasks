import path from "node:path"
import { Plugin } from "@opencode-ai/plugin"
import { formatTasks } from "./format.js"
import { TaskManager } from "./manager.js"
import { taskProjectPath } from "./paths.js"
import { backgroundTaskPolicy } from "./policy.js"
import { filterByStatus, TaskStore } from "./store.js"
import type { BackgroundTask } from "./types.js"
import { terminalStatuses } from "./types.js"

const bashHint =
  "\n\nFor commands likely to take more than a few seconds, prefer the background_bash tool so the Agent can continue working. Use bash for quick or interactive commands."

interface ProjectEntry {
  store: TaskStore
  manager: TaskManager
  watched: Set<string>
}

export default Plugin.define({
  id: "opencode2-shell-tasks",
  tui: true,
  setup: async (ctx) => {
    const projects = new Map<string, ProjectEntry>()

    const project = async (directory: string): Promise<ProjectEntry> => {
      const root = taskProjectPath({ directory })
      let entry = projects.get(root)
      if (!entry) {
        const store = new TaskStore(root)
        await store.initialize()
        entry = { store, manager: new TaskManager(store), watched: new Set<string>() }
        for (const task of await store.list()) {
          const refreshed = await store.refresh(task)
          if (!terminalStatuses.has(refreshed.status)) entry.watched.add(refreshed.id)
        }
        projects.set(root, entry)
      }
      return entry
    }

    // V2 tool executors no longer receive `directory`; resolve it from the session.
    const sessionDirectory = async (sessionID: string): Promise<string> => {
      try {
        const session = await ctx.session.get({ sessionID })
        return session.location.directory
      } catch {
        return process.cwd()
      }
    }

    // Wake the originating session when a watched task reaches a terminal state.
    const notifySession = async (task: BackgroundTask) => {
      if (!task.sessionID) return
      const success = task.status === "completed"
      const label = task.label ?? task.id
      const exit = task.exitCode === undefined ? "" : ` (exit ${task.exitCode})`
      const followUp = success
        ? `Use the background_output tool with task_id "${task.id}" to read its output, then report the result or continue the work it unblocks.`
        : `Use the background_output tool with task_id "${task.id}" to inspect what went wrong before deciding whether to retry.`
      try {
        await ctx.session.synthetic({
          sessionID: task.sessionID,
          text: `Background task ${label} ${task.status}${exit}. ${followUp}`,
          delivery: "queue",
        })
      } catch {
        // The session may be gone; the task record stays reconciled either way.
      }
    }

    const poll = setInterval(() => {
      void (async () => {
        for (const { store, watched } of projects.values()) {
          for (const task of await store.list()) {
            const refreshed = await store.refresh(task)
            if (!terminalStatuses.has(refreshed.status)) {
              watched.add(refreshed.id)
              continue
            }
            if (!watched.delete(refreshed.id)) continue
            await notifySession(refreshed)
          }
        }
      })().catch(() => undefined)
    }, 2000)
    poll.unref()

    // Replaces V1 "experimental.chat.system.transform" and "tool.definition".
    await ctx.session.hook("context", (event) => {
      event.system.push({ type: "text", text: backgroundTaskPolicy })
      const bash = event.tools.bash
      if (bash) bash.description += bashHint
    })

    interface BashInput {
      command?: unknown
      workdir?: unknown
      label?: unknown
    }
    interface TasksInput {
      status?: unknown
    }
    interface OutputInput {
      task_id?: unknown
      lines?: unknown
    }
    interface KillInput {
      task_id?: unknown
      force?: unknown
    }

    await ctx.tool.transform((tools) => {
      tools.add({
        name: "background_bash",
        description:
          "Start a long-running shell command as a detached background task. Returns immediately with a task ID; use background_tasks and background_output to monitor it.",
        input: {
          type: "object",
          properties: {
            command: { type: "string", description: "Shell command to run" },
            workdir: {
              type: "string",
              description: "Working directory, relative to the session directory by default",
            },
            label: { type: "string", description: "Short human-readable task label" },
          },
          required: ["command"],
          additionalProperties: false,
        },
        options: { permission: "background_bash" },
        execute: async (raw, context) => {
          const args = raw as BashInput
          const command = String(args.command ?? "")
          const directory = await sessionDirectory(context.sessionID)
          const cwd = path.resolve(directory, args.workdir ? String(args.workdir) : ".")
          const label = args.label === undefined ? undefined : String(args.label)
          const entry = await project(directory)
          const task = await entry.manager.start({ sessionID: context.sessionID, command, cwd, label })
          entry.watched.add(task.id)
          return {
            content: `Running in the background\nTask: ${task.id}\nPID: ${task.pid}\nLog: ${entry.store.logPath(task.id)}`,
            metadata: { taskID: task.id, pid: task.pid, status: task.status } as Record<string, unknown>,
          }
        },
      })

      tools.add({
        name: "background_tasks",
        description: "List background shell tasks and their current status.",
        input: {
          type: "object",
          properties: {
            status: {
              type: "string",
              enum: ["all", "running", "finished"],
              description: "Task status filter",
            },
          },
          additionalProperties: false,
        },
        execute: async (raw, context) => {
          const args = raw as TasksInput
          const status = args.status === "running" || args.status === "finished" ? args.status : "all"
          const directory = await sessionDirectory(context.sessionID)
          const { store } = await project(directory)
          const tasks: BackgroundTask[] = await Promise.all(
            (await store.list()).map((task) => store.refresh(task)),
          )
          return { content: formatTasks(filterByStatus(tasks, status)) }
        },
      })

      tools.add({
        name: "background_output",
        description: "Read the latest combined stdout and stderr from a background task.",
        input: {
          type: "object",
          properties: {
            task_id: { type: "string", description: "Background task ID" },
            lines: {
              type: "integer",
              minimum: 1,
              maximum: 2000,
              description: "Number of trailing lines",
            },
          },
          required: ["task_id"],
          additionalProperties: false,
        },
        execute: async (raw, context) => {
          const args = raw as OutputInput
          const taskID = String(args.task_id ?? "")
          const lines = args.lines === undefined ? 200 : Math.max(1, Math.min(2000, Math.floor(Number(args.lines))))
          const directory = await sessionDirectory(context.sessionID)
          const { store } = await project(directory)
          const task = await store.get(taskID)
          if (!task) throw new Error(`Unknown background task: ${taskID}`)
          const refreshed = await store.refresh(task)
          const output = await store.tail(task.id, Number.isFinite(lines) ? lines : 200)
          return {
            content: `Task ${task.id}: ${refreshed.status}${refreshed.exitCode === undefined ? "" : ` (exit ${refreshed.exitCode})`}\n\n${output || "(no output)"}`,
          }
        },
      })

      tools.add({
        name: "background_kill",
        description: "Stop a running background task and its process group.",
        input: {
          type: "object",
          properties: {
            task_id: { type: "string", description: "Background task ID" },
            force: { type: "boolean", description: "Use SIGKILL instead of SIGTERM" },
          },
          required: ["task_id"],
          additionalProperties: false,
        },
        options: { permission: "background_kill" },
        execute: async (raw, context) => {
          const args = raw as KillInput
          const taskID = String(args.task_id ?? "")
          const force = Boolean(args.force)
          const directory = await sessionDirectory(context.sessionID)
          const { manager } = await project(directory)
          const task = await manager.kill(taskID, force)
          return { content: `Task ${task.id}: ${task.status}` }
        },
      })
    })

    return () => clearInterval(poll)
  },
})
