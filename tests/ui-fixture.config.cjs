const path = require("node:path");
module.exports = {
  mode: "development", entry: "./tests/ui-fixture.js",
  output: { path: path.resolve(__dirname, "../.local-validation"), filename: "ui-fixture.js" },
  devtool: false,
};
