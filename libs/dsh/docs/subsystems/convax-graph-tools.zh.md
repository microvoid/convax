# Convax 图工具

English | [中文](convax-graph-tools.md)

## 概述

使用 `convax_graph` 发现已保存的图及提供方 schema，再通过 `convax_commit` 提交有序编辑。这两个工具属于 Convax Host，renderer 停用后仍然可用。Session 消息和源文件仍由 DSH 与文件系统持有。

## 目录

- [读取](#read)
- [提交](#commit)
- [历史与恢复](#history)
- [提供方与布局集成](#providers)

<a id="read"></a>
## 读取

省略 `canvasId` 时使用调用 Session 的 Chat 绑定。未绑定的 Session 可以列出画布和检查提供方，读取节点、连线或分组需要显式目标。结果描述已保存状态，与打开的 tab、视口和选中状态无关。

默认响应包含画布摘要，以及目标身份、标题和修订号。`include` 选择 `canvases`、`nodes`、`connections`、`groups`、`nodeTypes` 和 `issues`。未请求的集合不出现，不表示空集合。`projection` 字段声明包含范围与完整性。

`selection.nodeIds`、`selection.typeIds` 与 `selection.groupIds` 取交集。分组筛选选择成员节点，请求的 `groups` 返回结果选区涉及分组的身份与标题。节点的 `groupId` 字段暴露成员归属，所有位置均使用世界坐标。连线的两个端点必须都在该节点集合内。`selection.connectionIds` 进一步筛选连线及端点；`selection.incidentTo` 选择触及指定节点的边、端点及指定节点。`fields.nodes` 与 `fields.connections` 选择记录字段，始终保留 `id`。文件数据包含路径，不包含内容。

```json
{"include":["nodes","connections","nodeTypes"],"selection":{"incidentTo":["note"]},"fields":{"nodes":["typeId","data","revision"]}}
```

<a id="commit"></a>
## 提交

请求包含 `canvasId`（已绑定 Session 可省略）、`expectedRevision`、`operationId`、非空 `ops` 和可选 `confirmed`。一次提交只针对一张画布。创建画布要求显式新身份和修订号零。已有画布使用整图版本比较；`node.set.ifRevision` 增加暂存节点条件，不允许并发写入绕过整图检查。

| 操作 | 必需字段与效果 |
|---|---|
| `canvas.add` | `title`；只能是第一项，目标必须是新画布。 |
| `canvas.set` | `title`；替换标题。 |
| `canvas.remove` | 移除目标图，保留可恢复历史。 |
| `node.add` | `id`、`typeId`、`dataVersion`、`data`、`position`；支持任意已启用提供方。可选 `groupId` 分配到已有组。 |
| `node.set` | `id` 及至少 `data`、`position` 或 `groupId`；替换数据要求 `dataVersion`。可选 `ifRevision`；`groupId: null` 移除归属。 |
| `node.remove` | `id`；同时移除关联边，保留源文件。 |
| `group.add` | `id`、`title`；添加逻辑分组元数据。同批分配成员，空组在提交时移除。 |
| `group.set` | `id`、`title`；重命名分组。 |
| `group.remove` | `id`；解除成员归属，不移除节点或连线。 |
| `group.move` | `id`、`delta: { x, y }`；使用世界坐标平移成员。 |
| `edge.add` | `id`、`source`、`sourcePort`、`target`、`targetPort`、`purpose`（`input` 或 `delivery`）。 |
| `edge.remove` | `id`；移除一条已有连线。 |
| `history` | `targetOperationId`、`direction`（`undo` 或 `redo`）；必须单独提交。 |

操作在独立图副本上顺序执行，后续操作能看到前面的新增记录与修订号。`node.set.data` 完整替换提供方载荷，不做合并。一次 `node.set` 即使同时修改数据、位置和成员归属，也只推进一次节点修订号。提供方解析器、载荷版本、端口与值类型检查仍然生效。

图校验失败不发布任何修改，也不消耗重试身份。成功时原子提交图、一条回执和一条历史，并只推进一次画布修订号。回执包含 `ok`、`canvasId`、`operationId`、`revision` 及可空 `error`；错误包含稳定的 `code`、`message`，单项失败还返回从零开始的 `opIndex`。回执不返回整张图。

重试时复用操作身份及完全相同的参数，包括原预期修订号。持久回执可在重启或源文件移除后避免重复编辑。相同身份对应不同请求会被拒绝。冲突后重新读取，再为修改后的请求分配新身份。画布移除后回执仍保留修订号，供显式历史请求及丢失回执后的重试使用。

<a id="history"></a>
## 历史与恢复

一个批次是一个撤销单位。普通图历史恢复记录字段并保留无关编辑。批次的画布创建和移除另行保留画布生命周期快照。历史转换有自己的重试身份并推进修订号，不能与编辑混在同一批次。旧生命周期命令保留原语义，包括不可逆的 `purge`。

Chat 移除会在外部操作前校验完整批次，再使用已有确认、停止／归档及恢复协调。协调完成前不发布图编辑。Session 写入不能参与图的 SQLite 事务；`operation-pending` 表示保留可恢复意图，不代表外部操作已回滚。应重试相同请求或调用 `retryOperations`。恢复 Chat 保留原 Session 绑定，不重启已停止任务。

Agent 创建的边不会发送提示词、插入输入框引用或创建 thread。输入框引用由 renderer 的显式连线手势负责插入，图历史不重放该手势。

<a id="providers"></a>
## 提供方与布局集成

提供方在 `id`、`dataVersion` 和 `ports` 之外发布 `description` 及 JSON Schema `dataSchema`。`convax_graph` 将旧提供方缺失的元数据返回为 `null`，缺失不代表接受任意载荷。提供方解析器仍是最终校验依据。内置节点及随附示例提供 schema，插件节点无需专用添加工具。

Host 导出纯计算 `layoutGrid(nodes, options)`，宽高由调用方提供。它使用每列最大宽度及每行最大高度，间距表示单元格之间的空白。调用方通过 `node.set` 提交计算位置。工具不声称能测量已渲染卡片尺寸。旧排列适配器通过布局零尺寸点保留原坐标增量语义。

旧五个图工具继续作为兼容适配器。新集成使用这两个工具或仅 Host 提供的 `commit(CanvasCommitRequest)`；已有持久请求不重写。注册及安装见[插件开发](../cookbook/convax-plugin-development.zh.md)。

## 开发说明

真实模型 E2E 使用根目录 `.env` 中的 API key。它在 renderer 停用的正式组合中执行，独立检查 SQLite 图并验证源文件字节不变。记录 Session 场景覆盖通用提交及旧适配器，回放时不需要 key。
