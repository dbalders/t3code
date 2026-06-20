/**
 * OpenCodeAdapter — shape type for the OpenCode provider adapter.
 *
 * Historically this module exposed a `Context.Service` tag so consumers
 * could inject the adapter through the Effect layer graph. The driver
 * model ({@link ../Drivers/OpenCodeDriver}) bundles one adapter per
 * instance as a captured closure instead, so the tag is gone — we only
 * retain the shape interface as a naming anchor for the driver bundle.
 *
 * @module OpenCodeAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";
import type * as Effect from "effect/Effect";

export interface OpenCodeExternalSessionModel {
  readonly id: string;
  readonly providerID: string;
  readonly variant?: string | undefined;
}

export interface OpenCodeExternalSessionSummary {
  readonly sessionId: string;
  readonly directory: string;
  readonly path?: string | undefined;
  readonly title: string;
  readonly model?: OpenCodeExternalSessionModel | undefined;
  readonly createdAtEpochMs: number;
  readonly updatedAtEpochMs: number;
  readonly archivedAtEpochMs?: number | undefined;
}

/**
 * OpenCodeAdapterShape — per-instance OpenCode adapter contract. Carries
 * a branded driver kind as the nominal discriminant.
 */
export interface OpenCodeAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  /**
   * Discover OpenCode sessions for existing T3 project directories.
   *
   * This intentionally does not expose a global OpenCode history scan; callers
   * provide the exact project roots T3 already knows about and apply their own
   * projection/import policy.
   */
  readonly listExternalSessions: (input: {
    readonly directories: ReadonlyArray<string>;
    readonly limit?: number | undefined;
  }) => Effect.Effect<ReadonlyArray<OpenCodeExternalSessionSummary>, ProviderAdapterError>;
}
