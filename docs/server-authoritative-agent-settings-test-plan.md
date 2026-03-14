# Server-Authoritative Agent Settings: Full Verification Plan

This document is a step-by-step test plan for the server-authoritative settings change.
It includes:

- Exact commands.
- Expected outcomes.
- Where to inspect code for each behavior.

Use this top-to-bottom once on your machine.

---

## 0. Scope Being Verified

This plan verifies these requirements:

1. `useAppSettings()` remains the single consumer API.
2. Server-authoritative settings are persisted in SQLite and shared across clients:
   - `codexBinaryPath`
   - `codexHomePath`
   - `defaultThreadEnvMode`
   - `customCodexModels`
3. Client-local settings remain device-specific:
   - `timestampFormat`
   - `enableAssistantStreaming`
   - `confirmThreadDelete`
4. One-time legacy migration from `t3code:app-settings:v1` works.
5. Cross-client updates propagate via websocket push (`server.agentSettingsUpdated`).

---

## 1. Preconditions

1. Open terminal in repo root:

```bash
cd /Users/davidbalderston/Github/t3code
```

2. Ensure dependencies are installed:

```bash
bun install
```

3. Choose an isolated state dir for deterministic testing:

```bash
export T3TEST_STATE_DIR=/tmp/t3code-server-settings-e2e
rm -rf "$T3TEST_STATE_DIR"
mkdir -p "$T3TEST_STATE_DIR"
```

---

## 2. Code Review Order (One-by-One)

Review in this exact order before/while testing.

1. **Contracts: schema and wire protocol**
   - `packages/contracts/src/server.ts`
     - `ServerAgentSettings`
     - `ServerAgentSettingsState`
     - `ServerPatchAgentSettingsInput`
     - `ServerAgentSettingsUpdatedPayload`
   - `packages/contracts/src/ws.ts`
     - `WS_METHODS.serverGetAgentSettings`
     - `WS_METHODS.serverPatchAgentSettings`
     - `WS_CHANNELS.serverAgentSettingsUpdated`
     - `WsPushServerAgentSettingsUpdated`
   - `packages/contracts/src/ipc.ts`
     - `NativeApi.server.getAgentSettings`
     - `NativeApi.server.patchAgentSettings`

2. **Server persistence and runtime service**
   - `apps/server/src/persistence/Migrations/014_ServerAgentSettings.ts`
   - `apps/server/src/persistence/Services/ServerAgentSettings.ts`
   - `apps/server/src/persistence/Layers/ServerAgentSettings.ts`
   - `apps/server/src/serverSettings/Services/ServerAgentSettings.ts`
   - `apps/server/src/serverSettings/Layers/ServerAgentSettings.ts`
   - `apps/server/src/serverLayers.ts`

3. **Websocket integration**
   - `apps/server/src/wsServer.ts`
     - stream push for `serverAgentSettingsUpdated`
     - request cases for `serverGetAgentSettings`, `serverPatchAgentSettings`
   - `apps/web/src/wsNativeApi.ts`
     - `onServerAgentSettingsUpdated`
     - `api.server.getAgentSettings`
     - `api.server.patchAgentSettings`
   - `apps/web/src/routes/__root.tsx`
     - invalidation on `onServerAgentSettingsUpdated`

4. **Web app settings behavior**
   - `apps/web/src/lib/serverReactQuery.ts`
     - `serverAgentSettingsQueryOptions`
   - `apps/web/src/appSettings.ts`
     - key split: legacy, client-local, server-cache
     - `splitAppSettingsPatch`
     - optimistic server patch flow
     - legacy migration flow
   - `apps/web/src/routes/_chat.settings.tsx`
     - copy updates reflecting server-authoritative settings

5. **Normalization utility used by both sides**
   - `packages/shared/src/model.ts`
     - `normalizeCustomModelSlugs`

6. **Tests**
   - `packages/contracts/src/ws.test.ts`
   - `apps/server/src/persistence/Layers/ServerAgentSettings.test.ts`
   - `apps/server/src/wsServer.test.ts`
   - `apps/web/src/appSettings.test.ts`
   - `apps/web/src/wsNativeApi.test.ts`
   - `apps/web/src/wsTransport.test.ts`

