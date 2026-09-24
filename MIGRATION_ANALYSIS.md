# Informe de sincronización MySQL → Supabase

Fecha de ejecución: 10 de septiembre de 2026.

Origen: `accion_animal (5).sql` y carpeta local `uploaded/`.

Destino: proyecto Supabase `accion_animal` (`hvfubwyzarikudisbwfy`). Los binarios permanecen en `uploaded/`; Supabase guarda únicamente los datos y las rutas locales. Este informe no reproduce nombres, teléfonos, direcciones ni contenido médico.

## Resultado

- 15,009 mascotas importadas;
- 24,467 expedientes importados;
- 6,650 asociaciones entre expedientes y archivos locales;
- 11,753 registros de peso derivados de valores históricos válidos;
- 2 usuarios de Supabase y sus 2 perfiles conservados sin reemplazo;
- cero expedientes o archivos huérfanos en la base de destino;
- 15,005 mascotas activas y 4 inactivas;
- todos los identificadores MySQL de mascotas se conservaron en `legacy_id`.

El volcado contenía 24,470 expedientes. Tres hacían referencia a mascotas inexistentes y no se importaron. La zona temporal utilizada para validar la carga fue eliminada al terminar.

## Archivos locales

La carpeta `uploaded/` contiene 8,555 archivos y ocupa aproximadamente 15.8 GB:

- 1,664 archivos en la raíz;
- 6,891 archivos dentro de directorios clínicos;
- 1,619 fotos principales pudieron cruzarse con un archivo físico;
- 13,390 referencias históricas a foto principal no tienen un archivo físico identificable;
- 41 directorios clínicos referenciados en el SQL no existen en la carpeta recibida.

Las rutas se conservaron con el prefijo `uploaded/` para que la aplicación las sirva mediante el servidor local. No se copiaron imágenes a Supabase Storage.

## Seguridad y permisos

- recepción puede consultar, pero no crear ni modificar mascotas o información clínica;
- veterinaria/o puede crear y modificar mascotas y expedientes, incluido cambiar una mascota a `deceased`;
- únicamente el dueño puede eliminar información y administrar usuarios;
- RLS permanece habilitado en las tablas públicas;
- se conservó un respaldo privado previo a la sincronización en el esquema `backup_20260910_pre_legacy_sync`;
- `auth.users` quedó fuera de la sustitución y del respaldo de datos clínicos.

## Archivos de implementación

- `scripts/prepare-legacy-sync.mjs`: analiza el volcado y el inventario local, y genera lotes SQL temporales sin duplicar datos personales dentro del repositorio;
- `supabase/migrations/20260910191737_align_roles_for_legacy_sync.sql`: alinea RLS con los roles solicitados y permite asociar una misma ruta histórica con expedientes diferentes.

## Pendiente operativo

El asesor de seguridad de Supabase reporta que la protección contra contraseñas filtradas está desactivada. Esta opción debe habilitarse desde la configuración de Auth del proyecto.
