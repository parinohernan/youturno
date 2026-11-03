import { useEffect } from "preact/hooks";

export function LegalLinks() {
  return <nav aria-label="Información legal" className="flex flex-wrap gap-x-4 gap-y-2 text-sm text-muted-foreground">
    <a className="underline underline-offset-4" href="/privacidad">Privacidad</a>
    <a className="underline underline-offset-4" href="/terminos">Términos de uso</a>
  </nav>;
}

function Contact() {
  return <a className="break-all underline underline-offset-4" href="mailto:san.cayetano.314@gmail.com">san.cayetano.314@gmail.com</a>;
}

export type LegalPageKind = "privacy" | "terms";

export function legalPageForPath(path: string): LegalPageKind | null {
  if (/^\/privacidad\/?$/.test(path)) return "privacy";
  if (/^\/terminos\/?$/.test(path)) return "terms";
  return null;
}

export function LegalPage({ kind }: { kind: LegalPageKind }) {
  const title = kind === "privacy" ? "Política de privacidad" : "Términos de uso";
  useEffect(() => { document.title = `${title} | YouTurno`; }, [title]);
  return <main lang="es" className="mx-auto max-w-2xl space-y-6 bg-background p-4 text-foreground sm:p-8">
    <header className="space-y-3">
      <p className="font-semibold">YouTurno · Janus314</p>
      <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
      <p className="text-sm text-muted-foreground">Versión del <time dateTime="2026-11-01">1 de noviembre de 2026</time>.</p>
      <LegalLinks />
    </header>
    {kind === "privacy" ? <PrivacyContent /> : <TermsContent />}
    <footer className="space-y-3 border-t pt-4 text-sm">
      <p>Soporte y privacidad: <Contact />.</p>
      <LegalLinks />
      <p>Para reservar, vuelva al enlace de agenda de la empresa elegida.</p>
    </footer>
  </main>;
}

function PrivacyContent() {
  return <article className="space-y-6 text-sm leading-relaxed">
    <section className="space-y-2">
      <h2 className="text-lg font-semibold">Quién opera la plataforma</h2>
      <p>YouTurno es una plataforma de gestión de turnos operada bajo el nombre comercial Janus314. Las empresas que la utilizan administran sus propios clientes, servicios y turnos. Janus314 opera la plataforma; cada empresa determina el uso de los datos para organizar y prestar sus servicios.</p>
      <p>Este texto describe el funcionamiento actual. La identificación legal completa del operador y la validación jurídica de estos documentos están pendientes; el nombre comercial no sustituye los datos de identificación que puedan resultar exigibles.</p>
    </section>
    <section className="space-y-2">
      <h2 className="text-lg font-semibold">Datos utilizados y finalidad</h2>
      <ul className="list-disc space-y-2 pl-5">
        <li>Al iniciar sesión con Google, se guardan el proveedor, el identificador de la cuenta, el nombre cuando está disponible y el correo electrónico verificado. Se utilizan para identificar la cuenta y asociar sus reservas. Este inicio de sesión no solicita acceso a la bandeja de Gmail.</li>
        <li>Al confirmar una reserva pública, se utilizan el nombre y el correo de la cuenta para crear o asociar una ficha de cliente en la empresa elegida. Se registran el servicio, el profesional asignado, la fecha, el horario, el estado, el precio y el código del turno.</li>
        <li>La empresa también puede cargar o actualizar nombre, correo, teléfono y notas del cliente, además de instrucciones e historial del turno. Estos campos no se solicitan todos en la reserva pública. Evite incluir información sensible innecesaria en las notas.</li>
        <li>Para las cuentas de gestión se guardan el correo, una contraseña protegida mediante hash, el rol y la vinculación con la empresa. También se mantienen registros de administración de cuentas y controles de intentos de acceso.</li>
      </ul>
    </section>
    <section className="space-y-2">
      <h2 className="text-lg font-semibold">Acceso y servicios externos</h2>
      <p>La empresa seleccionada accede a los datos de cliente y turno necesarios para gestionar la reserva y prestar el servicio. Los controles de acceso de la aplicación separan los registros de cada empresa: una cuenta de otra empresa no tiene acceso a su ficha ni a sus turnos.</p>
      <p>La operación y el soporte de la plataforma pueden requerir acceso técnico autorizado a los datos. La separación entre empresas no significa que la infraestructura sea inaccesible para quienes la administran.</p>
      <p>Google interviene en la autenticación y aplica sus propias políticas. Los proveedores de alojamiento y base de datos intervienen en el funcionamiento técnico del servicio. Para conocer el uso que una empresa hace de sus fichas de clientes, consulte también con esa empresa.</p>
    </section>
    <section className="space-y-2">
      <h2 className="text-lg font-semibold">Cookies y almacenamiento del navegador</h2>
      <p>La aplicación utiliza cookies necesarias para mantener la sesión de clientes y de usuarios de gestión, y una cookie temporal para verificar el regreso desde Google. Las cookies de autenticación se configuran con Secure, HttpOnly y restricciones SameSite. Bloquearlas puede impedir el inicio de sesión o la confirmación de una reserva.</p>
      <p>La selección de servicio, profesional, fecha y horario se conserva temporalmente en sessionStorage para recuperarla después del inicio de sesión. La aplicación no incorpora actualmente cookies opcionales de publicidad o analítica; Google y los proveedores técnicos tienen sus propias prácticas.</p>
    </section>
    <section className="space-y-2">
      <h2 className="text-lg font-semibold">Conservación y seguridad</h2>
      <p>Los registros se conservan para la operación de las cuentas y la gestión e historial de los turnos. No hay un plazo fijo de eliminación automática ni una herramienta de autoservicio para borrar la cuenta de Google vinculada o todos sus datos. Las solicitudes se revisan manualmente según los registros afectados y las necesidades de conservación aplicables.</p>
      <p>Se utilizan sesiones firmadas, controles de acceso por empresa y protecciones de autenticación. Estas medidas reducen riesgos, pero no garantizan una seguridad absoluta.</p>
    </section>
    <section className="space-y-2">
      <h2 className="text-lg font-semibold">Consultas y solicitudes sobre sus datos</h2>
      <p>Para consultar por sus datos, solicitar acceso, corrección o eliminación, o plantear otra cuestión de privacidad, escriba a <Contact />. Indique el correo de su cuenta, la empresa relacionada y una descripción breve de la solicitud. No envíe contraseñas ni información sensible innecesaria.</p>
      <p>Puede ser necesario verificar su identidad con información mínima adicional y coordinar con la empresa que administra la ficha. La revisión es manual; no se garantiza una resolución inmediata ni un plazo específico. Para cambios operativos de un turno, contacte directamente a la empresa.</p>
    </section>
  </article>;
}

