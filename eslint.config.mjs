// Minimal ESLint v9 flat config — no FlatCompat, no compat layer needed.
// Build-time linting is fully disabled via `eslint: { ignoreDuringBuilds: true }`
// in next.config.mjs, so this file only needs to be syntactically valid.

/** @type {import('eslint').Linter.Config[]} */
const eslintConfig = [
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'out/**',
      'public/**',
    ],
  },
]

export default eslintConfig
