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
