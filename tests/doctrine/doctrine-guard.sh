#!/usr/bin/env bash
# 

# Doctrine guard: enforces this project's doctrine invariants (see RULES.md).
# Run: bash tests/doctrine/doctrine-guard.sh
# Run strict: bash tests/doctrine/doctrine-guard.sh --strict
# Run one check: bash tests/doctrine/doctrine-guard.sh --check <name>  (see --help)
# Exit 0: no check failed. Exit 1: a check failed, or (with --strict) a check
#         could not reach a verdict. Exit 2: unknown argument.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"

# ── Verdict bookkeeping ───────────────────────────────────────────────────────
# Every check resolves to exactly one of three states, counted per check:
#   pass        a verdict was reached, and it is clean
#   fail        a doctrine violation was found
#   unverified  the check could not reach a verdict (missing input, missing tool)
# Each check reads only its own counter (begin_check/fail/end_check below), so a
# failure in one check can no longer change what a later check reports.
PASSES=0
FAILURES=0
UNVERIFIED=0
FAILED_NAMES=""
UNVERIFIED_NAMES=""

# Figures the spec-health summary reads from the checks that computed them. A
# flag stays 0 when its check never reached a verdict, so the summary says null.
_HEALTH_STALE=""
_HEALTH_FRESHNESS_DONE=0
_HEALTH_TRACE_DONE=0
_HEALTH_REQ_BOUND=0
_HEALTH_INV_BOUND=0
_HEALTH_UNITS_DONE=0
_HEALTH_TOTAL_UNITS=0
_HEALTH_CLAIMED_UNITS=0
_HEALTH_BASELINE_DONE=0
_HEALTH_BASELINE_SIZE=0

# --strict turns an unverified check into a failure. Opt-in only: the pre-commit
# hook and CI call the guard with no argument and keep the tolerant default.
STRICT=0
WRITE_BASELINE=0
BASE_REF=""
CHECK_FILTER=""
_CHECK_NAMES="changelog forbidden paths visibility version spec invariants traceability changes freshness coverage integrity binary summary"

_usage() {
  cat <<USAGE
usage: doctrine-guard.sh [--strict] [--check <name>] [--list-checks] [--write-baseline] [--base <ref>] [--help]
  --strict          an unverified check fails the run
  --check <name>    run one check only; names: ${_CHECK_NAMES}
  --list-checks     print the check names, one per line, and exit (the capability line ai-forge validate reads)
  --write-baseline  write the unit baseline (coverage check only; it can only shrink)
  --base <ref>      measure the change against <ref> for the touch-it-claim-it rule
  --help            this text
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --strict) STRICT=1 ;;
    --write-baseline) WRITE_BASELINE=1 ;;
    --base)
      if [ "$#" -lt 2 ]; then
        echo "doctrine guard: --base needs a ref" >&2
        _usage >&2
        exit 2
      fi
      BASE_REF="$2"
      shift
      ;;
    --help | -h)
      _usage
      exit 0
      ;;
    --list-checks)
      for _name in $_CHECK_NAMES; do
        printf '%s\n' "$_name"
      done
      exit 0
      ;;
    --check)
      if [ "$#" -lt 2 ]; then
        echo "doctrine guard: --check needs a name" >&2
        _usage >&2
        exit 2
      fi
      CHECK_FILTER="$2"
      shift
      case " $_CHECK_NAMES " in
        *" $CHECK_FILTER "*) ;;
        *)
          echo "doctrine guard: unknown check: $CHECK_FILTER" >&2
          _usage >&2
          exit 2
          ;;
      esac
      ;;
    *)
      echo "doctrine guard: unknown argument: $1 (usage: doctrine-guard.sh [--strict] [--check <name>] [--help])" >&2
      exit 2
      ;;
  esac
  shift
done

if [ "$WRITE_BASELINE" -eq 1 ] && [ -n "$CHECK_FILTER" ] && [ "$CHECK_FILTER" != coverage ]; then
  echo "doctrine guard: --write-baseline only works with the coverage check (got --check $CHECK_FILTER)" >&2
  exit 2
fi

# True when no --check filter was given, or when the filter names this check.
_selected() { [ -z "$CHECK_FILTER" ] || [ "$CHECK_FILTER" = "$1" ]; }

# Doctrine files and the marker the spec-first checks look for.
_PLACEHOLDER='<!-- PLACEHOLDER -->'
_SPEC_REL="docs/SPEC.md"
_INVARIANTS_REL="INVARIANTS.md"
_CHANGES_REL="docs/changes"
# A change older than this many days, measured from the date prefix of its
# directory name to today, must be archived or replaced.
_CHANGE_STALE_DAYS=30
_CHANGE_NAME_RE='^([0-9]{4})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])-[a-z0-9]+(-[a-z0-9]+)*$'

# git-grep exclude list, shared across checks
_GREP_EXCLUDES=(
  ':(exclude).doctrine-forbidden'
  ':(exclude)tests/doctrine/*'
)

# ── Helpers ───────────────────────────────────────────────────────────────────

# begin_check opens a check: it prints the header and resets that check's
# counters. Every begin_check is paired with one end_check in the run-all block
# at the bottom, which is where the check's single verdict is recorded.
begin_check() {
  _CHECK_LABEL="$1"
  _CHECK_VERDICT=""
  _CHECK_FAILURES=0
  echo
  echo "check: $1"
}

# fail records a violation for the check in progress. A check may call it any
# number of times; end_check still records exactly one verdict.
fail() {
  echo "  [✗] $1"
  _CHECK_FAILURES=$((_CHECK_FAILURES + 1))
  _CHECK_VERDICT=fail
}

# ok records a clean verdict, but never erases a violation already recorded for
# this check: an "everything matched" line must not print over a match.
ok() {
  echo "  [✓] $1"
  [ -n "$_CHECK_VERDICT" ] || _CHECK_VERDICT=pass
}

# unverified records a check that could not reach a verdict — a missing input, a
# missing tool, a release still pending. It is not a failure unless --strict.
unverified() {
  echo "  [!] $1"
  [ "$_CHECK_VERDICT" = fail ] || _CHECK_VERDICT=unverified
}

# end_check records the verdict of the check that just ran. A check that reached
# no verdict at all is reported as unverified, never as a success.
end_check() {
  case "$_CHECK_VERDICT" in
    pass)
      PASSES=$((PASSES + 1))
      ;;
    fail)
      FAILURES=$((FAILURES + 1))
      FAILED_NAMES="${FAILED_NAMES}${_CHECK_LABEL}"$'\n'
      ;;
    *)
      UNVERIFIED=$((UNVERIFIED + 1))
      if [ "$_CHECK_VERDICT" = unverified ]; then
        UNVERIFIED_NAMES="${UNVERIFIED_NAMES}${_CHECK_LABEL}"$'\n'
      else
        UNVERIFIED_NAMES="${UNVERIFIED_NAMES}${_CHECK_LABEL} (reached no verdict)"$'\n'
      fi
      ;;
  esac
}

# ── 1. CHANGELOG.md is append-only vs HEAD ────────────────────────────────────

check_changelog_append_only() {
  begin_check "CHANGELOG.md append-only"

  if ! git -C "$REPO_ROOT" rev-parse HEAD >/dev/null 2>&1; then
    unverified "no HEAD yet: append-only check skipped (first commit)"
    return
  fi

  local committed working committed_len working_len
  committed="$(git -C "$REPO_ROOT" show HEAD:CHANGELOG.md 2>/dev/null || true)"
  working="$(cat "$REPO_ROOT/CHANGELOG.md" 2>/dev/null || true)"

  if [ -z "$committed" ]; then
    unverified "HEAD CHANGELOG.md is empty: append-only check skipped"
    return
  fi

  # Both vars have trailing newlines stripped by command substitution.
  # The working file must start with exactly the committed content.
  committed_len="${#committed}"
  working_len="${#working}"

  if [ "$working_len" -lt "$committed_len" ]; then
    fail "CHANGELOG.md is shorter than HEAD version; content was removed"
    return
  fi

  local working_prefix="${working:0:$committed_len}"
  if [ "$working_prefix" = "$committed" ]; then
    ok "CHANGELOG.md is append-only"
  else
    fail "CHANGELOG.md is not append-only: existing committed lines were modified or removed"
  fi
}

# ── 2. No forbidden identifiers in tracked files ──────────────────────────────

check_forbidden_identifiers() {
  begin_check "no forbidden identifiers in tracked files"

  local forbidden_file="$REPO_ROOT/.doctrine-forbidden"

  if [ ! -f "$forbidden_file" ]; then
    unverified ".doctrine-forbidden not found: identifier check skipped"
    return
  fi

  local pattern_count=0
  while IFS= read -r line || [ -n "$line" ]; do
    # Skip blank lines and comments
    [[ -z "$line" || "$line" == \#* ]] && continue
    pattern_count=$((pattern_count + 1))

    # Validate the regex via grep's own exit code (2 = syntax error). Portable
    # across GNU/BSD grep, unlike sniffing stderr text; their error wording differs.
    local grep_rc
    echo "" | grep -E -e "$line" >/dev/null 2>&1 && grep_rc=0 || grep_rc=$?
    if [ "$grep_rc" -eq 2 ]; then
      fail "malformed regex in .doctrine-forbidden: $line"
      continue
    fi

    # git grep exits 1 for "no match" and >1 for an error: an error is not a clean
    # result, so it must never fall through to the pass line below.
    local hits git_grep_rc=0
    hits="$(git -C "$REPO_ROOT" grep -nE -e "$line" -- . \
      "${_GREP_EXCLUDES[@]}" \
      2>/dev/null)" || git_grep_rc=$?
    if [ "$git_grep_rc" -gt 1 ]; then
      unverified "git grep failed (exit $git_grep_rc) while checking pattern '$line': identifier check cannot reach a verdict"
      continue
    fi

    if [ -n "$hits" ]; then
      fail "forbidden identifier pattern '$line' matched in tracked files:"
      printf '%s\n' "      ${hits//$'\n'/$'\n'      }"
    fi
  done < "$forbidden_file"

  if [ "$pattern_count" -eq 0 ]; then
    unverified ".doctrine-forbidden has no active patterns: identifier check skipped"
    return
  fi

  if [ "$_CHECK_FAILURES" -eq 0 ] && [ -z "$_CHECK_VERDICT" ]; then
    ok "no forbidden identifiers found ($pattern_count pattern(s) checked)"
  fi
}

# ── 3. Named doctrine paths resolve on disk ───────────────────────────────────

_regular_nonempty_file() {
  [ -f "$1" ] && [ ! -L "$1" ] && grep -q '[^[:space:]]' "$1"
}

_adjacent_agents_reaches_rules() {
  local claude="$REPO_ROOT/CLAUDE.md"
  local agents="$REPO_ROOT/AGENTS.md"
  local common="$REPO_ROOT/COMMON.md"
  local rules="$REPO_ROOT/RULES.md"

  _regular_nonempty_file "$claude" || return 1
  grep -Fxq "Read and follow \`AGENTS.md\` in this same directory." "$claude" || return 1
  _regular_nonempty_file "$agents" || return 1
  _regular_nonempty_file "$rules" || return 1
  grep -Fq "\`RULES.md\`" "$agents" && return 0
  grep -Fq "\`COMMON.md\`" "$agents" || return 1
  _regular_nonempty_file "$common" || return 1
  grep -Fq "\`RULES.md\`" "$common"
}

check_doctrine_paths() {
  begin_check "doctrine paths resolve on disk"

  local scaffold_level
  scaffold_level="$(grep -m1 -E '^Scaffold level: [0-4]$' "$REPO_ROOT/RULES.md" 2>/dev/null | sed -E 's/^Scaffold level: //' || true)"
  scaffold_level="${scaffold_level:-4}"

  local required=(
    "SOUL.md"
    "CLAUDE.md"
    "AGENTS.md"
    "RULES.md"
    "CHANGELOG.md"
    "README.md"
    "LICENSE"
    ".env.example"
    "tests/doctrine"
    "tests/doctrine/doctrine-guard.sh"
  )

  for path in "${required[@]}"; do
    if [ "$path" = ".env.example" ] && [ "$scaffold_level" -lt 2 ]; then
      continue
    fi
    if [ ! -e "$REPO_ROOT/$path" ]; then
      fail "required doctrine path missing: $path"
    fi
  done

  # A loader that exists but is empty, or points nowhere, loads no doctrine. The
  # scaffold's loaders name COMMON.md, which in turn names RULES.md.
  local loader loader_text
  for loader in CLAUDE.md AGENTS.md; do
    [ -f "$REPO_ROOT/$loader" ] || continue
    loader_text="$(cat "$REPO_ROOT/$loader")"
    if [ -z "${loader_text//[[:space:]]/}" ]; then
      fail "loader file $loader is empty"
    elif grep -qE 'RULES\.md|COMMON\.md' "$REPO_ROOT/$loader"; then
      :
    elif [ "$loader" = "CLAUDE.md" ] && _adjacent_agents_reaches_rules; then
      :
    else
      fail "loader file $loader does not point at RULES.md or COMMON.md"
    fi
  done

  if [ "$_CHECK_FAILURES" -eq 0 ]; then
    ok "all doctrine paths resolve on disk"
  fi
}

# ── 4. Repo visibility matches the private-by-default doctrine ───────────────

_visibility_github() {
  if ! command -v gh >/dev/null 2>&1; then
    unverified "gh CLI not installed: cannot verify GitHub remote visibility, verify manually"
    return
  fi

  # gh resolves the repository from its working directory, so run it from the repo.
  local is_private
  if ! is_private="$(cd "$REPO_ROOT" && gh repo view --json isPrivate -q .isPrivate 2>/dev/null)"; then
    unverified "gh repo view failed (not authenticated, or repo not found): verify manually"
    return
  fi

  if [ "$is_private" = "true" ]; then
    ok "GitHub remote is private"
  else
    fail "GitHub remote is PUBLIC: CLAUDE.md declares private-by-default; fix repo visibility or the doctrine before committing"
  fi
}

_visibility_gitlab_gs() {
  # A host name says nothing about reachability, and nothing here probes it.
  unverified "remote host name matches gitlab.gs but its visibility was not tested: CLAUDE.md declares private-by-default, verify manually"
}

_gitlab_project_path() {
  local remote_url="$1" project_path
  case "$remote_url" in
    *://*)
      project_path="${remote_url#*://}"
      project_path="${project_path#*/}"
      ;;
    *:*) project_path="${remote_url#*:}" ;;
    *) return 1 ;;
  esac

  project_path="${project_path%/}"
  project_path="${project_path%.git}"
  [ -n "$project_path" ] || return 1
  printf '%s\n' "$project_path"
}

