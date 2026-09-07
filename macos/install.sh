#!/bin/bash
# Mint the importable Shortcut from the XML in this directory.
#
# A .shortcut file is a *signed binary* plist, so git can only hold the XML and the
# importable file has to be built. Cheap and idempotent — re-signing on every run is
# fine, and it means the Shortcut can never drift from the plist under review.
#
# `-m anyone` signs for distribution rather than for this Mac, which is what lets the
# file be imported at all without Shortcuts complaining about an unsigned workflow.
#
# This installs nothing else. The hooks are a settings.json snippet (see the root
# README) and the token file is one line you write by hand; there is deliberately no
# installer that edits your dotfiles.

set -euo pipefail

cd "$(dirname "$0")"

[ "$(uname)" = "Darwin" ] || {
  echo "macOS only — the Shortcut and its signer are Apple's." >&2
  exit 1
}

out="Share to CDN.shortcut" # gitignored: a build artifact, not source

plutil -convert binary1 share-to-cdn.plist -o .unsigned.shortcut
# `shortcuts sign` spews harmless ObjC runtime warnings on stderr; drop them.
shortcuts sign -m anyone -i .unsigned.shortcut -o "$out" 2>/dev/null
rm -f .unsigned.shortcut

echo "built: macos/$out"
echo
echo "next:"
echo "  1. open \"macos/$out\"  → Add Shortcut"
echo "  2. if you cloned this repo somewhere other than ~/code/cdn, edit the"
echo "     Script path in share-to-cdn.plist and re-run this"
echo "  3. macos/README.md has the GUI settings — a fresh import appears NOWHERE"
echo "     until you set them by hand"
