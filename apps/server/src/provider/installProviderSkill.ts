import {
  type ProviderInstanceId,
  ServerInstallProviderSkillInput,
  type ServerInstallProviderSkillResult,
  ServerProviderSkillBundle,
  type ServerProviderSkillBundle as ServerProviderSkillBundleData,
  ServerProviderSkillCatalog,
  type ServerProviderSkillCatalogEntry,
  ServerProviderSkillCatalogError,
  ServerProviderSkillInstallError,
  type ServerProvider,
  type ServerProviderSkill,
  type ServerProviderSkillBundleFile,
} from "@t3tools/contracts";
import { fromYaml } from "@t3tools/shared/schemaYaml";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import * as NodeOS from "node:os";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import {
  DEFAULT_UCSD_SKILL_BUNDLES,
  DEFAULT_UCSD_SKILL_CATALOG,
  DEFAULT_UCSD_SKILL_CATALOG_URL,
} from "./skillCatalogDefaults.ts";
import { registerUcsdOpenCodeSkillPath } from "./opencodeSkillConfig.ts";

const GIT_CLONE_TIMEOUT_MS = 120_000;
const MAX_BUNDLE_FILE_COUNT = 200;
const MAX_BUNDLE_BYTES = 2 * 1024 * 1024;
const MAX_INSTALL_SOURCE_BYTES = MAX_BUNDLE_BYTES + 512 * 1024;
const SAFE_SKILL_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const CATALOG_URL_ENV = "T3CODE_SKILL_CATALOG_URL";

interface NormalizedGitHubUrl {
  readonly cloneUrl: string;
  readonly refAndPathSegments?: ReadonlyArray<string>;
}

const decodeSkillCatalogJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ServerProviderSkillCatalog),
);
const decodeSkillBundleJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ServerProviderSkillBundle),
);
const decodeInstallInput = Schema.decodeUnknownEffect(ServerInstallProviderSkillInput);
const isInstallError = Schema.is(ServerProviderSkillInstallError);
const fallbackBundles: Readonly<Record<string, ServerProviderSkillBundleData>> =
  DEFAULT_UCSD_SKILL_BUNDLES;

const SkillFrontmatter = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
});
const decodeSkillFrontmatter = Schema.decodeUnknownEffect(fromYaml(SkillFrontmatter));

function schemaIssue(error: Schema.SchemaError): string {
  return SchemaIssue.makeFormatterDefault()(error.issue);
}

function catalogError(message: string, cause?: unknown) {
  return new ServerProviderSkillCatalogError({
    message,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function installError(message: string, cause?: unknown) {
  return new ServerProviderSkillInstallError({
    message,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function configuredCatalogUrl(environment: NodeJS.ProcessEnv = process.env): string {
  return environment[CATALOG_URL_ENV]?.trim() || DEFAULT_UCSD_SKILL_CATALOG_URL;
}

function parseUrl(rawUrl: string): URL | null {
  try {
    return new URL(rawUrl.trim());
  } catch {
    return null;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/u.test(normalized)
  );
}

function ensureHttpUrl(rawUrl: string): Effect.Effect<URL, ServerProviderSkillInstallError> {
  const parsed = parseUrl(rawUrl);
  if (!parsed) {
    return installError("Skill source must be an absolute HTTPS URL.");
  }
  if (parsed.protocol === "https:") {
    return Effect.succeed(parsed);
  }
  if (parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname)) {
    return Effect.succeed(parsed);
  }
  return installError(
    "Skill source must be an HTTPS URL. HTTP is only allowed for loopback development sources.",
  );
}

function fetchText(
  url: string,
  errorFactory: (message: string, cause?: unknown) => ServerProviderSkillCatalogError,
): Effect.Effect<string, ServerProviderSkillCatalogError, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    return yield* httpClient
      .execute(
        HttpClientRequest.get(url).pipe(
          HttpClientRequest.setHeader("accept", "application/json, text/plain;q=0.9, */*;q=0.8"),
        ),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.text),
        Effect.mapError((cause) =>
          errorFactory(`Failed to fetch skill catalog resource from ${url}.`, cause),
        ),
      );
  });
}

function fetchInstallText(
  url: string,
): Effect.Effect<string, ServerProviderSkillInstallError, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    return yield* httpClient
      .execute(
        HttpClientRequest.get(url).pipe(
          HttpClientRequest.setHeader(
            "accept",
            "application/json, text/markdown;q=0.9, text/plain;q=0.8, */*;q=0.7",
          ),
        ),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => readLimitedInstallText(url, response)),
        Effect.mapError((cause) =>
          isInstallError(cause)
            ? cause
            : installError(`Failed to fetch skill source from ${url}.`, cause),
        ),
      );
  });
}

