const globals = require("globals");
const reactHooks = require("eslint-plugin-react-hooks");

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
    plugins: {
      "react-hooks": require("eslint-plugin-react-hooks"),
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
    plugins: {
      "react-hooks": require("eslint-plugin-react-hooks"),
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
    plugins: {
      "react-hooks": require("eslint-plugin-react-hooks"),
    },
  },
  {
    files: ["frontend/**/*.{js,jsx}"],
    plugins: {
      "react-hooks": require("eslint-plugin-react-hooks"),
    },
  },
  {
    // Service worker scripts run in ServiceWorkerGlobalScope, which
    // exposes globals (e.g. `clients`) that don't exist in a browser context.
    files: ["**/sw.js", "**/service-worker.js"],
    languageOptions: {
      globals: {
        ...require("globals").serviceworker,
      },
    },
  },
]