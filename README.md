# dsh-workflow-assistant

development-workflow 工作单助手 —— DeepSeek Harness 插件（组合包 bundle）。

- **悬浮胶囊**：右下角实时显示「有 N 项待办 / 暂无待办」
- **待办面板**：聚合两个需要用户出手的工作流门 —— 中/高复杂度「待评审」、实现完成后的「待验收」
- **工作单列表**：文件名 + 状态徽标（状态 = 进度清单勾选数自动推断：未开始 / 确认中 / 实现中 / 待验收 / 验收中 / 已完成）
- **HTML 查看器**：点击工作单在新标签打开（`/workorders-viewer`），卡片/状态标签/进度条/表格/深色模式；正文用 [marked](https://github.com/markedjs/marked)（随包分发的本地 vendor）渲染完整 Markdown：代码块、行内代码、粗体、链接、引用等
- **对话框联动**：「✓ 通过 / ✓ 验收通过」一键发送确认文案并唤醒 AI；「✗ 打回 / ✗ 验收未通过」预填输入框供补充原因

**设计原则**：工作单文件是唯一真相 —— 状态与待办完全由 `workorders/T-YYYYMMDD-xxx.md` 的进度清单推导，插件不做任何记账。唯一写入：点「✓ 通过 / ✓ 验收通过」时由插件勾选工作单对应项（评审 / 最终验收），使待办立即消失。更新机制：1 分钟轮询 + 监听 AI 对工作单的写操作立即重扫 + 手动「🔄 更新」。

## 目录结构

```
dsh-workflow-assistant/
├── package.json        # dsh.bundle + dsh.client manifest（npm 包）
├── dsh.plugin.json     # 插件清单
├── cordis.patch.yml    # 组合包插入层
├── lib/index.js        # Host 半：查看器路由 + 数据 API + AI 行为监听
├── lib/client.js       # 客户端 Web 模块（__ModuleLoader__ 格式）
├── lib/vendor/         # 本地第三方资源（marked.min.js，MIT）
├── CHANGELOG.md        # 版本演进
└── INSTALL.md          # 安装手册
```

## 版本管理

- 遵循 semver：功能新增 → minor，修复 → patch，破坏性重构 → major
- 每次变更在 `CHANGELOG.md` 记录（时间/改动/动机）
- 建议将本目录作为独立 git 仓库（或并入你的项目仓库），用 tag 对齐版本号
- 发布形态三选一（见官方文档）：本地路径 / git 仓库（需 `prepare` 脚本自构建）/ npm 或 tarball

## 开发

```sh
# 语法校验
node --check lib/index.js
node --check lib/client.js

# 本地安装（见 INSTALL.md）
dsh plugin --profile desktop add ./dsh-workflow-assistant
```
