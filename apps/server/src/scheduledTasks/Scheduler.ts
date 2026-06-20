import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import { ServerRuntimeStartup } from "../serverRuntimeStartup.ts";
import { ScheduledTaskService } from "./ScheduledTaskService.ts";

const POLL_INTERVAL = "30 seconds";

export const ScheduledTaskSchedulerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const startup = yield* ServerRuntimeStartup;
    const scheduledTasks = yield* ScheduledTaskService;

    const tick = startup.enqueueCommand(
      scheduledTasks.runDueTasks().pipe(
        Effect.catch((cause) =>
          Effect.logWarning("scheduled task poll failed", {
            cause,
          }),
        ),
      ),
    );

    yield* Effect.forkScoped(
      tick.pipe(Effect.repeat(Schedule.spaced(POLL_INTERVAL)), Effect.ignoreCause({ log: true })),
    );
  }),
);
