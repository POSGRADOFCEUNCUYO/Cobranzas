# Mapa de la nueva web — Portal de Cobranzas (SiGPo v2)

> Documento vivo de diseño. Se va actualizando a medida que definimos.
> **Última actualización:** 2026-10-19 (b)
> **Estado:** análisis / diseño (no implementado)

Leyenda: 🔵 **compartida/adaptable** (varios roles, cambia según el rol) · 🟢 **propia de un rol**

---

## 0. Objetivo y enfoque
- Rehacer el portal **desde cero**, tomando como base el sistema actual.
- **Primero** la estructura completa (el "qué hay"); **después** la visibilidad por rol (matriz Rol × Acción).
- Principio: **páginas compartidas y adaptables por defecto**; página propia de un rol solo cuando la experiencia es genuinamente distinta (ej. el estudiante pagando).
- **Pago online con Mercado Pago** reemplaza la carga manual de comprobantes. Automatización con **Tango Gestión Nube** = fase 2.
- **Los permisos reales viven en el servidor** (RLS / RPC). La pantalla solo muestra/oculta.
- **Paginado:** las listas/tablas largas se muestran **paginadas** (de a N filas), no todo de una.
- **Roles:** "Profesor" pasa a llamarse **Director**.

---

## 1. Roles
Administrador · Secretaría · Coordinador · Director (antes "Profesor") · Cooperadora · Gerente Cooperadora · Estudiante.

- **Administrador:** ve y hace **todo**.
- **Coordinador:** acotado a **sus** programas/agrupaciones.
- **Cooperadora:** **alcance global** (ente de control). Puede **armar/editar la estructura** (programas, agrupaciones, inscripciones, montos de cuotas). **Paga a proveedores** y **emite el comprobante de transferencia** (la transferencia se hace por fuera, en el home banking por CBU; el sistema solo la registra). Hace **liquidaciones** de divisas. *(Ya no aprueba comprobantes de alumnos: MP confirma solo.)*
- **Director (antes Profesor) / Secretaría / Gerente Cooperadora / Estudiante:** a definir en la matriz.

---

## 2. Conceptos base

### Agrupación vs Tipo
- **Agrupación** = el grupo **concreto** de estudiantes con sus cuotas (ej.: *Cohorte 2026*, *Readmisiones 2026*, *Reinscripciones anuales*).
- **Tipo** = la **categoría** de esa agrupación (ej.: *Cohorte*, *Readmisión*, *Reinscripción*). **Configurable** por el Admin, con interruptor **"¿Cuenta como cohorte?"**.
- **Muchas agrupaciones pueden ser del mismo tipo.**

Ejemplo (Doctorado): 5 agrupaciones (Cohorte 2024/2025/2026 + Readmisiones 2026 + Reinscripciones anuales), 3 tipos → la tarjeta "Cohortes" cuenta **3**; los totales de plata/estudiantes suman **las 5**.

### Estados de pago (por inscripción)
- **Al día:** sin cuotas vencidas impagas **y** mes corriente abonado.
- **Al corriente / mes pendiente:** sin vencidas impagas, pero el mes corriente (aún no vencido) no está pagado.
- **En mora:** al menos una cuota vencida impaga.

---

## 3. Mapa de páginas

### A. Acceso
- 🔵 **Login** — DNI + contraseña.
- 🔵 **Recuperar acceso** — dispara aviso al coordinador (o admin de respaldo).
- 🔵 **Cambio de contraseña** — obligatoria en el primer ingreso.

### B. Inicio (Dashboard)
- 🔵 **Dashboard de gestión** (Admin, Secretaría, Coordinador, Cooperadora, Director) — una sola página adaptable:
  - **Filtro Programa → Agrupaciones (con tildes):** recalcula todas las tarjetas para lo seleccionado.
  - **Tarjetas:** 📚 Cohortes (solo tipos "cuenta como cohorte", sin desglose) · Estudiantes (por inscripción) · Activos · Bajas · 💳 Al día · Al corriente/mes pendiente · En mora · 💰 Recaudado ARS · Recaudado USD (pendiente de liquidar) · Egresos · Saldo.
  - **Acceso "Liquidar"** → flujo de liquidación de divisas.
  - *Por rol:* Admin y Cooperadora = global; Coordinador = su alcance.
