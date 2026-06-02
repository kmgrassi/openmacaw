#!/bin/sh
set -eu

REPO="${LOCAL_RUNTIME_HELPER_REPO:-kmgrassi/local-runtime-helper}"
VERSION="${LOCAL_RUNTIME_HELPER_VERSION:-latest}"
INSTALL_DIR="${LOCAL_RUNTIME_HELPER_INSTALL_DIR:-$HOME/.local/bin}"
BASE_URL="${LOCAL_RUNTIME_HELPER_BASE_URL:-}"
BINARY="local-runtime-helper"

usage() {
  cat <<'USAGE'
Install local-runtime-helper.

Usage:
  install.sh [--version <tag>] [--install-dir <dir>]

Options:
  --version <tag>       Install a specific release tag, for example v0.1.0.
                        Defaults to the latest GitHub release.
  --install-dir <dir>   Directory to install into. Defaults to ~/.local/bin.
USAGE
}

fail() {
  printf 'local-runtime-helper install: %s\n' "$1" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

download() {
  url="$1"
  dest="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$dest"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$dest" "$url"
  else
    fail "missing required command: curl or wget"
  fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || fail "--version requires a value"
      VERSION="$2"
      shift 2
      ;;
    --install-dir)
      [ "$#" -ge 2 ] || fail "--install-dir requires a value"
      INSTALL_DIR="$2"
      shift 2
      ;;
    --base-url)
      [ "$#" -ge 2 ] || fail "--base-url requires a value"
      BASE_URL="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown option: $1"
      ;;
  esac
done

os="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch="$(uname -m)"

case "$os" in
  darwin|linux) ;;
  *) fail "unsupported operating system: $os" ;;
esac

case "$arch" in
  x86_64|amd64) arch="amd64" ;;
  arm64|aarch64) arch="arm64" ;;
  *) fail "unsupported architecture: $arch" ;;
esac

need_cmd tar
need_cmd mktemp
need_cmd install

asset="${BINARY}_${os}_${arch}.tar.gz"
if [ -z "$BASE_URL" ]; then
  if [ "$VERSION" = "latest" ]; then
    BASE_URL="https://github.com/${REPO}/releases/latest/download"
  else
    BASE_URL="https://github.com/${REPO}/releases/download/${VERSION}"
  fi
fi

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT INT HUP TERM

archive="$tmpdir/$asset"
checksums="$tmpdir/checksums.txt"

printf 'Downloading %s from %s...\n' "$asset" "$REPO"
download "$BASE_URL/$asset" "$archive"
download "$BASE_URL/checksums.txt" "$checksums"

expected_line="$(grep "  ${asset}$" "$checksums" || true)"
[ -n "$expected_line" ] || fail "${asset} is missing from checksums.txt"

expected_sum="$(printf '%s\n' "$expected_line" | awk '{print $1}')"
if command -v sha256sum >/dev/null 2>&1; then
  actual_sum="$(sha256sum "$archive" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  actual_sum="$(shasum -a 256 "$archive" | awk '{print $1}')"
else
  fail "missing required command: sha256sum or shasum"
fi

[ "$actual_sum" = "$expected_sum" ] || fail "checksum mismatch for ${asset}"

tar -xzf "$archive" -C "$tmpdir" "$BINARY"
mkdir -p "$INSTALL_DIR"
install -m 0755 "$tmpdir/$BINARY" "$INSTALL_DIR/$BINARY"

printf '\nInstalled %s to %s/%s\n' "$BINARY" "$INSTALL_DIR" "$BINARY"
"$INSTALL_DIR/$BINARY" --version

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    printf '\nAdd %s to your PATH before running local-runtime-helper from a new shell.\n' "$INSTALL_DIR"
    ;;
esac

cat <<EOF

Next steps:
  1. Register this machine with the command from Harper's Local computer setup page.
  2. Configure a local OpenAI-compatible runner in ~/.config/harper/runtime.toml.
  3. Start the helper:
       local-runtime-helper start
EOF
