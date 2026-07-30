const path = require("node:path");

/*
 * Test-only conditional Babel config. Presence of a Babel config makes Next.js
 * use Babel instead of SWC, so `next/font` (SWC-only) is forbidden in this
 * example. The Design Convergence plugin is added ONLY when DESIGN_CONVERGENCE
 * is set; production/default builds run the identical config with the plugin
 * absent, which must be verified by output, not assumed.
 *
 * Filename note: Next's Babel loader rejects `.cjs`/`.mjs` config files, so this
 * is `babel.config.js` (CommonJS — the example package has no "type":"module").
 * v0.1 Next.js consumers opt into this integration explicitly; there is no
 * transparent SWC support.
 */
module.exports = function babelConfig(api) {
  api.cache.using(() => process.env.DESIGN_CONVERGENCE === "true");

  const enabled = process.env.DESIGN_CONVERGENCE === "true";
  const {
    instrumentationPlugin,
  } = require("@design-convergence/instrumentation");

  return {
    presets: ["next/babel"],
    plugins: enabled
      ? [
          [
            instrumentationPlugin,
            {
              enabled: true,
              projectRoot: __dirname,
              bindingsPath: path.join(__dirname, "design-bindings.json"),
            },
          ],
        ]
      : [],
  };
};
