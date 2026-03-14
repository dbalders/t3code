import { queryOptions } from "@tanstack/react-query";
import { ensureNativeApi } from "~/nativeApi";

export const serverQueryKeys = {
  all: ["server"] as const,
  config: () => ["server", "config"] as const,
  agentSettings: () => ["server", "agent-settings"] as const,
};

export function serverConfigQueryOptions() {
  return queryOptions({
    queryKey: serverQueryKeys.config(),
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.server.getConfig();
    },
    staleTime: Infinity,
  });
}

export function serverAgentSettingsQueryOptions() {
  return queryOptions({
    queryKey: serverQueryKeys.agentSettings(),
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.server.getAgentSettings();
    },
    staleTime: Infinity,
  });
}
