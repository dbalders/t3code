# TritonGPT Sync Automation

This branch adds the automation scaffold for keeping a TritonGPT-branded downstream build of T3 Code under our control.

## Current Point In The Process

We are not branded yet. The `tritongpt` branch currently starts from upstream `pingdotgg/t3code` `main`.

That is intentional. Starting clean means future TritonGPT branding commits are easy to identify as downstream-owned changes. Once those branding commits exist, the sync automation can compare upstream changes against our custom branch and decide whether an update is safe.

## Moving Parts

There are two scripts:

- `scripts/dsmlp-bootstrap-tritongpt-sync.sh`
- `scripts/tritongpt-sync-upstream.mjs`

The bootstrap script is for setup or repair. Run it manually inside the DSMLP checkout. It installs dependencies, configures remotes, creates/updates the local `tritongpt` target branch, writes a private LiteLLM env template, and runs a dry sync check.

The sync script is the real automation target. It fetches `upstream/main`, compares it with `tritongpt`, attempts a merge in a temporary worktree, runs checks, and delegates review to either LiteLLM directly or an external coding agent command.

Package scripts wrap the sync script:

```sh
bun run tritongpt:sync:check
bun run tritongpt:sync:review
bun run tritongpt:sync:pr
```

## What The Dry Check Means

When the dry check reports:

```json
{
  "status": "already-current"
}
```

it means `tritongpt` already contains the current upstream commit. Right now that is expected because `tritongpt` is still clean upstream.

After branding work is added, `already-current` will mean upstream has not moved beyond the base that our branded branch already includes.

## Automation Timer Target

The timer should not run the bootstrap script. The timer should run the sync script through a package command.

For review-only runs:

```sh
source ~/.tritongpt-sync.env
cd ~/tritonai-code-server/t3code
bun run tritongpt:sync:review
```

For runs that should push a sync branch and open a PR:

```sh
source ~/.tritongpt-sync.env
cd ~/tritonai-code-server/t3code
bun run tritongpt:sync:pr
```

Example cron entry:

```cron
17 */6 * * * bash -lc 'source ~/.tritongpt-sync.env && cd ~/tritonai-code-server/t3code && git fetch --all --prune && bun run tritongpt:sync:pr >> ~/logs/tritongpt-sync-cron.log 2>&1'
```

Do not enable the cron job until one manual `tritongpt:sync:review` and one manual `tritongpt:sync:pr` have produced the expected result.

## Agent Review Mode

Preferred mode is agent review. The script owns the git mechanics and the agent works inside the temporary sync worktree.

Recommended DSMLP env shape:

```sh
export T3_SYNC_REVIEW_MODE="agent"
export T3_SYNC_AGENT_COMMAND='opencode run "$(cat "$T3_SYNC_AGENT_PROMPT_FILE")" > "$T3_SYNC_AGENT_RESPONSE_FILE"'
export T3_SYNC_AGENT_CAN_EDIT="0"
```

Set `T3_SYNC_AGENT_CAN_EDIT=1` only after manual test runs are behaving correctly. With edit mode enabled, the agent may resolve merge conflicts or fix check failures inside the temporary worktree. The script then commits those agent changes onto the generated `sync/upstream-*` branch, reruns checks, and still refuses auto-merge unless checks pass and the agent returns `auto_merge: true`.

The agent command receives these environment variables:

- `T3_SYNC_AGENT_PHASE`: `merge-review` or `conflict-resolution`
- `T3_SYNC_AGENT_PROMPT_FILE`: prompt and context file
- `T3_SYNC_AGENT_RESPONSE_FILE`: where the agent should write final JSON
- `T3_SYNC_AGENT_CAN_EDIT`: `0` or `1`

The final response must be JSON:

```json
{
  "auto_merge": false,
  "reason": "short reason",
  "summary": "what happened",
  "risks": ["risk or follow-up"]
}
```

## LiteLLM Direct Mode

LiteLLM direct mode is still available for simple classification:

```sh
export T3_SYNC_REVIEW_MODE="litellm"
export LITELLM_BASE_URL="https://your-litellm-base"
export LITELLM_API_KEY="..."
```

This mode sends the merge/check summary directly to `/v1/chat/completions`. It does not let a coding agent edit files.

## Hard Gates

The script refuses or stops when:

- Git has merge conflicts.
- Checks fail.
- Review is not configured.
- The reviewer says the merge is risky.

Even in agent mode, review does not replace checks. Agent edits are only useful if the final worktree passes the configured check command.

## Branch Flow

The intended branch flow is:

```text
pingdotgg/t3code main
        |
        v
dbalders/t3code tritongpt
        |
        v
sync/upstream-* temporary branches / PRs
```

`main` in the fork should remain close to upstream. `tritongpt` is where we carry our downstream branding and release control.

The old `codex/tritongpt-branding` branch is reference material only. The new branding work should start fresh on `tritongpt`.

## Release Control

The installer should eventually pull release assets from `dbalders/t3code`, not `pingdotgg/t3code`.

That switch should only happen after `dbalders/t3code` publishes compatible Electron release assets:

- `latest-mac.yml`
- `latest.yml`
- macOS `.dmg`
- Windows `.exe`
- `.blockmap` files

Branches are for source integration. GitHub Releases are for the installer and app updater.

## DSMLP Limit

DSMLP is good for fetch, merge, checks, LiteLLM review, and PR creation.

DSMLP is not the final macOS release builder. Signed/notarized macOS DMGs need this Mac, a Mac mini, or a macOS self-hosted runner.
