#!/usr/bin/env bash
# Build an arm64 (or any native) VS Agent image from the verana-labs/vs-agent sources.
# The published veranalabs/vs-agent images are amd64-only; hosts without x86 emulation in
# containers (Asahi Linux, Graviton) build their own. Usage:
#   dev/tools/build-vs-agent-image.sh [git-ref] [tag]      (defaults: origin/main, vs-agent:local-arm64)
set -euo pipefail
REF="${1:-origin/main}"; TAG="${2:-vs-agent:local-arm64}"
SRC="${VS_AGENT_SRC:-$HOME/git/github/verana-labs/vs-agent}"
WORK="$(mktemp -d)"
git -C "$SRC" fetch -q origin
git -C "$SRC" worktree add -q --detach "$WORK" "$REF"
trap 'git -C "$SRC" worktree remove --force "$WORK"' EXIT
echo "building $TAG from $(git -C "$WORK" log --oneline -1)"
docker build --target vs-agent -t "$TAG" -f apps/vs-agent/Dockerfile "$WORK"