---

## 3. Mandatory Baseline Checks

Run exactly:

```bash
bun fmt
bun lint
bun typecheck
```

Expected:

1. `bun fmt` exits 0.
2. `bun lint` exits 0.
3. `bun typecheck` exits 0.

If any fail, stop and fix before continuing.

---

## 4. Automated Test Matrix

### 4.1 Contracts Protocol Tests

Command:

```bash
bun --cwd packages/contracts test -- src/ws.test.ts
```

What this validates:

1. New ws method payloads decode.
2. New push channel payload decodes.

### 4.2 Web Unit/Integration Tests

Command:

```bash
bun --cwd apps/web test -- src/appSettings.test.ts src/wsNativeApi.test.ts src/wsTransport.test.ts
```

What this validates:

1. Settings patch split is correct.
2. Legacy extraction helpers are correct.
3. Native API exposes new server methods.
4. New push subscription callback path works.
5. Transport still validates push envelopes safely.

### 4.3 Server Persistence Tests

Command:

```bash
bun --cwd apps/server test -- src/persistence/Layers/ServerAgentSettings.test.ts
```

What this validates:

1. Uninitialized read returns none/default path via service.
2. Upsert and readback works.
3. JSON encode/decode persistence path works.

### 4.4 Server Websocket Tests

Command:

```bash
bun --cwd apps/server test -- src/wsServer.test.ts
```

What this validates:

1. `server.getAgentSettings` default state.
2. `server.patchAgentSettings` writes and returns normalized values.
3. `server.agentSettingsUpdated` push emitted.
4. sqlite persistence across restart.
5. no regressions around existing ws behavior.

Note:

- This suite opens sockets/filesystem watchers heavily. If your environment has watch/socket limits, run locally outside constrained sandboxes.

---

## 5. Manual End-to-End Verification (Product Behavior)

### 5.1 Start Server With Clean State

1. Start app:

```bash
T3CODE_STATE_DIR="$T3TEST_STATE_DIR" bun run dev
```

2. Open UI on **Device A** (desktop browser).
3. Open same server URL on **Device B** (phone or second browser profile).

### 5.2 Verify Default Server Settings State

1. On Device A, go to Settings.
2. Confirm these defaults:
   - Codex binary path: empty
   - CODEX_HOME path: empty
   - Default thread env mode: `local`
   - Custom models: empty
3. Optional DB check:

```bash
sqlite3 "$T3TEST_STATE_DIR/state.sqlite" "select scope, settings_json, updated_at from server_agent_settings;"
```

Expected: empty result before first patch.

### 5.3 Verify Server-Authoritative Sync Across Devices

1. On Device A set:
   - Codex binary path: `/usr/local/bin/codex`
   - CODEX_HOME path: `/tmp/.codex`
   - Default thread env mode: `worktree`
   - Add custom model: `custom/model-alpha`
2. Wait 1-2 seconds.
3. On Device B refresh Settings page.
4. Confirm B shows exactly the same values.

DB verification:

```bash
sqlite3 "$T3TEST_STATE_DIR/state.sqlite" "select scope, settings_json from server_agent_settings;"
```

Expected:

1. One row with `scope = global`.
2. JSON includes the four server-authoritative keys above.

### 5.4 Verify Client-Local Settings Stay Device-Specific

1. On Device A set:
   - Timestamp format: `24-hour`
   - Stream assistant messages: ON
   - Confirm thread deletion: OFF
2. On Device B leave those unchanged (or set opposite values).
3. Refresh both devices.
4. Confirm these three values remain different by device.

### 5.5 Verify Runtime Uses Server Settings

1. On Device A set `codexBinaryPath` to an invalid path: `/does/not/exist/codex`.
2. On Device B start a turn.
3. Expected: turn fails with codex executable/path error.
4. Reset path to valid/empty afterward.

