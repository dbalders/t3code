import { describe, expect, it } from "vitest";

import {
  TRITONAI_FIRST_RUN_WORKSPACE,
  hasPriorProjectOrConversationState,
  isTritonAiCodeBrand,
  isTritonAiWorkspacePath,
  resolveTritonAiFirstRunWorkspacePath,
  shouldRunTritonAiFirstRunOnboarding,
} from "./firstRunOnboarding";

describe("firstRunOnboarding", () => {
  it("is scoped to the TritonAI Code brand", () => {
    expect(isTritonAiCodeBrand("TritonAI Code")).toBe(true);
    expect(isTritonAiCodeBrand("T3 Code")).toBe(false);
  });

  it("uses the installer-created TritonAI documents workspace", () => {
    expect(resolveTritonAiFirstRunWorkspacePath()).toBe(TRITONAI_FIRST_RUN_WORKSPACE);
  });

  it("recognizes tilde, macOS/Linux, and Windows TritonAI documents paths", () => {
    expect(isTritonAiWorkspacePath("~/Documents/TritonAI")).toBe(true);
    expect(isTritonAiWorkspacePath("/Users/alice/Documents/TritonAI")).toBe(true);
    expect(isTritonAiWorkspacePath("/home/alice/Documents/TritonAI/")).toBe(true);
    expect(isTritonAiWorkspacePath("C:\\Users\\alice\\Documents\\TritonAI")).toBe(true);
    expect(isTritonAiWorkspacePath("/Users/alice/Projects/TritonAI")).toBe(false);
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
