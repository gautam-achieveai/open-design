# OpenDesign Web Clipper (MV3 — Chrome · Edge · Firefox)

The **OpenDesign Web Clipper**: a browser extension that captures images,
screenshots, and page content from any site straight into your OpenDesign
**Library** (the global asset registry).

This is a **standalone subproject** — it is intentionally *not* part of the pnpm
workspace and has **no build step**. The files here load directly as an unpacked
extension. The daemon/web TypeScript boundaries are unaffected.

## Load it

1. Start OpenDesign locally (`pnpm tools-dev`). For project annotations, use
   **Connect managed Edge → Copy connection URL**; paste it into Clipper’s
   connection field. It configures the daemon address automatically.
2. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**,
   and select this `clipper/` directory.
   - **Edge:** same steps at `edge://extensions`.
   - **Firefox:** prepare an isolated Firefox package with
     `pnpm exec tsx clipper/prepare-firefox.ts .tmp/clipper-firefox` from the
     repository root. In `about:debugging` → *This Firefox* → *Load Temporary
     Add-on*, select `.tmp/clipper-firefox/manifest.json`. Firefox uses
     `background.scripts`, while Edge/Chrome use `background.service_worker`.

That's it for **Library capture** — no pairing, codes, or tokens. The popup
shows **● Connected** as soon as it detects OpenDesign running, and you can
capture right away. Project annotations use a separate, explicit pairing below.

> The unpacked `clipper/` manifest is for Chrome/Edge and has no Firefox-only
> `background.scripts` field. `prepare-firefox.ts` copies the extension into a
> separate ignored directory and replaces only the manifest with
> `manifest.firefox.json`; do not replace the original manifest in place.
> Store/ASO assets and per-store copy live in [`store/`](store/LISTING.md).

### Why no login for Library capture?

The daemon only listens on loopback (`127.0.0.1`), so only programs on your own
machine can reach it, and a web page can't impersonate this extension's
`chrome-extension://` origin. The daemon auto-trusts the extension for its
narrow Library ingest/probe routes. **Project annotations are different:** they
require a one-use project pairing code and a short-lived capability scoped to
one browser tab and document. Library trust grants no project-write access.

## Annotate inside Open Design first

In the desktop app, open a project's **Browser** tab, visit a page, click
**Annotate**, select an element, write a note, and click **Add to chat draft**
(or press Enter). Only your note enters the composer body; the page and element
context appear as a chat-owned `annotation-context.json` attachment beside an
optional cropped screenshot. Form fields can be selected; their values and
attributes are omitted from context. Supported native text fields hide text paint
during capture while retaining original design pixels; unsupported controls are
masked before the screenshot is staged. Collect more annotations, then press the normal
chat **Send** once. No extension or pairing is needed. Screenshot failure does
not block a note-only draft. Evidence is not an editable project file.

This browser is Open Design's hosted Chromium session, not your installed
Edge/Chrome profile. Use the extension below when a website needs that profile.

CLI clients can stage the same note and evidence in the conversation draft,
then start a Run through the ordinary `od run` command:

```bash
od browser edge draft --project <id> --conversation <id> --url <url> --prompt-file <path|-> --json
od browser edge pending --project <id> --conversation <id> --json
od browser edge context --project <id> --conversation <id> --message <id> --annotation <id> --json
```

`pending` lists draft IDs; `context` reads a JSON attachment claimed by the
specified sent message. Optional `--screenshot <png>` attaches a cropped PNG;
`--context-file <json>` adds element context (`selector`, `label`, `text`,
`htmlHint`, `position`, and optional `domOutline`, `ancestors`, `style`). Reuse
`--event-id <id>` when retrying an identical draft to avoid duplicates. The
legacy `od browser edge post` remains available but posts a chat message
immediately; it does **not** stage the composer or start an agent.

## Annotate a managed Edge/Chrome site

The on-page annotation control matches the in-app browser: a light comment bar
next to the selected element, with a switches button for scrollable style fields
and an optional screenshot preview. Press Enter to add feedback to the chat
draft; Shift+Enter adds a line, and Escape closes the control. Style and simple
text edits preview locally. Closing restores the preview; adding it to the draft
captures fresh evidence and includes the requested changes for the agent.
This does not save changes to the website's source files. Entered form values
remain excluded from evidence and from the text editor.

For sites that require your company's Entra/Intune browser session, sign in in your
normal Edge or Chrome work profile using Windows Hello. The in-app Electron
Browser tab does **not** share that profile or its credentials.

