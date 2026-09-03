'use client';

/**
 * Small typed wrapper over Web Storage for the protection flow.
 *
 * The flow used to live entirely in React state, so a refresh at any step
 * dropped the user back to the beginning — worst on /protect/purchased, where
 * the only copy of a real transaction hash disappeared with it.
 *
 * Two lifetimes, deliberately different:
 *   session — the in-progress goal and selection. Scoped to the tab, so a
 *     second tab can run an independent search without stomping the first.
 *   local   — receipts and the deployed Safe address. These outlive the tab
 *     because they refer to something that exists on-chain and costs real
 *     money to recreate; losing them is losing the user's only pointer to it.
 */
const PREFIX = 'payung.v1.';

function read<T>(store: Storage | undefined, key: string): T | null {
  if (!store) return null;
  try {
    const raw = store.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    // Private-mode quota errors, or a value written by an older schema.
    return null;
  }
}

function write(store: Storage | undefined, key: string, value: unknown): void {
  if (!store) return;
  try {
    if (value === null || value === undefined) store.removeItem(PREFIX + key);
    else store.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Storage being unavailable must never break the flow it is only assisting.
  }
}

const session = () => (typeof window === 'undefined' ? undefined : window.sessionStorage);
const local = () => (typeof window === 'undefined' ? undefined : window.localStorage);

export const sessionGet = <T,>(key: string) => read<T>(session(), key);
export const sessionSet = (key: string, value: unknown) => write(session(), key, value);
export const localGet = <T,>(key: string) => read<T>(local(), key);
export const localSet = (key: string, value: unknown) => write(local(), key, value);

export const KEYS = {
  goal: 'goal',
  messages: 'messages',
  selectedQuote: 'selectedQuote',
  /** Receipt of a completed purchase — localStorage; see the lifetime note above. */
  purchase: 'purchase',
  /** Address of the Safe deployed for Precise Protection — localStorage, for the same reason. */
  safeAddress: 'safeAddress',
} as const;
