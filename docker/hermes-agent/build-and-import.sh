#!/usr/bin/env bash
# Builds the hermes-agent wrapper image and imports it into the local k3s
# containerd image store.
#
# This is the image-distribution path for the LOCAL dev cluster (cachyos-x8664),
# which has no in-cluster registry — HER-206 decision, option (a): build on the
# k3s host and `k3s ctr images import`, the path the HER-137 rollout actually
# used and verified.
#
# The previous GitHub Actions workflow (.github/workflows/hermes-agent-wrapper.yml)
# pushed to 10.43.150.22:5000 — the VPS production cluster registry (pricehunter
# infra/k8s/12-registry.yaml) — which does not exist on this cluster, and it
# never ran (missing VPS_SSH_KEY secret). It was removed in HER-206.
#
# Usage (run ON the k3s host, from the repo root or anywhere):
#   docker/hermes-agent/build-and-import.sh [TAG]
#
#   TAG defaults to "1.60-browsers" — the convention is <playwright-core
#   major.minor>-browsers, matching the image currently referenced by the
#   StatefulSet (docker/hermes-agent/statefulset.yaml, imagePullPolicy
#   IfNotPresent). Bump TAG when the baked browser set changes (e.g. after a
#   playwright-core bump in the Dockerfile), then roll out deliberately:
#     kubectl -n ai set image sts/hermes-agent hermes-agent=hermes-agent-wrapper:<TAG>
#     kubectl -n ai rollout status sts/hermes-agent
#
# Requirements:
#   - docker on the k3s host (to build)
#   - sudo (or root) on the k3s host (k3s ctr images import)
#
# Idempotent: re-importing the same tag replaces the image in the containerd
# store; running pods are unaffected until the StatefulSet is rolled out
# (IfNotPresent never re-pulls), so an import alone is safe.
set -euo pipefail

# Allow root operators to run without sudo: SUDO="" ./build-and-import.sh
SUDO="${SUDO:-sudo}"

TAG="${1:-1.60-browsers}"
IMAGE="hermes-agent-wrapper:${TAG}"

cd "$(dirname "$0")/../.." # repo root (script lives in docker/hermes-agent/)

echo "==> [1/3] Building ${IMAGE} from docker/hermes-agent/Dockerfile"
docker build -t "${IMAGE}" docker/hermes-agent

echo "==> [2/3] Importing ${IMAGE} into k3s containerd (${SUDO} k3s ctr images import)"
docker save "${IMAGE}" | ${SUDO} k3s ctr images import -

echo "==> [3/3] Verifying import"
if ${SUDO} k3s ctr images ls | grep -F "${IMAGE}" >/dev/null; then
  echo "OK: ${IMAGE} present in k3s containerd"
else
  echo "ERROR: ${IMAGE} not found in k3s containerd after import" >&2
  exit 1
fi

# If kubectl is available, warn when the StatefulSet references a different
# tag — the import is done, but the rollout still needs a deliberate step.
if command -v kubectl >/dev/null 2>&1; then
  LIVE_IMAGE="$(kubectl -n ai get sts hermes-agent \
    -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || true)"
  if [ -n "${LIVE_IMAGE}" ] && [ "${LIVE_IMAGE}" != "${IMAGE}" ]; then
    echo "NOTE: StatefulSet image is ${LIVE_IMAGE}, not ${IMAGE}. To roll out:"
    echo "  kubectl -n ai set image sts/hermes-agent hermes-agent=${IMAGE}"
    echo "  kubectl -n ai rollout status sts/hermes-agent"
  fi
fi

echo "Done. Wrapper image ${IMAGE} is ready for the local cluster."
