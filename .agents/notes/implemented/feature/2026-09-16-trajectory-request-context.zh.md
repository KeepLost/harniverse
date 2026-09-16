# Agent Note: 轨迹请求 Context 标签页 — 带seq 导航的模型可见组成

Status: implemented

[English](2026-09-16-trajectory-request-context.md) | 中文

Scope: `packages/client/ui-trajectory`

## Problem

上下文管理套件交付了服务端审计清单(`ctx.contextInspector`),但消费端界面被推迟:Web UI 无法查看单个请求实际发送了什么,也没有任何机制把上下文条目链接回产生它的会话。所有者否决了该推迟:计划项必须交付,不得擅自延期。

## Decision

轨迹请求检查器新增 `Context` 标签页。纯推导函数(`request-context.ts`)遍历请求锚点seq 之前的已组装 `ConversationNode`:每个仍存活的界面条目(user、assistant、tool、steering、context 注入)生成一个段,每个已落地的 `CompactionSummaryNode` 将其替换的条目吸收为一个摘要段,并携带已记录的条目数与 token 数。段行通过既有记录身份路径按 `sourceSeq` 导航账本,使每个上下文条目都链接到其轨迹行。流式请求(尚无锚点)推导完整当前窗口。零 runtime、host、事件格式变更:组成是账本已持有数据的可重放投影。

## Alternatives considered

- 通过新增 HTTP/RPC 端点暴露服务端清单:否决——组成可在客户端从会话日志推导,线上接口会复制检查器已钉死的唯一权威推导。
- 在账本行内渲染面板:否决——请求详情检查器已拥有按请求的组合视图(Options/Usage/Timing),标签页是原生缝。

## Consequences

检查器被推迟的缺口已在两个消费端补齐:上述 Web 标签页,以及为 CLI 渲染检查器清单的 `/context` 斜杠命令(`dsh-command-context`),带每段 seq 溯源。后续影响上下文的特性必须扩展该推导(或其夹具)而非绕开,因为该标签页如今是"这个请求看到了什么"的用户侧契约。
