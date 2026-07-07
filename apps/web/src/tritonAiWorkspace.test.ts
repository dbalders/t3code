import { describe, expect, it } from "vite-plus/test";

import {
  TRITONAI_CHATS_WORKSPACE,
  TRITONAI_FIRST_RUN_WORKSPACE,
  isTritonAiChatsWorkspacePath,
  isTritonAiCodeBrand,
  isTritonAiWorkspacePath,
  resolveTritonAiChatsWorkspacePath,
  resolveTritonAiFirstRunWorkspacePath,
} from "./tritonAiWorkspace";

describe("tritonAiWorkspace", () => {
  it("is scoped to the TritonAI Harness brand", () => {
    expect(isTritonAiCodeBrand("TritonAI Harness")).toBe(true);
    expect(isTritonAiCodeBrand("TritonAI Code")).toBe(false);
  });

  it("resolves the first-run TritonAI home workspace", () => {
    expect(resolveTritonAiFirstRunWorkspacePath()).toBe(TRITONAI_FIRST_RUN_WORKSPACE);
    expect(isTritonAiWorkspacePath("~/TritonAI")).toBe(true);
    expect(isTritonAiWorkspacePath("/Users/david/TritonAI/")).toBe(true);
    expect(isTritonAiWorkspacePath("/home/david/TritonAI")).toBe(true);
    expect(isTritonAiWorkspacePath("C:\\Users\\david\\TritonAI")).toBe(true);
    expect(isTritonAiWorkspacePath("~/Projects/TritonAI")).toBe(false);
  });

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
