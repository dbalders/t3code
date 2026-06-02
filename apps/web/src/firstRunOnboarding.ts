import { scopeProjectRef } from "@t3tools/client-runtime";
import type {
  EnvironmentApi,
  EnvironmentId,
  ProjectId,
  ScopedProjectRef,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { APP_BASE_NAME } from "./branding";
import { useComposerDraftStore, type DraftId } from "./composerDraftStore";
import { readEnvironmentApi } from "./environmentApi";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "./logicalProject";
import { findProjectByPath, inferProjectTitleFromPath } from "./lib/projectPaths";
import { newCommandId, newDraftId, newProjectId, newThreadId } from "./lib/utils";
import { useClientSettingsHydrated, useSettings, useUpdateSettings } from "./hooks/useSettings";
import { usePrimaryEnvironmentId } from "./environments/primary";
import { useStore, type EnvironmentState, type AppState } from "./store";
import { buildDraftThreadRouteParams } from "./threadRoutes";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Project } from "./types";

export const TRITONAI_FIRST_RUN_PROMPT = "How does TritonAI Code work, and how can it help me?";
export const TRITONAI_FIRST_RUN_WORKSPACE = "~/Documents/TritonAI";

const TRITONAI_APP_BASE_NAME = "TritonAI Code";
const ONBOARDING_PROJECT_TITLE = "TritonAI";
const PROJECT_CREATE_WAIT_TIMEOUT_MS = 5_000;

export function isTritonAiCodeBrand(appBaseName: string): boolean {
  return appBaseName.trim() === TRITONAI_APP_BASE_NAME;
}

export function isTritonAiWorkspacePath(path: string): boolean {
  const normalized = path.trim().replaceAll("\\", "/").replace(/\/+$/g, "").toLowerCase();
  return (
    normalized === "~/documents/tritonai" ||
    normalized.endsWith("/documents/tritonai") ||
    /^[a-z]:\/users\/[^/]+\/documents\/tritonai$/i.test(normalized)
  );
}

export function resolveTritonAiFirstRunWorkspacePath(): string {
  return TRITONAI_FIRST_RUN_WORKSPACE;
}

export function hasPriorProjectOrConversationState(input: {
  projectCount: number;
  threadCount: number;
  draftThreadCount: number;
  composerDraftCount: number;
  existingTritonAiWorkspace: boolean;
}): boolean {
  if (input.threadCount > 0 || input.draftThreadCount > 0 || input.composerDraftCount > 0) {
    return true;
  }

  return input.projectCount > 0 && !input.existingTritonAiWorkspace;
}

export function shouldRunTritonAiFirstRunOnboarding(input: {
  isBranded: boolean;
  markerCompleted: boolean;
  clientSettingsHydrated: boolean;
  composerDraftsHydrated: boolean;
  primaryEnvironmentReady: boolean;
  primaryEnvironmentBootstrapped: boolean;
  routePathname: string;
  projectCount: number;
  threadCount: number;
  draftThreadCount: number;
  composerDraftCount: number;
  existingTritonAiWorkspace: boolean;
}): boolean {
  if (!input.isBranded || input.markerCompleted) return false;
  if (!input.clientSettingsHydrated || !input.composerDraftsHydrated) return false;
  if (!input.primaryEnvironmentReady || !input.primaryEnvironmentBootstrapped) return false;
  if (input.routePathname !== "/") return false;
  return !hasPriorProjectOrConversationState(input);
}

function useComposerDraftStoreHydrated(): boolean {
  const [hydrated, setHydrated] = useState(() => useComposerDraftStore.persist.hasHydrated());

  useEffect(() => {
    if (hydrated) return;
    return useComposerDraftStore.persist.onFinishHydration(() => {
      setHydrated(true);
    });
  }, [hydrated]);

  return hydrated;
}

function selectPrimaryEnvironmentState(
  state: AppState,
  environmentId: EnvironmentId | null,
): EnvironmentState | null {
  if (!environmentId) return null;
  return state.environmentStateById[environmentId] ?? null;
}

function waitForProject(input: {
  environmentId: EnvironmentId;
  projectId?: ProjectId;
  workspacePath?: string;
  timeoutMs: number;
}): Promise<Project | null> {
  const findProject = (): Project | null => {
    const environmentState = useStore.getState().environmentStateById[input.environmentId] ?? null;
    if (!environmentState) return null;

    if (input.projectId) {
      return environmentState.projectById[input.projectId] ?? null;
    }

    if (input.workspacePath) {
      return (
        findProjectByPath(Object.values(environmentState.projectById), input.workspacePath) ?? null
      );
    }

    return null;
  };

  const immediate = findProject();
  if (immediate) return Promise.resolve(immediate);

  return new Promise((resolve) => {
    const timeout = window.setTimeout(() => {
      unsubscribe();
      resolve(findProject());
    }, input.timeoutMs);

    const unsubscribe = useStore.subscribe(() => {
      const project = findProject();
      if (!project) return;
      window.clearTimeout(timeout);
      unsubscribe();
      resolve(project);
    });
  });
}

async function ensureTritonAiProject(input: {
  api: EnvironmentApi;
  environmentId: EnvironmentId;
  existingProject: Project | null;
  defaultModelSelection: Project["defaultModelSelection"];
}): Promise<Project | null> {
  if (input.existingProject) {
    return input.existingProject;
  }

  const workspacePath = resolveTritonAiFirstRunWorkspacePath();
  const projectId = newProjectId();
  const createdAt = new Date().toISOString();
  await input.api.orchestration.dispatchCommand({
    type: "project.create",
    commandId: newCommandId(),
    projectId,
    title: inferProjectTitleFromPath(workspacePath) || ONBOARDING_PROJECT_TITLE,
    workspaceRoot: workspacePath,
    createWorkspaceRootIfMissing: true,
    defaultModelSelection: input.defaultModelSelection,
    createdAt,
  });

  return waitForProject({
    environmentId: input.environmentId,
    projectId,
    timeoutMs: PROJECT_CREATE_WAIT_TIMEOUT_MS,
  });
}

