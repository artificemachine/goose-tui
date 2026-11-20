# RULES: goose-tui

Canonical doctrine for every agent working in this project. `SOUL.md`, `CLAUDE.md`,
and `AGENTS.md` are thin loaders that point here; new rules land in this file,
never in a loader.

## Task Lifecycle (Mandatory)

Every task must follow this exact sequence: **never skip a phase**:

```
todo → plan_proposed → plan_approved → in_progress → report_ready → [review] → done
```

### Phase Rules

1. **Plan first (TDD required):** Write a plan with a `tdd` block (red/green/refactor). Wait for approval before implementing.
2. **Only implement after approval:** Only proceed when the operator approves the plan.
3. **Report always:** After implementation, write a report summarising what was done and what the next session needs to know. Wait for review.
4. **Loop on review failure:** If review fails, revise the plan and re-submit.
5. **Never self-close:** Only the operator closes tasks.

## Cross-Agent Protocol (superharness)

- Do **not** offer to run tests or start work directly after showing contract status.
- Ask: "Want me to enqueue `<task-id>` for dispatch?"
- Only proceed after the operator confirms which task to dispatch.
- Read `.superharness/contract.yaml`, `failures.yaml`, and `decisions.yaml` before starting work.
- Read handoffs addressed to your agent name in `.superharness/handoffs/`.
- Keep task status, ledger, and handoff updated before stopping.
## CHANGELOG Policy (Strict)
- `CHANGELOG.md` is append-only.
- Never edit, reorder, or delete existing lines.
- Add new entries at EOF only.
- Before commit, verify no existing lines were modified.

## Strict Rules
- Never commit directly to `main`
- No hardcoded secrets or local paths in committed files
- Never hardcode absolute paths or usernames in committed code
- TDD required for any non-trivial code
- Repo visibility is **public by the owner's decision** (Max, 2026-11-20): this repository is a fork of the public MIT project `viorn/rossii`, so it is published as `artificemachine/goose-tui`. The line below declares it to the doctrine guard. Everything committed here is public: audit reports, handoffs, internal plans and anything naming private infrastructure stay out of git.

Repo visibility: public

- `AGENTS.md`, `CLAUDE.md`, `SOUL.md` are protected: never auto-modify during task execution
- **A name states its scope, not the mechanism that implements it.** `wake_muted` named one leg while it gated the entire per-identity cycle, so two documents described its scope wrongly. Name the intent (`processing_opt_out`) and leave the mechanism to the docstring. Applies to any name read outside its own module: config key, roster field, journal category, status value, CLI flag.
- CI/CD: one pipeline per commit, and a cache only with a stated key. The generated GitLab workflow accepts merge-request events and pushes to the default branch only; feature branches without an MR do not receive a push pipeline and must use an MR to run CI. On GitHub, set `concurrency` with `cancel-in-progress: true`. State each job's pipeline source rather than relying on the default. Cache dependency downloads keyed on the lockfile, never secrets and never what a gate judges: a stale cache is worse than a slow pipeline. Cache availability is measurement metadata only: report the lockfile key class and hit, miss or unavailable state, never cache contents or credentials; every dependency install remains unconditional.
- Cache measurement protocol: after merge, compare a cold miss and warm hit for each provider/manager pair with a trusted cache-prime path. Use the same effective dependencies, runner image, install command and cache policy; prime a fresh lockfile key on the trusted default branch, then rerun unchanged. Record trust context, duration and safe cache metadata. Mark pairs without a prime path unmeasurable; `unavailable` is an observation, never a gate result.
- CI cache trust boundary: a merge-request pipeline restores dependency download stores and never primes them; only a trusted default-branch push with required manifests and lockfiles primes the stores. In GitLab this is `cache: policy: pull` on the jobs merge requests run, plus a default-branch-only job whose `policy: pull-push` install fills the store. In GitHub this is a default-branch-only prime job with the same lockfile key and download-store path; caches saved by pull-request runs are invisible to the default branch by platform rule. A store holds dependency downloads only: never a virtualenv, never build outputs, coverage, tests or secrets, and a manager's cache is skipped when its lockfile is absent rather than keyed on an empty hash.
- **Install and uninstall ship together, and an installed copy never depends on the repo.** A project that produces something installed (a CLI, a service, a hook, a scheduled job, a package) documents and tests an `install` path and an `uninstall` path, and uninstall removes everything install created. The installed version is self-contained: it never imports from, reads, or runs files in the checkout, so deleting the clone, moving it, or switching its branch cannot change what runs. Install a built artifact pinned to a version or tag, never an editable link or a path into the working tree; an editable install is a development aid for the checkout only. A project that installs nothing says so in its README instead of shipping empty scripts.
- **All documents must be in English.** Docs, plans, decisions, audits, READMEs, changelog entries, commit messages, and code comments are written in English, whatever language the conversation uses. Existing documents in another language, and checksum-pinned imports, are left as they are unless the user asks to translate them.

