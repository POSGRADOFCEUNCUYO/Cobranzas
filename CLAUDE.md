# SiGPo — Notas de proyecto

## Reglas de trabajo (pedidas por Anneris)
- **No rellenar los huecos con suposiciones, confirmar siempre.**
- Nunca usar Python/sed para reconstruir archivos — solo el tool Edit con bloques exactos ya leídos.
- Siempre leer antes de editar. Después de cada Edit, verificar con grep/Read.
- Un cambio por commit.

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
