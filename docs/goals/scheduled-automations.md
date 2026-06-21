# Scheduled Automations Goal

## Outcome

T3 supports first-class scheduled automations managed from Settings. Automations persist in SQLite, can target an existing thread or create a new thread for each run, use `once` or timezone-aware RRULE schedules, dispatch through the normal orchestration engine, and keep run history.

## Grounding

- Repository: `t3code` (repository root)
- Branch: `feature/scheduled-automations`
- User requirements:
  - Build automations/scheduling for t3code, similar in spirit to Codex app automations.
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

- Manual browser E2E with a temporary `T3CODE_HOME`:
  - Created a one-time Settings > Automations task against an existing thread.
  - Confirmed the scheduler fired, run history showed `success`, and the thread received `SCHEDULED_AUTOMATION_E2E_OK`.
- `npx pnpm@10.24.0 exec vp test run src/scheduledTasks/Schedule.test.ts src/scheduledTasks/ScheduledTaskService.test.ts --reporter=dot`
  - Passed: 2 files, 8 tests.
- `npx pnpm@10.24.0 exec vp run -r --concurrency-limit 2 typecheck`
  - Passed: 15/15 workspace typecheck tasks.
- `npx pnpm@10.24.0 exec vp check`
  - Passed formatting and lint with 0 errors.
  - Existing warnings remain for nested React components in unrelated files, plus one pre-existing redundant Boolean warning in `SkillsSettings`.
- `npx pnpm@10.24.0 exec vp run --filter @t3tools/web --filter t3 build`
  - Passed production web build for the new Settings route.
- `$HOME/.agents/skills/autoreview/scripts/autoreview --mode local`
  - Clean: no accepted/actionable findings after fixing the reported durability issues.

## Remaining Risks

- Scheduler is local-process based: tasks run only while the T3 server is running.
- Current UI covers core create/list/actions/history, but edit-in-place and model/runtime selectors can be expanded later.
