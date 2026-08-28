# Repository map

Generated from the checked-in architecture contract and source registries.

## Architecture

- Source root: `src`
- Layers: `src/app`, `src/features`, `src/shared`
- Feature contract: `module.json` + `index.ts`
- Import alias: `@/`
- Production TypeScript limit: 450 lines

## App routes

Registry: `src/app/router/route-registry.tsx`

| Path         | Label     | Page             | Feature              |
| ------------ | --------- | ---------------- | -------------------- |
| `/`          | Чаты      | `ChatPage`       | `chat`               |
| `/skills`    | Скиллы    | `skillsRoute`    | `catalog`            |
| `/tools`     | Тулы      | `toolsRoute`     | `catalog`            |
| `/mcp`       | MCP       | `mcpRoute`       | `catalog`            |
| `/models`    | Модели    | `modelsRoute`    | `models`             |
| `/providers` | Доступы   | `providersRoute` | `providers`          |
| `/insights`  | Аналитика | `insightsRoute`  | `insights`           |
| `/memory`    | Память    | `memoryRoute`    | `memory`             |
| `/profiles`  | Профили   | `profilesRoute`  | `profile-management` |

## Features

### `catalog`

- Description: Profile-scoped skills, toolsets, and MCP catalog screens.
- Module: `src/features/catalog/module.json`
- Public entry: `src/features/catalog/index.ts`
- Dependencies: `profiles`
- Public exports: `McpPage`, `SkillsPage`, `ToolsPage`
- Source files: 37

### `chat`

- Description: Persistent chat runtime, session history, streaming events, and chat UI.
- Module: `src/features/chat/module.json`
- Public entry: `src/features/chat/index.ts`
- Dependencies: `gateway`, `model-selection`, `profiles`
- Public exports: `ChatPage`, `ChatRuntimeProvider`
- Source files: 65

### `gateway`

- Description: Browser-to-Hermes transport, reconnect state, and local gateway settings.
- Module: `src/features/gateway/module.json`
- Public entry: `src/features/gateway/index.ts`
- Dependencies: —
- Public exports: `ConnectionState`, `GatewayClient`, `GatewayEvent`, `GatewayProvider`, `GatewaySheet`, `hostFromOrigin`, `useGateway`
- Source files: 13

### `insights`

- Description: Profile-scoped usage analytics route: a single cost figure, one calls pulse, compact model/tool/skill rankings, and a short sessions/tasks/host footer, drawn with a local inline-SVG chart kit.
- Module: `src/features/insights/module.json`
- Public entry: `src/features/insights/index.ts`
- Dependencies: `profiles`
- Public exports: `InsightsPage`
- Source files: 31

### `memory`

- Description: Profile-scoped stored memory: learning-graph chunks and learned skills with node editing, plus memory backend selection, provider setup, and reset.
- Module: `src/features/memory/module.json`
- Public entry: `src/features/memory/index.ts`
- Dependencies: `profiles`
- Public exports: `MemoryPage`
- Source files: 20

### `model-selection`

- Description: Model catalog parsing, selection controls, and assignment operations.
- Module: `src/features/model-selection/module.json`
- Public entry: `src/features/model-selection/index.ts`
- Dependencies: —
- Public exports: `ModelCapability`, `ModelPicker`, `ProviderOption`, `ReasoningPicker`, `modelCapabilityFor`, `modelKeys`, `modelSelectionApi`
- Source files: 10

### `models`

- Description: Profile-aware model catalog route.
- Module: `src/features/models/module.json`
- Public entry: `src/features/models/index.ts`
- Dependencies: `model-selection`, `profiles`
- Public exports: `ModelsPage`
- Source files: 3

### `profile-management`

- Description: Lazy profile management route, model assignment, and capability-scoped model settings.
- Module: `src/features/profile-management/module.json`
- Public entry: `src/features/profile-management/index.ts`
- Dependencies: `model-selection`, `profiles`
- Public exports: `ProfilesPage`
- Source files: 4

### `profiles`

- Description: Always-mounted active profile scope, metadata, storage, and API access.
- Module: `src/features/profiles/module.json`
- Public entry: `src/features/profiles/index.ts`
- Dependencies: `model-selection`
- Public exports: `ProfileProvider`, `metaFor`, `profileApi`, `profileKeys`, `useProfileScope`
- Source files: 11

### `providers`

- Description: OAuth logins, API keys, credential pool, and custom endpoints for the gateway's model providers.
- Module: `src/features/providers/module.json`
- Public entry: `src/features/providers/index.ts`
- Dependencies: `profiles`
- Public exports: `OauthUsageStrip`, `ProvidersPage`
- Source files: 30

## Shared

- Source files: 27

## App implementation

- Source files: 10
