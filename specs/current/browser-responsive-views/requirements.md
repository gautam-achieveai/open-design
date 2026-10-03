# Browser responsive views

Gautam requested mobile, tablet and desktop views in the existing in-app browser. Include this with the current uncommitted browser work.

## Behavior

- Show one device icon with a dropdown arrow in the browser toolbar. The icon reflects desktop, tablet or mobile; every dropdown option includes its corresponding icon. Keep an accessible selector with translated labels; reuse existing presets and per-project storage.
- Desktop fills the available browser surface. Tablet requests 820 × 1180; mobile requests 390 × 844. Constrain preview dimensions to the available workspace; make the actual dimensions clear. This is responsive page sizing, not a claim of full device, touch, user-agent or hardware emulation.
- Resize the actual page viewport, not only the surrounding decoration. Existing ordinary Electron webviews, iframe fallback and owned native popup tabs use the selected frame bounds.
- Switching presets retains the page, URL, session, form state and native opener context. Return to desktop restores the full surface. Saved valid choice restores on re-entry; invalid values fall back to desktop.
- Keep navigation, screenshots, element picking and annotation coordinates aligned with the resized surface. Keep the browser toolbar outside the page frame.
- Keep viewport selection available on narrow workspaces. Do not silently introduce horizontal overflow or put a native view over neighboring UI.

## API and CLI

Extend the existing browser command path rather than create a parallel service. Provide an `od browser viewport <desktop|tablet|mobile> --project <id> [--tab <id>] --json` surface against the same browser command endpoint used by the native UI. The renderer's existing lease/session can apply the presentation choice; it need not add arbitrary CDP evaluation or a privileged device emulation capability. A free-text prompt-file flag is not applicable to these enumerated presets. Document the existing live native-target requirement for CLI and iframe fallback limitation.

The callback stays stable across preset changes and reads live frame/popup references. Commit the preset and measure after layout. For a native popup, await scoped presentation acknowledgement at the new bounds before reporting success; retain current occlusion and refresh captured pixels when geometry changes. Propagate host failure or disposal. Hidden parked/zero-sized targets fail with an actionable instruction to activate the tab, rather than reporting invented dimensions. Existing lease and expiry checks remain in force.

## Proof

Scenario-first: open a responsive local fixture; change each preset; observe page viewport/media-query layout and unchanged DOM state/URL. Exercise ordinary and popup native contents, narrow workspace behavior, desktop restoration, stored choice and HTTP/CLI command relay. Protect only the material sizing/persistence/relay contracts after real observation. Run affected package checks and independent review; retain every failed or unavailable check by name.
