# TritonGPT Sync Automation

This branch adds the automation scaffold for keeping a TritonGPT-branded downstream build of T3 Code under our control.

## Current Point In The Process

The `tritongpt` branch is the controlled downstream branch. It carries TritonGPT branding, OpenCode defaults, and release-control changes on top of upstream `pingdotgg/t3code` `main`.

The automation compares `upstream/main` against `tritongpt`, attempts the merge in a temporary worktree, and only publishes a generated `sync/upstream-*` branch after it has a concrete report.

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
bun run tritongpt:sync:auto
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
cd ~/t3code-server/t3code
bun run tritongpt:sync:review
```

For runs that should let the agent repair the temporary merge, push a sync branch, and open a PR:

```sh
source ~/.tritongpt-sync.env
cd ~/t3code-server/t3code
bun run tritongpt:sync:pr
```

For the fully automated path that should also merge PRs classified as `auto-merge-ready`:

```sh
source ~/.tritongpt-sync.env
cd ~/t3code-server/t3code
bun run tritongpt:sync:auto
```

Example daily cron entry:

```cron
17 11 * * * bash -lc 'source ~/.tritongpt-sync.env && cd ~/t3code-server/t3code && git fetch --all --prune && bun run tritongpt:sync:auto >> ~/logs/tritongpt-sync-cron.log 2>&1'
```

Do not enable the auto-merge cron job until one manual synthetic agent test and one manual `tritongpt:sync:auto` run have produced the expected result. Use `bun run tritongpt:sync:pr` instead if you want PR creation without automated merging.

## Agent Review Mode

Preferred mode is agent review. The script owns the git mechanics and the agent works inside the temporary sync worktree.

Recommended DSMLP env shape:

```sh
export OPENCODE_CONFIG="$HOME/.config/opencode/opencode.json"
export T3_SYNC_REVIEW_MODE="agent"
export T3_SYNC_AGENT_MODEL="ucsd/deepseek-v4-flash-max"
export T3_SYNC_AGENT_COMMAND='OPENCODE_CONFIG="$HOME/.config/opencode/opencode.json" opencode run --model "${T3_SYNC_AGENT_MODEL:-ucsd/deepseek-v4-flash-max}" "$(cat "$T3_SYNC_AGENT_PROMPT_FILE")" > "$T3_SYNC_AGENT_RESPONSE_FILE"'
export T3_SYNC_AGENT_CAN_EDIT="1"
export T3_SYNC_AGENT_SECRET_ENV_ALLOWLIST="TRITONAI_API_KEY"
```

With edit mode enabled, the agent may resolve merge conflicts or fix check failures inside the temporary worktree. The script keeps the generated `sync/upstream-*` branch to one squashed sync commit, reruns checks, pushes the branch, and opens a PR when `tritongpt:sync:pr` is used.

The agent still does not push, create PRs, or merge `tritongpt`. The script owns publishing. In `tritongpt:sync:auto`, the script merges the PR only after local checks pass and the agent returns `auto_merge=true`.

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

If conflicts remain after the agent attempts a repair, the script aborts the conflicted merge, creates an empty marker commit on the generated `sync/upstream-*` branch, opens a PR, and labels it for human review. That PR is a triage container; a human can push a real follow-up fix to the same branch. If the agent resolves the conflict, the PR contains the resolved file diff as one sync commit.

## Labels

Generated PRs always get `automation:upstream-sync`. Additional labels describe the outcome:

- `automation:auto-merge-ready`: checks passed and AI review allowed merge.
- `needs-human-review`: automation could not safely merge.
- `upstream-conflict`: merge conflicts were present.
- `checks-failed`: local validation failed.
- `ai-review-risk`: AI review refused or could not classify the merge as safe.
- `agent-attempted`: OpenCode attempted review or repair.

## Secret Handling

The sync script deliberately removes GitHub tokens, LiteLLM credentials, SSH agent access, and generic token/password/API-key variables from the check subprocess environment. OpenCode agent runs also receive a stripped environment; only names in `T3_SYNC_AGENT_SECRET_ENV_ALLOWLIST` are passed through for model access. The default allowlist is `TRITONAI_API_KEY`.

This keeps upstream package scripts from seeing GitHub credentials during `bun run fmt:check`, `bun run lint`, `bun run typecheck`, `bun run test`, and `bun run release:smoke`.

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
