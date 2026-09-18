import Header from "@/components/Header";
import Terminal from "@/components/Terminal";
import About from "@/components/About";
import Faq from "@/components/Faq";
import Footer from "@/components/Footer";
import ErrorBoundary from "@/components/ErrorBoundary";
import { WalletProvider } from "@/components/WalletProvider";

export default function Home() {
  return (
    <WalletProvider>
      {/* Top-level boundary: contains any crash so the tree never white-screens. */}
      <ErrorBoundary label="Dashboard error">
        <Header />
        <main>
          {/* Granular boundary around the RPC / wallet-driven simulator so a blip
              there falls back locally while the rest of the page keeps running. */}
          <ErrorBoundary label="Simulator panel unavailable">
            <Terminal />
          </ErrorBoundary>
          <About />
          <Faq />
        </main>
        <Footer />
      </ErrorBoundary>
    </WalletProvider>
  );
}
