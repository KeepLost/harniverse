# Agent Note: present 批量立场——默认上限 4，指引并入描述

Status: implemented

[English](2026-10-04-present-batching-stance.md) | 中文

范围：`packages/deliverables/tool-present`

## 问题

Wave-4 吸收行 R11：`present` 以 `maxFiles` 默认 `8` 限制一次调用，而其描述对批量只字未提。模型面对多文件请求时要么发出一次超宽调用——更糟的是把一个请求的文件摊成一串零碎调用——数量与排序都不体现「交付交接应该长什么样」的立场。

## 决策

- `maxFiles` 默认改为 `4`（显式配置仍然生效；实际执行的上限跟随 `maxFiles`，错误文案亦然）。
- `present` 描述把交付义务与固定批量指引合并：用户要求的每个文件都必须 present，通常 1–2 个文件、每次调用至多 4 个，最重要的文件排在最前。指引同时点名经 Bash 或代码执行创建的文件也要 present。不再强调 Office 文件。

## 备选方案

**保留 8 文件默认、仅加指引。** 否决：指引与执行会互相矛盾；第一次 `present accepts 1 to 8 files` 失败就会把旧数字教回给模型。

**在宿主侧强制排序或拆分超限调用。** 否决：重要性是模型的判断，静默改写调用会把模型自己的批量行为从日志里藏掉。

## 后果

默认立场是小而有序的批量，且被要求的文件一个不漏。确需更宽交付的部署配置 `maxFiles`，此时描述中的「至多 4 个」读作默认立场的表述，而实际执行的上限仍由配置拥有。

## 验证

`packages/deliverables/tool-present` 套件：描述逐字钉住合并后的指引、默认上限接受 4 个并以 `present accepts 1 to 4 files` 拒绝 5 个、覆盖的 `maxFiles: 5` 接受五文件调用。
