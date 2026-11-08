# Agent Note: 使用世界坐标的 Convax 逻辑分组

Status: implemented

[English](2026-11-08-convax-canvas-groups.md) | 中文

## 问题

画布用户需要为相关卡片命名、整体移动和复制，同时保留各张卡片自己的交互及执行归属。Chat 和资源尺寸属于窗口偏好，因此持久化的分组矩形无法准确描述同一分组在各窗口中的范围。

## 决策

Convax Host 在 `CanvasDocument.groups` 中保存分组身份和标题。可选的 `CanvasNode.groupId` 是成员归属的唯一来源，每个节点至多属于一个组。节点位置始终使用世界坐标。分组不具有提供方数据、端口、Session 绑定或执行生命周期。

renderer 根据当前测得的成员边界派生各个分组框，包括拖动中的临时位置。画布拥有的分组控制器提交语义化 Host 命令。移动分组时将成员展开为唯一节点集合，混合选区不会重复移动成员。创建分组、取消分组和重新分配节点均保留世界位置。拖过分组框不会隐式改变归属。

成员归属、标题和位置共用一次修订、耐久回执及字段级历史。取消分组保留内容；删除组及其成员复用已有 Chat 确认、停止和归档协调。完整分组的副本分配新分组身份并保留标题，部分副本解除归属。复制画布同样重映射分组，不复制 Session 历史。

[Host 声明](../../../../../../packages/plugin-host/src/types.ts)、[仓储](../../../../../../packages/plugin-host/src/repository.ts)和[分组控制器](../../../../../../packages/plugin-renderer/src/client/canvas-grouping.ts)拥有这些契约。[完整画布提案](../../proposed/feature/2026-10-28-convax-canvas.zh.md)继续保留独立的产品与集成决策；本记录仅拥有分组决策。

## 考虑过的替代方案

**节点使用父级相对坐标。** 结构性父节点要求 Host 命令、工具、复制与历史均处理坐标转换，同时无法根据窗口拥有的 Chat 和预览尺寸确定耐久容器尺寸。保留世界坐标可维持已有提供方及布局语义。

**持久化分组框或只在 renderer 中保存归属。** 其他窗口使用不同卡片尺寸时，保存的分组框会失准。局部归属则使 Host、agent（智能体）和历史无法观察同一组关系。耐久逻辑归属加派生分组框，让每份事实留在各自所有者中。

**自动嵌套、拖入归组和整组缩放。** 这些行为超出显式分组，增加成员归属及尺寸规则。缩放 Chat、Browser 和 Terminal 卡片还会改变内容布局。当前实现保留单层归属及卡片独立尺寸。

## 影响

分组组织在重启或停用 renderer 后保留，各窗口显示匹配自身卡片尺寸的分组框。已有节点提供方保留原有位置和生命周期。分组框不是持久化的固定尺寸容器，不提供嵌套、折叠、自动拖入归组或整组尺寸调整。

仓储使用 schema 九，升级前备份旧数据库。旧 Host 拒绝升级后的存储，[升级指南](../../../../docs/upgrade-guide/v0.2.1-rc.3/convax-canvas-groups/guide.zh.md)拥有恢复步骤。

## 验证

[仓储测试](../../../../../../packages/plugin-host/tests/repository.spec.ts)验证原子成员归属及历史，[数据库测试](../../../../../../packages/plugin-host/tests/database.spec.ts)验证前驱图和升级备份的保留。[分组测试](../../../../../../packages/plugin-renderer/tests/canvas-grouping.client.spec.ts)覆盖测量分组框及去重移动，[剪贴板测试](../../../../../../packages/plugin-renderer/tests/canvas-clipboard.client.spec.ts)覆盖完整与部分分组复制。[浏览器场景](../../../../apps/web/tests/convax-canvas-interactions.e2e.ts)验证组合后的画布交互。
