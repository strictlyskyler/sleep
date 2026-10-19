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
        fetchAsync: async () => [...saved.values()].filter(doc =>
          doc.lane === laneId && doc.active === active,
        ),
      }),
      findOneAsync: async id => saved.get(id),
      updateAsync: async (selector, modifier) => {
        const doc = saved.get(selector._id);
        if (!doc) return 0;
        if (selector.active !== undefined && doc.active !== selector.active) {
          return 0;
        }
        Object.assign(doc, modifier.$set);
        return 1;
      },
    },
  };
};

const installTimers = (t) => {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const pending = [];
  global.setTimeout = (callback, delay) => {
    const timer = { callback, delay };
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
  });
  return {
    pending,
    runNext: async () => {
      const timer = pending.shift();
      assert.ok(timer, 'expected a scheduled timer');
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
  installHost(t, async () => { throw new Error('temporary failure'); });
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
  assert.equal(timers.pending.length, 1);
  assert.ok(timers.pending[0].delay > 0);
});
