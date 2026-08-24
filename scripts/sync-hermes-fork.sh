#!/usr/bin/env bash
# Synchronize Billy's Hermes fork with upstream while preserving the narrow
# private-Tailscale maintenance patch. This script never builds, installs,
# quits, or launches Hermes Desktop.

set -Eeuo pipefail

SCRIPT_NAME="$(basename "$0")"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

UPSTREAM_SLUG="${HERMES_UPSTREAM_SLUG:-nousresearch/hermes-agent}"
FORK_SLUG="${HERMES_FORK_SLUG:-billyhargroveofficial/hermes-agent}"
MAIN_BRANCH="${HERMES_MAIN_BRANCH:-main}"
MAINTENANCE_BRANCH="${HERMES_MAINTENANCE_BRANCH:-codex/tailscale-maintenance}"

CHECK_ONLY=0
DRY_RUN=0
STASH_DIRTY=0
PUSH_CHANGES=1
ORIGINAL_BRANCH=""
STASH_CREATED=0
STASH_REF=""

log() { printf '[hermes-sync] %s\n' "$*"; }
warn() { printf '[hermes-sync] warning: %s\n' "$*" >&2; }
die() { printf '[hermes-sync] error: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<EOF
Usage: $SCRIPT_NAME [options]

Synchronize local $MAIN_BRANCH with upstream and merge it into
$MAINTENANCE_BRANCH. This is source-only: /Applications/Hermes Desktop.app
and its saved data are never touched or launched.

Options:
  --check          Query remote refs and report state without fetch/mutation.
  --stash-dirty    Stash tracked and untracked edits, then restore them.
  --allow-dirty    Alias for --stash-dirty.
  --dry-run        Validate and print the synchronization plan only.
  --no-push        Update local branches only; do not push the fork.
  --help           Show this help.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) CHECK_ONLY=1 ;;
    --stash-dirty|--allow-dirty) STASH_DIRTY=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --no-push) PUSH_CHANGES=0 ;;
    --help|-h) usage; exit 0 ;;
    *) die "unknown option: $1 (use --help)" ;;
  esac
  shift
done

git_cmd() { git -C "$REPO_ROOT" "$@"; }

remote_url() {
  git_cmd remote get-url "$1" 2>/dev/null || true
}

url_matches_github_slug() {
  local url="$1" slug="$2" repo normalized
  case "$url" in
    git@github.com:*) repo="${url#git@github.com:}" ;;
    ssh://git@github.com/*) repo="${url#ssh://git@github.com/}" ;;
    ssh://github.com/*) repo="${url#ssh://github.com/}" ;;
    https://github.com/*) repo="${url#https://github.com/}" ;;
    *) return 1 ;;
  esac
  repo="${repo%/}"
  repo="${repo%.git}"
  normalized="$(printf '%s' "$repo" | tr '[:upper:]' '[:lower:]')"
  slug="$(printf '%s' "$slug" | tr '[:upper:]' '[:lower:]')"
  [[ "$normalized" == "$slug" ]]
}

require_repo() {
  git_cmd rev-parse --show-toplevel >/dev/null 2>&1 \
    || die "not a Git checkout: $REPO_ROOT"
  REPO_ROOT="$(git_cmd rev-parse --show-toplevel)"
  ORIGINAL_BRANCH="$(git_cmd symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  [[ -n "$ORIGINAL_BRANCH" ]] || die "a named branch is required; detached HEAD is not safe"
  git_cmd show-ref --verify --quiet "refs/heads/$MAIN_BRANCH" \
    || die "local branch is missing: $MAIN_BRANCH"
  git_cmd show-ref --verify --quiet "refs/heads/$MAINTENANCE_BRANCH" \
    || die "local branch is missing: $MAINTENANCE_BRANCH"
}

verify_remotes() {
  local upstream origin
  upstream="$(remote_url upstream)"
  origin="$(remote_url origin)"
  url_matches_github_slug "$upstream" "$UPSTREAM_SLUG" \
    || die "upstream is not the configured repository: $UPSTREAM_SLUG"
  url_matches_github_slug "$origin" "$FORK_SLUG" \
    || die "origin is not the configured fork: $FORK_SLUG"
}