function parseContentLengthHeader(value: string | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!/^\d+$/u.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function installSourceTooLarge(url: string) {
  return installError(
    `Skill source from ${url} exceeds the ${MAX_INSTALL_SOURCE_BYTES} byte limit.`,
  );
}

function readLimitedInstallText(url: string, response: HttpClientResponse.HttpClientResponse) {
  const contentLength = parseContentLengthHeader(response.headers["content-length"]);
  if (contentLength !== null && contentLength > MAX_INSTALL_SOURCE_BYTES) {
    return installSourceTooLarge(url);
  }

  const decoder = new TextDecoder();
  return response.stream.pipe(
    Stream.runFoldEffect(
      () => ({ bytes: 0, chunks: [] as string[] }),
      (state, chunk) => {
        const bytes = state.bytes + chunk.byteLength;
        if (bytes > MAX_INSTALL_SOURCE_BYTES) {
          return installSourceTooLarge(url);
        }
        state.chunks.push(decoder.decode(chunk, { stream: true }));
        return Effect.succeed({ bytes, chunks: state.chunks });
      },
    ),
    Effect.map((state) => {
      const tail = decoder.decode();
      return tail ? [...state.chunks, tail].join("") : state.chunks.join("");
    }),
  );
}

export const listProviderSkillCatalog = Effect.fn("listProviderSkillCatalog")(function* (
  environment?: NodeJS.ProcessEnv,
) {
  const url = configuredCatalogUrl(environment);
  const remote = yield* fetchText(url, catalogError).pipe(
    Effect.flatMap((raw) =>
      decodeSkillCatalogJson(raw).pipe(
        Effect.mapError((error) => catalogError(`Skill catalog from ${url} was invalid.`, error)),
      ),
    ),
    Effect.option,
  );

  if (remote._tag === "Some") {
    return {
      catalog: {
        ...remote.value,
        sourceStatus: "remote" as const,
      },
    };
  }

  return {
    catalog: DEFAULT_UCSD_SKILL_CATALOG,
  };
});

function bundleFromSkillMarkdown(
  skillId: string,
  content: string,
): Effect.Effect<ServerProviderSkillBundleData, ServerProviderSkillInstallError> {
  return validateSkillBundle({
    version: 1,
    skillId,
    files: [{ path: "SKILL.md", content }],
  });
}

function loadBundleFromUrl(
  url: string,
): Effect.Effect<
  ServerProviderSkillBundleData,
  ServerProviderSkillInstallError,
  HttpClient.HttpClient
> {
  return fetchInstallText(url).pipe(
    Effect.flatMap((raw) => {
      const trimmed = raw.trimStart();
      if (trimmed.startsWith("{")) {
        return decodeSkillBundleJson(raw).pipe(
          Effect.mapError((error) =>
            installError(`Skill bundle from ${url} was invalid: ${schemaIssue(error)}`, error),
          ),
          Effect.flatMap(validateSkillBundle),
        );
      }
      return bundleFromSkillMarkdown(url, raw);
    }),
  );
}

function validateCatalogEntryBundle(
  entry: ServerProviderSkillCatalogEntry,
  bundle: ServerProviderSkillBundleData,
): Effect.Effect<ServerProviderSkillBundleData, ServerProviderSkillInstallError> {
  return Effect.gen(function* () {
    const entrypoint = bundle.files.find((file) => file.path.replace(/\\/gu, "/") === "SKILL.md");
    if (!entrypoint) {
      return yield* installError("Skill bundle must contain SKILL.md at its root.");
    }
    const frontmatter = yield* extractFrontmatter(entrypoint.content);
    const expectedNames = new Set([entry.id, entry.name]);
    if (!expectedNames.has(bundle.skillId) || !expectedNames.has(frontmatter.name)) {
      return yield* installError(
        `Catalog entry '${entry.id}' does not match fetched skill bundle '${frontmatter.name}'.`,
      );
    }
    return bundle;
  });
}

function fallbackBundleForCatalogEntry(
  entry: ServerProviderSkillCatalogEntry,
): Effect.Effect<ServerProviderSkillBundleData, ServerProviderSkillInstallError> {
  const fallback = fallbackBundles[entry.id];
  if (!fallback) {
    return installError("The selected catalog skill is not available in the bundled fallback.");
  }
  return validateSkillBundle(fallback).pipe(
    Effect.flatMap((bundle) => validateCatalogEntryBundle(entry, bundle)),
  );
}

function loadBundleForCatalogEntry(
  catalogEntryId: string,
  environment?: NodeJS.ProcessEnv,
): Effect.Effect<
  ServerProviderSkillBundleData,
  ServerProviderSkillInstallError,
  HttpClient.HttpClient
> {
  return listProviderSkillCatalog(environment).pipe(
    Effect.flatMap(({ catalog }) => {
      const entry = catalog.entries.find((candidate) => candidate.id === catalogEntryId);
      if (!entry) {
        return installError("The selected catalog skill was not found.");
      }
      if (catalog.sourceStatus === "bundled-fallback") {
        return fallbackBundleForCatalogEntry(entry);
      }
      return loadBundleFromUrl(entry.sourceUrl).pipe(
        Effect.catch(() => fallbackBundleForCatalogEntry(entry)),
        Effect.flatMap((bundle) => validateCatalogEntryBundle(entry, bundle)),
      );
    }),
  );
}

function normalizeGitHubUrl(rawUrl: string): NormalizedGitHubUrl | null {
  const parsed = parseUrl(rawUrl);
  if (!parsed || parsed.hostname.toLowerCase() !== "github.com") return null;
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length < 2) return null;

  const [owner, rawRepo] = segments;
  const repo = rawRepo?.replace(/\.git$/u, "");
  if (!owner || !repo) return null;

  const marker = segments[2];
  if ((marker === "tree" || marker === "blob") && segments[3]) {
    return {
      cloneUrl: `https://github.com/${owner}/${repo}.git`,
      refAndPathSegments: segments.slice(3),
    };
  }

  return {
    cloneUrl: `https://github.com/${owner}/${repo}.git`,
  };
}

