# BelloMind

**Knowledge Without Limits.**

BelloMind is an AI-powered reading, studying, and personal knowledge platform. The current project is a browser-only, local-first PWA foundation. It has no application server, account system, cloud database, or AI provider configured.

## Current implementation

| Area | Implemented in this repository | Limits and follow-up |
| --- | --- | --- |
| Library | Imports PDF, TXT, and EPUB files up to 80 MB into IndexedDB; search, sort, open, remove; app shell is cached by the service worker | Browser storage can be evicted; no cloud upload, collections, duplicate detection, import progress, or storage quota estimate |
| TXT reader | UTF-8 browser text display; scroll position; saved bookmarks, highlights, and notes; reading theme | Search and text reflow preferences are not implemented |
| PDF reader | Opens a local PDF in the browser's native PDF viewer; page number entry and previous/next controls save a manual page position; page bookmarks and notes | Native viewer page position is not exposed consistently, so page tracking is manual; highlights inside its viewer are unavailable; no PDF.js integration or page count extraction |
| EPUB reader | Reads EPUB ZIP package/spine and navigates chapters; renders safe text structure and local PNG/JPEG/GIF/WebP images; persists chapter position, bookmarks, notes, and text highlights | Uses browser `DecompressionStream` with `deflate-raw`; unsupported compression, ZIP64, encrypted or multi-disk EPUBs fail clearly. EPUB styles, navigation TOC, SVG, audio/video, scripts, external resources, and some advanced EPUB features are not supported |
| Annotations | Local IndexedDB bookmarks, notes, and persistent visible text highlights in TXT/EPUB; EPUB/TXT annotations include reader position | PDF text annotations are unavailable in the native viewer; no cloud sync or cross-account partitioning |
| Focus | Timestamp-based timed/custom/open sessions, pause/resume, restart/end, optional pausable/extendable breaks; persistent local session history; active focus excludes focus-paused and break intervals; start coordination across tabs | Uses the device wall clock, so clock changes can affect duration. Browser locks coordinate concurrent starts where available; older-browser fallback uses a short local-storage lock. No cloud session sync or closed-app alerts |
| Reading estimate | Tracks visible reader time while the reader is open and has had activity within the last five minutes; shown separately from focus time | This is an estimate, not proof of attention. Background/idle time is excluded; multiple visible tabs may overcount. No goals, streaks, quiz history, or cloud analytics |
| PWA | Manifest, install icon, cached app shell, and offline access to locally imported documents and local records | Install/offline behavior has not been verified in a browser in this environment |
| Accounts, sync, AI, discovery | Honest unavailable states; no fabricated provider responses | Supabase authentication, database, private storage, secure server-side AI, sync/conflicts, resource search, and community features are not implemented |

### Local data behavior

Document blobs, library metadata, annotations, reading estimates, and focus history are stored in the current browser profile using IndexedDB. Timer state and preferences use localStorage. Clearing browser/site data or storage eviction may remove this data. The JSON export includes library metadata, notes, bookmarks, reader/focus/reading-session records, and timer state, but not document binary files. There is no account separation or cloud backup, so use a private browser profile for private documents.

Imported files are treated as untrusted. EPUB chapter content is parsed as XML and reconstructed from an allowlist of elements; EPUB scripts, stylesheets, active media, and external links are not executed. The EPUB reader enforces compressed file, entry count, and expanded-size limits. PDF rendering is delegated to the browser viewer.

## Run the current app

This version is plain HTML, CSS, and JavaScript and has no `package.json` or npm install step. It must be served from localhost for reliable IndexedDB and service-worker behavior.

Python 3.13.9 is available in this environment through the `python` command. The `py` launcher is present but reports that no Python installation is available, so use `python` directly:

```powershell
python -m http.server 4173
```

Run the command from the project root, then open `http://localhost:4173`. Any static localhost server can serve the repository root instead. This server serves the files but does not itself verify browser behavior, PWA installation, or offline use.

### Development tool requirements

The next build-system phase requires **64-bit Windows Node.js 24.x LTS** and the **npm version bundled with that Node.js installer**. Install the official Node.js LTS Windows x64 package, then confirm `node --version` reports `v24.x` and `npm --version` succeeds in a newly opened terminal. Do not install npm separately or use the Current release line. The official download page currently lists Node.js v24.21.0 as LTS; re-check the latest 24.x LTS patch when setting up the toolchain. After the runtime is available, add pinned project dependencies and lockfiles for Vite/TypeScript and browser automation; this repository currently has no `package.json`, build command, or automated tests. Do not add real credentials to frontend files.

