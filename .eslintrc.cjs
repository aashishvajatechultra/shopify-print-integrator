module.exports = {
  root: true,
  extends: ["eslint:recommended"],
  env: { es2022: true, node: true },
  parser: "@babel/eslint-parser",
  parserOptions: {
    requireConfigFile: false,
    babelOptions: { presets: [["@babel/preset-react"]] },
    sourceType: "module",
  },
  rules: {
    "no-unused-vars": "warn",
  },
  overrides: [
    {
      files: ["**/*.jsx", "**/*.js"],
      env: { browser: true },
    },
  ],
};
