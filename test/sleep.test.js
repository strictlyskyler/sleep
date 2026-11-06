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

const create_shipment = (db, id, manifest, actual = new Date(Date.now())) => {
  const shipment = {
    _id: id, lane: lane._id, active: true, actual,
    manifest: { ...manifest, shipment_id: id },
  };
  db.saved.set(id, shipment);
  return shipment;
};

const prepare = async (t, documents = []) => {
  const timers = installTimers(t);
  const calls = [];
  installHost(t, async (...args) => calls.push(args));
  const retries = [];
  global.H.retry = (key, work) => {
    const job = { key, work, cancelled: false };
    retries.push(job);
    return () => { job.cancelled = true; };
  };
  const db = makeCollections(documents, null);
  const sleep = loadSleep();
  sleep.register(db.lanes, null, db.harbors, db.shipments);
  return { timers, calls, db, sleep, retries };
};

test('rendering uses defaults and saved values', () => {
  const sleep = loadSleep();
  assert.match(sleep.render_input(), /value=1/);
  assert.match(sleep.render_input({ seconds: 5, exit_code: 1 }), /value=5/);
  assert.match(sleep.render_work_preview({ seconds: 1, exit_code: 0 }),
    /Success/);
  assert.match(sleep.render_work_preview({ seconds: 1, exit_code: 1 }),
    /an Error/);
});

test('update accepts numbers and rejects invalid input', () => {
  const sleep = loadSleep();
  for (const seconds of ['', ' ', 'invalid', '-1', [], [5], true,
    undefined, Infinity, NaN]) {
    assert.equal(sleep.update(lane, { seconds }), false);
  }
  for (const seconds of [5, '5', '0', '0.5']) {
    const manifest = { seconds };
    assert.equal(sleep.update(lane, manifest), true);
    assert.equal(manifest.seconds, Number(seconds));
  }
});

test('register has no startup side effects', async (t) => {
  const { sleep, db, timers } = await prepare(t);
  create_shipment(db, 'active', { seconds: 0, exit_code: 0 });
  assert.deepEqual(sleep.register(db.lanes, null, db.harbors, db.shipments),
    { name: 'sleep' });
  await flushRecovery();
  assert.equal(timers.pending.length, 0);
  await sleep.resume();
  assert.equal(timers.pending.length, 1);
});

test('work schedules from the atomic input snapshot without a settings write',
  async (t) => {
    const { sleep, db, timers, calls } = await prepare(t);
    db.shipments.updateAsync = () => assert.fail('unexpected settings write');
    const shipment = create_shipment(db, 'work', {
      seconds: 5, exit_code: '1', prior_manifest: { original: true },
    });
    const manifest = structuredClone(shipment.manifest);
    assert.equal(sleep.work(lane, manifest, shipment), manifest);
    manifest.prior_manifest.original = false;
    assert.equal(timers.pending[0].delay, 5000);
    await timers.runNext();
    assert.equal(calls.length, 1);
    assert.equal(calls[0][2], 1);
    assert.equal(calls[0][3].prior_manifest.original, true);
  });

test('restart schedules remaining time from the original input', async (t) => {
  const { sleep, db, timers, calls } = await prepare(t);
  const shipment = create_shipment(db, 'restart', { seconds: 5, exit_code: 0 },
    new Date(Date.now() - 2000));
  await sleep.resume();
  assert.equal(timers.pending[0].delay, 3000);
  await sleep.resume();
  assert.equal(timers.pending.length, 1);
  await timers.runNext();
  assert.equal(calls[0][3].shipment_id, shipment._id);
});

for (const method of ['work', 'resume']) {
  test(`${method} preserves typed manifest context`, async (t) => {
    const { sleep, db, timers, calls } = await prepare(t);
    class RecordId {
      constructor (value) { this.value = value; }
      toHexString () { return this.value; }
    }
    const shipment = create_shipment(db, 'typed',
      { seconds: 0, exit_code: 0 });
    const read = () => ({ ...shipment, manifest: { ...shipment.manifest,
      prior_manifest: { record_id: new RecordId('000000000000000000000123') },
    } });
    // Collection reads reconstruct the custom types stored in the database.
    db.shipments.findOneAsync = async () => read();
    db.shipments.find = () => ({ fetchAsync: async () => [read()] });
    if (method == 'work') sleep.work(lane, shipment.manifest, read());
    else await sleep.resume();
    await timers.runNext();
    const record_id = calls[0][3].prior_manifest.record_id;
    assert.ok(record_id instanceof RecordId);
    assert.equal(record_id.toHexString(), '000000000000000000000123');
  });
}

test('recovery and work on independent servers use the same durable settings',
  async (t) => {
    const { sleep, db, timers, calls } = await prepare(t);
    const shipment = create_shipment(db, 'two-servers', {
      seconds: 5, exit_code: 0,
    });
    const second = loadSleep();
    second.register(db.lanes, null, db.harbors, db.shipments);
    await second.resume();
    sleep.work(lane, shipment.manifest, shipment);
    assert.deepEqual(timers.pending.map(timer => timer.delay), [5000, 5000]);
    await timers.runNext();
    shipment.active = false; // Core's atomic completion wins on one server.
    await timers.runNext();
    assert.equal(calls.length, 1);
    assert.equal(calls[0][2], 0);
  });

