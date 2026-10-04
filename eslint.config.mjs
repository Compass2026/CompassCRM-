import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // The Astro starter is a separate project with its own toolchain.
    "templates/**",
    "supabase/functions/**",
    // The billing runtime (Vercel project compass-billing) has its own
    // package, typecheck and build (billing/package.json).
    "billing/**",
  ]),
]);

export default eslintConfig;
