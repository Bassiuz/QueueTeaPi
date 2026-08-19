#!/usr/bin/env bash
#
# Prepares a Google Cloud / Firebase project to run QueueTeaPi.
#
# Everything it does is additive and idempotent: it enables APIs, creates a
# Firestore database if there is not one already, and deploys the composite
# indexes the queue needs. It never deletes anything, and it prints every
# command before running it.
#
#   ./scripts/scaffold.sh --project my-project
#   ./scripts/scaffold.sh --project my-project --dry-run
#
set -euo pipefail

PROJECT=""
LOCATION="eur3"
DATABASE="(default)"
COLLECTION="kitchen-orders"
DRY_RUN=false
ASSUME_YES=false

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXAMPLE_DIR="$(dirname "$SCRIPT_DIR")"

# ── output helpers ───────────────────────────────────────────────────────────

if [ -t 1 ]; then
  BOLD=$(printf '\033[1m'); DIM=$(printf '\033[2m')
  GREEN=$(printf '\033[32m'); YELLOW=$(printf '\033[33m')
  RED=$(printf '\033[31m'); RESET=$(printf '\033[0m')
else
  BOLD=""; DIM=""; GREEN=""; YELLOW=""; RED=""; RESET=""
fi

step()  { printf '\n%s==>%s %s%s%s\n' "$GREEN" "$RESET" "$BOLD" "$1" "$RESET"; }
info()  { printf '    %s\n' "$1"; }
warn()  { printf '%s  !%s %s\n' "$YELLOW" "$RESET" "$1"; }
fail()  { printf '%s  ✗%s %s\n' "$RED" "$RESET" "$1" >&2; exit 1; }

# Prints a command, then runs it unless --dry-run was given.
run() {
  printf '    %s$ %s%s\n' "$DIM" "$*" "$RESET"
  if [ "$DRY_RUN" = false ]; then
    "$@"
  fi
}

usage() {
  cat <<EOF
${BOLD}scaffold.sh${RESET} — set up a Google Cloud project for QueueTeaPi

  --project <id>     Google Cloud project id (required)
  --location <id>    Firestore location, default: ${LOCATION}
                     e.g. eur3, nam5, europe-west1, us-central1
  --database <id>    Firestore database id, default: (default)
  --collection <p>   Collection to index, default: ${COLLECTION}
  --dry-run          Print every command without running it
  --yes              Do not pause for confirmation
  --help             This text

What it does, in order:
  1. Checks that gcloud and the Firebase CLI are installed and signed in
  2. Enables the Firestore API on the project
  3. Creates a Firestore database if the project has none
  4. Deploys the three composite indexes the queue needs
  5. Prints the environment variables to run the example with

It is safe to re-run. Nothing here deletes data.
EOF
}

# ── arguments ────────────────────────────────────────────────────────────────

while [ $# -gt 0 ]; do
  case "$1" in
    --project)    PROJECT="${2:-}"; shift 2 ;;
    --location)   LOCATION="${2:-}"; shift 2 ;;
    --database)   DATABASE="${2:-}"; shift 2 ;;
    --collection) COLLECTION="${2:-}"; shift 2 ;;
    --dry-run)    DRY_RUN=true; shift ;;
    --yes|-y)     ASSUME_YES=true; shift ;;
    --help|-h)    usage; exit 0 ;;
    *)            fail "Unknown option: $1 (try --help)" ;;
  esac
done

if [ -z "$PROJECT" ]; then
  PROJECT="$(gcloud config get-value project 2>/dev/null || true)"
  if [ -z "$PROJECT" ] || [ "$PROJECT" = "(unset)" ]; then
    usage
    echo
    fail "No project given. Pass --project <id>, or set one with: gcloud config set project <id>"
  fi
  info "Using the project gcloud is currently pointed at: $PROJECT"
fi

# ── 1. prerequisites ─────────────────────────────────────────────────────────

step "Checking prerequisites"

command -v gcloud >/dev/null 2>&1 \
  || fail "gcloud not found. Install it: https://cloud.google.com/sdk/docs/install"
info "gcloud    $(gcloud version 2>/dev/null | head -1)"

command -v firebase >/dev/null 2>&1 \
  || fail "The Firebase CLI is not installed. Install it: npm install -g firebase-tools"
info "firebase  $(firebase --version 2>/dev/null)"

