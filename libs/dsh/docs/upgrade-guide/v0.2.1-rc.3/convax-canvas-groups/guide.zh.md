---
kind: upgrade-guide
description: "Convax 分组和色板颜色要求 SQLite schema 10，旧 Host 无法打开。"
---

# 升级 Convax 分组存储

[English](guide.md) | 中文

## 变更

Convax 将自有仓储升级到 schema 10，保存分组身份、标题、色板颜色、节点归属及其可逆历史。schema 九的分组保留已有元数据和成员归属，缺少 `color` 时使用默认灰色。已有节点继续使用世界坐标。缺少 `groups` 和 `groupId` 的数据仍是有效的未分组数据，无需节点提供方迁移。

变更影响配置的 `databasePath`，通常为 `$DSH_HOME/storages/convax-canvas.sqlite`。Host 通过已有升级路径接受 schema 1–9。修改文件数据库前，先在 `<databasePath>.upgrades/upgrade-*/database.sqlite` 写入一致的恢复副本。schema 升级原子提交。旧 Host 拒绝 schema 10；修改存储版本号不能使旧版本正确读取新的图和历史。

画布剪贴板写入带分组颜色的版本 3。更新后的客户端仍读取版本 1 和 2，版本 2 的分组使用默认灰色。旧客户端无法读取新复制的版本 3 选区。

## 迁移

1. 升级前停止其他 Convax Desktop 和 Host 进程。保留应用主目录及 DSH Session 历史的一致备份。更新产品 bundle 后继续使用同一 `databasePath`，首次启动会自动升级自有仓储。
2. 检查已有画布标题、卡片位置、连线和 Chat thread。将两张卡片分组、修改组色、移动分组、撤销移动后重新打开画布，确认组名、颜色和归属仍保留，原文件与对话完整。验证完成前保留升级前备份。
3. 降级时停止全部 Convax 进程，恢复升级前完整的应用及数据快照，包括匹配的数据库备份。如需恢复新版本中的编辑，另行保留新数据库。不要合并 SQLite 文件或降低 schema 数字。备份后的编辑不在恢复快照中，旧版本无法重放新的分组或颜色历史。前驱导入与未完成 Session 操作见[仓储恢复](../convax-owned-storage/guide.zh.md)。
