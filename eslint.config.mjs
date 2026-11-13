import { defineConfig, globalIgnores } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';

export default defineConfig([
  globalIgnores(['node_modules/**', 'dist/**', 'artifacts/**', '.*-vault/**', 'vendor/**', 'dev/**', 'tests/**', 'scripts/**', 'eslint.config.mjs', 'docs/**', 'versions.json', 'package-lock.json']),
  ...obsidianmd.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
  },
]);
