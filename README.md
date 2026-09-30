# Acción Animal — reconstrucción con Supabase

## Entorno de pruebas de esta carpeta

Esta copia usa exclusivamente el proyecto Supabase `wuenfwsjifwuupfjgubm`. El arranque y la compilación comprueban que `.env.local` y el proyecto enlazado en `supabase/.temp/project-ref` coincidan con ese proyecto. También se rechazan URL de PostgreSQL remoto y carpetas de adjuntos que no sean `uploaded` dentro de esta copia. La interfaz muestra **ENTORNO DE PRUEBAS**.

Antes de operar con la CLI, ejecuta `npm run check:environment`. Para enviar migraciones al proyecto de pruebas, usa `npm run db:push:test`, que realiza la comprobación antes de ejecutar la CLI. Los comandos `npx supabase ...` escritos directamente no pasan por este control. Si falta el enlace, vuelve a enlazar esta carpeta al proyecto de pruebas y comprueba el resultado antes de continuar.

La base PostgreSQL local de desarrollo se llama `accion_animal_dev`. La aplicación usa PostgreSQL y credenciales locales; Supabase no interviene en el ingreso diario.

Esta carpeta contendrá la nueva versión del sistema. El proyecto PHP original se conserva intacto como referencia funcional y de datos.

## Objetivo confirmado

Reconstruir el sistema de Acción Animal con:

- aplicación ejecutada únicamente en la red local del consultorio;
- PostgreSQL y autenticación locales;
- imágenes y documentos conservados en una PC Windows del consultorio;
- registro, consulta, edición, baja y eliminación de mascotas;
- expedientes clínicos con fotos y documentos;
- interfaz adaptable a computadora, tableta y teléfono;
- permisos y validaciones que eviten los riesgos presentes en la versión original.

## Arquitectura propuesta

### Aplicación

La aplicación es una SPA construida con React, TypeScript y Vite. Un servidor Node.js pequeño la publica desde la PC de almacenamiento solamente en la red local. El servidor valida las sesiones y los roles en PostgreSQL local antes de permitir acceso a datos y archivos.

### Base de datos

Modelo inicial propuesto:

- `profiles`: perfil y rol (`owner`, `veterinarian` o `reception`) de cada usuario autenticado;
- `pets`: información de las mascotas, nombre y teléfono del tutor, foto principal y estado activo/baja;
- `clinical_records`: consultas e historias clínicas;
- `clinical_files`: metadatos y ruta de cada foto o documento;
- tablas de catálogo si se necesitan especies, doctores u otros valores administrables.

Las relaciones, restricciones, índices, políticas RLS y reglas de eliminación se definirán mediante migraciones SQL versionadas.

### Imágenes y documentos

La carpeta local `uploaded/` se conserva en la PC servidor. Supabase Storage no se usa para los archivos del sistema.

Diseño acordado:

- ruta web local `/uploaded/` asociada a la carpeta indicada por `AA_STORAGE_ROOT`;
- conservación de nombres y subcarpetas históricas, incluyendo `uploaded/clinicos/...`;
- la base de datos guardará ruta, nombre original, tipo MIME, tamaño, autor y fecha;
- los documentos se consultarán únicamente después de validar la sesión local;
- el servidor local aplicará límites de tamaño, tipos permitidos, permisos por rol y protección contra recorridos de ruta.

Los archivos clínicos permanecerán privados y se consultarán únicamente por usuarios autenticados autorizados.

## Acceso y permisos acordados

- acceso mediante correo electrónico y contraseña;
- tres roles: dueño, veterinaria/o y recepción;
- solo un usuario con rol `owner` podrá crear y desactivar accesos de veterinaria/o o recepción;
- el registro público de cuentas permanecerá deshabilitado;
- todos los usuarios autenticados pueden consultar todas las mascotas y expedientes;
- recepción no puede registrar y editar mascotas, incluyendo el nombre y teléfono del tutor en cada registro;
- veterinarias/os pueden registrar y editar mascotas, además de administrar toda la información clínica;
- solo veterinarias/os pueden dar de baja, reactivar o eliminar información;
- los roles usados para autorización no se confiarán a metadatos editables por el usuario;
- todas las tablas expuestas tendrán RLS y políticas explícitas;
- ninguna clave secreta o `service_role` formará parte de la aplicación publicada.

La administración de cuentas se realiza en el servidor local, incluso sin Internet. Desde **Usuarios**, `owner` define nombre, correo, contraseña y rol. Solo se guarda un hash scrypt con sal en PostgreSQL. La cuenta queda activa inmediatamente y no vence a los siete días. Al desactivar a alguien se revoca su acceso local y se conserva su historial. Tras aplicar `009_local_users.sql`, si aún no hay credenciales locales de un dueño se preparan una sola vez con `scripts/bootstrap-local-owner.mjs`. El sincronizador `--once` sigue siendo bidireccional y no sirve como respaldo de estas cuentas locales; para copias se requiere un respaldo PostgreSQL junto con `uploaded/`.

## Diseño visual acordado

- conservar logotipo y colores identificativos actuales;
- mejorar composición, navegación, formularios y adaptación responsive;
- apariencia profesional y sobria;
- tipografías legibles y controles accesibles;
- evitar animaciones o recursos visuales extravagantes.

## Funciones heredadas que se conservarán

- alta de mascota con nombre y teléfono de su tutor;
- búsqueda por mascota, propietario y teléfono;
- perfil con datos del animal y responsable;
- cálculo de edad;
- alta, edición y eliminación de expedientes clínicos;
- signos clínicos, diagnóstico, tratamiento, presupuesto y profesional responsable;
- múltiples fotos y documentos por expediente;
- galería y descarga de adjuntos;
- baja lógica y reactivación;
- eliminación definitiva, sujeta a permisos adecuados;
- diseño responsive.

## Módulos nuevos confirmados

- vacunas;
- medicamentos;
- alergias;
- notas;
- historial de peso.

## Ejecución local

La configuración de esta copia de pruebas está en `.env.local`, archivo ignorado por Git. Debe contener la URL y la clave publicable del proyecto Supabase de pruebas.

```powershell
npm ci
npm run local
```

La preparación completa de la PC servidor, el firewall y la copia de archivos se explica en [`ALMACENAMIENTO_LOCAL.md`](ALMACENAMIENTO_LOCAL.md).

`npm run local` compila la aplicación de pruebas y levanta la interfaz junto con el almacenamiento en `http://localhost:4174`.

Solo para desarrollar la interfaz sin el servidor de archivos puede usarse:

```powershell
npm run dev
```

En ese modo, las funciones que usan la carpeta `uploaded` no estarán disponibles.

## Decisiones pendientes

Antes de implementar se deben confirmar:

1. importar y validar la información histórica en Supabase;
2. completar perfil de mascota, formularios clínicos y administración de archivos;
3. instalar el sistema y copiar `uploaded` en la PC Windows definitiva.

## Estado

La aplicación React/Vite consulta PostgreSQL local para acceso, mascotas y expedientes. El servidor local valida sesiones y protege los archivos en `uploaded/`. La migración `009_local_users.sql` habilita usuarios locales sin vencimiento de siete días; debe aplicarse en cada base antes de usar esta versión. La importación histórica y el despliegue en la PC definitiva se verifican por separado.
