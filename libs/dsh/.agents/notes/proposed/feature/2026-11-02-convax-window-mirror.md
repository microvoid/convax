# Agent Note: Convax interactive window mirror nodes

Status: proposed

English | [中文](2026-11-02-convax-window-mirror.zh.md)

## Problem

Users need to place an application window on the canvas, operate the original window through its mirror, and connect it to a Chat that can see its current contents. A saved edge must not become continuous model input or override the composer's reference ownership.

This proposal extends the [canvas proposal](2026-10-28-convax-canvas.md) and [plugin development proposal](../architecture/2026-10-30-convax-plugin-development.md). It preserves the [Computer Use provider](../../implemented/architecture/2026-09-12-computer-use-provider-registration.md), [application consent](../../implemented/architecture/2026-09-26-cua-application-consent.md), and [shared native helper](../../implemented/architecture/2026-10-09-cua-shared-native-helper.md) decisions; none is superseded. Direct operation remains proposed; the read-only implementation and its native verification are recorded below.

## Proposal

### Confirmed behavior

| Subject | Agreed behavior |
|---|---|
| Binding | Each node binds to one specifically selected application window, rather than following the application's active window. |
| Operation | Direct clicks, dragging, scrolling, and typing remain the eventual goal, deferred until the user accepts read-only mirroring, Chat integration, recovery, and Computer Use verification. |
| Chat input | At message submission, capture a fresh screenshot for each window reference retained in that draft. The model receives fixed images, not the live preview stream. |

The remaining details are proposed defaults for delivering these requirements. The current delivery stops at a read-only mirror with send-time screenshots and verified Computer Use; the user then tests it before direct operation is discussed or implemented. Mirror preview does not forward pointer or keyboard input in this stage.

### Creation and card interaction

Register `convax.window` through the existing Host and renderer node registrations. Add “Application window” as a secondary creation action beside the existing resource actions. The picker lists running applications and individual windows with names/icons; capture previews only for authorized applications, otherwise generate them after selection through the existing authorization flow. Opening the picker must not capture every unauthorized application. Adding a node does not launch an application or implicitly choose its active window.

Align the card with resource cards: the compact header contains disclosure, application icon, window title, ports, and menu; the expandable body contains the live mirror. Selected-card actions provide fit, rebind, create Chat, and remove. Removing the node leaves the source window open. Keep the external resize handle and existing hover/fade behavior.

```text
                 [Fit] [Rebind] [New Chat] [Remove]
  o  [v] [App icon] Window title              [...]  o
     +---------------------------------------------+
     |                                             |
     |             Interactive mirror              |
     |                                             |
     +---------------------------------------------+
                                [Operating / Exit]
```

Dragging the header moves the node; operating the image controls the source window. The first image click enters operation and delivers that click once. Image gestures and scrolling must not pan the canvas, drag nodes, or create edges. Header controls, ports, and the external resize handle remain canvas controls. Clicking outside or using an explicit Exit control releases routing; do not unconditionally consume the application's Escape key.

Show visible keyboard focus. Verify the selected source window's focus before delivering keys; current application focus alone is insufficient. Support text selection, shortcuts, clipboard, and macOS system Pinyin composition, including its first character. Prove a native or local-composition bridge rather than forwarding composing `keydown` events as text. Loss of focus, lock, rebind, disconnection, or view removal cancels routing and releases held buttons/keys where possible. Never replay an input with unknown delivery outcome.

Map coordinates through canvas pan/zoom, card resizing, image letterboxing, source resizing, Retina scaling, and multiple displays. Ignore padding clicks and reject actions whose window generation or geometry changed. One mirror owns the active manual keyboard route; other mirrors continue viewing, without node/Chat quotas. Native focus changes caused by human or agent operation must not redirect an action to another window.

### Connections and reference ownership

Connecting to an existing Chat inserts a typed window reference into its selected thread draft. Creating a Chat from the window creates the edge and inserts the reference into its first thread. A window provides no filesystem project path: new Chats use the canvas's retained default directory, and existing Chats preserve their projects.

The chip identifies the application/window and indicates that sending captures a new image. It stores the source binding, not a connection-time screenshot. Deleting the chip preserves the edge; cutting the edge does not rewrite retained draft references. Removing or rebinding the source makes earlier references unavailable until explicitly removed or replaced. Rebind must never silently retarget an existing reference.

