# Browser pop-ups as tabs

Backlog: B-001. Status: in progress. Include with the current browser work before its next commit.

## User outcome

When testing a website in the native in-app browser, a pop-up opens as another browser tab in the same project. The original tab stays available. Websites keep their real child browsing context.

## Required behavior

- JavaScript window.open and links/forms targeting a new browsing context appear in the existing workspace tab strip.
- Preserve blank-then-navigate/document.write, returned WindowProxy, window.opener/postMessage and form POST semantics. Do not replace them with a fresh GET at the same URL.
- Use the same browser session. The child has the browser's existing isolation, sandbox and allowed-URL policy, without the privileged host preload.
- Support switching, closing, child window.close, nested pop-ups and ordinary browser navigation controls. Keep tab metadata in sync.
- Retain the existing annotation/inspection entry points on child pages, with honest limits where a native view changes overlay behavior.
- Child native surfaces follow the viewport and active tab. They never cover hidden tabs, workspace UI or host dialogs.
- Scope all renderer requests to children owned by the current host/project. Reject unknown/destroyed IDs and disallowed navigation.
- Closing a tab or leaving the project cleans up its owned native surface. Runtime child identifiers are not persisted as restorable browser sessions.
- Keep ordinary opener tabs and necessary ancestors mounted outside the default LRU while live pop-up children depend on them. Release those pins after the last child closes; preserve the existing unrelated browser pin and normal eviction for other tabs.
- An approved browser guest can open a child before its project/tab registration finishes. Stage the owned child invisibly by opener identity, then bind and publish it after trusted registration. Do not lose or duplicate it during subscription/snapshot recovery.

## Boundaries

The desktop host can intercept native pop-ups. A normal browser iframe cannot intercept arbitrary cross-origin window.open; no universal web-only interception claim is required. Existing browser tab listing/control remains reachable through its HTTP/CLI path; this is a native presentation fix, not a new agent command.

## Acceptance evidence

Record runnable scenario evidence, a regression for the deny-all symptom, stable lifecycle/ownership contracts, relevant whole-package checks and independent host-boundary review. Unavailable native UI automation is an explicit coverage limitation; mocks are not proof of real Chromium opener behavior.

## Reported annotation capture regression

- Ordinary browser element captures must use the selected element's complete on-screen rectangle at both default and nonunit host zoom.
- Native capture coordinates derive from the host's actual zoom, not renderer devicePixelRatio. Existing sender validation, masking, changed-target checks and image limits remain.
- Prove the observed upward/small crop regression causally with native pixels and verify a corrected image reaches the chat draft without sending an agent prompt.
- A successful crop does not close distinct missing-image, popup masking or drawing-frame cases without evidence.
