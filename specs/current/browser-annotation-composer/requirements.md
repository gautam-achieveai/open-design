# Compact browser annotation composer

Gautam requested a browser annotation UI like the supplied ChatGPT references. Include this in the current uncommitted browser work.

- Default to a compact rounded comment bar anchored inside the preview bounds. Keep comment input, sliders/style control, attachment access, close and add-to-chat action reachable.
- Sliders expand a scrollable style panel under the same comment bar. Keep the input and actions visible. Expose the selected element label and live text, text/background colors, font, font size/weight, line height/alignment, radius and padding using the existing browser edit path.
- Remaining reference fields (opacity, border color/width, width/height and margin sides) use the same typed style metadata and live edit path; do not invent a parallel editor or transport.
- UI and CLI live edits use one typed style operation through the existing browser command endpoint. Require existing project/tab/lease scope and mutation approval. Allow only the supported style keys and bounded string values; no arbitrary script or CSS property. CLI accepts a styles file and supports JSON output. Annotation context-file draft/post remains unchanged.
- Preserve the comment draft when opening/closing styles. Enter adds the draft through the current action, Shift+Enter inserts a newline, composing IME does not submit, and Escape closes the current style panel before the annotation.
- Captured images remain visible on demand and removable/previewable. Keep image privacy disclosure, capture guards, masking, size bounds and current post semantics. Never silently attach a stale crop after layout edits.
- Apply the compact presentation only to browser annotations; shared canvas/pod/saved-comment consumers retain their current presentation and permission gates.
- Reuse existing viewport presets and translated options. Browser toolbar shows selected device SVG plus dropdown arrow; every option has an icon. Existing CustomSelect preserves keyboard selection and visible focus.
- This reuses existing live browser capabilities and current UI/API/CLI; no new account, permission, dictation backend or inert microphone button.

## Evidence

Walk the smallest browser annotation scenario when UI access works. Protect stable input/style/disclosure/permission contracts in existing component tests. Keep unavailable real UI, earlier missing image and broader daemon failures explicit. No commit, push or publication of code is authorized.

## Annotation draft image card

- One pending browser annotation shows one image card. Its note and context stay behind that card; clicking opens the captured image, note and safe text representation of its context.
- Group by the exact pending annotation ID and image ID. Preserve ordinary uploads and unrelated saved/visual comment attachments.
- New annotation notes remain outside the editor but enter the existing outgoing prompt on send/queue. Preserve all human text and older draft text. Restored queued text already contains notes; never append them twice.
- Persist only bounded hidden-note IDs beside draft extras. Until their pending metadata loads, block sends and show a loading status; never silently omit a note.
- Whole-card removal discards the pending annotation and its image together. Image-only omission remains inside details. Failed removal keeps the card and shows the existing error.
- Missing images retain a visible fallback and details access. Notes, context IDs and image selection keep their existing submission contracts.
