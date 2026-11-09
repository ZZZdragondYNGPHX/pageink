# 笔记属性

第四阶段提供基于 Obsidian 原生 Modal 的统一属性表单。Markdown 属性保存到 frontmatter；手写笔记本和自由画布保存到可选的 `Manifest.properties`。原始 PDF 只读，不写 PDF 元数据；带 PDF 背景的 `.inknote` 仍可编辑它自己的文档属性。

入口由 `notes-host.tsx` 和 `main.tsx` 接入命令、菜单、工具栏与笔记库；`scripts/build.mjs` 将独立作用域样式拼入分发 CSS。跨笔记属性搜索见 [统一笔记库](unified-library.md)。

## 接口与集成

```ts
import { NoteProperties } from './properties-host';
// 将 properties.css 纳入插件样式构建。

const properties = new NoteProperties(app, io, path => liveSessionForPath(path));
plugin.register(() => properties.dispose());
await properties.open(path);
```

- `constructor(app: App, io: FileIO, session: (path: string) => Session | undefined)`：回调必须返回该路径当前的权威会话；文件重命名后需反映当前路径。
- `open(path: string): Promise<void>`：读取属性、打开 `NotePropertiesModal` 后完成；不等待关闭。读取失败会拒绝，由调用入口显示错误。
- `read(path: string): Promise<PropertiesSnapshot>`：返回 `{ path, kind, properties, documentId? }`；`kind` 为 `markdown`、`drawing` 或 `pdf`。`properties` 是自有键的隔离快照，不来自异步 metadata cache。
- `save(snapshot: PropertiesSnapshot, changes: readonly PropertyChange[]): Promise<void>`：必须传回同一个服务 `read()` 返回的原始快照；成功后完成，失败抛错。程序化连续编辑应重新 `read()`，不要把旧快照当成新的基线。
- `dispose(): void`：可重复调用。关闭本服务打开的模态框，拒绝后续和排队中的操作，并在异步边界检查卸载状态。原生编辑器已开始的保存、已经交给 `processFrontMatter` 或 `DocumentStore.commit()` 的写入无法取消；不破坏这些在途操作的持久化流程。插件卸载时模态框内存草稿随之释放。

类型与纯函数位于 `src/properties.ts`：

```ts
type PropertyValue = string | number | boolean | string[];
type PropertyChange =
  | { key: string; op: 'set'; value: PropertyValue }
  | { key: string; op: 'delete' };

const snapshot = await properties.read('课程.md');
await properties.save(snapshot, [
  { key: '课程', op: 'set', value: '物理' },
  { key: '复习次数', op: 'set', value: 3 },
  { key: '已完成', op: 'set', value: false },
  { key: '标签', op: 'set', value: ['课堂', '待复习'] },
  { key: '旧属性', op: 'delete' },
]);
```

`propertiesSnapshot`、`propertyChanges`、`applyPropertyChanges`、`propertyType`、`parsePropertyNumber`、`validateProperties` 可供独立数据测试。`save()` 接受的快照必须来自服务 `read()`，从而保留文件身份检查；纯函数创建的快照不用于宿主写入。

## 数据与并发边界

`Manifest.properties?: JsonProperties` 不改变 `schema: 1`。旧文档无此字段时仍保持缺省；无改动保存不新增字段或 revision。实际编辑后的空属性对象可以保留为 `{}`。验证接受 JSON 对象、数组、字符串、有限数字、布尔值和 `null`，拒绝非 JSON 值、稀疏数组、访问器和循环结构。

表单可编辑文本、数字、布尔值、字符串列表；空文本、`0`、`false`、空列表、空列表项、列表顺序和项内换行都保留。数字输入使用十进制格式并支持指数形式，空输入或非有限值不会转换为 `0`。已有属性名固定；需要改名时可删除旧项并添加新项，一次保存完成。复杂值、`null`、日期或混合数组只读，不提供删除或类型转换。

`__proto__`、`constructor`、`prototype` 及带控制字符的属性名不可编辑。已有保留名称作为自有数据键只读保留，不解释为路径，也不遍历原型链。属性副本使用无原型字典，写入使用自有数据属性；不对不可信对象执行 `Object.assign` 合并。显示只用文本节点。

每次保存先计算相对打开时基线的实际改动，改回原值的 key 不写入。保存时只比较这些 key 的“是否存在”和类型/值；字符串列表按顺序逐项比较。新增属性若当前已存在、修改或删除的属性若已变化，整批拒绝。即使并发修改恰好与草稿目标值相同，也不会把它当作当前草稿的成功保存。未修改的属性与复杂值采用最新版本。