_visibility_gitlab_api() {
  local remote_url="$1" api_host="$2" remote_label="$3"
  if ! command -v curl >/dev/null 2>&1 || [ -z "${GITLAB_TOKEN:-}" ]; then
    unverified "$remote_label remote found but no curl/GITLAB_TOKEN available: cannot verify visibility, verify manually"
    return
  fi

  case "$api_host" in
    https://*) ;;
    *)
      unverified "$remote_label API host is not an HTTPS URL: cannot verify visibility, verify manually"
      return
      ;;
  esac

  local project_path visibility
  if ! project_path="$(_gitlab_project_path "$remote_url")"; then
    unverified "$remote_label remote has no usable project path: cannot verify visibility, verify manually"
    return
  fi

  # The token goes to curl on stdin as a config line: argv is visible to `ps`.
  # The timeouts keep a pre-commit hook from hanging on an unreachable host.
  visibility="$( line='header = "PRIVATE-TOKEN: '; line+="$GITLAB_TOKEN"; line+='"'; printf '%s\n' "$line" \
    | curl -s --config - --connect-timeout 5 --max-time 15 \
      "${api_host%/}/api/v4/projects/$(printf '%s' "$project_path" | sed 's#/#%2F#g')" \
    | grep -o '"visibility":"[a-z]*"' | cut -d'"' -f4 || true)"

  if [ "$visibility" = "private" ]; then
    ok "$remote_label remote is private"
  elif [ -n "$visibility" ]; then
    fail "$remote_label remote visibility is '$visibility', not private: CLAUDE.md declares private-by-default; fix repo visibility or the doctrine before committing"
  else
    unverified "could not determine $remote_label remote visibility: verify manually"
  fi
}

_visibility_gitlab_com() {
  _visibility_gitlab_api "$1" "https://gitlab.com" "gitlab.com"
}

_visibility_self_hosted_gitlab() {
  local remote_url="$1"
  if [ -z "${GITLAB_SSH_ALIAS:-}" ]; then
    unverified "remote host not recognized (github.com/gitlab.com/gitlab.gs); cannot verify visibility automatically, verify manually: $(_remote_url_without_credentials "$remote_url")"
    return
  fi

  case "$remote_url" in
    "git@${GITLAB_SSH_ALIAS}":*) ;;
    *)
      unverified "remote host not recognized (github.com/gitlab.com/gitlab.gs); cannot verify visibility automatically, verify manually: $(_remote_url_without_credentials "$remote_url")"
      return
      ;;
  esac

  if [ -z "${GITLAB_HOST:-}" ]; then
    unverified "self-hosted GitLab SSH alias matches GITLAB_SSH_ALIAS but GITLAB_HOST is unset: cannot verify visibility, verify manually"
    return
  fi

  _visibility_gitlab_api "$remote_url" "$GITLAB_HOST" "self-hosted GitLab"
}

# A remote URL can carry credentials (a CI job token, a personal token), and the
# unverified messages below name the remote, so they print it through this filter.
# The authority's userinfo is everything before its last "@"; the path is kept
# as is, because a path may legitimately contain "@".
_remote_url_without_credentials() {
  local url="$1" scheme rest authority
  case "$url" in
    *://*)
      scheme="${url%%://*}"
      rest="${url#*://}"
      authority="${rest%%/*}"
      printf '%s\n' "${scheme}://${authority##*@}${rest#"$authority"}"
      ;;
    *) printf '%s\n' "$url" ;;
  esac
}

# GitLab CI reports the project's visibility in a predefined variable, which is the
# only evidence available to a CI job: its remote is an https URL carrying a job
# token, so neither the ssh-alias route nor a personal token can apply there.
# Advisory, not a security boundary: a maintainer can set the variable. Only the
# exact value "private" passes; anything else unrecognised falls through unverified.
_visibility_gitlab_ci_variable() {
  [ "${GITLAB_CI:-}" = "true" ] || return 1

  case "${CI_PROJECT_VISIBILITY:-}" in
    private)
      ok "GitLab CI remote is private (CI_PROJECT_VISIBILITY; advisory check, not a security boundary)"
      ;;
    public | internal)
      fail "GitLab CI remote visibility is '${CI_PROJECT_VISIBILITY}', not private: CLAUDE.md declares private-by-default; fix repo visibility or the doctrine before committing"
      ;;
    *) return 1 ;;
  esac
  return 0
}

check_repo_visibility() {
  begin_check "repo visibility matches private-by-default doctrine"

  # A fork of a public project cannot be private. The owner declares that once,
  # in RULES.md, on a line of its own; without the line the default stays private.
  if grep -qE '^Repo visibility: public$' "$REPO_ROOT/RULES.md" 2>/dev/null; then
    ok "repo is declared public by the owner (RULES.md: Repo visibility: public)"
    return
  fi

  _visibility_gitlab_ci_variable && return

  local remote_url
  remote_url="$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null || true)"

  case "$remote_url" in
    "")
      unverified "no remote configured yet: visibility check skipped"
      ;;
    *github.com*) _visibility_github ;;
    *gitlab.gs*) _visibility_gitlab_gs ;;
    *gitlab.com*) _visibility_gitlab_com "$remote_url" ;;
    git@*:*) _visibility_self_hosted_gitlab "$remote_url" ;;
    *)
      unverified "remote host not recognized (github.com/gitlab.com/gitlab.gs); cannot verify visibility automatically, verify manually: $(_remote_url_without_credentials "$remote_url")"
      ;;
  esac
}

# ── 5. Manifest version vs git tags ───────────────────────────────────────────

_manifest_file() {
  # Detect the manifest, first hit wins: pyproject.toml, package.json, Cargo.toml.
  # Echoes the path, or nothing when the project declares no manifest at all.
  local name
  for name in pyproject.toml package.json Cargo.toml; do
    if [ -f "$REPO_ROOT/$name" ]; then
      echo "$REPO_ROOT/$name"
      return 0
    fi
  done
  return 0
}

_manifest_version() {
  # Echoes the plain MAJOR.MINOR.PATCH version the manifest declares. Echoes
  # nothing when there is no manifest, or when the manifest declares no such
  # version (a dynamic version, or a prerelease like 1.2.3-rc1). The caller
  # distinguishes those two cases via _manifest_file.
  local manifest_file line raw
  manifest_file="$(_manifest_file)"
  [ -n "$manifest_file" ] || return 0

  case "$(basename "$manifest_file")" in
    package.json) line="$(grep -m1 -E '^[[:space:]]*"version":' "$manifest_file" || true)" ;;
    *)            line="$(grep -m1 -E '^version = "' "$manifest_file" || true)" ;;
  esac
  [ -n "$line" ] || return 0

  raw="$(echo "$line" | sed -E 's/.*"([0-9]+\.[0-9]+\.[0-9]+)".*/\1/')"
  echo "$raw"
  return 0
}