function parseGitRemoteRefs(output: string): ReadonlySet<string> {
  const refs = new Set<string>();
  for (const line of output.split(/\r?\n/u)) {
    const [, refName] = line.trim().split(/\s+/u);
    if (!refName || refName.endsWith("^{}")) continue;
    if (refName.startsWith("refs/heads/")) {
      refs.add(refName.slice("refs/heads/".length));
    }
    if (refName.startsWith("refs/tags/")) {
      refs.add(refName.slice("refs/tags/".length));
    }
  }
  return refs;
}

function resolveGitHubRefAndPath(input: {
  readonly refAndPathSegments: ReadonlyArray<string>;
  readonly remoteRefs: ReadonlySet<string>;
}): Effect.Effect<
  { readonly branch: string; readonly skillPath?: string },
  ServerProviderSkillInstallError
> {
  const segments = input.refAndPathSegments;
  for (let index = segments.length; index >= 1; index -= 1) {
    const candidate = segments.slice(0, index).join("/");
    if (input.remoteRefs.has(candidate)) {
      const skillPath = segments.slice(index).join("/");
      return Effect.succeed({
        branch: candidate,
        ...(skillPath ? { skillPath } : {}),
      });
    }
  }
  return installError(
    `Could not resolve GitHub branch or tag from '${segments.join("/")}'. Check the link and try again.`,
  );
}

function sanitizeSkillName(name: string): Effect.Effect<string, ServerProviderSkillInstallError> {
  const trimmed = name.trim();
  if (!SAFE_SKILL_NAME_PATTERN.test(trimmed) || trimmed === "." || trimmed === "..") {
    return installError(
      `Skill name '${name}' is not safe to install as a folder name. Use letters, numbers, dots, dashes, or underscores.`,
    );
  }
  return Effect.succeed(trimmed);
}

function validateBundlePath(
  relativePath: string,
): Effect.Effect<string, ServerProviderSkillInstallError> {
  const normalizedSeparators = relativePath.replace(/\\/gu, "/");
  const parts = normalizedSeparators.split("/").filter(Boolean);
  if (
    normalizedSeparators.startsWith("/") ||
    /^[a-zA-Z]:\//u.test(normalizedSeparators) ||
    parts.length === 0 ||
    parts.some((part) => part === "." || part === "..")
  ) {
    return installError(`Skill bundle contains an unsafe path: ${relativePath}`);
  }
  return Effect.succeed(parts.join("/"));
}

function extractFrontmatter(
  content: string,
): Effect.Effect<
  { readonly name: string; readonly description?: string },
  ServerProviderSkillInstallError
> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/u);
  if (!match?.[1]) {
    return installError("Skill entrypoint must start with YAML frontmatter.");
  }
  return decodeSkillFrontmatter(match[1]).pipe(
    Effect.mapError((error) =>
      installError(`Skill frontmatter is invalid: ${schemaIssue(error)}`, error),
    ),
    Effect.map((frontmatter) => ({
      name: frontmatter.name,
      ...(frontmatter.description ? { description: frontmatter.description } : {}),
    })),
  );
}

