import { useState } from "preact/hooks";
import { UserRound } from "lucide-preact";

/** Adjacent professional names label the identity; the portrait is decorative. */
export function ProfessionalAvatar({ src, size = 44, eager = false }: { src?: string | null; size?: number; eager?: boolean }) {
  const [failed, setFailed] = useState<string | null>(null);
  return <span aria-hidden="true" className="professional-avatar" style={{ width: size, height: size }}>
    {src && failed !== src
      ? <img src={src} alt="" width={size} height={size} loading={eager ? "eager" : "lazy"} decoding="async" onError={() => setFailed(src)} />
      : <UserRound width={Math.round(size * .56)} height={Math.round(size * .56)} strokeWidth={1.5} />}
  </span>;
}
