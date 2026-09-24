# Acción Animal — reconstrucción con Supabase

Esta carpeta contendrá la nueva versión del sistema. El proyecto PHP original se conserva intacto como referencia funcional y de datos.

## Objetivo confirmado

Reconstruir el sistema de Acción Animal con:

- aplicación ejecutada únicamente en la red local del consultorio;
- PostgreSQL y autenticación en Supabase Free;
- imágenes y documentos conservados en una PC Windows del consultorio;
- registro, consulta, edición, baja y eliminación de mascotas;
- expedientes clínicos con fotos y documentos;
- interfaz adaptable a computadora, tableta y teléfono;
- permisos y validaciones que eviten los riesgos presentes en la versión original.

## Arquitectura propuesta

### Aplicación

La aplicación es una SPA construida con React, TypeScript y Vite. Un servidor Node.js pequeño la publica desde la PC de almacenamiento solamente en la red local. La autorización de los datos se aplica en Supabase mediante RLS y el servidor valida cada sesión con Supabase antes de permitir acceso a los archivos.

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
- los documentos se consultarán únicamente después de validar la sesión de Supabase;
- el servidor local aplicará límites de tamaño, tipos permitidos, permisos por rol y protección contra recorridos de ruta.

Los archivos clínicos permanecerán privados y se consultarán únicamente por usuarios autenticados autorizados.

## Acceso y permisos acordados

- acceso mediante correo electrónico y contraseña;
- tres roles: dueño, veterinaria/o y recepción;
- existirá un único usuario con rol `owner`;
- solo el dueño podrá crear y eliminar accesos, definir sus credenciales y asignar los roles de veterinaria/o o recepción;
- el registro público de cuentas permanecerá deshabilitado;
- todos los usuarios autenticados pueden consultar todas las mascotas y expedientes;
- recepción no puede registrar y editar mascotas, incluyendo el nombre y teléfono del tutor en cada registro;
- veterinarias/os pueden registrar y editar mascotas, además de administrar toda la información clínica;
- solo veterinarias/os pueden dar de baja, reactivar o eliminar información;
- los roles usados para autorización no se confiarán a metadatos editables por el usuario;
- todas las tablas expuestas tendrán RLS y políticas explícitas;
- ninguna clave secreta o `service_role` formará parte de la aplicación publicada.

La administración de cuentas se realiza mediante la Supabase Edge Function autenticada `manage-users`. Esta comprueba en el servidor que quien realiza la solicitud sea el dueño antes de usar la API administrativa de Auth. La clave secreta permanece únicamente en el entorno seguro de Supabase. Desde la sección **Usuarios** el dueño define nombre, correo, contraseña y rol; Supabase valida y activa la cuenta inmediatamente, sin registro público ni correo de invitación. La contraseña nunca se devuelve ni se guarda en la aplicación. El dueño también puede eliminar cuentas de Veterinaria o Recepción, pero no su propia cuenta ni otra cuenta dueña. Al eliminar, desaparecen el acceso de Auth y el perfil; las mascotas, expedientes, notas, eventos de auditoría y archivos creados por esa persona se conservan.

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

La configuración real está en `.env.local`, archivo ignorado por Git. Para preparar otra computadora, copiar `.env.example` como `.env.local` y sustituir el marcador de la clave publicable.

```powershell
npm ci
npm run local
```

La preparación completa de la PC servidor, el firewall y la copia de archivos se explica en [`ALMACENAMIENTO_LOCAL.md`](ALMACENAMIENTO_LOCAL.md).

`npm run local` es el comando de uso normal: compila la aplicación y levanta la interfaz junto con el almacenamiento en `http://localhost:4173`.

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

Arquitectura inicial, permisos y módulos documentados. El esquema de Supabase está definido mediante migraciones versionadas. La aplicación React/Vite incluye acceso, panel, búsqueda, alta de mascotas y administración de usuarios. El servidor local publica la aplicación, valida sesiones contra Supabase y sirve las rutas históricas protegidas desde el disco de la PC configurada. El respaldo `accion_animal_db.sql` y la carpeta histórica fueron localizados y analizados; la importación final de los datos aún está pendiente.
