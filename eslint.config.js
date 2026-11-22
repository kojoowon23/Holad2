import firebaseRulesPlugin from "@firebase/eslint-plugin-security-rules";

export default [
  {
    ignores: ["dist/**/*", "node_modules/**/*", "cloudflare-worker/**/*"],
  },
  firebaseRulesPlugin.configs["flat/recommended"],
];
