#!/usr/bin/env bash
# Pure target selection, shared by the native recipe and its host-policy tests.
select_linux_media_target() {
  case "$1" in
    x86_64) TARGET_ARCH=x64; BUILD_DISTRO=ubuntu; BUILD_VERSION=24.04 ;;
    aarch64|arm64) TARGET_ARCH=arm64; BUILD_DISTRO=debian; BUILD_VERSION=12 ;;
    *) printf 'ERROR: Linux media tools require x86_64 or aarch64, not %s. Use a 64-bit OS and Node.js.\n' "$1" >&2; return 1 ;;
  esac
  TARGET="linux-$TARGET_ARCH"
}

linux_media_baseline_matches() {
  [[ "$1" == "$BUILD_DISTRO" && "$2" == "$BUILD_VERSION" ]]
}

linux_media_build_jobs() {
  local requested="${1:-}"
  if [[ -z "$requested" ]]; then
    if [[ "$TARGET_ARCH" == arm64 ]]; then requested=2
    else requested="$(getconf _NPROCESSORS_ONLN 2>/dev/null || printf '4')"; fi
  fi
  [[ "$requested" =~ ^[1-9][0-9]*$ ]] || {
    printf 'ERROR: MYNDA_MEDIA_BUILD_JOBS must be a positive integer.\n' >&2
    return 1
  }
  printf '%s\n' "$requested"
}
