# Changelog

All notable changes to this project are documented in this file.

## [1.0.7] - 2026-09-13

### Fixed

- Completing a cycle via `turnOffOnCycleComplete` while `resetCountOnOff` was also
  enabled reset the rotation counter, but left the switch that had just fired showing
  "on" — the switch accessories were never told the rotation had reset. They're now
  cleared back off at the same moment the counter resets, matching what already
  happened on a manual "off".

## [1.0.6] - 2026-09-12

### Added

- A GitHub Actions workflow (`.github/workflows/publish.yml`) that publishes to npm
  automatically when a semver tag is pushed to `main`, authenticating via npm's
  Trusted Publisher (OIDC) flow rather than a stored token. Refuses to publish if the
  tag isn't reachable from `main`, or doesn't match `package.json`'s version.

### Changed

- Stateful switches (`statefulSwitches: true`) now default to naming themselves
  `"<Light Name> Cycle <n>"` instead of `"<Light Name> Switch <n>"` — a settable,
  named `Switch` accessory reads too easily as an actual wall switch for the same
  light. Override any switch's name individually with `switchNames` if you'd rather
  call it something else.
- Filled in the real GitHub repository URLs in `package.json` (`homepage`,
  `repository`, `bugs`), replacing the placeholder left over from the project
  template.

## [1.0.5] - 2026-09-11

### Added

- `statefulSwitches` option: a light's switches can be exposed as ordinary settable
  HomeKit `Switch` services instead of read-only single-press buttons, so a scene,
  automation, or a tap in the Home app can turn a *specific* switch on directly and
  jump the rotation to it — the next time the light turns on, it fires the switch
  that follows the one you triggered.
- Each stateful switch lives in its own standalone accessory — one per switch — so
  the light stays a single, direct-tap tile in the Home app, and every switch has an
  unambiguous name of its own in Home's automation picker (a plain `Switch` service
  has no secondary naming characteristic, so switches sharing one accessory would
  otherwise all show up as indistinguishable "`<Light Name> Switches`").
- Stateful switches stay "on" for as long as the rotation is sitting on them, instead
  of pulsing back off a second after firing — exactly one switch per light is ever
  on, and every sibling turns off at the same moment. This keeps a Home scene that
  jumped the rotation reading back as staying "on", rather than reverting to "off"
  moments later. `resetCountOnOff` also clears every switch back off when it fires,
  since no step is "current" at that point.

### Fixed

- Turning on `statefulSwitches` (or shrinking `switchCount`) for an already-configured
  light sometimes left old switch services behind instead of fully cleaning them up:
  the cleanup code was removing services while iterating the same live list it was
  modifying, so only one of several stale switches would actually get removed.

### Docs

- Expanded the README with the HAP services/Apple Home UI reasoning behind the
  accessory-splitting design, a full options table, worked example automations
  (including "Jumping to a specific step"), and tips for managing the extra
  per-switch accessories: hiding individual switches from the Home View, or parking
  them in a dedicated empty room so it disappears from the tab bar entirely.

## [1.0.4] - 2026-09-09

### Changed

- The plugin no longer starts device discovery at all when nothing is configured and
  nothing needs cleaning up from a previous config — satisfies the Homebridge
  Verified plugin requirement that a plugin "must successfully install and not start
  unless it is configured."

## [1.0.3] - 2026-09-09

### Added

- Declared support for Node.js 24 and 26 (`engines.node`), verified via the npm
  registry that every build/lint dependency already supports both, and added a
  GitHub Actions build/lint matrix across Node 20/22/24/26 to verify it on every
  push.

### Docs

- Rewrote the README's introduction and rationale sections.

## [1.0.2] - 2026-09-09

### Changed

- Renamed the project from `homebridge-virtual-light-switches` /
  `VirtualLightSwitches` to `homebridge-cycle-light-switches` /
  `CycleLightSwitches`.

## [1.0.1] - 2026-09-09

### Fixed

- `npm install` failed with `EBADPLATFORM` on any non-macOS Homebridge host:
  `fsevents` (a macOS-only native dependency of `chokidar`, pulled in transitively by
  `nodemon`) had ended up listed directly under `dependencies`, making npm treat it
  as mandatory everywhere. Removed it — it's still available where needed as
  `chokidar`'s own optional dependency.

## [1.0.0] - 2026-09-09

### Added

- Initial release: configurable virtual on/off lights, each paired with a
  configurable number of virtual switches that fire in a round-robin sequence every
  time the light turns on, a `resetCountOnOff` option to restart the rotation when
  the light turns off, and a `turnOffOnCycleComplete` option to have the light turn
  itself back off as soon as a full rotation completes.
