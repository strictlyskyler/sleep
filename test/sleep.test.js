const test = require('node:test');
const assert = require('node:assert/strict');

const lane = { _id: 'lane-1', type: 'sleep', name: 'Sleeper' };

const loadSleep = () => {
  delete require.cache[require.resolve('../sleep.js')];
  return require('../sleep.js');
};

const makeCollections = (documents, harbor) => {
  const saved = new Map(documents.map(doc => [doc._id, doc]));
  return {
    saved,
    lanes: {
      find: ({ type }) => ({
        fetchAsync: async () => type === 'sleep' ? [lane] : [],
      }),
    },
    harbors: {
      findOneAsync: async () => harbor,
    },
    shipments: {
      find: ({ lane: laneId, active }) => ({
        fetchAsync: async () => structuredClone(
          [...saved.values()].filter(doc =>
            doc.lane === laneId && doc.active === active,
          ),
        ),
      }),
      findOneAsync: async id => structuredClone(saved.get(id)),
      updateAsync: async (selector, modifier) => {
        const doc = saved.get(selector._id);
        if (!doc) return 0;
        if (selector.active !== undefined && doc.active !== selector.active) {
          return 0;
        }
        Object.assign(doc, structuredClone(modifier.$set));
        return 1;
      },
    },
  };
};

const installTimers = (t) => {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const originalNow = Date.now;
  let now = Date.now();
  const pending = [];
  Date.now = () => now;
  global.setTimeout = (callback, delay) => {
    const timer = { callback, delay, due: now + delay };
    pending.push(timer);
    return timer;
  };
  global.clearTimeout = (timer) => {
    const index = pending.indexOf(timer);
    if (index !== -1) pending.splice(index, 1);
  };
  t.after(() => {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    Date.now = originalNow;
  });
  return {
    pending,
    runNext: async () => {
      const timer = pending.shift();
      assert.ok(timer, 'expected a scheduled timer');
      now = Math.max(now, timer.due);
      await timer.callback();
    },
  };
};

const installHost = (t, callback) => {
  const originalH = global.H;
  global.H = { call: callback };
  t.after(() => {
    if (originalH === undefined) delete global.H;
    else global.H = originalH;
  });
};

const flushRecovery = () => new Promise(resolve => setImmediate(resolve));

test('update accepts valid seconds and rejects invalid input', () => {
  const sleep = loadSleep();
  const values = { seconds: '5' };
  assert.equal(sleep.update(lane, values), true);
  assert.equal(values.seconds, 5);
  assert.equal(sleep.update(lane, { seconds: '' }), false);
  assert.equal(sleep.update(lane, { seconds: 'invalid' }), false);
  assert.equal(sleep.update(lane, { seconds: '-1' }), false);
  assert.equal(sleep.update(lane, { seconds: [] }), false);
  assert.equal(sleep.update(lane, { seconds: [5] }), false);
  assert.equal(sleep.update(lane, { seconds: true }), false);
  assert.equal(sleep.update(lane, { seconds: '0' }), true);
  assert.equal(sleep.update(lane, { seconds: '0.5' }), true);
});

test('work saves settings before scheduling', async (t) => {
  const timers = installTimers(t);
  installHost(t, async () => {});
  const shipment = {
    _id: 'ship-1', lane: lane._id, active: true, actual: new Date(),
  };
  const harbor = { lanes: {
    [lane._id]: { manifest: { seconds: 5, exit_code: 1 } },
  } };
  const db = makeCollections([shipment], harbor);
  const sleep = loadSleep();
  sleep.register(db.lanes, null, db.harbors, db.shipments);
  await flushRecovery();

  const manifest = {
    seconds: 5,
    exit_code: '1',
    shipment_id: shipment._id,
    prior_manifest: { value: 'original' },
  };
  const before = Date.now();
  assert.equal(await sleep.work(lane, manifest), manifest);
  assert.deepEqual(shipment.sleep_resume.manifest, manifest);
  assert.equal(shipment.sleep_resume.exit_code, 1);
  assert.ok(shipment.sleep_resume.deadline.getTime() >= before + 5000);
  assert.equal(timers.pending.length, 1);
  assert.ok(timers.pending[0].delay > 0);
  assert.ok(timers.pending[0].delay <= 5000);
});