test('work replaces its own existing timer', async (t) => {
  const { sleep, db, timers } = await prepare(t);
  assert.equal(sleep.replay_safe, true);
  const shipment = create_shipment(db, 'replace', { seconds: 1, exit_code: 0 });
  sleep.work(lane, shipment.manifest, shipment);
  sleep.work(lane, shipment.manifest, shipment);
  assert.equal(timers.pending.length, 1);
});

test('resume leaves pending dispatches to the core handoff', async (t) => {
  const { sleep, db, timers, calls } = await prepare(t);
  const prepared = create_shipment(db, 'prepared',
    { seconds: 0, exit_code: 0 });
  prepared.dispatch = { pending: false };
  const ready = create_shipment(db, 'ready', { seconds: 0, exit_code: 0 });
  ready.dispatch = { pending: true };
  const running = create_shipment(db, 'running', { seconds: 0, exit_code: 0 });
  running.dispatch = { pending: false, started: new Date() };
  await sleep.resume();
  assert.equal(timers.pending.length, 1);
  await timers.runNext();
  sleep.resume_shipment(lane, ready);
  await timers.runNext();
  assert.deepEqual(calls.map(call => call[3].shipment_id),
    ['running', 'ready']);
  prepared.dispatch.pending = true;
  ready.active = false;
  running.active = false;
  await sleep.resume();
  assert.equal(timers.pending.length, 0);
  sleep.resume_shipment(lane, prepared);
  assert.equal(timers.pending.length, 1);
  await timers.runNext();
  assert.equal(calls[2][3].shipment_id, 'prepared');
});

test('pending work waits for core to save its return before arming a timer',
  async (t) => {
    const { sleep, db, timers, calls } = await prepare(t);
    const shipment = create_shipment(db, 'pending',
      { seconds: 0, exit_code: 0 });
    shipment.dispatch = { pending: true };
    assert.equal(sleep.work(lane, shipment.manifest, shipment),
      shipment.manifest);
    assert.equal(timers.pending.length, 0);
    sleep.resume_shipment(lane, shipment);
    await timers.runNext();
    assert.equal(calls.length, 1);
    shipment.manifest.seconds = -1;
    assert.throws(() => sleep.work(lane, shipment.manifest, shipment),
      /Invalid number/);
  });

test('resume preserves deadlines saved by the previous harbor', async (t) => {
  const { sleep, db, timers, calls } = await prepare(t);
  db.saved.set('previous', {
    _id: 'previous', lane: lane._id, active: true,
    sleep_resume: {
      deadline: new Date(Date.now() - 1000), exit_code: 1,
      manifest: { seconds: 5, exit_code: 1, prior_manifest: 'original' },
    },
  });
  await sleep.resume();
  assert.equal(timers.pending[0].delay, 0);
  await timers.runNext();
  assert.equal(calls[0][2], 1);
  assert.equal(calls[0][3].prior_manifest, 'original');
});

test('invalid records are reported without preventing other recovery',
  async (t) => {
    const { sleep, db, timers } = await prepare(t);
    const errors = [];
    const original = console.error;
    console.error = (...args) => errors.push(args);
    t.after(() => { console.error = original; });
    for (const [id, manifest, actual] of [
      ['missing', undefined, new Date()],
      ['negative', { seconds: -1 }, new Date()],
      ['invalid-seconds', { seconds: '5' }, new Date()],
      ['invalid-date', { seconds: 1, exit_code: 0 }, 'invalid'],
      ['out-of-range', { seconds: 1e13, exit_code: 0 }, new Date()],
      ['invalid-exit', { seconds: 1, exit_code: 'invalid' }, new Date()],
    ]) {
      db.saved.set(id, { _id: id, lane: lane._id, active: true,
        manifest, actual });
    }
    db.saved.set('invalid-saved', {
      _id: 'invalid-saved', lane: lane._id, active: true,
      sleep_resume: { deadline: null, exit_code: 0,
        manifest: { seconds: 1, exit_code: 0 } },
    });
    create_shipment(db, 'valid', { seconds: 0, exit_code: 0 });
    await sleep.resume();
    assert.equal(errors.length, 7);
    assert.equal(timers.pending.length, 1);
    assert.throws(() => sleep.work(lane, {}, db.saved.get('negative')),
      /Invalid number/);
  });

test('database query failures propagate to the recovery retry', async (t) => {
  const { sleep, db } = await prepare(t);
  db.shipments.find = () => ({ fetchAsync: async () => {
    throw new Error('database unavailable');
  } });
  await assert.rejects(sleep.resume(), /database unavailable/);
});

