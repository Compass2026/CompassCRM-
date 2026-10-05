// opentype.js 1.3.4 ships no types; the Creative Engine uses parse() only
// (supabase/functions/creative-engine/text.ts types the font it returns).
declare module "opentype.js" {
  const opentype: { parse(buffer: ArrayBuffer): unknown };
  export default opentype;
}
