import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  /**
   * Opt the Thetanuts SDK and ethers out of Next.js bundling so they run via
   * native Node.js require() on the server. Both use Node-only APIs (fs,
   * crypto, etc.) that can't be bundled for the edge runtime, and ethers
   * ships non-standard ESM that causes bundler trouble in some webpack
   * configurations. Keeping them external is the safe default for any SDK
   * that hasn't explicitly declared Next.js / edge compatibility.
   */
  serverExternalPackages: [
    '@thetanuts-finance/thetanuts-client',
    'ethers',
  ],
};

export default nextConfig;