This proves runtime is using server-side settings regardless of client.

### 5.6 Verify Cross-Client Live Push Invalidation

1. Keep Device B on Settings page.
2. On Device A change `defaultThreadEnvMode` local -> worktree or reverse.
3. Device B should update after refetch without full app restart.
4. If needed, navigate away/back once to confirm query refresh.

### 5.7 Verify New Thread Behavior Uses Server Default Env Mode

1. Set `defaultThreadEnvMode=worktree` on Device A.
2. On Device B create a new thread.
3. Confirm new draft/thread starts with New worktree behavior by default.
4. Flip server setting back to `local` and repeat.

---

## 6. Legacy Migration Verification

### 6.1 Prepare Legacy LocalStorage and Empty Server Row

1. Stop app.
2. Ensure server settings table empty:

```bash
sqlite3 "$T3TEST_STATE_DIR/state.sqlite" "delete from server_agent_settings;"
```

3. Start app again with same state dir.
4. In Device A devtools console, set legacy key:

```js
localStorage.setItem(
  "t3code:app-settings:v1",
  JSON.stringify({
    codexBinaryPath: "/legacy/bin/codex",
    codexHomePath: "/legacy/.codex",
    defaultThreadEnvMode: "worktree",
    customCodexModels: ["legacy/model"],
    timestampFormat: "12-hour",
    enableAssistantStreaming: true,
    confirmThreadDelete: false,
  }),
);
location.reload();
```

### 6.2 Verify Migration Effects

Expected after reload:

1. Server settings become initialized with legacy server values.
2. Local settings move to new client-local key behavior.
3. Legacy key removed.

Checks:

```js
localStorage.getItem("t3code:app-settings:v1"); // expected: null
```

```bash
sqlite3 "$T3TEST_STATE_DIR/state.sqlite" "select settings_json from server_agent_settings where scope='global';"
```

Expected JSON contains `"/legacy/bin/codex"` and `"legacy/model"`.

---

## 7. Failure/Rollback Behavior Test

Goal: confirm optimistic UI patch rolls back when server patch fails.

1. Start server normally.
2. Open Settings on one device.
3. Temporarily stop server process.
4. Change a server-authoritative setting in UI.
5. Expected:
   - Error toast shown: "Unable to save server settings".
   - On reconnect/refetch, UI returns to persisted server values.
6. Restart server and reload page to confirm final state persisted correctly.

---

## 8. SQL-Level Assertions

Run:

```bash
sqlite3 "$T3TEST_STATE_DIR/state.sqlite" ".schema server_agent_settings"
sqlite3 "$T3TEST_STATE_DIR/state.sqlite" "select scope, updated_at, settings_json from server_agent_settings;"
```

Expected schema:

1. table `server_agent_settings`
2. columns: `scope`, `settings_json`, `updated_at`
3. primary key on `scope`

Expected data:

1. max one row for `scope=global`
2. JSON payload reflects latest server-authoritative settings.

---

## 9. Quick Pass/Fail Checklist

Mark all as pass before merge:

1. `bun fmt` pass
2. `bun lint` pass
3. `bun typecheck` pass
4. contracts tests pass
5. web tests pass
6. server persistence tests pass
7. wsServer tests pass in local unrestricted environment
8. cross-device server-setting sync pass
9. local-only setting isolation pass
10. legacy migration pass
11. rollback-on-failure UX pass
12. sqlite row/state assertions pass

---

## 10. Troubleshooting

1. If ws server tests fail with `EPERM listen` or `EMFILE watch`:
   - Run outside sandboxed CI shell.
   - Increase file descriptor limit:
   ```bash
   ulimit -n 8192
   ```
2. If cross-device sync appears stale:
   - Confirm both clients are connected to same server URL and state dir.
   - Verify `server.agentSettingsUpdated` handler in `apps/web/src/routes/__root.tsx`.
3. If custom models are not preserved:
   - Check normalization in `packages/shared/src/model.ts` and service patch path in `apps/server/src/serverSettings/Layers/ServerAgentSettings.ts`.