function validateSkillBundle(
  bundle: ServerProviderSkillBundleData,
): Effect.Effect<ServerProviderSkillBundleData, ServerProviderSkillInstallError> {
  return Effect.gen(function* () {
    if (bundle.files.length === 0) {
      return yield* installError("Skill bundle contains no files.");
    }
    if (bundle.files.length > MAX_BUNDLE_FILE_COUNT) {
      return yield* installError("Skill bundle contains too many files.");
    }
    const totalBytes = bundle.files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0);
    if (totalBytes > MAX_BUNDLE_BYTES) {
      return yield* installError("Skill bundle is too large.");
    }

    const seen = new Set<string>();
    for (const file of bundle.files) {
      const normalized = yield* validateBundlePath(file.path);
      if (seen.has(normalized)) {
        return yield* installError(`Skill bundle contains a duplicate path: ${file.path}`);
      }
      seen.add(normalized);
    }

    const entrypoint = bundle.files.find((file) => file.path.replace(/\\/gu, "/") === "SKILL.md");
    if (!entrypoint) {
      return yield* installError("Skill bundle must contain SKILL.md at its root.");
    }
    const frontmatter = yield* extractFrontmatter(entrypoint.content);
    yield* sanitizeSkillName(frontmatter.name);
    return bundle;
  });
}

function normalizeRequestedSkillPath(
  requestedPath: string,
): Effect.Effect<string, ServerProviderSkillInstallError> {
  const normalizedSeparators = requestedPath.replace(/\\/gu, "/");
  const parts = normalizedSeparators.split("/").filter(Boolean);
  if (
    normalizedSeparators.startsWith("/") ||
    /^[a-zA-Z]:\//u.test(normalizedSeparators) ||
    parts.length === 0 ||
    parts.some((part) => part === "." || part === "..")
  ) {
    return installError("GitHub skill path is unsafe.");
  }
  return Effect.succeed(parts.join("/"));
}

function findSkillDirectory(
  root: string,
  requestedPath?: string,
): Effect.Effect<string, ServerProviderSkillInstallError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;

    if (requestedPath) {
      const normalized = yield* normalizeRequestedSkillPath(requestedPath);
      const requestedAbsolute = pathService.join(root, normalized);
      const candidateDirectory =
        pathService.basename(requestedAbsolute) === "SKILL.md"
          ? pathService.dirname(requestedAbsolute)
          : requestedAbsolute;
      const exists = yield* fs
        .exists(pathService.join(candidateDirectory, "SKILL.md"))
        .pipe(
          Effect.mapError((cause) =>
            installError("Failed to inspect the requested GitHub skill path.", cause),
          ),
        );
      if (!exists) {
        return yield* installError("The GitHub path does not contain a SKILL.md file.");
      }
      return candidateDirectory;
    }

    const rootSkill = pathService.join(root, "SKILL.md");
    if (
      yield* fs
        .exists(rootSkill)
        .pipe(
          Effect.mapError((cause) =>
            installError("Failed to inspect the GitHub repository root.", cause),
          ),
        )
    ) {
      return root;
    }

    const skillsDir = pathService.join(root, "skills");
    const skillDirectories: string[] = [];
    const hasSkillsDir = yield* fs
      .exists(skillsDir)
      .pipe(
        Effect.mapError((cause) =>
          installError("Failed to inspect the GitHub repository skills directory.", cause),
        ),
      );
    if (hasSkillsDir) {
      const entries = yield* fs
        .readDirectory(skillsDir, { recursive: false })
        .pipe(
          Effect.mapError((cause) =>
            installError("Failed to read the GitHub repository skills directory.", cause),
          ),
        );
      for (const entry of entries) {
        const candidate = pathService.join(skillsDir, entry);
        const info = yield* fs.stat(candidate).pipe(Effect.option);
        if (info._tag === "Some" && info.value.type === "Directory") {
          const hasEntrypoint = yield* fs
            .exists(pathService.join(candidate, "SKILL.md"))
            .pipe(
              Effect.mapError((cause) =>
                installError("Failed to inspect a GitHub skill directory.", cause),
              ),
            );
          if (hasEntrypoint) {
            skillDirectories.push(candidate);
          }
        }
      }
    }

    if (skillDirectories.length === 1) {
      return skillDirectories[0]!;
    }
    if (skillDirectories.length > 1) {
      return yield* installError(
        "The GitHub repository contains multiple skills. Link directly to one skill folder.",
      );
    }

    return yield* installError("The GitHub repository does not contain a SKILL.md file.");
  });
}

function isSymbolicLinkPath(
  fs: FileSystem.FileSystem,
  absolutePath: string,
): Effect.Effect<boolean> {
  return fs.readLink(absolutePath).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
}

