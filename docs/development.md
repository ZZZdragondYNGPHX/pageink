# 开发指南

## 构建

环境：Node.js 24、npm 11。

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

安装文件位于 `dist/main.js`、`dist/manifest.json` 和 `dist/styles.css`。构建重新生成 `dist/`，校验内核补丁并收集第三方许可。`npm run dev` 监听源码；`npm run package` 构建并生成安装 ZIP、源码 ZIP 和校验和。

## 模块

| 模块 | 职责 |
| --- | --- |
| `main.tsx`、`host.ts` | 插件注册、文件操作、宿主接口。 |
| `Workspace.tsx`、`InkCanvas.tsx` | 工作区、编辑工具、输入与内核集成。 |
| `ink-input.ts`、`ink-viewport.ts`、`spatial.ts` | 输入批处理、视口画布复用、空间查询。 |
| `session.ts`、`storage.ts`、`history.ts` | 文档保存、冲突恢复、正文跨页与草稿纸独立历史。 |
| `notes-host.tsx`、`Library.tsx`、`library-search*.ts` | 文件树集成、文件夹浏览、预览与搜索。 |
| `mixed*.ts`、`cards*.ts` | 段落引用、笔迹绑定、卡片与来源快照。 |
| `properties*.ts` | 属性表单、验证与并发更新。 |
| `archive.ts`、`export*.ts`、`pdf.ts` | 完整备份、导出与 PDF 处理。 |
| `scripts/kernel-patch.mjs` | Excalidraw 补丁，详见[内核补丁](kernel-patches.md)。 |

文件名相对于 `src/`，`scripts/` 除外。文件树 DOM 适配集中在 `notes-host.tsx` 的 `mountExplorers`；文件夹浏览使用 `ItemView`，绘写注册为原生文件视图。

## 数据与集成

Markdown 正文和撤销由原生编辑器管理。绘写保存完整对象、坐标和压力；视口筛选只影响显示，导出读取完整场景。段落与卡片使用稳定引用和不可变来源快照，恢复时另存原件。

属性更新按键提交：Markdown 使用 `processFrontMatter`，绘写使用会话存储与冲突处理。

`kernel-api.ts` 声明内核扩展接口。Excalidraw 的 `@excalidraw/math` / `@excalidraw/utils` 类型映射至包内声明。`eslint.config.mjs` 使用 Obsidian 官方规则检查插件源码和清单。

PDF Worker 通过结构化消息接收字体与页面数据；图片在本地解码。`scripts/pdf-browser.mjs` 移除 PDFKit 浏览器包中的文件路径读取入口。资源与许可见 [PDF runtime assets](pdf-assets.md)。

## 验证

单元测试覆盖几何、原始采样、历史、布局、空间索引和存储。宿主脚本在独立测试库与临时配置中运行，报告与截图输出至 `artifacts/`。

Windows 设置 `OBSIDIAN_EXECUTABLE`；Linux 设置 `OBSIDIAN_APPIMAGE`。宿主脚本共用调试端口，按改动选择并串行运行：

| 范围 | 脚本 |
| --- | --- |
| 书写、擦除、输入、独立视口 | `dev/writing-workflows.mjs`、`dev/input-workflows.mjs` |
| PDF、导出、备份、卡片 | `dev/workflows.mjs`、`dev/cards-workflows.mjs`、`dev/mixed-workflows.mjs` |
| 文件夹、搜索、文字 | `dev/library-workflows.mjs`、`dev/notes-workflows.mjs` |
| 布局与控件 | `dev/ui-polish.mjs`、`dev/dock-workflows.mjs`、`dev/sidebar-workflows.mjs` |
| 性能 | `dev/performance-workflows.mjs optimized` |

性能脚本覆盖 100–50,000 笔的分布场景、10,000 笔密集页面、约 10 秒每帧四个采样的模拟笔输入，以及混合形状、撤销重做和保存重开。报告包含帧间隔、超过 50 ms 的长任务、CPU 热点、JS 堆使用和几何哈希。

`PAGEINK_STRESS_QUICK=1` 将场景缩减为 1,000 笔分布页面和 10,000 笔密集页面。Xvfb 测试设置 `DISPLAY` 与 `PAGEINK_VIRTUAL_DISPLAY=1`。帧间隔和输入回调时间衡量浏览器调度；设备到显示的延迟需实机测量。

## 发布

1. 更新 `manifest.json`、`package.json`、`package-lock.json`、`versions.json` 和 `CHANGELOG.md`。
2. 完成相关验证，运行 `npm run package`。
3. 推送提交，创建与清单版本相同的 Git 标签和 GitHub Release。
4. 上传 `main.js`、`manifest.json`、`styles.css`、安装 ZIP、源码 ZIP 和该版本的 `SHA256SUMS.txt`。

[Obsidian Community](https://community.obsidian.md/plugins/pageink) 自动检测 GitHub Release。目录中的版本、扫描报告和安装状态由平台发布流程更新。
