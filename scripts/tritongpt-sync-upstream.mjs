#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const options = parseArgs(process.argv.slice(2));

const config = {
  originRemote: env("T3_SYNC_ORIGIN_REMOTE", "origin"),
  upstreamRemote: env("T3_SYNC_UPSTREAM_REMOTE", "upstream"),
  upstreamBranch: env("T3_SYNC_UPSTREAM_BRANCH", "main"),
  mirrorBranch: env("T3_SYNC_MIRROR_BRANCH", "main"),
  brandBranch: env("T3_SYNC_BRAND_BRANCH", "tritongpt"),
  branchPrefix: env("T3_SYNC_BRANCH_PREFIX", "sync/upstream"),
  checks: env(
    "T3_SYNC_CHECKS",
    "bun run fmt:check && bun run lint && bun run typecheck && bun run test && bun run release:smoke",
  ),
  liteLlmBaseUrl: trimTrailingSlash(env("LITELLM_BASE_URL", "")),
  liteLlmApiKey: env("LITELLM_API_KEY", ""),
  liteLlmModel: env("T3_SYNC_LITELLM_MODEL", env("LITELLM_MODEL", "api-gemma-4-26b")),
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});

async function main() {
  ensureRemote(config.originRemote);
  ensureRemote(config.upstreamRemote);

  runGit(["fetch", "--prune", config.originRemote]);
  runGit(["fetch", "--prune", config.upstreamRemote]);

  const upstreamRef = `${config.upstreamRemote}/${config.upstreamBranch}`;
  const brandRef = resolveBrandRef();
  const upstreamSha = gitStdout(["rev-parse", upstreamRef]);
  const brandSha = gitStdout(["rev-parse", brandRef]);

  if (isAncestor(upstreamSha, brandSha)) {
    console.log(JSON.stringify({
      status: "already-current",
      upstreamRef,
      upstreamSha,
      brandRef,
      brandSha,
    }, null, 2));
    return;
  }

  if (options.updateMirror) {
    updateLocalMirror(upstreamRef);
  }

  const shortSha = upstreamSha.slice(0, 12);
  const dateStamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const syncBranch = `${config.branchPrefix}-${dateStamp}-${shortSha}`;
  const worktree = mkdtempSync(join(tmpdir(), "tritongpt-sync-"));
  const reportPath = join(worktree, "tritongpt-sync-report.json");

  try {
    runGit(["worktree", "add", "-B", syncBranch, worktree, brandRef]);

    const merge = spawnGit(["merge", "--no-edit", upstreamRef], { cwd: worktree });
    if (merge.status !== 0) {
      const conflicts = gitStdout(["diff", "--name-only", "--diff-filter=U"], {
        cwd: worktree,
        allowFailure: true,
      }).split("\n").filter(Boolean);
      const status = gitStdout(["status", "--short"], { cwd: worktree, allowFailure: true });
      spawnGit(["merge", "--abort"], { cwd: worktree, allowFailure: true });

      const report = {
        status: "needs-human-review",
        reason: "merge-conflicts",
        syncBranch,
        upstreamRef,
        upstreamSha,
        brandRef,
        brandSha,
        conflicts,
        gitStatus: status,
      };
      writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = 2;
      return;
    }

    const mergedSha = gitStdout(["rev-parse", "HEAD"], { cwd: worktree });
    const changeSummary = collectChangeSummary({ worktree, upstreamRef, brandRef });
    const checkResult = options.skipChecks
      ? { ok: true, skipped: true, output: "Checks skipped by --skip-checks." }
      : runChecks(worktree);
    const review = await reviewWithLiteLlm({
      changeSummary,
      checkResult,
      upstreamRef,
      upstreamSha,
      brandRef,
      brandSha,
      mergedSha,
    });

    const canAutoMerge = checkResult.ok && review.autoMerge === true;
    const report = {
      status: canAutoMerge ? "auto-merge-ready" : "needs-human-review",
      reason: canAutoMerge ? "clean-merge-checks-and-review" : review.reason,
      syncBranch,
      upstreamRef,
      upstreamSha,
      brandRef,
      brandSha,
      mergedSha,
      checks: {
        ok: checkResult.ok,
        skipped: checkResult.skipped === true,
      },
      review,
      changeSummary,
    };

    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));

    if (options.push) {
      runGit(["push", config.originRemote, `${syncBranch}:${syncBranch}`], { cwd: worktree });
      console.log(`Pushed ${syncBranch} to ${config.originRemote}.`);
    }

    if (options.createPr) {
      createPullRequest({ cwd: worktree, syncBranch, reportPath, report });
    }

    if (options.autoMerge) {
      if (!canAutoMerge) {
        console.error("Refusing --auto-merge because the report is not auto-merge-ready.");
        process.exitCode = 3;
        return;
      }

      if (!options.push) {
        console.error("Refusing --auto-merge without --push.");
        process.exitCode = 3;
        return;
      }

      runGit(["push", config.originRemote, `HEAD:refs/heads/${config.brandBranch}`], { cwd: worktree });
      console.log(`Updated ${config.originRemote}/${config.brandBranch} to ${mergedSha}.`);
    }

    if (!canAutoMerge) {
      process.exitCode = 2;
    }
  } finally {
    runGit(["worktree", "remove", "--force", worktree], { allowFailure: true });
    if (!options.keepBranch) {
      runGit(["branch", "--delete", "--force", syncBranch], { allowFailure: true });
    }
    rmSync(worktree, { recursive: true, force: true });
  }
}