check_version_tag_consistency() {
  begin_check "manifest version vs git tags"

  local manifest_file manifest
  manifest_file="$(_manifest_file)"
  manifest="$(_manifest_version)"

  if [ -z "$manifest_file" ]; then
    unverified "no manifest (pyproject.toml/package.json/Cargo.toml): version/tag check skipped"
    return 0
  fi

  if [ -z "$manifest" ] || ! [[ "$manifest" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    unverified "$(basename "$manifest_file") declares no plain MAJOR.MINOR.PATCH version (dynamic or prerelease): version/tag check skipped"
    return 0
  fi

  local tag_ver
  tag_ver="$(git -C "$REPO_ROOT" tag -l 'v*' | sed 's/^v//' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1 || true)"

  if [ -z "$tag_ver" ]; then
    unverified "no v* tags yet: version/tag check skipped"
    return 0
  fi

  local highest
  highest="$(printf '%s\n%s\n' "$manifest" "$tag_ver" | sort -V | tail -1)"

  if [ "$tag_ver" = "$manifest" ]; then
    ok "manifest $manifest matches newest tag v$tag_ver"
  elif [ "$highest" = "$manifest" ]; then
    unverified "manifest $manifest is ahead of newest tag v$tag_ver: tag optional; no release implied"
  else
    fail "tag v$tag_ver is ahead of manifest $manifest: bump the manifest or remove the stray tag"
  fi
}

# .doctrine-source-paths declares implementation that no source extension gives
# away (deploy.yml, main.tf, a config-only project): one git pathspec per line,
# blank lines and # comments ignored.
_declared_source_paths() {
  local file="$REPO_ROOT/.doctrine-source-paths" line
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    printf '%s\n' "$line"
  done < "$file"
}

_tracked_source_files() {
  local declared=() line
  while IFS= read -r line; do
    declared+=("$line")
  done < <(_declared_source_paths)

  git -C "$REPO_ROOT" ls-files -- \
    '*.py' '*.pyi' '*.js' '*.jsx' '*.mjs' '*.cjs' '*.ts' '*.tsx' '*.rs' '*.go' '*.sh' \
    '*.java' '*.c' '*.cc' '*.cpp' '*.cxx' '*.h' '*.hpp' '*.rb' '*.php' '*.kt' '*.kts' \
    '*.swift' '*.vue' '*.svelte' \
    ${declared[@]+"${declared[@]}"} \
    "${_GREP_EXCLUDES[@]}" \
    ':(exclude)tests/**' ':(exclude)docs/**' ':(exclude)scripts/ci/**'
}

# "No source yet" is only a verdict when the project declared what source means.
# Without a declaration an empty extension match cannot tell a real scaffold from
# a project whose implementation is YAML, Terraform or JSON.
_no_source_verdict() {
  local phase="$1"
  if [ -n "$(_declared_source_paths)" ]; then
    ok "$phase: no source yet (nothing matches the paths in .doctrine-source-paths)"
  else
    unverified "$phase: no source found by extension and no .doctrine-source-paths declared, cannot tell whether an implementation exists"
  fi
}

# An instruction sentence the template puts above each marker. Deleting the marker
# leaves it behind, so it is never counted as content the author wrote.
_SPEC_TEMPLATE_SENTENCES=(
  "Describe the user problem this change solves."
  "State what this change includes and excludes."
  "Record technical, operational, security, and delivery constraints."
  "List the observable conditions that prove the work is complete."
)
_SPEC_FILL_SECTIONS=(Problem Scope Constraints Acceptance)

# Prints one line per unresolved part of the spec: a marker still present, or a
# section to be filled in that carries nothing beyond the template sentence.
_spec_unresolved_reasons() {
  local spec_file="$1" line section="" section_label="" has_body=0 reported=0 name sentence is_template

  _spec_flush_section() {
    if [ "$reported" -eq 0 ] && [ "$has_body" -eq 0 ] && [ -n "$section" ]; then
      for name in "${_SPEC_FILL_SECTIONS[@]}"; do
        [ "$name" = "$section" ] && echo "section '$section' has no content beyond the template sentence"
      done
    fi
  }

  while IFS= read -r line || [ -n "$line" ]; do
    if [[ "$line" == "## "* ]]; then
      _spec_flush_section
      section="${line#\#\# }"
      has_body=0
      reported=0
      continue
    fi
    [[ -z "${line//[[:space:]]/}" ]] && continue
    if [ "$line" = "$_PLACEHOLDER" ]; then
      section_label=""
      if [ -n "$section" ]; then section_label=" in section '$section'"; fi
      echo "placeholder marker still present${section_label}"
      reported=1
      continue
    fi
    is_template=0
    for sentence in "${_SPEC_TEMPLATE_SENTENCES[@]}"; do
      [ "$line" = "$sentence" ] && is_template=1
    done
    [ "$is_template" -eq 1 ] || has_body=1
  done < "$spec_file"
  _spec_flush_section
}

check_spec_placeholders() {
  begin_check "SPEC.md placeholders"

  local spec_file="$REPO_ROOT/$_SPEC_REL"
  if [ ! -f "$spec_file" ]; then
    unverified "no SPEC.md: spec check skipped"
    return 0
  fi

  if [ -z "$(_spec_unresolved_reasons "$spec_file")" ]; then
    ok "spec is resolved"
    return 0
  fi

  local source_files
  source_files="$(_tracked_source_files)"

  if [ -z "$source_files" ]; then
    _no_source_verdict "spec-first"
    return 0
  fi

  fail "$_SPEC_REL has unresolved placeholder while tracked source files exist"
  _spec_unresolved_reasons "$spec_file" | sed 's/^/      /'
}

# Resolves a `tests/<file>[::[<Class>::]<node>[[<param>]]]` binding against the
# repository: the file must exist and every named segment must be found in it.
# Prints one line per problem ("names missing test file: ..."), nothing when the
# binding resolves. _binding_target_resolves turns each line into a fail named
# after the binding's owner, so the registry and the scoped spec V&V rows cannot
# drift apart; the claim classification asks the same question without failing.
_binding_problems() {
  local binding="$1" test_file
  test_file="${binding%%::*}"
  if [ ! -f "$REPO_ROOT/$test_file" ]; then
    echo "names missing test file: $test_file"
    return 0
  fi

  if [[ "$binding" == *"::"* ]]; then
    # tests/f.py::[Class::]test_name[[param]]: every named segment must exist in
    # the file. A parametrize id is a runtime suffix, so it is not searched for.
    local node="${binding#*::}" segment
    node="${node%%\[*}"
    local -a segments
    IFS=: read -r -a segments <<< "${node//::/:}"
    local last=$(( ${#segments[@]} - 1 )) idx=0
    for segment in "${segments[@]}"; do
      if [ "$idx" -lt "$last" ]; then
        grep -qE "class[ ]+$segment\\b" "$REPO_ROOT/$test_file" || echo "names missing test class: $segment"
      else
        grep -qE "(def|fn|func|it|test)[ (]+['\"]?$segment\\b" "$REPO_ROOT/$test_file" || echo "names missing test function: $segment"
      fi
      idx=$((idx + 1))
    done
  fi
}

# Records one fail per problem _binding_problems finds, named after the owner.
_binding_target_resolves() {
  local owner_id="$1" binding="$2" problem
  while IFS= read -r problem; do
    if [ -n "$problem" ]; then
      fail "$owner_id $problem"
    fi
  done < <(_binding_problems "$binding")
}

check_invariants_bound() {
  begin_check "INVARIANTS.md bindings"

  local inv_file="$REPO_ROOT/$_INVARIANTS_REL"
  if [ ! -f "$inv_file" ]; then
    unverified "no INVARIANTS.md: invariants check skipped"
    return 0
  fi

  local source_files line binding inv_id invariant_count=0
  source_files="$(_tracked_source_files)"

  while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" == "- [INV-"* ]] || continue
    invariant_count=$((invariant_count + 1))

    if ! grep -Eq '^- \[INV-[0-9]+\] .+ -> (<!-- PLACEHOLDER -->|tests/[^: []+(::[A-Za-z_][A-Za-z0-9_]*)*(\[[^] ]*\])?)$' <<< "$line"; then
      fail "malformed invariant line: $line"
      continue
    fi

    inv_id="$(printf '%s\n' "$line" | sed -E 's/^- \[(INV-[0-9]+)\].*/\1/')"
    binding="${line##* -> }"
    if [ "$binding" = "$_PLACEHOLDER" ]; then
      if [ -n "$source_files" ]; then
        fail "$inv_id still bound to a placeholder while tracked source files exist"
      fi
      continue
    fi

    _binding_target_resolves "$inv_id" "$binding"
  done < "$inv_file"

  if [ "$invariant_count" -eq 0 ]; then
    fail "INVARIANTS.md lists no invariant"
  elif [ "$_CHECK_FAILURES" -eq 0 ]; then
    if [ -z "$source_files" ]; then
      _no_source_verdict "invariants-first"
    else
      ok "invariants are bound"
    fi
  fi
}

# ── 5b. Spec index and status integrity ──────────────────────────────────────

# The multi-spec contract (docs/SPEC.md index + docs/specs/SPEC-*.md) is
# opt-in: a project opts in with its first "- [SPEC-" index row or by shipping
# a docs/specs/ directory. Projects without either are not judged here.
_traceability_opted_in() {
  grep -q '^- \[SPEC-' "$REPO_ROOT/docs/SPEC.md" 2>/dev/null && return 0
  [ -d "$REPO_ROOT/docs/specs" ]
}

# Prints "id|path|status|successor" for a well-formed index row; returns 1 for
# a line that opens like an index row but does not parse (the caller decides
# whether that is an unknown status or a malformed row) and for non-row lines.
_spec_index_row_fields() {
  local line="$1"
  [[ "$line" == "- [SPEC-"* ]] || return 1
  printf '%s\n' "$line" \
    | grep -E '^- \[SPEC-[0-9]+\] .+ \(docs/specs/[^)]+\.md\) status: (draft|approved|superseded)( -> SPEC-[0-9]+)?$' >/dev/null || return 1
  printf '%s\n' "$line" \
    | sed -E 's#^- \[(SPEC-[0-9]+)\] .+\((docs/specs/[^)]+\.md)\) status: (draft|approved|superseded)( -> SPEC-[0-9]+)?$#\1|\2|\3|\4#'
}

# The raw value of a spec file's `Affected paths:` line ("" when absent). One
# reader for check_traceability, check_spec_freshness and check_spec_coverage.
_affected_paths_of() {
  local line
  line="$(grep -m1 '^Affected paths: ' "$1" || true)"
  printf '%s\n' "${line#Affected paths: }"
}

check_traceability() {
  begin_check "spec index and status integrity"

  local spec_index="$REPO_ROOT/docs/SPEC.md"
  if [ ! -f "$spec_index" ]; then
    unverified "no SPEC.md: traceability check skipped"
    return 0
  fi

  if ! _traceability_opted_in; then
    ok "multi-spec traceability not opted in (no index rows, no docs/specs/)"
    return 0
  fi

  local source_files line fields id path status successor all_ids=""
  local row_count=0 draft_unresolved=0 _status_word sid successors_rows=""
  local active_rows="" all_req_ids="" all_inv_ids=""
  source_files="$(_tracked_source_files)"

  while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" == "- [SPEC-"* ]] || continue
    row_count=$((row_count + 1))

    if ! fields="$(_spec_index_row_fields "$line")"; then
      _status_word="$(printf '%s\n' "$line" | sed -E 's#^.* status: ([A-Za-z-]+).*$#\1#')"
      case "$_status_word" in
        draft|approved|superseded)
          fail "malformed spec index row: $line"
          ;;
        *)
          fail "unknown spec status '$_status_word' in index row: $line"
          ;;
      esac
      continue
    fi

    IFS='|' read -r id path status successor <<< "$fields"

    case "$status" in
      draft|approved) active_rows+="${id}|${path}|${status}"$'\n' ;;
    esac

    if grep -qx "$id" <<< "$all_ids"; then
      fail "duplicate spec id in index: $id"
      continue
    fi
    all_ids="${all_ids}${id}"$'\n'

    if [ ! -f "$REPO_ROOT/$path" ]; then
      fail "$id names missing spec file: $path"
      continue
    fi

    case "$status" in
      approved)
        if grep -qF -- "$_PLACEHOLDER" "$REPO_ROOT/$path"; then
          fail "approved spec still contains placeholder markers: $id"
        fi
        ;;
      draft)
        if grep -qF -- "$_PLACEHOLDER" "$REPO_ROOT/$path"; then
          draft_unresolved=1
        fi
        ;;
      superseded)
        if [ -z "$successor" ]; then
          fail "$id is superseded but names no successor (-> SPEC-nnn): traceability would end in a dead end"
        else
          successors_rows+="${successor# -> }"$'\n'
        fi
        ;;
    esac
  done < "$spec_index"

  if [ "$row_count" -eq 0 ]; then
    fail "docs/specs/ exists but docs/SPEC.md lists no specification index rows"
  fi

  for sid in $(grep -x '.*' <<< "$successors_rows" || true); do
    if ! grep -qx "$sid" <<< "$all_ids"; then
      fail "index names a successor that is not an index row: $sid"
    fi
  done

  if [ "$draft_unresolved" -eq 1 ]; then
    if [ -n "$source_files" ]; then
      fail "draft spec keeps placeholder rows while tracked source files exist"
    else
      _no_source_verdict "traceability-first"
    fi
  fi

  # ── Active-spec sweep: V&V bindings, scoped invariants, review freshness ──
  # Active specs (draft|approved) bind every REQ-*/INV-* row to a V&V target
  # that resolves, carry review metadata, and stay reviewed after the last
  # change to each declared tracked path. Superseded specs are excluded: their
  # index rows already name a successor. Placeholder bindings stay tolerated
  # only while no tracked source exists, the same rule as the registry.
  local active_row spec_file spec_line reviewed affected declared_reqs=""
  local declared_invs="" seen_vv="" rid rbinding vv_line need_id declared_path
  local last_commit affected_list failures_before
  while IFS= read -r active_row || [ -n "$active_row" ]; do
    [ -n "$active_row" ] || continue
    IFS='|' read -r id path status <<< "$active_row"
    spec_file="$REPO_ROOT/$path"
    declared_reqs=""
    declared_invs=""
    seen_vv=""
    if [ ! -f "$spec_file" ]; then
      continue # already reported as a missing spec file above
    fi

    reviewed="$(grep -m1 '^Last reviewed: ' "$spec_file")"
    reviewed="${reviewed#Last reviewed: }"
    if [ -z "$reviewed" ] || ! grep -Eqx '[0-9]{4}-[0-9]{2}-[0-9]{2}' <<< "$reviewed"; then
      fail "$id is missing a well-formed 'Last reviewed: YYYY-MM-DD' metadata line"
      reviewed=""
    fi
    affected="$(_affected_paths_of "$spec_file")"
    if [ -z "$affected" ]; then
      fail "$id is missing the 'Affected paths:' metadata line"
    fi

    while IFS= read -r spec_line || [ -n "$spec_line" ]; do
      case "$spec_line" in
        "- [REQ-"*)
          rid="$(printf '%s\n' "$spec_line" | sed -E 's/^- \[(REQ-[0-9]+)\].*/\1/')"
          if grep -qx "$rid" <<< "$all_req_ids"; then
            fail "duplicate requirement id across active specs: $rid"
          else
            all_req_ids="${all_req_ids}${rid}"$'\n'
          fi
          declared_reqs="${declared_reqs}${rid}"$'\n'
          ;;
        "- [INV-"*)
          rid="$(printf '%s\n' "$spec_line" | sed -E 's/^- \[(INV-[0-9]+)\].*/\1/')"
          if grep -qx "$rid" <<< "$all_inv_ids"; then
            fail "duplicate scoped invariant id across active specs: $rid"
          else
            all_inv_ids="${all_inv_ids}${rid}"$'\n'
          fi
          declared_invs="${declared_invs}${rid}"$'\n'
          ;;
        "- REQ-"*|"- INV-"*)
          vv_line="$spec_line"
          if ! grep -Eq '^- (REQ|INV)-[0-9]+ -> (<!-- PLACEHOLDER -->|tests/[^: []+(::[A-Za-z_][A-Za-z0-9_]*)*(\[[^] ]*\])?)$' <<< "$vv_line"; then
            fail "malformed V&V binding row: $vv_line"
            continue
          fi
          rid="$(printf '%s\n' "$vv_line" | sed -E 's/^- ((REQ|INV)-[0-9]+) -> .*/\1/')"
          seen_vv="${seen_vv}${rid}"$'\n'
          rbinding="${vv_line#* -> }"
          if [ "$rbinding" = "$_PLACEHOLDER" ]; then
            if [ -n "$source_files" ]; then
              fail "$rid still bound to a placeholder while tracked source files exist"
            fi
            continue
          fi
          failures_before="$_CHECK_FAILURES"
          _binding_target_resolves "$rid" "$rbinding"
          if [ "$_CHECK_FAILURES" -eq "$failures_before" ]; then
            case "$rid" in
              REQ-*) _HEALTH_REQ_BOUND=$((_HEALTH_REQ_BOUND + 1)) ;;
              INV-*) _HEALTH_INV_BOUND=$((_HEALTH_INV_BOUND + 1)) ;;
            esac
          fi
          ;;
      esac
    done < "$spec_file"

    for need_id in $declared_reqs $declared_invs; do
      if ! grep -qx "$need_id" <<< "$seen_vv"; then
        if [ "$status" = approved ] || [ -n "$source_files" ]; then
          fail "$need_id has no V&V binding row"
        fi
      fi
    done

    if [ -n "$reviewed" ] && [ -n "$affected" ] && [ "$affected" != "none" ]; then
      affected_list="${affected//, /$'\n'}"
      while IFS= read -r declared_path || [ -n "$declared_path" ]; do
        [ -n "$declared_path" ] || continue
        if git -C "$REPO_ROOT" ls-files --error-unmatch -- "$declared_path" >/dev/null 2>&1; then
          last_commit="$(git -C "$REPO_ROOT" log -1 --format=%cs -- "$declared_path" || true)"
          # A staged change is not in the history yet, and CI will judge its commit by
          # the date that commit carries. Judge it the same way here, or a pre-commit
          # run passes a commit the pipeline then rejects.
          change_origin=""
          if [ -n "$(git -C "$REPO_ROOT" diff --cached --name-only -- "$declared_path" 2>/dev/null)" ]; then
            staged_date="$(date +%F)"
            if [[ "$staged_date" > "$last_commit" ]]; then
              last_commit="$staged_date"
              change_origin=", staged"
            fi
          fi
          if [ -z "$last_commit" ]; then
            unverified "$id: no Git history for declared path $declared_path, review freshness unknown"
          elif [ -z "$change_origin" ] \
            && [ "$(git -C "$REPO_ROOT" rev-parse --is-shallow-repository 2>/dev/null || true)" = true ] \
            && grep -qx "$(git -C "$REPO_ROOT" log -1 --format=%H -- "$declared_path" || true)" \
              <<< "$(git -C "$REPO_ROOT" rev-list --max-parents=0 HEAD 2>/dev/null || true)"; then
            # A shallow clone's oldest commit seems to add every path, so its date is
            # not the path's last change: CI's default clone depth made a spec reviewed
            # after the real change fail there and pass in a full clone.
            unverified "$id: shallow clone, last change to declared path $declared_path unknown, review freshness unknown"
          elif [[ "$last_commit" > "$reviewed" ]]; then
            fail "$id review ($reviewed) predates last change to declared path $declared_path ($last_commit$change_origin)"
          fi
        else
          unverified "$id declares untracked path $declared_path, review freshness unknown"
        fi
      done <<< "$affected_list"
    fi
  done <<< "$active_rows"
  _HEALTH_TRACE_DONE=1

  if [ "$_CHECK_FAILURES" -eq 0 ] && [ -z "$_CHECK_VERDICT" ]; then
    ok "spec index and statuses are consistent ($row_count row(s))"
  fi
}

