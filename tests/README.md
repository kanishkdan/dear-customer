# Extension checks

The extension has no build step or runtime package dependencies.

## Logic regressions

Run from the repository root:

```sh
node --test tests/engine.test.cjs
```

The harness loads the production engine with browser rendering and boot replaced. It exercises selection, ignore recovery, cancellation between actions, partial/failed outcomes, timeouts, STOP and report limits, history, Wall eligibility and share counts, plus the 1.0.3 safeguards: saved contacts never pre-ticked, marketing-only actions for senders that also send updates, update-only and inactive numbers left alone, the opt-out gate, old stored delete choices stripped, no saves before history loads, and a debug handle that can't start a run. WhatsApp operations are mocked.

## Browser checks and screenshots

Use Node 20+ and install `playwright-core@1.63.0` in your development environment. Set `CHROMIUM_PATH` to an installed Chromium executable. Playwright's Chromium build 1223 was used for this release.

```sh
npm install --no-save --package-lock=false playwright-core@1.63.0
CHROMIUM_PATH='/absolute/path/to/chromium' node tests/ui-smoke.cjs
```

The browser loads the unmodified production scripts into an isolated page with fictional chats. WhatsApp APIs, extension storage, public Wall responses and the X window opener are mocked. All network requests are blocked, and any attempted request fails the suite.

The checks cover initial setup, ignore/restore, row expansion, stable row and Stop-button identity during progress, scroll position, completion, partial failures, cancellation, unblocking, sharing, PNG downloads and a compact window. Screenshots are written to `dist/qa/`; they are labelled as demo data.

These checks cannot establish whether WhatsApp's current internal opt-out, report or archive APIs work in a real linked account. The live acceptance pass is in `store/LAUNCH.md`.
