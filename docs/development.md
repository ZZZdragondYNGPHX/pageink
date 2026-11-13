# 开发指南

## 构建

使用 Node.js 24 和 npm 11，在仓库根目录执行：

```sh
npm ci
npm run typecheck
npm test
npm run build
```

`dist/main.js`、`dist/manifest.json`、`dist/styles.css` 是插件安装文件。构建会替换 `dist/`，验证内核补丁，并生成完整第三方许可。`npm run dev` 监听源码变化；`npm run package` 生成安装包和源码包。

## 源码结构

| 模块 | 职责 |
| --- | --- |
| `src/main.tsx`、`src/host.ts` | 插件注册、文件操作和宿主适配。 |
| `src/Workspace.tsx`、`src/InkCanvas.tsx` | 绘写工作区、输入与编辑内核集成。 |
| `src/session.ts`、`src/storage.ts`、`src/history.ts` | 保存、冲突处理、跨页历史与独立草稿纸历史。 |
| `src/notes-host.tsx`、`src/Library.tsx`、`src/library-search*.ts` | 原生工作台集成、文件夹浏览、内容预览与搜索。 |
| `src/mixed*.ts`、`src/cards*.ts` | 段落引用、笔迹绑定、卡片与来源备份。 |
| `src/properties*.ts` | 属性验证、表单与并发保存。 |
| `src/archive.ts`、`src/export*.ts`、`src/pdf.ts` | 完整备份、导出及 PDF 处理。 |
| `scripts/kernel-patch.mjs` | 集中管理 Excalidraw 修改，详见[内核补丁](kernel-patches.md)。 |

文件树工具栏暂无公开扩展 API；`notes-host.tsx` 将 DOM 适配集中在 `mountExplorers`，卸载恢复原始按钮与事件，核心能力通过宿主命令、文件/编辑器菜单和原生标签页复用。文件夹浏览状态使用 `ItemView` 状态，绘写注册为原生文件视图。

Markdown 正文与撤销由原生编辑器负责。绘写数据保存完整对象与采样，视口只影响显示；导出读取完整内容。段落和卡片使用稳定引用与不可变来源快照，恢复时另存可编辑原件。

属性更新只写入发生变化的键。Markdown 使用 `processFrontMatter`；绘写沿用已有保存和冲突处理，避免覆盖并发修改或重写笔迹。

## 宿主测试

安装 Obsidian 后，在 Windows 设置 `OBSIDIAN_EXECUTABLE` 为程序绝对路径；Linux 设置 `OBSIDIAN_APPIMAGE`。然后按需串行运行：

```sh
node dev/ui-polish.mjs
node dev/writing-workflows.mjs
node dev/library-workflows.mjs
node dev/notes-workflows.mjs
node dev/mixed-workflows.mjs
node dev/cards-workflows.mjs
node dev/workflows.mjs
```

脚本创建独立测试库与临时配置，报告和截图写入被 Git 忽略的 `artifacts/`。宿主脚本共用调试端口，不能同时运行；测试期间不要重建正在加载的插件。

## 发布

1. 同步更新 `manifest.json`、`package.json`、`package-lock.json` 和 `versions.json`，在 `CHANGELOG.md` 描述用户可见变化。
2. 完成相关检查，执行 `npm run package`，核对安装文件、许可与版本。
3. 推送源码，创建与清单版本完全相同的 Git 标签和 GitHub Release。
4. 单独上传 `main.js`、`manifest.json`、`styles.css`，并附安装 ZIP 与校验和。

首次收录通过 [Obsidian Community](https://community.obsidian.md/) 提交，流程见[官方发布指南](https://docs.obsidian.md/plugins/releasing/submit-plugin)。
