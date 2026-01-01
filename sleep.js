(function init () {

  'use strict';

  const name = 'sleep';
  let Shipments;

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
      return `
        <p>Sleep for <span class="pre">${
  manifest.seconds
  }</span> seconds, then exit with ${
    parseInt(manifest.exit_code, 10) ? 'an Error' : 'Success'
  }.</p>
      `;
    },

    register: (lanes, users, harbors, shipments) => {
      Shipments = shipments;
      return { name };
    },

    update: function (lane, values) {
      if (values.seconds) values.seconds = parseInt(values.seconds, 10);
      values.seconds = values.seconds || false;
      if (typeof values.seconds == 'number') return true;

      return false;
    },

    work: function (lane, manifest) {
      let exit_code = parseInt(manifest.exit_code, 10);

      if (typeof manifest.seconds != 'number') {
        throw new TypeError(`
          Invalid number of seconds to sleep!
          The manifest must contain a "seconds" member, which must be an
          integer representing the number of seconds to sleep.
        `);
      }

      try {
        setTimeout(function () {
          console.log(`Finished sleeping for ${
            manifest.seconds
          } seconds with exit code ${
            exit_code
          }`);
          const shipment = Shipments.findOne(manifest.shipment_id);
          if (shipment && shipment.exit_code) {
            console.log(`Prior exit code found: ${shipment.exit_code}`);
            exit_code = shipment.exit_code;
          }
          H.call('Lanes#end_shipment', lane, exit_code, manifest);
        }, manifest.seconds * 1000);

      }
      catch (err) {
        console.error(err);
        manifest.error = err;
      }

      return manifest;

    },

  };

})();
