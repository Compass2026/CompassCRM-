// Address guard for the site inventory: a host name is fetched only when
// every address it resolves to is public. The host-name rules in
// inventory.ts (the site's own host, http(s), no IP literals, credentials or
// ports) decide WHICH host; this decides that the host does not point inside
// a network (loopback, private, link-local, carrier-grade NAT, reserved,
// documentation, multicast, and the IPv6 equivalents, including IPv4 carried
// inside IPv6).
//
// Residual risk, accepted and documented: fetch() resolves the name again
// itself, so a host that changes its answer between this check and the
// connection (DNS rebinding) is not pinned. Every request is checked (no
// cache), which narrows that window to one lookup.
//
// Pure apart from systemResolver(), which uses Deno.resolveDns or Node's
// resolver. No resolver means no fetch (fail closed).

export type Resolver = (host: string) => Promise<string[]>;
export type HostCheck = { ok: true; addresses: string[] } | { ok: false; reason: string };

export function parseIPv4(s: string): number[] | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(p)) return null;     // decimal only, no octal-looking zeros
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

// Eight 16-bit words, or null. Accepts "::" compression and a trailing
// dotted quad; refuses zone ids ("fe80::1%eth0") and anything malformed.
export function parseIPv6(input: string): number[] | null {
  let s = input.replace(/^\[|\]$/g, "").toLowerCase();
  if (!s.includes(":") || s.includes("%")) return null;
  let tail: number[] = [];
  const quad = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (quad) {
    const v4 = parseIPv4(quad[2]);
    if (!v4) return null;
    tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    s = quad[1].endsWith("::") ? quad[1] : quad[1].slice(0, -1);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const words = (h: string) => (h === "" ? [] : h.split(":"));
  const head = words(halves[0]);
  const rest = halves.length === 2 ? words(halves[1]) : [];
  const want = 8 - tail.length;
  const given = head.length + rest.length;
  if (halves.length === 1 ? given !== want : given >= want) return null;
  const parse = (w: string) => (/^[0-9a-f]{1,4}$/.test(w) ? parseInt(w, 16) : NaN);
  const all = [...head.map(parse), ...Array(want - given).fill(0), ...rest.map(parse), ...tail];
  return all.some((n) => Number.isNaN(n)) ? null : all;
}

// [first octets, prefix length] of every IPv4 block that is not public.
const V4_BLOCKED: [number[], number][] = [
  [[0], 8],            // "this" network
  [[10], 8],           // private
  [[100, 64], 10],     // carrier-grade NAT
  [[127], 8],          // loopback
  [[169, 254], 16],    // link-local (cloud metadata lives here)
  [[172, 16], 12],     // private
  [[192, 0, 0], 24],   // IETF protocol assignments
  [[192, 0, 2], 24],   // documentation
  [[192, 88, 99], 24], // deprecated 6to4 relay anycast
  [[192, 168], 16],    // private
  [[198, 18], 15],     // benchmarking
  [[198, 51, 100], 24],// documentation
  [[203, 0, 113], 24], // documentation
  [[224], 4],          // multicast
  [[240], 4],          // reserved, and 255.255.255.255
];

const v4Int = (b: number[]) => ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;

export function isPublicIPv4(b: number[]): boolean {
  const ip = v4Int(b);
  return !V4_BLOCKED.some(([net, len]) => {
    const base = v4Int([...net, 0, 0, 0, 0].slice(0, 4));
    const mask = len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0;
    return ((ip & mask) >>> 0) === ((base & mask) >>> 0);
  });
}

const embedded = (hi: number, lo: number) => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];

// Only global unicast (2000::/3) is public, minus the reserved and
// documentation blocks inside it; IPv4 carried in IPv6 is judged as IPv4.
export function isPublicIPv6(w: number[]): boolean {
  const zeroTo = (n: number) => w.slice(0, n).every((x) => x === 0);
  if (zeroTo(5) && w[5] === 0xffff) return isPublicIPv4(embedded(w[6], w[7]));                   // ::ffff:a.b.c.d (mapped)
  if (w[0] === 0x64 && w[1] === 0xff9b && w.slice(2, 6).every((x) => x === 0)) return isPublicIPv4(embedded(w[6], w[7])); // NAT64
  if ((w[0] & 0xe000) !== 0x2000) return false;          // ::, ::1, fc00::/7, fe80::/10, ff00::/8, 64:ff9b:1::/48 …
  if (w[0] === 0x2001 && w[1] < 0x0200) return false;     // 2001::/23 IETF protocol assignments (Teredo 2001::/32, ORCHID)
  if (w[0] === 0x2001 && w[1] === 0x0db8) return false;   // documentation
  if (w[0] === 0x3fff && w[1] < 0x1000) return false;     // documentation (3fff::/20)
  if (w[0] === 0x2002) return isPublicIPv4(embedded(w[1], w[2]));                                 // 6to4
  return true;
}

// Anything that does not parse as an address is not public.
export function isPublicAddress(ip: string): boolean {
  const v4 = parseIPv4(ip);
  if (v4) return isPublicIPv4(v4);
  const v6 = parseIPv6(ip);
  return v6 ? isPublicIPv6(v6) : false;
}

// Resolves the host and refuses it unless every address is public.
export async function checkHost(host: string, resolve: Resolver | null): Promise<HostCheck> {
  if (!resolve) return { ok: false, reason: "dns_unavailable" };
  let addresses: string[];
  try { addresses = await resolve(host); } catch { return { ok: false, reason: "dns_failed" }; }
  if (!addresses.length) return { ok: false, reason: "dns_no_address" };
  const bad = addresses.find((a) => !isPublicAddress(a));
  return bad ? { ok: false, reason: `non_public_address ${bad}` } : { ok: true, addresses };
}

type DenoDns = { resolveDns?: (host: string, type: "A" | "AAAA") => Promise<string[]> };

// A and AAAA through Deno.resolveDns where it exists, then Node's resolver
// (the Edge runtime's node:dns, or Node for scripts/site-inventory.mjs);
// null when neither is available.
export async function systemResolver(): Promise<Resolver | null> {
  const deno = (globalThis as { Deno?: DenoDns }).Deno;
  let node: ((host: string) => Promise<string[]>) | null = null;
  try {
    const dns = await import("node:dns/promises");
    node = async (host) => (await dns.lookup(host, { all: true, verbatim: true })).map((x) => x.address);
  } catch { /* no node:dns */ }
  const viaDeno = deno?.resolveDns ? deno.resolveDns.bind(deno) : null;
  if (!viaDeno && !node) return null;
  return async (host) => {
    if (viaDeno) {
      const [a, aaaa] = await Promise.allSettled([viaDeno(host, "A"), viaDeno(host, "AAAA")]);
      const got = [...(a.status === "fulfilled" ? a.value : []), ...(aaaa.status === "fulfilled" ? aaaa.value : [])];
      if (got.length || !node) {
        if (!got.length && a.status === "rejected") throw a.reason;
        return got;
      }
    }
    return node!(host);
  };
}
