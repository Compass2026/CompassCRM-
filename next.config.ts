import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/clients/**/agreements/**": ["./public/compass-agreement-logo.png"],
    "/agreements/**": ["./public/compass-agreement-logo.png"],
    "/sign/**": ["./public/compass-agreement-logo.png"],
  },
  async headers() {
    return [
      {
        source: "/sign/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Content-Security-Policy",
            value:
              "frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
          },
          { key: "Cache-Control", value: "private, no-store" },
        ],
      },
    ];
  },
};

export default nextConfig;