ACCOUNT="$(gcloud config get-value account 2>/dev/null || true)"
if [ -z "$ACCOUNT" ] || [ "$ACCOUNT" = "(unset)" ]; then
  fail "gcloud is not signed in. Run: gcloud auth login"
fi
info "signed in as $ACCOUNT"

if [ "$DRY_RUN" = true ]; then
  warn "Dry run — commands will be printed but not executed."
fi

cat <<EOF

    project      ${BOLD}${PROJECT}${RESET}
    database     ${DATABASE}
    location     ${LOCATION}
    collection   ${COLLECTION}
EOF

if [ "$ASSUME_YES" = false ] && [ "$DRY_RUN" = false ]; then
  printf '\n    Continue? [y/N] '
  read -r reply
  case "$reply" in
    [yY]|[yY][eE][sS]) ;;
    *) info "Nothing done."; exit 0 ;;
  esac
fi

# ── 2. APIs ──────────────────────────────────────────────────────────────────

step "Enabling the Firestore API"
info "Already-enabled APIs are left alone; this may take a minute the first time."
run gcloud services enable firestore.googleapis.com --project "$PROJECT"

# ── 3. the database ──────────────────────────────────────────────────────────

step "Making sure a Firestore database exists"

if [ "$DRY_RUN" = true ]; then
  info "Would check for an existing database, and create one if there is none."
  run gcloud firestore databases create \
    --project "$PROJECT" --database "$DATABASE" --location "$LOCATION" --type firestore-native
elif gcloud firestore databases describe \
      --project "$PROJECT" --database "$DATABASE" >/dev/null 2>&1; then
  info "Database ${DATABASE} already exists — leaving it as it is."
else
  info "No database yet; creating a Native-mode one in ${LOCATION}."
  info "A project's default database location is permanent, so choose carefully."
  run gcloud firestore databases create \
    --project "$PROJECT" --database "$DATABASE" --location "$LOCATION" --type firestore-native
fi

# ── 4. indexes ───────────────────────────────────────────────────────────────

step "Deploying the composite indexes the queue needs"
info "status + nextAttemptAt   — claiming due work"
info "status + leaseExpiresAt  — reclaiming events from workers that died"
info "status + createdAt       — the dashboard's filtered list"

INDEX_FILE="$EXAMPLE_DIR/firestore.indexes.json"
[ -f "$INDEX_FILE" ] || fail "Cannot find $INDEX_FILE"

DEPLOY_CONFIG="$EXAMPLE_DIR/firebase.json"

# For a non-default collection, stage a complete config in a temporary
# directory rather than editing the file in the repository. `firebase` resolves
# the indexes path relative to its config, so both files have to move together.
if [ "$COLLECTION" != "kitchen-orders" ]; then
  info "Staging index definitions for collection ${COLLECTION}."
  STAGE="$(mktemp -d -t queueteapi-scaffold.XXXXXX)"
  trap 'rm -rf "$STAGE"' EXIT

  sed "s/kitchen-orders/${COLLECTION}/g" "$INDEX_FILE" \
    > "$STAGE/firestore.indexes.json"
  printf '{\n  "firestore": { "indexes": "firestore.indexes.json" }\n}\n' \
    > "$STAGE/firebase.json"

  DEPLOY_CONFIG="$STAGE/firebase.json"
fi

info "Indexes build in the background; the queue works before they finish,"
info "but its queries will be slow until they do."
run firebase deploy --only firestore:indexes \
  --project "$PROJECT" --config "$DEPLOY_CONFIG"

# ── 5. done ──────────────────────────────────────────────────────────────────

step "Ready"

cat <<EOF

    Run the example against this project:

      ${BOLD}export GOOGLE_CLOUD_PROJECT=${PROJECT}${RESET}
      ${BOLD}export QUEUE_COLLECTION=${COLLECTION}${RESET}$(
        [ "$DATABASE" = "(default)" ] || printf '\n      %sexport FIRESTORE_DATABASE_ID=%s%s' "$BOLD" "$DATABASE" "$RESET"
      )
      ${BOLD}gcloud auth application-default login${RESET}   ${DIM}# once per machine${RESET}
      ${BOLD}npm start${RESET}

    Then:

      tea room    http://localhost:4000
      dashboard   http://localhost:4000/queue
      terminal    npx queueteapi stats --project ${PROJECT} --collection ${COLLECTION}

    ${DIM}No cloud project needed for a quick look: just 'npm start' with none of
    the variables above set, and everything runs in memory.${RESET}

EOF