# Newest commit touching the given paths, skipping commits listed in
# .git-blame-ignore-revs (formatting-only history). Prints the full hash, or
# nothing when the paths have no usable history.
_last_commit_touching() {
  local ignore_file="$REPO_ROOT/.git-blame-ignore-revs" ignored="" commit
  if [ -f "$ignore_file" ]; then
    ignored="$(grep -Eo '^[0-9a-fA-F]{40}' "$ignore_file" | tr 'A-F' 'a-f' || true)"
  fi
  while IFS= read -r commit; do
    [ -n "$commit" ] || continue
    if grep -qx "$commit" <<< "$ignored"; then
      continue
    fi
    printf '%s\n' "$commit"
    return 0
  done < <(git -C "$REPO_ROOT" log --format=%H -- "$@" 2>/dev/null || true)
  return 0
}

# Claims come from two sources (coordination contract, clause 2): the
# `Affected paths:` line of an active spec, and the rows of
# docs/registry/units.md. A claim is fresh when the newest commit touching each
# of its paths is the anchor's own last commit or one of its ancestors. Ancestry,
# never dates: a commit date can be rewritten, a parent link cannot. Warning
# level only: a stale claim is reported as unverified, the date-based review
# check in check_traceability keeps its own verdict.
_UNITS_REL="docs/registry/units.md"
_UNITS_HEADER='| Paths | Requirements |'

# Report each tracked path of a comma-separated claim that changed after the anchor.
# Arguments: label, anchor commit, anchor label, comma-separated paths.
_report_stale_claim_paths() {
  local label="$1" anchor="$2" anchor_label="$3" declared_path path_commit
  while IFS= read -r declared_path || [ -n "$declared_path" ]; do
    declared_path="$(printf '%s' "$declared_path" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
    [ -n "$declared_path" ] || continue
    if ! git -C "$REPO_ROOT" ls-files --error-unmatch -- "$declared_path" >/dev/null 2>&1; then
      unverified "$label declares untracked path $declared_path, freshness unknown"
      continue
    fi
    path_commit="$(_last_commit_touching "$declared_path")"
    if [ -z "$path_commit" ] || [ "$path_commit" = "$anchor" ]; then
      continue
    fi
    if ! git -C "$REPO_ROOT" merge-base --is-ancestor "$path_commit" "$anchor" 2>/dev/null; then
      _HEALTH_STALE+="${label}${_FIELD_SEP}${declared_path}${_FIELD_SEP}${path_commit}"$'\n'
      unverified "$label claims $declared_path, which changed in commit $(git -C "$REPO_ROOT" rev-parse --short "$path_commit") after $anchor_label $(git -C "$REPO_ROOT" rev-parse --short "$anchor")"
    fi
  done <<< "${4//,/$'\n'}"
}

# Active specs: the anchor is each spec file's own last commit.
_spec_claims_freshness() {
  local spec_index="$REPO_ROOT/docs/SPEC.md" line fields id path status affected spec_commit
  while IFS= read -r line || [ -n "$line" ]; do
    fields="$(_spec_index_row_fields "$line")" || continue
    IFS='|' read -r id path status _ <<< "$fields"
    case "$status" in
      draft|approved) ;;
      *) continue ;;
    esac
    [ -f "$REPO_ROOT/$path" ] || continue # reported as a missing spec file by check_traceability

    affected="$(_affected_paths_of "$REPO_ROOT/$path")"
    if [ -z "$affected" ] || [ "$affected" = "none" ]; then
      continue
    fi
    _FRESHNESS_CLAIMS=$((_FRESHNESS_CLAIMS + 1))

    spec_commit="$(_last_commit_touching "$path")"
    if [ -z "$spec_commit" ]; then
      unverified "$id: no Git history for the spec file $path, freshness unknown"
      continue
    fi
    _report_stale_claim_paths "$id" "$spec_commit" "the spec's last commit" "$affected"
  done < "$spec_index"
}

# Units table: the anchor is the table file's last commit, so any edit to it
# clears every row. That is coarse and stated as such in the contract.
_units_claims_freshness() {
  local line row paths units_commit
  units_commit="$(_last_commit_touching "$_UNITS_REL")"
  if [ -z "$units_commit" ]; then
    unverified "$_UNITS_REL has no Git history, freshness unknown"
    return 0
  fi
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    case "$line" in
      PROBLEM\|*)
        unverified "${line#PROBLEM|}"
        continue
        ;;
    esac
    IFS='|' read -r row paths _ <<< "$line"
    _FRESHNESS_CLAIMS=$((_FRESHNESS_CLAIMS + 1))
    _report_stale_claim_paths "$_UNITS_REL row $row" "$units_commit" "the last commit of $_UNITS_REL" "$paths"
  done <<< "$(_units_md_rows)"
}

check_spec_freshness() {
  begin_check "spec freshness (Git ancestry)"

  local has_specs=0 has_units=0
  if [ -f "$REPO_ROOT/docs/SPEC.md" ] && _traceability_opted_in; then
    has_specs=1
  fi
  if [ -f "$REPO_ROOT/$_UNITS_REL" ]; then
    has_units=1
  fi
  if [ "$has_specs" -eq 0 ] && [ "$has_units" -eq 0 ]; then
    if [ -f "$REPO_ROOT/docs/SPEC.md" ]; then
      ok "multi-spec traceability not opted in (no index rows, no docs/specs/) and no $_UNITS_REL"
    else
      unverified "no SPEC.md and no $_UNITS_REL: freshness check skipped"
    fi
    return 0
  fi
  if ! git -C "$REPO_ROOT" rev-parse --verify -q HEAD >/dev/null 2>&1; then
    unverified "no commits yet: freshness unknown"
    return 0
  fi
  if [ "$(git -C "$REPO_ROOT" rev-parse --is-shallow-repository 2>/dev/null || true)" = true ]; then
    unverified "shallow clone: history is incomplete, freshness unknown"
    return 0
  fi

  _FRESHNESS_CLAIMS=0
  if [ "$has_specs" -eq 1 ]; then
    _spec_claims_freshness
  fi
  if [ "$has_units" -eq 1 ]; then
    _units_claims_freshness
  fi

  _HEALTH_FRESHNESS_DONE=1
  if [ -z "$_CHECK_VERDICT" ]; then
    ok "claimed paths are covered by their anchor's last commit ($_FRESHNESS_CLAIMS claim(s))"
  fi
}

_project_slug() {
  local slug
  slug="$(basename "$REPO_ROOT")"

  [ -n "$slug" ] || return 1
  if [[ "$slug" == *$'\n'* || "$slug" == *$'\r'* || "$slug" == *"'"* || "$slug" == *'"'* ]]; then
    return 2
  fi

  printf '%s\n' "$slug"
  return 0
}


check_test_binary_resolution() {
  begin_check "same-line Python test binary resolution"

  local project_slug slug_status=0 test_files slug_pattern pattern hits
  test_files="$(git -C "$REPO_ROOT" ls-files -- \
    ':(glob)tests/*.py' ':(glob)tests/**/*.py' "${_GREP_EXCLUDES[@]}")"

  if [ -z "$test_files" ]; then
    unverified "no Python test suite: binary check skipped"
    return 0
  fi

  project_slug="$(_project_slug)" || slug_status=$?
  if [ "$slug_status" -eq 1 ]; then
    unverified "binary check skipped: could not derive project slug from repository root"
    return 0
  fi
  if [ "$slug_status" -eq 2 ]; then
    unverified "binary check skipped: cannot safely represent project slug containing quotes or newlines"
    return 0
  fi

  slug_pattern="$(printf '%s' "$project_slug" | sed 's/[][\\.^$*+?{}|()]/\\&/g')"
  pattern="subprocess\\.(run|call|check_call|check_output|Popen)[[:space:]]*\\([[:space:]]*\\[[[:space:]]*['\"]${slug_pattern}['\"]"
  hits="$(git -C "$REPO_ROOT" grep -nE "$pattern" -- \
    ':(glob)tests/*.py' ':(glob)tests/**/*.py' "${_GREP_EXCLUDES[@]}" 2>/dev/null || true)"

  if [ -n "$hits" ]; then
    fail "test resolves the project binary from PATH; use sys.executable -m <package> instead"
    printf '%s\n' "      ${hits//$'\n'/$'\n'      }"
    return 0
  fi

  ok "Python test binary resolution is ready for $project_slug"
}