test('restart uses saved settings even after the lane is edited', async (t) => {
  const timers = installTimers(t);
  installHost(t, async () => {});
  const shipment = {
    _id: 'ship-2', lane: lane._id, active: true, actual: new Date(),
  };
  const harbor = { lanes: {
    [lane._id]: { manifest: { seconds: 5, exit_code: 1 } },
  } };
  const db = makeCollections([shipment], harbor);
  const sleep = loadSleep();
  sleep.register(db.lanes, null, db.harbors, db.shipments);
  await flushRecovery();
  await sleep.work(lane, {
    seconds: 5, exit_code: 1, shipment_id: shipment._id,
  });

  // Discard the first process's timer and change the lane configuration.
  timers.pending.length = 0;
  harbor.lanes[lane._id].manifest = { seconds: 30, exit_code: 0 };
  const restarted = loadSleep();
  assert.deepEqual(
    restarted.register(db.lanes, null, db.harbors, db.shipments),
    { name: 'sleep' },
  );
  await flushRecovery();
  assert.equal(timers.pending.length, 1);
  assert.ok(timers.pending[0].delay > 0);
  assert.ok(timers.pending[0].delay <= 5000);
  assert.equal(shipment.sleep_resume.exit_code, 1);
});

test('restart finishes overdue work with the lane and shipment manifest',
  async (t) => {
    const timers = installTimers(t);
    const calls = [];
    const shipment = {
      _id: 'ship-3',
      lane: lane._id,
      active: true,
      sleep_resume: {
        deadline: new Date(Date.now() - 1000),
        exit_code: 1,
        manifest: { seconds: 5, exit_code: 1, prior_manifest: 'saved' },
      },
    };
    installHost(t, async (...args) => {
      calls.push(args);
      shipment.active = false;
    });
    const db = makeCollections([shipment], null);
    const sleep = loadSleep();
    sleep.register(db.lanes, null, db.harbors, db.shipments);
    await flushRecovery();

    assert.equal(timers.pending[0].delay, 0);
    await timers.runNext();
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'Lanes#end_shipment');
    assert.equal(calls[0][1], lane);
    assert.equal(calls[0][2], 1);
    assert.equal(calls[0][3].shipment_id, shipment._id);
    assert.equal(calls[0][3].prior_manifest, 'saved');
  });

test('restart recovers an older active shipment from its start time',
  async (t) => {
    const timers = installTimers(t);
    const calls = [];
    installHost(t, async (...args) => calls.push(args));
    const shipment = {
      _id: 'legacy',
      lane: lane._id,
      active: true,
      actual: new Date(Date.now() - 6000),
      start: 'planned-start',
    };
    const harbor = { lanes: {
      [lane._id]: { manifest: { seconds: 5, exit_code: '0' } },
    } };
    const db = makeCollections([shipment], harbor);
    const sleep = loadSleep();
    sleep.register(db.lanes, null, db.harbors, db.shipments);
    await flushRecovery();

    assert.equal(timers.pending[0].delay, 0);
    await timers.runNext();
    assert.equal(calls[0][1], lane);
    assert.equal(calls[0][2], 0);
    assert.equal(calls[0][3].shipment_id, shipment._id);
    assert.equal(calls[0][3].shipment_start_date, shipment.start);
  });

test('a reset shipment is not completed by its timer', async (t) => {
  const timers = installTimers(t);
  const calls = [];
  installHost(t, async (...args) => calls.push(args));
  const shipment = {
    _id: 'reset',
    lane: lane._id,
    active: true,
    sleep_resume: {
      deadline: new Date(Date.now() - 1000),
      exit_code: 0,
      manifest: { seconds: 5 },
    },
  };
  const db = makeCollections([shipment], null);
  const sleep = loadSleep();
  sleep.register(db.lanes, null, db.harbors, db.shipments);
  await flushRecovery();

  shipment.active = false;
  await timers.runNext();
  assert.equal(calls.length, 0);
});

