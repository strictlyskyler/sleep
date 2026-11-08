const plan_sleep_migration = (shipments, harbor) => {
  const changes = [];
  const report = [];
  for (const shipment of shipments) {
    if (!shipment.active) {
      if (shipment.active === false &&
        Object.hasOwn(shipment, 'sleep_resume')) {
        changes.push({
          _id: shipment._id, action: 'cleanup', previous: shipment.sleep_resume,
        });
        report.push({
          shipment_id: shipment._id, lane: shipment.lane,
          action: 'cleanup', changes: true,
        });
      }
      continue;
    }
    const saved = shipment.sleep_resume;
    const config = harbor && harbor.lanes && harbor.lanes[shipment.lane];
    const recorded = saved ? saved.manifest : shipment.manifest;
    const input = recorded || (config && config.manifest);
    if (!input) throw new Error(`Missing sleep settings: ${shipment._id}`);
    const manifest = { ...input };
    if (!recorded && typeof manifest.seconds == 'string' &&
      manifest.seconds.trim()) {
      manifest.seconds = Number(manifest.seconds);
    }
    const exit_code = saved ? saved.exit_code :
      parseInt(manifest.exit_code, 10);
    const actual = new Date(shipment.actual || NaN).getTime();
    const deadline = new Date(saved ? saved.deadline || NaN :
      actual + manifest.seconds * 1000).getTime();
    if (!Number.isFinite(manifest.seconds) || manifest.seconds < 0 ||
      !Number.isFinite(exit_code) || !Number.isFinite(deadline)) {
      throw new Error(`Invalid sleep settings: ${shipment._id}`);
    }
    manifest.shipment_id = shipment._id;
    manifest.shipment_start_date = shipment.start;
    if (!shipment.manifest) {
      changes.push({
        _id: shipment._id,
        action: 'backfill',
        previous: shipment.manifest,
        manifest,
      });
    }
    report.push({
      shipment_id: shipment._id, lane: shipment.lane,
      action: 'backfill',
      deadline: new Date(deadline), estimated: !recorded,
      changes: !shipment.manifest,
    });
  }
  return { changes, report };
};

const apply_sleep_migration = async (shipments, plan) => {
  const result = { updated: 0, skipped: [] };
  for (const change of plan.changes) {
    let selector;
    let modifier;
    if (change.action === 'cleanup') {
      selector = {
        _id: change._id, active: false, sleep_resume: change.previous,
      };
      modifier = { $unset: { sleep_resume: '' } };
    }
    else {
      const previous = change.previous === undefined ?
        { $exists: false } : change.previous;
      selector = { _id: change._id, active: true, manifest: previous };
      modifier = { $set: { manifest: change.manifest } };
    }
    const update = await shipments.updateOne(selector, modifier);
    if (update.modifiedCount) result.updated++;
    else result.skipped.push(change._id);
  }
  return result;
};

export { plan_sleep_migration, apply_sleep_migration };
