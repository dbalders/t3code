import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

const OpenCodeConfigJson = fromJsonStringPretty(Schema.Record(Schema.String, Schema.Json));
const decodeOpenCodeConfigJson = Schema.decodeUnknownEffect(OpenCodeConfigJson);
const encodeOpenCodeConfigJson = Schema.encodeUnknownEffect(OpenCodeConfigJson);
type JsonObject = typeof OpenCodeConfigJson.Type;

class OpenCodeSkillConfigError extends Data.TaggedError("OpenCodeSkillConfigError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

function asObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function configError(message: string, cause?: unknown) {
  return new OpenCodeSkillConfigError({
    message,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function schemaIssue(error: Schema.SchemaError): string {
  return SchemaIssue.makeFormatterDefault()(error.issue);
}

function resolveUcsdOpenCodeConfigPath(
  pathService: Path.Path,
  skillDirectoryPath: string,
): string | null {
  const skillsDirectory = pathService.dirname(skillDirectoryPath);
  const ucsdDirectory = pathService.dirname(skillsDirectory);
  if (
    pathService.basename(skillsDirectory) !== "skills" ||
    pathService.basename(ucsdDirectory) !== "ucsd"
  ) {
    return null;
  }

  return pathService.join(ucsdDirectory, "config", "opencode", "opencode.json");
}

function readOpenCodeConfig(
  configPath: string,
): Effect.Effect<JsonObject | null, OpenCodeSkillConfigError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs
      .exists(configPath)
      .pipe(Effect.mapError((cause) => configError(`Failed to inspect ${configPath}.`, cause)));
    if (!exists) {
      return null;
    }

    const raw = yield* fs
      .readFileString(configPath)
      .pipe(Effect.mapError((cause) => configError(`Failed to read ${configPath}.`, cause)));
    return yield* decodeOpenCodeConfigJson(raw).pipe(
      Effect.mapError((error) =>
        configError(`Failed to parse ${configPath}: ${schemaIssue(error)}`, error),
      ),
    );
  });
}

function readSkillPaths(
  config: JsonObject,
  configPath: string,
): Effect.Effect<ReadonlyArray<string>, OpenCodeSkillConfigError> {
  const skills = asObject(config.skills) ?? {};
  const rawPaths = skills.paths;
  if (rawPaths === undefined) {
    return Effect.succeed([]);
  }
  if (!Array.isArray(rawPaths) || rawPaths.some((entry) => typeof entry !== "string")) {
    return Effect.fail(configError(`${configPath} skills.paths must be an array of strings.`));
  }
  return Effect.succeed(rawPaths);
}

function withSkillPaths(config: JsonObject, paths: ReadonlyArray<string>): JsonObject {
  const skills = asObject(config.skills) ?? {};
  return {
    ...config,
    skills: {
      ...skills,
      paths: [...paths],
    },
  };
}

function writeOpenCodeConfig(
  configPath: string,
  config: JsonObject,
): Effect.Effect<void, OpenCodeSkillConfigError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const encoded = yield* encodeOpenCodeConfigJson(config).pipe(
      Effect.mapError((error) =>
        configError(`Failed to encode ${configPath}: ${schemaIssue(error)}`, error),
      ),
    );
    yield* fs
      .writeFileString(configPath, encoded)
      .pipe(Effect.mapError((cause) => configError(`Failed to write ${configPath}.`, cause)));
  });
}

export function registerUcsdOpenCodeSkillPath(
  skillDirectoryPath: string,
): Effect.Effect<void, OpenCodeSkillConfigError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const pathService = yield* Path.Path;
    const configPath = resolveUcsdOpenCodeConfigPath(pathService, skillDirectoryPath);
    if (!configPath) {
      return;
    }

    const config = yield* readOpenCodeConfig(configPath);
    if (!config) {
      return;
    }

    const paths = yield* readSkillPaths(config, configPath);
    if (paths.includes(skillDirectoryPath)) {
      return;
    }

    yield* writeOpenCodeConfig(configPath, withSkillPaths(config, [...paths, skillDirectoryPath]));
  });
}

export function unregisterUcsdOpenCodeSkillPath(
  skillDirectoryPath: string,
): Effect.Effect<void, OpenCodeSkillConfigError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const pathService = yield* Path.Path;
    const configPath = resolveUcsdOpenCodeConfigPath(pathService, skillDirectoryPath);
    if (!configPath) {
      return;
    }

    const config = yield* readOpenCodeConfig(configPath);
    if (!config) {
      return;
    }

    const paths = yield* readSkillPaths(config, configPath);
    const nextPaths = paths.filter((path) => path !== skillDirectoryPath);
    if (nextPaths.length === paths.length) {
      return;
    }

    yield* writeOpenCodeConfig(configPath, withSkillPaths(config, nextPaths));
  });
}
