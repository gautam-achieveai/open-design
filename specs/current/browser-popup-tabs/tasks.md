# Browser pop-up tab tasks

Requirements: [requirements.md](requirements.md). Execution ledger: `.claude/scratchpad/conversation_memories/apply-annotation-patch/inspection.md`.

- [x] Record pre-commit backlog B-001 and new progress work.
- [x] Inspect native deny-all handler, renderer allowpopups and current workspace tabs.
- [x] Review the concrete host/tab design and relevant boundaries.
- [x] Implement the smallest real-child popup slice and expose its tab entry point.
- [x] Exercise window.open, new-target links/forms, blank content, opener messages, switching/close and nested child flows.
- [x] Add observed-defect regressions and stable ownership/lifecycle contracts.
- [ ] Run relevant package checks and independent review; fix required findings.
- [ ] Refresh backlog/evidence, archive validated progress and publish the final receipt. Stop only the popup monitor.

No commit, push or release is part of these tasks.

## Ordinary annotation crop correction

- [x] Reproduce the user's shifted heading crop and prove host zoom mismatch with real Electron pixels.
- [ ] Correct the current host capture rectangle conversion and contract comment.
- [ ] Add observed-defect regression; verify default/nonunit zoom and full-page behavior.
- [ ] Inspect corrected native heading preview and image in chat draft; retain existing human draft.
