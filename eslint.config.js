import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Flat-config (eslint v9). Typed linting is enabled via
// recommendedTypeChecked so that no-floating-promises and
// no-misused-promises can catch unhandled rejections at lint time.
export default [
  {
    ignores: [
      "build/**",
      "node_modules/**",
      "*.tar.gz",
      "*.exe",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      parserOptions: {
        project: "./tsconfig.eslint.json",
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        setImmediate: "readonly",
        NodeJS: "readonly",
        // Vitest globals (only relevant under __tests__, but cheaper to
        // declare globally than to maintain a second config).
        describe: "readonly",
        it: "readonly",
        expect: "readonly",
        beforeEach: "readonly",
        afterEach: "readonly",
        beforeAll: "readonly",
        afterAll: "readonly",
        vi: "readonly",
      },
    },
    rules: {
      // Unused-import / variable detection — the original ask. Allow the
      // common `_arg` underscore convention to silence intentionally-unused
      // params (e.g. `_ctx` in evaluateComparison).
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
      // tsc already enforces this stricter than eslint can without typed
      // linting; turn off the AST-only version to avoid duplicate / wrong
      // reports.
      "no-unused-vars": "off",
      // The codebase intentionally uses `unknown` casts at boundaries
      // (YAML parse results, JSON parse, etc.) and validates structurally
      // afterwards. Keep the rule but allow `any` where it's the only
      // honest type — flag explicit `any`, allow when justified inline.
      "@typescript-eslint/no-explicit-any": "warn",
      // `Function` / empty interface bans — fine to keep on.
      "@typescript-eslint/no-empty-object-type": "off",
      // Allow non-null assertion (!) — the codebase uses it after explicit
      // null checks (e.g. `findSection(...)!.heading`) where TS narrowing
      // doesn't propagate through the function boundary.
      "@typescript-eslint/no-non-null-assertion": "off",
      // Catch require()-style imports — the codebase is pure ESM.
      "@typescript-eslint/no-require-imports": "error",
      // Typed-linting rules: catch unhandled promise rejections.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
  {
    // Tests are allowed to use `any` for terse mocks and cast tricks.
    files: ["src/__tests__/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/require-await": "off",
    },
  },
  {
    // Disable type-checked rules for JS config files (no tsconfig covers
    // them, so the type-aware parser would error).
    files: ["*.js", "*.mjs", "*.cjs"],
    ...tseslint.configs.disableTypeChecked,
  },
];
