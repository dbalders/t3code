import { ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";

import type { ProviderInstanceEntry } from "./providerInstances";

export const VISIBLE_PROVIDER_DRIVER = ProviderDriverKind.make("opencode");

export function isVisibleProviderDriver(driver: ProviderDriverKind): boolean {
  return driver === VISIBLE_PROVIDER_DRIVER;
}

export function filterVisibleServerProviders(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ServerProvider> {
  return providers.filter((provider) => isVisibleProviderDriver(provider.driver));
}

export function filterVisibleProviderInstanceEntries(
  entries: ReadonlyArray<ProviderInstanceEntry>,
): ReadonlyArray<ProviderInstanceEntry> {
  return entries.filter((entry) => isVisibleProviderDriver(entry.driverKind));
}
