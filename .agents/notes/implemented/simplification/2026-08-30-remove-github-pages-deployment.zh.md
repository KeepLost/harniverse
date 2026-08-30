# Agent Note: Harniverse 不使用 GitHub Pages 部署

Status: implemented

[English](2026-08-30-remove-github-pages-deployment.md) | 中文

## 问题

Harniverse 具备规范文档投影器和 VitePress 构建，但本仓库当前不把 GitHub Pages 作为产品部署目标。Pages 工作流依赖当前有意缺失的仓库托管配置，在不改善开发反馈的情况下持续产生合并后的失败运行。

## 决策

已移除 `.github/workflows/docs-pages.yml` 中的 GitHub Pages 部署工作流，并禁用对应的 GitHub Actions workflow。文档构建能力继续保留：`website/docs.ts` 投影规范来源，`pnpm run doc-sync` 校验文档，网站构建继续生成供本地和 CI 检查使用的临时 `website/.dist` 输出。

本仓库不配置 `github-pages` environment、Pages 托管、Pages 部署权限或公开文档 URL。未来的托管方式可以复用现有网站构建，并通过单独审查的部署决策接入。

## 考虑过的替代方案

**启用 GitHub Pages 并创建缺失的托管 environment。** 否决，因为托管文档不是当前产品需求，为开发阶段仓库增加外部部署面没有必要。

**在 Pages 未配置时继续保留启用的工作流。** 否决，因为每次向 `master` 推送都会产生可预期的配置失败，既不能验证 Harniverse 代码，也不能验证文档构建。

**同时移除网站投影器和 VitePress 构建。** 否决，因为本地和 CI 文档验证仍有价值，而且它们与托管服务商无关。

## 后果

文档修改仍会得到构建和链接校验，但不会尝试托管部署。GitHub Actions 不再需要本仓库的 Pages 或部署令牌权限；未来选择托管服务商时，也不需要改变规范文档所有权或公开路由投影。
