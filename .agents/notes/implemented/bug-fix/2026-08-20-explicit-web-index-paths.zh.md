# Agent Note：显式 Web index 路径与静态未命中 404

Status: implemented

[English](2026-08-20-explicit-web-index-paths.md) | 中文

## 问题

无条件 SPA fallback 会让每个未匹配的 GET 或 HEAD 请求看起来成功。失效链接以及缺失的 JavaScript、样式表、source map、manifest 或类似 API 的路径都会收到状态为 200 的 HTML 壳，浏览器、cache 与监控因而无法区分已声明页面入口和不存在的资源。

Harniverse 还有一个基于 pathname 的浏览器入口：已认证 owner 会打开 `/auth/manage`。如果除 `/` 和 `/index.html` 外一律返回 404，就会在修复静态未命中的同时破坏该管理界面。

## 决定

`dsh-host-frontend-static` 只在请求 dist 根路径、已配置 index 文件或精确的 `Config.indexPaths` 条目时渲染 `index.html`。`dsh-web-app` 拥有当前路由组合并声明 `/auth/manage`；通用静态插件不了解认证路径。

现有文件照常提供。`ENOENT`、`EISDIR` 与 `ENOTDIR` 产生空 404；其他文件系统错误交给 Webserver 请求失败处理器。Index 缺失时，每个已声明页面入口都返回同样的 404。GET 与 HEAD 保持一致的状态语义。

## 考虑过的替代方案

- **为每个不含扩展名的路径返回壳。** 未知普通路径和类似 API 的路径仍会表现为成功，而且扩展名语法不能声明浏览器路由。
- **使用 `Accept: text/html`。** 表示偏好不能授权 pathname 成为页面入口；bot 和无效浏览器请求也可以发送相同标头。
- **在 `frontend-static` 中硬编码 `/auth/manage`。** 这会让通用 Host 插件拥有 Harniverse 认证组合决定。

## 后果

缺失资产与未声明路径会公开正确的 HTTP 状态。每个新的 History API pathname 都必须由组合应用增加配置和真实组合覆盖，不能继承宽泛 fallback。

## 验证

Frontend-static Loader 组合覆盖已声明 index 路径、GET／HEAD 一致性、缺失资产、普通及类似 API 的未命中、缺失 index、遍历、非支持方法、压缩、immutable cache 和 fallback dispose。Web-app 组合另行证明 `/auth/manage` 渲染壳，而缺失资产返回 404。
