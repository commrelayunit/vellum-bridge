# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

History prior to 1.0.0 was not tracked in this file.

## [1.0.7] - 2026-08-24

### Changed

- Relicense the project under GNU GPL v3.0 or later.

## [1.0.6] - 2026-08-24

### Fixed

- Preserve the complete Vellum message context when starting bridge runs, so
  document-edit requests retain the live document instructions.
- Use dispatchable Vellum session keys and bind their runtime identities before
  the trusted `edit_document` policy is evaluated.
- Flush streamed tool-call frames through the gateway and reverse proxy, so
  Vellum receives each tool call without waiting for the request to close.

## [1.0.3] - 2026-08-24

### Fixed

- Preserve the bridge session identity by using OpenClaw's supported opaque
  session-key shape, so trusted document edits are not normalized into ordinary
  OpenAI sessions.

## [1.0.2] - 2026-08-24

### Fixed

- Add redacted session-correlation diagnostics for live bridge requests.

## [1.0.1] - 2026-08-24

### Fixed

- Bind OpenClaw's runtime-normalized session key to the authenticated bridge
  run, so trusted Vellum tool calls remain eligible for `edit_document`.

## [1.0.0] - 2026-08-24

### Added

- Public first release of the Vellum-to-OpenClaw live document-editing bridge.
- Transparent Vellum sessions over the OpenAI-compatible chat-completions route.
