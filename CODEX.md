# ToolsEnabled Fleet for Codex

This maintenance candidate uses the published Fleet 1.9.1 source snapshot plus
the reviewed fixes listed in docs/MAINTENANCE-20261019.md. It keeps the Codex
package separate from the Claude plugin runtime. The plugin offers coordination with workers off. After this candidate is merged
into `openai-plugin`, install it from that branch:

```sh
codex plugin marketplace add ToolsEnabled/toolsenabled-fleet-mcp --ref openai-plugin
codex plugin add toolsenabled-fleet@toolsenabled-fleet-openai
```

Requires Linux x86_64 and Node >=22.19. Configure this separate state yourself
from the installed plugin folder, with a real project inside your account home:

```sh
node bin/toolsenabled-host.js setup --plugin --tier standard --workspace /absolute/project --state-root /absolute/private/fleet-mcp-codex
export FLEET_MCP_CODEX_STATE_ROOT=/absolute/private/fleet-mcp-codex
export FLEET_MCP_CODEX_WORKSPACE=/absolute/project
```

Restart Codex with those two variables. The entry refuses missing/relative
configuration, workers enabled, a tier other than Standard, and any selected workspace that does not resolve exactly to the sealed project
directory. Children and parents refuse; an alias to the same directory may pass. It serves canonical individual coordination/file tools as
actor codex; no setup, worker or Claude hook adaptation is added. The shared host code includes the published 1.9.1 fixes and this maintenance update. No provider account or model call is needed in this server.

State retains tasks, ledger, memory/search and host records in the separate
private root. Stop clients before private backup/deletion; uninstall retains
state. Codex may send tool results to OpenAI under its own login/terms. The core
is not an OS sandbox for Codex's own tools. No API keys are forwarded by this
manifest. See SECURITY.md, docs/HOST-MODE.md and the MIT license. See the package-specific [privacy statement](PRIVACY.md) and
[vendor policy record](docs/PLUGIN-POLICY.md). No directory approval is claimed.

The prior package was qualified by a fresh install with Codex CLI 0.162.1 on
Linux x86_64. This candidate has automated entry and source regression checks;
a fresh installation of this exact version remains a release check. Native Windows/macOS, worker lifecycle and OpenAI directory approval
are not claimed; the plugin has not been submitted to the directory.

The package name is now `toolsenabled-fleet@toolsenabled-fleet-openai`. If you installed the older `toolsenabled-fleet-mcp@toolsenabled-fleet-mcp-openai` entry, remove that plugin before adding this one to avoid duplicate servers. Keep your selected state folder and project variables; plugin removal does not delete them.

Example prompts:

- "List Fleet tasks for this project and show the unfinished ones."
- "Save the build command I just gave you in this project's Fleet memory."
- "Use Fleet to read notes.txt, change its title to Release notes, and show the result."
