# Changelog

- 2026: initial project scaffold
- 2026-11-20: `/theme` (six themes, saved), retrowave surfaces and section bands; `goose-tui web` browser surface over the ACP client; display name `goose-tui` (identifiers stay `rossii`); `bin/goose-tui` launcher; Esc never exits, `/exit` added; error journal (`src/journal.ts`): failures are written to the state directory with secrets redacted.
- 2026-11-20: specifications SPEC-002 to SPEC-005 (themes, browser surface, chat keys, launcher) and INV-4, each requirement bound to a test under `tests/`; `startWebServer` reports the bound host.
- 2026-11-20: `scripts/worktree-test.ts` no longer depends on the host: its fixture ignores machine-wide Git hooks and resolves the temp directory, so `bun run test` runs to the end on macOS.
- 2026-11-20: version 3.7.0-rc.1 (release candidate); `release.yml` publishes tags containing `-rc.` as prereleases so `rossii update` without `--pre` never picks them up.
- 2026-11-20: `release.yml` pins its three actions to commit SHAs (ShipGuard GHA-002).
- 2026-11-23: `build.sh` names the artifact after the host that compiled it (`uname`) instead of hardcoding `linux-x86_64`, refuses a host or architecture it has no mapping for, and runs the glibc loader/`NEEDED` gate only for Linux builds (it is an ELF rule, and macOS has no `readelf`); `.gitignore` covers `rossii-*-darwin-*` so the new artifact and its `.sha256` stay out of the repository, and declares the secret-protection entries ShipGuard SC-004 requires (`.env`, `*.key`, `*.pem`, `*.p12`, `*.pfx`), which blocked the commit that first touched the file.
