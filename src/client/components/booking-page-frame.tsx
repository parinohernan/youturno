import type { ComponentChildren } from "preact";
import { LegalLinks } from "./legal-pages";
import { appearanceDecoration, buttonForeground, defaultAppearance, isColor, type BookingAppearance } from "../../shared/booking-appearance";

/** The same scoped palette paints the public wizard and its fictional draft preview. */
export function BookingPageFrame({ appearance, preview = false, children }: {
  appearance?: BookingAppearance; preview?: boolean; children: ComponentChildren;
}) {
  const theme = { ...defaultAppearance, ...appearance };
  for (const key of ["background", "text", "button"] as const) {
    if (!isColor(theme[key])) theme[key] = defaultAppearance[key];
  }
  const decoration = appearanceDecoration(theme);
  return <div className="booking-appearance min-w-0 w-full bg-background text-foreground" data-booking-preview={preview || undefined}
    onClickCapture={preview ? (event) => { if ((event.target as Element).closest("a")) event.preventDefault(); } : undefined} style={{
      containerType: "inline-size", containerName: "booking",
      minHeight: preview ? undefined : "100dvh",
      "--background": theme.background, "--foreground": theme.text,
      "--card": theme.background, "--card-foreground": theme.text,
      "--muted": theme.background, "--muted-foreground": theme.text,
      "--secondary": theme.background, "--secondary-foreground": theme.text,
      "--accent": theme.background, "--accent-foreground": theme.text,
      "--primary": theme.button, "--primary-foreground": buttonForeground(theme.button),
      "--booking-glow": decoration.glow, "--booking-line": decoration.line,
      "--booking-shadow": decoration.shadow,
      "--ring": theme.text, "--border": decoration.border,
      "--input": theme.text,
    }}>{children}<footer className="booking-legal mx-auto max-w-2xl px-4 pb-6"><LegalLinks /></footer></div>;
}
