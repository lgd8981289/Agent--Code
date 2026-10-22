import js from "@eslint/js";
import ts from "typescript-eslint";
import vue from "eslint-plugin-vue";
import globals from "globals";

export default [
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "web/dist/**",
      "data/**",
      "workspaces/**",
      "test-artifacts/**",
    ],
  },
  js.configs.recommended,
  ...ts.configs.recommended,
  ...vue.configs["flat/essential"],
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      "no-empty": ["error", { allowEmptyCatch: true }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", caughtErrors: "none" },
      ],
    },
  },
  { files: ["**/*.vue"], languageOptions: { parserOptions: { parser: ts.parser } } },
  {
    files: ["scripts/**/*.mjs", "web/public/**/*.js", "*.mjs"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  // 测试替身需要表达供应商的动态 JSON；生产代码仍禁止显式 any。
  { files: ["test/**/*.ts"], rules: { "@typescript-eslint/no-explicit-any": "off" } },
];
