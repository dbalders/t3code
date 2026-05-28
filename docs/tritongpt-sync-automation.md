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

The sync script is the real automation target. It fetches `upstream/main`, compares it with `tritongpt`, attempts a merge in a temporary worktree, runs checks, and optionally asks LiteLLM whether the merge is safe.

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

## LiteLLM Role

LiteLLM is only the review layer. It does not replace hard gates.

The script refuses or stops when:

- Git has merge conflicts.
- Checks fail.
- LiteLLM is not configured.
- LiteLLM says the merge is risky.

LiteLLM receives a structured summary of commits, diffs, check output, and merge status. It returns JSON saying whether the merge is safe enough to proceed or needs human review.

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