working_tree_dirty() {
  [[ -n "$(git_cmd status --porcelain=v1 --untracked-files=all)" ]]
}

stash_dirty_tree() {
  working_tree_dirty || return 0
  [[ "$STASH_DIRTY" == 1 ]] \
    || die "working tree is dirty; commit it or pass --stash-dirty"
  if [[ "$DRY_RUN" == 1 ]]; then
    log "dry-run: would stash tracked/untracked changes and restore them"
    return 0
  fi

  local message output rc=0 match
  message="hermes-source-sync-$(date -u +%Y%m%dT%H%M%SZ)-$$-${RANDOM}"
  log "stashing dirty source tree ($message)"
  if output="$(git_cmd stash push --include-untracked --message "$message" 2>&1)"; then
    rc=0
  else
    rc=$?
  fi
  [[ -z "$output" ]] || printf '%s\n' "$output"
  match="$(git_cmd stash list --format='%H%x09%gs' | awk -F '\t' -v needle="$message" 'index($2, needle) { print $1; exit }')"
  [[ -n "$match" ]] \
    || die "could not verify the updater-owned stash; no existing stash was touched"
  STASH_CREATED=1
  STASH_REF="$match"
  [[ "$rc" == 0 ]] \
    || die "source changes were preserved at $STASH_REF, but the worktree could not be cleaned"
}

restore_original_branch() {
  local current
  current="$(git_cmd symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  [[ "$current" == "$ORIGINAL_BRANCH" ]] && return 0
  log "returning to $ORIGINAL_BRANCH"
  git_cmd switch --quiet "$ORIGINAL_BRANCH"
}

restore_stash() {
  local commit drop_ref
  [[ "$STASH_CREATED" == 1 ]] || return 0
  commit="$(git_cmd rev-parse "$STASH_REF" 2>/dev/null || true)"
  [[ -n "$commit" ]] || { warn "updater stash was kept at $STASH_REF"; return 1; }
  log "restoring source edits from $STASH_REF"
  git_cmd stash apply --index "$commit" \
    || { warn "stash restoration conflicted; stash kept at $STASH_REF"; return 1; }
  drop_ref="$(git_cmd stash list --format='%gd %H' | awk -v target="$commit" '$2 == target { print $1; exit }')"
  [[ -n "$drop_ref" ]] \
    || { warn "source restored, but stash could not be located for cleanup"; return 1; }
  git_cmd stash drop "$drop_ref"
  STASH_CREATED=0
}

finish() {
  local rc=$?
  trap - EXIT
  if ! restore_original_branch; then
    rc=1
    [[ "$STASH_CREATED" == 0 ]] \
      || warn "source stash remains preserved at $STASH_REF because the original branch could not be restored"
  else
    restore_stash || rc=1
  fi
  exit "$rc"
}

remote_branch_sha() {
  local remote="$1" branch="$2" line slug encoded sha

  case "$remote" in
    upstream) slug="$UPSTREAM_SLUG" ;;
    origin) slug="$FORK_SLUG" ;;
    *) slug="" ;;
  esac

  # Prefer the authenticated GitHub API when available. Repeated anonymous or
  # SSH upload-pack probes can be temporarily throttled even while normal API
  # access remains healthy, turning a read-only updater check into a long hang.
  if [[ -n "$slug" ]] && command -v gh >/dev/null 2>&1; then
    encoded="${branch//\//%2F}"
    if sha="$(gh api "repos/$slug/git/ref/heads/$encoded" --jq '.object.sha' 2>/dev/null)" \
      && [[ "$sha" =~ ^[0-9a-f]{40}$ ]]; then
      printf '%s\n' "$sha"
      return 0
    fi
  fi

  line="$(git_cmd ls-remote --heads "$remote" "refs/heads/$branch")" \
    || return 1
  printf '%s\n' "${line%%[[:space:]]*}"
}

