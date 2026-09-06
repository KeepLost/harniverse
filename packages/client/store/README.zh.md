# @deepseek-ai/dsh-client-store

[English](README.md) | 中文

供 Client controller 与 renderer adapter 共用的不依赖 React 的 observable 和 snapshot-store 基础设施。本包持有框架中立的 store 约定（`StoreSpec`／`StoreHandle`／`BakedActions`，以及用于校验投影的 `StorePersistence`）与背后的引擎：`createSnapshotStore`（zustand vanilla + subscribeWithSelector + Immer `produce` 更新 + 开发期冻结），支持同步或按 animation-frame 批量发布；`shallowEqual`；以及 `defineStore`——把 init/persist/actions 字面量封装为句柄，其 `create(scopeKey?)` 产出按会话或根 scope 的实例，携带去除 draft 参数的 actions 与 `clearPersisted` 清理。可选 `persist` 接受完整状态 key，或带 `select`／`restore` 的 `StorePersistence<T>`。引擎产物是裸 observable——`getSnapshot`／`subscribe`／`update`／`set`，没有 selector 钩子；钩子合成留在 web-react，在绑定点从这些 source 构造 `useStore`。ui-slots 再导出面向 slot 的约定类型；runtime 包为既有导入方再导出引擎值。

## 模型体验

无，因为本包提供浏览器侧状态基础设施，不注册任何面向模型的内容。

#### KV Cache 影响

无；这些 store 既不组装也不发送模型请求。

## 已知限制与暂缓事项

- **持久化仅限浏览器本地**——持久化 store 使用 `localStorage` 中的 JSON；非浏览器运行时会禁用持久化，本包也不提供跨设备同步。
- **persist key 即存储身份**——同一解析 key 下创建的多个活实例共享（并互相污染）同一个 `localStorage` 条目；每个 key 的实例唯一性由调用方负责（框架按句柄 × scope key 缓存一个实例）。
