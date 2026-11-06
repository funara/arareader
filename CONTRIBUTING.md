# Contributing to ARAReader

Thanks for your interest. ARAReader is the PDF reader/editor of the ARAOffice family (GPL-3.0-or-later); ARAOffice is the parent application, and this repository is ARAReader's standalone build, extracted from the [ARAOffice](https://github.com/funara/araoffice) tree. This file covers setup, the checks a change must pass, the boundaries we keep, and how changes land.

## Getting started

Prerequisites:

- **Node.js >= 22.12.0**
- **npm >= 10** (workspaces; the repo is an npm workspaces monorepo)

```bash
git clone https://github.com/funara/arareader.git
cd arareader
npm install
npm run dev
```

`npm install` runs the root `postinstall` (`install-electron`, the Electron
package's own installer), which downloads the Electron runtime. `npm run dev`
starts the PDF renderer dev server on port 5176 and the host window with hot
reload; the host renderer uses port 5199 and loads the PDF view from 5176
(override with `PDF_RENDERER_URL`).

To run the built app instead:

```bash
npm run build     # apps/pdf, then apps/desktop
npm run start     # electron-vite build of the host, then launch Electron
```

## Gates a change must pass

Run these before you ask for review. All of them are expected to be green on
`main`; a change that breaks one is not finished.

| Command                | What it covers                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| `npm run typecheck`    | `tsc --noEmit` in every workspace that defines the script (all apps and all nine packages)        |
| `npm test`             | vitest suites for `@arareader/desktop` and `@arareader/pdf`                                       |
| `npm run build`        | electron-vite builds of the PDF module and the desktop host                                       |
| `npm run lint`         | `eslint .` (flat config, TypeScript + React hooks)                                                |
| `npm run format:check` | Prettier over files changed against git                                                           |
| `npm run licenses`     | every production dependency must carry a license from the allowlist in `tools/check-licenses.mjs` |
| `npm run notices`      | regenerates `apps/desktop/build/THIRD-PARTY-NOTICES.txt` used by packaging                        |
| `npm run test:e2e`     | Playwright Electron suite in `e2e/` — run `npm run build` first                                   |

Notes that cost people time:

- **`npm test` does not fan out to `packages/*`.** Run those suites explicitly when
  you touch a package, for example `npm test -w @arareader/agent-core`. The
  packages with tests are `agent-core`, `ai-provider`, `ai-search`,
  `docx-engine`, `electron-utils`, `file-parse`, `i18n`, and `project-store`.
- **`test:e2e` launches the built app**, not the dev server. Build first. Each
  spec boots `apps/desktop/out` with a scratch `userData` directory
  (`ARAREADER_USER_DATA`), English UI (`ARAREADER_LANG=en`), and runs serially —
  parallel Electron instances fight over the GPU cache and the single-instance
  lock.
- **`format` / `format:check` only look at changed files** (working tree, index,
  and untracked files), which keeps the gate fast. To check a branch:
  `npm run format:check -- --base origin/main`. `npm run format` rewrites them.
- **`licenses` and `notices` read what actually ships.** A new dependency needs a
  permissive license (see the allowlist) or it fails the gate; if it is bundled
  into `out/`, it also needs to appear in the notices file.

## Formatting and style

- Prettier is the source of truth: no semicolons, single quotes, trailing commas,
  `printWidth: 100`, LF line endings (see `.prettierrc.json` and `.gitattributes`).
- ESLint's `no-unused-vars` allows `_`-prefixed names for deliberately unused
  arguments and variables; `no-empty` allows empty `catch` blocks (deliberate
  fail-open) but not empty blocks elsewhere.
- Comments explain **why**, not what. Existing code follows that habit — match it.
- Keep user-visible strings in the string tables (`apps/pdf/src/renderer/i18n/strings.ts`
  for the PDF view, `apps/desktop/src/renderer/src/strings.ts` for the host) rather
  than inline in components.

## Package boundaries

- **`apps/desktop`** is the host: window lifecycle, tab manager, home screen, tab
  strip, menus, recents, app settings, the AI bridge, and the updater. It owns
  every `ai:*`, `files:*`, and `project:*` handler.
- **`apps/pdf`** is the document module: PDF.js rendering and editing UI, its own
  preload and `pdf:*` IPC, and the `pdf-lib` writers in `src/main`. It is loaded
  into a `WebContentsView` per tab. It may not reach into `apps/desktop` source;
  the host imports the PDF module's main/preload/shared entry points, not the other
  way round.
- **`packages/*`** are pure TypeScript (except `ui`, which is React components)
  and must stay Electron-free unless they are explicitly main-process helpers.
  Import the package entry point (`@arareader/...`); vite aliases resolve to
  `src/`, so no build step is needed for local development.
- **Shared IPC contracts live in `src/shared/*.ts`** on the side that owns the
  handler, and channel names are a cross-module contract — never rename them.
- New dependencies need a reason. This app ships a small dependency set on
  purpose; do not add one that duplicates an existing package (atomic writes,
  i18n, search, provider streaming already exist here).

## `araoffice` is read-only

ARAOffice is the parent app. ARAReader was extracted from `araoffice`, which lives
next to it on disk (`C:/Users/adhir/Documents/Git/ARAEcosystem/araoffice`). Reading
it for reference is fine. **Never** edit, format, generate files into, or run
mutating commands in that tree, and never add a build or runtime dependency back
into it. The extraction is one-way: this repo advances on its own, and security
fixes are cherry-picked into ARAOffice by hand, deliberately.

## Secrets and local data

- Never commit API keys, tokens, or `.env` files. `.env`, `ai-settings.json`, and
  `app-settings.json` are gitignored; a local repo-root `.env` is only read for
  feed and brand identity overrides (`ARA_GITHUB_*`, `ARAREADER_UPDATE_URL`, …).
- Do not commit real documents as fixtures. Tests build their fixtures in code
  (`apps/pdf/tests/*.test.ts`) or in temp directories.
- AI credentials stay in the main process. If you touch the AI bridge, keep the
  redaction boundary intact: renderers may see `hasApiKey`, never the key.

## Commits and releases

- Keep commits focused, and write the summary as `type(scope): imperative summary`
  with a short body explaining the _why_ when it is not obvious. Existing history
  uses `feat(ai)`, `feat(desktop)`, and similar scopes.
- Do not commit build output: `out/`, `release/`, `dist/`, `*.exe`, `*.dmg`, test
  reports, and generated notices are ignored (or regenerated) on purpose.
- Releases are maintainer-only. Tagging a version, building installers, and
  publishing to GitHub Releases happen **only** on an explicit human go-ahead —
  the exact procedure is [docs/RELEASE.md](docs/RELEASE.md). Never push, tag, or
  publish as part of an automated change.
- No signing credentials are configured; do not introduce a signing step that
  silently fails or produces a partially signed artifact.

## Issues and pull requests

- For a bug, include: the PDF type (if shareable), the platform, the app version
  from the About card, and the steps that reproduce it. Never attach a confidential document.
- For a feature, say what the PDF workflow is and what currently happens instead.
  Features that need new architecture belong in a discussion first; small
  improvements are welcome as PRs.
- Keep a PR scoped to one concern. Include the gate output you ran, and add a test
  for behavior changes (vitest next to the code, or an e2e spec when the flow is
  host-level).
- Rebase or merge `main` before asking for review rather than force-pushing over
  someone else's commits.
