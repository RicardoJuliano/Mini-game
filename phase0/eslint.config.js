module.exports = [
  {
    // Vendored, unmodified third-party builds — not our code, not worth linting.
    ignores: ["public/shared/three.min.js", "public/shared/qrcode.min.js"],
  },
  {
    files: ["public/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        window: "readonly",
        document: "readonly",
        location: "readonly",
        navigator: "readonly",
        screen: "readonly",
        performance: "readonly",
        requestAnimationFrame: "readonly",
        setTimeout: "readonly",
        setInterval: "readonly",
        clearTimeout: "readonly",
        clearInterval: "readonly",
        WebSocket: "readonly",
        DeviceMotionEvent: "readonly",
        URLSearchParams: "readonly",
        console: "readonly",
        module: "writable",
        globalThis: "readonly",
        THREE: "readonly",
        TiltProtocol: "readonly",
        TiltVisualConfig: "readonly",
        qrcode: "readonly",
      },
    },
    rules: {
      "no-use-before-define": ["error", { functions: false, classes: true, variables: true }],
      "no-undef": "error",
      "no-unused-vars": "warn",
    },
  },
];
