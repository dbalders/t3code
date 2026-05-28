# TritonGPT Downstream Operations

This repo is the controlled downstream of upstream T3 Code.

## Branch Structure

- `upstream/main`: upstream source from `https://github.com/pingdotgg/t3code.git`.
- `main`: mirror of upstream `main` in `dbalders/t3code`. Keep this clean when practical.
- `tritongpt`: clean downstream branch that starts from current upstream `main`. New branding work should happen here.
- `codex/tritongpt-branding`: old branding attempt. Treat it as reference only; do not base the new downstream branch on it.
- `sync/upstream-*`: generated branches from sync attempts.

Publish the clean downstream branch:

```sh
git checkout tritongpt
git push -u origin tritongpt
```

After that, use `tritongpt` everywhere. Keep `codex/tritongpt-branding` only as historical context until you are comfortable deleting it.

## Local Upstream Sync

The sync script works in a temporary git worktree so the normal checkout stays clean.

Dry orientation run:

```sh
bun run tritongpt:sync:check
```

Full local review run with LiteLLM:

```sh
export LITELLM_BASE_URL="https://your-litellm.example.edu"
export LITELLM_API_KEY="..."
export T3_SYNC_LITELLM_MODEL="api-gemma-4-26b"
bun run tritongpt:sync:review
```

Open a PR when the merge is clean enough to review:

```sh
bun run tritongpt:sync:pr
```

Preferred DSMLP mode uses OpenCode as the repair/review agent:

```sh
export OPENCODE_CONFIG="$HOME/.config/opencode/opencode.json"
export T3_SYNC_REVIEW_MODE="agent"
export T3_SYNC_AGENT_COMMAND='OPENCODE_CONFIG="$HOME/.config/opencode/opencode.json" opencode run "$(cat "$T3_SYNC_AGENT_PROMPT_FILE")" > "$T3_SYNC_AGENT_RESPONSE_FILE"'
export T3_SYNC_AGENT_CAN_EDIT="1"
```

In this mode OpenCode may fix conflicts or failed checks inside the temporary sync worktree. The script still owns pushing the generated `sync/upstream-*` branch and opening the PR, and it does not merge `tritongpt` unless `--auto-merge` is explicitly added.

The script exits with:

- `0`: already current or auto-merge-ready.
- `2`: human review needed.
- `3`: auto-merge was requested but refused.

Useful environment overrides:

- `T3_SYNC_BRAND_BRANCH=tritongpt` for the clean downstream branch.
- `T3_SYNC_CHECKS="bun run lint && bun run typecheck"` for a faster first pass.
- `T3_SYNC_UPSTREAM_REMOTE=upstream`
- `T3_SYNC_UPSTREAM_BRANCH=main`

Do not use `--auto-merge` until the job has run several times and the release branch is protected.

## Optional Self-Hosted GitHub Workflow

`.github/workflows/tritongpt-upstream-sync.yml` wraps the same script for a self-hosted runner. It is manual-dispatch only, uses `runs-on: self-hosted`, and expects these repository secrets if you want AI review:

- `LITELLM_BASE_URL`
- `LITELLM_API_KEY`
- `T3_SYNC_LITELLM_MODEL`

Use DSMLP cron first. The workflow is mainly useful later if you register a self-hosted runner and want GitHub's PR/check UI around the same local automation.

## Release Control

The installer should consume GitHub Release assets from `dbalders/t3code`, not branches. Branches are for source integration; releases are for the `.dmg`, `.exe`, updater metadata, and blockmaps.

For a controlled release:

```sh
git checkout tritongpt
git pull --ff-only origin tritongpt
git tag v0.0.24-ucsd.1
git push origin v0.0.24-ucsd.1
```

Only publish release assets from a branded branch commit. Do not publish upstream `main` as latest for the fork.

Important limitation: DSMLP is Linux. It can run the sync, tests, LiteLLM review, and PR creation, but it cannot produce a signed/notarized macOS DMG. Use a Mac runner or this Mac for macOS release artifacts.

## DSMLP Deployment Plan

