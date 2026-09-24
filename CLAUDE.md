# SiGPo — Notas de proyecto

## Reglas de trabajo (pedidas por Anneris)
- **No rellenar los huecos con suposiciones, confirmar siempre.**
- **CORROBORAR SIEMPRE en la base/código antes de afirmar algo. Nada de trabajar a ciegas ni de memoria.** Antes de responder o dar por hecho un dato (login, montos, estados, estructura), verificarlo con una consulta o leyendo el código. No dar explicaciones "de memoria" sobre cómo funciona el sistema: chequear primero.
- Nunca usar Python/sed para reconstruir archivos — solo el tool Edit con bloques exactos ya leídos.
- Siempre leer antes de editar. Después de cada Edit, verificar con grep/Read.
- Un cambio por commit.

## Login del estudiante (CORROBORADO en portal_login.html) — NO confundir
- **El estudiante entra escribiendo su DNI como usuario y su contraseña** (contraseña inicial = el DNI). El campo del login es el **DNI**, NO el email.
- Por dentro: el DNI se pasa al RPC `get_login_info(p_dni)` → devuelve `{email, activo}`; con ese email + la contraseña se hace `sb.auth.signInWithPassword({email, password})`.
- Por eso en `auth.users.email` va el **email real** del estudiante (identificador interno de la cuenta + destino de los mails de "recuperar contraseña"); el alumno **nunca escribe el email**. La cadena que importa que funcione es **DNI → email** (que `get_login_info(DNI)` devuelva el mismo email guardado en `auth.users`/`usuarios`/`estudiantes`).

## Infraestructura (NO volver a preguntar)
- **GitHub Pages publica desde la rama `desarrollo-38`.** Es la rama de producción en vivo. NO es `main`. Pushear a `desarrollo-38` pone los cambios en vivo. (Antes producción era `desarrollo-36`; se movió a `desarrollo-38`.)
- Historial de ramas: `desarrollo-38` salió de `desarrollo-37`, que salió de `desarrollo-36`.
- **Migración a GitHub institucional:** el proyecto se va a copiar al repo `POSGRADOFCEUNCUYO/pagos-cobranzas` (cuenta institucional). Esa migración la hace Anneris manualmente (import de GitHub); no requiere acción del asistente.

## Supabase — capacidad y plan (recordatorio)
- **Proyecto Supabase:** `fdevypdowdhqaxvfiywt`. Plan **free**.
- **Uso real al 2026-08-31** (muy holgado): base **20 MB / 500 MB**, usuarios auth **308 / 50.000**, archivos (comprobantes) **38 MB / 1 GB** (180 archivos). Cobros ~4.585 filas.
- **Capacidad: el free alcanza por años.** El único tope que algún día podría rozar es el de **archivos/Storage** (comprobantes). **Umbral a vigilar: Storage > ~800 MB** → ahí recién empezar a archivar/borrar viejos o subir de plan.
- **Evaluar plan Pro (~USD 25/mes) NO por espacio, sino por:** backups automáticos diarios + point-in-time recovery (lo más valioso para datos de pagos), que no se pause por inactividad, y soporte por mail. Es un **upgrade** (un botón), no una migración.
- **Servidores propios de la facultad (idea a futuro):** Supabase es open source y autohospedable (Docker). Dos caminos: (A) mudar el stack completo (Postgres + PostgREST + Auth + Storage) a un servidor de la facultad con **endpoint público HTTPS** (los alumnos entran desde su casa; red interna sola no sirve); (B) híbrido: Supabase sigue en vivo y se replica una **copia de respaldo** de la base a un servidor de la facultad. Ojo: mover solo Postgres NO alcanza (la web usa toda la API/Auth de Supabase). Antes de decidir, preguntar a IT: (1) ¿pueden exponer HTTPS público?, (2) ¿corren Docker?, (3) ¿quién mantiene el stack y los backups?

## Supabase — cambio Data API 30-oct-2026 (GRANTs en tablas nuevas)
- **Desde el 30/10/2026**, Supabase deja de dar acceso automático de la Data API (supabase-js/PostgREST/GraphQL) a **tablas nuevas** del esquema `public`.
- **Las tablas actuales NO cambian:** conservan permisos y siguen accesibles. La web del Portal sigue funcionando sin tocar nada. Este proyecto casi siempre hace **cambios de datos** (UPDATE/INSERT de filas), no crea tablas → en el día a día no afecta.
- **Solo importa cuando se CREA una tabla nueva** en `public` (migración, SQL manual, rama preview o `supabase db reset`). Si falta el GRANT, la API responde *permission denied* con el GRANT exacto a correr.
- **Regla:** en la MISMA migración que crea la tabla, agregar:
  ```sql
  GRANT SELECT ON public.mi_tabla TO anon;
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.mi_tabla TO authenticated;
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.mi_tabla TO service_role;
  ```
  (ajustar según qué debería ver `anon` — para tablas sensibles, no darle SELECT a `anon`).

