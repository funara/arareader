# ARAReader

<p align="center">
  <img src="public/ARAReader_light.png" alt="ARAReader" width="420" />
</p>

<p align="center">
  <strong>The ARAOffice PDF reader and editor — privacy-first, with a built-in AI copilot</strong><br />
  <sub>Offline-first · Zero Telemetry · No Accounts · Local PDF Processing</sub>
</p>

---

## What ARAReader is

ARAReader is the PDF reader and editor of the ARAOffice family; ARAOffice is the
parent application. It reads and edits PDF files, with an optional AI assistant
that works on the document you have open. It is an Electron app (Electron 43,
React 19, electron-vite 5) built on PDF.js for rendering and `pdf-lib` for
writing, hosted in a single window with tabs.

This repository is ARAReader's standalone build: the PDF module (`apps/pdf`) and
nine supporting packages were extracted from the parent
[ARAOffice](https://github.com/funara/araoffice) tree, the `@araoffice/*` scope
was renamed to `@arareader/*`, and a small desktop host (`apps/desktop`) replaced
ARAOffice's shell with a PDF-only home screen, tab strip, menus, AI bridge, and
updater. The extracted ARAOffice copy is frozen at that point — future PDF work
happens here, and security fixes travel back to ARAOffice by hand — so this
repository builds, tests, packages, and updates on its own, with no path back
into `araoffice`.

- **Windows, macOS, Linux** — electron-builder targets for each platform.
- **GPL-3.0-or-later** for the whole repository.

## Brand and identity

ARAReader is part of **ARAOffice**, the parent application. The approved product
and author identities are **ARA**, **ARA AI**, **ARAOffice**, **ARAReader**, and
**Adhi Rahmadian**. The official GitHub organization is
[`funara`](https://github.com/funara); release feeds, package links, and the
updater point there.

---

## Features

### Reading

- PDF.js rendering with a selectable text layer, thumbnails, outline/bookmarks, and link handling.
- Search with match navigation; zoom, fit width, fit page; continuous scrolling or a page-by-page view with a one- or two-page spread; keyboard page navigation.
- **Command Center:** Find commands or search document text in one place with `Ctrl+K` (`Cmd+K` on macOS). Its launcher cycles through search hints.
- **Read mode:** Hide the ribbon, footer, and panels for focused reading. Select **Read** on Home or View, then use **Exit Read mode** or `Esc` to restore the previous mode and panel layout; unfinished text edits are preserved. Read mode is an interface setting, not a permanent PDF lock.
- Sidebar with thumbnails, outline, and comments; resizable and remembered widths. The Pages and ARA Assistant panels can be collapsed independently.
- Print preview and printing.
- Password-protected PDFs open **read-only**: write tools refuse rather than corrupt the file.
- Autosave every 30 seconds and on window blur while the document is dirty.

### Editing and document operations

- **Markup:** highlight, underline, strikeout, squiggly.
- **Drawing:** ink, rectangle, ellipse, line, arrow, polyline, polygon, caret, typewriter text, note.
- **Comments:** panel with file-side annotation matching and delete. Existing annotations are passive outside **Edit** mode, avoiding accidental selection, movement, resizing, copying, or removal.
- **Forms:** text, checkbox, radio, and choice fields; values are written on save.
- **Signatures and stamps:** Place drawn signatures as ink annotations or image and QR signatures as Stamp annotations. QR Signature includes the signer's name, local date and time with time-zone offset, intent, and recipient; optionally combine it with the default saved signature and adjust the preview before placing it. These are visible signatures, not cryptographic signatures: QR contents do not verify identity or protect against tampering.
- **Image stamp actions:** Copy the selected stamp to the clipboard or remove it in Edit mode; removal can be undone.
- **Metadata:** title, author, subject, keywords.
- **Pages:** rotate, delete, reorder; extract a page range to a new PDF; insert another PDF after a page.
- **Split:** into one file per range, every N pages, or per top-level bookmark.
- **Combine:** merge several PDFs with optional per-file bookmarks.
- **Export:** page images (PNG), document text, and embedded images.
- **Outline editing:** add, rename, delete, reorder bookmarks, then apply to the file.
- **Sanitize:** metadata, document JavaScript, attachments, comments/markup, page thumbnails, private data — with a per-category census before and a report after.
- **Accessibility:** report (title, language, tagging, alt text, bookmarks, headings, tables, forms) and a metadata fix.
- **Save / Save As**, with a dirty-close guard (Save / Don't Save / Cancel) per tab and on window close.

### Host application

- One window: a Home tab plus one tab per PDF; drag to reorder; `.pdf` drops anywhere on the window open a tab.
- Opening from the file dialog, a recent entry, OS double-click (macOS `open-file`), or a second launch with a `.pdf` argument all land in a tab of the existing window (single-instance lock).
- Recent list (last 100 PDFs, missing files skipped) plus OS recent-documents registration on Windows and macOS.
- UI language and theme (light/dark/system) persisted in `userData/app-settings.json`.
- Application menu (File / Edit / View / Window / Help) with the usual accelerators: `Ctrl+O`, `Ctrl+S`, `Ctrl+Shift+S`, `Ctrl+P`, `Ctrl+W`.
- Frameless window with custom minimize / maximize / close controls in the tab strip on Windows, hidden-inset title bar on macOS.
- Full-width document footer with filename and save status, including when the assistant panel is collapsed.
- About card with version, license, and repository link.

### AI copilot

- Streaming ReAct agent with a cancel button, keepalive/watchdog, and tool-activity cards.
- **Document tools:** `read_pages`, `search_text`, `goto_page`, `get_outline`, `list_form_fields`, `fill_form_field`, `rotate_page`, `delete_page`, `markup_text`. Its writes appear in the document immediately and are undoable like toolbar edits.
- **Attachments:** pick one file, drop it on the panel, or paste an image. PDF, DOCX, PPTX, XLSX, and plain text are parsed locally; images are sent multimodally. One attachment per chat.
- **Web search and fetch** through the bundled search drivers (HTML search endpoints; no extra API key), with citations. Fetched pages are treated as untrusted context; private, loopback, and link-local addresses are refused.
- **Per-document history:** one JSONL transcript per file path. Reopening a PDF restores the **active** conversation for a follow-up (bounded, sanitized, with completed actions stated as outcomes rather than replayed), while conversations closed with **New chat** stay visible in the panel but never re-enter the model context and are never deleted. Stopped and failed turns, including completed actions, are recorded. Save As re-binds the transcript to the new path and preserves the conversation boundary even when histories merge.

---

## AI provider setup

AI is optional and works with bring-your-own-key endpoints only. Open provider
setup from either place:

- the **AI provider** button on the Home screen, or
- the **configure** card in a PDF's AI dock (it brings Home forward and opens the same dialog).

Then pick a provider and save once:

| Provider              | What it needs                                                                                                                                                                           |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Gemini**            | An API key from [Google AI Studio](https://aistudio.google.com/apikey), plus a model from the built-in list.                                                                            |
| **OpenAI-compatible** | A base URL (e.g. `http://localhost:11434/v1`, `http://localhost:1234/v1`, `https://api.openai.com/v1`), a model, and an optional key. Use **Fetch models** to read the endpoint's list. |

The dialog keeps one key per provider: clearing the Gemini key never wipes the
custom one. Local servers (Ollama, LM Studio) normally need no key.

How the keys are handled:

- Credentials are written to `userData/ai-settings.json` and live in the **main
  process only**. Every renderer sees redacted settings (`hasApiKey: true|false`),
  never the key itself, and streaming runs in the host's AI bridge.
- Manually started AI turns go straight from your machine to the endpoint you
  configured, with no proxy or relay service. Automatic document recommendations
  can also send limited PDF context when you explicitly enable that setting.
- Settings changes apply to the next turn without a reload.

---

## Zero Telemetry & Offline-First Privacy

ARAReader is offline-first and has no telemetry: **your reading activity and personal credentials stay on your device.** Optional AI and web features contact only the destinations described below, when used.

### 1. Absolute Zero Telemetry

- **No Analytics, Tracking, or Heartbeats:** ARAReader contains zero telemetry, analytics, event tracking, crash-reporting SDKs, install identifiers, or background pings. No telemetry code exists anywhere in the codebase.
- **No Accounts or Cloud Sign-Ins:** You are never required to register, log in, or authenticate with an ARA service. Everything runs immediately and locally out of the box.
- **No Intermediary Relays:** When utilizing AI capabilities with bring-your-own-key endpoints, requests travel directly between your machine and your chosen model endpoint (or stay 100% offline when using local servers like Ollama or LM Studio). Nothing is ever routed through ARA servers or third-party proxies.

### 2. Local-Only Storage & Execution

- **Document Processing:** PDF rendering (PDF.js), editing (`pdf-lib`), annotations, form-filling, text extraction, page reorganizing, and sanitization execute entirely on your local CPU. Untouched file bytes remain untouched.
- **Credentials & Preferences:** Your author profile (Display Name, Full Name, default author preference) and application settings are persisted strictly on your own device in `userData/app-settings.json`. Keys and tokens remain exclusively in the host process and are never accessible to renderer processes.
- **Chat Transcripts:** AI conversations and document histories are saved locally as individual JSONL files bound to your document paths on disk.

### 3. Strict Network Boundary

Network communication is strictly gated and limited to the actions below:

1. **Configured AI Endpoint:** Direct communication with the API endpoint you choose (e.g. Google AI Studio, custom OpenAI-compatible server, or local Ollama).
2. **Explicit Web Search & Page Fetch:** Powered by `@arareader/ai-search` only when you explicitly ask the assistant to search the web, with strict SSRF blocklists denying private, loopback, and local network ranges on every redirect hop.
3. **Application Updates:** Transparent GitHub release check (packaged Windows and macOS builds only, checked 5 seconds after launch and every 4 hours; or on demand via `Help → Check for Updates…`).
4. **Adaptive Prompt Suggestions (off by default):** Only after you explicitly enable it, opening a PDF while AI is connected sends the filename, page count, up to 10 outline titles, and at most 1,200 characters from the first three pages to your configured AI provider. The request is wrapped in explicit untrusted-content delimiters and is never sent to ARA servers. Manage the choice in `Settings → Preferences → Adaptive AI recommendations on document open`. This is separate from AI chat messages you choose to send.

> [!NOTE]
> Zero telemetry means ARAReader does not collect usage data. It does not prevent content from being sent to an AI provider or web endpoint you choose to contact. Review that destination's data-handling terms before sending sensitive material.

---

## Downloads and installers

| Platform | Target         | Configuration                                                                                             |
| -------- | -------------- | --------------------------------------------------------------------------------------------------------- |
| Windows  | NSIS (x64)     | Expected installer: `apps/desktop/release/ARAReader.Setup.0.2.2.exe` (per-user, with `.pdf` association). |
| macOS    | DMG + ZIP      | Configured in `apps/desktop/electron-builder.cjs`; must be built on macOS.                                |
| Linux    | AppImage + deb | Configured in `apps/desktop/electron-builder.cjs`; must be built on Linux.                                |

Version 0.2.2 installers were not built as part of this preparation. Release
artifacts are intended for [GitHub Releases](https://github.com/funara/arareader/releases);
the packaged app reads that repository from `resources/app-update.yml`. See
[docs/RELEASE.md](docs/RELEASE.md) for the release checklist.

**Builds are unsigned.** There is no Authenticode certificate and no Apple
Developer ID / notarization (`notarize: false`, `dmg.sign: false`). Windows
SmartScreen and macOS Gatekeeper will warn on first launch; that is expected for
these builds. Auto-update works on packaged Windows (NSIS, `latest.yml`) and
macOS (ZIP, `latest-mac.yml`) builds; on Linux the app shows a manual-download
notice instead. `ARAREADER_UPDATE_URL` points the updater at a generic static feed
(serving `latest.yml` / `latest-mac.yml`) instead of GitHub.

---

## Development quickstart

Prerequisites: **Node.js >= 22.12.0** and **npm >= 10**. No Rust toolchain is
needed — ARAReader is pure TypeScript/Electron.

```bash
git clone https://github.com/funara/arareader.git
cd arareader
npm install          # postinstall downloads the Electron binary
npm run dev          # PDF renderer on :5176 + host window with hot reload
```

`npm run dev` starts two processes: the PDF module's renderer dev server
(`vite.renderer.config.ts`, port 5176) and the desktop host (`electron-vite dev`,
which serves the host renderer on port 5199 and loads the PDF view from 5176).

### Build and run the built app

```bash
npm run build        # apps/pdf, then apps/desktop (electron-vite)
npm run start        # rebuilds the host and launches Electron on the built output
```

The host resolves the PDF module from `apps/pdf/out` in an unpacked run and from
`resources/modules/pdf` in a packaged build.

### Gates

```bash
npm run typecheck    # tsc --noEmit across every workspace that has the script
npm test             # vitest: @arareader/desktop, then @arareader/pdf
npm run build        # both apps
npm run lint         # eslint .
npm run format:check # prettier --check on files changed vs git (see below)
npm run licenses     # dependency license allowlist gate
npm run notices      # regenerate apps/desktop/build/THIRD-PARTY-NOTICES.txt
npm run test:e2e     # Playwright Electron suite (build first)
```

- `npm test` covers the host and the PDF module. Package suites run per workspace:
  `npm test -w @arareader/agent-core` (and `ai-provider`, `ai-search`,
  `docx-engine`, `electron-utils`, `file-parse`, `i18n`, `project-store`).
- `format` / `format:check` run Prettier over files changed against git
  (working tree, index, and untracked), not the whole repo:
  `npm run format:check -- --base origin/main` checks a branch diff instead.
- `npm run test:e2e` launches the **built** app with Playwright's `_electron`
  against `apps/desktop` (temp `userData`, English UI, workers: 1). Run
  `npm run build` first; the config lives in `e2e/playwright.config.ts`.

### Package

```bash
npm run dist:win     # build -> notices -> electron-builder (NSIS x64)
npm run dist:mac     # build -> notices -> electron-builder (dmg, zip)   [macOS host]
npm run dist:linux   # build -> notices -> electron-builder (AppImage, deb) [Linux host]
```

Artifacts land in `apps/desktop/release/`. Each script runs the app builds and
the notices refresh first because electron-builder only ships what already
exists and fails the build when an `extraResources` source is missing.

### Environment variables

Optional. Read from the environment at runtime, with a repo-root `.env` as
fallback; the packaging config also consults the same names at build time.

| Variable                                                | Effect                                                                                     |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `ARAREADER_USER_DATA`                                   | Runtime (`userData`) override; dev runs otherwise use `ARAReader Dev`.                     |
| `ARAREADER_LANG`                                        | Runtime UI language override (e.g. `en`, `ja`).                                            |
| `PDF_RENDERER_URL` / `PDF_DEV_PORT`                     | Host: load the PDF view from this dev-server URL. PDF dev server: its port (default 5176). |
| `ARAREADER_UPDATE_URL`                                  | Use a generic static update feed instead of GitHub Releases.                               |
| `ARAREADER_FAKE_UPDATE` / `ARAREADER_FAKE_JUST_UPDATED` | Simulate a download / a post-update launch in an unpacked build.                           |
| `ARA_GITHUB_OWNER` / `ARA_GITHUB_REPO`                  | Override the release feed and changelog coordinates.                                       |

A repo-root `.env` is gitignored and used as a fallback for these values.

---

## Repository layout

```text
arareader/
  apps/
    desktop/            # host: main (window, tabs, menus, AI bridge, updater),
                        # preload, React home/tab strip/title bar, tests
      build/            # icons, NSIS script, generated THIRD-PARTY-NOTICES.txt
      electron-builder.cjs
    pdf/                # the PDF module: main (pdf-lib writers, IPC), preload,
                        # renderer (PDF.js viewer, ribbon, panels, AI dock), tests
  packages/
    agent-core/         # ReAct loop, skill composition, shared prompts and tools
    ai-provider/        # provider settings, Gemini + OpenAI-compatible streaming
    ai-search/          # web search / page extract with an SSRF blocklist
    file-parse/         # attachment text extraction (pdf, docx, pptx, xlsx, text)
    docx-engine/        # DOCX parsing needed by file-parse
    project-store/      # file -> chat mapping and per-document JSONL history
    i18n/               # typed locale core shared by host and PDF module
    ui/                 # shared AI panel components and CSS
    electron-utils/     # atomic writes, safe URLs, dialogs, menus, navigation guard
  e2e/                  # Playwright Electron specs and config
  tools/                # format-changed, check-licenses, gen-third-party-notices
  public/               # brand assets shipped as resources
  docs/                 # architecture, release checklist, QA matrix
```

---

## Documentation

- [CHANGELOG.md](CHANGELOG.md) — version history and unreleased changes.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — process model, tab hosting, PDF
  module runtime, AI bridge and storage, security invariants, packaging and updates.
- [docs/RELEASE.md](docs/RELEASE.md) — the exact release checklist (build, tag,
  publish, artifact names, feed, signing caveats).
- [docs/QA-MATRIX.md](docs/QA-MATRIX.md) — manual QA coverage: CJK, password,
  huge, and form PDFs, dark/light, scaling, dirty close, Save As.
- [CONTRIBUTING.md](CONTRIBUTING.md) — setup, gates, formatting, package
  boundaries, commit and release policy.
- [AGENTS.md](AGENTS.md) — repo map and invariants for AI coding agents.

---

## Known limitations (v0.2.2)

- macOS and Linux installers are configured but have not been built here; they
  must be produced on their own hosts.
- No code signing or notarization.
- No OCR: scanned/image-only PDFs have no text for the assistant or search.
- Signatures are visible annotations, not cryptographic signatures; there is no cryptographic signing or validation.
- One attachment per chat.
- The PDF view is translated into the locales shipped in `apps/pdf` (including
  CJK, RTL, and `zh-TW`); the Home screen and tab strip currently fall back to English.

---

## License

ARAReader is released under the **GNU General Public License v3.0 or later**
(`GPL-3.0-or-later`). See [LICENSE](LICENSE).

Third-party components are licensed separately: `THIRD-PARTY-NOTICES.txt` and
`LICENSES.chromium.html` ship inside every installer's `resources/` directory,
and the notices file is regenerated with `npm run notices`.