- 🟢 **Inicio del Estudiante** — vista simple: inscripciones y cuotas.

### C. Estructura académica
- 🔵 **Programas / Cursos** — ABM del Admin; otros ven lo suyo.
- 🔵 **Detalle de Programa** — sus agrupaciones, cada una con su tipo.
- 🔵 **Detalle de Agrupación (cohorte/edición)** — grilla estudiantes × cuotas + sus valores de honorarios.
  - La **secuencia de cuotas** (encabezados: Cuota N – mes – valor general) es un **PLAN DE REFERENCIA** de la agrupación, para que el administrativo sepa a qué cuota/mes corresponde y el valor general. **El monto real de cada estudiante puede diferir** (descuento, otra forma de pago, paga más).
- 🔵 **Detalle de Estudiante** — ficha con todas sus cuotas/estados.

### D. Pagos — lado Estudiante
- 🟢 **Mis inscripciones** — todas sus agrupaciones (de uno o varios programas) con su estado.
- 🟢 **Abonar cuotas** — selección múltiple:
  - pre-tildadas las **vencidas + mes corriente**; selección elegible.
  - **cuotas completas**; para PAGO_PARCIAL, cobra el **saldo restante**.
  - seleccionables: NO_ABONADA, EN_MORA, PAGO_PARCIAL (las "a definir" y "no aplica", no).
  - **un pago = un solo programa/curso**.
  - monto calculado **al momento** (descuento por pago en término / mora).
  - **Pagar seleccionadas → Mercado Pago**.
- 🟢 **Resultado del pago** — aprobado / pendiente (offline) / rechazado.
- 🟢 **Solicitar baja** — de una inscripción puntual.

### E. Libre Deuda
- 🟢 **Solicitar Libre Deuda** — se habilita **por programa** cuando están saldadas todas sus inscripciones de ese programa; con baja, cuando está pagado **hasta la fecha de baja**.
- 🟢 **Certificado de Libre Deuda** — detalle completo: todas las cuotas (incluidas "a definir"), lo que correspondía, lo pagado, y la baja con fecha (si hubo). Con **QR**.
- 🔵 **Verificación por QR** — página propia del sistema (se conserva).
- 🔵 **Libre deudas emitidos** — consulta para gestión.

### F. Pagos — lado Gestión
- 🔵 **Gestión de cuotas** (dentro de la Agrupación / ficha) — editar montos, estados, exenciones (mora/descuento), **quitar mora/descuento en una o varias cuotas seleccionadas** de un estudiante, **marca manual de pago** y **pago parcial** para excepciones (transferencias fuera de MP).
- 🔵 **Historial de pagos** — gestión ve todos; el alumno, los suyos.
- ❌ **Eliminado:** subir comprobante (alumno) y aprobar/rechazar comprobantes.

### G. Finanzas / Egresos
- 🔵 **Gastos y Egresos** — proyectados y ejecutados (ver detalle en §4).
- 🔵 **Etiquetas de gastos** / **Categorías** (agrupador opcional para reportes).
- 🔵 **Liquidaciones de divisas (USD → ARS)** — selectiva (por programa y/o agrupación), cotización propia, atribuye los pesos al origen, registrada; nunca se liquida dos veces.
- 🔵 **Cashflow / Flujo de caja**.

### H. Proyecciones
- 🔵 **Dos proyecciones que conviven:**
  - **Confirmada:** solo lo que ya tiene valor.
  - **Estimada:** confirmada + los "a definir" al último valor conocido (toggle "incluir estimadas").

### I. Usuarios y accesos
- 🟢 **Usuarios** — ABM, roles, asignaciones, importar, reseteo de clave (Admin; quizá Secretaría).
- *(Reseteo del Coordinador vive dentro de la Agrupación.)*

### J. Reportes
Inventario (el "cómo se arma cada uno" se detalla reporte por reporte más adelante).
Alcance por rol: **Admin y Cooperadora = global**; **Coordinador/Director = sus programas**; **Secretaría = operativos (estado de pagos, morosidad)**.