Only references retained in the submitted draft determine screenshots. Saved edges, reopening canvases, switching threads, and selecting nodes do not insert references. Success follows native draft-consumption behavior; edges do not repopulate consumed references. Multiple Chats can independently reference one window, and one Chat can reference multiple windows. Connecting or operating a window never sends a message automatically.

### Send-time preparation

1. Freeze the thread, draft, ordered references, and binding generations through the native submission lifecycle. Show screenshot preparation within that attempt and prevent duplicate submits.
2. After submission begins, validate the exact native lease and capture a fresh frame from the renderer-owned window stream with `ImageCapture.grabFrame()`. Revalidate before admission; do not reuse an older preview image. Multiple captures have individual timestamps rather than one simultaneous desktop instant.
3. Create immutable image attachments. Associate each image with its source application/window, capture time, and dimensions using existing serializable message/attachment fields. Store image bytes with DSH attachments, not the canvas database.
4. Revalidate binding generations and cancellation before admitting text and all images together through the existing DSH prompt/attachment path. Keep the captured target thread even if navigation changes. Queueing captures before waiting in the queue; queue delivery, provider retries, and historical replay reuse that image set instead of recapturing.
5. Before admission, any capture/preparation failure sends no partial message, preserves the draft, identifies the failed reference in place, and releases unadmitted resources. Admission failures use native recovery; unknown outcomes reconcile rather than auto-resend. A deliberate new submission captures fresh images.

Closed, minimized, locked, inaccessible, or unsupported windows must not silently supply old pixels. Capture succeeds only if the provider verifies a current image from the exact window; otherwise restore/rebind, retry, or remove the reference and send the remaining draft. Unsupported model image input reports a failure before consuming the draft. Removing a node later leaves admitted image history intact and replayable without the live window.

### Existing capabilities and required extensions

The [node registry](../../../../../../packages/plugin-host/src/registry.ts) and [renderer registry](../../../../../../packages/plugin-renderer/src/client/node-renderers.tsx) supply node contributions. Current [resource preparation](../../../../../../packages/plugin-host/src/index.ts) validates file/folder paths, while [draft insertion](../../../../../../packages/plugin-renderer/src/client/draft-references.ts) creates native file references. A live window binding needs an explicit reference protocol.

The [native CUA code](../../../../packages/experimental/cua-macos/native/Sources/CuaNative/) implements single-window screenshots and local pointer operations, not a continuous mirror. Keyboard operations follow application focus; hover can require the original window to be frontmost. The [Computer Use registry](../../../../packages/computer-use/computer-use/src/index.ts) only registers provider identity, without a public capture/input dispatcher. Do not invent `ctx.computerUse.capture`, use private Agent closures, or manufacture an Agent for manual routing.

The [composer](../../../../packages/client/ui-conversation/src/client/input/facade.ts) captures attachment ids for an attempt, and [reference serialization](../../../../packages/client/ui-conversation/src/client/input/prompt.ts) returns text. A serializer that mutates the draft to append an image misses that captured list. Propose a typed asynchronous preparation contribution that resolves captured references into text and image inputs before the existing sink admits the attempt. Define ordering, cancellation, temporary-resource ownership, failure restoration, queue behavior, and command attachment support. Preserve existing reference behavior when no contribution applies; do not wrap the send button or create a second composer.

### Runtime and persistence ownership

The shared `dsh-util-desktop-capture` library defines the typed protocol. The Desktop main process provides exact-window enumeration and one-shot capture leases; the Convax renderer consumes that bridge, owns read-only MediaStreams, and prepares send-time images. The DSH Host persists graph records and admits ordinary image attachments. Effect disposal stops tracks, drains pending frame work, and releases native leases. Direct-input routing remains deferred.

Evaluate reuse of the shared native helper; avoid competing capture helpers or a second Computer Use provider. Any missing shared native/composer API requires a separately scoped, tested extension for its actual consumer. Keep Computer Use's `agentPreset: 'ptc'` default and authorization rules unchanged. Manual mirroring does not switch a Chat's preset; screenshot references do not grant agent control tools. Human routing and agent tools retain separate entry points with the existing OS permission requirements.

Preview frames remain transient, outside canvas storage and Session events. A runtime selection retains its track across card folding and canvas navigation so a draft can capture without silently reacquiring a native window id. Removing/rebinding the node or unloading the renderer stops the track and releases its lease. Read-only views release their video elements independently. Native capture uses the platform cadence instead of a parallel screenshot polling loop.

