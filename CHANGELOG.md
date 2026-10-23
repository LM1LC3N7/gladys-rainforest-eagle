# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Local reading of a Rainforest Eagle-200 (and Eagle-3, same local API, not
  verified) as the aioeagle library does: the `device_list` and
  `device_query` commands POSTed as XML to `/cgi-bin/post_manager`, with the
  Cloud ID and the install code as HTTP Basic credentials, one second apart,
  every 30 s by default (30 to 300 s). Read-only: nothing else is ever sent.
- One device per electricity meter, keyed by its hardware address: the net
  power (W, negative when sending to the grid), the consumption index for
  the energy monitoring, and the energy sent to the grid as a plain sensor
  (never counted as consumption).
- The consumption index goes through the guard of gladys-p1-monitor: never
  0, jumps and drops held (also across restarts) until the "Accept the held
  index" button is clicked twice.
- Never a read faster than the interval: not the test button, Discovery, a
  reconnection, a save of an unchanged configuration nor a restart (the last
  request is kept in `/data`, written at most once a minute). A read that
  ends after a restart or a new configuration publishes nothing.
- Refused credentials stop the reads for good, kept in `/data` (a salted
  fingerprint of the refused pair only, erased by the first success): only
  other credentials saved, or a click on "Test the connection", try again.
  HTTP 429 and 5xx of the device list pause the reads from 1 minute to 6
  hours; an error of one meter only leaves that meter out. A meter the Eagle
  no longer reaches publishes nothing.
- A small XML reader of our own: bounded (256 KiB, elements and depth),
  linear, no DOCTYPE nor entity expansion, no key of the answer as a property.
- "Test the connection" and "Accept the held index" buttons.
- Documentation in English and French; `LICENSE` (Apache-2.0) and
  `THIRD_PARTY_NOTICES.md` (aioeagle, Apache-2.0), shipped in the image.

[Unreleased]: https://github.com/LM1LC3N7/gladys-rainforest-eagle/commits/main
