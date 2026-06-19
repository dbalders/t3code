export const TRITONAI_FIRST_RUN_PROMPT = "How does TritonAI Code work, and how can it help me?";
export const TRITONAI_FIRST_RUN_WORKSPACE = "~/TritonAI";
export const TRITONAI_CHATS_WORKSPACE = "~/.agents/ucsd/state/tritonai-code/chats";
export const TRITONAI_CHATS_PROJECT_TITLE = "Chats";

const TRITONAI_APP_BASE_NAME = "TritonAI Code";

export function isTritonAiCodeBrand(appBaseName: string): boolean {
  return appBaseName.trim() === TRITONAI_APP_BASE_NAME;
}

function normalizeWorkspacePath(path: string): string {
  return path.trim().replaceAll("\\", "/").replace(/\/+$/g, "").toLowerCase();
}

function isPathAtHomeTritonAi(normalizedPath: string): boolean {
  return (
    normalizedPath === "~/tritonai" ||
    /^\/(users|home)\/[^/]+\/tritonai$/i.test(normalizedPath) ||
    /^[a-z]:\/users\/[^/]+\/tritonai$/i.test(normalizedPath)
  );
}

export function isTritonAiWorkspacePath(path: string): boolean {
  return isPathAtHomeTritonAi(normalizeWorkspacePath(path));
}

export function isTritonAiChatsWorkspacePath(path: string): boolean {
  const normalized = normalizeWorkspacePath(path);
  return (
    normalized === "~/.agents/ucsd/state/tritonai-code/chats" ||
    /^\/(users|home)\/[^/]+\/\.agents\/ucsd\/state\/tritonai-code\/chats$/i.test(normalized) ||
    /^[a-z]:\/users\/[^/]+\/\.agents\/ucsd\/state\/tritonai-code\/chats$/i.test(normalized)
  );
}

export function resolveTritonAiFirstRunWorkspacePath(): string {
  return TRITONAI_FIRST_RUN_WORKSPACE;
}

export function resolveTritonAiChatsWorkspacePath(): string {
  return TRITONAI_CHATS_WORKSPACE;
}
