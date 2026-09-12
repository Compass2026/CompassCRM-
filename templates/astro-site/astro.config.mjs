import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import { site } from "./src/config/site";

// `site` must be the production URL: canonicals, the sitemap, llms.txt and
// every JSON-LD @id are built from it.
export default defineConfig({
  site: site.url,
  trailingSlash: "always",
  integrations: [sitemap()],
});