function readSkillDirectoryBundle(
  skillDirectory: string,
): Effect.Effect<
  ServerProviderSkillBundleData,
  ServerProviderSkillInstallError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const files: ServerProviderSkillBundleFile[] = [];
    let totalBytes = 0n;
    const maxBundleBytes = BigInt(MAX_BUNDLE_BYTES);

    if (yield* isSymbolicLinkPath(fs, skillDirectory)) {
      return yield* installError("GitHub skill path must point to a real directory.");
    }
    const rootInfo = yield* fs
      .stat(skillDirectory)
      .pipe(Effect.mapError((cause) => installError(`Failed to stat '${skillDirectory}'.`, cause)));
    if (rootInfo.type !== "Directory") {
      return yield* installError("GitHub skill path must point to a real directory.");
    }

    const walk = Effect.fn("readSkillDirectoryBundle.walk")(function* (
      currentDirectory: string,
      relativePrefix: string,
    ): Effect.fn.Return<void, ServerProviderSkillInstallError, FileSystem.FileSystem | Path.Path> {
      const entries = yield* fs
        .readDirectory(currentDirectory, { recursive: false })
        .pipe(
          Effect.mapError((cause) =>
            installError(`Failed to read skill directory '${currentDirectory}'.`, cause),
          ),
        );
      for (const entry of entries.toSorted()) {
        if (entry.startsWith(".") || entry === "node_modules") continue;
        const absolutePath = pathService.join(currentDirectory, entry);
        const relativePath = relativePrefix ? `${relativePrefix}/${entry}` : entry;
        if (yield* isSymbolicLinkPath(fs, absolutePath)) continue;
        const info = yield* fs
          .stat(absolutePath)
          .pipe(
            Effect.mapError((cause) => installError(`Failed to stat '${absolutePath}'.`, cause)),
          );
        if (info.type === "Directory") {
          yield* walk(absolutePath, relativePath);
          continue;
        }
        if (info.type !== "File") continue;
        if (files.length + 1 > MAX_BUNDLE_FILE_COUNT) {
          return yield* installError("Skill bundle contains too many files.");
        }
        if (totalBytes + info.size > maxBundleBytes) {
          return yield* installError("Skill bundle is too large.");
        }
        const content = yield* fs
          .readFileString(absolutePath)
          .pipe(
            Effect.mapError((cause) => installError(`Failed to read '${absolutePath}'.`, cause)),
          );
        totalBytes += BigInt(Buffer.byteLength(content));
        if (totalBytes > maxBundleBytes) {
          return yield* installError("Skill bundle is too large.");
        }
        files.push({ path: relativePath, content });
      }
    });

    yield* walk(skillDirectory, "");
    const entrypoint = files.find((file) => file.path === "SKILL.md");
    if (!entrypoint) {
      return yield* installError("Skill directory does not contain SKILL.md at its root.");
    }
    const frontmatter = yield* extractFrontmatter(entrypoint.content);
    const skillName = yield* sanitizeSkillName(frontmatter.name);
    return yield* validateSkillBundle({
      version: 1,
      skillId: skillName,
      files,
    });
  });
}

function cloneGitHubSkillBundle(
  normalized: NormalizedGitHubUrl,
): Effect.Effect<
  ServerProviderSkillBundleData,
  ServerProviderSkillInstallError,
  FileSystem.FileSystem | Path.Path | VcsProcess.VcsProcess
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const process = yield* VcsProcess.VcsProcess;
    const tempRoot = yield* fs
      .makeTempDirectory({ prefix: "t3-skill-install-" })
      .pipe(
        Effect.mapError((cause) =>
          installError("Failed to create a temporary GitHub skill clone directory.", cause),
        ),
      );
    const destination = pathService.join(tempRoot, "repo");
    return yield* Effect.gen(function* () {
      const resolvedRef = normalized.refAndPathSegments
        ? yield* process
            .run({
              operation: "installProviderSkill.gitLsRemote",
              command: "git",
              args: ["ls-remote", "--heads", "--tags", normalized.cloneUrl],
              cwd: tempRoot,
              timeoutMs: GIT_CLONE_TIMEOUT_MS,
              maxOutputBytes: 512 * 1024,
            })
            .pipe(
              Effect.map((output) => parseGitRemoteRefs(output.stdout)),
              Effect.flatMap((remoteRefs) =>
                resolveGitHubRefAndPath({
                  refAndPathSegments: normalized.refAndPathSegments!,
                  remoteRefs,
                }),
              ),
              Effect.mapError((cause) =>
                installError("Failed to resolve GitHub skill source branch.", cause),
              ),
            )
        : undefined;
      const cloneArgs = [
        "clone",
        "--depth",
        "1",
        ...(resolvedRef ? ["--branch", resolvedRef.branch] : []),
        normalized.cloneUrl,
        destination,
      ];

      yield* process
        .run({
          operation: "installProviderSkill.gitClone",
          command: "git",
          args: cloneArgs,
          cwd: tempRoot,
          timeoutMs: GIT_CLONE_TIMEOUT_MS,
          maxOutputBytes: 256 * 1024,
        })
        .pipe(
          Effect.mapError((cause) => installError("Failed to clone GitHub skill source.", cause)),
        );

      const skillDirectory = yield* findSkillDirectory(destination, resolvedRef?.skillPath);
      return yield* readSkillDirectoryBundle(skillDirectory);
    }).pipe(
      Effect.ensuring(
        fs.remove(tempRoot, { recursive: true }).pipe(Effect.catch(() => Effect.void)),
      ),
    );
  });
}

