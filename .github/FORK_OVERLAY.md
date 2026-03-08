# Fork Overlay

This fork keeps a custom Cloudflare deployment layer on top of upstream `chenyme/grok2api`.

## Preserved paths

See `.github/fork-overlay.paths`.

Currently preserved:

- `worker/`
- `.github/workflows/cloudflare-workers.yml`
- `.github/workflows/sync-upstream.yml`
- `.github/fork-overlay.paths`

## Sync strategy

Use the `Sync upstream and preserve fork overlay` workflow.

It will:

1. fetch `upstream/main`
2. create a fresh sync branch from upstream
3. copy the fork overlay back on top
4. run worker checks:
   - `npm run typecheck`
   - `npm run check:upstream-drift`
5. open a PR back to `main`

## Why PR instead of direct push?

Because this fork has custom runtime/deploy code (`worker/`) that can drift from upstream. PR review keeps sync safe and visible.
