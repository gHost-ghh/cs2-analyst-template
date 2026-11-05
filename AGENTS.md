# Agent development and setup entry

Read `docs/AGENT_SETUP.md`, `docs/CONFIGURATION.md` and `docs/ARCHITECTURE.md` before provisioning or changing this project.

## Identity and ownership

- This is reusable code, not authorization to operate the original author's resources. Use only the current user's repository, Steam identity, hosting project and storage.
- Check Git status before edits. Preserve existing changes and commits. Make logical local commits; push or publish only within the current user's authorization. Never rewrite remote history by default.
- Personal deployments and repositories containing match data must remain private. This code template may be public; generated matches and credentials may not.
- Do not copy old `.git`, data, reports, deployment IDs, access tokens, local runtime state or private handoff notes from another installation.
- Never ask for a secret in chat, print a secret, put it in shell arguments, commit it or embed it into browser code. Use the account's secret manager or secure stdin import. Managed proxy references are not ordinary API keys.

## Setup priorities

1. Validate dependencies and synthetic/offline tests.
2. Configure the user's repository and SteamID64 with `tools/setup/configure.mjs`; one installation is bound to one identity.
3. Guide the user through Steam mobile QR approval and GitHub Actions Secrets. Never approve account authentication on their behalf.
4. Run one real Demo job, verify the player's ownership and actual parsed outputs, then enable recurring sync if requested.
5. Register the user's own private Sites project, configure persistent private storage, publish and connect its generated MCP plugin.
6. Verify MCP reads, source references and webpage interactions. DeepSeek API is optional and must not block the preceding stages.

## Implementation rules

- `dashboard/` contains frontend and Worker source. Generated `dist/` is not authoritative source. Build the exact reviewed revision before publishing.
- Preserve compact index and immutable per-match detail/statistics shards. Do not introduce a growing tracked full-history `reports/dashboard.json`.
- Prefer deterministic typed computations over placing all raw rows in model context. Preserve owner, source revision, generation, citations and immutable historical reports.
- Read-only MCP data tools must never acquire arbitrary shell/SQL/file/network execution. Validate queries, bounds, projections and stored shard checksums.
- Keep model credentials server-side. No DeepSeek key is required to download/parse Demo files, use deterministic dashboard views or query MCP from ChatGPT.
- Offline tests must not inherit production deployment credentials or model keys. Paid model tests require an explicit relevant task and bounded acceptance case.
- Do not buy a cloud GPU, install a permanent capture service or maintain a separate rendering server. Native capture uses the current user's installed game, on demand.
- Before every native CS2 launch, protect exact original settings bytes and attributes. Restore and verify them after the owned process exits, including failure and cancellation. Stop if safe restoration cannot be proved. Do not terminate a user's active game.
- Do not call estimated trajectories real bullet impacts, radar circles real smoke volumes, or synthetic C4 effects observed engine animation.

## Completion

Report tests, deployed revision and concrete user-facing acceptance separately. A build, HTTP health response, completed workflow or saved version alone does not prove the full system works. Keep external-login requirements and unverified scenarios explicit.
