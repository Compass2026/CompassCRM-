// The inventory's address guard (supabase/functions/authority/netguard.ts)
// and how inventorySite uses it: DNS is resolved before every request, a
// host with any non-public address is refused, redirects are re-checked
// hop by hop, and the run is bounded (concurrency, budget, body size).
import { test } from "node:test";
import assert from "node:assert/strict";
import { isPublicAddress, parseIPv6, checkHost } from "../supabase/functions/authority/netguard.ts";
import { inventorySite, INVENTORY_LIMITS } from "../supabase/functions/authority/inventory.ts";

const SITE = "https://www.example-roofing.com";
const PUBLIC = ["93.184.216.34"];

test("IPv4: private, loopback, link-local, CGNAT, reserved, documentation and multicast are refused", () => {
  for (const ip of ["0.0.0.0", "0.1.2.3", "10.0.0.1", "10.255.255.255", "100.64.0.1", "100.127.255.255", "127.0.0.1", "127.8.9.10",
    "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.0.0.8", "192.0.2.1", "192.88.99.1", "192.168.1.1", "198.18.0.1",
    "198.19.255.255", "198.51.100.7", "203.0.113.9", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255"]) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
});

test("IPv4: public addresses, including the neighbours of blocked ranges, pass", () => {
  for (const ip of ["93.184.216.34", "8.8.8.8", "1.1.1.1", "100.63.255.255", "100.128.0.0", "172.15.255.255", "172.32.0.0",
    "169.253.255.255", "192.167.255.255", "198.17.255.255", "198.20.0.0", "223.255.255.255", "11.0.0.1"]) {
    assert.equal(isPublicAddress(ip), true, ip);
  }
});

test("IPv6: loopback, unspecified, ULA, link-local, site-local, multicast, discard, documentation and tunnels are refused", () => {
  for (const ip of ["::", "::1", "fc00::1", "fd12:3456:789a::1", "fe80::1", "febf::1", "fec0::1", "ff02::1", "ff05::2",
    "100::1", "2001:db8::1", "2001:0db8:85a3::8a2e:370:7334", "2001::1", "2001:0:4136:e378::1", "2001:10::1", "2001:20::1",
    "3fff::1", "64:ff9b:1::1", "::127.0.0.1", "0:0:0:0:0:0:0:1"]) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
});

test("IPv6: IPv4 carried inside IPv6 is judged by the IPv4 address", () => {
  assert.equal(isPublicAddress("::ffff:127.0.0.1"), false);
  assert.equal(isPublicAddress("::ffff:7f00:1"), false);
  assert.equal(isPublicAddress("::ffff:169.254.169.254"), false);
  assert.equal(isPublicAddress("::ffff:10.1.2.3"), false);
  assert.equal(isPublicAddress("64:ff9b::10.0.0.1"), false, "NAT64 of a private address");
  assert.equal(isPublicAddress("64:ff9b::c0a8:101"), false, "NAT64 of 192.168.1.1");
  assert.equal(isPublicAddress("2002:c0a8:0101::1"), false, "6to4 of 192.168.1.1");
  assert.equal(isPublicAddress("2002:7f00:1::1"), false, "6to4 of 127.0.0.1");
  assert.equal(isPublicAddress("::ffff:93.184.216.34"), true);
  assert.equal(isPublicAddress("64:ff9b::8.8.8.8"), true);
  assert.equal(isPublicAddress("2002:5db8:d822::1"), true, "6to4 of a public address");
});

test("IPv6: global unicast passes", () => {
  for (const ip of ["2606:2800:220:1:248:1893:25c8:1946", "2001:4860:4860::8888", "2a00:1450:4001:80b::200e", "2620:fe::fe", "[2606:4700::1111]"]) {
    assert.equal(isPublicAddress(ip), true, ip);
  }
});

test("parsing: malformed or zoned addresses are never public", () => {
  for (const ip of ["", "localhost", "1.2.3", "1.2.3.4.5", "256.1.1.1", "01.2.3.4", "1::2::3", "fe80::1%eth0", "12345::", "::g", ":1", "1:2:3:4:5:6:7:8:9"]) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  assert.deepEqual(parseIPv6("::ffff:1.2.3.4"), [0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
  assert.deepEqual(parseIPv6("1:2:3:4:5:6:7:8"), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(parseIPv6("1::"), [1, 0, 0, 0, 0, 0, 0, 0]);
});

test("checkHost: every address must be public; failures and no resolver refuse", async () => {
  assert.deepEqual(await checkHost("a.test", async () => PUBLIC), { ok: true, addresses: PUBLIC });
  assert.equal((await checkHost("a.test", async () => ["93.184.216.34", "10.0.0.5"])).ok, false, "one private address among public ones");
  assert.equal((await checkHost("a.test", async () => ["2606:4700::1", "fd00::1"])).ok, false);
  assert.deepEqual(await checkHost("a.test", async () => []), { ok: false, reason: "dns_no_address" });
  assert.deepEqual(await checkHost("a.test", async () => { throw new Error("NXDOMAIN"); }), { ok: false, reason: "dns_failed" });
  assert.deepEqual(await checkHost("a.test", null), { ok: false, reason: "dns_unavailable" });
});

// A fake site: routes by path; records each request.
function fakeSite(routes, hits = []) {
  return async (url, init) => {
    hits.push(url);
    const u = new URL(url);
    const r = routes[u.pathname];
    if (typeof r === "function") return r(init);
    const [status, body, loc] = r ?? [404, ""];
    return new Response(status >= 300 && status < 400 ? null : body ?? "", { status, headers: loc ? { location: loc } : {} });
  };
}

test("inventory: a host that resolves to a private address is never fetched", async () => {
  const hits = [];
  const inv = await inventorySite({ site: SITE, fetch: fakeSite({ "/": [200, "<h1>x</h1>"] }, hits), resolve: async () => ["169.254.169.254"], now: () => "T" });
  assert.equal(hits.length, 0, "no request left the function");
  assert.equal(inv.pages.length, 1);
  assert.equal(inv.pages[0].status, null);
  assert.ok(inv.refusals.some((r) => r.reason === "non_public_address 169.254.169.254"));
});

test("inventory: no resolver fails closed", async () => {
  const hits = [];
  const inv = await inventorySite({ site: SITE, fetch: fakeSite({ "/": [200, "ok"] }, hits), resolve: null, now: () => "T" });
  assert.equal(hits.length, 0);
  assert.ok(inv.refusals.every((r) => r.reason === "dns_unavailable"));
});

test("inventory: every same-host redirect hop is resolved again; a hop to a private answer stops there", async () => {
  const hits = [];
  const lookups = [];
  let n = 0;
  // the sitemap (1), "/" (2) and the first hop of /old (3) resolve public; the next hop resolves private
  const resolve = async (h) => { lookups.push(h); n++; return n >= 5 ? ["10.0.0.7"] : PUBLIC; };
  const inv = await inventorySite({
    site: SITE, candidates: [`${SITE}/old`], concurrency: 1,
    fetch: fakeSite({ "/sitemap.xml": [404, ""], "/": [200, "<h1>Home</h1>"], "/old": [301, null, "/mid"], "/mid": [301, null, "https://example-roofing.com/new"], "/new": [200, "<h1>New</h1>"] }, hits),
    resolve, now: () => "T",
  });
  const old = inv.pages.find((p) => p.url === `${SITE}/old`);
  assert.equal(old.status, 301);
  assert.equal(old.final_status, null, "the private hop was not fetched");
  assert.ok(!hits.some((h) => h.endsWith("/new")));
  assert.deepEqual(lookups, ["www.example-roofing.com", "www.example-roofing.com", "www.example-roofing.com", "www.example-roofing.com", "example-roofing.com"]);
  assert.ok(inv.refusals.some((r) => r.url === "https://example-roofing.com/new" && r.reason === "non_public_address 10.0.0.7"));
});

test("inventory: a redirect to another host is recorded, never resolved or fetched", async () => {
  const lookups = [];
  const hits = [];
  const inv = await inventorySite({
    site: SITE, candidates: [`${SITE}/away`],
    fetch: fakeSite({ "/sitemap.xml": [404, ""], "/": [200, "ok"], "/away": [302, null, "https://evil.test/"] }, hits),
    resolve: async (h) => { lookups.push(h); return PUBLIC; }, now: () => "T",
  });
  assert.equal(inv.pages.find((p) => p.url === `${SITE}/away`).final_url, "https://evil.test/");
  assert.ok(!lookups.includes("evil.test"));
  assert.ok(!hits.some((h) => h.includes("evil.test")));
});

test("inventory: at most 4 requests at a time; the home page is always requested first", async () => {
  let inFlight = 0, peak = 0;
  const slow = () => async () => { inFlight++; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 5)); inFlight--; return new Response("<h1>p</h1>", { status: 200 }); };
  const routes = { "/sitemap.xml": [404, ""] };
  const candidates = [];
  for (let i = 0; i < 20; i++) { routes[`/p${i}`] = slow(); candidates.push(`${SITE}/p${i}`); }
  routes["/"] = slow();
  const inv = await inventorySite({ site: SITE, candidates, fetch: fakeSite(routes), resolve: async () => PUBLIC, now: () => "T" });
  assert.equal(INVENTORY_LIMITS.concurrency, 4);
  assert.equal(peak, 4);
  assert.equal(inv.pages.length, 21);
  assert.equal(inv.pages[0].url, `${SITE}/`);
});

test("inventory: the budget stops new requests and is reported", async () => {
  let t = 0;
  const routes = { "/sitemap.xml": [404, ""], "/": [200, "ok"] };
  const candidates = [];
  for (let i = 0; i < 10; i++) { routes[`/p${i}`] = () => { t += 50_000; return new Response("x", { status: 200 }); }; candidates.push(`${SITE}/p${i}`); }
  const inv = await inventorySite({ site: SITE, candidates, concurrency: 1, clock: () => t, fetch: fakeSite(routes), resolve: async () => PUBLIC, now: () => "T" });
  assert.equal(INVENTORY_LIMITS.budgetMs, 120_000);
  assert.equal(inv.budget_exceeded, true);
  assert.ok(inv.skipped > 0);
  assert.equal(inv.pages.length + inv.skipped, 11);
  assert.equal(inv.pages[0].status, 200, "the home page was fetched");
});

test("inventory: bodies are cut at the byte cap and page text at 4,000 characters", async () => {
  const big = `<body><p>${"word ".repeat(5000)}</p></body>`;
  const inv = await inventorySite({ site: SITE, maxBytes: 3000, fetch: fakeSite({ "/sitemap.xml": [404, ""], "/": [200, big] }), resolve: async () => PUBLIC, now: () => "T" });
  assert.ok(inv.pages[0].text.length <= 3000);
  const inv2 = await inventorySite({ site: SITE, fetch: fakeSite({ "/sitemap.xml": [404, ""], "/": [200, big] }), resolve: async () => PUBLIC, now: () => "T" });
  assert.equal(inv2.pages[0].text.length, INVENTORY_LIMITS.textChars);
});

test("inventory: host-name rules are unchanged (credentials, ports, IP literals, other hosts)", async () => {
  const { allowedUrl } = await import("../supabase/functions/authority/inventory.ts");
  for (const bad of ["https://user:pw@www.example-roofing.com/", "https://www.example-roofing.com:8443/", "http://127.0.0.1/", "http://[::1]/",
    "https://localhost/", "https://x.localhost/", "https://evil.test/", "ftp://www.example-roofing.com/", "http://0x7f.1/", "http://2130706433/"]) {
    assert.equal(allowedUrl(bad, SITE), false, bad);
  }
  assert.equal(allowedUrl("https://example-roofing.com/a", SITE), true);
});

test("systemResolver: Node's resolver is found and its answers are checked like any other", async () => {
  const { systemResolver } = await import("../supabase/functions/authority/netguard.ts");
  const r = await systemResolver();
  assert.ok(r, "a resolver exists under Node");
  const addrs = await r("localhost");
  assert.ok(addrs.length > 0);
  assert.deepEqual(await checkHost("localhost", r), { ok: false, reason: `non_public_address ${addrs.find((a) => !isPublicAddress(a))}` });
});
