import type { Config } from "tailwindcss";

// STASIS PROTOCOL - cybernetic war-room design tokens.
const config: Config = {
  darkMode: "class",
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        obsidian: {
          DEFAULT: "#07090E",
          900: "#07090E",
          800: "#0B0F17",
        },
        panel: {
          DEFAULT: "#0F141F",
          soft: "rgba(15, 20, 31, 0.7)",
        },
        // Signal colors
        mint: "#00FFA3",
        emerald: "#10B981",
        amber: "#F59E0B",
        crimson: "#FF2E54",
        cyan: "#00E5FF",
      },
      fontFamily: {
        sans: ["var(--font-geist-sans)", "Inter", "system-ui", "sans-serif"],
        mono: [
          "var(--font-geist-mono)",
          "JetBrains Mono",
          "ui-monospace",
          "monospace",
        ],
      },
      boxShadow: {
        "glow-mint": "0 0 0 1px rgba(0,255,163,0.25), 0 0 24px -4px rgba(0,255,163,0.45)",
        "glow-amber": "0 0 0 1px rgba(245,158,11,0.25), 0 0 24px -4px rgba(245,158,11,0.45)",
        "glow-crimson": "0 0 0 1px rgba(255,46,84,0.30), 0 0 30px -2px rgba(255,46,84,0.55)",
        "glow-cyan": "0 0 0 1px rgba(0,229,255,0.25), 0 0 24px -4px rgba(0,229,255,0.45)",
      },
      keyframes: {
        "pulse-ring": {
          "0%,100%": { opacity: "1", transform: "scale(1)" },
          "50%": { opacity: "0.35", transform: "scale(1.35)" },
        },
        scanline: {
          "0%": { transform: "translateY(-100%)" },
          "100%": { transform: "translateY(100%)" },
        },
        sweepx: {
          "0%": { transform: "translateX(-120%)" },
          "100%": { transform: "translateX(320%)" },
        },
      },
      animation: {
        "pulse-ring": "pulse-ring 1.8s ease-in-out infinite",
        scanline: "scanline 6s linear infinite",
        sweepx: "sweepx 1.2s linear infinite",
      },
    },
  },
  plugins: [],
};

export default config;