function loadBundleForUrl(
  rawUrl: string,
): Effect.Effect<
  ServerProviderSkillBundleData,
  ServerProviderSkillInstallError,
  FileSystem.FileSystem | HttpClient.HttpClient | Path.Path | VcsProcess.VcsProcess
> {
  return Effect.gen(function* () {
    const url = yield* ensureHttpUrl(rawUrl);
    const github = normalizeGitHubUrl(url.toString());
    if (github) {
      return yield* cloneGitHubSkillBundle(github);
    }

    return yield* loadBundleFromUrl(url.toString());
  });
}

function providerSkillsDirectoryRank(root: string): number {
  const normalized = root.replace(/\\/gu, "/").toLowerCase();
  if (normalized.includes("/.agents/ucsd/skills")) return 0;
  if (normalized.includes("/.codex/plugins/cache")) return 4;
  if (normalized.includes("/.codex/skills/.system")) return 4;
  if (normalized.includes("/.agents/skills")) return 1;
  if (normalized.includes("/.codex/skills")) return 2;
  return 3;
}

function resolveProviderSkillsDirectory(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly instanceId: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
}): Effect.Effect<string, ServerProviderSkillInstallError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const pathService = yield* Path.Path;
    const provider = input.providers.find((candidate) => candidate.instanceId === input.instanceId);
    if (!provider) {
      return yield* installError(`Provider '${input.instanceId}' was not found.`);
    }
    if (provider.driver !== "opencode") {
      return yield* installError(
        "Skill installation is currently available for OpenCode providers.",
      );
    }

    const roots = new Set<string>();
    for (const skill of provider.skills) {
      if (!pathService.isAbsolute(skill.path) || pathService.basename(skill.path) !== "SKILL.md") {
        continue;
      }
      const skillDirectory = pathService.dirname(skill.path);
      if (pathService.basename(pathService.dirname(skillDirectory)) === "skills") {
        roots.add(pathService.dirname(skillDirectory));
      }
    }

    const candidates = [...roots].toSorted(
      (left, right) =>
        providerSkillsDirectoryRank(left) - providerSkillsDirectoryRank(right) ||
        left.localeCompare(right),
    );
    const selected = candidates[0];
    if (!selected) {
      const defaultDirectory = yield* resolveDefaultOpenCodeSkillsDirectory(
        input.environment !== undefined ? { environment: input.environment } : {},
      );
      if (defaultDirectory) {
        return defaultDirectory;
      }
      return yield* installError(
        "No provider-reported skills directory is available, and no UCSD OpenCode config was found to select a default skills folder.",
      );
    }
    return selected;
  });
}

function resolveUcsdConfigSkillsDirectory(
  configPath: string,
): Effect.Effect<string | null, never, Path.Path> {
  return Effect.gen(function* () {
    const pathService = yield* Path.Path;
    const normalized = pathService.resolve(configPath);
    const opencodeDirectory = pathService.dirname(normalized);
    const configDirectory = pathService.dirname(opencodeDirectory);
    const ucsdDirectory = pathService.dirname(configDirectory);
    if (
      pathService.basename(normalized) !== "opencode.json" ||
      pathService.basename(opencodeDirectory) !== "opencode" ||
      pathService.basename(configDirectory) !== "config" ||
      pathService.basename(ucsdDirectory) !== "ucsd"
    ) {
      return null;
    }
    return pathService.join(ucsdDirectory, "skills");
  });
}