test('a startup read failure retries recovery', async (t) => {
  const timers = installTimers(t);
  installHost(t, async () => {});
  const db = makeCollections([], null);
  let attempts = 0;
  db.harbors.findOneAsync = async () => {
    attempts++;
    if (attempts === 1) throw new Error('database unavailable');
    return null;
  };
  const originalError = console.error;
  console.error = () => {};
  t.after(() => { console.error = originalError; });

  const sleep = loadSleep();
  sleep.register(db.lanes, null, db.harbors, db.shipments);
  await flushRecovery();
  assert.equal(timers.pending.length, 1);
  assert.equal(timers.pending[0].delay, 30000);
  await timers.runNext();
  await flushRecovery();
  assert.equal(attempts, 2);
  assert.equal(timers.pending.length, 0);
});

test('a failed completion is retried', async (t) => {
  const timers = installTimers(t);
  let attempts = 0;
  installHost(t, async () => {
    attempts++;
    if (attempts === 1) throw new Error('temporary failure');
    shipment.active = false;
  });
  const originalError = console.error;
  console.error = () => {};
  t.after(() => { console.error = originalError; });
  const shipment = {
    _id: 'retry',
    lane: lane._id,
    active: true,
    sleep_resume: {
      deadline: new Date(Date.now() - 1000),
      exit_code: 0,
      manifest: { seconds: 5 },
    },
  };
  const db = makeCollections([shipment], null);
  loadSleep().register(db.lanes, null, db.harbors, db.shipments);
  await flushRecovery();
  await timers.runNext();
  assert.equal(attempts, 1);
  assert.equal(timers.pending.length, 1);
  assert.equal(timers.pending[0].delay, 30000);
  await timers.runNext();
  assert.equal(attempts, 2);
  assert.equal(shipment.active, false);
  assert.equal(timers.pending.length, 0);
});

test('completion keeps the original nested manifest after the caller edits it',
  async (t) => {
    const timers = installTimers(t);
    const calls = [];
    installHost(t, async (...args) => calls.push(args));
    const db = makeCollections([], null);
    const sleep = loadSleep();
    sleep.register(db.lanes, null, db.harbors, db.shipments);
    await flushRecovery();
    db.saved.set('snapshot', { _id: 'snapshot', lane: lane._id, active: true });

    const manifest = {
      shipment_id: 'snapshot', seconds: 0.5, exit_code: 0,
      prior_manifest: { value: 'original' },
    };
    await sleep.work(lane, manifest);
    manifest.prior_manifest.value = 'edited';
    await timers.runNext();

    assert.equal(calls.length, 1);
    assert.equal(calls[0][3].prior_manifest.value, 'original');
  });

test('a stale startup query does not replace a timer scheduled by work',
  async (t) => {
    const timers = installTimers(t);
    const calls = [];
    installHost(t, async (...args) => calls.push(args));
    const shipment = {
      _id: 'startup-race', lane: lane._id, active: true,
      actual: new Date(Date.now() - 10000),
    };
    const db = makeCollections([shipment], { lanes: {
      [lane._id]: { manifest: { seconds: 1, exit_code: 1 } },
    } });
    let finishQuery;
    db.shipments.find = () => ({
      fetchAsync: () => new Promise(resolve => { finishQuery = resolve; }),
    });
    const sleep = loadSleep();
    sleep.register(db.lanes, null, db.harbors, db.shipments);
    await flushRecovery();
    const staleShipment = structuredClone(shipment);

    await sleep.work(lane, {
      shipment_id: shipment._id, seconds: 5, exit_code: 0,
    });
    finishQuery([staleShipment]);
    await flushRecovery();

    assert.equal(timers.pending.length, 1);
    assert.equal(timers.pending[0].delay, 5000);
    await timers.runNext();
    assert.equal(calls[0][2], 0);
  });

test('a recovered timer respects newer saved settings and a zero exit code',
  async (t) => {
    const timers = installTimers(t);
    const calls = [];
    installHost(t, async (...args) => calls.push(args));
    const shipment = {
      _id: 'new-settings', lane: lane._id, active: true,
      sleep_resume: {
        deadline: new Date(Date.now() - 1000), exit_code: 1,
        manifest: { value: 'old' },
      },
    };
    const db = makeCollections([shipment], null);
    loadSleep().register(db.lanes, null, db.harbors, db.shipments);
    await flushRecovery();
    shipment.sleep_resume = {
      deadline: new Date(Date.now() + 5000), exit_code: 1,
      manifest: { value: 'current' },
    };
    shipment.exit_code = 0;

    await timers.runNext();
    assert.equal(calls.length, 0);
    assert.equal(timers.pending[0].delay, 5000);
    await timers.runNext();
    assert.equal(calls.length, 1);
    assert.equal(calls[0][2], 0);
    assert.equal(calls[0][3].value, 'current');
  });

