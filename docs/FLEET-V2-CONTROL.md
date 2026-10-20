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
Identical answer replay does not execute a worker or replenish any authority.
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
