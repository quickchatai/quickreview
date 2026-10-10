// ESLint (flat config) for QuickReview.
//
// The stack is deliberately three packages — eslint, typescript-eslint,
// prettier — and no rule plugins beyond them. Formatting is Prettier's job
// and ESLint has no opinion about it (ESLint 10 ships no formatting rules at
// all, so the two cannot conflict and eslint-config-prettier is not needed).
// What ESLint is here for is the class of defect this codebase is prone to:
// promises that were never awaited, and unions that grew a member while a
// switch did not.

import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // ---------------------------------------------------------------------
    // Not linted, and each exclusion has a reason.
    // ---------------------------------------------------------------------
    ignores: [
      "dist/**",
      "node_modules/**",

      // Runtime state the daemon, TUI and tests write. Gitignored already.
      // The reviewed repo's base clone is absent from this list on purpose:
      // its directory name is derived per-install ([review] clone_dir), so
      // there is no fixed name to write down.
      "state/**",
      "inject/**",
      "verdict/**",
      "commands/**",
      "digest/**",
      "archive/**",
      "memory/**",
      "wt/**",
      "evidence/**",
      "reports/**",
      "pihome/**",
      "state-snapshots/**",
      "coverage/**",
      ".claude/worktrees/**",

      // VENDORED VERBATIM. This mirrors what tsconfig.json and
      // tsconfig.tests.json already exclude, for the same reason they exclude
      // it: provenance for these files is a byte comparison against a pinned
      // upstream (rule 7 — extensions/vendor/openviking-pi/upstream.json
      // records the commit, and tests/openviking-fork.test.ts fails on drift).
      // An unused-variable or floating-promise "fix" in vendored code is a
      // LOCAL MODIFICATION we are forbidden to make, so linting it could only
      // ever produce findings nobody is allowed to act on.
      //
      // extensions/inline-bash.ts is the same situation one file at a time:
      // copied unmodified from the pinned pi release's shipped examples, and
      // excluded from the BUILD because it uses pi API surface our
      // deliberately-minimal ambient pi-api.d.ts does not declare. Type-aware
      // rules cannot run on a file tsc will not type-check.
      "extensions/vendor/**",
      "extensions/inline-bash.ts",
    ],
  },

  // -----------------------------------------------------------------------
  // TypeScript: src/, extensions/ (minus the vendored files above), tests/.
  // -----------------------------------------------------------------------
  {
    files: ["src/**/*.ts", "extensions/**/*.ts", "tests/**/*.ts"],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        // Type information comes from the TypeScript project service, which
        // resolves each file to its owning tsconfig the way the compiler and
        // the editor do — no hand-maintained project list to drift.
        //
        // It covers src/ and extensions/, which the root tsconfig.json
        // includes. tests/ needs the override below: see there.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // ------------------------------------------------------------------
      // The four type-aware rules this repo is actually here for.
      // ------------------------------------------------------------------

      // A dropped promise is this system's signature bug: the daemon is a
      // pump of async steps, and a delivery that resolves without having
      // happened is exactly how a review round goes missing. Errors, not
      // warnings. `void expr` is the sanctioned escape hatch and reads as a
      // deliberate fire-and-forget at the call site.
      "@typescript-eslint/no-floating-promises": "error",

      // The same defect in callback position — passing an async function
      // where a void-returning one is expected, so nothing can ever observe
      // the rejection.
      "@typescript-eslint/no-misused-promises": "error",

      // Verdicts, mutation kinds, session states and PR lifecycle states are
      // all string unions that get new members. A switch that silently stops
      // covering one is a wrong answer with no error.
      // `considerDefaultExhaustiveForUnions` is what makes this rule usable
      // here rather than noisy: a `default:` clause IS the author saying
      // "every remaining member is handled this way", and this codebase uses
      // that shape deliberately (TUI key handlers that act on a few keys and
      // ignore the rest; MemoryStore.rewrite defaulting to null). Without the
      // option a switch with a default still reports, so the rule would fire
      // on correct sites and hide the ones that are not. With
      // it, what remains is a switch that covers PART of a union and has NO
      // default — which is the actual defect: a new union member falls
      // through to nothing, silently.
      "@typescript-eslint/switch-exhaustiveness-check": [
        "error",
        { considerDefaultExhaustiveForUnions: true },
      ],

      // Type-only imports are erased at emit. Making them explicit keeps the
      // module graph honest under NodeNext/ESM, where a runtime import of a
      // module that only supplies types is a real (and load-bearing) edge.
      // `disallowTypeAnnotations` is off because an inline `import("./x.js").T`
      // in a TYPE position is already type-only — it is erased at emit and
      // cannot create a runtime edge, which is precisely why src/daemon.ts
      // uses it: that module is the stub-wired core, and its optional hook
      // signatures name types from modules it must not pull into the runtime
      // graph. What the rule is here for is the case that CAN create an edge
      // — a value `import` used only for types — and that half stays on.
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          prefer: "type-imports",
          fixStyle: "inline-type-imports",
          disallowTypeAnnotations: false,
        },
      ],

      // ------------------------------------------------------------------
      // Rules relaxed because they fire on a deliberate, consistent idiom
      // rather than on a defect. Each is stated with what the idiom is.
      // ------------------------------------------------------------------

      // Boundary code — webhook payloads, GitHub REST/GraphQL responses,
      // verdict JSON written by a model, pi's ambient extension API — is
      // typed `any` at the seam on purpose and narrowed immediately after.
      // These rules fire on that narrowing, not on the unsafety: the
      // check that matters (does the narrowed value get used as its narrowed
      // type) is tsc's, and tsc runs strict.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",

      // Almost every `async` in this tree exists to SATISFY AN ASYNC SEAM,
      // not to await something: SessionHooks, MemoryStore, DockerRunner, the
      // GitHub adapter and the reconcile adapter are all async interfaces,
      // and their implementations and (most of all) their test doubles are
      // written `async () => []`. Dropping `async` there is not a
      // cleanup — it changes the return type from `Promise<T>` to `T` and
      // stops the value satisfying the interface. The rule is asking for a
      // change we are not allowed to make, on a shape that is correct.
      "@typescript-eslint/require-await": "off",

      // The TUI is a terminal front end: it parses OSC 52 clipboard replies,
      // strips CSI/OSC sequences out of mirrored pi output, and scrubs
      // control characters out of text before it reaches a frame. Control
      // characters in those regexes are the subject matter, not a typo.
      "no-control-regex": "off",

      // Fires on `String(x)`/template interpolation where the operand is
      // `unknown` or a wide boundary type — the same narrowing idiom the
      // no-unsafe-* rules above are off for, and in several places (see
      // extensions/tui-view.ts) the code already branches on `typeof x ===
      // "object"` and the rule cannot see it. Kept as a WARNING rather than
      // removed, because a genuine "[object Object]" in a posted review body
      // is a real defect and worth seeing in a new hit.
      "@typescript-eslint/no-base-to-string": "warn",

      // This codebase pulls an optional hook off its owner and then invokes it
      // with an explicit receiver — `const alive = hooks.sessionAlive; …
      // alive.call(hooks, pr)` (src/verdicts.ts, src/reconcile.ts,
      // extensions/onboarding.ts). That IS the binding the rule asks for, but
      // the rule reports at the EXTRACTION and cannot see the `.call` that
      // follows, so every hit is the correct pattern being flagged.
      "@typescript-eslint/unbound-method": "off",

      // Fires on `TimerHandle | null` and `unknown | undefined`, where the
      // named alias IS the documentation: `TimerHandle` (= unknown, an opaque
      // host timer) says what the value is for in a way that collapsing the
      // union to bare `unknown` would delete. Technically redundant to the
      // compiler; load-bearing to a reader.
      "@typescript-eslint/no-redundant-type-constituents": "off",

      // Every hit is the same deliberate shape, and it is this
      // system's core discipline written as code: declare with the FAILURE
      // default, overwrite on success, restore the default on throw —
      //     let ref: PrRef | null = null;
      //     try { ref = await adapter.getPr(n); } catch { continue; }
      // The initializer is dead only because every path assigns or leaves,
      // and stating the fallback at the declaration is the point: a refusal
      // is never a throw. Dropping it would be churn that reads worse.
      "no-useless-assignment": "off",

      // `any` appears where an external shape genuinely is unknown until it
      // is parsed. Downgraded rather than removed so a new one is visible in
      // review without failing the build.
      "@typescript-eslint/no-explicit-any": "warn",

      // `ignoreReadBeforeAssign` covers the circular-wiring pattern the tests
      // need: `let adapter!: GitHubAdapter;` is READ inside the closure handed
      // to `new MutationGate(...)` before the line that assigns it, so it
      // cannot be a `const` at all — the rule's suggestion does not compile.
      "prefer-const": ["error", { ignoreReadBeforeAssign: true }],

      // An unused argument is often the signature of a seam being satisfied
      // (SessionHooks, DockerRunner, MemoryStore all have methods whose test
      // doubles ignore parameters the real one needs). Leading-underscore is
      // this repo's existing marker for that; unused LOCALS still error,
      // because those are stale assertions.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          args: "after-used",
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "all",
          caughtErrorsIgnorePattern: "^_",
          // `const { finished_at, ...missing } = verdictFile();` is the
          // standard way to build "the same object without that field", and
          // the named sibling is the omission, not a forgotten variable.
          ignoreRestSiblings: true,
        },
      ],
    },
  },

  // -----------------------------------------------------------------------
  // Test-only relaxations.
  // -----------------------------------------------------------------------
  {
    files: ["tests/**/*.ts"],
    languageOptions: {
      parserOptions: {
        // tests/ is deliberately EXCLUDED from tsconfig.json — the build emits
        // nothing for it — and type-checked by tsconfig.tests.json instead.
        // The project service resolves a file by walking up to the nearest
        // tsconfig.json, which here is the root one that excludes these files,
        // so every test would be reported as "not found by the project
        // service". Naming the project explicitly is the fix; it is the same
        // project `npm run typecheck:tests` uses, so ESLint and that fence
        // cannot disagree about what a test's types are.
        projectService: false,
        project: ["./tsconfig.tests.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Test doubles routinely assert a shape the compiler cannot see (a
      // partial hook object, a hand-built payload) and then cast. That is
      // what a double IS; requiring it to satisfy the full interface would
      // make the double the thing under test.
      "@typescript-eslint/no-unnecessary-type-assertion": "off",

      // Vitest's `expect(...)` chains are expressions used for effect.
      "@typescript-eslint/no-unused-expressions": "off",
    },
  },

  // -----------------------------------------------------------------------
  // Plain JS/ESM: the repo's own tooling and helper scripts. These are not
  // in any tsconfig, so they get syntax and correctness rules WITHOUT type
  // information — running the type-checked set here would only report that
  // everything is `any`.
  // -----------------------------------------------------------------------
  {
    files: ["scripts/*.mjs", "deploy/*.mjs", "*.js", "*.mjs"],
    extends: [js.configs.recommended, tseslint.configs.disableTypeChecked],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        AbortController: "readonly",
        AbortSignal: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        setImmediate: "readonly",
        queueMicrotask: "readonly",
        structuredClone: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
      },
    },
    rules: {
      "no-unused-vars": [
        "error",
        { args: "after-used", argsIgnorePattern: "^_", caughtErrors: "all" },
      ],
      // Same declare-with-the-failure-default idiom as the TypeScript block
      // above, and off here for the same reason.
      "no-useless-assignment": "off",
    },
  },
);
