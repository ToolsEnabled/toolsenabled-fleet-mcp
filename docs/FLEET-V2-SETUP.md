# fleetV2 standalone MCP candidate

This is a development candidate, not a qualified public release. It contains the standalone MCP runtime. Provider CLIs, their subscriptions and ToolsEngine are separately installed. It neither installs nor builds vendor plugins.

Requires Node.js 22.19 or newer. Linux workers require the native Python supervisor and supported Landlock kernel. Windows runs natively with Windows PowerShell and NTFS; WSL is not a runtime dependency. Native Windows filesystem restriction fixtures pass, but full restricted provider execution is not yet qualified. Do not treat that fixture result as Windows worker support.

Extract into a new, private folder outside your project and state folders. Authenticate the archive checksum through the channel from which you received it, then run `node verify.cjs` to check the extracted contents. That check detects changed contents; it does not authenticate an untrusted download. Keep the runtime folder stable after setup.

Run `node runtime/bin/fleetV2.js --help` for the exact CLI. For example, on Linux:

```sh
node runtime/bin/fleetV2.js setup --workspace /absolute/project --state-root /absolute/private-state --read-all --write-root /absolute/project
```

Use absolute native paths on Windows, for example `C:\Users\YOU\Projects\project`. The state folder must be new. `--read-all` permits reads already allowed by the operating system; it does not grant writes outside the explicit write roots. Alternatively supply each `--read-root` separately. `--coordination-only` disables worker launching.

The folder policy is an explicit operator declaration. Automatic discovery of an arbitrary lead agent's effective folder policy is **not implemented**. Match the policy to the lead's actual authority; neither Ask/bypass mode nor MCP workspace roots proves that authority. Runtime files, provider authentication, provider transcripts and temporary files also require appropriate access. The runtime does not silently grant additional bookkeeping folders.

Setup prints a `server` command and arguments for the MCP client. Its example actor is `codex`; choose the described provider that owns the lead connection. It also prints `toolsEngineEnvironment`, which can be added to the separately configured ToolsEngine MCP environment. The shared Chrome transfer setting then takes effect on the next transfer request. It does not replace explicit user authorization for transferring a signed-in session.

Inspect configuration with:

```sh
node runtime/bin/fleetV2.js status --state-root /absolute/private-state
```

Update the complete declared folder policy from the local operator terminal, using its current revision:

```sh
node runtime/bin/fleetV2.js scope --state-root /absolute/private-state --revision 1 --read-all --write-root /absolute/next-project
```

The update records a new revision. The live host observes it and quiesces current workers before their next operation. Inspect the control state before resuming. This command does not change a separately running lead agent's own policy.

The orchestrator coordinates through task assignments, rules and durable Asks. It retains lifecycle and settings control. Workers use provider bypass, remain subject to their configured native folder boundary, and message linked peers. Native and shell file edits do not participate in MCP byte mediation. No network isolation is provided.

Close the MCP client connection before moving or retiring this extracted runtime. No client registration or live installation is changed automatically. Preserve the separate state directory if you need task history, rules, Asks or audit records.
