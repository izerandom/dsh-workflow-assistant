# INSTALL — 本地安装

官方机制见 https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish

## 前提

- `dsh` CLI 已安装；或使用源码 checkout（命令改为 `pnpm dsh ...`）
- 本机 profile：`C:\Users\D\.dsh\profiles\desktop`（本插件目标 profile）

## 安装（本地路径）

```sh
# 在包含 dsh-workflow-assistant 的目录执行（或使用绝对路径）
dsh plugin --profile desktop add ./dsh-workflow-assistant
```

该命令会：pnpm 链接包 → 追加 `dsh.profile.bundles` → 应用 `cordis.patch.yml` 的插入行。

验证层已生效：

```sh
dsh --profile desktop --dump-config   # 应看到 "# == dsh-workflow-assistant" 层
```

## 生效方式

- 编辑 `profiles/desktop/cordis.patch.yml`（用户 patch 层）会被 HMR 热重载；**但新增一个 bundle 包**通常需要重启 profile 才完整生效（Host 插件装载 + 浏览器加载客户端模块）。
- 重启：`dsh --profile desktop`（或桌面应用重启）。
- 重启前建议**停用动态插件**避免 UI 重复：在会话中执行 `cordis_stop`（或删除该动态插件）。

## 卸载

```sh
dsh plugin --profile desktop remove dsh-workflow-assistant
```

## 更新

修改代码后重新 `add`（或 `pnpm add file:` 重新链接），按 CHANGELOG 提升版本号；重启生效。

## 手动安装（无 CLI 时）

1. 把包复制进 `profiles/desktop/node_modules/dsh-workflow-assistant/`
2. `profiles/desktop/package.json` 的 `dependencies` 加 `"dsh-workflow-assistant": "link:...或 file:..."`，`dsh.profile.bundles` 追加 `"dsh-workflow-assistant"`
3. 重启 profile

## 故障排查

- 查看器 404：Host 半未装载 —— 检查 bundles 列表与 patch 插入行
- 胶囊不出现：客户端模块未加载 —— 刷新页面；仍无则检查 `dsh.client` manifest 与 `exports["./client"]`
- 状态不更新：确认 `workorders/` 在会话工作区根目录；点「🔄 更新」或等 1 分钟轮询