function parseArgs(args) {
  return {
    push: args.includes("--push"),
    createPr: args.includes("--create-pr"),
    autoMerge: args.includes("--auto-merge"),
    keepBranch: args.includes("--keep-branch"),
    skipChecks: args.includes("--skip-checks"),
    noLlm: args.includes("--no-llm"),
    updateMirror: args.includes("--update-mirror"),
  };
}

function env(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function ensureRemote(remote) {
  const remotes = gitStdout(["remote"]).split("\n").filter(Boolean);
  if (!remotes.includes(remote)) {
    throw new Error(`Missing git remote '${remote}'.`);
  }
}

function resolveBrandRef() {
  const localExists = spawnGit(["rev-parse", "--verify", "--quiet", config.brandBranch], {
    allowFailure: true,
  }).status === 0;
  if (localExists) return config.brandBranch;

  const remoteRef = `${config.originRemote}/${config.brandBranch}`;
  const remoteExists = spawnGit(["rev-parse", "--verify", "--quiet", remoteRef], {
    allowFailure: true,
  }).status === 0;
  if (remoteExists) return remoteRef;

  throw new Error(`Could not resolve branded branch '${config.brandBranch}'.`);
}

function updateLocalMirror(upstreamRef) {
  runGit(["branch", "--force", config.mirrorBranch, upstreamRef]);
  if (options.push) {
    runGit(["push", config.originRemote, `${upstreamRef}:refs/heads/${config.mirrorBranch}`]);
  }
}

function isAncestor(ancestor, descendant) {
  return spawnGit(["merge-base", "--is-ancestor", ancestor, descendant], {
    allowFailure: true,
  }).status === 0;
}

function collectChangeSummary({ worktree, upstreamRef, brandRef }) {
  return {
    upstreamCommits: gitStdout(["log", "--oneline", "--decorate", "--max-count=80", `${brandRef}..${upstreamRef}`], {
      cwd: worktree,
      allowFailure: true,
    }),
    mergedDiffStat: gitStdout(["diff", "--stat", `${brandRef}..HEAD`], {
      cwd: worktree,
      allowFailure: true,
    }),
    mergedNameStatus: gitStdout(["diff", "--name-status", `${brandRef}..HEAD`], {
      cwd: worktree,
      allowFailure: true,
    }),
    downstreamPatchNameStatus: gitStdout(["diff", "--name-status", `${upstreamRef}..HEAD`], {
      cwd: worktree,
      allowFailure: true,
    }),
  };
}

function runChecks(cwd) {
  const result = spawnSync("/bin/sh", ["-lc", config.checks], {
    cwd,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  const output = truncate(`${result.stdout || ""}\n${result.stderr || ""}`, 20000);
  return {
    ok: result.status === 0,
    skipped: false,
    command: config.checks,
    output,
  };
}

async function reviewWithLiteLlm(context) {
  if (options.noLlm) {
    return {
      autoMerge: false,
      reason: "llm-review-disabled",
      summary: "LiteLLM review was disabled by --no-llm.",
      risks: ["No AI review was performed."],
    };
  }

  if (!config.liteLlmBaseUrl || !config.liteLlmApiKey) {
    return {
      autoMerge: false,
      reason: "missing-litellm-config",
      summary: "Set LITELLM_BASE_URL and LITELLM_API_KEY to enable AI review.",
      risks: ["No AI review was performed."],
    };
  }

  const body = {
    model: config.liteLlmModel,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: [
          "You review downstream TritonGPT Code merges from upstream T3 Code.",
          "Return strict JSON with keys: auto_merge boolean, reason string, summary string, risks string array.",
          "Set auto_merge=false for failed checks, merge conflicts, unclear release/updater/signing changes, or branding regressions.",
        ].join(" "),
      },
      {
        role: "user",
        content: truncate(JSON.stringify({
          upstreamRef: context.upstreamRef,
          upstreamSha: context.upstreamSha,
          brandRef: context.brandRef,
          brandSha: context.brandSha,
          mergedSha: context.mergedSha,
          checks: {
            ok: context.checkResult.ok,
            skipped: context.checkResult.skipped,
            command: context.checkResult.command,
            output: context.checkResult.output,
          },
          changeSummary: context.changeSummary,
        }, null, 2), 60000),
      },
    ],
  };

  const response = await fetch(`${config.liteLlmBaseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.liteLlmApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    return {
      autoMerge: false,
      reason: "litellm-request-failed",
      summary: `LiteLLM returned HTTP ${response.status}.`,
      risks: [truncate(await response.text(), 1000)],
    };
  }

  const json = await response.json();
  const content = json?.choices?.[0]?.message?.content;
  const parsed = parseJsonObject(content);
  return {
    autoMerge: parsed.auto_merge === true || parsed.autoMerge === true,
    reason: String(parsed.reason || "litellm-review"),
    summary: String(parsed.summary || ""),
    risks: Array.isArray(parsed.risks) ? parsed.risks.map(String) : [],
    model: config.liteLlmModel,
  };
}

function parseJsonObject(content) {
  if (typeof content !== "string") return {};
  const trimmed = content.trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    return {};
  }
}

function createPullRequest({ cwd, syncBranch, reportPath, report }) {
  const gh = spawnSync("gh", ["--version"], { encoding: "utf8" });
  if (gh.status !== 0) {
    console.error("GitHub CLI is not available; skipping PR creation.");
    return;
  }

  const title = `Sync upstream T3 Code into TritonGPT (${report.upstreamSha.slice(0, 12)})`;
  const result = spawnSync("gh", [
    "pr",
    "create",
    "--base",
    config.brandBranch,
    "--head",
    syncBranch,
    "--title",
    title,
    "--body-file",
    reportPath,
  ], {
    cwd,
    encoding: "utf8",
    stdio: "inherit",
  });

  if (result.status !== 0) {
    throw new Error("gh pr create failed.");
  }
}

function runGit(args, opts = {}) {
  const result = spawnGit(args, opts);
  if (result.status !== 0 && !opts.allowFailure) {
    throw new Error(`git ${args.join(" ")} failed with exit code ${result.status}.`);
  }
  return result;
}

function spawnGit(args, opts = {}) {
  return spawnSync("git", args, {
    cwd: opts.cwd || repoRoot,
    encoding: "utf8",
    stdio: opts.stdio || ["ignore", "pipe", "pipe"],
  });
}

function gitStdout(args, opts = {}) {
  try {
    return execFileSync("git", args, {
      cwd: opts.cwd || repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", opts.allowFailure ? "pipe" : "inherit"],
      maxBuffer: 20 * 1024 * 1024,
    }).trim();
  } catch (error) {
    if (opts.allowFailure) return "";
    throw error;
  }
}

function truncate(value, maxLength) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n... truncated ${value.length - maxLength} chars ...`;
}