1. In the destination Open Design conversation, open **Connect managed Edge** and
   click **Copy connection URL**. No extension ID is required.
2. In your website tab, open Clipper, paste the URL into **Open Design connection
   URL**, and click **Connect**. The URL includes the daemon address and one-use
   code; there is no separate Advanced setup. The popup names the destination
   project and conversation.
3. Choose **Annotate an element**, select an element, review the screenshot
   when available, add your note, then click **Send to chat**. This stages your
   note and a structured JSON attachment in the destination composer; it does
   not post yet. A failed screenshot does not block the note. **View chat** opens
   the exact destination conversation. Text, email, and password fields can be
   selected for design feedback; values and attributes are excluded from JSON.
   Reviewed annotation screenshots temporarily hide text paint in supported
   native text inputs and textareas without reading or changing entered values.
   Original borders, backgrounds and layout remain visible. The preview labels
   this modification. Unsupported controls (including selects and contenteditable)
   retain opaque masks; opaque embedded surfaces can omit screenshots. Editable
   controls and iframe/custom-element boundaries remain selectable for notes,
   without reading entered copy or opaque internals. For permitted HTTP(S) child
   frames, select the iframe then choose **Pick inside frame**. Open-shadow internals
   can be picked directly. These selections stage note plus scoped JSON only;
   screenshots are explicitly unsupported. JSON identifies the child URL or shadow
   host path so its selector is not mistaken for a top-document selector. Child
   navigation invalidates the review. Closed-shadow internals, restricted pages,
   and opaque/sandboxed frame documents are not supported. New JSON evidence records
   whether a screenshot was captured or not provided. Identity-provider pages remain
   unavailable. **Pick element**
   remains Library capture, not chat.
4. Collect more notes and crops in the same conversation draft. Remove unwanted
   crops there, then press the normal chat **Send** once. Collection alone does
   not post a transcript message or start an agent.

The connection lasts up to eight hours and survives extension-worker sleep and
same-origin page reload/navigation. Screenshots are discarded on navigation.
Changing sites, restarting the daemon, or ending the browser session may require
reconnecting. Read-only live inspection of a newly loaded document requires a
fresh pairing, even when its origin is unchanged. Use Disconnect in Open Design
to revoke the connection. Tokens stay in extension-only session storage, never
in website content or local storage. The full connection URL is not saved.
The optional screenshot is chat evidence, not an editable project file.

Collected annotations are durable pending draft evidence and survive daemon
restarts. Only the normal chat Send binds selected notes and crops to a message.
Optional styles and ancestor metadata are filtered and bounded rather than
rejecting the note. Ordinary long copy is truncated; credential-shaped text is
omitted. A submission validation/server error preserves the connection and
reviewed crop so the same annotation can be retried.

Under **Advanced**, enable **Record annotation diagnostics**, reproduce the
problem, then **Copy sanitized report**. Recording is off by default, bounded
to 100 operational events, and kept only in extension session storage. The
report contains event names, timestamps, correlation IDs, success/HTTP status,
daemon annotation-protocol build and correlation acknowledgment, opaque destination
and draft IDs, worker build, extension version, and a count of paired tabs. It contains no page
URLs, DOM, notes, screenshots, connection codes, tokens, or network payloads.
Disabling recording clears its events. Copying does not send the report anywhere.
The worker build displayed there helps identify a stale extension after source
changes; reload the unpacked extension to load new scripts.

## Capture

- **Popup** → *Capture page → Library* (a self-contained, high-fidelity HTML
  snapshot — readable stylesheets inlined, images inlined as data URIs, scripts
  stripped), *Extract design system* (a programmatic design-system HTML capture saved
  as a `design-system` Library asset), *Download Figma (.json)* (a structured
  Figma import JSON for the OD Figma plugin — see `../figma-plugin/`), *Pick
  element → capture*, *Pick images*, or *Capture screenshot* (visible tab).
- **Pick element** → a DevTools-style picker: hover to highlight any element,
  click to save it as a **single self-contained HTML snapshot of that element**.
  The page's stylesheets are kept (so the element's cascade resolves and it stays
  styled), the element's own images are inlined as data URIs, and the rest of the
  page is pruned away — leaving the element where it sat, ready to open. Esc
  cancels. The saved Library card is **one HTML file** you can open, share, or
  distribute as the element; its preview shows the live element with its
  selector + size (tag, selector, dimensions) noted beneath. No separate
  screenshot-plus-markup pair — just the HTML.
