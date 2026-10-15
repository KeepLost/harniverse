# Agent Note: 认证重置期间的壁纸保留

Status: implemented

[English](2026-10-15-wallpaper-retention-across-auth-resets.md) | 中文

## Problem

交换密钥或重新认证会让外壳壁纸消失。认证身份变化触发 `SettingsDescribeMirror.reset()`，清空已授权的设置描述；每个绑定的作用域随之以 `value: undefined` 重新派生，`normalizeSettings` 把这段间隙塌缩为默认值——`wallpaper: ''`——于是 `resolveBackdrop` 在重置到新的 `settings.describe` 应答到来之前一直回落到皮肤渐变（或什么都不画）。壁纸只有等作用域再次 ready 才回来，哪怕字节、对象 URL 和最后一份良好目录全都还活在插件里。

## Decision

**皮肤控制器保住在权威设置段落之下展示过的最后一张壁纸，并在没有段落立足期间继续绘制它。** `resolveBackdrop` 增加了可选的 `retained { hash, blur }` 输入，只在设置壁纸为空时被咨询；控制器恰好在 `scope.value === undefined`（重新派生间隙）时传入它，并在有段落立足时更新或清除：选择壁纸的段落刷新保留项（哈希与模糊值），选择无壁纸的段落清除它。目录不再持有的保留哈希照旧回落到渐变，强制不透明的环境开关仍然优先于保留。由于发布的 `backdrop` 切片在整段间隙保持 `kind: 'wallpaper'`，`WallpaperLayer` 不会卸载，引用计数的对象 URL 一直被持有，槽位条目也从不切换——绝不会在 Remote 不可达时发起重新获取。作用域加载期间各行仍读取塌缩后的默认设置并禁用写入，因此除刻意保持的背景外，间隙在各处都保持诚实。

## Alternatives considered

**在作用域或镜像层保留整个设置段落。** 否决：`SettingsDescribeMirror.reset()` 的存在意义就是清空上一个连接世代授权的一切；保留段落会把一个主体的已脱敏设置泄露进下一个主体的窗口。保留范围只限于皮肤插件内部本就展示在屏幕上的视觉背景。

**客户端持久化壁纸字节（Cache API / IndexedDB）。** 暂缓：它还能覆盖离线时的页面刷新，但会引入本修复不需要的存储表面与过期规则——上报的缺陷是会话内的重认证间隙，对象 URL 的生命周期已经足够覆盖。

## Consequences

交换密钥或重新认证不再清空背景；壁纸持续绘制直到新的权威段落就位，然后精确跟随它（包括服务端清除）。落在另一台主机上的重新认证期间，过期壁纸可能短暂展示到该主机的设置与目录应答为止——这与任何镜像 UI 的过期窗口一致。离线状态下刷新页面依然没有壁纸（字节未持久化）；该事项作为上述字节缓存方案的后续工作保留。

验证：`controller.client.spec.ts` 驱动作用域经历 ready → 间隙 → ready（间隙保持保留、权威清除生效、之后的间隙不再保留），并在间隙中目录丢失哈希时丢弃保留；`view.client.spec.ts` 覆盖 `resolveBackdrop` 的保留分支，包括强制不透明的优先级。

PR: #191 (merge)
