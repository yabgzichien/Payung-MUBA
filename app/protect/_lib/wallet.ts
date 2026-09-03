import { BrowserProvider, type Eip1193Provider } from 'ethers';

export const BASE_CHAIN_ID = 8453;
const BASE_CHAIN_ID_HEX = '0x2105';

const BASE_CHAIN_PARAMS = {
  chainId: BASE_CHAIN_ID_HEX,
  chainName: 'Base',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: ['https://mainnet.base.org'],
  blockExplorerUrls: ['https://basescan.org'],
};

function getInjectedProvider(): Eip1193Provider | null {
  if (typeof window === 'undefined') return null;
  const eth = (window as unknown as { ethereum?: Eip1193Provider }).ethereum;
  return eth ?? null;
}

export function hasInjectedWallet(): boolean {
  return getInjectedProvider() !== null;
}

/** Requests account access and returns the connected address + current chain id. */
export async function connectInjectedWallet(): Promise<{ address: string; chainId: number }> {
  const injected = getInjectedProvider();
  if (!injected) {
    throw new Error('No wallet found. Install a browser wallet like MetaMask and try again.');
  }
  const provider = new BrowserProvider(injected);
  const accounts = await provider.send('eth_requestAccounts', []);
  if (!accounts?.[0]) throw new Error('No account was returned by your wallet.');
  const network = await provider.getNetwork();
  return { address: accounts[0], chainId: Number(network.chainId) };
}

/** Attempts to switch (or add) the injected wallet's active chain to Base mainnet. */
export async function switchToBase(): Promise<void> {
  const injected = getInjectedProvider();
  if (!injected) throw new Error('No wallet found.');
  try {
    await injected.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: BASE_CHAIN_ID_HEX }],
    });
  } catch (err: unknown) {
    const code = (err as { code?: number })?.code;
    if (code === 4902) {
      await injected.request({
        method: 'wallet_addEthereumChain',
        params: [BASE_CHAIN_PARAMS],
      });
    } else {
      throw err;
    }
  }
}

export function getSigner() {
  const injected = getInjectedProvider();
  if (!injected) throw new Error('No wallet found.');
  const provider = new BrowserProvider(injected);
  return provider.getSigner();
}

export function getReadProvider() {
  const injected = getInjectedProvider();
  if (!injected) throw new Error('No wallet found.');
  return new BrowserProvider(injected);
}

export type TxRequest = { to: string; data: string };

/** Human-readable message for common wallet errors (user rejection, revert, etc). */
export function describeWalletError(err: unknown): string {
  const e = err as { code?: number | string; shortMessage?: string; message?: string; reason?: string };
  if (e?.code === 4001 || e?.code === 'ACTION_REJECTED') return 'You rejected the request in your wallet.';
  return e?.shortMessage || e?.reason || e?.message || String(err);
}

export async function sendAndWait(signer: Awaited<ReturnType<typeof getSigner>>, tx: TxRequest) {
  const sent = await signer.sendTransaction({ to: tx.to, data: tx.data });
  const receipt = await sent.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error('Transaction reverted on-chain.');
  }
  return { hash: sent.hash, receipt };
}