test('missing and reset shipments do not finish', async (t) => {
  const { sleep, db, timers, calls } = await prepare(t);
  const shipment = create_shipment(db, 'reset', { seconds: 0, exit_code: 0 });
  sleep.work(lane, shipment.manifest, shipment);
  shipment.active = false;
  await timers.runNext();
  shipment.active = true;
  sleep.work(lane, shipment.manifest, shipment);
  db.saved.delete(shipment._id);
  await timers.runNext();
  assert.equal(calls.length, 0);
});

test('a later durable deadline and a zero exit override are respected',
  async (t) => {
    const { sleep, db, timers, calls } = await prepare(t);
    const shipment = create_shipment(db, 'later', { seconds: 0, exit_code: 1 });
    sleep.work(lane, shipment.manifest, shipment);
    shipment.manifest.seconds = 5;
    shipment.exit_code = 0;
    await timers.runNext();
    assert.equal(calls.length, 0);
    assert.equal(timers.pending[0].delay, 5000);
    await timers.runNext();
    assert.equal(calls[0][2], 0);
  });

test('long sleeps honor the Node timeout limit', async (t) => {
  const { sleep, db, timers, calls } = await prepare(t);
  const shipment = create_shipment(db, 'long', {
    seconds: 2147484.147, exit_code: 0,
  });
  sleep.work(lane, shipment.manifest, shipment);
  assert.equal(timers.pending[0].delay, 2147483647);
  await timers.runNext();
  assert.equal(calls.length, 0);
  assert.equal(timers.pending[0].delay, 500);
  await timers.runNext();
  assert.equal(calls.length, 1);
});

test('completion and read failures retry without moving the deadline',
  async (t) => {
    const { sleep, db, timers, calls, retries } = await prepare(t);
    const original = console.error;
    console.error = () => {};
    t.after(() => { console.error = original; });
    const shipment = create_shipment(db, 'retry', { seconds: 1, exit_code: 0 });
    const deadline = shipment.actual.getTime() + 1000;
    const read = db.shipments.findOneAsync;
    db.shipments.findOneAsync = async () => {
      throw new Error('read failure');
    };
    sleep.work(lane, shipment.manifest, shipment);
    await timers.runNext();
    assert.equal(timers.pending.length, 0);
    assert.equal(retries[0].key, 'sleep:retry');
    db.shipments.findOneAsync = read;
    global.H.call = async () => { throw new Error('completion failure'); };
    await assert.rejects(retries[0].work(), /completion failure/);
    global.H.call = async (...args) => calls.push(args);
    await retries[0].work();
    assert.equal(calls.length, 1);
    assert.equal(shipment.actual.getTime() + 1000, deadline);
  });

[false, true].forEach(fails => {
  test(`a replaced timer ignores an old read: ${fails}`, async (t) => {
    const { sleep, db, timers, calls, retries } = await prepare(t);
    const shipment = create_shipment(db, 'stale', { seconds: 0, exit_code: 0 });
    const read = db.shipments.findOneAsync;
    let release;
    db.shipments.findOneAsync = () => new Promise((resolve, reject) => {
      release = () => fails ? reject(new Error('old read failed')) :
        resolve(structuredClone(shipment));
    });
    sleep.work(lane, shipment.manifest, shipment);
    const running = timers.runNext();
    await Promise.resolve();
    sleep.work(lane, shipment.manifest, shipment);
    release();
    await running;
    assert.equal(retries.length, 0);
    assert.equal(calls.length, 0);
    db.shipments.findOneAsync = read;
    await timers.runNext();
    assert.equal(calls.length, 1);
  });
});

test('work cancels backoff without losing its replacement timer', async (t) => {
  const { sleep, db, timers, calls, retries } = await prepare(t);
  const error = console.error;
  console.error = () => {};
  t.after(() => { console.error = error; });
  const shipment = create_shipment(db, 'retry-replaced',
    { seconds: 0, exit_code: 0 });
  const read = db.shipments.findOneAsync;
  db.shipments.findOneAsync = async () => { throw new Error('unavailable'); };
  sleep.work(lane, shipment.manifest, shipment);
  await timers.runNext();
  db.shipments.findOneAsync = read;
  sleep.work(lane, shipment.manifest, shipment);
  assert.equal(retries[0].cancelled, true);
  await retries[0].work();
  assert.equal(calls.length, 0);
  assert.equal(timers.pending.length, 1);
  await timers.runNext();
  assert.equal(calls.length, 1);
});

test('a late completion does not remove a replacement timer', async (t) => {
  const { sleep, db, timers, calls } = await prepare(t);
  const shipment = create_shipment(db, 'finishing',
    { seconds: 0, exit_code: 0 });
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  global.H.call = async (...args) => {
    calls.push(args);
    entered();
    await new Promise(resolve => { release = resolve; });
  };
  sleep.work(lane, shipment.manifest, shipment);
  const finishing = timers.runNext();
  await started;
  sleep.work(lane, shipment.manifest, shipment);
  sleep.resume_shipment(lane, shipment);
  release();
  await finishing;
  assert.equal(timers.pending.length, 1);
  shipment.active = false;
  await timers.runNext();
  assert.equal(calls.length, 1);
});
