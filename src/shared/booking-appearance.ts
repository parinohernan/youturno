export interface BookingAppearance {
  background: string;
  text: string;
  button: string;
  welcome: string;
}

export const defaultAppearance: BookingAppearance = {
  background: "#ffffff", text: "#18181b", button: "#6d28d9", welcome: "",
};
export const isColor = (value: unknown): value is string => typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);

function luminance(color: string): number {
  const channels = [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}
export function contrast(a: string, b: string): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
export function buttonForeground(button: string): string {
  return contrast(button, "#ffffff") >= contrast(button, "#000000") ? "#ffffff" : "#000000";
}

/** Decoration never changes the validated solid surfaces beneath text or controls. */
export function appearanceDecoration(appearance: BookingAppearance) {
  const background = isColor(appearance.background) ? appearance.background : defaultAppearance.background;
  const text = isColor(appearance.text) ? appearance.text : defaultAppearance.text;
  const button = isColor(appearance.button) ? appearance.button : defaultAppearance.button;
  const alpha = (color: string, opacity: number) => `rgba(${[1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16)).join(", ")}, ${opacity})`;
  return {
    glow: alpha(button, 0.16),
    line: alpha(button, 0.28),
    border: alpha(text, 0.28),
    shadow: alpha(text, contrast(background, "#000000") > contrast(background, "#ffffff") ? 0.08 : 0.16),
  };
}
export function appearanceError(value: BookingAppearance): string | null {
  if (![value.background, value.text, value.button].every(isColor)) return "Use colores en formato #RRGGBB.";
  if (typeof value.welcome !== "string" || value.welcome.length > 500) return "El mensaje admite hasta 500 caracteres.";
  if (contrast(value.background, value.text) < 4.5) return "El texto necesita un contraste mínimo de 4,5:1 con el fondo.";
  if (contrast(value.background, value.button) < 3) return "El botón necesita un contraste mínimo de 3:1 con el fondo.";
  return null;
}

/** Missing legacy rows and invalid stored values use a complete, readable fallback. */
export function readAppearance(raw: string | null | undefined): BookingAppearance {
  try {
    const value = JSON.parse(raw || "null");
    if (!value || appearanceError(value)) return { ...defaultAppearance };
    return { background: value.background, text: value.text, button: value.button, welcome: value.welcome };
  } catch { return { ...defaultAppearance }; }
}
