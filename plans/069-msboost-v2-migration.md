# MSBOOST v2 migration from FLVX 2.2.0-alpha4

## Goal

Create a GPL-compliant MSBOOST distribution based on FLVX 2.2.0-alpha4.
Keep the legacy Cloudflare Sites application on the `main` branch until the
new Docker deployment has passed VPS acceptance testing.

## Tasks

- [x] Preserve the legacy application in GitHub `main`.
- [x] Create the `msboost-v2` branch from FLVX 2.2.0-alpha4.
- [x] Retain FLVX GPL-3.0, Apache-2.0, and NOTICE source attribution.
- [ ] Rename deployment identifiers, service names, documentation and visible brand to MSBOOST.
- [x] Publish a self-hosted Docker Compose installer that builds from this repository's `msboost-v2` source branch.
- [ ] Verify panel and agent installation on a clean Debian 12 test VPS.
- [ ] Add MSBOOST account model: numeric QQ mailbox registration, invitation controls, optional Turnstile and agreement consent.
- [ ] Add card-code entitlement, fixed-duration plans, expiry shutdown and traffic quota rules.
- [ ] Add MSBOOST configuration generation, direct/relay download lifecycle, and one-target restriction.
- [ ] Add one-shot customer VPS deployment jobs (DD, node setup and time synchronization) without persisting SSH secrets.
- [ ] Add Markdown knowledge-base/policy editing and backup scheduling.
- [ ] Perform acceptance testing, tag a release, then replace `main` only after approval.
