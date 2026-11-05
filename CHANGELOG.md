# Changelog

All notable changes to **ARAReader** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.1.0] - 2026-11-04

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
