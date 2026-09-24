# Creación y enlace del proyecto Supabase

El esquema local ya está preparado. No se debe importar `accion_animal_db.sql` directamente: primero se crea el esquema nuevo y posteriormente se ejecutará una migración controlada de los datos heredados.

> Estado al 8 de septiembre de 2026: el proyecto `hvfubwyzarikudisbwfy` está enlazado y la migración `20260908215222_initial_schema.sql` está aplicada y verificada.

## 1. Crear el proyecto

1. Iniciar sesión en <https://supabase.com/dashboard>.
2. Crear una organización, si todavía no existe.
3. Seleccionar **New project**.
4. Usar un nombre como `accion-animal`.
5. Generar una contraseña de base de datos larga y guardarla en un administrador de contraseñas.
6. Elegir la región más cercana a los usuarios del sistema.
7. Si aparece **Automatically expose new tables**, dejarla desactivada. La migración incluye permisos explícitos.
8. Esperar a que Supabase termine de preparar el proyecto.

No compartir en el chat la contraseña de la base, una secret key ni la clave `service_role` heredada.

## 2. Obtener el identificador del proyecto

En **Project Settings → General**, copiar el **Reference ID**. También puede obtenerse de la URL del Dashboard:

```text
https://supabase.com/dashboard/project/hvfubwyzarikudisbwfy
```

El Reference ID de este proyecto es `hvfubwyzarikudisbwfy`. No es una contraseña.

## 3. Enlazar desde la terminal

Ejecutar dentro de `accion-animal-supabase`:

```powershell
npx --yes supabase@2.117.0 login
npx --yes supabase@2.117.0 link --project-ref hvfubwyzarikudisbwfy
npx --yes supabase@2.117.0 db push
```

`db push` aplicará la migración versionada que crea tablas, relaciones, índices, RLS, funciones, triggers y buckets. No se debe copiar y pegar manualmente el respaldo MySQL en SQL Editor.

## 4. Configurar autenticación

En **Authentication → Providers → Email**:

- habilitar correo y contraseña;
- deshabilitar el registro público de usuarios;
- no habilitar usuarios anónimos;
- mantener una longitud mínima de contraseña de al menos 10 caracteres;
- requerir letras mayúsculas, minúsculas y números.

Cuando exista la URL de GitHub Pages, configurar en **Authentication → URL Configuration**:

```text
Site URL: https://USUARIO.github.io/REPOSITORIO/
Redirect URL: https://USUARIO.github.io/REPOSITORIO/**
```

Durante desarrollo también se agregará la URL local de Vite.

## 5. Crear la cuenta del dueño

Después de aplicar la migración:

1. Ir a **Authentication → Users**.
2. Crear o invitar manualmente la cuenta del dueño.
3. Esperar a que el trigger cree su fila en `public.profiles` con el rol seguro inicial `reception`.
4. En **SQL Editor**, ejecutar una sola vez, reemplazando el correo:

```sql
update public.profiles
set role = 'owner'
where id = (
  select id
  from auth.users
  where lower(email) = lower('CORREO_DEL_DUENO')
);
```

El índice `profiles_single_owner_idx` impedirá que existan dos cuentas dueñas. Las cuentas posteriores se crearán desde la aplicación por medio de una Edge Function protegida.

## 6. Revisar el resultado

En **Table Editor** deben aparecer 10 tablas de la aplicación:

- `profiles`;
- `pets`;
- `clinical_records`;
- `clinical_files`;
- `vaccinations`;
- `medications`;
- `allergies`;
- `pet_notes`;
- `weight_records`;
- `audit_events`.

En **Storage** deben aparecer:

- `pet-photos`, público, máximo 10 MB por objeto;
- `clinical-files`, privado, máximo 25 MB por objeto.

Ejecutar los asesores de seguridad y rendimiento del Dashboard y no ignorar alertas de tablas sin RLS o funciones inseguras.

## 7. Datos que usará la aplicación web

En **Project Settings → API Keys**, la aplicación necesitará posteriormente:

- Project URL;
- Publishable key.

La publishable key puede utilizarse en un navegador porque RLS limita su alcance. No se utilizarán secret keys en GitHub Pages.

## Validación local opcional

Para levantar Supabase completamente en esta computadora será necesario instalar Docker Desktop. Después se podrán ejecutar:

```powershell
npx --yes supabase@2.117.0 start
npx --yes supabase@2.117.0 db reset
npx --yes supabase@2.117.0 test db --local
npx --yes supabase@2.117.0 db lint --local --level warning --fail-on error
```

La prueba pgTAP se encuentra en `supabase/tests/database/initial_schema.test.sql`.