function resolveDefaultOpenCodeSkillsDirectory(input: {
  readonly environment?: NodeJS.ProcessEnv;
}): Effect.Effect<
  string | null,
  ServerProviderSkillInstallError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const environment = input.environment ?? process.env;

    const configuredPath = environment.OPENCODE_CONFIG?.trim();
    if (configuredPath) {
      const configPath = pathService.resolve(configuredPath);
      const skillsDirectory = yield* resolveUcsdConfigSkillsDirectory(configPath);
      if (!skillsDirectory) {
        return yield* installError(
          `OPENCODE_CONFIG must point to a UCSD OpenCode config at 'ucsd/config/opencode/opencode.json'. Received ${configPath}.`,
        );
      }

      const exists = yield* fs
        .exists(configPath)
        .pipe(Effect.mapError((cause) => installError(`Failed to inspect ${configPath}.`, cause)));
      if (!exists) {
        return yield* installError(`Configured OpenCode config was not found at ${configPath}.`);
      }
      return skillsDirectory;
    }

    const home = environment.HOME?.trim() || NodeOS.homedir();
    if (!home) {
      return null;
    }

    const ucsdDirectory = pathService.join(home, ".agents", "ucsd");
    const configPath = pathService.join(ucsdDirectory, "config", "opencode", "opencode.json");
    const exists = yield* fs
      .exists(configPath)
      .pipe(Effect.mapError((cause) => installError(`Failed to inspect ${configPath}.`, cause)));
    return exists ? pathService.join(ucsdDirectory, "skills") : null;
  });
}

function installSkillBundle(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly instanceId: ProviderInstanceId;
  readonly bundle: ServerProviderSkillBundleData;
  readonly environment?: NodeJS.ProcessEnv;
}): Effect.Effect<
  { readonly skillName: string; readonly skillPath: string },
  ServerProviderSkillInstallError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const bundle = yield* validateSkillBundle(input.bundle);
    const entrypoint = bundle.files.find((file) => file.path.replace(/\\/gu, "/") === "SKILL.md");
    if (!entrypoint) {
      return yield* installError("Skill bundle must contain SKILL.md at its root.");
    }

    const frontmatter = yield* extractFrontmatter(entrypoint.content);
    const skillName = yield* sanitizeSkillName(frontmatter.name);
    const skillsDirectory = yield* resolveProviderSkillsDirectory({
      providers: input.providers,
      instanceId: input.instanceId,
      ...(input.environment !== undefined ? { environment: input.environment } : {}),
    });
    const skillDirectory = pathService.join(skillsDirectory, skillName);
    const skillPath = pathService.join(skillDirectory, "SKILL.md");

    const skillDirectoryExists = yield* fs
      .exists(skillDirectory)
      .pipe(
        Effect.mapError((cause) => installError(`Failed to inspect ${skillDirectory}.`, cause)),
      );
    if (skillDirectoryExists) {
      const existingEntrypoint = yield* fs
        .exists(skillPath)
        .pipe(Effect.mapError((cause) => installError(`Failed to inspect ${skillPath}.`, cause)));
      if (!existingEntrypoint) {
        return yield* installError(
          `Skill '${skillName}' cannot be installed because ${skillDirectory} already exists without a SKILL.md file.`,
        );
      }

      const existingContent = yield* fs
        .readFileString(skillPath)
        .pipe(Effect.mapError((cause) => installError(`Failed to read ${skillPath}.`, cause)));
      const existingFrontmatter = yield* extractFrontmatter(existingContent);
      if (existingFrontmatter.name !== skillName) {
        return yield* installError(
          `Skill '${skillName}' cannot be installed because ${skillDirectory} already contains skill '${existingFrontmatter.name}'.`,
        );
      }

      yield* refreshExistingSkillBundleFiles({
        files: bundle.files,
        skillName,
        skillDirectory,
      });
      return { skillName, skillPath };
    }

    yield* fs
      .makeDirectory(skillDirectory, { recursive: true })
      .pipe(Effect.mapError((cause) => installError(`Failed to create ${skillDirectory}.`, cause)));

    yield* Effect.gen(function* () {
      yield* writeSkillBundleFiles({
        files: bundle.files,
        skillDirectory,
      });
      yield* registerInstalledSkillDirectory({ skillName, skillDirectory });
    }).pipe(
      Effect.catch((error) =>
        fs
          .remove(skillDirectory, { recursive: true })
          .pipe(Effect.ignore, Effect.andThen(Effect.fail(error))),
      ),
    );

    return { skillName, skillPath };
  });
}

function writeSkillBundleFiles(input: {
  readonly files: ReadonlyArray<ServerProviderSkillBundleFile>;
  readonly skillDirectory: string;
}): Effect.Effect<void, ServerProviderSkillInstallError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;

    for (const file of input.files) {
      const normalizedPath = yield* validateBundlePath(file.path);
      const targetPath = pathService.join(input.skillDirectory, normalizedPath);
      yield* fs
        .makeDirectory(pathService.dirname(targetPath), { recursive: true })
        .pipe(
          Effect.mapError((cause) =>
            installError(`Failed to create directory for ${targetPath}.`, cause),
          ),
        );
      yield* fs
        .writeFileString(targetPath, file.content)
        .pipe(Effect.mapError((cause) => installError(`Failed to write ${targetPath}.`, cause)));
    }
  });
}

