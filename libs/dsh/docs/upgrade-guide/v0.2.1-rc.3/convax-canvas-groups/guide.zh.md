---
kind: upgrade-guide
description: "Convax 分组元数据及成员归属要求 SQLite schema 9，旧 Host 无法打开。"
---

# 升级 Convax 分组存储

[English](guide.md) | 中文

## 变更

Convax 将自有仓储从 schema 8 升至 9，保存分组身份、标题、节点归属及其可逆历史。已有节点继续使用世界坐标。缺少 `groups` 和 `groupId` 的数据仍是有效的未分组数据，无需节点提供方迁移。

变更影响配置的 `databasePath`，通常为 `$DSH_HOME/storages/convax-canvas.sqlite`。Host 也通过已有升级路径接受 schema 1–7。修改文件数据库前，先在 `<databasePath>.upgrades/upgrade-*/database.sqlite` 写入一致的恢复副本。schema 升级原子提交。旧 Host 拒绝 schema 9；修改存储版本号不能使旧版本正确读取新的图和历史。

## 迁移

1. 升级前停止其他 Convax Desktop 和 Host 进程。保留应用主目录及 DSH Session 历史的一致备份。更新产品 bundle 后继续使用同一 `databasePath`，首次启动会自动升级自有仓储。
2. 检查已有画布标题、卡片位置、连线和 Chat thread。将两张卡片分组、移动分组、撤销移动后重新打开画布，确认组名和归属仍保留，原文件与对话完整。验证完成前保留升级前备份。
3. 降级时停止全部 Convax 进程，恢复升级前完整的应用及数据快照，包括匹配的数据库备份。如需恢复新版本中的编辑，另行保留新数据库。不要合并 SQLite 文件或降低 schema 数字。备份后的编辑不在恢复快照中，旧版本无法重放新的分组历史。前驱导入与未完成 Session 操作见[仓储恢复](../convax-owned-storage/guide.zh.md)。