## Alta de un estudiante nuevo (proceso probado — NO reinventar)
Contexto clave: al insertar en `inscripciones` hay un **trigger** (`trg_cobros_nuevo_inscripto` → `generar_cobros_nuevo_inscripto()`) que **crea automáticamente las cuotas en esqueleto** (estado `A_DEFINIR`, montos 0) copiando el plan de la cohorte (conceptos/períodos/vencimientos de los otros estudiantes). Por eso **NO hay que insertar cobros a mano** (choca con el UNIQUE `cobros_uq_dni_cohorte_concepto_periodo`): se **UPDATE-an** las cuotas que el trigger ya creó.

IDs autoincrementales (identity, omitir al insertar): `estudiantes.id`, `inscripciones.id`, `usuarios.usuario_id`, `cobros.cobro_id`.

**Pasos (todo en un DO $$ block / transacción):**
1. **auth.users** (login): `id gen_random_uuid()`, `instance_id '00000000-0000-0000-0000-000000000000'`, `aud`/`role` `'authenticated'`, `email`, `encrypted_password extensions.crypt('<DNI>', extensions.gen_salt('bf'))`, `email_confirmed_at now()`, `raw_app_meta_data '{"provider":"email","providers":["email"]}'`, `raw_user_meta_data '{"email_verified":true}'`, tokens vacíos (`confirmation_token, recovery_token, email_change_token_new, email_change = ''`), `is_sso_user/is_anonymous false`. Contraseña inicial = **el DNI**.
2. **estudiantes**: `auth_user_id, dni, apellido, nombre, email, programa_id, cohorte_id, descuento_porcentaje` → `RETURNING id`.
3. **usuarios**: `auth_user_id, dni, nombre_completo, apellido, nombre, email, rol 'ESTUDIANTE', programa_id, debe_cambiar_password true`.
4. **inscripciones**: `estudiante_id, cohorte_id, descuento_porcentaje` → **el trigger genera las cuotas esqueleto** (A_DEFINIR, 0).
5. **UPDATE cobros** por concepto para poner los montos reales (el trigger NO aplica montos ni descuento):
   - Inscripción abonada: `monto_original`, `monto_final`, `descuento_porcentaje`, `estado='ABONADA'`, `monto_abonado`, `saldo_pendiente=0`, `fecha_pago` + fila en **`pagos`** (`cobro_id, numero_pago, fecha_pago, monto`).
   - Cuotas: `monto_original` (base), `descuento_porcentaje`, `monto_final = base*(1-desc/100)`, `saldo_pendiente = monto_final`, `estado='NO_ABONADA'`. `exenta_mora=true` en las que corresponda.

Notas: FK `cobros_dni_fkey` → `estudiantes(dni)` (crear estudiante ANTES que los cobros; con el trigger esto ya queda ordenado). `cobros.tipo`/`estado` no aplica acá (eso es de egresos). Enums cobros: `estado_cobro`. Siempre verificar primero si el estudiante ya existe (estudiantes + usuarios + cobros por DNI) y confirmar nombre↔DNI (han venido con DNI equivocado).

## Recibos / Tango Gestión (NO confundir)
- **El recibo/comprobante fiscal lo emite Tango Gestión** (sistema contable externo). **NO tengo acceso a Tango** — solo a Supabase (base del Portal) y al repo.
- Lo que en el Portal llamamos `pago` (tabla `pagos`) es un **registro INTERNO de trazabilidad** (cuánto/cuándo se pagó, para que la cuota cierre), **NO** el recibo que se le entrega al estudiante. Marcar una cuota `ABONADA` no requiere sí o sí una fila en `pagos`.
- Al registrar un pago interno **nunca inventar la fecha**: pedirla. Si alcanza con el estado ABONADA, se deja sin fila en `pagos`.
- **Circuito real del recibo:** Tango emite el recibo → se envía por mail → la automatización **Google Apps Script `sigpo_gas_recibos.gs`** lee el mail y matchea el recibo con su cobro por la leyenda **"Cobro `<id>` `<período>` `<DNI>`"**, sube el recibo al Portal (`recibo_url`/comprobante) y **registra el pago solo**. → **NO cargar pagos/recibos a mano**: los carga el GAS. A lo sumo marcar el estado de la cuota.
