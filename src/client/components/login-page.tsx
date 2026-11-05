import type { JSX } from "preact";
import { BrandLogo } from "./brand-logo";
import { LegalLinks } from "./legal-pages";

type LoginPageProps = {
  error: string;
  professional?: boolean;
  onSubmit: JSX.GenericEventHandler<HTMLFormElement>;
};

/** Platform sign-in stays independent of public company appearance settings. */
export function LoginPage({ error, onSubmit, professional = false }: LoginPageProps) {
  return <main className="platform-login">
    <div className="platform-login__decoration" aria-hidden="true">
      <div className="platform-login__orbit" />
      <div className="platform-login__orbit platform-login__orbit--inner" />
    </div>
    <div className="platform-login__content">
      <section className="platform-login__card" aria-labelledby="login-title">
        <BrandLogo className="platform-login__logo" decorative />
        <header className="platform-login__heading">
          <p className="platform-login__eyebrow">Tu espacio de trabajo</p>
          <h1 id="login-title">{professional ? "Portal del profesional" : "Ingresar a Youturno"}</h1>
          <p>{professional ? "Ingrese con el correo de su ficha y la contraseña establecida por la administración de su empresa." : "Te damos la bienvenida. Ingresa a tu cuenta para continuar."}</p>
        </header>
        <form className="platform-login__form" onSubmit={onSubmit}>
          <label>Correo electrónico
            <input name="email" type="email" autoComplete="username" required />
          </label>
          <label>Contraseña
            <input name="password" type="password" autoComplete="current-password" required />
          </label>
          <button type="submit">Ingresar<span aria-hidden="true">→</span></button>
        </form>
        {error && <p className="platform-login__error" role="alert">{error}</p>}
        {professional && <a href="/" className="text-sm underline">Ingreso de administración</a>}
      </section>
      <footer className="platform-login__footer"><LegalLinks /></footer>
    </div>
  </main>;
}
