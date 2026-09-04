import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTypeScript,
  {
    files: ["src/domain/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          { group: ["next", "next/**", "react", "react/**", "react-dom", "react-dom/**", "@modelcontextprotocol/**", "node:*", "@/server/**", "@/integrations/**", "../server/**", "../integrations/**"], message: "Keep the domain independent of frameworks, transport and provider code." }
        ]
      }]
    }
  },
  {
    files: ["src/domain/**/*.ts", "src/integrations/**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "error" }
  },
  globalIgnores([".next/**", "out/**", "coverage/**", "playwright-report/**", "test-results/**", "next-env.d.ts"])
]);
