import { describe, expect, it } from "vite-plus/test";

import {
  getTritonAiFirstRunOnboardingDecision,
  hasPriorProjectOrConversationState,
  shouldRunTritonAiFirstRunOnboarding,
} from "./firstRunOnboarding";

describe("firstRunOnboarding", () => {
  it("treats existing non-onboarding projects, threads, and drafts as prior state", () => {
    expect(
      hasPriorProjectOrConversationState({
        projectCount: 1,
        nonOnboardingProjectCount: 1,
        threadCount: 0,
        draftThreadCount: 0,
        composerDraftCount: 0,
        existingTritonAiWorkspace: false,
      }),
    ).toBe(true);
    expect(
      hasPriorProjectOrConversationState({
        projectCount: 1,
        nonOnboardingProjectCount: 0,
        threadCount: 0,
        draftThreadCount: 0,
        composerDraftCount: 0,
        existingTritonAiWorkspace: true,
      }),
    ).toBe(false);
    expect(
      hasPriorProjectOrConversationState({
        projectCount: 2,
        nonOnboardingProjectCount: 1,
        threadCount: 0,
        draftThreadCount: 0,
        composerDraftCount: 0,
        existingTritonAiWorkspace: true,
      }),
    ).toBe(true);
    expect(
      hasPriorProjectOrConversationState({
        projectCount: 0,
        nonOnboardingProjectCount: 0,
        threadCount: 1,
        draftThreadCount: 0,
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
      nonOnboardingProjectCount: 0,
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
    expect(
      shouldRunTritonAiFirstRunOnboarding({
        ...readyInput,
        projectCount: 1,
        nonOnboardingProjectCount: 1,
      }),
    ).toBe(false);
    expect(
      shouldRunTritonAiFirstRunOnboarding({
        ...readyInput,
        projectCount: 1,
        nonOnboardingProjectCount: 0,
        existingTritonAiWorkspace: true,
      }),
    ).toBe(true);
  });

  it("defers non-root routes instead of completing the onboarding marker", () => {
    const readyInput = {
      isBranded: true,
      markerCompleted: false,
      clientSettingsHydrated: true,
      composerDraftsHydrated: true,
      primaryEnvironmentReady: true,
      primaryEnvironmentBootstrapped: true,
      routePathname: "/",
      projectCount: 0,
      nonOnboardingProjectCount: 0,
      threadCount: 0,
      draftThreadCount: 0,
      composerDraftCount: 0,
      existingTritonAiWorkspace: false,
    };

    expect(
      getTritonAiFirstRunOnboardingDecision({
        ...readyInput,
        routePathname: "/settings",
      }),
    ).toBe("defer");
    expect(
      getTritonAiFirstRunOnboardingDecision({
        ...readyInput,
        projectCount: 1,
        nonOnboardingProjectCount: 1,
      }),
    ).toBe("complete");
  });
});
