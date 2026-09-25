# PostgreSQL local de desarrollo

`migrations/001_initial_schema.sql` crea el esquema `aa_local` con las diez
tablas de negocio actuales. Conserva los UUID, columnas, relaciones y
validaciones de Supabase. Los UUID de `aa_local.profiles.id` corresponden a los
usuarios de Supabase Auth, pero esta base no instala `auth` ni `storage`.

La migración rechaza las bases de mantenimiento `postgres` y `template*`, y
requiere que no exista un esquema `aa_local` previo. Está dentro de una
transacción: si falla, no deja tablas parciales. No ejecuta ninguna operación
sobre el proyecto Supabase remoto.

Desde la raíz de `Accion_Animal_Offline`, aplicar con:

```powershell
& 'C:\Program Files\PostgreSQL\18\bin\psql.exe' -X -h 127.0.0.1 -p 5432 -U postgres -d accion_animal_dev -v ON_ERROR_STOP=1 -f 'db/local/migrations/001_initial_schema.sql'
```

PostgreSQL solicitará la contraseña en la terminal. No guardarla en este
repositorio ni enviarla por chat. Si aparece `COMMIT` al final, ejecutar las
comprobaciones, que terminan en `ROLLBACK` y no conservan datos ficticios:

```powershell
& 'C:\Program Files\PostgreSQL\18\bin\psql.exe' -X -h 127.0.0.1 -p 5432 -U postgres -d accion_animal_dev -v ON_ERROR_STOP=1 -f 'db/local/tests/initial_schema.test.sql'
```

## Paso 4.2: base de sincronización y cuentas separadas

Después de aplicar y probar la migración 001, ejecutar:

```powershell
& 'C:\Program Files\PostgreSQL\18\bin\psql.exe' -X -h 127.0.0.1 -p 5432 -U postgres -d accion_animal_dev -v ON_ERROR_STOP=1 -f 'db/local/migrations/002_sync_foundation.sql'
```

La migración añade `sync_operations`, `sync_confirmations`, `sync_errors` y
`sync_state`. Agrega versiones de fila y auditoría automática a las ocho
tablas clínicas. Crea `aa_local_migrator`, dueño de los objetos, y
`aa_local_app`, con permisos limitados. Ambos roles quedan sin `LOGIN` y sin
contraseña hasta configurar sus credenciales fuera de Git. La cuenta de la
aplicación no puede modificar el contenido de una operación ya registrada ni
insertar eventos de auditoría directamente.

Si aparece `COMMIT`, ejecutar la prueba, que termina en `ROLLBACK` y no
conserva datos ficticios:

```powershell
& 'C:\Program Files\PostgreSQL\18\bin\psql.exe' -X -h 127.0.0.1 -p 5432 -U postgres -d accion_animal_dev -v ON_ERROR_STOP=1 -f 'db/local/tests/sync_foundation.test.sql'
```

Esta etapa todavía no conecta React o Node.js a `aa_local` ni activa el
trabajador de sincronización. La API validará identidad y permisos, y guardará
cada cambio junto con su operación pendiente dentro de una transacción. Los
roles de base de datos no sustituyen esa autorización. La aplicación actual
sigue utilizando Supabase directamente para los datos clínicos.

## Paso 4.3 en curso: API local

El servidor de este repositorio ya incluye rutas `GET` bajo `/api/local/` para
mascotas, expedientes, vacunas, medicamentos, alergias, notas, pesos y metadatos
de archivos. Por ejemplo, `/api/local/pets` y
`/api/local/pets/{uuid}/clinical-records`. Requieren la sesión HTTP actual y
un perfil activo con el mismo rol en `aa_local.profiles`. Las consultas usan
parámetros SQL y páginas de hasta 200 filas. Todavía no existen rutas de
escritura para todos los recursos ni se ha cambiado React para usar estas
consultas.

`POST /api/local/pets` acepta una mascota junto con sus vacunas y su nota
inicial. Solo dueño y veterinaria pueden utilizarlo. Registra mascota, datos
relacionados y operaciones pendientes de sincronización dentro de una sola
transacción; si falla cualquier parte, deshace el alta. Esta ruta todavía no
está conectada a la pantalla de React.

`POST /api/local/pets/{uuid}/clinical-records` acepta un expediente y un peso
opcional. Verifica que la mascota exista, registra auditoría y crea las
operaciones pendientes con dependencias mascota → expediente → peso. Si falla
el peso, deshace también el expediente.

`POST /api/local/clinical-records/{uuid}/files` registra los metadatos de un
archivo ya cargado en `/uploaded/...`. Verifica ruta, existencia, tamaño y
SHA-256 del archivo físico antes de guardar el registro y su operación
pendiente. No borra el archivo físico si falla el registro; la interfaz futura
debe limpiar esa carga o permitir reintentar el registro.

`PATCH /api/local/pets/{uuid}` y `PATCH /api/local/clinical-records/{uuid}`
editan campos permitidos. El cuerpo incluye `expected_version` (la
`row_version` recibida al consultar) y `changes`. Si otra operación modificó
el registro, la API responde `409` para evitar sobrescribirla. Cada edición
incrementa la versión, registra auditoría y crea una operación `UPDATE`
pendiente en la misma transacción. En mascotas, la API establece o limpia
automáticamente los campos de baja al cambiar `status`.