# ── Check 2: spec coverage (units) ────────────────────────────────────────────
# A unit is a tracked file under a declared root that no exclusion matches
# (coordination contract, clause 3). The declaration is the one place a project
# says what its units are; the guard only reads it. Roots and exclusions are
# literal paths: a trailing slash names a directory, anything else names one
# file. No globs, so this reader and GTP's cannot disagree on a dialect.
_COVERAGE_DECLARATION_PRIMARY=".ai-forge/spec-coverage.json"
# A project that already keeps this layout in its own registry (the protocol's own
# units config) does not need a second copy under .ai-forge/.
_COVERAGE_DECLARATION_ALTERNATE="docs/registry/unit-config.json"
_COVERAGE_DECLARATION_REL="$_COVERAGE_DECLARATION_PRIMARY"
_COV_ROOTS=""
_COV_EXCLUSIONS=""
_COV_REASON=""
_COV_BASELINE=""

# Parses the declaration in its fixed layout (one string per line, two-space
# steps), pinned by a test, because the guard needs no Python and no jq:
#   {
#     "schema_version": "1",
#     "roots": [
#       "src/"
#     ],
#     "exclusions": [
#       "vendor/"
#     ]
#   }
# Returns 1 with _COV_REASON set on anything else, an unknown field included.
_read_coverage_declaration() {
  local file="$REPO_ROOT/$_COVERAGE_DECLARATION_REL" line section="" value schema=""
  local re_schema='^  "schema_version": "([^"]*)",?$'
  local re_baseline='^  "baseline": "([^"]*)",?$'
  local re_open='^  "(roots|exclusions)": \[$'
  local re_close='^  \],?$'
  local re_item='^    "([^"\\]*)",?$'
  _COV_ROOTS=""
  _COV_EXCLUSIONS=""
  _COV_REASON=""
  _COV_BASELINE=""

  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    if [ -n "$section" ]; then
      if [[ "$line" =~ $re_close ]]; then
        section=""
      elif [[ "$line" =~ $re_item ]]; then
        value="${BASH_REMATCH[1]}"
        case "$value" in
          "" | /* | *..* | *[\*\?\[]*)
            _COV_REASON="$section entry '$value' must be a literal path (no glob, no absolute path, no ..)"
            return 1
            ;;
        esac
        if [ "$section" = roots ]; then
          _COV_ROOTS="${_COV_ROOTS}${value}"$'\n'
        else
          _COV_EXCLUSIONS="${_COV_EXCLUSIONS}${value}"$'\n'
        fi
      else
        _COV_REASON="unrecognised line in $section: $line"
        return 1
      fi
    elif [ "$line" = "{" ] || [ "$line" = "}" ]; then
      :
    elif [[ "$line" =~ $re_schema ]]; then
      schema="${BASH_REMATCH[1]}"
    elif [[ "$line" =~ $re_open ]]; then
      section="${BASH_REMATCH[1]}"
    elif [[ "$line" =~ $re_baseline ]]; then
      value="${BASH_REMATCH[1]}"
      case "$value" in
        "" | /* | *..* | *[\*\?\[]*)
          _COV_REASON="baseline path '$value' must be a literal relative path (no glob, no absolute path, no ..)"
          return 1
          ;;
      esac
      _COV_BASELINE="$value"
    else
      _COV_REASON="unrecognised line (unknown field or layout): $line"
      return 1
    fi
  done < "$file"

  if [ -n "$section" ]; then
    _COV_REASON="unterminated $section list"
    return 1
  fi
  if [ "$schema" != "1" ]; then
    _COV_REASON="schema_version must be \"1\" (found \"${schema}\")"
    return 1
  fi
  if [ -z "$_COV_ROOTS" ]; then
    _COV_REASON="roots is empty"
    return 1
  fi
  return 0
}

# Chooses the declaration the check reads: the primary location, else the alternate.
# Both present is a conflict the guard does not rank or merge: it returns 1 and the
# caller reports unverified, so a project never gets a verdict from the wrong file.
_resolve_coverage_declaration() {
  _COVERAGE_DECLARATION_REL="$_COVERAGE_DECLARATION_PRIMARY"
  if [ -f "$REPO_ROOT/$_COVERAGE_DECLARATION_PRIMARY" ] \
    && [ -f "$REPO_ROOT/$_COVERAGE_DECLARATION_ALTERNATE" ]; then
    return 1
  fi
  if [ ! -f "$REPO_ROOT/$_COVERAGE_DECLARATION_PRIMARY" ] \
    && [ -f "$REPO_ROOT/$_COVERAGE_DECLARATION_ALTERNATE" ]; then
    _COVERAGE_DECLARATION_REL="$_COVERAGE_DECLARATION_ALTERNATE"
  fi
  return 0
}

# Tracked files under the declared roots minus the exclusions, one per line.
_declared_units() {
  local root path excl skip
  while IFS= read -r root; do
    [ -n "$root" ] || continue
    while IFS= read -r path; do
      [ -n "$path" ] || continue
      skip=0
      while IFS= read -r excl; do
        [ -n "$excl" ] || continue
        if [ "$path" = "$excl" ] || { [[ "$excl" == */ ]] && [[ "$path" == "$excl"* ]]; }; then
          skip=1
          break
        fi
      done <<< "$_COV_EXCLUSIONS"
      if [ "$skip" -eq 0 ]; then
        printf '%s\n' "$path"
      fi
    done < <(git -C "$REPO_ROOT" --literal-pathspecs ls-files -- "$root")
  done <<< "$_COV_ROOTS" | sort -u
}

# ── Baseline: units grandfathered while they stay unclaimed ───────────────────
# The baseline is a debt record, not a claim. It shrinks and never grows: the
# guard is its only writer, and only on an explicit --write-baseline run
# (coordination contract, clause 4). Fixed layout, like the declaration:
#   {
#     "schema": 1,
#     "units": [
#       "src/old.py"
#     ]
#   }
_COV_BASELINE_UNITS=""
_COV_BASELINE_REASON=""

# Reads the baseline file into _COV_BASELINE_UNITS. A missing file is an empty
# baseline (nothing grandfathered yet). Returns 1 with _COV_BASELINE_REASON on
# a file that is there but not in the layout above.
_read_coverage_baseline() {
  local file="$REPO_ROOT/$_COV_BASELINE" line in_units=0 schema=""
  local re_schema='^  "schema": ([0-9]+),?$'
  local re_open='^  "units": \[$'
  local re_close='^  \],?$'
  local re_item='^    "([^"\\]*)",?$'
  _COV_BASELINE_UNITS=""
  _COV_BASELINE_REASON=""
  [ -f "$file" ] || return 0

  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    if [ "$in_units" -eq 1 ]; then
      if [[ "$line" =~ $re_close ]]; then
        in_units=0
      elif [[ "$line" =~ $re_item ]]; then
        _COV_BASELINE_UNITS="${_COV_BASELINE_UNITS}${BASH_REMATCH[1]}"$'\n'
      else
        _COV_BASELINE_REASON="unrecognised line in units: $line"
        return 1
      fi
    elif [ "$line" = "{" ] || [ "$line" = "}" ]; then
      :
    elif [[ "$line" =~ $re_schema ]]; then
      schema="${BASH_REMATCH[1]}"
    elif [[ "$line" =~ $re_open ]]; then
      in_units=1
    else
      _COV_BASELINE_REASON="unrecognised line (unknown field or layout): $line"
      return 1
    fi
  done < "$file"

  if [ "$in_units" -eq 1 ]; then
    _COV_BASELINE_REASON="unterminated units list"
    return 1
  fi
  if [ "$schema" != "1" ]; then
    _COV_BASELINE_REASON="schema must be 1 (found \"${schema}\")"
    return 1
  fi
  return 0
}

# Lines of $1 that are not in $2 (newline lists).
_lines_not_in() {
  comm -23 <(printf '%s' "$1" | sort -u) <(printf '%s' "$2" | sort -u)
}

# Lines in both $1 and $2.
_lines_in_both() {
  comm -12 <(printf '%s' "$1" | sort -u) <(printf '%s' "$2" | sort -u)
}

# Writes the baseline atomically: a failed write leaves the previous file as it was.
_write_baseline() {
  local units="$1" target="$REPO_ROOT/$_COV_BASELINE" tmp unit sep=""
  tmp="${target}.tmp.$$"
  if ! mkdir -p "$(dirname "$target")" 2>/dev/null; then
    return 1
  fi
  {
    printf '{\n  "schema": 1,\n  "units": [\n'
    while IFS= read -r unit; do
      [ -n "$unit" ] || continue
      printf '%s    "%s"' "$sep" "$(_json_string "$unit")"
      sep=$',\n'
    done <<< "$units"
    [ -z "$sep" ] || printf '\n'
    printf '  ]\n}\n'
  } > "$tmp" 2>/dev/null || { rm -f "$tmp" 2>/dev/null || true; return 1; }
  mv -f "$tmp" "$target" 2>/dev/null || { rm -f "$tmp" 2>/dev/null || true; return 1; }
}

# ── "Touch it, claim it" ──────────────────────────────────────────────────────
# A baselined unit that the current change modifies should be claimed in the
# same change and leave the baseline, so debt only shrinks as the code is worked
# on. Warning level: everything here is `unverified`.

# The ref the change is measured against: --base, else the base the forge
# exposes. GitLab sets CI_MERGE_REQUEST_DIFF_BASE_SHA in merge-request pipelines;
# GitHub sets GITHUB_BASE_REF (a branch name, fetched as origin/<name> by a
# full-depth checkout) on pull_request events. Branch pipelines have neither.
_resolve_base_ref() {
  if [ -n "$BASE_REF" ]; then
    printf '%s\n' "$BASE_REF"
  elif [ -n "${CI_MERGE_REQUEST_DIFF_BASE_SHA:-}" ]; then
    printf '%s\n' "$CI_MERGE_REQUEST_DIFF_BASE_SHA"
  elif [ -n "${GITHUB_BASE_REF:-}" ]; then
    printf 'origin/%s\n' "$GITHUB_BASE_REF"
  elif [ -n "${CI_MERGE_REQUEST_TARGET_BRANCH_NAME:-}" ]; then
    printf 'origin/%s\n' "$CI_MERGE_REQUEST_TARGET_BRANCH_NAME"
  else
    return 1
  fi
}

_report_touched_baselined_units() {
  local baselined="$1" base changed touched unit
  # Nothing baselined: the rule has nothing to say, and says nothing.
  [ -n "$baselined" ] || return 0
  # A --write-baseline run has just recorded these units; there is no change to judge.
  [ "$WRITE_BASELINE" -eq 0 ] || return 0

  if ! base="$(_resolve_base_ref)"; then
    unverified "touch-it-claim-it: no base reference (pass --base <ref>, or run in a merge-request pipeline)"
    return 0
  fi
  if ! git -C "$REPO_ROOT" rev-parse --verify -q "${base}^{commit}" >/dev/null 2>&1; then
    unverified "touch-it-claim-it: base reference $base does not resolve to a commit"
    return 0
  fi
  if ! changed="$(git -C "$REPO_ROOT" diff --name-only "${base}...HEAD" 2>/dev/null)"; then
    unverified "touch-it-claim-it: cannot compute the change against $base (shallow clone or no common ancestor)"
    return 0
  fi

  touched="$(_lines_in_both "$baselined" "$changed")"
  while IFS= read -r unit; do
    if [ -n "$unit" ]; then
      unverified "baselined unit $unit was modified in this change: claim it and remove it from the baseline"
    fi
  done <<< "$touched"
}

# True when the spec has at least one REQ or INV row whose binding resolves to a
# test that exists. A placeholder, a malformed row or a dangling target does not
# count: a claim backed by nothing falsifiable is not a claim (coordination
# contract, clause 5).
_spec_has_resolving_binding() {
  local line binding
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      "- REQ-"* | "- INV-"*) ;;
      *) continue ;;
    esac
    # With a second argument, only the row of that requirement counts.
    if [ -n "${2:-}" ] && [[ "$line" != "- $2 -> "* ]]; then
      continue
    fi
    grep -Eq '^- (REQ|INV)-[0-9]+ -> tests/[^: []+(::[A-Za-z_][A-Za-z0-9_]*)*(\[[^] ]*\])?$' <<< "$line" || continue
    binding="${line#* -> }"
    if [ -z "$(_binding_problems "$binding")" ]; then
      return 0
    fi
  done < "$1"
  return 1
}