- 🔵 **Planificación financiera** (estratégico) — liquidez, escenarios de flujo de caja, métricas, deserción, aging; incluye consultor IA. (Admin/Cooperadora.)
- 🔵 **Ingresos ejecutados** — lo efectivamente cobrado, por período/programa/agrupación.
- 🔵 **Egresos ejecutados** — lo efectivamente pagado.
- 🔵 **Egresos vs Ingresos** — comparación / resultado.
- 🔵 **Proyección de ingresos** — cuotas futuras por cobrar (confirmadas + estimadas).
- 🔵 **Proyección de egresos** — gastos futuros (recurrentes, dictado, eventos estimados).
- 🔵 **Morosidad** — cuotas/estudiantes en mora.
- 🔵 **Estado de pagos** — situación de cada estudiante/cuota (al día / al corriente / en mora).
- 🔵 **Impacto de descuentos** — cuánto se resignó por descuentos.
- 🔵 **Tasa de deserción** — bajas / abandono.
- 🔵 **Comparativo** — entre programas / agrupaciones / períodos.

### K. Conciliación contable (Fase 2 – Tango)
- 🔵 **Recibos / Facturas Tango** — asignación de comprobantes (Admin / Cooperadora / Secretaría).

**Integración por API — "factura = deuda" (opciones):**
- **Opción 1 (recomendada):** Tango manda, el sistema escucha → al emitirse una **factura** suma deuda al estudiante; **nota de débito** suma; **nota de crédito** resta.
- **Opción 2:** el sistema manda, Tango refleja.
- **Opción 3:** bidireccional.

**Enlace comprobante → cuota (el problema a resolver):**
- El estudiante se identifica por su **ID de Tango** (único por estudiante).
- La **factura** muestra en el **artículo** el **programa/curso** y el **monto**.
- El **recibo** muestra qué **factura** paga, el **ID del estudiante** y el **monto** (puede ser **menor** que la factura: la factura cubre las cuotas definidas y el recibo paga una cuota).
- Falta vincular a la **cuota puntual**. Opciones: (a) que el **artículo** incluya el **período/cuota**; (b) **inferir** por monto + cuotas pendientes del estudiante en ese programa; (c) una **referencia explícita** (tipo leyenda "Cobro id período DNI"). Sugerido: **(a) + (b)**.

### L. Configuración (solo Admin)
- 🟢 **Parámetros** — mora, descuentos (incluye "¿pierde el descuento al entrar en mora?"), emails automáticos. *(Datos bancarios: ya no, se paga por MP.)*
- 🟢 **Tipos de agrupación** — lista simple: nombre del tipo + interruptor "¿Cuenta como cohorte?" + editar/eliminar + "Nuevo tipo". Al crear/editar una agrupación, se elige el tipo de esta lista.
- 🟢 **Etiquetas de gastos** — catálogo (con valor / monto libre).
- 🟢 **Mercado Pago** — credenciales/config.

### M. Transversales
- 🔵 **Notificaciones** · 🔵 **Perfil** · 🟢 **Logs / Auditoría** (Admin).

---

## 4. Modelo de egresos / honorarios (detalle)

### Etiquetas de gastos
- Catálogo que gestiona el **Admin**. Cada etiqueta es **con valor** (honorario, se pre-carga el monto) o **de monto libre** (se escribe).

### Valores (honorarios)
- Se setean **por agrupación**, con **vigencia** (historial de aumentos) y **editables**.
- Conceptos: hora de dictado, coordinador, director, jurado de tesis, director de tesis, etc.
- Los valores difieren entre programas (incluso entre dos especializaciones) y entre agrupaciones de un mismo programa (aumentan año a año).
- Comodidad: al crear una agrupación nueva, pre-completar copiando de otra y editar.

### Asignación y reparto de gastos
Al cargar un gasto se elige su **destino**:
- **A una o más agrupaciones (directo):** si es una, va entera; si son varias, se **pre-carga por saldo disponible ponderado**, con **edición manual**.
- **Al programa/curso:** **reparto ponderado por saldo disponible** entre las agrupaciones del programa.
- **A un tipo de agrupación** (ej.: todas las Readmisiones).

**Criterio de reparto:** por defecto **por saldo disponible** (fijo por programa), con **posibilidad de editarlo/cambiarlo** en un gasto puntual.

**Saldo disponible de una agrupación = ingresos ejecutados − egresos ejecutados** (la plata real que hay). Es lo que pondera el reparto.

