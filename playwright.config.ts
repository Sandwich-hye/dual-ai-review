import { defineConfig } from "@playwright/test";

export default defineConfig({ testDir: "./tests/unit", timeout: 30000, reporter: "list" });
