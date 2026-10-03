# Browser responsive view tasks

- [x] Inspect existing presets, translations, storage, unused state and native popup bounds.
- [x] Add a discoverable accessible selector and responsive frame sizing without remounting page contents.
- [x] Replace visible preset text with the selected device icon and dropdown arrow; include icons in every option. Reuse accessible CustomSelect keyboard behavior and preset persistence. Focused control and popup-occlusion checks pass; mounted appearance remains open below.
- [x] Extend existing contracts/HTTP/browser command relay/CLI for the same viewport selection behavior.
- [x] Observe responsive native and fallback scenarios; verify retained page state and popup context.
- [x] Protect observed defects and stable sizing/storage/relay contracts with focused tests.
- [ ] Run affected checks, review evidence and report limitations. Include before a later commit; no commit or push is authorized.

### Mounted native acceptance corrections
- [x] Reproduce unequal host/child zoom: selected Mobile width390 must match child CSS innerWidth, while fitting the same DOM frame and preserving real content/state.
- [x] Capture bounded renderer failure category for mounted viewport API502; repair only the proved ACK/presentation failure, then replay the original UI operation.
- [ ] Repeat native blank/link/form popup flows, switching/close and annotation entry points through the real mounted workspace. Isolated drivers alone do not close this gate.