Markdown 读取及保存前对该文件已打开的原生 `MarkdownView` 调用公开 `save()`。读取通过 `Vault.read`、`getFrontMatterInfo` 和 `parseYaml` 完成；保存仅调用 `FileManager.processFrontMatter`，在原子回调中先检查整批冲突，再修改指定 key。模块不设置原生编辑器内容，也不写回打开时缓存的正文。YAML 的空白、引号、注释和序列化格式由 Obsidian 决定；保证属性语义和最新正文，不保证 frontmatter 字节格式不变。非法或非对象的 frontmatter 拒绝编辑。

活跃绘图会话先 `flush()` 已有内核/正文状态，再检查文件身份、会话身份和外部 manifest 变化，合并当前 `session.manifest.properties`。随后调用 `metadataChanged()` 和 `save()` 立即发布，避免把草稿暂存后再次执行可能失败的编辑器 flusher。若属性写入失败，只撤回仍与本次草稿相同的 key，保留期间出现的其他会话修改；草稿仍在 Modal 内，可重试。会话原有的失败状态、冲突副本和恢复机制继续生效。

未打开的绘图使用最新 `DocumentStore.open()` 的 manifest，提交空的绘图变更集和合并后的元数据；不会重建或重写笔迹数据块。外部修改活跃会话对应的 manifest 时保守拒绝，要求先重新载入该会话，不向正在编辑的会话悄悄替换正文。未打开文档在提交过程中发生 revision 竞争时，沿用 `DocumentStore` 的冲突副本机制。现有 `FileIO` 不提供跨设备 CAS，本层不承诺跨设备事务或消除底层发布检查后的竞争窗口。

完整 `.inkpack`、恢复记录和 `forkDocument` 本来就保存完整 manifest，因此自然保留该可选字段及复杂属性。属性编辑不改变原始自由笔 points、pressures、lastCommittedPoint、页面数据、草稿、引用、图像资源或第三方许可。属性不新增绘图撤销历史；已保存的属性需要通过再次编辑修改。

## 表单与宿主测试定位

| 内容 | 选择器或中文标签 |
| --- | --- |
| 模态框 / 标题 | `.pageink-properties-modal` / `笔记属性` |
| 属性列表 / 属性项 | `.pageink-properties-list` / `fieldset.pageink-property-row` |
| 已有属性定位 | 对应 fieldset 的 `legend` 为原始 key |
| 属性名 / 类型 | `属性名` / `属性类型`；select 的值为 `text`、`number`、`boolean`、`list` |
| 类型选项 | `文本`、`数字`、`布尔值`、`字符串列表` |
| 文本 / 数字 | `文本值` / `数字值` |
| 布尔复选框 | `属性值：是（true）` 或 `属性值：否（false）` |
| 列表 | `第 1 项` 等文本框，`添加列表项`、`删除第 1 项` 等按钮 |
| 属性操作 | `添加属性`、`删除属性`、`撤销删除` |
| 保存 / 关闭 | `保存属性`（进行中为 `正在保存…`）/ `关闭` |
| 错误 | `.pageink-properties-error[role="alert"]` |
| 放弃草稿 | `.pageink-properties-confirm` 内的 `继续编辑` / `放弃草稿并关闭` |
| 只读值 | `.pageink-property-preview` |

输入标签位于对应属性 fieldset 内，宿主测试应先定位属性项再按标签查找。保存过程中禁用表单并设置 `aria-busy="true"`；失败保留所有输入，错误区域获得焦点。关闭按钮、原生关闭控件及 Escape 经过相同关闭检查；重复 Escape 不会自动放弃草稿，必须点击明确的“放弃草稿并关闭”。插件卸载使用服务 `dispose()` 强制清理本服务模态框。

## 验证范围

本模块的本地验证命令：

```sh
npx tsx --test tests/properties.test.ts
npm run typecheck
npm test
```

属性测试覆盖数据验证、原型污染防护、未改 key 保留、整批冲突拒绝、原生保存先行、最新 Markdown 正文保留、保存失败重试、会话属性回滚、文件身份、服务卸载、手写/画板原始笔迹与完整包/恢复往返。Obsidian npm 包只有声明，单测通过 esbuild 注入公开 API 替身；测试 frontmatter 使用合法 YAML 子集 JSON。它不能替代真实 Obsidian 的 YAML 序列化、编辑器保存调度、Modal 焦点/Escape 和主题表现验证。

真实宿主入口、表单与原生并发验证由 `dev/library-workflows.mjs` 覆盖，最终构建与结果见 [统一笔记库验证](unified-library.md)。iPad、Apple Pencil 和真实同步服务仍未验证。本模块没有修改编辑内核和第三方许可。