## Branching Convention
```
main          ← protected
feat/<name>   ← new features
fix/<name>    ← bug fixes
chore/<name>  ← maintenance
```

## Versioning / Tag / Release
The manifest declares the version. A tag is optional; a release is a separate, optional decision that requires a matching tag.

branch -> PR (bump + CHANGELOG) -> merge to main -> [tag v<version>] -> [release] -> [publish]

- **Source of truth is the manifest**: `pyproject.toml` / `package.json` / `Cargo.toml`. Semver `MAJOR.MINOR.PATCH`. No other file declares the version.
- **Bump in the PR that introduces the change**: feat -> minor, fix/security/chore -> patch, BREAKING CHANGE -> major. The bump and the `CHANGELOG.md` line land in the same PR. A PR with no user-visible change needs no bump.
- **Tag only `main`, only after merge**: when selected, create an annotated tag `v<version>` on the merge commit, at most one final tag per manifest version; release candidates are covered by `Release Candidates and Tag Format` below. Never tag a feature branch. Tags never move: a wrong tag is fixed by a new patch version, not by re-tagging.
- **Release is separate from tagging**: a tag may remain without a release. When a release is selected, create a GitHub/GitLab release titled `v<version>` for the matching tag, with the `CHANGELOG.md` lines since the previous tag. A release without a matching tag is a defect.
- **Publish follows release**: if the project has a publish workflow, it runs from the release, never from a branch push. Absence of a publish workflow is a deliberate choice, not a gap to fill silently.
- **Invariant**: manifest version >= newest `v*` tag at all times. Manifest ahead of tag does not require a tag or release. Tag ahead of manifest is a defect. `tests/doctrine/doctrine-guard.sh` checks this.
- **Gates**: any agent may bump the manifest and append to `CHANGELOG.md` inside a PR. Creating a tag, a release, or triggering publish requires the operator's explicit confirmation in the current session; agents never do it unprompted.

## Release Candidates and Tag Format
- **Format:** `vMAJOR.MINOR.PATCH[-rc.N]`, always prefixed with `v`, annotated, on `main`.
- **Candidates:** a tested, unshipped build carries `-rc.N` for the next target version; `N` starts
  at 1. Candidates are exempt from any "one tag per version" limit.
- **Final:** a tag without suffix means shipped, and a `-rc.N` tag is never the baseline of the
  last shipped version. A final tag goes on the same commit as the last validated candidate,
  never on an unvalidated one.
- **Immutable:** a tag is never moved, deleted or reused; a mistake is fixed by the next candidate.

## Doctrine Tier
This project's tier decides what it owes beyond tests and the baseline invariants.
`ai-forge validate` reads the line below, so keep it exactly one word.

Tier: lib
Scaffold level: 1

- `lib`: a library or tool with no external contract. Tests plus the three baseline invariants in `INVARIANTS.md`.
- `service`: has an external contract (CLI, API, MCP tool, file format). `docs/SPEC.md` is required and kept current.
- `stateful`: owns data that can be corrupted (database, ledger, sync direction, money). Must list at least one invariant of its own in `INVARIANTS.md`, beyond the three baseline rows.

Raising the tier is a decision, not a formality: record it as an ADR, then add the
artifacts the new tier requires before the next commit.

## Spec / Decision / Verification
Rigor moves upstream, so the gates do too. Projects use `docs/SPEC.md`, `docs/adr/`, and
`docs/incidents/` to record the required artifacts.

