import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * A verification build and the dev server both default to `.next`. Running `next build` while
   * `next dev` is live overwrites the chunks the dev server is serving, and the browser then gets
   * a stale mix until the cache is cleared — which looks exactly like "my change didn't apply".
   * Setting `NEXT_DIST_DIR=.next-build` for a build keeps the two out of each other's way.
   */
  distDir: process.env.NEXT_DIST_DIR || ".next",

  /**
   * The dev server prints every Server Function call with its arguments — and those arguments
   * include what people type into secret fields: AI provider keys, email-provider and e-invoice
   * credentials, passwords. Found when a copilot key appeared in plain text in the dev log. Off, so
   * no secret lands in a terminal, a log file or a screen share.
   */
  logging: {
    serverFunctions: false,
  },

  /**
   * Each workspace is its own subdomain — locally `acme.localhost:3000`. Next 16 refuses dev assets
   * and hot reload to any origin not listed here, which would leave every workspace but the bare
   * `localhost` a page that never finishes loading in development.
   */
  allowedDevOrigins: ["*.localhost", "127.0.0.1"],

  /**
   * The control plane's and the reference database's Prisma clients (prisma/control,
   * prisma/reference), loaded by Node as they are rather than bundled — the same treatment Next gives
   * Prisma's main client. Bundled, a client's search for its own query engine on disk makes the
   * build trace the entire project.
   */
  serverExternalPackages: ["@wroffy/control-client", "@wroffy/reference-client", "@prisma/adapter-pg"],

  /**
   * Server actions accept bodies up to 6 MB: the website CMS uploads images of up to 5 MB through one
   * (src/actions/cms/media.ts), and Next's default of 1 MB would refuse them before the action's own
   * checks run. Every action still validates its own input.
   */
  experimental: {
    serverActions: { bodySizeLimit: "6mb" },
  },

  /**
   * eSSL / ZKTeco terminals post to a fixed path.
   *
   * Their firmware lets you set the server address and port on the keypad, but the path is baked
   * in as /iclock/ — so the app has to answer there rather than somewhere tidier. The handler
   * itself lives under /api/biometric/iclock, and this points the one at the other.
   */
  async rewrites() {
    return [{ source: "/iclock/:path*", destination: "/api/biometric/iclock/:path*" }];
  },
};

export default nextConfig;
