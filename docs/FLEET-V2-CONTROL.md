# FleetV2 control protocol

The standalone `fleetV2` profile adds `fleet.control`. Existing MCP definitions
retain the session role and permission checks. The root cannot discover or
invoke `agent_comms.send_local`; the retained tree also refuses that route if
called directly. Workers retain parent/child and automatically linked-peer
messaging. A peer link grants no lifecycle or folder authority.

Use `{"action":"read"}` to obtain the current integer `revision`, durable
`tasks`, `rules`, `asks`, and root `pendingAsks`. Worker reads return only their
assignment and asks. Every root mutation requires `expectedRevision` matching
the latest read. Concurrent edits with the same revision have one winner.

An assignment is keyed by the existing worker `nodeId`. A root pauses it with
`{"action":"pause","nodeId":"...","expectedRevision":1}` and edits with
`{"action":"task","nodeId":"...","text":"Revised assignment","expectedRevision":2}`.
Resume with the revision returned by the edit. Pause waits for native execution
quiescence, retires the old link token and fences queued actions. Resume reads
the current durable task/rules/answers; it cannot accept replacement instructions
through an ephemeral message. `stop` and `remove` use the same lifecycle path.

Ordinary task edits retain task identity. Set `newTask:true`, or replace a
completed assignment, to start a new task identity. With
`fleet.worker_reset_after_task` on, that new task starts a fresh provider
conversation. With it off, the conversation is retained. Rule/answer edits do
not themselves reset the conversation. Workers report durable status with
`{"action":"progress","text":"..."}` or `{"action":"complete","text":"..."}`.
Completed tasks must be replaced before a resume or restart.

Workers file `{"action":"ask","id":"stable-id","question":"..."}`. Repeating
that exact id/question returns the retained record; changing the question under
the same id refuses. The root answers with `action:"answer"`, `id`, `answer` and
`expectedRevision`. Answering pauses an active questioner before committing.
Identical answer replay does not execute a worker or replenish any authority. Asks are bound to task identity; a new task supersedes old open questions and never receives earlier task answers. Task results and prior rule/task revisions remain in retained history. New asks also wake the root’s existing report wait with a generic notice; the durable record remains authoritative.
Shared rule edits require all workers paused. Resume explicitly adopts them.

`settings-read` lists the pinned old setting ids, defaults, options and mapping.
`settings` writes validated `changes:{"setting.id":value}` after workers pause.
Current runtime values remain available through `settings.read`. Behavioral old
orchestration choices are retained as assignment policy; they are instructions,
not claimed OS enforcement. `import-settings` accepts an old id/value map,
imports supported controls and reports excluded ids with reasons. Remove any
credential values before making a tool call. The actual old resource preference
key `mc.resources.v1` accepts its JSON object or JSON string. Folder roots,
permission tier and provider approval mode cannot be changed through settings.

The exact old engine catalogue is retained in
`config/fleet-v2-settings-import.json` (103 entries, including original metadata).
The app-specific inventory identifies controls with no standalone UI equivalent
and records any remaining useful capability gaps separately.

Resource-aware starts use `resources-read`, `resources` with a `policy` object,
and `resource-advice`. The policy is the old `mc.resources.v1` shape: mode
`off|mechanical|controller|both`, `reserveBytes`, provider-specific
`providerBytes`, `maxConcurrentStarts`, CPU thresholds, normal/busy start
intervals, sample expiry and settling time. Defaults remain off. Mechanical
checks use native CPU/RAM observations and launch reservations. Controller mode
requires root advice containing `id`, `provider`, `decision:allow|hold`,
`launches`, and an `expiresAtMs` within sixty seconds; advice replay never refills
spent starts. The old admission core is used directly. These controls admit
starts; they do not terminate already-running workers or widen folder scope.

The operator changes parent folder policy through the local standalone CLI,
never model-selected setting values. The host checks the private revisioned
record before root lifecycle/control calls and every linked worker request,
and checks it every 500ms while running. A newer policy quiesces all descendants
before adoption. Worker file mediation also obtains the current authenticated
scope. Malformed/backward/revisionless policy changes refuse new work and pause
active workers on the watcher. A saved CLI policy receipt does not claim the
live host has already adopted it.

Saved worker action profiles use the actual old `mc.action-permissions.v1`
object (or JSON string) through `import-settings`, or `permission-profiles`
with `profiles`. `permission-profiles-read` returns the active profile document.
Profile inheritance, function allowlists and per-action modes apply to workers;
changes require workers paused. Authenticated worker MCP calls refresh that
policy before discovery/dispatch, and raw tree operations check it again.
The orchestrator retains its separate lifecycle authority. Headless workers
have no fabricated direct-user or inherited-user approval provenance.

`agent.status_injection` defaults off. On, automatic worker onboarding/resume
includes native CPU and memory measurements; the first CPU sample and unavailable
state/audit/backlog/quota measurements are explicitly unknown. Overrides retain
the old exact agent, lane, host precedence and fail closed if malformed.
`metrics.local_history` records private numeric lifecycle and token metadata
separately from provider traces. Root `metrics-read` supports `offset` and `limit`
(up to 1000). Off records nothing new and returns no saved-history rows; existing
records remain. Usage events must match the current generation, thread and turn.

`browser.agent_chrome_session_transfer` defaults true and controls availability
of explicitly authorized Chrome session transfer in the separately registered
ToolsEngine MCP. `toolsEngineMcpEnvironment(config)` in
`src/lib/fleet-v2-browser-settings.js` supplies `TOOLSENABLED_SETTINGS` pointing
at the actual `<stateRoot>/services/settings.json`. Configure that environment
on the separate ToolsEngine registration. It rereads the file for each transfer;
false refuses before source connection. This capability does not replace the
per-transfer user authorization.

The full pinned source inspection is
`docs/FLEET-V2-SETTINGS-APP-INVENTORY.json`. It preserves the audit snapshot and
adds a final integration resolution for fixes made after inspection. It includes
app settings rows, mounted panels, resource fields, setup controls and quick
sliders, with explicit standalone exclusions and behavioral-only limitations.
