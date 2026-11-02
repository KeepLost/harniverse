#!/usr/bin/env bash
# Build the micro-VM world assets into <package>/.cache/assets (or $1):
#   vmlinuz-virt            — Alpine virt kernel (pinned 3.20.3)
#   initramfs.cpio.gz       — Alpine minirootfs + the static guest agent as /init
#
# Requirements: curl, tar, gzip, cpio, find, sha256sum, and a Rust toolchain
# with the x86_64-unknown-linux-musl target (rustup target add
# x86_64-unknown-linux-musl). Offline reuse: drop the two pinned upstream
# files into the download cache named alpine-minirootfs-3.20.3-x86_64.tar.gz
# and vmlinuz-virt; their digests are still enforced.
set -euo pipefail

readonly ALPINE_VERSION=3.20.3
readonly ALPINE_BASE="https://dl-cdn.alpinelinux.org/alpine/v3.20/releases/x86_64"
readonly MINIROOTFS="alpine-minirootfs-${ALPINE_VERSION}-x86_64.tar.gz"
# Upstream-published digest for the minirootfs; observed upstream digest for
# the kernel release artifact (no sidecar is published for it).
readonly MINIROOTFS_SHA256="d4e6fd67dcf75e40c451560ac7265166c2b72a0f38ddc9aae756a7de3d1efa0c"
readonly VMLINUZ_SHA256="1bd27a89309e05f4f05ec63be4a81bf3a90a3f59334cf4114ec90966dd0bf8bd"

script_dir="$(cd "$(dirname "$0")" && pwd)"
package_dir="$(dirname "$script_dir")"
cache_dir="${package_dir}/.cache"
download_dir="${cache_dir}/downloads"
rootfs_dir="${cache_dir}/rootfs"
target_dir="${cache_dir}/guest-target"
out_dir="${1:-${cache_dir}/assets}"

need() { command -v "$1" >/dev/null 2>&1 || { echo "build-rootfs: missing tool: $1" >&2; exit 1; }; }
need curl; need tar; need gzip; need cpio; need find; need sha256sum; need cargo

fetch() {
  local name="$1" url="$2" digest="$3"
  local path="${download_dir}/${name}"
  if [[ ! -f $path ]]; then
    echo "build-rootfs: downloading ${name}"
    curl -fL --retry 3 -o "${path}.part" "$url"
    mv "${path}.part" "$path"
  fi
  echo "${digest}  ${path}" | sha256sum -c - >/dev/null
}

mkdir -p "$download_dir" "$out_dir" "$target_dir"

fetch "$MINIROOTFS" "${ALPINE_BASE}/${MINIROOTFS}" "$MINIROOTFS_SHA256"
fetch vmlinuz-virt "${ALPINE_BASE}/vmlinuz-virt" "$VMLINUZ_SHA256"

echo "build-rootfs: building guest agent (static musl)"
cargo build --release --target x86_64-unknown-linux-musl --target-dir "$target_dir" \
  --manifest-path "${package_dir}/guest/Cargo.toml" >&2
agent_bin="${target_dir}/x86_64-unknown-linux-musl/release/dsh-vm-guest-agent"
[[ -f $agent_bin ]] || { echo "build-rootfs: agent binary missing after cargo build" >&2; exit 1; }

echo "build-rootfs: staging rootfs"
rm -rf "$rootfs_dir"
mkdir -p "$rootfs_dir"
tar -xzf "${download_dir}/${MINIROOTFS}" -C "$rootfs_dir"
install -m 0755 "$agent_bin" "${rootfs_dir}/init"
mkdir -p "${rootfs_dir}/dev" "${rootfs_dir}/proc" "${rootfs_dir}/tmp" "${rootfs_dir}/sys"

echo "build-rootfs: packing initramfs"
(cd "$rootfs_dir" && find . | cpio -o -H newc --quiet | gzip -9) > "${out_dir}/initramfs.cpio.gz"
cp "${download_dir}/vmlinuz-virt" "${out_dir}/vmlinuz-virt"

echo "build-rootfs: assets ready in ${out_dir}"
ls -l "${out_dir}"
