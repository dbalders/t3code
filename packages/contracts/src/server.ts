import { Option, Schema } from "effect";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas";
import { KeybindingRule, ResolvedKeybindingsConfig } from "./keybindings";
import { EditorId } from "./editor";
import { ProviderKind } from "./orchestration";

const KeybindingsMalformedConfigIssue = Schema.Struct({
  kind: Schema.Literal("keybindings.malformed-config"),
  message: TrimmedNonEmptyString,
});

const KeybindingsInvalidEntryIssue = Schema.Struct({
  kind: Schema.Literal("keybindings.invalid-entry"),
  message: TrimmedNonEmptyString,
  index: Schema.Number,
});

export const ServerConfigIssue = Schema.Union([
  KeybindingsMalformedConfigIssue,
  KeybindingsInvalidEntryIssue,
]);
export type ServerConfigIssue = typeof ServerConfigIssue.Type;

const ServerConfigIssues = Schema.Array(ServerConfigIssue);

export const SERVER_AGENT_SETTINGS_MAX_PATH_LENGTH = 4096;
export const SERVER_AGENT_SETTINGS_MAX_CUSTOM_MODEL_COUNT = 32;
export const SERVER_AGENT_SETTINGS_MAX_CUSTOM_MODEL_LENGTH = 256;

export const ServerAgentSettings = Schema.Struct({
  codexBinaryPath: Schema.String.check(
    Schema.isMaxLength(SERVER_AGENT_SETTINGS_MAX_PATH_LENGTH),
  ).pipe(Schema.withConstructorDefault(() => Option.some(""))),
  codexHomePath: Schema.String.check(
    Schema.isMaxLength(SERVER_AGENT_SETTINGS_MAX_PATH_LENGTH),
  ).pipe(Schema.withConstructorDefault(() => Option.some(""))),
  defaultThreadEnvMode: Schema.Literals(["local", "worktree"]).pipe(
    Schema.withConstructorDefault(() => Option.some("local")),
  ),
  customCodexModels: Schema.Array(
    Schema.String.check(Schema.isMaxLength(SERVER_AGENT_SETTINGS_MAX_CUSTOM_MODEL_LENGTH)),
  )
    .check(Schema.isMaxLength(SERVER_AGENT_SETTINGS_MAX_CUSTOM_MODEL_COUNT))
    .pipe(Schema.withConstructorDefault(() => Option.some([]))),
});
export type ServerAgentSettings = typeof ServerAgentSettings.Type;

export const ServerAgentSettingsState = Schema.Struct({
  settings: ServerAgentSettings,
  isInitialized: Schema.Boolean,
});
export type ServerAgentSettingsState = typeof ServerAgentSettingsState.Type;

export const ServerPatchAgentSettingsInput = Schema.Struct({
  codexBinaryPath: Schema.optional(
    Schema.String.check(Schema.isMaxLength(SERVER_AGENT_SETTINGS_MAX_PATH_LENGTH)),
  ),
  codexHomePath: Schema.optional(
    Schema.String.check(Schema.isMaxLength(SERVER_AGENT_SETTINGS_MAX_PATH_LENGTH)),
  ),
  defaultThreadEnvMode: Schema.optional(Schema.Literals(["local", "worktree"])),
  customCodexModels: Schema.optional(
    Schema.Array(
      Schema.String.check(Schema.isMaxLength(SERVER_AGENT_SETTINGS_MAX_CUSTOM_MODEL_LENGTH)),
    ).check(Schema.isMaxLength(SERVER_AGENT_SETTINGS_MAX_CUSTOM_MODEL_COUNT)),
  ),
});
export type ServerPatchAgentSettingsInput = typeof ServerPatchAgentSettingsInput.Type;

export const ServerProviderStatusState = Schema.Literals(["ready", "warning", "error"]);
export type ServerProviderStatusState = typeof ServerProviderStatusState.Type;

export const ServerProviderAuthStatus = Schema.Literals([
  "authenticated",
  "unauthenticated",
  "unknown",
]);
export type ServerProviderAuthStatus = typeof ServerProviderAuthStatus.Type;

export const ServerProviderStatus = Schema.Struct({
  provider: ProviderKind,
  status: ServerProviderStatusState,
  available: Schema.Boolean,
  authStatus: ServerProviderAuthStatus,
  checkedAt: IsoDateTime,
  message: Schema.optional(TrimmedNonEmptyString),
});
export type ServerProviderStatus = typeof ServerProviderStatus.Type;

const ServerProviderStatuses = Schema.Array(ServerProviderStatus);

export const ServerConfig = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  keybindingsConfigPath: TrimmedNonEmptyString,
  keybindings: ResolvedKeybindingsConfig,
  issues: ServerConfigIssues,
  providers: ServerProviderStatuses,
  availableEditors: Schema.Array(EditorId),
});
export type ServerConfig = typeof ServerConfig.Type;

export const ServerUpsertKeybindingInput = KeybindingRule;
export type ServerUpsertKeybindingInput = typeof ServerUpsertKeybindingInput.Type;

export const ServerUpsertKeybindingResult = Schema.Struct({
  keybindings: ResolvedKeybindingsConfig,
  issues: ServerConfigIssues,
});
export type ServerUpsertKeybindingResult = typeof ServerUpsertKeybindingResult.Type;

export const ServerConfigUpdatedPayload = Schema.Struct({
  issues: ServerConfigIssues,
  providers: ServerProviderStatuses,
});
export type ServerConfigUpdatedPayload = typeof ServerConfigUpdatedPayload.Type;

export const ServerAgentSettingsUpdatedPayload = ServerAgentSettings;
export type ServerAgentSettingsUpdatedPayload = typeof ServerAgentSettingsUpdatedPayload.Type;