# True when an approved spec of the index binds requirement $1 to a test that resolves.
_requirement_resolves() {
  local line fields path status
  [ -f "$REPO_ROOT/docs/SPEC.md" ] || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    fields="$(_spec_index_row_fields "$line")" || continue
    IFS='|' read -r _ path status _ <<< "$fields"
    [ "$status" = approved ] || continue
    [ -f "$REPO_ROOT/$path" ] || continue
    if _spec_has_resolving_binding "$REPO_ROOT/$path" "$1"; then
      return 0
    fi
  done < "$REPO_ROOT/docs/SPEC.md"
  return 1
}

# The rows of docs/registry/units.md as "row|paths|requirements" lines, or one line
# "PROBLEM|<message>" for a header or a row that cannot be used. The reading rules are
# those of check 5 (_units_claims_freshness): the header is pinned, a row has two cells
# and the paths come first. Printing instead of calling unverified keeps this safe to
# run inside $(...), where a verdict would be lost.
_units_md_rows() {
  local units_file="$REPO_ROOT/$_UNITS_REL" line header_seen=0 row=0 inner pipes paths reqs
  [ -f "$units_file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    [[ "$line" == "|"* ]] || continue
    if [ "$header_seen" -eq 0 ]; then
      header_seen=1
      if [ "$(printf '%s' "$line" | tr -s ' ')" != "$_UNITS_HEADER" ]; then
        printf "PROBLEM|%s header is not '%s', its rows were not read\n" "$_UNITS_REL" "$_UNITS_HEADER"
        return 0
      fi
      continue
    fi
    if grep -Eq '^\|[ :|-]+\|$' <<< "$line"; then
      continue # separator row
    fi
    row=$((row + 1))
    inner="${line#|}"
    inner="${inner%|}"
    pipes="${inner//[^|]/}"
    paths="$(printf '%s' "${inner%%|*}" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
    reqs="$(printf '%s' "${inner#*|}" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
    if [ "${#pipes}" -ne 1 ] || [ -z "$paths" ]; then
      printf 'PROBLEM|%s row %s is malformed (expected two cells, paths first), not read\n' "$_UNITS_REL" "$row"
      continue
    fi
    printf '%s|%s|%s\n' "$row" "$paths" "$reqs"
  done < "$units_file"
}

# The claims of docs/registry/units.md as "label|path|backed" lines, in the shape
# _spec_claims prints. A row is backed when it names a requirement that an approved spec
# binds to a test that resolves (clause 5); a problem is reported as unverified.
# True when $1 names a row of the registry tables whose test file exists. In table
# format (no spec tree opted in) the tables are the project's record: requirements
# live in docs/registry/requirements.md with the test node ids in the last cell,
# invariants in INVARIANTS.md with the binding after '->'. The file before '::'
# must exist in the working tree; a row that names no existing test does not resolve.
_table_requirement_resolves() {
  local req="$1" line file
  line="$(awk -F'|' -v id="$req" '
    /^\|/ {
      c=$2; gsub(/^[[:space:]]+|[[:space:]]+$/, "", c)
      if (c == id) {
        for (i = NF; i > 0; i--) {
          t=$i; gsub(/^[[:space:]]+|[[:space:]]+$/, "", t)
          if (t != "") { print t; exit }
        }
      }
    }' "$REPO_ROOT/docs/registry/requirements.md" 2>/dev/null)"
  if [ -z "$line" ] && [ -f "$REPO_ROOT/$_INVARIANTS_REL" ]; then
    line="$(grep -m1 -E "^- \\[${req}\\]" "$REPO_ROOT/$_INVARIANTS_REL")"
  fi
  [ -n "$line" ] || return 1
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    [ -f "$REPO_ROOT/$file" ] && return 0
  done < <(grep -oE '[A-Za-z0-9_./-]+\.py' <<< "$line" || true)
  return 1
}

_add_units_md_claims() {
  local rows line row paths reqs req backed entry req_ids
  rows="$(_units_md_rows)"
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    case "$line" in
      PROBLEM\|*)
        unverified "${line#PROBLEM|}"
        continue
        ;;
    esac
    IFS='|' read -r row paths reqs <<< "$line"
    backed=0
    req_ids="$(grep -oE '(REQ|INV)-[0-9]+' <<< "$reqs" || true)"
    if _traceability_opted_in; then
      while IFS= read -r req; do
        [ -n "$req" ] || continue
        if _requirement_resolves "$req"; then
          backed=1
          break
        fi
      done <<< "$req_ids"
    else
      while IFS= read -r req; do
        [ -n "$req" ] || continue
        if _table_requirement_resolves "$req"; then
          backed=1
          break
        fi
      done <<< "$req_ids"
    fi
    while IFS= read -r entry; do
      entry="$(printf '%s' "$entry" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
      entry="${entry%/}"
      [ -n "$entry" ] || continue
      _UNITS_MD_CLAIMS+="${_UNITS_REL} row ${row}|${entry}|${backed}"$'\n'
    done <<< "${paths//,/$'\n'}"
  done <<< "$rows"
}

# Claims of every active spec, one "SPEC-ID|path|backed" per entry of its
# `Affected paths:` line. An entry is a literal path; a trailing slash is not
# significant. backed is 1 when the spec is approved and has a resolving binding.
_spec_claims() {
  local line fields id path status affected entry backed
  [ -f "$REPO_ROOT/docs/SPEC.md" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    fields="$(_spec_index_row_fields "$line")" || continue
    IFS='|' read -r id path status _ <<< "$fields"
    case "$status" in
      draft|approved) ;;
      *) continue ;;
    esac
    [ -f "$REPO_ROOT/$path" ] || continue
    affected="$(_affected_paths_of "$REPO_ROOT/$path")"
    if [ -z "$affected" ] || [ "$affected" = "none" ]; then
      continue
    fi
    backed=0
    if [ "$status" = approved ] && _spec_has_resolving_binding "$REPO_ROOT/$path"; then
      backed=1
    fi
    while IFS= read -r entry; do
      entry="$(printf '%s' "$entry" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
      entry="${entry%/}"
      [ -n "$entry" ] || continue
      printf '%s|%s|%s\n' "$id" "$entry" "$backed"
    done <<< "${affected//,/$'\n'}"
  done < "$REPO_ROOT/docs/SPEC.md"
}

# True when a declared root holds units below a subdirectory of itself.
_root_has_source_subdirectories() {
  printf '%s\n' "$2" \
    | awk -v r="$1" 'index($0, r "/") == 1 { if (index(substr($0, length(r) + 2), "/")) found = 1 } END { exit !found }'
}

# Prints at most 20 paths of a newline list, indented, and says how many it left out.
_print_capped_list() {
  local shown=20 count
  count="$(printf '%s\n' "$1" | wc -l | tr -d ' ')"
  head -n "$shown" <<< "$1" | sed 's/^/      /'
  if [ "$count" -gt "$shown" ]; then
    echo "      ($((count - shown)) more not shown)"
  fi
}

# Matches units against claims by whole path segments and warns about what does
# not add up. Warning level only: everything here is `unverified`.
_report_unclaimed_units() {
  local units="$1" claims id claim backed root matches refused line duplicates stray indexed
  local claimed_backed="" claimed_unbacked="" unclaimed unbacked count
  claims="$(_spec_claims)"
  # Clause 2: the rows of docs/registry/units.md are claims too.
  _UNITS_MD_CLAIMS=""
  _add_units_md_claims
  if [ -n "$_UNITS_MD_CLAIMS" ]; then
    claims="${claims:+$claims$'\n'}${_UNITS_MD_CLAIMS%$'\n'}"
  fi

  # A spec file the index does not list is not read: say so instead of dropping its claims.
  indexed="$(grep -o '(docs/specs/[^)]*\.md)' "$REPO_ROOT/docs/SPEC.md" 2>/dev/null | tr -d '()' || true)"
  while IFS= read -r stray; do
    [ -n "$stray" ] || continue
    if ! grep -qxF "$stray" <<< "$indexed"; then
      unverified "$stray is not in the docs/SPEC.md index; its claims are not counted"
    fi
  done < <(git -C "$REPO_ROOT" ls-files -- 'docs/specs/SPEC-*.md')

  while IFS='|' read -r id claim backed; do
    [ -n "$claim" ] || continue
    case "$claim" in
      *[\*\?\[]*)
        unverified "$id claim '$claim' contains glob characters; it is read as a literal path and matches nothing"
        continue
        ;;
    esac
    refused=0
    while IFS= read -r root; do
      root="${root%/}"
      [ -n "$root" ] || continue
      if [ "$claim" = "$root" ] && _root_has_source_subdirectories "$root" "$units"; then
        unverified "$id claims root $root/, which holds source subdirectories; claim each subdirectory instead"
        refused=1
        break
      fi
    done <<< "$_COV_ROOTS"
    [ "$refused" -eq 0 ] || continue

    matches="$(printf '%s\n' "$units" | awk -v c="$claim" '$0 == c || index($0, c "/") == 1')"
    if [ -z "$matches" ]; then
      unverified "$id claims $claim, which matches no unit"
      continue
    fi
    if [ "$backed" = 1 ]; then
      claimed_backed="${claimed_backed}${matches}"$'\n'
    else
      claimed_unbacked="${claimed_unbacked}${matches}"$'\n'
    fi
  done <<< "$claims"

  duplicates="$(printf '%s\n' "$claims" \
    | awk -F'|' 'NF == 3 { n[$2]++; ids[$2] = (ids[$2] == "" ? $1 : ids[$2] ", " $1) }
        END { for (c in n) if (n[c] > 1) print c " is claimed more than once (" ids[c] ")" }' \
    | sort)"
  while IFS= read -r line; do
    if [ -n "$line" ]; then
      unverified "$line"
    fi
  done <<< "$duplicates"

  unclaimed="$(comm -23 <(printf '%s\n' "$units" | sort -u) \
    <(printf '%s%s' "$claimed_backed" "$claimed_unbacked" | sort -u))"
  unbacked="$(comm -23 <(printf '%s' "$claimed_unbacked" | sort -u) <(printf '%s' "$claimed_backed" | sort -u))"

  local baseline_units="" baselined removable fresh grown new_count
  if [ -n "$_COV_BASELINE" ]; then
    if _read_coverage_baseline; then
      baseline_units="$_COV_BASELINE_UNITS"
    else
      unverified "baseline $_COV_BASELINE: $_COV_BASELINE_REASON"
    fi
  fi

  if [ "$WRITE_BASELINE" -eq 1 ]; then
    if [ -z "$_COV_BASELINE" ]; then
      fail "no baseline path declared in $_COVERAGE_DECLARATION_REL; nothing written"
    elif [ -n "$_COV_BASELINE_REASON" ]; then
      fail "cannot check that the baseline only shrinks while it is unreadable; fix or remove $_COV_BASELINE"
    else
      grown=""
      if [ -f "$REPO_ROOT/$_COV_BASELINE" ]; then
        grown="$(_lines_not_in "$unclaimed" "$baseline_units")"
      fi
      if [ -n "$grown" ]; then
        new_count="$(printf '%s\n' "$grown" | wc -l | tr -d ' ')"
        fail "refusing to grow the baseline: $new_count unit(s) are not in it yet; claim them instead"
        _print_capped_list "$grown"
      elif _write_baseline "$unclaimed"; then
        baseline_units="$unclaimed"
        echo "      baseline written: $_COV_BASELINE"
      else
        fail "cannot write the baseline $_COV_BASELINE; the previous file is untouched"
      fi
    fi
  fi

  # Unit figures for the spec-health summary; a baseline that could not be read stays unknown.
  _HEALTH_UNITS_DONE=1
  _HEALTH_TOTAL_UNITS="$(printf '%s\n' "$units" | grep -c . || true)"
  _HEALTH_CLAIMED_UNITS="$(printf '%s' "$claimed_backed" | sort -u | grep -c . || true)"
  if [ -z "$_COV_BASELINE_REASON" ]; then
    _HEALTH_BASELINE_DONE=1
    _HEALTH_BASELINE_SIZE="$(printf '%s' "$baseline_units" | sort -u | grep -c . || true)"
  fi

  baselined="$(_lines_in_both "$unclaimed" "$baseline_units")"
  fresh="$(_lines_not_in "$unclaimed" "$baseline_units")"
  removable="$(_lines_not_in "$baseline_units" "$unclaimed")"

  if [ -n "$baselined" ]; then
    echo "      $(printf '%s\n' "$baselined" | wc -l | tr -d ' ') unit(s) baselined (grandfathered, not yet claimed)"
    _print_capped_list "$baselined"
  fi
  if [ -n "$removable" ]; then
    head -n 20 <<< "$removable" \
      | sed 's/^/      baseline entry /; s/$/ can be removed: it is claimed or no longer a unit/'
  fi
  _report_touched_baselined_units "$baselined"

  if [ -n "$fresh" ]; then
    count="$(printf '%s\n' "$fresh" | wc -l | tr -d ' ')"
    unverified "$count unit(s) unclaimed"
    _print_capped_list "$fresh"
  fi

  if [ -n "$unbacked" ]; then
    count="$(printf '%s\n' "$unbacked" | wc -l | tr -d ' ')"
    unverified "$count unit(s) claimed-unbacked (the claiming spec is not approved, or binds no requirement to a test that resolves)"
    _print_capped_list "$unbacked"
  fi

  if [ -z "$_CHECK_VERDICT" ]; then
    ok "every unit is claimed by an approved spec with a bound requirement, or baselined"
  fi
}

