export interface ManagedLabel {
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

export const managedLabels: readonly ManagedLabel[];

export function parseArgs(args: readonly string[]): {
  readonly push: boolean;
  readonly createPr: boolean;
  readonly autoMerge: boolean;
  readonly autoMergePr: boolean;
  readonly keepBranch: boolean;
  readonly skipChecks: boolean;
  readonly noLlm: boolean;
  readonly allowNeedsReview: boolean;
  readonly updateMirror: boolean;
};

export function parseCsv(value: string): string[];

export function trimTrailingSlash(value: string): string;

export function isSecretEnvName(name: string): boolean;

export function makeSanitizedChildEnv(options?: {
  readonly allowSecretNames?: readonly string[];
  readonly extra?: Readonly<Record<string, string | undefined>>;
  readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
}): Record<string, string>;

export function labelsForReport(input: {
  readonly report: Readonly<Record<string, unknown>>;
  readonly canAutoMerge: boolean;
}): string[];

export function buildPullRequestBody(input: {
  readonly report: Readonly<Record<string, unknown>>;
  readonly labels: readonly string[];
}): string;

export function parseJsonObject(content: unknown): Record<string, unknown>;
