import { useState, type CSSProperties } from "react";

import { themes } from "./landing/content.js";
import {
  ComparisonSection,
  FooterSection,
  HeroSection,
  LocalFirstSection,
  ProductPillarsSection,
  StatsSection,
  SystemArchitectureSection,
} from "./landing/sections.js";

type LandingProps = {
  appUrl: string;
};

export function Landing({ appUrl }: LandingProps) {
  const [themeIndex, setThemeIndex] = useState(0);
  const theme = themes[themeIndex] ?? themes[0]!;
  const primaryButtonStyle: CSSProperties = {
    backgroundColor: theme.primary,
    color: theme.primaryText,
  };
  const outlineButtonStyle: CSSProperties = {
    backgroundColor: theme.surface,
    borderColor: theme.border,
    color: theme.text,
  };
  const elevatedSurfaceStyle: CSSProperties = {
    backgroundColor: `${theme.surface}e6`,
    borderColor: theme.border,
    boxShadow:
      "0 22px 70px rgba(120, 53, 15, 0.10), 0 1px 0 rgba(255, 255, 255, 0.70) inset",
  };

  return (
    <main
      className="min-h-full"
      style={{ backgroundColor: theme.page, color: theme.text }}
    >
      <HeroSection
        appUrl={appUrl}
        theme={theme}
        primaryButtonStyle={primaryButtonStyle}
        outlineButtonStyle={outlineButtonStyle}
        elevatedSurfaceStyle={elevatedSurfaceStyle}
      />
      <StatsSection theme={theme} />
      <ProductPillarsSection theme={theme} />
      <SystemArchitectureSection theme={theme} />
      <LocalFirstSection theme={theme} />
      <ComparisonSection theme={theme} />
      <FooterSection
        appUrl={appUrl}
        theme={theme}
        themeIndex={themeIndex}
        onSelectTheme={setThemeIndex}
        primaryButtonStyle={primaryButtonStyle}
        outlineButtonStyle={outlineButtonStyle}
      />
    </main>
  );
}
