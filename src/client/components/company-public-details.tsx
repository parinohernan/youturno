import type { CompanyProfile } from "../types";
import { safeSocialUrl, socialNetworks } from "../../shared/social-links";

export function safeWebsite(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function CompanyPublicDetails({ company, preview = false, identityOnly = false, hideLogo = false }: { company: Partial<CompanyProfile>; preview?: boolean; identityOnly?: boolean; hideLogo?: boolean }) {
  const website = safeWebsite(company.website);
  return <div className={`company-public-details space-y-2 text-sm${identityOnly ? " company-identity-only" : ""}`}>
    {!hideLogo && company.logo_url && (/^\/api\/public\/[a-z0-9-]+\/logo\?v=[\w-]+$/.test(company.logo_url) ||
      (preview && /^\/api\/company\/logo\?v=[\w-]+$/.test(company.logo_url))) &&
      <img className="mx-auto block h-28 w-28 rounded object-contain object-center" src={company.logo_url} alt={`Logo de ${company.name}`} />}
    {!identityOnly && <>
    {company.description && <p className="whitespace-pre-line">{company.description}</p>}
    {company.address && <p className="whitespace-pre-line">Ubicación: {company.address}</p>}
    {company.phone && <p>Teléfono: {company.phone}</p>}
    {company.public_email && <p>Correo electrónico: {company.public_email}</p>}
    {website && <p><a className="underline" href={website} target="_blank" rel="noopener noreferrer">Sitio web de la empresa</a></p>}
    {socialNetworks.some(({ key }) => safeSocialUrl(company.social_links?.[key])) &&
      <nav aria-label="Redes sociales de la empresa" className="flex flex-wrap gap-3">
        {socialNetworks.map(({ key, label }) => {
          const href = safeSocialUrl(company.social_links?.[key]);
          return href ? <a key={key} className="underline" href={href} target="_blank" rel="noopener noreferrer"
            aria-label={`${label} de ${company.name || "la empresa"}`}>{label}</a> : null;
        })}
      </nav>}
    </>}
  </div>;
}
