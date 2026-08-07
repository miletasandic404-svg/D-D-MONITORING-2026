const globals = require("globals");

module.exports = [
  {
    ignores: ["frontend/dist/**", "frontend/node_modules/**", "node_modules/**"],
  },
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      "no-unused-vars": "warn",
      "no-undef": "error",
      "no-console": "warn",
    },
  },
  {
    // Service worker scripts run in ServiceWorkerGlobalScope, which
    // exposes globals (e.g. `clients`) that don't exist in a browser context.
    files: ["**/sw.js", "**/service-worker.js"],
    languageOptions: {
      globals: {
        ...globals.serviceworker,
      },
    },
  },
]
