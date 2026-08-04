# hermes-agent wrapper image + StatefulSet (HER-134)

Makes the Playwright browser cache durable for Hermes agents.

## Problem

The upstream `nousresearch/hermes-agent:latest` image bakes in Playwright
1.62.1-era browsers (revision 1234) and sets `PLAYWRIGHT_BROWSERS_PATH=/opt/hermes/.playwright`
as an image-level ENV. Agent workspaces pin older playwright versions —
pricehunter pins `playwright-core@1.60.0` (`frontend/package.json`), which
needs revision 1223 (`chromium-1223`, `chromium_headless_shell-1223`,
`ffmpeg-1011`).

When the 1223 set was missing, every Visual run triggered a mid-run
`npx playwright install chromium` that hung and timed out, putting the Visual
agent into `error` state (2026-08-03 incident). The interim fix (2026-08-04)
installed the 1223 set manually into the container writable layer — it
survives pod restarts but is lost on pod deletion or image rebuild.

## Decision: wrapper image (vs PVC-backed browsers path)

Chosen: **wrapper image** (`Dockerfile` in this directory). The 1223 browser
set is baked into image layers, so it survives pod deletion AND image
rebuilds — the actual failure mode from the incident. Build-time marker checks
(`INSTALLATION_COMPLETE`) fail the build if a browser is missing, instead of
surfacing at runtime.

Rejected for now: overriding `PLAYWRIGHT_BROWSERS_PATH` to a PVC-backed path
(e.g. `/opt/data/.playwright` on the existing `hermes-data` PVC). It avoids
image rebuilds, but it (a) keeps a runtime download path open — the exact
failure mode from the incident if the cache is ever empty or corrupted,
(b) mixes ~900 MB of browser binaries into the agent workspace PVC, and
(c) leaves the browser set on the node-bound local-path PV rather than in the
immutable image. If image size ever becomes a problem, the PVC path is the
documented fallback (single env override + one-time install).

## Layout

- `Dockerfile` — wrapper image: upstream image + `playwright-core@1.60.0 install chromium`
- `statefulset.yaml` — tracked StatefulSet manifest (namespace `ai`), references the wrapper image
- `.github/workflows/hermes-agent-wrapper.yml` — build + push workflow (repo root)

## Build & push

Via CI (recommended): run the `hermes-agent-wrapper` workflow
(`workflow_dispatch`) in GitHub Actions. Requires the `VPS_SSH_KEY` repo
secret (same key as the `eliyarson/pricehunter` repo — ask the coordinator to
add it to this repo before the first run). The workflow builds on the runner,
transfers the image with `docker save | ssh docker load`, and pushes from the
VPS to the in-cluster registry (`10.43.150.22:5000`).

Manually on the VPS (2.24.100.112, where `docker` + `kubectl` have cluster
access):

```sh
cd <paperclip checkout>
docker build -t 10.43.150.22:5000/hermes-agent:latest docker/hermes-agent
docker push 10.43.150.22:5000/hermes-agent:latest
```

## Apply (manual, on the VPS)

> Reconciliation required before first apply. `kubectl apply` prunes live
> fields absent from the file (three-way merge). Diff first and port over
> anything missing (env, probes, resources, tolerations, ...):
>
> ```sh
> kubectl -n ai get sts hermes-agent -o yaml > /tmp/hermes-agent-live.yaml
> diff -u /tmp/hermes-agent-live.yaml docker/hermes-agent/statefulset.yaml
> ```
>
> SECURITY: the readiness probe carries a Bearer token. It lives only in the
> cluster (secret / last-applied annotation). Never commit or paste it; the
> tracked file uses a `BEARER_TOKEN_PLACEHOLDER` that must be replaced at
> apply time. If it ever leaks, rotate it.

```sh
kubectl apply -f docker/hermes-agent/statefulset.yaml
kubectl -n ai rollout status sts/hermes-agent
```

## Verify durability (post-rollout)

```sh
# 1. Browser cache present on the recreated pod (baked into the wrapper image)
kubectl -n ai exec hermes-agent-0 -- ls /opt/hermes/.playwright/
kubectl -n ai exec hermes-agent-0 -- test -f /opt/hermes/.playwright/chromium_headless_shell-1223/INSTALLATION_COMPLETE && echo "1223 cache OK"

# 2. Playwright launch works from the pricehunter frontend checkout (no download)
kubectl -n ai exec hermes-agent-0 -- sh -c 'cd /opt/data/workspace/pricehunter/frontend && node -e "const {chromium}=require(\"playwright-core\"); chromium.launch({headless:true}).then(b=>{console.log(\"LAUNCH OK\", b.version()); return b.close()})"'

# 3. Visual agent screenshot/QA heartbeat completes without a mid-run install
#    (watch the run transcript for `npx playwright install`)
```

Pre-flight evidence collected 2026-08-04 (on the running pod, before rollout):

- `npx --yes playwright-core@1.60.0 install --dry-run chromium` with
  `PLAYWRIGHT_BROWSERS_PATH=/opt/hermes/.playwright` reports exactly
  chromium-1223, chromium_headless_shell-1223, ffmpeg-1011 at that path.
- `chromium.launch({headless:true})` from
  `/opt/data/workspace/pricehunter/frontend` succeeds (chromium
  148.0.7778.96, i.e. the 1223 set) with no download.
