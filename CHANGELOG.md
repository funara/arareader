# Changelog

All notable changes to **ARAReader** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [v0.2.3]

### Added

- **Organize pages:** Drag a page to reorder it across the grid, or use the accessible move controls. Page moves support undo and are saved with the document.

### Changed

- **AI privacy:** Automatic document recommendations are off until explicitly enabled. Attachment access requires a user-authorized file selection.
- **Reader preferences:** Apply the selected default zoom, sidebar, and autosave settings when reading PDFs.
- **Keyboard navigation:** Improve focus handling in PDF dialogs, Settings, and the tab strip.

### Fixed

- **Save and close:** Prevent overlapping operations from racing document saves and close prompts; retain a recovery path when a saved document cannot be refreshed.
- **Web safety:** Pin validated network addresses across requests and redirects, and reject oversized or excessively compressed responses.
- **Page operations:** Extract and insert pages at their displayed positions after pending page changes are saved.

## [v0.2.2]

### Added

- **Page layout controls:** Switch between single-page and two-page layouts from the footer or Read-mode header.
- **Assistant history:** Open a recent PDF with a fresh conversation while keeping earlier messages available in History.

### Changed

- **Assistant reliability:** Preserve conversation boundaries and report stopped or failed actions accurately.
- **Text editing:** Clicking outside the active text editor cancels its unapplied draft; applied edits remain.
- **Navigation sidebar:** Show the narrow sidebar rail only when the pane is collapsed.

## [v0.2.1]

### Added

- **Page-by-page view:** Switch between continuous scrolling and page-by-page reading from the View tab, footer, or Read-mode header. Navigate pages or spreads with the mouse wheel, keyboard, or thumbnails.

### Changed

- **Reading experience:** Page-by-page view fits pages to the window, keeps your place when switching views, and preserves in-progress text edits when turning pages.
- **Update dialog:** Refined the update-ready dialog for a clearer, more consistent appearance.

## [v0.2.0]

### Added

- **QR signatures:** Create a visible QR stamp containing the signer's name, local date and time with time-zone offset, intent, and recipient. Optionally combine it with the default saved primary signature and adjust the layout before placement.
- **Read mode:** Focus on the document with the ribbon, footer, and panels hidden. Exiting restores the previous mode and panel layout, including unfinished text-edit drafts.
- **Command Center:** Search commands and document text from one launcher with `Ctrl+K` (or `Cmd+K` on macOS). Animated hints describe the available searches.
- **Document status:** The full-width footer shows the filename and save status even when the assistant panel is collapsed.

### Changed

- **Select, Edit, and Read modes:** Existing annotations are passive outside Edit, preventing accidental selection, movement, resizing, copying, or removal. Read is an interface mode, not a permanent PDF lock.
- **Signatures and stamps:** Selected image stamps can be copied to the clipboard or removed in Edit mode, with undo available for removal.

QR signatures and other visible signatures are **not cryptographic signatures**. The QR contains user-supplied information; it does not verify identity or protect the document from tampering.

## [v0.1.0]

### Initial Standalone Release

ARAReader is the standalone, privacy-first PDF reader and editor of the ARAOffice family, engineered with an optional bring-your-own-key AI copilot and an uncompromising zero-telemetry commitment.

#### Absolute Zero Telemetry & 100% Offline Privacy

- **Zero Telemetry by Design:** Contains no tracking, analytics SDKs, crash reporters, user profiling, telemetry pings, or background heartbeats.
- **No Cloud Accounts:** No registration, login, or cloud authentication required.
- **Local-Only Processing:** PDF rendering, page operations, annotations, form editing, and AI chat transcripts run and persist strictly on your device.
- **Direct AI Connection:** When using AI features, requests travel directly between your machine and your chosen model endpoint (Google Gemini, OpenAI-compatible servers, or 100% local models like Ollama / LM Studio) with no intermediary proxies.

#### Onboarding & Author Credentials

- **First-Launch Author Setup:** Onboarding modal prompting for Display Name and Full Name to credit document metadata, annotations, and signatures.
- **Clear Privacy Guarantee:** Prominent local-only privacy assurance banner with theme-aware ARAReader brand logos.

#### PDF Reading & Navigation

- High-fidelity PDF rendering with selectable text and smooth continuous scrolling.
- Single-page, two-page spread, fit width, and fit page zoom modes.
- Sidebar with interactive thumbnails, document outline / bookmarks, and comments panel.
- Fast in-document text search with match cycling and highlight navigation.
- Password-protected PDF support with safe read-only guard.

#### Document Editing & Annotation

- **Annotation Tools:** Highlight, underline, strikeout, squiggly text markup.
- **Drawing & Shapes:** Freehand ink, rectangle, ellipse, line, arrow, polyline, polygon, typewriter text, and sticky notes.
- **Form Filling:** Interactive form field completion (text inputs, checkboxes, radio buttons, choice dropdowns) written directly to file.
- **Stamps & Signatures:** Image-based signature annotations and custom image stamps with dedicated canvas drawing pads.
- **Document Metadata:** View and edit PDF Title, Author, Subject, and Keywords.
- **Watermarking:** Watermark and header/footer modal with multi-text options.

#### Page & Document Operations

- Rotate, delete, and reorder pages visually.
- Extract page ranges to a new PDF document.
- Insert external PDF documents at any page index.
- Split documents by page intervals, ranges, or top-level bookmarks.
- Combine and merge multiple PDF documents with automatic bookmark preservation.
- Document sanitization tool (census and removal of metadata, embedded JavaScript, attachments, comments, and private data).
- PDF accessibility analysis report and metadata tagging repairs.
- File fidelity guard: untouched file bytes remain bit-for-bit identical.

#### Host Application & OS Integration

- **Single-Window Tab Strip:** Home workspace tab plus one tab per open PDF with drag-and-drop reordering.
- **Single-Instance Lock:** Opening PDFs from File Explorer automatically activates the existing window and opens a new tab.
- **Windows Integration:** Full file association (`.pdf`), context menu ("Open with ARAReader"), and registered capabilities for Windows 10/11 Default Apps settings.
- **Recent Files:** Recents tracking up to 100 documents with OS jump-list integration.
- **Theme Synchronization:** Seamless Dark, Light, and System theme switching.
- **In-App Updater:** Seamless updates with differential blockmap support.

#### Optional AI Copilot

- Streaming ReAct agent with full document context awareness.
- Document action tools: `read_pages`, `search_text`, `goto_page`, `get_outline`, `list_form_fields`, `fill_form_field`, `rotate_page`, `delete_page`, and `markup_text`.
- Local attachment analysis and inspection.
- Optional web search and page fetch guarded by strict private-network SSRF blocklists.
- Per-document JSONL transcripts saved on disk and restored upon re-opening.
