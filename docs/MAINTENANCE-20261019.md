# Fleet MCP 1.9.2-rc.1 maintenance candidate

This candidate synchronizes the standalone repository with the published
Fleet 1.9.1 source at `ToolsEnabled/toolsenabled-engine`, commit
`104ea39d29e54e96e9a6579f99034cf0ec0f63c7`. It preserves the independent Codex
package, which requires Standard tier and workers off. It is not a new runtime
archive release or a claim of directory approval.

## Reported issues

- #1: complete Windows/WSL entries, explicit Linux environment forwarding,
  MCP startup allowance and PowerShell separator guidance in HOST-MODE.md.
- #2: package-neutral setup instructions replace the Claude-only slash command
  in the server's startup summary and mismatched-record remedy.
- #3: Linux-native Codex profile guidance, independently authenticated by the
  CLI; actionable CODEX_START_TIMEOUT in both MCP response forms; configurable
  session startup timeout. No credentials are copied and no billing fallback
  is added.
- #4: strict inherited permissions retained. An invisible Windows lead remains
  level 2; running the lead in WSL makes its command line observable. Published
  1.9.1's existing terminal interaction route can answer supported individual
  requests without raising a worker's level. No declared-level override added.
- #5: full reports retained in private tree state; previews explicitly identify
  truncation and offer paged retrieval through agent.wait. Reports remain
  readable after delivery and restart. Already-lost text from older versions
  cannot be reconstructed. Retained report storage grows with reports; include
  tree state in your private backup and retention procedure.

## Additional maintenance

Three previously local ACP fixes are included: discard responses with no
client-owned pending request, ignore updates for sessions Fleet did not open,
and mark oversized display-output arrays as truncated instead of killing the
worker. Responses to Fleet's own requests and permission requests retain their
validation. This does not enable native subagents or add a new provider.

Google setup guidance no longer repeats an unverified individual-login shutdown
date. Fleet's supported worker routes are stated separately from eligibility
to use Google's own applications.

## Publication boundaries

The runtime declares no production npm dependencies and retains its MIT license
and notices. Provider CLIs are separately installed and retain their terms.
Source fixes do not establish vendor approval or qualify a newly built archive.

Personal Antigravity worker orchestration is excluded: Google's
[terms](https://www.antigravity.google/terms) and
[FAQ](https://antigravity.google/docs/faq) prohibit consumer-plan wrappers in
third-party agents. A person using Google's own app with Fleet as an MCP tool is
a different integration direction; do not treat that as permission for Fleet
to launch personal Antigravity workers.

Claude Code must remain unmodified and each user must sign in through its own
flow. Anthropic's [legal guidance](https://code.claude.com/docs/en/legal-and-compliance)
permits end-user authentication in hosted unmodified Claude Code, while
restricting third-party subscription routing and credential intermediation.
Commercial Terms acceptance and the intended deployment must be checked before
offering that route as a product. Heavy orchestration is not guaranteed ordinary
individual subscription usage. No blanket vendor clearance is asserted.

The [Claude Directory Policy](https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy)
has separate requirements for external resources and conversation/history
access. Do not transfer standalone transcript-reading or arbitrary-provider
features into the Claude plugin's directory submission without reviewing that
submission separately.

Codex's [app-server](https://learn.chatgpt.com/docs/app-server) documents external
integration. Its [authentication guidance](https://learn.chatgpt.com/docs/auth)
supports local ChatGPT sign-in and says to use API-key authentication for
programmatic Codex CLI workflows; it also documents administrator-authorized
Enterprise access tokens for trusted automation. Fleet must not promise personal
subscription entitlement for every automated workload.
Grok's [ACP guide](https://docs.x.ai/build/cli/headless-scripting) documents tool
integration with the official CLI. Neither document establishes an account's
current entitlement, unlimited usage, or Fleet directory approval.

Validation uses local protocol fixtures and isolated state. No paid API or
provider inference call is required for these fixes. Native Windows acceptance
and exact-archive qualification remain separate release checks.
