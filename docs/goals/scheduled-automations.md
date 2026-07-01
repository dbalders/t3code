# Scheduled Automations Goal

## Outcome

TritonAI Harness supports first-class scheduled automations managed from Settings. Automations persist in SQLite, can target an existing thread or create a new thread for each run, use `once` or timezone-aware RRULE schedules, dispatch through the normal orchestration engine, and keep run history.

## Grounding

- Repository: `t3code-codex-runtime` (repository root)
- Branch: `tritonai-codex-runtime`
- User requirements:
  - Build automations/scheduling for TritonAI Harness, similar in spirit to Codex app automations.
  - Manage automations in Settings rather than the sidebar.
  - Allow scheduled prompts to talk back to existing threads or create new threads.
  - Research first and use UCSD skills library only if useful.
- Design decision:
  - Keep scheduling local-first and in-process with the T3 server.
  - Use SQLite for task/run persistence.
  - Use `rrule-es` for recurrence because it preserves local wall-clock time across DST when given an absolute `dtStart` plus `tzid`.
  - Dispatch scheduled work through `thread.create` and `thread.turn.start` orchestration commands, not provider adapters.
  - Let skill usage remain prompt-level, e.g. `$skill-name`, rather than coupling scheduler logic to `UCSD-Skills-Library`.

## Implemented

- Added shared contracts for `ScheduledTask`, `ScheduledTaskRun`, schedule configs, IDs, RPC methods, and local API methods.
- Added SQLite migration `033_ScheduledTasks` with `scheduled_tasks` and `scheduled_task_runs`.
- Added scheduled task repositories and live layers.
- Added `ScheduledTaskService` for list/create/update/delete/pause/resume/runNow/listRuns/runDueTasks/reconcileOpenRuns.
- Added an in-process scheduler layer that polls every 30 seconds through `ServerRuntimeStartup.enqueueCommand`.
- Wired scheduled task RPC handlers into WebSocket auth and the client runtime/local API.
- Added Settings > Automations route and nav item with creation controls, task list, actions, and run history.
- Added focused schedule and service tests:
  - DST-aware daily recurrence.
  - One-time run exhaustion.
  - Missed-run grace helper.
  - Due standalone task dispatch through `thread.create` and `thread.turn.start` with run persistence.
  - Failure handling for stale targets, dispatch errors, completed-turn reconciliation, and provider start failures before a turn id exists.

## Verification

- `pnpm --filter @t3tools/contracts test src/scheduledTasks.test.ts`
  - Passed: 1 file, 4 tests.
- `pnpm --filter t3 test src/scheduledTasks/Schedule.test.ts src/scheduledTasks/ScheduledTaskService.test.ts src/mcp/toolkits/automations/tools.test.ts src/mcp/toolkits/automations/handlers.test.ts`
  - Passed: 4 files, 20 tests.
- `pnpm --filter t3 test src/server.test.ts -t "serves static index content"`
  - Passed: 1 test, 100 skipped.
- `pnpm --filter @t3tools/contracts typecheck && pnpm --filter t3 typecheck && pnpm --filter @t3tools/web typecheck`
  - Passed.
- `pnpm --filter @t3tools/client-runtime typecheck`
  - Passed.
- `pnpm --filter @t3tools/web build`
  - Passed production web build for the new Settings route.
- `git diff --check`
  - Passed.

## Remaining Risks

- Scheduler is local-process based: tasks run only while the T3 server is running.
- Manual desktop E2E against a live TritonAI Harness config has not been run yet in this Codex-runtime branch.
- `pnpm fmt:check` currently fails on six unrelated pre-existing files outside the automation port.