## Supabase and AI integration assessment

Supabase is a reasonable candidate for the requested hosted auth, PostgreSQL, and private object storage, with server-side functions for privileged AI and upload operations. It is not configured here. Before implementing it, provision a Supabase project and decide the deployment target for server-side functions. The browser may contain only the project URL and public anon/publishable key; that key is safe to expose only when every user-data table and storage bucket has tested row-level/storage policies. The service-role key and AI provider key must remain in server-side secret storage.

The backend phase needs version-controlled migrations and explicit user ownership policies for profiles, library metadata, annotations, reading/focus sessions, and sync tombstones. Private document upload must be opt-in. Local IDs and per-record revision/version metadata should support idempotent synchronization and explicit conflict handling. Account changes need a local-data partition/lock policy before cloud sync is enabled. None of these protections are implemented or tested yet.

AI should be called only through authenticated server-side functions that verify ownership, retrieve bounded document passages, validate structured output, and enforce usage limits. The current UI does not send documents to a cloud AI. Offline/on-device AI has not been implemented or selected; assess device memory, download size, performance, browser support, licensing, and answer quality separately before offering it.

## Next development phases

1. **Tooling and reader verification:** install Node.js/npm and Python or another localhost server; create a Vite/TypeScript build and automated tests; verify EPUB examples, PDF page control, annotations, file limits, browser storage failure, offline shell, responsive layouts, and accessibility in target browsers. Consider PDF.js and a maintained EPUB library if native/manual behavior is insufficient.
2. **Focus hardening:** add automated tests for timer transitions, custom/open sessions, break pauses/extensions, reopen/suspension, duplicate starts across tabs, and daily/weekly calculations. Document/handle clock corrections and interrupted/corrupt local timer state.
3. **Identity and synchronization:** provision Supabase, write migrations/RLS/storage policies, add registration/login/recovery, scope local data by account, and implement a durable outbox with idempotency, retries, tombstones, and conflict resolution.
4. **Study tools:** deploy authenticated AI functions with a provider secret, secure document retrieval and citations, structured summaries/flashcards/quizzes, limits, and real unavailable/error states.
5. **Learning/release:** expand measured/estimated reading analytics, goals, quiz history, resource discovery, community controls, security review, real end-to-end coverage, deployment, and backup/recovery documentation.

## Branding

- App name: **BelloMind**
- Project folder: `bellomind`
- Tagline: **Knowledge Without Limits.**
- Description: **An AI-powered reading, studying, and personal knowledge platform.**
- Brand personality: intelligent, modern, premium, welcoming, and trustworthy

The B mark is a custom SVG letterform with a subtle book-spine motif. The app name, domain, and trademark have not been checked for availability.

## Verification log (2026-10-11)

- Inspected the existing README, static app files, and `.vscode/settings.json` (Live Server configured for port 5501). No existing user data or package/deployment configuration was present in the repository.
- Confirmed all 70 statically referenced `$('#id')` selectors in `app.js` have a matching element in `index.html` after the reader controls were added. This is a static consistency check, not an application test.
- The earlier environment note that Python was unavailable was incorrect: `python --version` reports Python 3.13.9. The `py` launcher reports no installed Python runtime. Node.js, npm, npx, Playwright, and Selenium were not found.
- Static server execution and HTTP responses are recorded for the preparation phase below. No interactive browser check was completed. Service worker registration, IndexedDB, EPUB rendering, timer workflows, PWA installation, and offline behavior remain unverified.
- No production build or automated test suite was run. No dependencies were installed. These limitations are environmental, not passing test results.

## Preparation phase verification (2026-10-11)

- Ran `python -m http.server 4173` from the project root and fetched `http://127.0.0.1:4173/`; the server returned HTTP 200 (`text/html`, 15,321 bytes). This verifies static serving only, not browser execution.
- Inspected the entry HTML, manifest, service worker, and referenced local assets. Root-relative paths (`/index.html`, `/styles.css`, `/app.js`, `/manifest.webmanifest`, `/icon.svg`, `/sw.js`) work when hosted at the origin root, as in the command above; deploying under a URL subpath would require adjusting them and the manifest scope/start URL.
- Fixed service-worker activation so it removes only older BelloMind cache names, rather than deleting every Cache Storage entry for the origin. Restricted runtime caching to the app shell, avoiding indefinite caching of arbitrary same-origin GET responses. Navigations now use the network first and fall back to the cached app shell when offline.
- Offline behavior and installability remain unverified in an actual browser. The manifest supplies an SVG icon; target-browser installation compatibility should be checked during browser verification.