check_state() {
  local upstream_sha origin_maintenance_sha local_main local_maintenance dirty_count
  upstream_sha="$(remote_branch_sha upstream "$MAIN_BRANCH")" \
    || die "could not query upstream/$MAIN_BRANCH"
  [[ -n "$upstream_sha" ]] || die "upstream/$MAIN_BRANCH does not exist"
  origin_maintenance_sha="$(remote_branch_sha origin "$MAINTENANCE_BRANCH")" \
    || die "could not query origin/$MAINTENANCE_BRANCH"
  local_main="$(git_cmd rev-parse "$MAIN_BRANCH")"
  local_maintenance="$(git_cmd rev-parse "$MAINTENANCE_BRANCH")"
  dirty_count="$(git_cmd status --porcelain=v1 --untracked-files=all | wc -l | tr -d ' ')"

  printf 'local %-29s %.12s\n' "$MAIN_BRANCH" "$local_main"
  printf 'upstream/%-26s %.12s\n' "$MAIN_BRANCH" "$upstream_sha"
  printf 'local %-29s %.12s\n' "$MAINTENANCE_BRANCH" "$local_maintenance"
  if [[ -n "$origin_maintenance_sha" ]]; then
    printf 'origin/%-24s %.12s\n' "$MAINTENANCE_BRANCH" "$origin_maintenance_sha"
  else
    printf 'origin/%-24s %s\n' "$MAINTENANCE_BRANCH" 'not published'
  fi
  printf 'worktree changes              %s\n' "$dirty_count"
}

sync_source() {
  local origin_maintenance_sha remote_ref="refs/remotes/origin/$MAINTENANCE_BRANCH"
  log "fetching upstream/$MAIN_BRANCH"
  git_cmd fetch --prune upstream "$MAIN_BRANCH"
  origin_maintenance_sha="$(remote_branch_sha origin "$MAINTENANCE_BRANCH")" \
    || die "could not query origin/$MAINTENANCE_BRANCH"
  if [[ -n "$origin_maintenance_sha" ]]; then
    log "fetching origin/$MAINTENANCE_BRANCH"
    git_cmd fetch --prune origin "$MAINTENANCE_BRANCH"
  else
    git_cmd update-ref -d "$remote_ref"
  fi

  log "fast-forwarding $MAIN_BRANCH"
  git_cmd switch --quiet "$MAIN_BRANCH"
  git_cmd merge --ff-only "upstream/$MAIN_BRANCH"

  log "merging upstream into $MAINTENANCE_BRANCH without rewriting its patch"
  git_cmd switch --quiet "$MAINTENANCE_BRANCH"
  if git_cmd show-ref --verify --quiet "$remote_ref"; then
    if ! git_cmd merge --no-edit "origin/$MAINTENANCE_BRANCH"; then
      git_cmd merge --abort || true
      die "origin/$MAINTENANCE_BRANCH conflicts with local maintenance commits"
    fi
  fi
  if ! git_cmd merge --no-edit "$MAIN_BRANCH"; then
    local conflicts
    conflicts="$(git_cmd diff --name-only --diff-filter=U | paste -sd ', ' -)"
    git_cmd merge --abort || true
    die "upstream merge conflicts in: ${conflicts:-unknown}"
  fi

  if [[ "$PUSH_CHANGES" == 1 ]]; then
    log "atomically pushing $MAIN_BRANCH and $MAINTENANCE_BRANCH to the fork"
    git_cmd push --atomic origin \
      "$MAIN_BRANCH:$MAIN_BRANCH" \
      "$MAINTENANCE_BRANCH:$MAINTENANCE_BRANCH"
  fi
}

main() {
  require_repo
  verify_remotes
  if [[ "$CHECK_ONLY" == 1 ]]; then
    check_state
    log "read-only check complete"
    return 0
  fi
  stash_dirty_tree
  if [[ "$DRY_RUN" == 1 ]]; then
    check_state
    log "dry-run: would fast-forward $MAIN_BRANCH and merge it into $MAINTENANCE_BRANCH"
    if [[ "$PUSH_CHANGES" == 1 ]]; then
      log "dry-run: would atomically push both synchronized branches to origin"
    fi
    log "dry-run: would not build, install, quit, or launch Hermes Desktop"
    return 0
  fi
  sync_source
  log "source synchronization complete; installed Hermes Desktop was untouched"
}

trap finish EXIT
main
