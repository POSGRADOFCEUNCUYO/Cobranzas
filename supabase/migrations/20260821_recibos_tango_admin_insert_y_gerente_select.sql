-- Recibos Tango: permitir que el ADMINISTRADOR cargue recibos manualmente desde el
-- navegador, y que GERENTE_COOPERADORA pueda verlos.
--
-- Contexto: la carga manual de recibos desde administrador_5_estudiante.html inserta
-- en recibos_tango desde el cliente (rol authenticated). Hasta ahora solo el GAS con
-- service_role podía insertar, y GERENTE_COOPERADORA no figuraba en las policies de
-- lectura (por lo que tampoco veía los recibos que entran por Tango).

-- 1) INSERT: solo ADMINISTRADOR puede insertar recibos desde el navegador.
drop policy if exists adm_insert_tango on public.recibos_tango;
create policy adm_insert_tango on public.recibos_tango
  for insert
  with check (exists (
    select 1 from public.usuarios u
    where u.auth_user_id = auth.uid()
      and u.rol = 'ADMINISTRADOR'::rol_usuario
      and u.activo = true
  ));

-- 2) SELECT: GERENTE_COOPERADORA puede ver los recibos (faltaba).
drop policy if exists gerente_select_tango on public.recibos_tango;
create policy gerente_select_tango on public.recibos_tango
  for select
  using (exists (
    select 1 from public.usuarios u
    where u.auth_user_id = auth.uid()
      and u.rol = 'GERENTE_COOPERADORA'::rol_usuario
      and u.activo = true
  ));
