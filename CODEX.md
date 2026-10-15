# Independent Fleet MCP Codex candidate (unreleased)

This is a local-source candidate derived only from the published Fleet1.9.0
source TAR, not the newer Claude plugin's1.11.4 runtime or any private history.
An authorized public Git destination is unresolved; do not invent a repository.
Use a verified local candidate checkout/bundle, then:

```sh
codex plugin marketplace add /absolute/candidate-root
codex plugin add toolsenabled-fleet-mcp@toolsenabled-fleet-mcp-openai
```

Requires Linux x86_64 and Node >=22.19. Configure this separate state yourself
from the installed plugin folder, with a real project inside your account home:

```sh
node bin/toolsenabled-host.js setup --plugin --tier standard --workspace /absolute/project --state-root /absolute/private/fleet-mcp-codex
export FLEET_MCP_CODEX_STATE_ROOT=/absolute/private/fleet-mcp-codex
export FLEET_MCP_CODEX_WORKSPACE=/absolute/project
```

Restart Codex with those two variables. The entry refuses missing/relative
configuration, workers enabled, a tier other than Standard, and projects outside
the sealed workspace. It serves canonical individual coordination/file tools as
actor codex; no setup, worker or Claude hook adaptation is added. Original host
code is unchanged. No provider account or model call is needed in this server.

State retains tasks, ledger, memory/search and host records in the separate
private root. Stop clients before private backup/deletion; uninstall retains
state. Codex may send tool results to OpenAI under its own login/terms. The core
is not an OS sandbox for Codex's own tools. No API keys are forwarded by this
manifest. See SECURITY.md, docs/HOST-MODE.md and the MIT license. Public policy
links are https://toolsenabled.ai/privacy/ and https://toolsenabled.ai/terms/;
coverage for this exact archive/Codex path still needs lead review. Source website
is https://toolsenabled.ai; no dedicated product page is asserted.

Only local marketplace/source qualification is possible before public Git
routing is supplied. No public branch install, native Windows/macOS, worker
lifecycle or directory approval is claimed. Do not submit or publish this bundle.
