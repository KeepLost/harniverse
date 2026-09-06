# @deepseek-ai/dsh-client-store

English | [中文](README.zh.md)

React-free observable and snapshot-store primitives shared by Client controllers and renderer adapters. The package owns the framework-neutral store contracts (`StoreSpec`/`StoreHandle`/`BakedActions`, plus `StorePersistence` for validated projections) and the engine behind them: `createSnapshotStore` (zustand vanilla + subscribeWithSelector + Immer `produce` updates + dev freeze) with synchronous or animation-frame-batched publication, `shallowEqual`, and `defineStore`, which bakes an init/persist/actions literal into a handle whose `create(scopeKey?)` yields per-session or root-scope instances with draft-stripped actions and `clearPersisted` cleanup. Optional `persist` accepts either a whole-state key or a `StorePersistence<T>` with `select`/`restore`. Engine products are bare observables — `getSnapshot`/`subscribe`/`update`/`set`, no selector hook; hook synthesis stays in web-react, which binds `useStore` from these sources at the binding site. ui-slots re-exports the slot-facing contract types; the runtime package re-exports the engine values for existing importers.

## Model Experience

None, as this package provides browser-side state primitives and registers nothing model-facing.

#### KV Cache effect

None; the stores neither assemble nor send model requests.

## Known Limitations and Deferred Work

- **Persistence is browser-local** — persisted stores use JSON in `localStorage`; non-browser runtimes disable persistence, and the package provides no cross-device synchronization.
- **The persist key is the storage identity** — multiple live instances created under the same resolved key share (and cross-pollute) one `localStorage` entry; instance uniqueness per key is the caller's responsibility (the framework caches one instance per handle × scope key).
