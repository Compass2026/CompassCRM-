import type { Database } from './database.types';
export type BrandWorkspace = Database['public']['Tables']['client_brand_workspaces']['Row'];
export const WORKSPACE_TEXT_FIELDS = [
  ['positioning','Positioning'], ['voice_tone','Voice and tone'], ['audience','Audience'],
  ['tagline','Tagline'], ['differentiators','Differentiators (claims still need evidence)'],
  ['imagery_style','Image guidance'], ['typography_notes','Typography'],
  ['ai_guidance','Blog and social writing guidance'], ['standing_cta','Call to action'],
] as const;
export const WORKSPACE_LIST_FIELDS = [
  ['content_pillars','Content pillars'], ['words_we_use','Words we use'],
  ['words_we_avoid','Words we avoid'], ['hard_rules','Hard rules'],
] as const;
export function parsePalette(value: string): {name:string;hex:string}[] {
  return value.split(/\r?\n/).filter(s=>s.trim()).map(line=>{
    const [name,hex,...extra]=line.split('|').map(s=>s.trim());
    if (!name || !/^#[a-f0-9]{6}$/i.test(hex??'') || extra.length) throw new Error('Use Color name | #rrggbb, one per line.');
    return {name,hex:hex.toLowerCase()};
  });
}
