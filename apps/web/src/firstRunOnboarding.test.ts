import { describe, expect, it } from "vite-plus/test";

import {
  TRITONAI_FIRST_RUN_WORKSPACE,
  TRITONAI_CHATS_WORKSPACE,
  hasPriorProjectOrConversationState,
  isTritonAiCodeBrand,
  isTritonAiChatsWorkspacePath,
  isTritonAiWorkspacePath,
  resolveTritonAiChatsWorkspacePath,
  resolveTritonAiFirstRunWorkspacePath,
  shouldRunTritonAiFirstRunOnboarding,
} from "./firstRunOnboarding";

describe("firstRunOnboarding", () => {
  it("is scoped to the TritonAI Code brand", () => {
    expect(isTritonAiCodeBrand("TritonAI Code")).toBe(true);
    expect(isTritonAiCodeBrand("T3 Code")).toBe(false);
  });

  it("uses the installer-created TritonAI home workspace", () => {
    expect(resolveTritonAiFirstRunWorkspacePath()).toBe(TRITONAI_FIRST_RUN_WORKSPACE);
    expect(resolveTritonAiChatsWorkspacePath()).toBe(TRITONAI_CHATS_WORKSPACE);
  });

  it("recognizes tilde, macOS/Linux, and Windows TritonAI home paths", () => {
    expect(isTritonAiWorkspacePath("~/TritonAI")).toBe(true);
    expect(isTritonAiWorkspacePath("/Users/alice/TritonAI")).toBe(true);
    expect(isTritonAiWorkspacePath("/home/alice/TritonAI/")).toBe(true);
    expect(isTritonAiWorkspacePath("C:\\Users\\alice\\TritonAI")).toBe(true);
    expect(isTritonAiWorkspacePath("~/Documents/TritonAI")).toBe(false);
    expect(isTritonAiWorkspacePath("/Users/alice/Projects/TritonAI")).toBe(false);
  });

  it("recognizes the hidden managed chats workspace", () => {
    expect(isTritonAiChatsWorkspacePath("~/.agents/ucsd/state/tritonai-code/chats")).toBe(true);
    expect(
      isTritonAiChatsWorkspacePath("/Users/alice/.agents/ucsd/state/tritonai-code/chats"),
    ).toBe(true);
    expect(
      isTritonAiChatsWorkspacePath("/home/alice/.agents/ucsd/state/tritonai-code/chats/"),
    ).toBe(true);
    expect(
      isTritonAiChatsWorkspacePath("C:\\Users\\alice\\.agents\\ucsd\\state\\tritonai-code\\chats"),
    ).toBe(true);
    expect(isTritonAiChatsWorkspacePath("~/TritonAI/Chats")).toBe(false);
    expect(isTritonAiChatsWorkspacePath("~/Documents/TritonAI/Chats")).toBe(false);
  });

  it("treats existing non-onboarding projects, threads, and drafts as prior state", () => {
    expect(
      hasPriorProjectOrConversationState({
        projectCount: 1,
        threadCount: 0,
        draftThreadCount: 0,
        composerDraftCount: 0,
        existingTritonAiWorkspace: false,
      }),
    ).toBe(true);
    expect(
      hasPriorProjectOrConversationState({
        projectCount: 1,
        threadCount: 0,
        draftThreadCount: 0,
        composerDraftCount: 0,
        existingTritonAiWorkspace: true,
      }),
    ).toBe(false);
    expect(
      hasPriorProjectOrConversationState({
        projectCount: 0,
        threadCount: 0,
        draftThreadCount: 1,
        composerDraftCount: 0,
        existingTritonAiWorkspace: false,
      }),
    ).toBe(true);
  });

  it("runs only when fully hydrated, unmarked, on the empty root route", () => {
    const readyInput = {
      isBranded: true,
      markerCompleted: false,
      clientSettingsHydrated: true,
      composerDraftsHydrated: true,
      primaryEnvironmentReady: true,
      primaryEnvironmentBootstrapped: true,
      routePathname: "/",
      projectCount: 0,
      threadCount: 0,
      draftThreadCount: 0,
      composerDraftCount: 0,
      existingTritonAiWorkspace: false,
    };

    expect(shouldRunTritonAiFirstRunOnboarding(readyInput)).toBe(true);
    expect(shouldRunTritonAiFirstRunOnboarding({ ...readyInput, markerCompleted: true })).toBe(
      false,
    );
    expect(shouldRunTritonAiFirstRunOnboarding({ ...readyInput, routePathname: "/draft/1" })).toBe(
      false,
    );
    expect(shouldRunTritonAiFirstRunOnboarding({ ...readyInput, composerDraftCount: 1 })).toBe(
      false,
    );
  });
});
