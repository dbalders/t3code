import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface OpenCodeExternalSessionSyncResult {
  readonly discoveredCount: number;
  readonly importedCount: number;
  readonly refreshedCount: number;
  readonly skippedCount: number;
  readonly failedInstanceCount: number;
}

export interface OpenCodeExternalSessionSyncShape {
  readonly syncOnce: Effect.Effect<OpenCodeExternalSessionSyncResult>;

  /**
   * Start the background OpenCode history sync within the provided scope.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class OpenCodeExternalSessionSync extends Context.Service<
  OpenCodeExternalSessionSync,
  OpenCodeExternalSessionSyncShape
>()("t3/provider/Services/OpenCodeExternalSessionSync") {}
