import type { ComponentChildren } from "preact";
import { buttonForeground, defaultAppearance, isColor, type BookingAppearance } from "../../shared/booking-appearance";

/** The same scoped palette paints the real page and its noninteractive draft preview. */
export function BookingPageFrame({ appearance, preview = false, children }: {
  appearance?: BookingAppearance; preview?: boolean; children: ComponentChildren;
}) {
  const theme = { ...defaultAppearance, ...appearance };
  for (const key of ["background", "text", "button"] as const) {
    if (!isColor(theme[key])) theme[key] = defaultAppearance[key];
  }
  return <div className="booking-appearance min-w-0 w-full bg-background text-foreground" data-booking-preview={preview || undefined}
    inert={preview || undefined} style={{
      containerType: "inline-size", containerName: "booking",
      minHeight: preview ? undefined : "100dvh",
      "--background": theme.background, "--foreground": theme.text,
      "--card": theme.background, "--card-foreground": theme.text,
      "--muted": theme.background, "--muted-foreground": theme.text,
      "--secondary": theme.background, "--secondary-foreground": theme.text,
      "--accent": theme.background, "--accent-foreground": theme.text,
      "--primary": theme.button, "--primary-foreground": buttonForeground(theme.button),
      "--ring": theme.text, "--border": `color-mix(in srgb, ${theme.text} 35%, ${theme.background})`,
      "--input": theme.text,
    }}>{children}</div>;
}
