#!/usr/bin/env bash
# openquestion installer.
#
#   curl -fsSL https://raw.githubusercontent.com/PolderLabs/openquestion/main/install.sh | sh
#
# The repository is public, so no account or token is required. If you are
# signed in with gh it is used opportunistically; otherwise a plain git clone
# is enough.
#
# To install from a private fork or mirror:
#   curl -fsSL .../install.sh | REPO=owner/name sh
#
# Environment:
#   REPO     owner/name to install from        (default PolderLabs/openquestion)
#   REF      branch or tag                     (default main)
#   PREFIX   install root                       (default $HOME/.local)
#   VERSION  verify this exact ref              (e.g. v0.1.0)
#   NO_UPDATE_SELF  set to 1 to skip the PATH hint

set -eu

REPO="${REPO:-PolderLabs/openquestion}"
REF="${REF:-main}"
PREFIX="${PREFIX:-$HOME/.local}"
INSTALL_DIR="$PREFIX/share/openquestion"
BIN_DIR="$PREFIX/bin"

die() { printf 'error: %s\n' "$1" >&2; exit 1; }
info() { printf '  %s\n' "$1"; }

need_node() {
  command -v node >/dev/null 2>&1 || die "node is required (Node 20+). Install it, then re-run."
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$major" -ge 20 ] || die "Node 20+ is required; found $(node -v)."
}

# Fetch the repository, preferring gh (which can read a private repo with the
# caller's credentials) and falling back to a plain clone.
fetch_repo() {
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    info "cloning $REPO via gh"
    gh repo clone "$REPO" "$INSTALL_DIR" -- --depth 1 --branch "$REF" >/dev/null 2>&1 && return 0
    info "gh clone failed, falling back to a public clone"
  fi
  info "cloning $REPO via git"
  git clone --depth 1 --branch "$REF" "https://github.com/$REPO.git" "$INSTALL_DIR" >/dev/null 2>&1 \
    || die "could not clone $REPO at $REF.
    If $REPO is private, sign in first:
      gh auth login
    or use a token:
      REPO=owner/name with a reachable HTTPS clone."
}

verify_version() {
  [ -n "${VERSION:-}" ] || return 0
  [ -d "$INSTALL_DIR/.git" ] || return 0
  git -C "$INSTALL_DIR" fetch --depth 1 origin "refs/tags/$VERSION:refs/tags/$VERSION" >/dev/null 2>&1 \
    || die "version $VERSION not found in $REPO"
  git -C "$INSTALL_DIR" checkout -q "tags/$VERSION"
  info "checked out $VERSION"
}

main() {
  need_node

  command -v git >/dev/null 2>&1 || die "git is required."

  # Refuse to clobber an existing install that has local edits, rather than
  # silently discarding work the user may have made.
  if [ -d "$INSTALL_DIR/.git" ]; then
    if [ -n "$(git -C "$INSTALL_DIR" status --porcelain 2>/dev/null || true)" ]; then
      die "$INSTALL_DIR has uncommitted changes.
    Move or delete it, then re-run. Nothing was changed."
    fi
    info "updating existing install at $INSTALL_DIR"
    git -C "$INSTALL_DIR" fetch --depth 1 origin >/dev/null 2>&1 \
      || die "could not fetch updates for $INSTALL_DIR"
    git -C "$INSTALL_DIR" checkout -q "$REF" 2>/dev/null || true
    git -C "$INSTALL_DIR" reset --hard "origin/$REF" >/dev/null 2>&1 \
      || die "could not update $INSTALL_DIR to origin/$REF"
  else
    fetch_repo
  fi
  verify_version

  [ -f "$INSTALL_DIR/package.json" ] || die "install looks incomplete: no package.json in $INSTALL_DIR"

  # Marker so `oq update` knows this is an install it may reset, rather than a
  # working checkout someone is editing.
  printf 'installed by install.sh\n' > "$INSTALL_DIR/.openquestion-install"

  mkdir -p "$BIN_DIR"
  # A small launcher rather than a symlink, so the tool keeps working if the
  # install directory moves and so `oq update` can find its own root.
  cat > "$BIN_DIR/oq" <<EOF
#!/usr/bin/env sh
exec node "$INSTALL_DIR/src/cli/main.js" "\$@"
EOF
  chmod +x "$BIN_DIR/oq"

  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *)
      if [ "${NO_UPDATE_SELF:-0}" = "1" ]; then
        :
      else
        printf '\nAdd %s to your PATH:\n\n    export PATH="%s:$PATH"\n\n' "$BIN_DIR" "$BIN_DIR"
      fi
      ;;
  esac

  printf '\n'
  printf '  openquestion installed to %s\n' "$INSTALL_DIR"
  "$BIN_DIR/oq" --version | sed 's/^/  version /'
  printf '\n  Get started:\n\n'
  printf '    oq serve --project ~/code/my-project\n\n'
}

main "$@"
