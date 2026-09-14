const globals = require("globals");
const reactHooks = require("./frontend/node_modules/eslint-plugin-react-hooks");

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
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    files: ["frontend/**/*.jsx"],
    languageOptions: {
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
  },
  {
    files: ["frontend/src/test/**/*.{js,jsx}"],
    languageOptions: {
      globals: {
        afterEach: "readonly",
        beforeEach: "readonly",
        describe: "readonly",
        expect: "readonly",
        it: "readonly",
        vi: "readonly",
      },
    },
  },
  {
    files: ["frontend/**/*.{js,jsx}"],
    plugins: {
      "react-hooks": reactHooks,
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
