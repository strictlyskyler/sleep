(function init () {

  'use strict';

  const name = 'sleep';
  const maxTimeout = 2147483647;
  const retryDelay = 30000;
  const timers = new Map();
  const starting = new Set();
  const finishing = new Set();
  let Shipments;

  const schedule = (shipmentId, lane, state) => {
    const deadline = new Date(state.deadline).getTime();
    if (!Number.isFinite(deadline)) {
      throw new TypeError(`Invalid sleep deadline for ${shipmentId}`);
    }
    if (!Number.isFinite(state.exit_code)) {
      throw new TypeError(`Invalid sleep exit code for ${shipmentId}`);
    }

    if (timers.has(shipmentId)) clearTimeout(timers.get(shipmentId));
    const delay = Math.max(0, Math.min(deadline - Date.now(), maxTimeout));
    const timer = setTimeout(async () => {
      timers.delete(shipmentId);
      if (deadline > Date.now()) {
        schedule(shipmentId, lane, state);
        return;
      }
      if (starting.has(shipmentId) || finishing.has(shipmentId)) return;

      finishing.add(shipmentId);
      try {
        const shipment = await Shipments.findOneAsync(shipmentId);
        if (!shipment || !shipment.active) return;

        const savedState = shipment.sleep_resume || state;
        if (new Date(savedState.deadline).getTime() > Date.now()) {
          schedule(shipmentId, lane, savedState);
          return;
        }
        const manifest = {
          ...structuredClone(savedState.manifest), shipment_id: shipmentId,
        };
        const exitCode = shipment.exit_code ?? savedState.exit_code;
        await H.call('Lanes#end_shipment', lane, exitCode, manifest);
      }
      catch (error) {
        console.error(`Unable to finish sleep shipment ${shipmentId}:`, error);
        schedule(shipmentId, lane, {
          ...state,
          deadline: new Date(Date.now() + retryDelay),
        });
      }
      finally {
        finishing.delete(shipmentId);
      }
    }, delay);
    timers.set(shipmentId, timer);
  };

  const resumeShipments = async (lanes, harbors, shipments) => {
    const [sleepLanes, sleepHarbor] = await Promise.all([
      lanes.find({ type: name }).fetchAsync(),
      harbors.findOneAsync(name),
    ]);

    for (const lane of sleepLanes) {
      const activeShipments = await shipments.find({
        lane: lane._id,
        active: true,
      }).fetchAsync();

      for (const shipment of activeShipments) {
        try {
          // Work may have started while the recovery query was in flight.
          if (timers.has(shipment._id) || starting.has(shipment._id) ||
            finishing.has(shipment._id)) continue;
          let state = shipment.sleep_resume;
          if (!state || !state.manifest || !state.deadline) {
            const config = sleepHarbor && sleepHarbor.lanes &&
              sleepHarbor.lanes[lane._id];
            const manifest = config && config.manifest;
            const seconds = manifest && Number(manifest.seconds);
            if (!Number.isFinite(seconds) || seconds < 0 || !shipment.actual) {
              throw new Error('No usable sleep settings or start time');
            }

            state = {
              deadline: new Date(
                new Date(shipment.actual).getTime() + seconds * 1000
              ),
              exit_code: parseInt(manifest.exit_code, 10),
              manifest: {
                ...manifest,
                shipment_id: shipment._id,
                shipment_start_date: shipment.start,
              },
            };
          }
          schedule(shipment._id, lane, state);
        }
        catch (error) {
          console.error(`Unable to resume sleep shipment ${
            shipment._id}:`, error);
        }
      }
    }
  };

  return module.exports = {
    render_input: function (values) {
      values = values || {
        seconds: 1,
        exit_code: 0,
      };

      return `
        <p>Sleep for how many seconds?</p>
        <input type=text required name="seconds" value=${values.seconds}>
        <p>Exit with:</p>
        <label>
          <input
            type=radio
            name=exit_code
            value=0
            required
            ${values.exit_code == 0 ? 'checked' : ''}
          >
          &nbsp;Success
        </label>
        <label>
          <input
            type=radio
            name=exit_code
            value=1
            required
            ${values.exit_code == 1 ? 'checked' : ''}
          >
          &nbsp;Error
        </label>
      `;
    },

    render_work_preview: function (manifest) {
      const exitText = parseInt(manifest.exit_code, 10) ?
        'an Error' : 'Success';
      const html = `<p>Sleep for <span class="pre">${
        manifest.seconds
      }</span> seconds, then exit with ${
        exitText
      }.</p>`;
      return html;
    },

    register: (lanes, users, harbors, shipments) => {
      Shipments = shipments;
      const recover = () => {
        resumeShipments(lanes, harbors, shipments).catch(error => {
          console.error('Unable to resume sleep shipments:', error);
          setTimeout(recover, retryDelay);
        });
      };
      recover();

      return { name };
    },

    update: function (lane, values) {
      if (typeof values.seconds != 'number' &&
        typeof values.seconds != 'string') {
        return false;
      }
      if (typeof values.seconds == 'string' && !values.seconds.trim()) {
        return false;
      }
      const seconds = Number(values.seconds);
      if (!Number.isFinite(seconds) || seconds < 0) return false;
      values.seconds = seconds;
      return true;
    },

    work: async function (lane, manifest) {
      if (!Number.isFinite(manifest.seconds) || manifest.seconds < 0) {
        throw new TypeError(`
          Invalid number of seconds to sleep!
          The manifest must contain a "seconds" member, which must be a
          non-negative number of seconds to sleep.
        `);
      }

      const state = {
        deadline: new Date(Date.now() + manifest.seconds * 1000),
        exit_code: parseInt(manifest.exit_code, 10),
        manifest: structuredClone(manifest),
      };
      if (!Number.isFinite(state.deadline.getTime()) ||
        !Number.isFinite(state.exit_code)) {
        throw new TypeError('Invalid sleep deadline or exit code');
      }
      starting.add(manifest.shipment_id);
      try {
        const updated = await Shipments.updateAsync(
          { _id: manifest.shipment_id, active: true },
          { $set: { sleep_resume: state } }
        );
        if (updated) schedule(manifest.shipment_id, lane, state);
        return manifest;
      }
      finally {
        starting.delete(manifest.shipment_id);
      }
    },

  };
})();