UCSD's DSMLP supports SSH login to `dsmlp-login.ucsd.edu`, Kubernetes-backed containers, `kubesh <pod-name>` reconnects, and background/batch pods. If you are off campus, connect to the UCSD VPN first.

Use your known DSMLP username:

```sh
ssh dbalderston@dsmlp-login.ucsd.edu
```

Create or reconnect to a pod:

```sh
kubectl get pods
kubesh t3code
```

If the `t3code` pod does not exist, launch a background container using the image your DSMLP account supports. Start with the standard DSMLP image rather than a custom image:

```sh
launch.sh -b -N t3code
kubesh t3code
```

Inside the pod, create a workspace:

```sh
mkdir -p ~/t3code-server ~/logs ~/bin
cd ~/t3code-server
```

Install user-local basics if missing:

```sh
command -v git
command -v gh || echo "Install GitHub CLI or use git pushes only."
command -v bun || curl -fsSL https://bun.sh/install | bash
```

Load Bun in the current shell if the installer added it to `~/.bashrc`:

```sh
source ~/.bashrc
```

Use the repo bootstrap script when available:

```sh
mkdir -p ~/t3code-server
cd ~/t3code-server
git clone https://github.com/dbalders/t3code.git
cd t3code
bash scripts/dsmlp-bootstrap-tritongpt-sync.sh
```

Manual equivalent:

```sh
git clone https://github.com/dbalders/t3code.git
cd t3code
git remote add upstream https://github.com/pingdotgg/t3code.git 2>/dev/null || true
git fetch --all --prune
git checkout tritongpt
```

Set secrets outside git:

```sh
cat > ~/.tritongpt-sync.env <<'EOF'
export LITELLM_BASE_URL="https://your-litellm.example.edu"
export LITELLM_API_KEY="replace-me"
export T3_SYNC_LITELLM_MODEL="api-gemma-4-26b"
export OPENCODE_CONFIG="$HOME/.config/opencode/opencode.json"
export T3_SYNC_REVIEW_MODE="agent"
export T3_SYNC_AGENT_COMMAND='OPENCODE_CONFIG="$HOME/.config/opencode/opencode.json" opencode run "$(cat "$T3_SYNC_AGENT_PROMPT_FILE")" > "$T3_SYNC_AGENT_RESPONSE_FILE"'
export T3_SYNC_AGENT_CAN_EDIT="1"
export T3_SYNC_BRAND_BRANCH="tritongpt"
export T3_SYNC_CHECKS="bun run lint && bun run typecheck && bun run test && bun run release:smoke"
EOF
chmod 600 ~/.tritongpt-sync.env
```

Run a manual sync:

```sh
source ~/.tritongpt-sync.env
bun install --frozen-lockfile
bun run tritongpt:sync:review 2>&1 | tee ~/logs/tritongpt-sync-$(date +%F-%H%M).log
```

If that works, add a simple cron entry:

```sh
crontab -e
```

Add:

```cron
17 */6 * * * bash -lc 'source ~/.tritongpt-sync.env && cd ~/t3code-server/t3code && git fetch --all --prune && bun run tritongpt:sync:pr >> ~/logs/tritongpt-sync-cron.log 2>&1'
```

Operational rules:

- Keep `LITELLM_API_KEY`, GitHub tokens, Apple signing certs, and npm tokens out of git.
- Let DSMLP create sync PRs; do final macOS release builds on a Mac unless a macOS self-hosted runner is available.
- Do not rely on DSMLP as a permanent scheduler unless UCSD has approved that use. Background pods are time-limited; use DSMLP for manual or batch sync runs, and use a Mac mini/local machine for persistent scheduling.
- Delete idle DSMLP pods when you are done:

```sh
kubectl delete pod t3code
```

## Next Installer Change

After `dbalders/t3code` has a real GitHub Release containing `latest-mac.yml`, `latest.yml`, `.dmg`, `.exe`, and blockmaps, update `Desktop_Installer` to use:

```text
https://github.com/dbalders/t3code/releases/latest/download
```

Do not switch the installer before those assets exist.
