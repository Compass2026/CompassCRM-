// The trimmed Lucas export (tests/fixtures/authority-lucas-home.json) as a
// full AuthorityInput: claims, posts, Search Console and ranks empty; the
// state gazetteer the authority-run function adds.
import { readFileSync } from "node:fs";

const FX = JSON.parse(readFileSync(new URL("../fixtures/authority-lucas-home.json", import.meta.url), "utf8"));
const GAZ = JSON.parse(readFileSync(new URL("../../supabase/functions/post-drafter/gazetteer.json", import.meta.url), "utf8"));
export const LUCAS_HOME = FX;

export function lucasHomeInput(mut) {
  const fx = structuredClone(FX);
  const input = {
    asOf: fx.now.slice(0, 10), client: fx.client, brand: null, board: null, services: fx.services, keywords: fx.keywords,
    claims: [], locations: fx.locations, assets: [], offers: [],
    pageGroups: fx.pageGroupsFull.map((g) => ({ id: g.id, name: g.name, status: g.status, target_url: g.target_url, primary_keyword_id: g.primary_keyword_id })),
    authority: {
      now: fx.now, site: fx.site, pageGroupsFull: fx.pageGroupsFull, keywordExtras: [], moneyKeywordIds: fx.moneyKeywordIds,
      gsc: [], ranks: [], socialPosts: [], contentPosts: [], changeLog: [], inventory: fx.inventory, places: GAZ[fx.client.state] ?? [],
    },
  };
  mut?.(input);
  return input;
}
