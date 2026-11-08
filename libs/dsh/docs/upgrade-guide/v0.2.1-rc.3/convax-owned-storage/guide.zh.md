---
kind: upgrade-guide
description: "Convax 自己管理 SQLite 仓储与 thread 操作，不再通过 DSH 存储路由实现。"
---

# 将 Convax 数据迁至自有仓储

[English](guide.md) | 中文

## 变更

Convax 在 `$DSH_HOME/storages/convax-canvas.sqlite` 中保存图与 thread Session 预留。DSH 存储与 Session Controller 不再提供 Convax 事务或耐久操作扩展。

产品 bundle 提供 `databasePath` 和 `legacyDatabasePath`。迁移读取并保留 `$DSH_HOME/storages/convax.sqlite`，保留画布、绑定、回执、待完成操作和节点升级副本。DSH 保留 Session 历史。前驱写入者仍活动、格式不兼容或 Session 身份冲突时，迁移明确失败。

SQLite schema 10 接受版本 1–9，升级时保留事前备份；旧版 Host 拒绝打开升级后的数据库。回退见[分组指南](../convax-canvas-groups/guide.zh.md)。新画布在 `canvasDirectoryRoot` 下分配本机目录，默认根目录为 `~/Documents/convax`；目录准备先于图发布，旧画布在首次使用时补建。已有目录分配和 Chat 工作目录在升级或根目录配置变化后保持不变。删除画布保留文件。画布归档状态会持久化，并独立于 Session 归档。永久删除画布会清除图的撤销记录，保留 Session 日志和源文件。

## 迁移

1. 更换构建前停止旧 Desktop 和 Host。在应用停止后备份整个应用 home（包括 Session 持久化），或使用一致的数据库备份。迁移状态验证完成前，保留前驱库和升级备份。
2. 使用更新后的 Convax 产品 bundle。在源码检出目录中，通过 [Convax Desktop 启动器](../../../../../../packages/plugin-renderer/README.zh.md) 显式选择 `.convax`；DSH 原生 Desktop 命令保留原有开发目录。手动挂载 Host 时，为 `convax-canvas.sqlite` 设置绝对 `databasePath`，为前驱库设置绝对 `legacyDatabasePath`。两个路径必须指向不同文件。默认 Documents 位置不合适时，将 `canvasDirectoryRoot` 设为本机绝对父路径；组合文件系统也必须允许访问。该配置仅影响尚未分配目录的画布。详见 [Host 配置](../../../../../../packages/plugin-host/README.zh.md)。
3. 移除手写的 `storage-domain` 中 `convax` 和 `session_operations` 路由，以及原来仅供 Convax 使用的 SQLite 提供方行。保留其他功能仍在使用的存储路由和提供方。更新后的产品 patch 不需要 DSH 事务域或已移除的 Session Controller 方法。
4. 启动更新后的应用。迁移在发布前保留固定 Session 身份和分叉位置。重新打开不会再次导入旧图。图撤销与重做仅适用于新 Host 记录的操作；Session 绑定与归档状态保持不变。无法对应的前驱操作身份仍保留在源库中，并产生警告。
5. 检查已有画布标题、节点连线、Chat thread 和历史。通过 Convax 重试未完成操作，确认保留原 thread 身份。失败或损坏的 Session 保持待处理并给出诊断，不另建 Session 替代。
6. 启动报告仍有写入者时，关闭其他 Host，不要通过删除锁文件绕过。数据不兼容或无效时保留两个数据库，修复或恢复一致备份后再重试。回退需要对应的应用与数据快照；旧构建不会将新仓储中的编辑合并回前驱库。
