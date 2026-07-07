export const TRITONAI_FIRST_RUN_PROMPT = "How does TritonAI Harness work, and how can it help me?";
export const TRITONAI_FIRST_RUN_WORKSPACE = "~/TritonAI";
export const TRITONAI_CHATS_PROJECT_TITLE = "Chats";
export const TRITONAI_CHATS_WORKSPACE = "~/.tritonai-harness/chats";

const LEGACY_TRITONAI_CHATS_WORKSPACE = "~/.agents/ucsd/state/tritonai-code/chats";
const TRITONAI_APP_BASE_NAME = "TritonAI Harness";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeWorkspacePath(path: string): string {
  return path.trim().replaceAll("\\", "/").replace(/\/+$/g, "").toLowerCase();
}

function isHomeRelativePath(normalizedPath: string, suffix: string): boolean {
  const escapedSuffix = escapeRegExp(suffix);
  return (
    normalizedPath === `~/${suffix}` ||
    new RegExp(`^/(users|home)/[^/]+/${escapedSuffix}$`, "i").test(normalizedPath) ||
    new RegExp(`^[a-z]:/users/[^/]+/${escapedSuffix}$`, "i").test(normalizedPath)
  );
}

export function isTritonAiCodeBrand(appBaseName: string): boolean {
  return appBaseName.trim() === TRITONAI_APP_BASE_NAME;
}

export function isTritonAiWorkspacePath(path: string): boolean {
  return isHomeRelativePath(normalizeWorkspacePath(path), "tritonai");
}

export function isTritonAiChatsWorkspacePath(path: string): boolean {
  const normalized = normalizeWorkspacePath(path);
  return (
    isHomeRelativePath(normalized, ".tritonai-harness/chats") ||
    isHomeRelativePath(normalized, ".agents/ucsd/state/tritonai-code/chats") ||
    normalized === normalizeWorkspacePath(LEGACY_TRITONAI_CHATS_WORKSPACE)
  );
}

export function resolveTritonAiFirstRunWorkspacePath(): string {
  return TRITONAI_FIRST_RUN_WORKSPACE;
}

export function resolveTritonAiChatsWorkspacePath(): string {
  return TRITONAI_CHATS_WORKSPACE;
}
