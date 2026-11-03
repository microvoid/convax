---
description: "Typed window selection and capture reservations shared by the Desktop shell and client features."
kind: "package-library"
---

# @deepseek-ai/dsh-util-desktop-capture

English | [中文](README.zh.md)

## Summary

Client features can select one Desktop window, reserve its next video-only stream grant, and check that the source remains available. These declarations keep Electron objects out of the client bridge. The library captures nothing and owns no application state; Desktop supplies the implementation.

## Table of Contents

- [Use this package](#use-this-package)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Use the [typed bridge](src/index.ts) from the primary macOS Desktop application document after checking that optional `dshDesktop.windowCapture` exists. Unverified Windows/Linux providers do not expose it. `list()` returns names, ids, and available application icons as PNG data URLs, without window thumbnails. Serialize `prepare(sourceId)` and the following renderer-owned `getDisplayMedia({ audio: false, video: true })`. One unused reservation is allowed per document, and the main process grants that exact window once. Keep the lease until the client stops its tracks and calls `release(lease.id)`; release after acquisition failure as well.

`validate(lease.id)` freshly enumerates native windows. A missing source permanently invalidates its lease. Validate before and after preparing an image: a live track does not establish that a closed or minimized window supplies current pixels. Persist selection hints rather than source/lease ids, which are process-local identities. [Desktop](../../../apps/desktop/README.md) owns permissions and native grants; the renderer owns streams and pixels. Navigation and provider disposal revoke reservations. Manual capture does not authorize agent Computer Use tools or switch their preset.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- This video-only protocol does not record audio, forward pointer/keyboard input, or give native ids durable identity. Platform availability needs native verification; a client must report failure rather than substitute another source or an old frame.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers</summary>

None.

</details>
