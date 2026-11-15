---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-14-background-delivery-key

English | [中文](2026-11-14-background-delivery-key.zh.md)

## Summary

Adds an optional deliveryKey to deliverables/presented so Host background generation can durably deduplicate publication in the originating Session.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

The event discriminator and existing turn, callId, and files fields are unchanged. Existing readers ignore the optional field and continue displaying the same deliverables. New readers accept older declarations without a key; those declarations retain their original non-keyed behavior. No Session format version increase is needed.

<a id="verification"></a>
## Verification

The present and background publisher Vitest suites pass all 21 tests, covering original turn ownership, live and cold Session persistence, concurrent retries, payload conflicts, restart recovery, failed flush retries, filesystem admission, cancellation, and observer failure containment. The Convax Delivery recovery lifetime group passes all 4 tests, including cold background publication into native file nodes and delivery edges. The tool-present package TypeScript check passes.

<a id="dev-note"></a>
## Dev Note

None.
