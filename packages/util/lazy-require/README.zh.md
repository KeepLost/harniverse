# dsh-lazy-require

[English](README.md) | 中文

面向 CommonJS 兼容宿主依赖的调用方相对懒加载。只有一个极小的函数：把急切的顶层原生 import 包成首次使用时才加载，让无图片或无 PTY 的启动不为可能永远用不到的 binding 买单。

## 它做什么

`createLazyRequire` 基于 Node 的 `createRequire` 构造一个零参加载器，锚定在调用方自己的 `import.meta.url` 上，发布后的包布局因此保持正确解析。只有成功加载会被缓存；失败的加载不缓存，纠正安装之后的下一次调用即可重试。

```ts
import type sharp from 'sharp'
import { createLazyRequire } from '@deepseek-ai/dsh-lazy-require'

const requireSharp = createLazyRequire<typeof sharp>('sharp', import.meta.url)

// First use loads the native binding; every later call returns the same module.
const metadata = await requireSharp()(input).metadata()
```

泛型参数保留调用方提供的模块类型；请保留 `import type` 一侧，让依赖本身在首次使用前不进入模块图。

## 已知限制与暂缓事项

- **仅适用于 CommonJS 兼容依赖**——ESM-only 的包需要由其调用方自持异步 `await import()` 工厂。
- **静态打包器无法看穿 `createLazyRequire()` 调用**——打包/浏览器构建必须让依赖名保持为可发现的字面量请求；当前所有消费者都不发布打包产物。