También hay altas individuales `POST /api/local/pets/{uuid}/vaccinations`,
`/pet-notes` y `/weight-records`, más ediciones `PATCH` para esos tres recursos
en `/api/local/{recurso}/{uuid}`. `DELETE` de vacunas, notas, pesos y
metadatos clínicos (`/api/local/clinical-files/{uuid}`) exige
`expected_version` y guarda una operación pendiente de eliminación. Al borrar
metadatos clínicos, el archivo físico permanece en `uploaded` hasta poder
confirmar su eliminación remota y revisar si otra ficha lo usa. La interfaz
aún no utiliza estas rutas; faltan las eliminaciones de expedientes y mascotas.

La conexión usa exclusivamente `127.0.0.1`, `accion_animal_dev` y el rol
limitado `aa_local_app`; nunca usa la cuenta `postgres` en el servidor de la
aplicación. La migración deja el rol sin `LOGIN`. En desarrollo, desde `psql`
conectado como `postgres` a `accion_animal_dev`, aprovisionarlo con
`\password aa_local_app` y después `ALTER ROLE aa_local_app LOGIN;`. La contraseña se
introduce en la terminal, nunca en Git ni en el chat. En esta instalación de
desarrollo ese paso ya se realizó y se comprobó que la cuenta ve `aa_local.pets`.

En la sesión PowerShell donde se iniciará el servidor, activar la conexión sin
mostrar la contraseña:

```powershell
$env:AA_DB_PASSWORD = Read-Host 'Contraseña de aa_local_app' -MaskInput
npm.cmd run start:local
```

El arranque comprueba la cuenta limitada y el esquema. `/api/health` informa
`database: available` cuando se conectó. Sin `AA_DB_PASSWORD`, el servidor
continúa funcionando y las rutas `/api/local/` responden `503` tras autenticar
al usuario. Al establecer una sesión con Supabase, el servidor copia o
actualiza en PostgreSQL el perfil activo verificado (UUID, nombre y rol). Esto
habilita la API local para ese usuario; todavía requiere internet para iniciar
sesión y no copia los datos clínicos. Reiniciar el servidor después de cambiar
este código y volver a iniciar sesión para registrar el perfil local.

Verificar las rutas sin conectarse a la base:

```powershell
node --test server/local-api.test.mjs
node --test server/local-writes.test.mjs
npm.cmd run build
```

Para comprobar en la base real los permisos del rol y los disparadores sin
conservar datos de ejemplo, ejecutar como `postgres` desde la raíz del repo:

```powershell
& 'C:\Program Files\PostgreSQL\18\bin\psql.exe' -X -h 127.0.0.1 -p 5432 -U postgres -d accion_animal_dev -v ON_ERROR_STOP=1 -f 'db/local/tests/clinical_api_write.test.sql'
```

La salida correcta termina con `Clinical API write permissions and transaction
checks passed` y `ROLLBACK`. Esta prueba SQL usa una ruta de archivo ficticia
para comprobar los metadatos: no crea ningún archivo en `uploaded`. La prueba
de código que verifica un archivo físico lo crea en una carpeta temporal y lo
borra al terminar.

Estas rutas aún dependen de la sesión Supabase y no son acceso sin internet.

## Ensayo de importación desde Supabase de pruebas

`scripts/import-test-data.mjs` lee las nueve tablas de datos clínicos y perfiles del proyecto
Supabase de **pruebas** y conserva UUID, fechas y relaciones en `aa_local`.
Rechaza otra referencia de proyecto, un destino con datos clínicos o una cola
de sincronización existente. La lectura remota usa una transacción de solo
lectura; la importación local usa una sola transacción. Por defecto verifica
recuentos y termina en `ROLLBACK`. No copia archivos de `uploaded` ni prepara
el punto inicial de sincronización ni el historial `audit_events`; no usar este
script para producción.

En una nueva terminal PowerShell, obtener en **Connect → Session pooler** la
URI PostgreSQL del proyecto de **pruebas** (puerto 5432). La URI de conexión
directa `db.<proyecto>.supabase.co` puede requerir IPv6 y no resolver desde
esta PC. No pegar contraseñas ni URI en el chat o en archivos del repositorio.
Introducir ambas sin mostrarlas:

```powershell
$env:AA_TEST_DB_URL = Read-Host 'URI PostgreSQL de Supabase de pruebas' -MaskInput
$env:AA_DB_PASSWORD = Read-Host 'Contraseña de aa_local_app' -MaskInput
node scripts/import-test-data.mjs --check
```

Solo después de revisar que el recuento coincide con el origen de pruebas,
ejecutar `node scripts/import-test-data.mjs --apply` para conservar la copia
local de pruebas. El destino `accion_animal_dev` puede tener perfiles creados
por el inicio de sesión, siempre que también existan en el origen de pruebas.
El script falla antes de importar si ya hay datos clínicos locales.
