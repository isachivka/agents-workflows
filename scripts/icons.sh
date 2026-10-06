#!/bin/sh
# Regenerates the raster icons from the SVGs in ui/icons. A maintainer tool, not used by flowd:
# needs rsvg-convert and ImageMagick (brew install librsvg imagemagick).
set -eu
ui="$(cd "$(dirname "$0")/../ui" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
for s in 16 32 48; do rsvg-convert -w "$s" -h "$s" "$ui/icons/favicon.svg" -o "$tmp/$s.png"; done
magick "$tmp/16.png" "$tmp/32.png" "$tmp/48.png" "$ui/favicon.ico"
rsvg-convert -w 192 -h 192 "$ui/icons/favicon.svg" -o "$ui/icons/icon-192.png"
rsvg-convert -w 512 -h 512 "$ui/icons/favicon.svg" -o "$ui/icons/icon-512.png"
rsvg-convert -w 180 -h 180 "$ui/icons/icon-fullbleed.svg" -o "$ui/icons/apple-touch-icon.png"
rsvg-convert -w 512 -h 512 "$ui/icons/icon-fullbleed.svg" -o "$ui/icons/icon-maskable-512.png"