function createFirstRunDraft(input: {
  projectRef: ScopedProjectRef;
  logicalProjectKey: string;
  envMode: "local" | "worktree";
}): DraftId {
  const draftId = newDraftId();
  const draftStore = useComposerDraftStore.getState();
  draftStore.setLogicalProjectDraftThreadId(input.logicalProjectKey, input.projectRef, draftId, {
    threadId: newThreadId(),
    createdAt: new Date().toISOString(),
    branch: null,
    worktreePath: null,
    envMode: input.envMode,
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
  });
  draftStore.applyStickyState(draftId);

  const composerDraft = draftStore.getComposerDraft(draftId);
  if (!composerDraft || composerDraft.prompt.length === 0) {
    draftStore.setPrompt(draftId, TRITONAI_FIRST_RUN_PROMPT);
  }

  return draftId;
}

export function TritonAiFirstRunOnboardingBootstrap(props: { pathname: string }) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const navigate = useNavigate();
  const { updateSettings } = useUpdateSettings();
  const clientSettingsHydrated = useClientSettingsHydrated();
  const composerDraftsHydrated = useComposerDraftStoreHydrated();
  const onboardingCompleted = useSettings(
    (settings) => settings.tritonAiFirstRunOnboardingCompleted,
  );
  const defaultThreadEnvMode = useSettings((settings) => settings.defaultThreadEnvMode);
  const textGenerationModelSelection = useSettings(
    (settings) => settings.textGenerationModelSelection,
  );
  const projectGroupingSettings = useSettings(selectProjectGroupingSettings);
  const primaryEnvironmentState = useStore(
    useMemo(
      () => (state) => selectPrimaryEnvironmentState(state, primaryEnvironmentId),
      [primaryEnvironmentId],
    ),
  );
  const draftStateSummary = useComposerDraftStore(
    useShallow((state) => ({
      draftThreadCount: Object.keys(state.draftThreadsByThreadKey).length,
      composerDraftCount: Object.keys(state.draftsByThreadKey).length,
    })),
  );
  const runningRef = useRef(false);

  useEffect(() => {
    if (!primaryEnvironmentId || !primaryEnvironmentState) return;

    const projects = Object.values(primaryEnvironmentState.projectById);
    const existingTritonAiProject =
      projects.find((project) => isTritonAiWorkspacePath(project.cwd)) ?? null;
    const decisionInput = {
      isBranded: isTritonAiCodeBrand(APP_BASE_NAME),
      markerCompleted: onboardingCompleted,
      clientSettingsHydrated,
      composerDraftsHydrated,
      primaryEnvironmentReady: true,
      primaryEnvironmentBootstrapped: primaryEnvironmentState.bootstrapComplete,
      routePathname: props.pathname,
      projectCount: projects.length,
      threadCount: primaryEnvironmentState.threadIds.length,
      draftThreadCount: draftStateSummary.draftThreadCount,
      composerDraftCount: draftStateSummary.composerDraftCount,
      existingTritonAiWorkspace: existingTritonAiProject !== null,
    };

    if (!decisionInput.isBranded || decisionInput.markerCompleted) return;
    if (!decisionInput.clientSettingsHydrated || !decisionInput.composerDraftsHydrated) return;
    if (!decisionInput.primaryEnvironmentBootstrapped) return;

    const hasPriorState = hasPriorProjectOrConversationState(decisionInput);
    if (props.pathname !== "/" || hasPriorState) {
      updateSettings({ tritonAiFirstRunOnboardingCompleted: true });
      return;
    }

    if (!shouldRunTritonAiFirstRunOnboarding(decisionInput) || runningRef.current) {
      return;
    }

    runningRef.current = true;
    void (async () => {
      try {
        const api = readEnvironmentApi(primaryEnvironmentId);
        if (!api) return;

        const project = await ensureTritonAiProject({
          api,
          environmentId: primaryEnvironmentId,
          existingProject: existingTritonAiProject,
          defaultModelSelection: textGenerationModelSelection,
        });
        if (!project) return;

        const projectRef = scopeProjectRef(project.environmentId, project.id);
        const currentDraftStore = useComposerDraftStore.getState();
        const existingProjectDraft = currentDraftStore.getDraftSessionByProjectRef(projectRef);
        if (existingProjectDraft) {
          updateSettings({ tritonAiFirstRunOnboardingCompleted: true });
          return;
        }

        const logicalProjectKey = deriveLogicalProjectKeyFromSettings(
          project,
          projectGroupingSettings,
        );
        const draftId = createFirstRunDraft({
          projectRef,
          logicalProjectKey,
          envMode: defaultThreadEnvMode,
        });

        await navigate({
          to: "/draft/$draftId",
          params: buildDraftThreadRouteParams(draftId),
          replace: true,
        });
        updateSettings({ tritonAiFirstRunOnboardingCompleted: true });
      } catch (error) {
        console.error("[first-run-onboarding] failed", error);
      } finally {
        runningRef.current = false;
      }
    })();
  }, [
    clientSettingsHydrated,
    composerDraftsHydrated,
    defaultThreadEnvMode,
    draftStateSummary.composerDraftCount,
    draftStateSummary.draftThreadCount,
    navigate,
    onboardingCompleted,
    primaryEnvironmentId,
    primaryEnvironmentState,
    projectGroupingSettings,
    props.pathname,
    textGenerationModelSelection,
    updateSettings,
  ]);

  return null;
}
