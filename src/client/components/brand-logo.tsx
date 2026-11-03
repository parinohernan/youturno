import { cn } from "@/lib/utils";

export function BrandLogo({ className, decorative = false }: { className?: string; decorative?: boolean }) {
  return <img
    src="/brand/youturno-logo.jpg"
    width={1254}
    height={1254}
    alt={decorative ? "" : "YouTurno · Gestión de turnos"}
    className={cn("shrink-0 object-contain", className)}
  />;
}
