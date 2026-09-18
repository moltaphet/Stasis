// Defensive EIP-6963 provider discovery.
//
// Reviewer-mode hardening (Pillar 6): browser extensions like Phantom aggressively
// override window.ethereum and hijack MetaMask Snap RPC calls, producing spurious
// -32601 "method not found" errors. We therefore never touch window.ethereum
// directly. Instead we listen for EIP-6963 announce events and select strictly by
// rdns === "io.metamask". Any Snap-specific RPC is wrapped in try/catch so a
// hijacked provider degrades gracefully instead of throwing.

export interface Eip6963ProviderInfo {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
}

export interface Eip6963Provider {
  info: Eip6963ProviderInfo;
  provider: any;
}

const METAMASK_RDNS = "io.metamask";

export function discoverProviders(
  onUpdate: (providers: Eip6963Provider[]) => void,
): () => void {
  if (typeof window === "undefined") return () => {};

  const found = new Map<string, Eip6963Provider>();

  const handler = (event: Event) => {
    const detail = (event as CustomEvent).detail as Eip6963Provider | undefined;
    if (!detail || !detail.info || !detail.info.rdns) return;
    found.set(detail.info.rdns, detail);
    onUpdate(Array.from(found.values()));
  };

  window.addEventListener("eip6963:announceProvider", handler as EventListener);
  // Ask any injected providers to (re-)announce themselves.
  window.dispatchEvent(new Event("eip6963:requestProvider"));

  return () =>
    window.removeEventListener(
      "eip6963:announceProvider",
      handler as EventListener,
    );
}

export function pickMetaMask(
  providers: Eip6963Provider[],
): Eip6963Provider | null {
  // Strict rdns selection: never fall back to a Phantom-injected window.ethereum.
  return providers.find((p) => p.info.rdns === METAMASK_RDNS) || null;
}

export async function requestAccounts(
  provider: Eip6963Provider,
): Promise<string[]> {
  try {
    const accounts = await provider.provider.request({
      method: "eth_requestAccounts",
    });
    return Array.isArray(accounts) ? (accounts as string[]) : [];
  } catch (err) {
    // A hijacked provider (e.g. Phantom answering -32601) must not crash the app.
    console.warn("[stasis] eth_requestAccounts failed:", err);
    return [];
  }
}
