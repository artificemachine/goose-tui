#!/usr/bin/env bash
#
# build.sh — Compile rossii into a standalone binary for GitHub Releases
#
# Produces a named binary: rossii-<version>-<os>-<arch>, where <os> and <arch>
# are the host that compiled it (rossii-1.0.0-linux-x86_64,
# rossii-1.0.0-darwin-arm64). The name describes the artifact, never a target:
# see "Name the artifact after the host" below.
#
# Requires: bun (https://bun.sh)
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Read version from package.json
VERSION="$(grep '"version"' package.json | sed 's/.*"version": *"\([^"]*\)".*/\1/')"

# What the released binary is allowed to ask for at runtime. A glibc `bun`
# build links nothing but glibc's own libraries and bakes in the loader path
# every glibc distribution has. A bun from another source bakes in ITS loader
# instead: the released 2.0.2 … 3.0.0 binaries asked for
# /home/linuxbrew/.linuxbrew/lib/ld.so and started on no machine but the one
# that built them (verified: failed in a clean debian:11 container, while the
# current artifact runs there).
EXPECTED_LOADER="/lib64/ld-linux-x86-64.so.2"
GLIBC_LIBS_RE='libc\.so|ld-linux-x86-64|libpthread\.so|libdl\.so|libm\.so'

# The runtime embedded here is the whole artifact: ~2.5 MB of rossii's own JS on
# top of whichever bun compiles it (80.8 MB for 1.4.0, 107.3 MB for 1.4.4 — that
# is the entire 61.7 → 79.5 → 105 MiB story of this repository's releases). So
# the compiler is part of the build output and gets printed with it.
BUN_REVISION="$(bun --revision 2>/dev/null || bun --version)"

die() {
  echo ""
  echo "  ✖ ${1}"
  echo "    ${2}"
  # ${OUTFILE:-} because a failure can happen before the name is derived.
  rm -f "${OUTFILE:-}" "${OUTFILE:-}.sha256"
  exit 1
}

# ─── Name the artifact after the host that compiled it ───────────────────────
# `--target` is deliberately not used (see the compile step), so bun always
# compiles for the host it runs on. A hardcoded label therefore described a build
# that never existed: on macOS it named a Mach-O arm64 binary
# `…-linux-x86_64`, and the loader gate below then died on a file whose name
# promised glibc. The name follows `uname` because the binary does.
case "$(uname -s)" in
  Linux)  OS="linux" ;;
  Darwin) OS="darwin" ;;
  *) die "unsupported build host '$(uname -s)'" \
        "An artifact name states the platform it runs on; add a mapping for '$(uname -s)' before building." ;;
esac
case "$(uname -m)" in
  x86_64|amd64)  ARCH="x86_64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *) die "unsupported build architecture '$(uname -m)'" \
        "Add a mapping for '$(uname -m)' before building." ;;
esac
OUTFILE="rossii-${VERSION}-${OS}-${ARCH}"

echo "==> Installing dependencies..."
bun install --frozen-lockfile 2>/dev/null || bun install

# Deliberately no --target: it does not merely pick a runtime, it DOWNLOADS the
# official release for that target and can replace the installed bun with it
# (observed: 1.4.0 → 1.4.4 mid-session, artifacts 83.4 MB → 105 MB). An
# explicit `bun-linux-x64` on an x86_64 host is what bun does anyway.
echo "==> Compiling ${OUTFILE} with bun ${BUN_REVISION}..."
bun build --compile src/index.ts --outfile "${OUTFILE}"

if [ "${OS}" = "linux" ]; then
  echo "==> Checking the binary can run outside this machine..."
  # LC_ALL=C is not decoration: without it readelf TRANSLATES the one line this
  # check parses ("[Requesting program interpreter: …]"), the parse quietly comes
  # back empty, and the check passes on nothing.
  LOADER="$(LC_ALL=C readelf -lW "${OUTFILE}" 2>/dev/null | sed -n 's/.*interpreter: \(.*\)\]$/\1/p' | head -1)"
  if [ -z "${LOADER}" ]; then
    LOADER="$(LC_ALL=C file -b "${OUTFILE}" | sed -n 's/.*interpreter \([^,]*\),.*/\1/p')"
  fi
  if [ "${LOADER}" != "${EXPECTED_LOADER}" ]; then
    die "${OUTFILE} asks for the loader '${LOADER:-<none>}' (bun ${BUN_REVISION})" \
        "Expected ${EXPECTED_LOADER} — that is what every glibc Linux has. Use the official bun (https://bun.sh), not a distribution or Homebrew build of it."
  fi

  NEEDED="$(LC_ALL=C readelf -dW "${OUTFILE}" 2>/dev/null | sed -n 's/.*NEEDED.*\[\(.*\)\]$/\1/p')"
  if echo "${NEEDED}" | grep -qE 'libstdc\+\+|libc\.musl'; then
    die "${OUTFILE} needs a C++ or musl runtime: $(echo "${NEEDED}" | tr '\n' ' ')" \
        "Only glibc's own libraries belong in a glibc bun build. Use the official bun (https://bun.sh)."
  fi
  UNEXPECTED="$(echo "${NEEDED}" | grep -vE "${GLIBC_LIBS_RE}" || true)"
  if [ -n "${UNEXPECTED}" ]; then
    printf "  ! Unexpected NEEDED entries, check portability: %s\n" "$(echo "${UNEXPECTED}" | tr '\n' ' ')"
  fi
else
  # The gate reads an ELF interpreter and DT_NEEDED: it is a statement about
  # glibc Linux, and `readelf` does not exist on macOS. Applying it to a darwin
  # build reported 'asks for the loader <none>' on a binary that was fine.
  echo "==> Skipping the glibc loader check (${OS} build, ELF-only gate)"
fi

# A published <asset>.sha256 is what install-release.sh prefers over the digest
# GitHub reports, and it is what a user verifies by hand; write it next to the
# binary in the `sha256sum` format so `sha256sum -c` works as well. Written after
# the checks above, so a binary that fails them never gets one.
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "${OUTFILE}" > "${OUTFILE}.sha256"
elif command -v shasum >/dev/null 2>&1; then
  # macOS: `shasum -a 256` prints the same "<hash>  <file>" line, so
  # install-release.sh and the release workflow parse it unchanged.
  shasum -a 256 "${OUTFILE}" > "${OUTFILE}.sha256"
fi

echo ""
echo "  ✓ Done! ./${OUTFILE} is ready"
printf "  %s\n" "$(LC_ALL=C file -b "${OUTFILE}")"
printf "  Compiler: bun %s\n" "${BUN_REVISION}"
if [ "${OS}" = "linux" ]; then
  printf "  Loader: %s\n" "${LOADER}"
fi
printf "  Size: %s\n" "$(du -h "${OUTFILE}" | cut -f1)"
[ -f "${OUTFILE}.sha256" ] && printf "  %s\n" "$(cat "${OUTFILE}.sha256")"
echo ""
echo "  Run: ./${OUTFILE}"
echo "  For GitHub: upload ${OUTFILE}$([ -f "${OUTFILE}.sha256" ] && echo " and ${OUTFILE}.sha256") to a release"
