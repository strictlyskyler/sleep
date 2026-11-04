(function init () {

  'use strict';

  const name = 'sleep';
  const max_timeout = 2147483647;
  const retry_delay = 30000;
  const timers = new Map();
  let Lanes;
  let Shipments;

  const sleep_state = (shipment) => {
    const saved = shipment.sleep_resume;
    const manifest = saved ? saved.manifest : shipment.manifest;
    if (!manifest || !Number.isFinite(manifest.seconds) ||
      manifest.seconds < 0) {
      throw new TypeError('Invalid number of seconds to sleep');
    }
    const actual = new Date(shipment.actual || NaN).getTime();
    const deadline = new Date(saved ? saved.deadline || NaN :
      actual + manifest.seconds * 1000).getTime();
    const exit_code = saved ? saved.exit_code :
      parseInt(manifest.exit_code, 10);
    if (!Number.isFinite(deadline) || !Number.isFinite(exit_code)) {
      throw new TypeError('Invalid sleep deadline or exit code');
    }
    return { deadline, exit_code, manifest: structuredClone(manifest) };
  };

  const schedule = (lane, shipment, retry = false) => {
    const state = sleep_state(shipment);
    const shipment_id = shipment._id;
    if (timers.has(shipment_id)) clearTimeout(timers.get(shipment_id));
    const delay = retry ? retry_delay :
      Math.max(0, Math.min(state.deadline - Date.now(), max_timeout));
    timers.set(shipment_id, setTimeout(async () => {
      timers.delete(shipment_id);
      try {
        const current = await Shipments.findOneAsync(shipment_id);
        if (!current || !current.active) return;
        const current_state = sleep_state(current);
        if (current_state.deadline > Date.now()) {
          schedule(lane, current);
          return;
        }
        const manifest = {
          ...current_state.manifest, shipment_id,
        };
        await H.call('Lanes#end_shipment', lane,
          current.exit_code ?? current_state.exit_code, manifest);
      }
      catch (error) {
        console.error(`Unable to finish sleep shipment ${shipment_id}:`, error);
        schedule(lane, shipment, true);
      }
    }, delay));
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
      Lanes = lanes;
      Shipments = shipments;
      return { name };
    },

    resume: async () => {
      const lanes = await Lanes.find({ type: name }).fetchAsync();
      for (const lane of lanes) {
        const shipments = await Shipments.find({
          lane: lane._id, active: true,
        }).fetchAsync();
        for (const shipment of shipments) {
          if (timers.has(shipment._id)) continue;
          try {
            schedule(lane, shipment);
          }
          catch (error) {
            console.error(`Unable to resume sleep shipment ${
              shipment._id}:`, error);
          }
        }
      }
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

    work: function (lane, manifest, shipment) {
      schedule(lane, shipment);
      return manifest;
    },

  };
})();
