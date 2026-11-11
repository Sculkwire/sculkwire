#!/bin/sh
# Install sculkwire on Linux or macOS: the newest release into a managed folder (updated automatically), `sculk` on
# PATH, then `sculk setup`. Run it from a clone (./install.sh) or piped (curl -fsSL .../install.sh | sh). install.ps1
# is the Windows twin: same options, prompts and output.
set -eu

REPO="${SCULKWIRE_REPO:-https://github.com/Sculkwire/sculkwire.git}"
REPO_GIVEN=0
[ -n "${SCULKWIRE_REPO:-}" ] && REPO_GIVEN=1
YES="${SCULKWIRE_YES:-0}"
REGISTER="${SCULKWIRE_REGISTER:-}"
REGISTER_GIVEN=0
[ -n "$REGISTER" ] && REGISTER_GIVEN=1
CHANNEL="${SCULKWIRE_CHANNEL:-}"
NO_PATH="${SCULKWIRE_NO_PATH:-0}"

usage() {
  cat >&2 <<'EOF'
Usage: install.sh [--yes] [--register omp,claude] [--channel release|main|off] [--repo URL] [--no-path]

  --yes       ask nothing (no client registration unless --register)
  --register  MCP clients to register sculkwire with (omp, claude). The JSON for any other client is printed
  --channel   update channel: release (default), main, or off for no automatic updates
  --repo      git URL or local path to install from (default https://github.com/Sculkwire/sculkwire.git)
  --no-path   do not put sculk on PATH (default: a symlink in $SCULKWIRE_BIN_DIR, else ~/.local/bin)

Every option can also come from the environment, which works when the script is piped: SCULKWIRE_YES=1,
SCULKWIRE_REGISTER, SCULKWIRE_CHANNEL, SCULKWIRE_REPO, SCULKWIRE_NO_PATH=1.
EOF
}

die() {
  printf 'sculkwire install: %s\n' "$1" >&2
  exit 2
}
say() { printf '%s\n' "$1" >&2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --yes | -y) YES=1 ;;
    --no-path) NO_PATH=1 ;;
    --register | --channel | --repo)
      [ $# -ge 2 ] || die "$1 needs a value"
      opt="$1"
      shift
      case "$opt" in
        --register) REGISTER="$1" REGISTER_GIVEN=1 ;;
        --channel) CHANNEL="$1" ;;
        --repo) REPO="$1" REPO_GIVEN=1 ;;
      esac
      ;;
    --register=*) REGISTER="${1#*=}" REGISTER_GIVEN=1 ;;
    --channel=*) CHANNEL="${1#*=}" ;;
    --repo=*) REPO="${1#*=}" REPO_GIVEN=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage
      die "unknown argument $1"
      ;;
  esac
  shift
done

case "$CHANNEL" in "" | release | main | off) ;; *) die "--channel must be release, main or off" ;; esac

command -v git >/dev/null 2>&1 || die "git is required: install it from https://git-scm.com"
command -v node >/dev/null 2>&1 || die "Node.js 22.18 or newer is required: install it from https://nodejs.org"
command -v npm >/dev/null 2>&1 || die "npm is required (it comes with Node.js)"
node -e 'const m=Number(process.versions.node.split(".")[0]); process.exit(m >= 22 && process.features.typescript ? 0 : 1)' ||
  die "Node.js $(node --version) cannot run sculkwire: install Node.js 22.18 or newer"

# Source of the installer code: the clone this script runs from, or a fresh shallow clone.
SRC=""
case "$0" in
  *install.sh)
    dir=$(cd "$(dirname "$0")" && pwd)
    [ -f "$dir/src/update/bootstrap.ts" ] && SRC="$dir"
    ;;
esac
if [ -z "$SRC" ]; then
  TMP=$(mktemp -d)
  trap 'rm -rf "$TMP"' EXIT INT TERM
  say "Downloading sculkwire from $REPO"
  GIT_TERMINAL_PROMPT=0 git clone --quiet --depth 1 "$REPO" "$TMP/sculkwire" ||
    die "git clone $REPO failed. Check the network, the --repo URL, or your git credentials for a private fork"
  SRC="$TMP/sculkwire"
  REPO_GIVEN=1
fi

set -- --install
[ -n "$CHANNEL" ] && set -- "$@" --channel "$CHANNEL"
[ "$REPO_GIVEN" = 1 ] && set -- "$@" --repo "$REPO"
say "Installing the newest sculkwire release (this runs npm ci, about a minute)"
LAUNCHER=$(node "$SRC/src/update/bootstrap.ts" "$@") || die "installing sculkwire failed (see the message above)"

if [ "$NO_PATH" = 1 ]; then
  say "Left PATH unchanged (--no-path). Run sculkwire as $LAUNCHER"
else
  BIN_DIR="${SCULKWIRE_BIN_DIR:-$HOME/.local/bin}"
  say "Linking $BIN_DIR/sculk -> $LAUNCHER (--no-path skips this)"
  mkdir -p "$BIN_DIR"
  ln -sf "$LAUNCHER" "$BIN_DIR/sculk"
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) say "$BIN_DIR is not on PATH. Add this line to your shell profile: export PATH=\"$BIN_DIR:\$PATH\"" ;;
  esac
fi

# Questions go to the terminal even when this script arrives through a pipe.
TTY=0
if [ "$YES" != 1 ] && (: </dev/tty) 2>/dev/null; then TTY=1; fi

if [ "$REGISTER_GIVEN" = 0 ] && [ "$TTY" = 1 ]; then
  detected=""
  [ -d "$HOME/.omp" ] && detected="omp"
  command -v claude >/dev/null 2>&1 && detected="${detected:+$detected,}claude"
  printf 'Register sculkwire with which MCP clients? (omp, claude, comma separated, or none) [%s]: ' "${detected:-none}" >&2
  read -r answer </dev/tty || answer=""
  REGISTER="${answer:-${detected:-none}}"
fi

set -- setup --yes
[ -n "$REGISTER" ] && set -- "$@" --register "$REGISTER"
"$LAUNCHER" "$@" || die "sculk setup failed"

say ""
say "sculkwire is installed. Check it with: sculk doctor"
