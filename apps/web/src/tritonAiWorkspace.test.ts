import { describe, expect, it } from "vite-plus/test";

import {
  TRITONAI_CHATS_WORKSPACE,
  isTritonAiChatsWorkspacePath,
  resolveTritonAiChatsWorkspacePath,
} from "./tritonAiWorkspace";

describe("tritonAiWorkspace", () => {
  it("resolves the canonical TritonAI Harness chats workspace", () => {
    expect(resolveTritonAiChatsWorkspacePath()).toBe(TRITONAI_CHATS_WORKSPACE);
    expect(isTritonAiChatsWorkspacePath("~/.tritonai-harness/chats")).toBe(true);
    expect(isTritonAiChatsWorkspacePath("/Users/david/.tritonai-harness/chats/")).toBe(true);
  });

  it("recognizes legacy TritonAI Code chats workspaces", () => {
    expect(isTritonAiChatsWorkspacePath("~/.agents/ucsd/state/tritonai-code/chats")).toBe(true);
    expect(isTritonAiChatsWorkspacePath("/home/david/.agents/ucsd/state/tritonai-code/chats")).toBe(
      true,
    );
  });

  it("rejects normal project paths", () => {
    expect(isTritonAiChatsWorkspacePath("~/Projects/t3code")).toBe(false);
    expect(isTritonAiChatsWorkspacePath("/Users/david/.tritonai-harness/chat-history")).toBe(false);
  });
});