Persist node identity/version, application identity, display name, selection hints, geometry, and collapsed state through Convax. OS handles, process-instance ids, streams, frame buffers, focus, and pending captures remain runtime-owned. Bare window ids/PIDs can be reused; matching ids or titles cannot authorize automatic attachment to a different window. On restart, show awaiting reconnection unless the provider establishes the same concrete window identity; otherwise require explicit reselection.

Closing a window or exiting its application preserves a disconnected node and edges. Switching the source application's active window does not retarget it. Copying a node/canvas preserves presentation and selection hints, obtains fresh handles, and transfers no active input route; existing independent Chat-copy semantics remain. Follow node payload migration rules and acknowledge actual declared persistence-type changes before altering durable drafts or attachment fields.

Prove native behavior first on the current macOS Desktop. Other platforms/browser clients require verified capture, transport, and input capabilities; otherwise preserve an unavailable placeholder. A browser must not silently substitute its own screen picker for the Desktop Host's window. Permission denial/revocation uses existing guidance and a recoverable card state. Covered-window mirroring is a verification target; minimized, hidden, and cross-Space behavior require separate native evidence. Frozen previews must show their state/time and cannot satisfy fresh capture.

### Delivery sequence

1. Read-only mirror feasibility: prove a specifically selected native window continuously updates, preserves its target under occlusion, and reports minimized/closed states. Verify clean release before adding Chat integration; do not implement input forwarding.
2. Vertical feature: integrate node registration, picker, read-only live card, Chat creation/connection, typed reference, and send-time preparation through the native composer/attachment flow. Verify a real window-to-Chat round trip.
3. Recovery: cover multiple windows/Chats, queueing, failure, permissions, window replacement/reconnect, copy/restart, navigation, and plugin disposal. Update owning package/subsystem docs and persistence acknowledgements for the implementation actually delivered.
4. Computer Use verification: test the existing tool path against the mirrored window while capture is active, including screenshot freshness, a benign action, and visible verification. Keep preset defaults and authorization unchanged; establish coexistence instead of inferring it from separate tests.
5. User acceptance: leave the running feature available for the user to test and stop at that checkpoint. Only after acceptance, discuss direct operation and its focus, coordinate, clipboard, and IME requirements described above.

## Alternatives considered

**Follow application activation.** The agreed target is a specific window; following activation could send a different document when the user changes windows.

**Read-only screenshot card.** This removes focus/input complexity but omits the agreed direct operation capability.

**Connection-time image or cached preview.** It can predate the message. A submit-owned capture gives each admitted message an immutable, attributable image.

**Continuous model streaming.** Preview and model input have separate lifetimes. Send-time images preserve message history without making viewing a window start continuous model requests.

**Permanent edge-driven input.** It conflicts with draft ownership and restores references users removed or consumed. The submitted draft remains authoritative.

## Acceptance criteria

- Two windows of one application stay distinguishable; source selection, focus changes, and reused native ids cannot redirect input or screenshots.
- Real clicks, drags, scrolling, text selection, shortcuts, clipboard, and macOS system Pinyin work through the mirror across zoom, resize, display scaling, and multiple displays. Focus transitions keep the canvas usable.
- Mirror input cannot pan/drag the canvas or type into another Chat. Outside controls work, and exit/disconnect/disposal releases held input.
- A connection inserts a removable reference into exactly the selected thread. Removing it preserves the edge; sends without it take no window screenshot.
- Changing the window after connecting but before sending changes the submitted image. Changing it after submission does not change queued input, retries, or replay. Multiple sources retain attachment order and source associations.
- Capture/image-support/admission failures preserve the draft and identify the source; stale images or partially admitted substitutes are not presented as success. Unknown admission outcomes reconcile without duplicate prompts.
- Window replacement/closure, lock, minimized/covered states, permissions, restart, copy, and provider/renderer disposal preserve graph data while rejecting unsafe capture/input.
- Each stage has focused tests and browser E2E; native Desktop E2E verifies actual pixels, input, and IME rather than accepting simulated browser video as platform evidence. A keyless recorded-session case checks immutable image history. Real-model tests follow the root `.env` API-key convention without recording credentials.

## Risks

Controlling an exact native window while retaining a useful canvas is the main feasibility risk. A successful screenshot does not establish correct keyboard focus, hover, or IME. If a platform requires foreground activation, validate and document that UX before treating it as equivalent to embedded operation.

Continuous capture adds latency/resource cost and must coexist with the shared helper's serialization and capture-failure recovery. Browser tests and recorded Session replay cannot establish native permissions, current source pixels, obscured-window behavior, or input targeting; those require native evidence before release.
