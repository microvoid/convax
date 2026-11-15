---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-14-background-delivery-key

[English](2026-11-14-background-delivery-key.md) | 中文

## 概述

为 deliverables/presented 增加可选 deliveryKey，让 Host 后台生成任务在原始 Session 中持久化交付去重信息。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-14-background-delivery-key
baseline: false
changes:
  - root: "event:deliverables/presented"
    previous: "2026-09-11-initial"
    after: "2c703434080d69f300d77d0d1ff50d4d48af2fab707eb2647fd799d7db01f82f"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

事件判别字段以及原有 turn、callId、files 字段均保持不变。现有读取方忽略新增可选字段，继续展示相同交付物。新读取方接受没有 key 的历史声明，并保留其原有无 key 行为。不需要提高 Session 格式版本。

<a id="verification"></a>
## 验证

present 与后台发布器的 Vitest 测试共 21 项通过，覆盖原始轮次归属、活跃与冷 Session 持久化、并发重试、载荷冲突、重启恢复、flush 失败重试、文件系统校验、取消与通知失败隔离。Convax 的 Delivery recovery lifetime 测试组共 4 项通过，包括将冷 Session 后台交付投影为原生文件节点和交付连线。tool-present 包的 TypeScript 检查通过。

<a id="dev-note"></a>
## 开发备注

无。
