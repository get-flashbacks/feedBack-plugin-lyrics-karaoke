# AGENTS.md

## Commands

```bash
npm ci && npm test && npm run lint
python3 -m pip install pytest fastapi pyyaml httpx ruff
python3 -m pytest -q tests
python3 -m compileall -q routes.py tests
ruff check --select E4,E7,E9,F routes.py tests
node --check screen.js
for file in tests/*.test.js; do node --check "$file"; done
python3 tests/fixtures/generate_feedpaks.py /tmp/vocals-fixtures
```

- Node: use `node` / `npm`, not `python`. ESLint 10 requires Node 20.19+, 22.13+, or 24+. CI uses Node 22.
- Python: this environment uses `python3`; README's `python -m pip` won't run.

## CI gates (pull_request / push to main)

1. `version-bumped-on-change` — any functional source change (`.py|js|html|css` outside `tests?/`) MUST be accompanied by a `plugin.json` version bump and a `CHANGELOG.md` `[Unreleased]` update. The diff is against the merge base.
2. `idempotent-top-level-guard` — `screen.js` must have a `window.__*` reload guard because it re-executes on plugin reload.
3. Shared reusable CI runs `tests/*.test.js`.

## Repo shape

- FeedBack plugin — no build step. Runtime ships `screen.js` + `routes.py` + `screen.html`.
- `package.json` is private dev-tooling only; nothing here is published or loaded at runtime.
- `screen.js` is a classic script (`sourceType: 'script'`), not a module. It runs in the host's browser context.
- Python backend is FastAPI routes mounted by the host.

## ESLint quirk

`eslint.config.mjs` is named `.mjs` deliberately. A `eslint.config.js` at repo root would be caught by the compliance workflow's functional-source glob, tying it to the plugin-version gate.

## ESLint exemptions on `screen.js`

Two ESLint 10 recommended rules are turned off for `screen.js` only:
- `no-useless-assignment`
- `preserve-caught-error`

Known dead-code sites exist (`let body = null`, `let devices = []`, one dropped cause). Fix them in a functional-source PR with a version bump, not in the linter-introduction PR.

## Screen.js reload/idempotency

Top-level `addEventListener` / `setInterval` calls must be guarded by a `window.__*` flag. Existing guards:
- `window.__feedBackLyricsKaraokeMic`
- `window.__feedBackLyricsKaraokeDeviceWatch`

## Migration status

Since 1.13.0 the highway renderer is **not** selectable from any host control. The Karaoke button drives the legacy pitch ribbon. Existing splitscreen panels that already saved Lyrics Karaoke as their viz keep loading it. Do not add host-control surface without updating `plugin.json` capabilities and the architecture doc.

## Backend path containment

`routes.py` song resolution delegates to the host's shared containment helper (`dlc_paths._resolve_dlc_path` if present, else `safepath.safe_join`). The plugin never joins a filename onto the library directory unchecked — if neither helper exists, resolution returns `None` (404) rather than guessing.

## Key docs

- `docs/architecture/vocals-visualization-integration.md` — renderer ownership, settings namespace, minimum host version.
- `docs/architecture/vocals-playback-contract.md` — canonical `/playback` payload shape.
- `docs/user-guide.md` — user-facing setup, calibration, troubleshooting.
