export const TRITONAI_CHATS_PROJECT_TITLE = "Chats";
export const TRITONAI_CHATS_WORKSPACE = "~/.tritonai-harness/chats";

const LEGACY_TRITONAI_CHATS_WORKSPACE = "~/.agents/ucsd/state/tritonai-code/chats";

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

export function isTritonAiChatsWorkspacePath(path: string): boolean {
  const normalized = normalizeWorkspacePath(path);
  return (
    isHomeRelativePath(normalized, ".tritonai-harness/chats") ||
    isHomeRelativePath(normalized, ".agents/ucsd/state/tritonai-code/chats") ||
    normalized === normalizeWorkspacePath(LEGACY_TRITONAI_CHATS_WORKSPACE)
  );
}

export function resolveTritonAiChatsWorkspacePath(): string {
  return TRITONAI_CHATS_WORKSPACE;
}