function TermsContent() {
  return <article className="space-y-6 text-sm leading-relaxed">
    <section className="space-y-2">
      <h2 className="text-lg font-semibold">Alcance del servicio</h2>
      <p>YouTurno, operado bajo el nombre comercial Janus314, permite a las empresas gestionar sus agendas y a sus clientes reservar turnos mediante un enlace público. La empresa elegida ofrece y presta el servicio reservado; Janus314 proporciona la herramienta de agenda.</p>
      <p>Estos términos describen el uso actual de la plataforma. La identificación legal completa del operador y la validación jurídica de estos documentos están pendientes; el nombre comercial no sustituye los datos de identificación que puedan resultar exigibles.</p>
    </section>
    <section className="space-y-2">
      <h2 className="text-lg font-semibold">Reserva y confirmación</h2>
      <p>Puede consultar servicios y horarios sin iniciar sesión. Para confirmar una reserva pública, debe identificarse con Google, revisar la selección y pulsar «Confirmar turno». El inicio de sesión por sí solo no reserva un horario.</p>
      <p>La disponibilidad puede cambiar antes de la confirmación final. Si el horario deja de estar disponible, deberá elegir otro. Cuando la operación se completa, la pantalla muestra el turno confirmado y su código; conserve ese código para consultar con la empresa.</p>
      <p>Los servicios, profesionales, precios y horarios mostrados son administrados por la empresa. Consulte con ella cualquier duda sobre la prestación o las condiciones del servicio.</p>
    </section>
    <section className="space-y-2">
      <h2 className="text-lg font-semibold">Cancelaciones y reprogramaciones</h2>
      <p>Solicite las cancelaciones o los cambios directamente a la empresa y consulte sus políticas aplicables. El personal de la empresa puede cancelar o reprogramar turnos desde la gestión de la agenda.</p>
      <p>La plataforma no ofrece actualmente un flujo completo de solicitudes de cambio del cliente ni garantiza notificaciones automáticas de cancelación o reprogramación. Verifique los cambios con la empresa; no suponga que una solicitud enviada por otro medio ya modificó el turno.</p>
    </section>
    <section className="space-y-2">
      <h2 className="text-lg font-semibold">Uso responsable</h2>
      <p>Utilice datos correctos y una cuenta propia o que esté autorizado a utilizar. No suplante identidades, intente acceder a información de terceros ni realice reservas abusivas o acciones destinadas a bloquear la disponibilidad o interferir con el servicio. Proteja el acceso a su cuenta y no comparta sus credenciales.</p>
    </section>
    <section className="space-y-2">
      <h2 className="text-lg font-semibold">Operación y responsabilidades</h2>
      <p>La empresa administra su agenda, sus políticas de cambios y la prestación del servicio. La plataforma facilita el registro y la gestión de los turnos, pero no reemplaza la comunicación con la empresa. Pueden producirse interrupciones o errores técnicos; ante dudas sobre una confirmación, contacte a la empresa antes de repetir la reserva.</p>
      <p>Estos términos no pretenden excluir derechos que correspondan conforme a la normativa aplicable. El tratamiento de datos se describe en la <a className="underline underline-offset-4" href="/privacidad">Política de privacidad</a>.</p>
    </section>
    <section className="space-y-2">
      <h2 className="text-lg font-semibold">Contacto y versiones</h2>
      <p>Para soporte de la plataforma, escriba a <Contact />. Las consultas sobre el servicio reservado y sus cambios deben dirigirse a la empresa. Esta página indica la fecha de su versión para facilitar la consulta de las condiciones publicadas.</p>
    </section>
  </article>;
}