**Reglas de seguridad (en todos los modos):**
1. Agrupación con saldo **0 o negativo → no recibe** parte del gasto.
2. Si a una le tocaría **más de lo que tiene**, se le asigna solo hasta su saldo y el **excedente se redistribuye**; **nunca** queda en negativo.
3. Si entre todas **no alcanza** para cubrir el gasto, el sistema **avisa** (fondos insuficientes) y decide la persona.

**Proyección vs pago:** se **proyecta** con la estimación y, **al pagar**, el reparto se **ajusta sobre los saldos reales** del momento.

### Pago a proveedores
- La transferencia al proveedor se hace **por fuera del sistema** (home banking, CBU). El sistema **registra el egreso** y Cooperadora **emite/adjunta el comprobante de transferencia**.
- **Oportunidad de integración:** una automatización **nueva** (aparte de la de recibos) podría **leer los correos de notificación del banco** y registrar el pago + adjuntar el comprobante automáticamente.

### Quién carga proyectados
- **Cooperadora** (global) y **Coordinador** (su alcance). Admin gestiona el catálogo.

### Naturaleza de los egresos
- **Recurrentes mensuales** (coordinador, director) → se proyectan cada mes.
- **Hora de dictado** → Proyectado = horas totales × valor hora de la agrupación (se conocen las horas de antemano). Ejecutado = **N facturas**, una por **profesor-proveedor** con sus horas (ej.: 20 hs a 1 h c/u = 20 facturas / 20 proveedores).
- **Esporádicos / por evento** (jurado de tesis, director de tesis) → se registran al ocurrir; proyectables por **cantidad estimada** (manual **y** sugerida por historial) × valor.
- **Únicos / compras** (libros, insumos) → carga manual, monto libre.

### Cuotas "a definir" (ingresos)
- No valen **menos** que la última cuota con valor definido (ese valor = piso para estimar). Se muestran como estimadas en la proyección.

---

## 5. Pagos online (Mercado Pago)
- Reemplaza la carga de comprobantes del alumno.
- Flujo: el front pide al backend (Edge Function) crear el pago → MP → el alumno paga → **webhook** verificado del lado servidor → se marca(n) la(s) cuota(s) ABONADA(s).
- **La verdad del pago es el webhook verificado**, no la pantalla de "éxito".
- Una orden de pago puede cubrir **varias cuotas** (del mismo programa): se guarda la lista de cuotas antes de pagar y se reconcilia por esa lista (idempotente).
- El **access token** de MP vive solo en el servidor; la **public key** en el frontend (credenciales test/producción del panel de MP).
- **Estados del PAGO** (no del recibo):
  - **Aprobado** → la cuota pasa a ABONADA.
  - **Pendiente** → pago **en proceso** por medios offline (efectivo/Rapipago/PagoFácil): MP da un cupón, el alumno paga en el kiosco y MP confirma horas después. Mientras tanto queda "pendiente". *(No es "recibo pendiente"; el recibo fiscal es tema de Tango, fase 2.)*
  - **Rechazado** → no se registra pago.
- Con MP se paga el **monto exacto** → no hay "pago de más". El pago de más solo ocurre por **transferencia**, que se maneja por fuera.

---

## 6. Liquidación de divisas (USD → ARS)
- **Selectiva:** por programa y/o agrupación, con cotización propia por liquidación.
- Convierte solo los USD **pendientes** del alcance elegido; los pesos quedan atribuidos a **cada agrupación de origen** (cada dólar viene de un pago atado a una cuota → programa/agrupación/tipo).
- Queda **registrada** (fecha + cotización + alcance + pagos). Cada pago USD sabe si está pendiente o liquidado → no se liquida dos veces.

---

## 7. Pendientes de definir
- **Estimación de defensas de tesis:** ¿a qué nivel se carga, programa/año o cohorte? *(en discusión)* — sirve para proyectar el gasto de jurado y director de tesis.
- **Perfiles de Secretaría, Director (antes Profesor), Gerente Cooperadora, Estudiante** (detalle).
- **Tango (fase 2):** elegir opción de integración (§K) y resolver el enlace recibo → cuota.
- **Reportes:** detallar "cómo se arma" cada uno (§J).
- **Matriz Rol × Página/Acción** completa.

---

## 8. Próximos pasos
1. Resolver los pendientes de §7.
2. Armar la **matriz Rol × Página/Acción**.
3. Decidir arquitectura técnica (frontend + Supabase + Edge Functions para MP).
