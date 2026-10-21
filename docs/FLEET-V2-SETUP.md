# fleetV2 standalone MCP candidate

Fleet V2 is a standalone MCP runtime. Provider CLIs, their subscriptions and ToolsEngine are separately installed. This package does not install or build vendor plugins.

Requires Node.js 22.19 or newer. Linux uses Python 3 for retained process-tree cleanup. Linux and native Windows x64 are supported targets; Windows uses native PowerShell and NTFS, without WSL. See the retained platform qualification receipts for the exact tested provider paths.

Fleet inherits the environment from which it is launched. The terminal starting directory becomes the working directory; it is not a filesystem boundary. Fleet does not add a folder sandbox or discover the lead client's folder permissions. Configure any desired filesystem or network restrictions outside Fleet, for example in the sandbox that launches the terminal. Existing operating-system restrictions still apply. Fleet does not elevate privileges or escape an external sandbox.

Extract into a new, private folder outside the state folder. Authenticate the archive checksum through the channel from which you received it, then run `node verify.cjs` to check extracted contents. Keep the runtime folder stable after setup.

From your intended working directory, run:

```sh
node /path/to/runtime/bin/fleetV2.js setup --state-root /absolute/private-state
```

Use absolute native paths on Windows. The state folder must be new. Setup defaults to the current directory; `--workspace` selects a setup directory explicitly. `--coordination-only` disables worker launching. Each new server process and its workers use the server's starting directory, so an MCP client must launch it with the intended working directory.

Setup prints a `server` command and arguments for the MCP client. Its example actor is `codex`; choose the provider that owns the lead connection. It also prints `toolsEngineEnvironment`, which can be added to a separately configured ToolsEngine MCP. The shared Chrome transfer setting takes effect on the next transfer request and does not replace explicit user authorization.

Inspect configuration and the supported launch entry with:

```sh
node runtime/bin/fleetV2.js status --state-root /absolute/private-state
```

The orchestrator coordinates through task assignments, rules and durable Asks. It retains lifecycle and settings control. Workers use provider bypass and message linked peers. Pausing and editing assignments invalidates stale task authority before resume. Retained process groups and Windows Jobs control lifecycle; they do not grant additional filesystem rights.

MCP file tools provide byte-coordinated edits across paths accessible to the running process. Private state/credential protections remain. Native and shell edits do not participate in byte mediation. The working directory is only the default for relative paths.

Existing explicitly scoped development installations retain their saved restrictions. The old read/write-root flags and `scope` update command remain available for those installations; an old state is never silently widened. New installations without root flags use `inherited-environment` and do not require folder-policy configuration.

Close the MCP client before moving or retiring this extracted runtime. No client registration or live installation is changed automatically. Preserve the separate state directory for task history, rules, Asks and audit records.
