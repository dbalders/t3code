import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  createBuildConfig,
  resolveDesktopRuntimeDependencies,
  resolveBuildOptions,
  resolveDesktopBuildIconAssets,
  resolveDesktopPublishConfig,
  resolveDesktopUpdateRepository,
  resolveDesktopProductName,
  resolveDesktopUpdateChannel,
  resolveGitHubPublishConfig,
  resolveMockUpdateServerPort,
  resolveMockUpdateServerUrl,
} from "./build-desktop-artifact.ts";
import { BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";

function withDesktopUpdateRepositoryEnv(value: string | undefined, fn: () => void) {
  const previous = process.env.T3CODE_DESKTOP_UPDATE_REPOSITORY;
  try {
    if (value === undefined) {
      delete process.env.T3CODE_DESKTOP_UPDATE_REPOSITORY;
    } else {
      process.env.T3CODE_DESKTOP_UPDATE_REPOSITORY = value;
    }
    fn();
  } finally {
    if (previous === undefined) {
      delete process.env.T3CODE_DESKTOP_UPDATE_REPOSITORY;
    } else {
      process.env.T3CODE_DESKTOP_UPDATE_REPOSITORY = previous;
    }
  }
}

it.layer(NodeServices.layer)("build-desktop-artifact", (it) => {
  it("resolves the dedicated nightly updater channel from nightly versions", () => {
    assert.equal(resolveDesktopUpdateChannel("0.0.17-nightly.20260413.42"), "nightly");
    assert.equal(resolveDesktopUpdateChannel("0.0.17"), "latest");
  });

  it("switches desktop packaging product names to nightly for nightly builds", () => {
    assert.equal(resolveDesktopProductName("0.0.17"), "TritonAI Code");
    assert.equal(
      resolveDesktopProductName("0.0.17-nightly.20260413.42"),
      "TritonAI Code (Nightly)",
    );
  });

  it.effect("keeps Windows resource editing enabled for unsigned local builds", () =>
    Effect.gen(function* () {
      const buildConfig = yield* createBuildConfig(
        "win",
        "nsis",
        "0.0.17",
        false,
        false,
        undefined,
      );

      const winConfig = buildConfig.win as Record<string, unknown>;
      assert.equal(buildConfig.productName, "TritonAI Code");
      assert.equal(winConfig.icon, "icon.ico");
      assert.equal(winConfig.signAndEditExecutable, undefined);
    }),
  );

  it("switches desktop packaging icons to the nightly artwork for nightly versions", () => {
    assert.deepStrictEqual(resolveDesktopBuildIconAssets("0.0.17"), {
      macIconPng: BRAND_ASSET_PATHS.productionMacIconPng,
      linuxIconPng: BRAND_ASSET_PATHS.productionLinuxIconPng,
      windowsIconIco: BRAND_ASSET_PATHS.productionWindowsIconIco,
    });

    assert.deepStrictEqual(resolveDesktopBuildIconAssets("0.0.17-nightly.20260413.42"), {
      macIconPng: BRAND_ASSET_PATHS.nightlyMacIconPng,
      linuxIconPng: BRAND_ASSET_PATHS.nightlyLinuxIconPng,
      windowsIconIco: BRAND_ASSET_PATHS.nightlyWindowsIconIco,
    });
  });

  it("defaults desktop updater releases to the controlled downstream repository", () => {
    withDesktopUpdateRepositoryEnv(undefined, () => {
      assert.equal(resolveDesktopUpdateRepository(), "dbalders/t3code");
      assert.deepStrictEqual(resolveGitHubPublishConfig("latest"), {
        provider: "github",
        owner: "dbalders",
        repo: "t3code",
        releaseType: "release",
      });
    });
  });

  it("keeps the explicit desktop updater repository override for test feeds", () => {
    withDesktopUpdateRepositoryEnv("example/custom-updates", () => {
      assert.equal(resolveDesktopUpdateRepository(), "example/custom-updates");
      assert.deepStrictEqual(resolveGitHubPublishConfig("nightly"), {
        provider: "github",
        owner: "example",
        repo: "custom-updates",
        releaseType: "prerelease",
        channel: "nightly",
      });
    });
  });

  it("uses the generic mock update server when mock updates are enabled", () => {
    withDesktopUpdateRepositoryEnv(undefined, () => {
      assert.deepStrictEqual(resolveDesktopPublishConfig("latest", true, 4123), [
        {
          provider: "generic",
          url: "http://localhost:4123",
        },
      ]);
    });
  });

  it("omits bundled workspace packages from staged desktop dependencies", () => {
    assert.deepStrictEqual(
      resolveDesktopRuntimeDependencies(
        {
          "@effect/platform-node": "catalog:",
          "@t3tools/contracts": "workspace:*",
          "@t3tools/shared": "workspace:*",
          "@t3tools/ssh": "workspace:*",
          "@t3tools/tailscale": "workspace:*",
          effect: "catalog:",
          electron: "41.5.0",
        },
        {
          "@effect/platform-node": "4.0.0-beta.59",
          effect: "4.0.0-beta.59",
        },
      ),
      {
        "@effect/platform-node": "4.0.0-beta.59",
        effect: "4.0.0-beta.59",
      },
    );
  });

  it("falls back to the default mock update port when the configured port is blank", () => {
    assert.equal(resolveMockUpdateServerUrl(undefined), "http://localhost:3000");
    assert.equal(resolveMockUpdateServerUrl(4123), "http://localhost:4123");
  });

  it.effect("normalizes mock update server ports from env-style strings", () =>
    Effect.gen(function* () {
      assert.equal(yield* resolveMockUpdateServerPort(undefined), undefined);
      assert.equal(yield* resolveMockUpdateServerPort(""), undefined);
      assert.equal(yield* resolveMockUpdateServerPort("   "), undefined);
      assert.equal(yield* resolveMockUpdateServerPort("4123"), 4123);
    }),
  );

  it.effect("rejects non-numeric or out-of-range mock update ports", () =>
    Effect.gen(function* () {
      const invalidPorts = ["abc", "12.5", "0", "65536"];
      for (const port of invalidPorts) {
        const exit = yield* Effect.exit(resolveMockUpdateServerPort(port));
        assert.equal(exit._tag, "Failure");
      }
    }),
  );

  it.effect("preserves explicit false boolean flags over true env defaults", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveBuildOptions({
        platform: Option.some("mac"),
        target: Option.none(),
        arch: Option.some("arm64"),
        buildVersion: Option.none(),
        outputDir: Option.some("release-test"),
        skipBuild: Option.some(false),
        keepStage: Option.some(false),
        signed: Option.some(false),
        verbose: Option.some(false),
        mockUpdates: Option.some(false),
        mockUpdateServerPort: Option.none(),
      }).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                T3CODE_DESKTOP_SKIP_BUILD: "true",
                T3CODE_DESKTOP_KEEP_STAGE: "true",
                T3CODE_DESKTOP_SIGNED: "true",
                T3CODE_DESKTOP_VERBOSE: "true",
                T3CODE_DESKTOP_MOCK_UPDATES: "true",
              },
            }),
          ),
        ),
      );

      assert.equal(resolved.skipBuild, false);
      assert.equal(resolved.keepStage, false);
      assert.equal(resolved.signed, false);
      assert.equal(resolved.verbose, false);
      assert.equal(resolved.mockUpdates, false);
    }),
  );
});
