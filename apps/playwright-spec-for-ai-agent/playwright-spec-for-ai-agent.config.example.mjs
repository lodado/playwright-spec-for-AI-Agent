/** Copy to the consumer repository root as playwright-spec-for-ai-agent.config.mjs. */
export default {
  specDir: "src/page/{page}/__tests__",
  baseUrl: "https://staging.example.com",
  pages: {
    dashboard: {
      targetPath: "/dashboard",
    },
    "account/settings": {
      specDir: "tests/settings",
      targetPath: "/app/settings",
    },
  },
};
