"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  discoverProviders,
  pickMetaMask,
  requestAccounts,
  type Eip6963Provider,
} from "@/lib/wallet";
import { createReviewerSession, type ReviewerSession } from "@/lib/genlayer";

export type ConnectionType = "metamask" | "reviewer" | null;

interface WalletContextValue {
  type: ConnectionType;
  address: string;
  session: ReviewerSession | null; // signing session (reviewer only)
  isConnected: boolean;
  metamaskAvailable: boolean;
  connectMetaMask: () => Promise<string>;
  connectReviewer: () => void;
  disconnect: () => void;
}

const WalletContext = createContext<WalletContextValue | null>(null);

// Remove any Stasis / reviewer / genlayer key material that may have been cached.
// The ephemeral reviewer key is held in memory only, but we clear both web storage
// backends defensively so disconnect leaves nothing behind.
function clearWalletStorage() {
  if (typeof window === "undefined") return;
  for (const store of [window.localStorage, window.sessionStorage]) {
    try {
      const doomed: string[] = [];
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (k && /stasis|reviewer|genlayer/i.test(k)) doomed.push(k);
      }
      doomed.forEach((k) => store.removeItem(k));
    } catch {
      /* storage unavailable (private mode / SSR) */
    }
  }
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [providers, setProviders] = useState<Eip6963Provider[]>([]);
  const [type, setType] = useState<ConnectionType>(null);
  const [address, setAddress] = useState("");
  const [session, setSession] = useState<ReviewerSession | null>(null);

  useEffect(() => discoverProviders(setProviders), []);
  const metamask = pickMetaMask(providers);

  const connectMetaMask = useCallback(async (): Promise<string> => {
    if (!metamask) return "";
    const accounts = await requestAccounts(metamask);
    if (accounts.length === 0) return "";
    setType("metamask");
    setAddress(accounts[0]);
    setSession(null); // MetaMask connection does not provide a signing session
    return accounts[0];
  }, [metamask]);

  const connectReviewer = useCallback(() => {
    // Self-safe: a genlayer-js account/client failure must not crash the tree.
    try {
      const s = createReviewerSession();
      setSession(s);
      setAddress(s.address || "");
      setType("reviewer");
    } catch (err) {
      console.error("[stasis] reviewer connect failed:", err);
    }
  }, []);

  const disconnect = useCallback(() => {
    setType(null);
    setAddress("");
    setSession(null);
    clearWalletStorage();
  }, []);

  const value = useMemo<WalletContextValue>(
    () => ({
      type,
      address,
      session,
      isConnected: type !== null,
      metamaskAvailable: Boolean(metamask),
      connectMetaMask,
      connectReviewer,
      disconnect,
    }),
    [type, address, session, metamask, connectMetaMask, connectReviewer, disconnect],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used within <WalletProvider>");
  return ctx;
}
