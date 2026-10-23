# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.

It reads a **Rainforest Eagle-200 / Eagle-3** through its local API (HTTP,
port 80): XML commands `device_list` and `device_query` POSTed to
`/cgi-bin/post_manager` with the Cloud ID and the install code as HTTP Basic
credentials. The API, commands and answers are ported from
[aioeagle](https://github.com/home-assistant-libs/aioeagle) (Apache-2.0, see
`THIRD_PARTY_NOTICES.md`). Unofficial: not affiliated with Rainforest
Automation. **Read-only**: never `onSetValue`. Siblings: `gladys-sonnen`
(structure, pace, store), `gladys-p1-monitor` (the guard, a main meter).

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
node --test --test-name-pattern "guard"   # tests whose name matches
npm run audit                             # npm audit --omit=dev
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only: handlers registered before connect()
src/app.js                        EagleApp: pace, reads, index, refusal, pauses, buttons
src/eagle/client.js               the only HTTP access (two read commands, bounded body)
src/eagle/model.js                commands and answers -> values (pure)
src/eagle/xml.js                  small bounded XML reader (pure, linear)
src/guard.js                      plausibility of an energy index, from gladys-p1-monitor (pure)
src/store.js                      what /data keeps across restarts
src/devices.js                    the device of a meter, feature keys, states (pure)
src/config.js                     address, Cloud ID, install code, interval, normalized
src/constants.js                  commands, pacing, limits, manifest keys
src/i18n.js                       runtime texts (en/fr)
gladys-assistant-integration.json manifest: name, config_schema, actions...
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test, against the SDK's fake Gladys (integration-sdk/testing)
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
```

## Rules

- **Read-only.** No `onSetValue`, only the commands of `COMMANDS`
  (`test/client.test.js` checks it). A command, if one is ever added, is a
  `button` disabled by default behind an option, never a `switch`.
- **The install code** (and the Cloud ID) is never logged, never shown, never
  written to `/data` (only a salted fingerprint of REFUSED credentials,
  erased by the first success), only sent to the configured address; no
  redirect followed. Its field is described as "kept by Gladys in its
  database, never shown again".
- **Refused credentials are final**: never retried by the timer; only a click
  on the test button or other credentials saved try again.
- **Pace**: never a read faster than the interval, whatever asks (test
  button, Discovery, connection, save, restart: `/data` keeps the last
  request, written at most once a minute); one second between two requests.
  A read of an old generation publishes nothing and sets no status.
- **Energy monitoring**: `consumption_index` is the only index (`INDEXES` in
  `src/devices.js`), through `IndexGuard` (`src/guard.js`, taken as it is):
  never 0, a drop and a jump never confirmed by repetition nor by time, only
  by the `accept_held_index` action clicked twice. The energy sent to the
  grid is a plain sensor; no `daily-consumption`, never
  `publishEnergyConsumption`.
- **Hostile answers**: bodies bounded to 256 KiB in one buffer, the XML reader
  bounded and linear, no DOCTYPE, strict numbers, ranges checked. Never a
  text of the Eagle in a message.
- **External ids are forever**: `meter:<hardware address>`, the `FEATURE`
  keys of `src/devices.js`, the manifest keys. The catalog is fixed: a device
  published again never loses a feature.
- **Units**: only those of `DEVICE_FEATURE_UNITS_BY_CATEGORY` in the core
  (`test/manifest.test.js`).
- **The container rootfs is read-only.** Write only under `/data`:
  `src/store.js` keeps `/data/rainforest-eagle-state.json`.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand. `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md` (`### Added`, `Changed`, `Fixed`, `Removed`, `Security`).
  Never write a version heading: the Release workflow moves the section.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`.
  The catalog `description` holds 10 to 100 characters per language.
- **User-facing text** is bilingual (English and French), kept in sync. Files
  are UTF-8 without BOM nor control byte (`test/encoding.test.js`, sources
  included).
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network.