check_spec_coverage() {
  begin_check "spec coverage (units)"

  if ! _resolve_coverage_declaration; then
    unverified "two declarations: $_COVERAGE_DECLARATION_PRIMARY and $_COVERAGE_DECLARATION_ALTERNATE both exist; keep one, the guard does not choose"
    return 0
  fi
  if [ ! -f "$REPO_ROOT/$_COVERAGE_DECLARATION_REL" ]; then
    unverified "no declaration: $_COVERAGE_DECLARATION_PRIMARY (or $_COVERAGE_DECLARATION_ALTERNATE) not found"
    return 0
  fi
  if ! _read_coverage_declaration; then
    unverified "declaration $_COVERAGE_DECLARATION_REL: $_COV_REASON"
    return 0
  fi

  local root units total
  while IFS= read -r root; do
    [ -n "$root" ] || continue
    if [ -z "$(git -C "$REPO_ROOT" --literal-pathspecs ls-files -- "$root")" ]; then
      unverified "root $root lists no tracked file"
    fi
  done <<< "$_COV_ROOTS"
  if [ -n "$_CHECK_VERDICT" ]; then
    return 0
  fi

  units="$(_declared_units)"
  if [ -z "$units" ]; then
    unverified "the declared roots and exclusions leave no unit"
    return 0
  fi
  total="$(printf '%s\n' "$units" | wc -l | tr -d ' ')"
  echo "      $total unit(s) under the declared roots"
  printf '%s\n' "$units" \
    | awk -F/ '{ k = (index($0, "/") ? $1 : "."); c[k]++ } END { for (k in c) print "      " k ": " c[k] }' \
    | sort
  _report_unclaimed_units "$units"
}

# ── Spec-health summary (check 9) ─────────────────────────────────────────────
# The guard writes .reports/spec-health.json and no other tool's file (coordination
# contract, clauses 6 and 7). Figures a check did not reach are null, never 0:
# "unknown" and "none found" are different statements to the reader.
_SPEC_HEALTH_REL=".reports/spec-health.json"
_SPEC_HEALTH_SCHEMA_VERSION="1"
_FIELD_SEP=$'\x1f'

# JSON string body: drop control characters except tab and carriage return,
# then escape backslash, quote, tab and carriage return.
_json_string() {
  printf '%s' "$1" \
    | tr -d '\000-\010\012-\014\016-\037' \
    | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e $'s/\t/\\\\t/g' -e $'s/\r/\\\\r/g'
}

# Prints a JSON number, or null when the count was not reached.
_json_count() {
  if [ "$1" -eq 1 ]; then
    printf '%s' "$2"
  else
    printf 'null'
  fi
}

check_spec_health_summary() {
  begin_check "spec-health summary ($_SPEC_HEALTH_REL)"

  local out="$REPO_ROOT/$_SPEC_HEALTH_REL" tmp commit="null" stale="null"
  local label path sha sep=""

  if git -C "$REPO_ROOT" rev-parse --verify -q HEAD >/dev/null 2>&1; then
    commit="\"$(git -C "$REPO_ROOT" rev-parse HEAD)\""
  fi

  if [ "$_HEALTH_FRESHNESS_DONE" -eq 1 ]; then
    stale="["
    while IFS="$_FIELD_SEP" read -r label path sha; do
      [ -n "$label" ] || continue
      stale+="${sep}{\"spec\": \"$(_json_string "$label")\", \"path\": \"$(_json_string "$path")\", \"commit\": \"$sha\"}"
      sep=", "
    done <<< "$_HEALTH_STALE"
    stale+="]"
  fi

  # Every value below is already JSON: a quoted-and-escaped string, a bare
  # count, or null. The document is assembled from them and written verbatim,
  # so no value is interpreted as a printf format.
  local doc nl=$'\n'
  doc="{${nl}"
  doc+="  \"schema_version\": \"${_SPEC_HEALTH_SCHEMA_VERSION}\",${nl}"
  doc+="  \"commit\": ${commit},${nl}"
  doc+="  \"stale\": ${stale},${nl}"
  doc+="  \"figures\": {${nl}"
  doc+="    \"claimed_units\": $(_json_count "$_HEALTH_UNITS_DONE" "$_HEALTH_CLAIMED_UNITS"),${nl}"
  doc+="    \"total_units\": $(_json_count "$_HEALTH_UNITS_DONE" "$_HEALTH_TOTAL_UNITS"),${nl}"
  doc+="    \"baseline_size\": $(_json_count "$_HEALTH_BASELINE_DONE" "$_HEALTH_BASELINE_SIZE"),${nl}"
  doc+="    \"spec_requirements_bound\": $(_json_count "$_HEALTH_TRACE_DONE" "$_HEALTH_REQ_BOUND"),${nl}"
  doc+="    \"spec_invariants_bound\": $(_json_count "$_HEALTH_TRACE_DONE" "$_HEALTH_INV_BOUND")${nl}"
  doc+="  }${nl}}"

  tmp="$REPO_ROOT/.reports/.spec-health.json.$$"
  if ! mkdir -p "$REPO_ROOT/.reports" 2>/dev/null \
    || ! printf '%s\n' "$doc" > "$tmp" 2>/dev/null \
    || ! mv -f "$tmp" "$out" 2>/dev/null; then
    rm -f "$tmp" 2>/dev/null || true
    unverified "cannot write $_SPEC_HEALTH_REL: the summary was not produced"
    return 0
  fi

  ok "wrote $_SPEC_HEALTH_REL"
}

# ── Managed files are not modified copies ────────────────────────────────────
# `ai-forge new` and `ai-forge sync` record the SHA-256 of every file they write in
# .ai-forge/manifest.json (`template_sha256`). A managed file whose bytes no longer
# hash to that digest is a modified copy of the template. The guard reads the
# manifest itself, with awk, against the layout the writer produces (indent 2,
# sorted keys, one field per line); the layout is pinned by
# test_integrity_manifest_written_by_ai_forge_is_readable_by_shell. A manifest in any
# other layout is unverified, never a failure.
_MANIFEST_V2_REL=".ai-forge/manifest.json"

# The SHA-256 of standard input as 64 lowercase hex digits. The portable hash command
# is chosen here once: sha256sum on Linux, shasum on macOS.
_sha256_stdin() {
  local out
  if command -v sha256sum >/dev/null 2>&1; then
    out="$(sha256sum 2>/dev/null)" || return 1
  elif command -v shasum >/dev/null 2>&1; then
    out="$(shasum -a 256 2>/dev/null)" || return 1
  else
    return 1
  fi
  printf '%s\n' "${out%% *}"
}

_LAYOUT_END_MARKER='<!-- /ai-forge:documentation-layout -->'

# The bytes ai-forge hashed for a record. A generated or written record hashes the
# file as it is. A customized record hashes Path.read_text(), which turns CRLF into
# LF, so its kind is "text" and the carriage returns are dropped.
_provenance_feed() {
  if [ "$2" = text ]; then
    tr -d '\r' < "$1"
  else
    cat -- "$1"
  fi
}

# How ai-forge reads the Documentation Layout markers of RULES.md
# (file_provenance_digest). Prints NONE when the text holds no marker at all (the whole
# file is hashed), "OK <checksum>" for exactly one start marker line followed by exactly
# one end marker (the checksum is the one the start marker embeds), and BAD for any other
# arrangement, which Python rejects with a ValueError.
_rules_md_scan() {
  LC_ALL=C awk -v end_mark="$_LAYOUT_END_MARKER" '
    {
      if ($0 ~ /^<!-- ai-forge:documentation-layout:v[0-9]+:sha256=[0-9a-f]+ -->$/) {
        sum = $0
        sub(/^.*:sha256=/, "", sum)
        sub(/ -->$/, "", sum)
        if (length(sum) == 64) {
          starts++
          if (starts == 1) { checksum = sum; start_line = NR }
        }
      }
      rest = $0
      while ((i = index(rest, end_mark)) > 0) {
        ends++
        if (ends == 1) end_line = NR
        rest = substr(rest, i + length(end_mark))
      }
    }
    END {
      if (starts == 0 && ends == 0) print "NONE"
      else if (starts == 1 && ends == 1 && end_line > start_line) print "OK " checksum
      else print "BAD"
    }'
}

# The bytes between the start marker line and the end marker, which is what the
# RULES.md digest covers. Streamed through awk rather than captured with $(...), which
# would strip trailing newlines. It reads its whole input so the writer never gets SIGPIPE.
_rules_md_body() {
  LC_ALL=C awk -v end_mark="$_LAYOUT_END_MARKER" '
    state == 0 {
      if ($0 ~ /^<!-- ai-forge:documentation-layout:v[0-9]+:sha256=[0-9a-f]+ -->$/) {
        sum = $0
        sub(/^.*:sha256=/, "", sum)
        sub(/ -->$/, "", sum)
        if (length(sum) == 64) state = 1
      }
      next
    }
    state == 1 {
      i = index($0, end_mark)
      if (i > 0) { printf "%s", substr($0, 1, i - 1); state = 2 } else print $0
    }
  '
}

# The digest ai-forge records for a file, computed in shell: <file> <relative path> <kind>.
# Prints the digest, followed by a space and the checksum the start marker embeds when
# the file is RULES.md with markers. Returns 2 for markers Python rejects, 3 for a text
# file whose line endings cannot be mapped to Python's (a lone CR), 1 when it cannot hash.
_provenance_digest() {
  local file="$1" rel="$2" kind="$3" scan digest
  if [ "$kind" = text ]; then
    if LC_ALL=C grep -q $'\r.' -- "$file" 2>/dev/null \
      || tail -c 1 -- "$file" 2>/dev/null | LC_ALL=C grep -q $'\r'; then
      return 3
    fi
  fi
  if [ "$rel" = RULES.md ]; then
    scan="$(_provenance_feed "$file" "$kind" | _rules_md_scan)" || return 1
    case "$scan" in
      NONE) ;;
      "OK "*)
        digest="$(_provenance_feed "$file" "$kind" | _rules_md_body | _sha256_stdin)" || return 1
        printf '%s %s\n' "$digest" "${scan#OK }"
        return 0
        ;;
      *) return 2 ;;
    esac
  fi
  _provenance_feed "$file" "$kind" | _sha256_stdin || return 1
}

