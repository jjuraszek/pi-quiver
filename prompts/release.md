---
name: release
description: Cut a pi-quiver release (major/minor/patch) - bump version, tag, push; tag-triggered CI publishes to npm.
---

Run a release of this package using the `release` skill at
`.agents/skills/release/SKILL.md`.

Requested bump type: {{args}}

A given bump type is the approval: run `release.sh <level>` directly (it
promotes the CHANGELOG `## Unreleased` section, bumps, tags, pushes; CI
publishes to npm via OIDC). Without one, run `release.sh propose` and wait for
the pick. Report old version, new version, tag, and the npm verification
result. Never run `npm publish` by hand.