test('startup recovery waits for work to save its settings', async (t) => {
  const timers = installTimers(t);
  installHost(t, async () => assert.fail('work has not finished sleeping'));
  const shipment = {
    _id: 'saving', lane: lane._id, active: true,
    actual: new Date(Date.now() - 10000),
  };
  const db = makeCollections([shipment], { lanes: {
    [lane._id]: { manifest: { seconds: 1, exit_code: 1 } },
  } });
  let finishQuery;
  db.shipments.find = () => ({
    fetchAsync: () => new Promise(resolve => { finishQuery = resolve; }),
  });
  const persist = db.shipments.updateAsync;
  let finishSave;
  db.shipments.updateAsync = (...args) => new Promise(resolve => {
    finishSave = () => resolve(persist(...args));
  });
  const sleep = loadSleep();
  sleep.register(db.lanes, null, db.harbors, db.shipments);
  await flushRecovery();

  const work = sleep.work(lane, {
    shipment_id: shipment._id, seconds: 5, exit_code: 0,
  });
  finishQuery([structuredClone(shipment)]);
  await flushRecovery();
  assert.equal(timers.pending.length, 0);

  finishSave();
  await work;
  assert.equal(timers.pending.length, 1);
  assert.equal(timers.pending[0].delay, 5000);
});

test('long sleeps wait through the Node timer limit before completing',
  async (t) => {
    const timers = installTimers(t);
    const calls = [];
    installHost(t, async (...args) => calls.push(args));
    const shipment = {
      _id: 'long-sleep', lane: lane._id, active: true,
      sleep_resume: {
        deadline: new Date(Date.now() + 2147484147), exit_code: 0,
        manifest: { seconds: 2147484.147 },
      },
    };
    const db = makeCollections([shipment], null);
    loadSleep().register(db.lanes, null, db.harbors, db.shipments);
    await flushRecovery();

    assert.equal(timers.pending[0].delay, 2147483647);
    await timers.runNext();
    assert.equal(calls.length, 0);
    assert.equal(timers.pending[0].delay, 500);
    await timers.runNext();
    assert.equal(calls.length, 1);
  });

test('work does not schedule a missing or inactive shipment', async (t) => {
  const timers = installTimers(t);
  installHost(t, async () => assert.fail('shipment should not complete'));
  const db = makeCollections([
    { _id: 'inactive', lane: lane._id, active: false },
  ], null);
  const sleep = loadSleep();
  sleep.register(db.lanes, null, db.harbors, db.shipments);
  await flushRecovery();

  for (const shipmentId of ['missing', 'inactive']) {
    await sleep.work(lane, {
      shipment_id: shipmentId, seconds: 0, exit_code: 0,
    });
  }
  assert.equal(timers.pending.length, 0);
  assert.equal(db.saved.get('inactive').sleep_resume, undefined);
});

test('a failed settings write leaves the shipment available for recovery',
  async (t) => {
    const timers = installTimers(t);
    const calls = [];
    installHost(t, async (...args) => calls.push(args));
    const db = makeCollections([], { lanes: {
      [lane._id]: { manifest: { seconds: 5, exit_code: 0 } },
    } });
    const sleep = loadSleep();
    sleep.register(db.lanes, null, db.harbors, db.shipments);
    await flushRecovery();
    db.saved.set('failed-save', {
      _id: 'failed-save', lane: lane._id, active: true,
      actual: new Date(Date.now() - 10000),
    });
    const persist = db.shipments.updateAsync;
    db.shipments.updateAsync = async () => {
      throw new Error('database unavailable');
    };

    await assert.rejects(sleep.work(lane, {
      shipment_id: 'failed-save', seconds: 5, exit_code: 0,
    }), /database unavailable/);
    assert.equal(timers.pending.length, 0);

    db.shipments.updateAsync = persist;
    sleep.register(db.lanes, null, db.harbors, db.shipments);
    await flushRecovery();
    assert.equal(timers.pending.length, 1);
    await timers.runNext();
    assert.equal(calls.length, 1);
  });
