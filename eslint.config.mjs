import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/generated/**', '**/.local/**'] },
  eslint.configs.recommended,
  tseslint.configs.recommended,
);
