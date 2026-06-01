import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { describe, expect, it } from "vitest";
import {
  buildPullRequestBody,
  isSecretEnvName,
  labelsForReport,
  makeSanitizedChildEnv,
  managedLabels,
  parseArgs,
  parseCsv,
  parseJsonObject,
  trimTrailingSlash,
} from "./tritongpt-sync-upstream.mjs";

describe("tritongpt upstream sync helpers", () => {
  it("parses CLI flags without executing the sync script", () => {
    expect(
      parseArgs([
        "--push",
        "--create-pr",
        "--auto-merge",
        "--auto-merge-pr",
        "--keep-branch",
        "--skip-checks",
        "--no-llm",
        "--allow-needs-review",
        "--update-mirror",
      ]),
    ).toEqual({
      push: true,
      createPr: true,
      autoMerge: true,
      autoMergePr: true,
      keepBranch: true,
      skipChecks: true,
      noLlm: true,
      allowNeedsReview: true,
      updateMirror: true,
    });
    expect(parseArgs(["--unknown"])).toEqual({
      push: false,
      createPr: false,
      autoMerge: false,
      autoMergePr: false,
      keepBranch: false,
      skipChecks: false,
      noLlm: false,
      allowNeedsReview: false,
      updateMirror: false,
    });
  });

  it("normalizes CSV values and trailing slashes", () => {
    expect(parseCsv(" TRITONAI_API_KEY, ,CUSTOM_SECRET,normal ")).toEqual([
      "TRITONAI_API_KEY",
      "CUSTOM_SECRET",
      "normal",
    ]);
    expect(trimTrailingSlash("https://litellm.example.test///")).toBe(
      "https://litellm.example.test",
    );
    expect(trimTrailingSlash("")).toBe("");
  });

  it("classifies secret-like environment names", () => {
    expect(isSecretEnvName("TRITONAI_API_KEY")).toBe(true);
    expect(isSecretEnvName("CUSTOM_PRIVATE_KEY")).toBe(true);
    expect(isSecretEnvName("service_password")).toBe(true);
    expect(isSecretEnvName("LITELLM_BASE_URL")).toBe(true);
    expect(isSecretEnvName("PATH")).toBe(false);
    expect(isSecretEnvName("OPENCODE_CONFIG")).toBe(false);
  });

  it("strips secret-like child env values by default", () => {
    expect(
      makeSanitizedChildEnv({
        sourceEnv: {
          PATH: "/usr/bin",
          OPENCODE_CONFIG: "/tmp/opencode.json",
          TRITONAI_API_KEY: "triton-secret",
          GH_TOKEN: "gh-secret",
          GITHUB_TOKEN: "github-secret",
          SSH_AUTH_SOCK: "/tmp/ssh.sock",
          LITELLM_API_KEY: "litellm-secret",
          LITELLM_BASE_URL: "https://litellm.example.test",
          CUSTOM_TOKEN: "custom-secret",
          DATABASE_PASSWORD: "password-secret",
        },
      }),
    ).toEqual({
      PATH: "/usr/bin",
      OPENCODE_CONFIG: "/tmp/opencode.json",
    });
  });

  it("passes TRITONAI_API_KEY only when allowlisted while protected credentials stay stripped", () => {
    const childEnv = makeSanitizedChildEnv({
      allowSecretNames: [
        "TRITONAI_API_KEY",
        "GH_TOKEN",
        "GITHUB_TOKEN",
        "SSH_AUTH_SOCK",
        "LITELLM_API_KEY",
        "LITELLM_BASE_URL",
      ],
      sourceEnv: {
        PATH: "/usr/bin",
        TRITONAI_API_KEY: "triton-secret",
        GH_TOKEN: "gh-secret",
        GITHUB_TOKEN: "github-secret",
        SSH_AUTH_SOCK: "/tmp/ssh.sock",
        LITELLM_API_KEY: "litellm-secret",
        LITELLM_BASE_URL: "https://litellm.example.test",
      },
      extra: {
        T3_SYNC_AGENT_PHASE: "merge-review",
        LITELLM_MODEL: "api-gemma",
      },
    });

    expect(childEnv).toEqual({
      PATH: "/usr/bin",
      TRITONAI_API_KEY: "triton-secret",
      T3_SYNC_AGENT_PHASE: "merge-review",
    });
  });

  it("selects auto-merge and human-review labels from reports", () => {
    expect(labelsForReport({ report: { reason: "safe" }, canAutoMerge: true })).toEqual([
      "automation:upstream-sync",
      "automation:auto-merge-ready",
    ]);

    expect(
      labelsForReport({
        canAutoMerge: false,
        report: {
          reason: "merge-conflicts",
          conflicts: ["package.json"],
          checks: { ok: false },
          review: { reviewer: "agent", phase: "conflict-resolution" },
        },
      }),
    ).toEqual([
      "automation:upstream-sync",
      "needs-human-review",
      "upstream-conflict",
      "checks-failed",
      "agent-attempted",
      "ai-review-risk",
    ]);
  });

  it("builds concise PR bodies with status, reason, checks, conflicts, and risks", () => {
    const body = buildPullRequestBody({
      labels: ["automation:upstream-sync", "needs-human-review", "checks-failed"],
      report: {
        status: "needs-human-review",
        reason: "checks-failed",
        upstreamRef: "upstream/main",
        upstreamSha: "abc123",
        brandRef: "tritongpt",
        brandSha: "def456",
        mergedSha: "789abc",
        checks: { ok: false, command: "bun run lint", output: "lint failed" },
        conflicts: ["package.json"],
        review: {
          summary: "Validation failed after merge.",
          risks: ["Release workflow changed.", "Branding diff needs review."],
        },
        changeSummary: {
          upstreamCommits: "abc123 upstream commit",
          mergedDiffStat: " package.json | 2 +-",
        },
      },
    });

    expect(body).toContain("- Status: `needs-human-review`");
    expect(body).toContain("- Reason: `checks-failed`");
    expect(body).toContain("- Checks: `failed`");
    expect(body).toContain("`package.json`");
    expect(body).toContain("- Release workflow changed.");
    expect(body).toContain("- Branding diff needs review.");
    expect(body).toContain("abc123 upstream commit");
    expect(body).not.toContain("Full automation report");
    expect(body).not.toContain('"reason": "checks-failed"');
    expect(body).toContain("`checks-failed`");
  });

  it("parses strict, fenced, and embedded JSON objects", () => {
    expect(parseJsonObject('{"auto_merge":true,"reason":"safe"}')).toEqual({
      auto_merge: true,
      reason: "safe",
    });
    expect(parseJsonObject('```json\n{"summary":"ok"}\n```')).toEqual({ summary: "ok" });
    expect(parseJsonObject('prefix {"risks":["a"]} suffix')).toEqual({ risks: ["a"] });
    expect(parseJsonObject('{"auto_merge":true}\u0000\u0000extra text with {broken')).toEqual({
      auto_merge: true,
    });
    expect(parseJsonObject("Written review. auto_merge: true - safe to merge.")).toMatchObject({
      auto_merge: true,
      reason: "agent-text-auto-merge",
    });
    expect(parseJsonObject("not json")).toEqual({});
    expect(parseJsonObject(undefined)).toEqual({});
  });

  it("keeps managed sync labels consistent with the issue-label workflow", async () => {
    const workflow = await Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      return yield* fileSystem.readFileString(
        path.join(import.meta.dirname, "../.github/workflows/issue-labels.yml"),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.runPromise);

    for (const label of managedLabels) {
      expect(workflow).toContain(`name: "${label.name}"`);
      expect(workflow).toContain(`color: "${label.color}"`);
      expect(workflow).toContain(`description: "${label.description}"`);
    }
  });
});
