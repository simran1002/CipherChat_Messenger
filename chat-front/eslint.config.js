const tseslint = require("typescript-eslint");
const reactHooks = require("eslint-plugin-react-hooks");
// eslint-plugin-react-refresh is ESM-only from 0.5; require() of an ES module hands back the
// namespace, so the plugin sits under .default (older CommonJS builds return it directly).
const reactRefreshModule = require("eslint-plugin-react-refresh");
const reactRefresh = reactRefreshModule.default ?? reactRefreshModule;

module.exports = tseslint.config(
  { ignores: ["dist", "build", "node_modules"] },
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-explicit-any": "warn",
    },
  }
);