- **Pick images** → an on-page overlay grid of every image on the page with
  checkboxes, *Select all* / *Clear*, and *Save N to Library* — so you choose
  exactly which images to save instead of grabbing them all.
- **On-page toolbar** → an optional floating page / design-system / Figma JSON /
  screenshot / image / element launcher
  anchored **top-center** of the page (Figma-style), with a gap from the edge so
  it reads as a deliberate surface. It's **hidden by default**; turn it on with
  *Show on-page bar* in the popup (the preference is remembered, and the bar's
  ✕ hides it again). Each control shows a **hover tooltip** naming what it does.
  Grab the dotted **handle** on its left edge to drag the bar anywhere on the
  page — its position is remembered across reloads. The launcher is automatically
  pulled out of frame while a capture is taken, so it never ends up inside the
  snapshot.
- **Right-click an image** → *Save image to OpenDesign Library*.

### Page → design system

*Extract design system* is intentionally separate from full-page capture. It reads
the live page with JavaScript and fills a stable design-system HTML template with:

- logo/app-icon candidates and representative images;
- computed typography, font-family usage, and readable `@font-face` rules;
- weighted palette tokens and light/dark theme variables;
- title, product description, headings, and keywords;
- a small component kit (buttons, fields, cards, navigation samples) rendered
  from the extracted tokens.

The result is saved to the Library as `kind: "design-system"` with `text/html`
bytes, so it previews like an HTML asset but filters as a design-system asset in the
Library and *Select from library* picker.

### Page → Figma JSON

*Capture page → Library* also computes an **OD Figma capture** (a JSON node-tree
of frames / text / images with live geometry, fills, strokes, corner radii and
shadows) from the live page and stores it alongside the HTML asset. From the
Library you can later **Download Figma JSON** for that asset, or use *Download Figma
(.json)* in the clipper to grab it directly without saving to the Library.

> ### ⚠️ The `.od-figma.json` is opened by a Figma plugin, not by dragging it in
>
> Figma only imports its own binary `.fig`/`.jam` files, so dragging an
> `.od-figma.json` into Figma (or **Drafts**) shows **“Unsupported file format”** —
> that is expected. Open it in **two steps** instead:
>
> 1. **Install the OD Figma Import plugin once** — in the Figma *desktop* app:
>    **Plugins → Development → Import plugin from manifest…** → pick
>    `figma-plugin/manifest.json`. (Same model as web-to-figma / html.to.design,
>    which are also plugins.)
> 2. **Run the plugin and open the file** — **Plugins → Development → OD Figma
>    Import**, then drop in the downloaded `.od-figma.json`.
>
> Full instructions: [`../figma-plugin/README.md`](../figma-plugin/README.md).

> A native binary `.fig` can't be produced outside Figma, so this is an import
> JSON node-tree rebuilt as editable layers by the OD Figma plugin.
> Fidelity is best-effort: cross-origin stylesheets that block reads, web-component
> shadow DOM, and tainted canvases may degrade. Image fills in any web format
> (SVG, WebP, GIF, …) are supported — the plugin re-encodes the ones Figma's image
> API can't read (everything but PNG/JPEG) to PNG on import.

Everything you capture appears in the Library tab (live, via SSE) with a
**Clipper** source badge and a back-link to its source page.

The **Capture options** (under *Advanced*) include *Inline images* — on by
default for the highest fidelity; turn it off for smaller, faster captures that
reference images by URL instead of embedding them.

Very large, image-heavy pages are captured at reduced fidelity rather than
failing — the capture is built to always fit the daemon's ingest limit:

1. Large raster images are re-encoded smaller (downscaled + WebP) before being
   embedded, so most pages embed everything at a fraction of the size.
2. If the page is still over budget, images are embedded smallest-first and the
   largest are left as live URLs (the HTML structure and styles are kept intact).
3. As a last resort the secondary Figma layout capture is dropped so the HTML
   page itself always saves.

The popup/on-page toast notes when any of these kicked in (e.g. "some images
left as links").

## Permissions

- `host_permissions: <all_urls>` — needed to screenshot/read images on any page,
  fetch+inline cross-origin page resources, and reach the loopback daemon.
  Standard for web clippers (Evernote, Figma).
- `scripting`, `tabs` — capture the active tab, harvest images, and run the
  page-capture runtime (`capture.js`) on demand.
- `contextMenus` — the right-click "Save image" entry.
- `downloads` — save the *Download Figma (.json)* import file to disk.
- `storage` — remember the daemon URL locally (only needed if you changed it).
