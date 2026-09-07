# MSBOOST product rebuild

## Goal

Replace the exposed FLVX management interface with a customer-facing MSBOOST
game-node service. Retain only the proven forwarding agent, runtime telemetry,
traffic accounting and node-control transport from the FLVX base.

## Delivery order

- [ ] Replace the public login and customer navigation with the MSBOOST product
  surface: 教程（必看）, VPS 节点部署, 套餐与卡密, 隧道中转, 工单/账户.
- [ ] Add public registration for numeric QQ mailboxes only, service-agreement
  acceptance, configurable invitations and optional Turnstile.
- [ ] Add administrator-managed card codes and 1–31 day plans, including
  zero-price trial rules, replacement traffic quotas and expiry enforcement.
- [ ] Build customer tunnel creation on top of the existing relay runtime:
  exactly one target IP and port per customer, chosen line, rate/traffic data,
  configuration download and removal on expiry.
- [ ] Rename the installed forwarding agent and all customer-visible files and
  services to MSBOOST; retain upstream notices in the source distribution.
- [ ] Add one-shot VPS jobs for DD and MSBOOST node setup without retaining SSH
  credentials, with the requested time synchronisation and clean re-deploy.
- [ ] Add an editable Markdown tutorial/policy system with media uploads,
  operational backup scheduling and audit records.
- [ ] Publish prebuilt GitHub Container Registry images so future panel
  installation pulls images rather than compiling on the VPS.
- [ ] Acceptance-test each customer flow on a clean VPS before replacing the
  legacy Sites version.

## Explicit non-goals during the transition

- Do not expose the inherited FLVX admin pages as the finished customer UI.
- Do not delete the legacy Sites application or production data before the
  Docker replacement passes acceptance testing.
