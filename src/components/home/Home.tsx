"use client";

import React from "react";
import HeroSection from "./HeroSection";
import LivePreviewMockup from "./LivePreviewMockup";
import HowItWorks from "./HowItWorks";
import FeatureGrid from "./FeatureGrid";

export default function Home() {
  return (
    <div className="w-full bg-background text-foreground overflow-hidden font-sans">
      <HeroSection />
      <LivePreviewMockup />
      <HowItWorks />
      <FeatureGrid />
    </div>
  );
}
