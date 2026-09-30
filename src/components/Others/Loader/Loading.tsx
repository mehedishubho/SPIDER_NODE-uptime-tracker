// src/components/Loading.tsx
"use client";

import React from "react";
import { DotLottieReact } from "@lottiefiles/dotlottie-react";

// 08-05 light-safe brand asset: the overlay is token-driven
// (bg-background/80) — light keeps today's near-white scrim over the
// light-designed artwork; dark now gets a dark scrim instead of the old
// hardcoded white flash. The asset's cream/orange elements carry the
// artwork on dark; see the 08-05 summary for the asset color inventory.
export default function Loading() {
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-background/80 z-50 transition-opacity duration-300 opacity-100 h-screen w-full">
      <div className="w-32 h-32">
        {" "}
        {/* You can adjust the size */}
        <DotLottieReact
          src="https://lottie.host/c719ce09-1bc3-4d1e-a80b-30daa65acb2e/taKJ2GubxU.lottie"
          loop
          autoplay
        />
      </div>
    </div>
  );
}