- **Spec before code:** Do not implement while `docs/SPEC.md` has unresolved placeholder markers. The v1 guard uses an explicit common-source-extension allowlist; unsupported stacks require a project-specific check.
- **Downstream specification doctrine:** When ai-forge changes the generated specification, invariant, V&V model, or the guards that enforce it, assess the impact on `ground-truth-protocol` and `skills-canonical` before declaring the change complete. Record whether a downstream update, patch, or synchronization is required. Do not modify or synchronize either project automatically; follow that project's own plan, tests, and approval workflow.
- **Decisions before code:** Record architectural decisions as ADRs before implementation.
- **Independent RED:** Observe and record a failing test whose verifier is independent of its oracle before the fix.
- **Incident residue:** Record what happened, the fix, and the resolver knowledge that located the cause, including ruled-out hypotheses.
- **Adversarial gate:** Before remediation or ship, make one pass that argues against the current hypothesis.
- **Test the checkout:** Verify the artifact under test is the artifact changed. Python tests invoke the checkout with `sys.executable -m <package>` rather than a PATH-resolved project binary. The v1 guard checks same-line direct literal Python `subprocess` calls only; other stacks preserve checkout provenance but are not parser-enforced in v1.
- **Claims decay:** Generate or guard-check countable claims in durable docs, and propagate corrections everywhere the claim landed.
- **Guards need negative tests:** Every guard ships a negative test proving it can fail, plus a liveness check when it lives outside the repository.
- **Sandboxed tests:** Tests and hooks use synthetic, temporary environment state and never read or mutate live user configuration.

## Specification Traceability
When a project outgrows one file, `docs/SPEC.md` becomes the system index and individual
specifications live beside it.

- **Index:** `docs/SPEC.md` lists every specification as one row: its `SPEC-*` identifier, title, path under `docs/specs/`, and status. Every row's path resolves to an existing file.
- **Per-spec contract:** each `docs/specs/SPEC-<nnn>-<name>.md` states exactly one status (`draft`, `approved`, or `superseded`) and carries its requirements (`REQ-*`), its scoped invariants (`INV-*`), a Verification & Validation list binding every requirement and scoped invariant to a real test (`tests/<file>[::<test>]`), and review metadata: a `Last reviewed` date and the `Affected paths` the spec covers.
- **Unique identifiers:** `SPEC-*`, `REQ-*`, and `INV-*` identifiers are globally unique across the index and every spec file.
- **Superseded names its successor:** a `superseded` spec's index row names the `SPEC-*` that replaced it; traceability has no silent dead ends.
- **Owner/guard boundary:** the doctrine guard validates structure and evidence links only: index rows resolve, statuses are legal, bindings point at real tests, reviews are fresh. The guard never decides whether an owner approved the substance; promoting `draft` to `approved` is the owner's act, never the guard's or an agent's.
- **Downstream assessment:** when this model or the guards that enforce it change, assess the impact on `ground-truth-protocol` and `skills-canonical` per the Downstream specification doctrine rule; neither project is modified automatically.

## Change Delta and Archive
A change that alters an approved specification is recorded as a change directory beside the
specs, so the intent, the delta and the work stay together until the change is folded in.

- **Layout:** each change lives in `docs/changes/<YYYY-MM-DD>-<slug>/`, where the date is the day the change was opened.
- **Required files:** a change directory carries `CHANGE.md` (why and what), `DELTA.md` (what moves in the specification) and `TASKS.md` (the work that realizes it).
- **Delta names its specs:** `DELTA.md` names at least one `SPEC-nnn` that is listed in the `docs/SPEC.md` index, and states the status transition the change makes, such as `approved` to `superseded`.
- **Archive:** a finished change moves to `docs/changes/archive/<YYYY-MM-DD>-<slug>/` with its name unchanged.
- **Staleness:** an unarchived change whose date prefix is older than 30 days fails the guard. Archive it or open a fresh change.
- **Named by role:** files inside a change directory are named by role (`CHANGE.md`, `DELTA.md`, `TASKS.md`), not by the `docs/` filename-prefix convention in Documentation Layout.
- **Owner boundary:** folding a delta into an approved specification is the owner's act, never the guard's or an agent's.

## Failure Reporting
These three rules apply at every tier. They are stated as doctrine here, as fixed
constraints in `docs/SPEC.md`, and as the baseline rows `INV-1` to `INV-3` of
`INVARIANTS.md`, where each one binds to the test that guards it.

