<!-- COMMON.md: agent-agnostic loader content shared by CLAUDE.md/AGENTS.md
     (rules pointer + safety block) only. If this grows beyond a pointer plus
     safety-style boilerplate, that content belongs in RULES.md, not here. -->

## Rules
**All project doctrine lives in `RULES.md`. Read it before any work.**
It covers: Task Lifecycle, CHANGELOG Policy, Strict Rules, Branching Convention,
Spec / Decision / Verification, Doctrine Guard usage, the superharness cross-agent protocol.
New rules land in `RULES.md`, never here.

## Safety (verbatim, survives any skipped read)
- Never commit directly to `main`
- No hardcoded secrets or local paths in committed files
- Repo visibility is **public** by the owner's decision (fork of the public project `viorn/rossii`): everything committed is published, so keep audits, handoffs and private infrastructure names out of git
