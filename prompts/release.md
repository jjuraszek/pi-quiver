---
name: release
description: Cut a pi-essentials release (major/minor/patch) - bump version, tag, push; tag-triggered CI publishes to npm.
---

Run a release of this package using the `release` skill at
`.agents/skills/release/SKILL.md`.

Requested bump type: {{args}}

If no bump type (`major`, `minor`, or `patch`) was given, run
`release.sh propose` and ask the user to confirm the level before doing
anything. Then follow the skill: promote the CHANGELOG entry, run the helper
script to bump + tag + push, and let `.github/workflows/release.yml` publish to
npm via OIDC. Report the old version, new version, created tag, push
confirmation, and the CI/npm verification result. Never run `npm publish` by
hand.