- **Persistent trace:** Every error leaves a persistent trace, with an explanation when one is known. No partial failure is ever reported as success.
- **Confirmed failures become issues:** Every confirmed bug, gap, invariant violation and persistent failure gets a written report in the repo and becomes a private issue on the project's tracker (GitLab, GitHub or OpenProject), deduplicated, labelled `AI-gen`.
- **No secret, ever:** No secret reaches a log or an issue. When the tracker is unreachable, write a local report and queue the publication rather than dropping it.

<!-- ai-forge:documentation-layout:v2:sha256=c8ba91ba287b35def909838634b3e8625223cb21ec148a911ecf90d0c3bbd841 -->
## Documentation Layout
Docs live under `docs/`. Place new files with recognized filename prefixes in
the matching subdirectory, creating that subdirectory when its first document
is needed:

- `docs/plans/`: iteration and rollout plans.
- `docs/audits/`: audit reports and findings.
- `docs/architecture/`: design docs and diagrams that don't belong in `docs/adr/`.
- `docs/guides/`: how-to and onboarding material for humans or agents.
- `docs/proposals/`: pre-decision proposals awaiting a verdict.
- `docs/registers/`: programme inventories, holding one row per open issue, defect document or
  readiness criterion, with its declared status, its blocker, and the plan and iteration that
  covers it.

Use `PLAN-` for `docs/plans/`, `AUDIT-` for `docs/audits/`, `ARCH-` or
`DESIGN-` for `docs/architecture/`, `GUIDE-` or `HOWTO-` for `docs/guides/`,
`PROPOSAL-` or `RFC-` for `docs/proposals/`, and `REGISTER-` for
`docs/registers/`. Keep required root files such as `docs/SPEC.md` and
established paths under `docs/adr/` and `docs/incidents/` in place.

A register is an inventory, not a plan. It never estimates effort, orders work or authorizes
anything: `aucune` / `none` is a frequent and honest answer to its coverage column, and a register
with no `none` row usually only looked at what a plan already claimed. Write it as
`REGISTER-<programme>-<date>.md`, refresh it from the live sources rather than editing rows in
place, and supersede an old one with a `Superseded-by:` line instead of rewriting it.

Its header carries one machine-readable line so a gate can read the snapshot without parsing
prose: `<!-- register-freshness: base=<rev> date=<YYYY-MM-DD> documents=<n> untracked=<n>
issues=<n> -->`. `tests/register/register-freshness.sh` compares those recorded facts against the
live tree and exits 0 fresh, 1 stale after printing the refreshing command, or 2 when it cannot
evaluate at all. The same script runs in `.gitlab-ci.yml` (where it blocks) and in
`.project-hooks/pre-commit` (where it warns, and blocks only a commit that touches what the
register enumerates).

This layout governs documents created after the convention lands in a project; it does not
require moving files already in `docs/`. Existing trees are grandfathered, the same way
`CHANGELOG.md` history is appended under a new rule rather than rewritten to match it.

New scaffolds start with an empty `.ai-forge/docs-layout-baseline.json`. For an existing
project, `ai-forge sync --apply` records misplaced prefixed documents already present when
the convention is adopted. `ai-forge docs --check` then rejects newly misplaced prefixed
documents while leaving those recorded paths grandfathered.

The scaffold ships none of these folders: `docs/.gitkeep` already covers the parent, and empty
folders a project never fills are clutter. Create each folder with its first matching document.
A project that wants every convention folder can run `ai-forge docs --apply`, which creates only
the missing folders and moves nothing. Auditing
without the flag (`ai-forge docs`) reports what is missing and which loose documents suggest a
folder, and writes nothing at all.
<!-- /ai-forge:documentation-layout -->

## Doctrine Guard usage
Run at any time: `bash tests/doctrine/doctrine-guard.sh`
Enforces: CHANGELOG append-only vs HEAD, no forbidden identifiers, required paths on disk, manifest version vs git tags, SPEC.md placeholder status, INVARIANTS.md bindings, and same-line direct Python test binary resolution.
Check names, as `--check <name>` takes them and `--list-checks` prints them: changelog, forbidden, paths, visibility, version, spec, invariants, traceability, changes, freshness, coverage, integrity, binary, summary.
Wired into `.project-hooks/pre-commit` (local) and `.github/workflows/ci.yml` (CI).
Add project-specific forbidden identifier patterns to `.doctrine-forbidden`.