# One tab-separated line per file record: path, policy, status, digest ("null" when
# the record has none). When the manifest is not in the pinned layout the output is a
# single line starting with ERROR.
_read_manifest_records() {
  awk '
    function bad(msg) { print "ERROR\t" msg; failed = 1; exit }
    BEGIN { state = "top" }
    state == "top" {
      if ($0 == "  \"schema_version\": 2,") version = 1
      else if ($0 == "  \"files\": {},") files_seen = 1
      else if ($0 == "  \"files\": {") { files_seen = 1; state = "files" }
      next
    }
    state == "files" {
      if ($0 ~ /^  \},?$/) { state = "top"; next }
      if ($0 ~ /^    ".*": \{$/) {
        path = $0
        sub(/^    "/, "", path)
        sub(/": \{$/, "", path)
        policy = ""; status = ""; digest = ""
        state = "record"
        next
      }
      bad("unexpected line in the files section")
    }
    state == "record" {
      value = $0
      if ($0 ~ /^      "policy": ".*",$/) {
        sub(/^      "policy": "/, "", value); sub(/",$/, "", value)
        policy = value; next
      }
      if ($0 ~ /^      "status": ".*",$/) {
        sub(/^      "status": "/, "", value); sub(/",$/, "", value)
        status = value; next
      }
      if ($0 ~ /^      "template_sha256": null$/) { digest = "null"; next }
      if ($0 ~ /^      "template_sha256": ".*"$/) {
        sub(/^      "template_sha256": "/, "", value); sub(/"$/, "", value)
        digest = value; next
      }
      if ($0 ~ /^    \},?$/) {
        if (policy == "" || status == "" || digest == "") bad("incomplete record")
        if (digest != "null" && (length(digest) != 64 || digest ~ /[^0-9a-f]/)) bad("invalid digest")
        print path "\t" policy "\t" status "\t" digest
        state = "files"
        next
      }
      bad("unexpected line in a file record")
    }
    END {
      if (failed) exit
      if (state != "top") print "ERROR\ttruncated manifest"
      else if (!version) print "ERROR\tunsupported or missing schema_version"
      else if (!files_seen) print "ERROR\tno files section"
    }
  ' "$1"
}

check_managed_integrity() {
  begin_check "managed files integrity (manifest digests)"

  local manifest="$REPO_ROOT/$_MANIFEST_V2_REL"
  if [ -L "$REPO_ROOT/.ai-forge" ] || [ -L "$manifest" ]; then
    unverified "$_MANIFEST_V2_REL is a symlink: managed files cannot be verified"
    return 0
  fi
  if [ ! -f "$manifest" ]; then
    unverified "no $_MANIFEST_V2_REL: managed files cannot be verified"
    return 0
  fi

  local records first
  if ! records="$(_read_manifest_records "$manifest")"; then
    unverified "manifest not readable by the guard (awk failed): managed files cannot be verified"
    return 0
  fi
  first="${records%%$'\n'*}"
  if [ "${first%%$'\t'*}" = ERROR ]; then
    unverified "manifest not readable by the guard (${first#*$'\t'}): managed files cannot be verified"
    return 0
  fi

  local path policy status digest file found embedded rc matched=0
  local same=0 edited=0 unknown=0
  while IFS=$'\t' read -r path policy status digest; do
    [ -n "$path" ] || continue
    case "$path" in
      *\\*)
        unverified "$path: path stored with JSON escapes, digest not verified"
        continue
        ;;
      /* | ../* | */../* | */..)
        unverified "$path: unsafe path in the manifest, not read"
        continue
        ;;
    esac
    case "$policy" in
      create-only)
        continue
        ;;
      managed-block)
        if [ "$path" != RULES.md ]; then
          unverified "$path: managed-block digest is not verified by this version of the guard"
          continue
        fi
        ;;
    esac
    file="$REPO_ROOT/$path"
    case "$status" in
      unverified)
        unverified "$path: recorded without a digest (ownership unknown)"
        continue
        ;;
      customized)
        # The record holds the digest of the project's own bytes at init: a file the project
        # owns, never a failure. Whether it changed since is reported, not judged.
        if [ -f "$file" ] && [ ! -L "$file" ] && found="$(_provenance_digest "$file" "$path" text)"; then
          if [ "${found%% *}" = "$digest" ]; then same=$((same + 1)); else edited=$((edited + 1)); fi
        else
          unknown=$((unknown + 1))
        fi
        continue
        ;;
    esac
    if [ -L "$file" ]; then
      unverified "$path: is a symlink, digest not verified"
      continue
    fi
    if [ ! -f "$file" ]; then
      fail "$path: recorded as managed but the file is missing"
      continue
    fi
    if found="$(_provenance_digest "$file" "$path" bytes)"; then
      rc=0
    else
      rc=$?
    fi
    case "$rc" in
      0) ;;
      2)
        unverified "$path: Documentation Layout markers are not valid, digest not verified"
        continue
        ;;
      *)
        unverified "$path: cannot hash the file (no sha256sum or shasum, or unreadable)"
        continue
        ;;
    esac
    embedded=""
    case "$found" in *" "*) embedded="${found#* }" ;; esac
    found="${found%% *}"
    if [ "$found" != "$digest" ]; then
      fail "$path: managed file modified since ai-forge wrote it (recorded ${digest:0:12}, found ${found:0:12})"
    elif [ -n "$embedded" ] && [ "$embedded" != "$found" ]; then
      unverified "$path: the Documentation Layout checksum embedded in the file does not match its body"
    else
      matched=$((matched + 1))
    fi
  done <<< "$records"

  # Printed whenever nothing failed; an unverified line above still leaves the verdict unverified.
  if [ "$_CHECK_VERDICT" != fail ]; then
    ok "$matched managed file(s) match their recorded digest; customized: $same unchanged since init, $edited edited since, $unknown not comparable"
  fi
}

# ── 7. Change directories (docs/changes) ────────────────────────────────────

# The change-delta contract is opt-in: a project opts in by shipping a
# docs/changes/ directory. A change is a directory, never a file, so
# docs/changes/README.md and the archive/ directory itself are not judged.
_changes_opted_in() {
  [ -d "$REPO_ROOT/$_CHANGES_REL" ]
}

# Days since a fixed epoch for a calendar date, in shell arithmetic. `date -d`
# (GNU) and `date -j` (BSD) disagree, so no date arithmetic is delegated to
# date; only `date +%Y-%m-%d`, which both accept, supplies today.
_days_from_civil() {
  local y m d era yoe doy doe
  y=$((10#$1))
  m=$((10#$2))
  d=$((10#$3))
  if [ "$m" -le 2 ]; then
    y=$((y - 1))
  fi
  era=$((y / 400))
  yoe=$((y - era * 400))
  doy=$(((153 * ((m + 9) % 12) + 2) / 5 + d - 1))
  doe=$((yoe * 365 + yoe / 4 - yoe / 100 + doy))
  echo $((era * 146097 + doe))
}

# Succeeds when year, month and day name a real Gregorian date. The name
# pattern bounds the day to 01-31 and the month to 01-12; this rejects a day
# past the end of its month (2026-02-30, 2026-04-31), leap years included.
_valid_civil_date() {
  local y m d max
  y=$((10#$1))
  m=$((10#$2))
  d=$((10#$3))
  case "$m" in
    4 | 6 | 9 | 11) max=30 ;;
    2)
      if [ $((y % 4)) -eq 0 ] && { [ $((y % 100)) -ne 0 ] || [ $((y % 400)) -eq 0 ]; }; then
        max=29
      else
        max=28
      fi
      ;;
    *) max=31 ;;
  esac
  [ "$d" -le "$max" ]
}

# Prints today's day number; returns 1 when the date cannot be read.
_today_days() {
  local today
  today="$(date +%Y-%m-%d 2>/dev/null)" || return 1
  [[ "$today" =~ ^([0-9]{4})-([0-9]{2})-([0-9]{2})$ ]] || return 1
  _days_from_civil "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}"
}

# Prints "state|relative path" for each change directory: "active" for a
# directory directly under docs/changes/, "archived" for one under archive/.
_change_dirs() {
  local dir
  for dir in "$REPO_ROOT/$_CHANGES_REL"/*/; do
    [ -d "$dir" ] || continue
    dir="${dir%/}"
    [ "${dir##*/}" = archive ] && continue
    echo "active|${dir#"$REPO_ROOT"/}"
  done
  for dir in "$REPO_ROOT/$_CHANGES_REL"/archive/*/; do
    [ -d "$dir" ] || continue
    dir="${dir%/}"
    echo "archived|${dir#"$REPO_ROOT"/}"
  done
}

check_changes() {
  begin_check "change directories (docs/changes)"

  if ! _changes_opted_in; then
    ok "change delta not opted in (no docs/changes/)"
    return 0
  fi

  local spec_ids="" line fields dirs state rel name file delta named id found
  local change_count=0 change_days today_days age

  if [ -f "$REPO_ROOT/$_SPEC_REL" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      fields="$(_spec_index_row_fields "$line")" || continue
      spec_ids="${spec_ids}${fields%%|*}"$'\n'
    done < "$REPO_ROOT/$_SPEC_REL"
  fi

  dirs="$(_change_dirs)"
  while IFS='|' read -r state rel; do
    [ -n "$rel" ] || continue
    change_count=$((change_count + 1))
    name="${rel##*/}"

    change_days=""
    if [[ "$name" =~ $_CHANGE_NAME_RE ]] \
      && _valid_civil_date "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}"; then
      change_days="$(_days_from_civil "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}")"
    else
      fail "$rel is not named YYYY-MM-DD-<slug> (date, then a lowercase hyphenated slug)"
    fi

    for file in CHANGE.md DELTA.md TASKS.md; do
      [ -f "$REPO_ROOT/$rel/$file" ] || fail "$rel is missing $file"
    done

    delta="$REPO_ROOT/$rel/DELTA.md"
    if [ -f "$delta" ]; then
      named="$(grep -oE 'SPEC-[0-9]+' "$delta" | sort -u || true)"
      if [ -z "$named" ]; then
        fail "$rel/DELTA.md names no SPEC-nnn"
      else
        found=0
        for id in $named; do
          if grep -qx "$id" <<< "$spec_ids"; then
            found=1
          fi
        done
        if [ "$found" -eq 0 ]; then
          fail "$rel/DELTA.md names no SPEC-nnn listed in $_SPEC_REL ($(printf '%s' "$named" | tr '\n' ' '))"
        fi
      fi
    fi

    if [ "$state" = active ] && [ -n "$change_days" ]; then
      if today_days="$(_today_days)"; then
        age=$((today_days - change_days))
        if [ "$age" -gt "$_CHANGE_STALE_DAYS" ]; then
          fail "$rel is stale: opened $age days ago (limit $_CHANGE_STALE_DAYS); archive it under $_CHANGES_REL/archive/ or open a fresh change"
        fi
      else
        unverified "cannot read today's date: staleness of $rel not judged"
      fi
    fi
  done <<< "$dirs"

  if [ -z "$_CHECK_VERDICT" ]; then
    if [ "$change_count" -eq 0 ]; then
      ok "no change directories (docs/changes/ opted in)"
    else
      ok "$change_count change(s) well formed"
    fi
  fi
}

# ── Run all checks ─────────────────────────────────────────────────────────────

echo
echo "doctrine guard: $(basename "$REPO_ROOT")"
echo "────────────────────────────────────────"

_selected changelog && { check_changelog_append_only; end_check; }
_selected forbidden && { check_forbidden_identifiers; end_check; }
_selected paths && { check_doctrine_paths; end_check; }
_selected visibility && { check_repo_visibility; end_check; }
_selected version && { check_version_tag_consistency; end_check; }
_selected spec && { check_spec_placeholders; end_check; }
_selected invariants && { check_invariants_bound; end_check; }
_selected traceability && { check_traceability; end_check; }
_selected changes && { check_changes; end_check; }
_selected freshness && { check_spec_freshness; end_check; }
_selected coverage && { check_spec_coverage; end_check; }
_selected integrity && { check_managed_integrity; end_check; }
_selected binary && { check_test_binary_resolution; end_check; }
_selected summary && { check_spec_health_summary; end_check; }

echo
echo "────────────────────────────────────────"
if [ "$FAILURES" -gt 0 ]; then
  echo "  [✗] doctrine FAILED: $PASSES passed, $FAILURES failed, $UNVERIFIED unverified"
elif [ "$STRICT" -eq 1 ] && [ "$UNVERIFIED" -gt 0 ]; then
  echo "  [✗] doctrine FAILED (--strict): $PASSES passed, $FAILURES failed, $UNVERIFIED unverified"
elif [ "$UNVERIFIED" -gt 0 ]; then
  echo "  [!] doctrine OK with unverified checks: $PASSES passed, $FAILURES failed, $UNVERIFIED unverified"
else
  echo "  [✓] doctrine OK: $PASSES passed, $FAILURES failed, $UNVERIFIED unverified"
fi

if [ -n "$FAILED_NAMES" ]; then
  printf '%s' "$FAILED_NAMES" | sed 's/^/      failed: /'
fi
if [ -n "$UNVERIFIED_NAMES" ]; then
  printf '%s' "$UNVERIFIED_NAMES" | sed 's/^/      unverified: /'
fi

if [ "$FAILURES" -gt 0 ] || { [ "$STRICT" -eq 1 ] && [ "$UNVERIFIED" -gt 0 ]; }; then
  exit 1
fi
exit 0
# 
