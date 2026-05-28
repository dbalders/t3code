#!/usr/bin/env bash
set -euo pipefail

repo_url="${T3_SYNC_REPO_URL:-https://github.com/dbalders/t3code.git}"
default_repo_dir="$HOME/t3code-server/t3code"
if git rev-parse --show-toplevel >/dev/null 2>&1; then
  default_repo_dir="$(git rev-parse --show-toplevel)"
fi
repo_dir="${T3_SYNC_REPO_DIR:-$default_repo_dir}"
workspace="${T3_SYNC_WORKSPACE:-$(dirname "$repo_dir")}"
env_file="${T3_SYNC_ENV_FILE:-$HOME/.tritongpt-sync.env}"
brand_branch="${T3_SYNC_BRAND_BRANCH:-tritongpt}"

mkdir -p "$workspace" "$HOME/logs" "$HOME/bin"

if ! command -v git >/dev/null 2>&1; then
  echo "git is required in this DSMLP image." >&2
  exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "Installing Bun into the user home..."
  curl -fsSL https://bun.sh/install | bash
fi

export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export PATH="$BUN_INSTALL/bin:$PATH"

if ! command -v bun >/dev/null 2>&1; then
  echo "Bun is still not on PATH after install. Check $HOME/.bun/bin." >&2
  exit 1
fi

if [[ ! -d "$repo_dir/.git" ]]; then
  git clone "$repo_url" "$repo_dir"
fi

cd "$repo_dir"

git remote set-url origin "$repo_url"
git remote add upstream https://github.com/pingdotgg/t3code.git 2>/dev/null || true
git remote set-url upstream https://github.com/pingdotgg/t3code.git
git fetch --all --prune

current_branch="$(git branch --show-current || true)"

if git show-ref --verify --quiet "refs/remotes/origin/$brand_branch"; then
  git branch --force "$brand_branch" "origin/$brand_branch"
elif git show-ref --verify --quiet "refs/heads/$brand_branch"; then
  true
else
  git branch --force "$brand_branch" upstream/main
fi

if [[ -n "$current_branch" ]]; then
  git checkout "$current_branch"
fi

if [[ ! -f "$env_file" ]]; then
  cat > "$env_file" <<'ENVEOF'
# Private DSMLP TritonGPT sync settings. Keep this file out of git.
export LITELLM_BASE_URL="https://your-litellm.example.edu"
export LITELLM_API_KEY="replace-me"
export T3_SYNC_LITELLM_MODEL="api-gemma-4-26b"
export T3_SYNC_BRAND_BRANCH="tritongpt"
export T3_SYNC_CHECKS="bun run lint && bun run typecheck && bun run test && bun run release:smoke"
ENVEOF
  chmod 600 "$env_file"
  echo "Wrote private env template at $env_file. Edit it with your real LiteLLM values before running review/PR mode."
fi

bun install --frozen-lockfile

echo
echo "Running dry sync check..."
bun run tritongpt:sync:check

cat <<EOF

DSMLP TritonGPT sync workspace is ready.

Next manual review run:
  source "$env_file"
  cd "$repo_dir"
  bun run tritongpt:sync:review 2>&1 | tee "$HOME/logs/tritongpt-sync-\$(date +%F-%H%M).log"

Open a PR from DSMLP after review:
  source "$env_file"
  cd "$repo_dir"
  bun run tritongpt:sync:pr

EOF
