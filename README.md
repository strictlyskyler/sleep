# harbormaster-sleep

A Harbor for sleeping a specified number of seconds.

Active shipments save their deadline and original manifest. After a server
restart, the harbor schedules the remaining time or completes overdue work.
Shipments without saved sleep settings use their recorded `actual` timestamp
and the lane's current settings for recovery. Transient database and completion
errors are retried after 30 seconds.

When multiple servers recover the same shipment, Harbormaster's
`Lanes#end_shipment` must atomically update only active shipments and check the
affected count before starting follow-up or salvage work.

## Screenshots

![Edit lane](edit-page.png)

![Ship lane](ship-page.png)

## ESLint

```bash
npm run lint
npm run lint:fix
npm test
```
