import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: [".next/**", "node_modules/**", "coverage/**"] },
  ...tseslint.configs.recommended,
);
