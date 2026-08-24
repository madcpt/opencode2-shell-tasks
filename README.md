# OpenCode 2 Shell Tasks

An [OpenCode 2](https://opencode.ai/v2/docs/) plugin for Claude Code-style background shell jobs, built on the **V2 plugin API** (`Plugin.define`, `ctx.tool.transform`, `ctx.session.hook`). It lets the Agent start a long command without blocking the current turn, continue other work, inspect status and logs, stop a task, and manage everything from a native TUI panel.

> This is the OpenCode 2 port of [`opencode-shell-tasks`](https://github.com/madcpt/opencode-shell-tasks), which targets OpenCode 1.x. The two plugins target different plugin API generations and are not interchangeable.

## Features

- Detached shell commands that return a task ID immediately
- Project-scoped task metadata persisted outside the repository
- Combined stdout/stderr logs with bounded tail reads
- Status and exit-code reconciliation after an OpenCode restart
- Graceful or forced process-group cancellation
- A native `/tasks` TUI panel registered automatically by the plugin
- Automatic Agent guidance to route long-running shell work to `background_bash`
- Permission-gated tools via declarative V2 `options.permission`

## Install From This Checkout

```sh
npm install
npm run build
```

Add the package directory to the `plugins` list in `opencode.json(c)` (project or global):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    { "package": "/absolute/path/to/opencode2-shell-tasks" }
  ]
}
```

OpenCode 2 discovers both server and TUI entrypoints from the same package. Restart OpenCode after changing the configuration or rebuilding the plugin.

## Usage

Ask naturally:

```text
Run npm test in the background and keep working on the README.
```

The Agent can call these tools:

| Tool | Purpose |
|---|---|
| `background_bash` | Start a detached command. |
| `background_tasks` | List running or finished tasks. |
| `background_output` | Tail a task's combined output. |
| `background_kill` | Send `SIGTERM` or `SIGKILL` to the task process group. |

Run `/tasks` to open the native shell-details panel immediately. It does not call the model. The prompt footer shows a shell counter while any shell is active.

The plugin also injects routing guidance into the Agent's context: tests, builds, installs, downloads, sleeps, watch servers, and other commands likely to take more than a few seconds use `background_bash` automatically. Quick or interactive commands continue to use `bash`.

Panel controls:

| Key | Action |
|---|---|
| `j` / `k` or arrow keys | Switch between shells. |
| `x` | Stop the selected shell. |
| `X` | Force-stop the selected task. |
| `r` | Refresh task state. |
| `←` / `Esc` / `Enter` / `Space` | Close the details panel. |

Task state defaults to:

```text
~/.local/share/opencode/background-tasks/<project-hash>/
```

Set `OPENCODE_BACKGROUND_TASKS_DIR` to override the storage root.

## V2 Plugin API Notes

This plugin tracks the beta V2 plugin API and pins `@opencode-ai/plugin@beta`. Key mappings from the V1 implementation:

| V1 | V2 |
|---|---|
| `async ({client, directory}) => ({hooks, tool})` | `Plugin.define({id, tui, setup(ctx)})` |
| `tool({args})` registration | `ctx.tool.transform(tools.add(...))` with JSON Schema inputs |
| `context.ask({permission})` | Declarative `options.permission` on tool registration |
| `experimental.chat.system.transform` + `tool.definition` | Single `ctx.session.hook("context")` callback |
| Tool executor `context.directory` | Resolved per call via `ctx.session.get(sessionID)` |
| `api.route` / `slots.register` / `keymap.registerLayer` | `ui.router` pages, `ui.slot` claims, `keymap.layer()` commands |

Because the V2 plugin API is still beta, pin your OpenCode release if you depend on specific behavior.

## Development

```sh
npm run check
```

The process wrapper writes an exit-code sidecar before exiting. This allows the plugin to recover the final status after a restart even though the detached process is no longer owned by the restarted OpenCode server.
