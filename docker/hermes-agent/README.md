# hermes-agent wrapper image + StatefulSet (HER-134, HER-206)

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
- `statefulset.yaml` — tracked StatefulSet manifest (namespace `ai`), references the wrapper image; reconciled with the live object 2026-08-05 (HER-206)
- `build-and-import.sh` — build + import the wrapper image into the local k3s containerd (the local-cluster distribution path)

## Image distribution for the local cluster (HER-206 decision)

Decision: **option (a) — build on the k3s host and import into k3s containerd**
(`docker save | sudo k3s ctr images import`). This is the path the HER-137
rollout actually used and verified; it needs no new infrastructure and no
credentials.

Rejected alternatives:

- **(b) in-cluster registry on the local k3s** — new infrastructure (registry:2
  Deployment + Service + pull config) to serve a single image to a single
  node; nothing else on this cluster needs a registry.
- **(c) GHCR / docker hub** — the wrapper image is ~1 GB+ (browsers baked in);
  CI would need push credentials and the local node pull credentials, and the
  GitHub runner cannot reach the cluster anyway.

The previous GitHub Actions workflow (`.github/workflows/hermes-agent-wrapper.yml`)
pushed to `10.43.150.22:5000` — the **VPS production cluster** registry
(pricehunter `infra/k8s/12-registry.yaml`), which does not exist on the local
dev k3s (`cachyos-x8664`). It never ran (missing `VPS_SSH_KEY` secret) and even
if it had, the local cluster cannot pull from that IP. It was removed in
HER-206; the script below is the distribution path.

### Rebuild + redistribute (run ON the k3s host)

```sh
./docker/hermes-agent/build-and-import.sh                 # hermes-agent-wrapper:1.60-browsers
./docker/hermes-agent/build-and-import.sh 1.61-browsers   # after a browser-set bump
```

The script builds the Dockerfile, imports the image into k3s containerd
(`docker save | sudo k3s ctr images import -`), verifies the import, and warns
if the StatefulSet still references a different tag. Idempotent: re-importing
the same tag only replaces the image in the containerd store — running pods
are unaffected until you roll out.

Manual equivalent:

```sh
docker build -t hermes-agent-wrapper:1.60-browsers docker/hermes-agent
docker save hermes-agent-wrapper:1.60-browsers | sudo k3s ctr images import -
sudo k3s ctr images ls | grep hermes-agent-wrapper
```

### Roll out a new tag

`statefulset.yaml` references `hermes-agent-wrapper:1.60-browsers` with
`imagePullPolicy: IfNotPresent` (live-object convention, HER-206 scope item 3).
IfNotPresent means re-importing the same tag never re-pulls — so:

1. import the new tag (script above),
2. point the StatefulSet at it and roll out:

```sh
kubectl -n ai set image sts/hermes-agent hermes-agent=hermes-agent-wrapper:<TAG>
kubectl -n ai rollout status sts/hermes-agent
```

## Apply (manual, on the k3s host)

> The tracked manifest was reconciled with the live object on 2026-08-05
> (HER-206): container command (`/opt/hermes/bin/hermes gateway run`), envFrom
> `configMapRef hermes-env`, env (PYTHONPATH only), configMap volume
> `hermes-config-vol` → `hermes-config-volume`, PVC 10Gi, image
> `hermes-agent-wrapper:1.60-browsers` with IfNotPresent.
>
> SECURITY: the readiness probe carries a Bearer token. It lives only in the
> cluster (secret / last-applied annotation). Never commit or paste it; the
> tracked file uses a `BEARER_TOKEN_PLACEHOLDER` that must be replaced at
> apply time. If it ever leaks, rotate it.

```sh
# Server-side dry-run against the live object first (shows exactly what would
# change; the probe-token diff is expected and fine):
kubectl -n ai apply --dry-run=server -f docker/hermes-agent/statefulset.yaml

# Real apply — replace BEARER_TOKEN_PLACEHOLDER with the live token first:
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
