# UI / UX 打磨：设计依据与验证

本轮围绕笔记库、新建入口、书写工具与搜索操作实施，保留现有文档、保存、宿主服务和编辑内核。依据现有代码与 Windows 隔离 Obsidian 的实际截图发现问题，再对照下列资料调整。

## 调研与取舍

| 来源 | 采用的部分 | 在 PageInk 中的落点 |
| --- | --- | --- |
| [Goodnotes：Improved User Interface](https://support.goodnotes.com/hc/en-us/articles/13682253498767-Improved-User-Interface) | 文档导航与书写工具分区，当前工具的设置就近展开 | 保持现有工具位置；优化工具键盘导航、设置浮层与返回焦点 |
| [Goodnotes：Get Started](https://support.goodnotes.com/hc/en-us/articles/7378598719759-Get-Started-With-Goodnotes-for-Android-Windows-and-Web) | 笔记库作为起点；记住上次的纸张选择 | 三种常用笔记直接创建，复用已有纸张偏好；无需先填写名称 |
| [Goodnotes Education：界面说明](https://goodnoteseducation.zendesk.com/hc/en-us/articles/13933174130959-Get-Started-with-Goodnotes) | 原文展示了 Library、Nav Bar、Toolbar 的职责与工具属性布局 | 继续沿用现有分区，没有增加第二套编辑模式 |
| [Bear 官方界面](https://bear.app/) | 标题、内容线索、时间的紧凑层次；克制的分隔与图标 | 对照官方 Mac 截图调整笔记列表，类型、文件夹和时间放在次级信息行 |
| [Apple Freeform：创建与管理画板](https://support.apple.com/guide/freeform/create-a-board-frfm9474646a9/mac) | 先开始工作，随后命名；自动保存 | 一键创建、名称按需填写，窄屏继续显示保存状态 |
| [Apple Freeform：搜索画板](https://support.apple.com/guide/freeform/search-your-boards-frfm18ab658ed/mac) | 搜索与浏览相互补充 | 类型筛选始终可见，附带实际数量；搜索后保留类型上下文 |
| [Apple Freeform：快捷键](https://support.apple.com/guide/freeform/keyboard-shortcuts-and-gestures-frfm46c25187e/mac) | 高频操作通过键盘即时完成 | 笔记库 Ctrl/Cmd+F、搜索结果方向键与 Enter |
| [NN/g：Progressive Disclosure](https://www.nngroup.com/articles/progressive-disclosure/) | 将低频选项放到明确的次级入口 | 搜索范围放入“搜索选项”；名称与纸张折叠为可选项 |
| [NN/g：Recognition and Recall](https://www.nngroup.com/articles/recognition-and-recall/) | 用可见线索减少记忆负担 | 图标带文字入口；窄屏不再同时隐藏类型和修改日期 |
| [NN/g：Search Is Not Enough](https://www.nngroup.com/articles/search-not-enough/) | 搜索不能取代可浏览的结构 | 无需关键词也可按类型找到笔记；空结果可一键回到全部笔记 |
| [NN/g：User Intent Affects Filter Design](https://www.nngroup.com/articles/applying-filters/) | 简单探索式筛选及时反馈 | 单个类型筛选直接更新，不添加“应用筛选”步骤 |
| [W3C APG：Radio Group](https://www.w3.org/WAI/ARIA/apg/patterns/radio/) | 单个 Tab 停靠点，方向键切换选项 | 工具颜色、粗细、分段选择与纸张选择 |
| [W3C APG：Toolbar](https://www.w3.org/WAI/ARIA/apg/patterns/toolbar/) | 方向键移动焦点，明确激活工具 | 左右键浏览工具；Enter 激活；Home/End 到两端 |
| [W3C APG：Keyboard Interface](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/) | 组合控件内外的焦点规则 | Escape 回到弹层触发按钮，点击外部不抢焦点 |
| [Vercel Web Interface Guidelines](https://github.com/vercel-labs/web-interface-guidelines/blob/main/command.md) | 焦点、长文本、异步反馈、触控与主题检查 | 本轮执行者自查清单，按 Obsidian 宿主场景选取适用规则 |
| [Lucide 官方图标与许可](https://lucide.dev/license) | 直接使用官方 SVG 资产 | 复用已锁定的 `lucide-react@1.70.0` 和宿主 Lucide 图标，移除新建窗口自绘的装饰示意 |

产品截图仅用于对照，没有将其他产品的截图、商标或封面打包进插件。实际分发素材仍为官方 Lucide 图标；ISC 与 Feather MIT 声明沿用现有许可生成器完整保留。没有新增依赖或运行时网络请求。

## 视觉与流程

继承宿主字体和主题变量。备用颜色沿用 `#FFFFFF`（内容）、`#F5F6F8`（次级背景）、`#E3E6EA`（分隔）、`#1F2329`（正文）、`#6B7380`（次级信息）、`#3267B2`（操作强调）。深色主题继承宿主背景、文本和已有浅蓝强调。标题 24px、笔记名称 14px、辅助信息 11–12px；桌面控件沿用 36px，触控主要控件为 44px。

布局为“笔记库与日常操作 → 三种直接创建入口 → 搜索与类型 → 按最近修改排列的笔记”。桌面内容左对齐，窄屏创建入口居中纵向排列，保留类型副说明；不增加封面墙、营销插画、新字体或第二套侧栏。列表分隔保持安静，工具和内容仍是主体。

## 名称与文案

用户指出旧入口“文字笔记／笔记本／自由画布”未能准确解释三种文件用途，并要求语言更有书卷气。采用短名称加具体说明：

| 类型 | 名称 | 新建说明 | 窄屏说明 |
| --- | --- | --- | --- |
| Markdown | 文笺 | 以字记事 · Markdown 文件 | .md 文件 |
| 分页绘画 | 手札 | 落笔成页 · 分页绘写 | 分页绘写 |
| 无边绘画 | 长卷 | 随笔铺展 · 无边画布 | 无边画布 |

三类定义统一来自 `src/notes.ts` 的 `NOTE_TYPES`，用于新建卡片、笔记库、工具栏、命令与默认文件名。已有文件名不改写，内部类型和格式不迁移。窄屏始终保留具体说明，辅助技术也能读取类型说明。

新建引导为“把所见所思，留在纸间。”，空笔记库为“一页空白，等你落笔”。动作保持准确：文笺“开始写作”、手札“开始书写”、长卷“展开画布”。保存、删除、导出和错误提示不使用隐喻。

同步校正卡片、段落、属性和草稿纸文案：“画板卡片”统一为“画布卡片”；长卷文字面板不再误称“本页”；草稿纸明确“复制到当前页／复制到画布”；属性表单用“是／否”和“文字列表”，错误提示用“当前笔记”代替“绘图会话”。

| Before | After | Why |
| --- | --- | --- |
| 创建任何笔记先经过类型弹窗 | 笔记库直接点击文笺、手札或长卷；另保留“新建与导入” | 常用新建减少一次交互 |
| 名称和纸张默认展开，先聚焦名称 | 可选项按需展开，默认聚焦创建按钮 | 无需命名即可写；减少移动端键盘占屏 |
| 搜索范围复选框和限制说明常驻首屏 | 默认搜索内容，在“搜索选项”调整范围 | 不要求用户先理解搜索实现 |
| 窄屏隐藏类型和日期 | 类型、文件夹、日期在次级信息行换行或截断 | 缩窄后仍能识别笔记 |
| 所有错误都提供“重新读取” | 列表读取、搜索、打开/创建分别重试对应操作 | 重试能真正解决刚才失败的动作 |
| 中文输入中间态触发搜索，旧结果可暂留 | 组合输入结束再检索；按当前请求识别结果 | 避免候选输入干扰及错开旧结果 |
| 搜索原文的定位较晚完成时，可能抢回焦点 | 返回笔记库后，过期跳转不再设置焦点 | 快速往返时保留用户最新选择 |
| 单选控件的每一项都占用 Tab，缺少方向键 | 每组一个 Tab 停靠点，方向键选择 | 键盘路径更短，与控件语义一致 |
| 高频工具弹层淡入 | 立即显示 | 输入路径无需等待；没有新增动态效果 |
| 弹层清理时可能失去触发器焦点 | Escape 明确返回触发器；外部点击保留目标焦点 | 关闭后继续操作，不跳回文档起点 |

## 验证入口

```powershell
npm run typecheck
npm test
npm run build
$env:OBSIDIAN_EXECUTABLE = '<Obsidian executable>'
node dev/ui-polish.mjs
node dev/library-workflows.mjs
node dev/workflows.mjs
node dev/notes-workflows.mjs
```

`dev/obsidian.mjs` 支持通过 `OBSIDIAN_EXECUTABLE` 指定 Windows 程序，Linux 继续支持 `OBSIDIAN_APPIMAGE`。每个测试进程创建独立 `.test-vault/run-<id>/` 和临时配置，保留失败现场，不删除或复用用户库。截图、报告和生成库均被 Git 忽略。

自动检查涵盖实际宿主中的创建、重复点击、纸张选择、保存重开、搜索、键盘、取消、重试，以及窄窗口和模拟 390px 触控视口。模拟触控和合成 IME 事件仅验证相应 UI 分支，不等于 iPad/Pencil、真实中文输入法或同步服务验证。

## 本轮验证记录

2026-11-09，Windows Obsidian 1.12.7（Electron 39.8.3 / Chromium 142.0.7444.265）。新建窗口、桌面笔记库、窄屏笔记库和深色界面均查看实际截图后核对。类型名称与副说明没有被窄屏布局隐藏。

构建 `dist/main.js` 的 SHA-256：`5acea8b2107cb5b44ff47afca9420175c62ceaa2afec722c8d8c7d7bf411e9df`。

- `npm run typecheck`：通过。
- `npm test`：126/126 通过；既有属性测试同步采用新的错误文案，冲突保护断言保持。
- `npm run build`：通过，第三方许可扫描 300 个包，缺失 0。
- `node dev/ui-polish.mjs`：11 组通过，包括确定性延迟跳转、重复点击、原始笔迹重开、键盘与窄屏类型说明。
- `node dev/library-workflows.mjs`：10 组通过，包括正文/PDF/画布搜索、属性并发冲突、日记唯一创建与原始笔迹保持。
- `node dev/workflows.mjs`：5 组通过，包括分页绘写、PDF 摘录、草稿纸复制与撤销、PDF 导出、完整备份恢复和长卷工具。
- `node dev/notes-workflows.mjs`：7 组通过，包括原生 Markdown 保存与撤销、链接改名、手写预览跳转、迟到插入保护和插件禁用后继续编辑。
- `git diff --check`：通过。

报告和截图位于被 Git 忽略的 `artifacts/`，运行时只使用生成的隔离笔记库。仓库中的第三方声明保留原有内容，本机构建的完整许可仍附在分发文件内。

本轮执行者按 Web Interface Guidelines 自查标签、焦点、长文本、主题、异步状态与触控入口；页面 URL/网站导航规则不套用到 Obsidian 宿主视图。动效自查结论：高频工具浮层立即显示，未新增入场动效；焦点恢复与减少动态效果分支均通过宿主检查。