function refreshExistingSkillBundleFiles(input: {
  readonly files: ReadonlyArray<ServerProviderSkillBundleFile>;
  readonly skillName: string;
  readonly skillDirectory: string;
}): Effect.Effect<void, ServerProviderSkillInstallError, FileSystem.FileSystem | Path.Path> {
  return Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const parentDirectory = pathService.dirname(input.skillDirectory);
      const backupRoot = yield* fs
        .makeTempDirectoryScoped({
          directory: parentDirectory,
          prefix: `${pathService.basename(input.skillDirectory)}.backup.`,
        })
        .pipe(
          Effect.mapError((cause) =>
            installError(`Failed to prepare backup for ${input.skillDirectory}.`, cause),
          ),
        );
      const backupDirectory = pathService.join(backupRoot, "skill");
      yield* fs
        .copy(input.skillDirectory, backupDirectory)
        .pipe(
          Effect.mapError((cause) =>
            installError(`Failed to back up ${input.skillDirectory}.`, cause),
          ),
        );

      yield* Effect.gen(function* () {
        yield* fs
          .remove(input.skillDirectory, { recursive: true, force: true })
          .pipe(
            Effect.mapError((cause) =>
              installError(`Failed to clear ${input.skillDirectory}.`, cause),
            ),
          );
        yield* writeSkillBundleFiles({
          files: input.files,
          skillDirectory: input.skillDirectory,
        });
        yield* registerInstalledSkillDirectory({
          skillName: input.skillName,
          skillDirectory: input.skillDirectory,
        });
      }).pipe(
        Effect.catch((error) =>
          fs
            .remove(input.skillDirectory, { recursive: true, force: true })
            .pipe(
              Effect.ignore,
              Effect.andThen(fs.copy(backupDirectory, input.skillDirectory, { overwrite: true })),
              Effect.ignore,
              Effect.andThen(Effect.fail(error)),
            ),
        ),
      );
    }),
  );
}

function registerInstalledSkillDirectory(input: {
  readonly skillName: string;
  readonly skillDirectory: string;
}): Effect.Effect<void, ServerProviderSkillInstallError, FileSystem.FileSystem | Path.Path> {
  return registerUcsdOpenCodeSkillPath(input.skillDirectory).pipe(
    Effect.mapError((cause) =>
      installError(`Failed to register '${input.skillName}' in OpenCode skill config.`, cause),
    ),
  );
}

export function mergeInstalledProviderSkill(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly instanceId: ProviderInstanceId;
  readonly skillName: string;
  readonly skillPath: string;
}): ReadonlyArray<ServerProvider> {
  return input.providers.map((provider) => {
    if (provider.instanceId !== input.instanceId) {
      return provider;
    }

    const alreadyPresent = provider.skills.some(
      (skill) => skill.path === input.skillPath || skill.name === input.skillName,
    );
    const installedSkill: ServerProviderSkill = {
      name: input.skillName,
      path: input.skillPath,
      enabled: true,
      scope: "user",
    };

    return {
      ...provider,
      skills: (alreadyPresent
        ? provider.skills.map((skill) =>
            skill.path === input.skillPath || skill.name === input.skillName
              ? {
                  ...skill,
                  name: input.skillName,
                  path: input.skillPath,
                  enabled: true,
                  scope: skill.scope ?? "user",
                }
              : skill,
          )
        : [...provider.skills, installedSkill]
      ).toSorted((left, right) => left.name.localeCompare(right.name)),
    };
  });
}

export const installProviderSkill = Effect.fn("installProviderSkill")(function* (input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly request: unknown;
  readonly environment?: NodeJS.ProcessEnv;
}): Effect.fn.Return<
  Omit<ServerInstallProviderSkillResult, "providers">,
  ServerProviderSkillInstallError,
  FileSystem.FileSystem | HttpClient.HttpClient | Path.Path | VcsProcess.VcsProcess
> {
  const request = yield* decodeInstallInput(input.request).pipe(
    Effect.mapError((error) =>
      installError(`Skill install request is invalid: ${schemaIssue(error)}`, error),
    ),
  );
  const bundle =
    request.source.type === "catalog"
      ? yield* loadBundleForCatalogEntry(request.source.catalogEntryId, input.environment)
      : yield* loadBundleForUrl(request.source.url);
  return yield* installSkillBundle({
    providers: input.providers,
    instanceId: request.instanceId,
    bundle,
    ...(input.environment !== undefined ? { environment: input.environment } : {}),
  });
});
