# harbormaster-sleep

A Harbor for sleeping a specified number of seconds.

## Installation

Add `https://github.com/strictlyskyler/sleep.git` from Harbormaster's Harbors
page, then create a lane using the Sleep harbor. Core setup does not install
individual harbors.

## Upgrading existing shipments

Sleep owns its legacy shipment migration. Run this tool with Harbormaster
stopped, before starting the updated core and Sleep harbor together:

```bash
npm ci
MONGO_URL='mongodb://localhost:27017/harbormaster' npm run migrate
MONGO_URL='mongodb://localhost:27017/harbormaster' npm run migrate -- --apply
```

Use the URL of your Harbormaster database. The first command previews the
deadlines and proposed changes. The second applies the validated plan only to
unchanged, active shipments that still lack a manifest; it can be rerun safely.
Saved manifests, deadlines, and BSON values are preserved.

Older shipments may never have recorded their original inputs. Those records
are marked `estimated` because the tool must use the lane's current settings.
Review those settings and deadlines before applying with both `--apply` and
`--acknowledge-current-settings`. Missing or invalid settings stop the plan
before any writes. Alternatively, let legacy sleeps finish before upgrading.

Sleep retains compatibility with `sleep_resume` records and removes that
private state after completion. Core needs no Sleep-specific migration or
cleanup behavior.

## Integration tests

The migration and recovery integration tests live here and run against real
core collections and RPCs. Install Meteor and the dependencies in a core
checkout, then run:

```bash
HARBORMASTER_PATH=/path/to/harbormaster npm run test:integration
```

The runner copies tracked files from that checkout into a temporary workspace,
adds this repo's tests, and starts an isolated Meteor test database. It removes
the workspace afterward and leaves the supplied checkout untouched. Core must
include the durable shipment recovery API. CI pins the tested core commit in
this repo's workflow; core has no dependency on this harbor or its tests.

## Screenshots

![Edit lane](edit-page.png)

![Ship lane](ship-page.png)

## ESLint

```bash
npm run lint
npm run lint:fix
npm test
```
