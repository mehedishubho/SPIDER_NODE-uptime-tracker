// src/components/NotFound/NotFound.tsx
"use client";

import React from "react";
import { DotLottieReact } from "@lottiefiles/dotlottie-react";

interface NotFoundProps {
  pageName?: string;
}

// 08-05 light-safe brand asset: the 404 artwork mixes dark-slate strokes
// with white and light-gray highlights, so it needs a stable dark surface in
// BOTH modes — the illustration plate (bg-surface-deep) reproduces the
// dark-mode rendering exactly and lifts it into light mode as an intentional
// dark panel; the heading is token-driven (text-gray-900 was invisible in
// dark). Smaller-diff form chosen over a light-variant asset swap (recorded
// in the 08-05 summary).
const PageNotFound: React.FC<NotFoundProps> = ({ pageName = "This page" }) => {
  return (
    <div className="min-h-[80vh] flex flex-col items-center justify-center px-4">
      {/* Large Lottie Animation on its both-mode-safe illustration plate */}
      <div className="mb-8 rounded-3xl bg-surface-deep p-4 shadow-2xl">
        <DotLottieReact
          src="https://lottie.host/22b19dd0-bedc-48d5-8007-d00d51bef6ec/tBFRsuL10q.lottie"
          loop
          autoplay
          className="w-96 h-96"
        />
      </div>

      {/* Minimal Content */}
      <div className="text-center space-y-3">
        <h1 className="text-3xl font-bold text-foreground">
          The {pageName} Page Not Found
        </h1>
      </div>
    </div>
  );
};

export default PageNotFound;
