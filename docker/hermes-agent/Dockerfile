# syntax=docker/dockerfile:1
#
# Wrapper image for the Hermes agent (HER-134).
#
# Problem: the upstream `nousresearch/hermes-agent` image bakes in
# Playwright 1.62.1-era browsers (revision 1234) and sets the image-level ENV
# PLAYWRIGHT_BROWSERS_PATH=/opt/hermes/.playwright. Agent workspaces pin older
# playwright versions — pricehunter pins playwright-core 1.60.0
# (frontend/package.json), which needs revision 1223 (chromium-1223,
# chromium_headless_shell-1223, ffmpeg-1011). When the 1223 set was missing,
# every Visual run triggered a mid-run `npx playwright install chromium` that
# hung and timed out, putting the Visual agent into `error` state (2026-08-03
# incident, HER-134).
#
# This wrapper bakes the 1223 set into image layers so the browser cache
# survives pod deletion and image rebuilds (the container writable layer does
# not). The install is idempotent: `playwright install` is a no-op when the
# revisions are already present, so rebuilding against a newer base image
# re-adds 1223 without re-downloading when the layer cache hits.
FROM nousresearch/hermes-agent:latest

# The base image already sets this; re-assert it so the install below lands in
# the same cache the image ENV points at, and keep the property explicit in
# this wrapper.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/hermes/.playwright

# Pre-install the browser set required by workspaces pinned to
# playwright-core 1.60.0: chromium-1223, chromium_headless_shell-1223,
# ffmpeg-1011. Verified 2026-08-04 on the running pod:
#   npx --yes playwright-core@1.60.0 install --dry-run chromium
# reports exactly these three artifacts at $PLAYWRIGHT_BROWSERS_PATH.
# The marker checks turn a missing browser into a build failure instead of a
# silent runtime surprise.
RUN npx --yes playwright-core@1.60.0 install chromium \
    && test -f "$PLAYWRIGHT_BROWSERS_PATH/chromium-1223/INSTALLATION_COMPLETE" \
    && test -f "$PLAYWRIGHT_BROWSERS_PATH/chromium_headless_shell-1223/INSTALLATION_COMPLETE" \
    && test -f "$PLAYWRIGHT_BROWSERS_PATH/ffmpeg-1011/INSTALLATION_COMPLETE"
