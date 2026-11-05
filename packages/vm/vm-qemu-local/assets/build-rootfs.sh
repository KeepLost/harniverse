#!/usr/bin/env bash
# Build the micro-VM world assets into <package>/.cache/assets (or $1):
#   vmlinuz-virt            — Alpine virt kernel (from the pinned linux-virt apk)
#   initramfs.cpio.gz       — Alpine minirootfs + the static guest agent as /init
#                             + the virtio_blk kernel module (data plane)
#                             + bash with its shared-library chain (tool shell)
#                             + the Landlock confinement wrapper as
#                             /bin/dsh-vm-confine (in-guest sandbox backend)
#   qemu-wrap               — host sandbox wrapper (Landlock + uid drop + rlimits)
#
# Requirements: curl, tar, gzip, cpio, find, sha256sum, and a Rust toolchain
# with the x86_64-unknown-linux-musl target (rustup target add
# x86_64-unknown-linux-musl). Offline reuse: drop the pinned upstream
# files into the download cache under their pinned names; their digests
# are still enforced. The wrapper
# needs a C compiler on Linux; without one the assets still build and
# `openWorld` reports `sandboxed: false`.
#
# The kernel comes from the linux-virt apk rather than the release directory:
# the CDN purges superseded release artifacts, while the versioned apk keeps
# the kernel and its virtio_blk module as one digest-pinned, vermagic-matched
# pair (block drivers are modules in the virt kernel, not built-ins).
#
# bash arrives the same way: the shell tools compose `bash -c` and persistent
# interactive bash over the world's subprocess seam, and busybox has no bash
# applet. The pinned chain is bash -> libreadline.so.8 -> libncursesw.so.6 ->
# musl (already in the minirootfs); terminfo-base keeps readline's pty mode
# from degrading to the dumb entry.
set -euo pipefail

readonly ALPINE_VERSION=3.20.3
readonly ALPINE_BASE="https://dl-cdn.alpinelinux.org/alpine/v3.20"
readonly MINIROOTFS="alpine-minirootfs-${ALPINE_VERSION}-x86_64.tar.gz"
# Upstream-published digest for the minirootfs; observed upstream digests for
# the apks (no sidecars are published for them).
readonly MINIROOTFS_SHA256="d4e6fd67dcf75e40c451560ac7265166c2b72a0f38ddc9aae756a7de3d1efa0c"
readonly LINUX_VIRT="linux-virt-6.6.142-r0.apk"
readonly LINUX_VIRT_SHA256="0d84e30c04c52426b0bf10b01616c45f7d0c5384a59552e4c4a6caeb13a3f6e7"
readonly LINUX_VIRT_KERNEL_MEMBER="boot/vmlinuz-virt"
readonly LINUX_VIRT_BLK_MODULE_MEMBER="lib/modules/6.6.142-0-virt/kernel/drivers/block/virtio_blk.ko.gz"
readonly BASH_APKS=(
  "bash-5.2.26-r0.apk 132bb6f77fcad208b44b54d1fd73cb5e02cfea18f884b399f8de0e38b5134a93"
  "readline-8.2.10-r0.apk 177b9c76718d0a12cd1c27f2a3e422341ad93259ad56d77f55da712563049aed"
  "libncursesw-6.4_p20240420-r2.apk db40dff96b7bb668257e45a5d14cab346bdfc7992598d5c51ee64dfc4ad014d5"
  "ncurses-terminfo-base-6.4_p20240420-r2.apk 555948e6b67d4bddc213673843a63bbd3d30548133bdff8aff9e66988285ae7e"
)

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

fetch "$MINIROOTFS" "${ALPINE_BASE}/releases/x86_64/${MINIROOTFS}" "$MINIROOTFS_SHA256"
fetch "$LINUX_VIRT" "${ALPINE_BASE}/main/x86_64/${LINUX_VIRT}" "$LINUX_VIRT_SHA256"
for entry in "${BASH_APKS[@]}"; do
  read -r apk digest <<<"$entry"
  fetch "$apk" "${ALPINE_BASE}/main/x86_64/${apk}" "$digest"
done

echo "build-rootfs: building guest agent (static musl)"
cargo build --release --target x86_64-unknown-linux-musl --target-dir "$target_dir" \
  --manifest-path "${package_dir}/guest/Cargo.toml" >&2
agent_bin="${target_dir}/x86_64-unknown-linux-musl/release/dsh-vm-guest-agent"
[[ -f $agent_bin ]] || { echo "build-rootfs: agent binary missing after cargo build" >&2; exit 1; }
confine_bin="${target_dir}/x86_64-unknown-linux-musl/release/dsh-vm-confine"
[[ -f $confine_bin ]] || { echo "build-rootfs: confinement wrapper missing after cargo build" >&2; exit 1; }

echo "build-rootfs: staging rootfs"
rm -rf "$rootfs_dir"
mkdir -p "$rootfs_dir"
tar -xzf "${download_dir}/${MINIROOTFS}" -C "$rootfs_dir"
install -m 0755 "$agent_bin" "${rootfs_dir}/init"
install -m 0755 "$confine_bin" "${rootfs_dir}/bin/dsh-vm-confine"
mkdir -p "${rootfs_dir}/dev" "${rootfs_dir}/proc" "${rootfs_dir}/tmp" "${rootfs_dir}/sys"

echo "build-rootfs: staging kernel and virtio_blk module from the apk"
apk_dir="${cache_dir}/apk"
mkdir -p "$apk_dir"
# The apk is a pax tar; the APK-TOOLS.* extended-header warnings are noise.
tar -xzf "${download_dir}/${LINUX_VIRT}" -C "$apk_dir" \
  "$LINUX_VIRT_KERNEL_MEMBER" "$LINUX_VIRT_BLK_MODULE_MEMBER" 2>/dev/null
cp "${apk_dir}/${LINUX_VIRT_KERNEL_MEMBER}" "${out_dir}/vmlinuz-virt"
mkdir -p "${rootfs_dir}/lib/modules"
gzip -dc "${apk_dir}/${LINUX_VIRT_BLK_MODULE_MEMBER}" > "${rootfs_dir}/lib/modules/virtio_blk.ko"

echo "build-rootfs: staging bash and its shared-library chain"
for entry in "${BASH_APKS[@]}"; do
  read -r apk _digest <<<"$entry"
  # Payload members only; the apk control files (.SIGN*, .PKGINFO, scripts)
  # belong to apk-tools, not to the world's filesystem.
  tar -xzf "${download_dir}/${apk}" -C "$rootfs_dir" \
    --exclude='.SIGN*' --exclude='.PKGINFO' --exclude='.pre-*' --exclude='.post-*' --exclude='.trigger*' 2>/dev/null
done

echo "build-rootfs: packing initramfs"
(cd "$rootfs_dir" && find . | cpio -o -H newc --quiet | gzip -9) > "${out_dir}/initramfs.cpio.gz"

if [[ $(uname -s) == Linux ]]; then
  if command -v cc >/dev/null 2>&1; then
    echo "build-rootfs: compiling qemu-wrap"
    cc -O2 -Wall -Wextra -o "${out_dir}/qemu-wrap" "${script_dir}/qemu-wrap.c"
  else
    echo "build-rootfs: cc not found; building without qemu-wrap (openWorld reports sandboxed: false)" >&2
  fi
fi

echo "build-rootfs: assets ready in ${out_dir}"
ls -l "${out_dir}"
