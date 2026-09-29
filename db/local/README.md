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

La API guarda cada cambio junto con su operación pendiente dentro de una
transacción. Los roles de base de datos no sustituyen su autorización.
El trabajador de envío se prepara en el paso 4.5; requiere su cuenta remota.

## Paso 4.3 en curso: API local

El servidor de este repositorio ya incluye rutas `GET` bajo `/api/local/` para
mascotas, expedientes, vacunas, medicamentos, alergias, notas, pesos y metadatos
de archivos. Por ejemplo, `/api/local/pets` y
`/api/local/pets/{uuid}/clinical-records`. Requieren la sesión HTTP actual y
un perfil activo con el mismo rol en `aa_local.profiles`. Las consultas usan
parámetros SQL y páginas de hasta 200 filas. React utiliza estas consultas
para las listas y la ficha clínica.

`POST /api/local/pets` acepta una mascota junto con sus vacunas y su nota
inicial. Solo dueño y veterinaria pueden utilizarlo. Registra mascota, datos
relacionados y operaciones pendientes de sincronización dentro de una sola
transacción; si falla cualquier parte, deshace el alta. React utiliza esta
ruta para crear mascotas.

`POST /api/local/pets/{uuid}/clinical-records` acepta un expediente y un peso
opcional. Verifica que la mascota exista, registra auditoría y crea las
operaciones pendientes con dependencias mascota → expediente → peso. Si falla
el peso, deshace también el expediente.

`POST /api/local/clinical-records/{uuid}/files` registra los metadatos de un
archivo ya cargado en `/uploaded/...`. Verifica ruta, existencia, tamaño y
SHA-256 del archivo físico antes de guardar el registro y su operación
pendiente. No borra el archivo físico si falla el registro; la interfaz
permite reintentar el registro.

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
utiliza estas rutas, incluidas las eliminaciones de expedientes y mascotas.

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
$env:AA_DB_PASSWORD = [System.Net.NetworkCredential]::new('', (Read-Host 'Contraseña de aa_local_app' -AsSecureString)).Password
npm.cmd run start:local
```

El arranque comprueba la cuenta limitada y el esquema. `/api/health` informa
`database: available` cuando se conectó. Sin `AA_DB_PASSWORD`, el servidor
continúa funcionando y las rutas `/api/local/` responden `503` tras autenticar
al usuario. Al establecer una sesión con Supabase, el servidor copia o
actualiza en PostgreSQL el perfil activo verificado (UUID, nombre y rol). Esto
habilita la API local para ese usuario; el acceso sin internet se describe en
el paso 4.4 y no copia los datos clínicos. Reiniciar el servidor después de cambiar
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

Estas rutas usan la sesión HTTP del servidor local.

La pantalla principal consulta el resumen, la lista y la búsqueda en la API
local. La ficha completa, las vacunas, notas, pesos, consultas, foto principal
y adjuntos escriben en PostgreSQL local. La ficha se descarga al abrir una
mascota; el historial usa páginas de 25 consultas y los adjuntos se consultan
al desplegar cada expediente, en páginas de 50. No se añaden dependencias.
La administración de usuarios sigue usando Supabase; el ingreso tiene respaldo local.
Para arrancar este
servidor, cargar `AA_DB_PASSWORD` de `aa_local_app` en la misma terminal antes
de `npm.cmd run start:local`. El arranque automático, HTTPS y los respaldos en
la PC definitiva siguen pendientes.

`DELETE /api/local/pets/{uuid}` y `/clinical-records/{uuid}` exigen
`expected_version`. Dentro de una transacción bloquean el registro, eliminan
los hijos y registran sus lápidas en la cola. El expediente desvincula los
medicamentos sin borrarlos. La operación de eliminación padre incluye
`cascade_delete_operations` con los UUID de las operaciones de hijos y de
desvinculación; el futuro trabajador debe confirmar **todas** esas operaciones
y `depends_on_operation_id` antes de enviar la eliminación padre.

Eliminar un adjunto quita sus metadatos de la ficha. Los archivos físicos y
las fotografías anteriores se conservan hasta confirmar sincronización y
revisar referencias compartidas; el navegador no puede borrarlos directamente.
El registro de un adjunto admite reintentos con la misma ruta y metadatos,
sin duplicar registros ni operaciones. Un fallo al cargar adjuntos conserva
el expediente y permite reintentar los archivos pendientes. Si no se pudo
confirmar el alta de una consulta, el formulario exige revisar el historial
antes de volver a crearla para evitar duplicados. Las eliminaciones de mascota
y expediente reconfirman la contraseña local antes de enviar la eliminación.

## Paso 4.4: acceso sin internet

Aplicar como `postgres` en `accion_animal_dev` y comprobar:

```powershell
& 'C:\Program Files\PostgreSQL\18\bin\psql.exe' -X -h 127.0.0.1 -p 5432 -U postgres -d accion_animal_dev -v ON_ERROR_STOP=1 -f 'db/local/migrations/003_offline_auth.sql'
& 'C:\Program Files\PostgreSQL\18\bin\psql.exe' -X -h 127.0.0.1 -p 5432 -U postgres -d accion_animal_dev -v ON_ERROR_STOP=1 -f 'db/local/tests/offline_auth.test.sql'
```

La prueba termina en `ROLLBACK`. La migración crea solamente la tabla privada
`login_credentials`; no modifica Supabase ni las fichas. Reiniciar después el
servidor en su terminal habitual con `AA_DB_PASSWORD` ya cargada.

El primer ingreso verifica contraseña
y perfil activo en Supabase. Guarda únicamente un hash scrypt con sal aleatoria,
UUID y correo en PostgreSQL local. La validación caduca a los siete días;
un nuevo ingreso con conexión la renueva. El acceso es automático: se intenta
Supabase con un plazo de tres segundos. Si no logra contactar
Auth, intenta las credenciales locales; un rechazo de contraseña en
Supabase nunca activa ese respaldo. No se cachean claves inválidas.

`POST /api/local-auth` crea una cookie aleatoria HttpOnly y SameSite Strict
por ocho horas como máximo, acotada por la vigencia de la validación. Las
sesiones viven en memoria; reiniciar el servidor exige ingresar de nuevo,
pero conserva la comprobación de contraseña en PostgreSQL. No hay claves
ni tokens persistidos en el navegador. Con HTTPS la cookie también es Secure.

`GET /api/local-session` restaura la identidad desde la cookie. El resumen,
la ficha y el perfil se consultan localmente. Los archivos y la API comprueban
el perfil activo en cada solicitud. `POST /api/local-auth/verify` reconfirma
la contraseña de la misma cuenta; el servidor exige una confirmación de menos
de cinco minutos para eliminar mascotas o expedientes. Se limitan los intentos
a cinco por correo y dirección en cinco minutos, sin añadir dependencias.

**Límite conocido:** sin sincronización, una baja o cambio de rol remoto puede
tardar hasta siete días en reflejarse si se usa acceso local. El trabajador de
perfiles deberá reducir ese intervalo cuando haya conexión. La administración
de cuentas sigue requiriendo un ingreso con internet; tras recargar la página,
hay que ingresar de nuevo con internet para usarla. La sesión Supabase solo
vive en memoria y no se renueva automáticamente; el acceso clínico es local.
El envío de datos se describe en el paso 4.5. La recepción de cambios remotos
y perfiles sigue pendiente. Los archivos físicos permanecen locales por diseño.

Comprobaciones de código:

```powershell
node --test server/local-auth.test.mjs server/local-api.test.mjs server/local-writes.test.mjs
npm.cmd run build
```

## Paso 4.5: envío local → Supabase de pruebas

`server/local-sync.mjs` envía la cola mediante un proceso separado de la API.
No modifica el código descargado por el navegador ni añade paquetes. Usa
lotes de hasta 50 operaciones; `--watch` revisa cada 30 segundos y reconecta
después de una caída. Los fallos temporales esperan entre 2 y 60 minutos.
Solo una instancia puede tomar el bloqueo local. Esta etapa admite una sola
PC que origina cambios, exclusivamente contra el proyecto de pruebas.

La migración remota `20260926192506_offline_sync_receipts.sql` **ya fue aplicada
al proyecto de pruebas**. Crea una cuenta limitada `aa_sync_worker`, sin LOGIN
ni contraseña, y confirmaciones privadas e inmutables. Cada escritura y su
confirmación se guardan en una sola transacción remota. Si se pierde la
respuesta, el reintento consulta la confirmación y no repite la escritura.
Las escrituras asumen el rol `authenticated`, conservan el autor de la
operación y están sujetas a las políticas RLS existentes. Una cuenta remota
inactiva o sin permiso clínico no puede enviar sus cambios pendientes.

El trabajador espera la operación anterior y **todos** los hijos de una
eliminación. Antes de eliminar un padre también comprueba que no tenga hijos
nuevos en Supabase. No elimina archivos del disco. Fotos y documentos siguen
en la PC; se envían sus metadatos, conforme al diseño de almacenamiento local.

Las nuevas ediciones guardan su versión original en `_sync_base`, dentro de la
operación, para comparar contra Supabase. Si la fila remota cambió, se detiene
esa operación como `conflict`; no sobrescribe el dato remoto. Las ediciones
antiguas que no tengan versión original ni confirmación previa también
requieren revisión. Reiniciar la API con `AA_DB_PASSWORD` cargada antes de
generar nuevos cambios para que incluya esa versión original.

### Activación pendiente: credenciales privadas en la terminal

1. En Supabase de **pruebas**, abrir **Connect → Session pooler**, puerto 5432.
   Obtener el host y descargar el certificado CA desde **Database → Settings →
   SSL Configuration** ([configuración de la base de pruebas](https://supabase.com/dashboard/project/wuenfwsjifwuupfjgubm/database/settings)).
   No compartir contraseñas ni URI en el chat.
2. Desde PowerShell, conectarse como administrador para configurar solamente
   la cuenta de transporte. Reemplazar la ruta del certificado y escribir el
   host indicado por Supabase:

   ```powershell
   $aaPoolHost = Read-Host 'Host del Session pooler de PRUEBAS'
   $env:PGSSLMODE = 'verify-full'
   $env:PGSSLROOTCERT = Read-Host 'Ruta completa del certificado CA descargado'
   & 'C:\Program Files\PostgreSQL\18\bin\psql.exe' -X -h $aaPoolHost -p 5432 -U postgres.wuenfwsjifwuupfjgubm -d postgres -W
   ```

   PostgreSQL solicita la contraseña administrativa en la terminal. Dentro de
   `psql`, definir una contraseña distinta para la cuenta de transporte:

   ```text
   \password aa_sync_worker
   ALTER ROLE aa_sync_worker LOGIN;
   \q
   ```

3. En una terminal separada de la API, ubicada en `Accion_Animal_Offline`,
   cargar las credenciales de la cuenta local y de transporte. La URI debe
   usar usuario `aa_sync_worker.wuenfwsjifwuupfjgubm`, el mismo host del pooler,
   puerto 5432 y base `postgres`, **sin parámetros adicionales**. Si la
   contraseña incluye caracteres reservados, codificarlos para una URI.

   ```powershell
   $env:AA_DB_PASSWORD = [System.Net.NetworkCredential]::new('', (Read-Host 'Contraseña de aa_local_app' -AsSecureString)).Password
   $env:AA_SYNC_DB_URL = [System.Net.NetworkCredential]::new('', (Read-Host 'URI Session pooler de aa_sync_worker de PRUEBAS' -AsSecureString)).Password
   $env:AA_SYNC_CA_FILE = Read-Host 'Ruta completa del certificado CA descargado'
   node --env-file-if-exists=.env.local --env-file-if-exists=.env.server scripts/sync-test-data.mjs --check
   ```

   `--check` verifica conexiones, cuenta remota y confirmaciones; muestra
   solamente recuentos y **no envía cambios**. No guardar estas credenciales en
   archivos del repositorio. Si termina correctamente, avisar para revisar la
   cola existente antes de iniciar el primer envío.

4. Tras revisar el resultado y la cola, el envío se ejecuta con `--once`; el
   proceso continuo usa `--watch`. No iniciar todavía el proceso continuo
   antes de comprobar el primer lote:

   ```powershell
   node --env-file-if-exists=.env.local --env-file-if-exists=.env.server scripts/sync-test-data.mjs --once
   node --env-file-if-exists=.env.local --env-file-if-exists=.env.server scripts/sync-test-data.mjs --watch
   ```

### Verificación realizada y trabajo pendiente

Pasaron 41 comprobaciones de código y la compilación. La comprobación SQL
`supabase/tests/database/offline_sync_receipts.test.sql` se ejecutó en Supabase
de pruebas: verificó permisos, unicidad de confirmaciones, RLS, auditoría y
alta/edición/eliminación de una mascota ficticia; terminó en `ROLLBACK`.
No se ha enviado la cola local: falta habilitar la cuenta y verificar su conexión.

La recepción de cambios clínicos y perfiles desde Supabase, la resolución
asistida de conflictos y el arranque del sincronizador con Windows siguen
pendientes. Este paso no completa la sincronización bidireccional. El paso 3
de instalación definitiva también conserva sus pendientes de HTTPS y respaldos.

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
$env:AA_TEST_DB_URL = [System.Net.NetworkCredential]::new('', (Read-Host 'URI PostgreSQL de Supabase de pruebas' -AsSecureString)).Password
$env:AA_DB_PASSWORD = [System.Net.NetworkCredential]::new('', (Read-Host 'Contraseña de aa_local_app' -AsSecureString)).Password
node scripts/import-test-data.mjs --check
```

Solo después de revisar que el recuento coincide con el origen de pruebas,
ejecutar `node scripts/import-test-data.mjs --apply` para conservar la copia
local de pruebas. El destino `accion_animal_dev` puede tener perfiles creados
por el inicio de sesión, siempre que también existan en el origen de pruebas.
El script falla antes de importar si ya hay datos clínicos locales.

### 4.6 Recepción de perfiles

La migración remota offline_profiles_inbound está aplicada en PRUEBAS.
El trabajador solo lee perfiles; no lee contraseñas de Supabase Auth.
Detén --watch con Ctrl+C en su terminal y conserva las variables cargadas.
Ejecuta:

    node --env-file-if-exists=.env.local --env-file-if-exists=.env.server scripts/sync-test-data.mjs --profiles

Se actualizan nombres, roles y actividad de forma atómica. Los perfiles ausentes
se desactivan sin borrar sus referencias clínicas. Se eliminan credenciales
locales de perfiles inactivos, pero no se renueva su plazo de siete días.
Después puedes volver a iniciar --watch.
Los modos --once y --watch reciben perfiles antes de enviar cambios clínicos. Con --watch se revisan cada 30 segundos mientras el trabajador esté abierto. La recepción de ediciones de mascotas existentes se describe en 4.9. Límite de perfiles: 1000 perfiles; superar ese límite cancela
la recepción sin cambiar el acceso local.
### 4.7 Comparación de mascotas (solo lectura)

Detén --watch con Ctrl+C, conservando las variables de la misma terminal.
Ejecuta sync-test-data.mjs --pets-check con los mismos --env-file-if-exists.
El resultado contiene recuentos, UUID, nombres de campos diferentes y local_pending;
no imprime datos clínicos ni modifica registros. Requiere un perfil clínico activo
tanto local como remoto. Una mascota solo local no prueba que fue eliminada
en Supabase: puede ser una creación pendiente. La recepción clínica aún no aplica
cambios. Límite explícito: 10000 mascotas por base.
### 4.8 Recepción manual de una mascota existente

Aplicar db/local/migrations/004_pet_inbound.sql a accion_animal_dev con el
administrador PostgreSQL LOCAL (postgres), no con la contraseña de Supabase
ni la de aa_local_app. La cuenta del sincronizador sigue siendo aa_local_app.
La prueba db/local/tests/pet_inbound.test.sql termina en ROLLBACK.

Con --watch detenido y las variables conservadas, ejecutar el sincronizador
con --pet-receive UUID. Este paso actualiza solo una mascota existente;
rechaza operaciones locales sin confirmar y ausencias remotas. No importa
mascotas nuevas, no elimina mascotas ni recibe expedientes o archivos.
La base remota queda guardada para verificar la siguiente escritura local,
y su versión compite con los recibos posteriores. La recepción incrementa
row_version para rechazar formularios locales abiertos antes del cambio.

### 4.9 Recepción automática de ediciones de mascotas

Plan de esta etapa:
1. Recibir ediciones de mascotas que ya existen en la PC mediante lotes pequeños.
2. Verificar un cambio de nombre hecho en Supabase y la protección de una edición
   simultánea local pendiente.
3. Después de esas verificaciones, ampliar a altas, eliminaciones y expedientes.

Implementado el punto 1: --watch usa la misma conexión y cuenta de sincronización.
Cada ciclo recibe perfiles, envía pendientes y revisa hasta 500 mascotas locales
por UUID. Consulta esas UUID en Supabase usando su índice primario; no descarga
toda la tabla ni agrega solicitudes al navegador. --once revisa un solo lote.
La pausa entre ciclos es de 30 segundos más el tiempo de las consultas.
Con más de 500 mascotas se requieren varias vueltas para revisar todas; el
cursor vive en memoria y reiniciar vuelve al primer lote.

Se actualizan solo filas con cambios de contenido, ignorando diferencias de
marcas de auditoría. No se incrementa row_version en mascotas sin cambios.
Las pendientes, bloqueadas y en conflicto se protegen; se comprueba la cola
otra vez con el bloqueo de la fila antes de escribir. Una ausencia en Supabase
no elimina la copia local. Este paso no importa nuevas mascotas ni expedientes.
No necesita otra migración; requiere la 004 ya aplicada.

Prueba siguiente: iniciar --watch, cambiar solamente name de una mascota
ficticia existente en Supabase y esperar el mensaje:
Recepción de mascotas de PRUEBAS: { checked: 2, received: 1, protected: 0 }
Recargar la aplicación local para ver el nombre recibido.
Detener --watch antes de usar comandos manuales del sincronizador.

Verificación de código: 43 pruebas de sincronización, API y escrituras pasan.
La prueba manual automática y la simultánea siguen pendientes hasta observar
sus resultados; no declarar terminada la recepción clínica completa.

### 4.10 Resolución revisada conservando una edición local

La prueba automática recibió el nombre remoto y protegió después una mascota
con una edición simultánea: received 0, protected 1. El diagnóstico confirmó
un conflicto y mantuvo ambas versiones disponibles para comparación.

Con --watch detenido, usar --resolve-local UUID-de-la-operación.
El comando muestra las diferencias y pide escribir APLICAR para conservar
la edición local. Admite UPDATE con o sin base original; exige que la
dependencia anterior esté confirmada y el autor conserve permisos remotos.
La misma transacción bloquea la fila, compara el hash de la versión revisada,
escribe y guarda el recibo. Si la fila cambió tras revisar, cancela sin escribir.
No aplicar esta opción a altas o eliminaciones. La resolución remota o mezcla
de campos sigue pendiente. El usuario eligió el nombre local para esta prueba;
falta observar la confirmación del comando y comprobar la cola sin conflictos.

Verificación: las 15 pruebas del sincronizador pasan, incluyendo resolución
con base previa y rechazo de cambios posteriores a la revisión.
### 4.11 Recepción automática de mascotas nuevas

Los modos --watch y --once descubren también hasta 500 UUID de mascotas en
Supabase por ciclo, usando el índice primario y un cursor en memoria. Solo se
descargan los datos completos de las que faltan localmente. Se conservan UUID,
campos, auditoría original y referencia remota. No se añade una operación de
salida por importar. Las versiones continúan después del máximo historial
local o de recibos remotos para no reutilizar versiones de un UUID anterior.

Antes de insertar se consulta la cola incluso si la mascota ya no existe en
la tabla local: una eliminación pendiente, bloqueada o en conflicto protege
ese UUID. Las restricciones y claves foráneas siguen vigentes. Si otra
transacción creó la misma UUID, ON CONFLICT DO NOTHING evita sobrescribirla.
No se reciben todavía sus expedientes, vacunas, notas, pesos ni archivos.
No se eliminan mascotas por ausencia remota. Requiere la migración 004 y la
recepción de perfiles ya existentes; no requiere una migración adicional.

Prueba siguiente, pendiente: reiniciar --watch y crear una mascota ficticia
en Supabase; comprobar Mascotas nuevas de PRUEBAS con received 1 y su aparición
tras recargar la aplicación. Después verificar su edición local y confirmación.

Verificación de código: 45 pruebas de sincronización, API y escrituras pasan.
La resolución de la prueba simultánea anterior terminó correctamente y el
diagnóstico del usuario mostró 42 confirmadas, sin conflictos pendientes.

### 4.12 Recepción de expedientes clínicos

Confirmado por el usuario: una mascota nueva de Supabase llegó a la PC y su
edición local produjo confirmed: 1. Implementada ahora la recepción de altas y
ediciones de clinical_records con lotes de 500 UUID por ciclo de --once/--watch.
Reutiliza la recepción de mascotas, conserva referencia remota y continúa las
versiones después del historial previo. No crea operaciones de salida al importar.
Protege pendientes, bloqueadas y conflictos, incluidas eliminaciones locales.
Comprueba la cola bajo bloqueo de fila; exige la mascota local y aplaza el
expediente si falta o tiene una eliminación pendiente. No modifica filas iguales.
Las ausencias remotas no eliminan la copia local. Mantiene RLS remoto.

Con --watch detenido, aplicar una sola vez usando el administrador PostgreSQL
LOCAL (postgres) y su contraseña local:

```powershell
& 'C:\Program Files\PostgreSQL\18\bin\psql.exe' -X -h 127.0.0.1 -p 5432 -U postgres -d accion_animal_dev -W -v ON_ERROR_STOP=1 -f 'db/local/migrations/005_clinical_records_inbound.sql'
& 'C:\Program Files\PostgreSQL\18\bin\psql.exe' -X -h 127.0.0.1 -p 5432 -U postgres -d accion_animal_dev -W -v ON_ERROR_STOP=1 -f 'db/local/tests/clinical_records_inbound.test.sql'
```

La prueba SQL crea una consulta ficticia para una mascota existente y termina
en ROLLBACK. Tras COMMIT de la migración y ROLLBACK de la prueba, ejecutar en
la terminal que conserva AA_DB_PASSWORD, AA_SYNC_DB_URL y AA_SYNC_CA_FILE:

```powershell
node --env-file-if-exists=.env.local --env-file-if-exists=.env.server scripts/sync-test-data.mjs --once
```

Este comando también envía pendientes. Revisar Expedientes clínicos de PRUEBAS
con checked, received y protected. Para verificar: crear o editar una consulta
ficticia en Supabase para una mascota ya local, comprobar su recepción, editarla
localmente y comprobar confirmed: 1. Verificar también una edición simultánea:
el conflicto debe proteger la versión local. Reiniciar --watch solo después de
estas comprobaciones. La carga inicial revisa 500 expedientes por ciclo. Tras
completarla, la migración 007 conserva el cursor y recibe cambios recientes
desde `audit_events`, incluso después de reiniciar el sincronizador.

Estado actualizado el 28 de septiembre de 2026: migración 005 presente y prueba
SQL aprobada. La recepción y el conflicto de expedientes se verificaron con
datos ficticios de PRUEBAS; consultar 4.13 para el resultado observado.

### Contraseñas: nombres recomendados en el gestor

| Nombre clave | Cuenta y uso |
| --- | --- |
| AA / PC / PostgreSQL administrador | postgres LOCAL: migraciones y administración de accion_animal_dev. |
| AA / PC / PostgreSQL aplicación | aa_local_app LOCAL: AA_DB_PASSWORD para API y sincronizador. |
| AA / Supabase PRUEBAS / PostgreSQL administrador | postgres remoto: administración del proyecto de pruebas; distinta de postgres local. |
| AA / Supabase PRUEBAS / Sincronizador | aa_sync_worker remoto: transporte; su contraseña forma parte de AA_SYNC_DB_URL. |
| AA / Aplicación / usuario / correo | Contraseña de ingreso del usuario en Supabase Auth; distinta de todas las contraseñas PostgreSQL. |

AA_SYNC_CA_FILE es una ruta de certificado, no una contraseña. AA_SYNC_DB_URL
es una URI que contiene un secreto: guardar como campo privado del registro del
sincronizador. Separar los registros de PRUEBAS y PRODUCCIÓN cuando se configure
la PC definitiva; no reutilizar contraseñas ni guardarlas en Git. Supabase Auth
no entrega contraseñas a PostgreSQL local; el acceso offline conserva un
verificador temporal del ingreso ya validado, no una contraseña administrativa.

### 4.13 Recepción de recursos clínicos relacionados

Verificado por el usuario el paso 4.12: edición remota recibida, edición local
posterior confirmed: 1, edición simultánea conflict: 1 / protected: 1, resolución
revisada conservando el local confirmed: true y ciclo siguiente sin conflictos.
La preferencia para resolver conflictos es conservar el local, con revisión
explícita antes de sobrescribir la versión de Supabase.

Implementada recepción de altas y ediciones de vaccinations, medications,
allergies, pet_notes, weight_records y clinical_files. Reutiliza el receptor
existente y su referencia remota. Cada tabla recorre hasta 500 UUID por ciclo;
los cursores son independientes y viven en memoria. Primero se reciben mascotas,
luego expedientes y luego recursos. Una mascota o consulta aún no recibida
aplaza su recurso para la siguiente vuelta. Los medicamentos vinculados deben
corresponder a la mascota de la consulta. La lectura remota conserva RLS y
verifica el perfil clínico activo. No hay nuevos permisos remotos.

Se protege cualquier operación sin confirmar del mismo recurso, incluidas
eliminaciones locales aunque la fila ya no exista. También se protegen padres
con eliminación pendiente. Se comprueba bajo bloqueo antes de escribir; las
restricciones y claves foráneas permanecen vigentes. Una recepción no añade
operaciones a la cola. La edición/eliminación posterior usa la nueva referencia
remota aunque existan recibos anteriores. Las filas iguales no cambian versión.

clinical_files recibe solo metadatos y valida la ruta uploaded/, nombre, tipo,
tamaño y checksum con el validador existente. No descarga, crea ni elimina
archivos físicos ni confirma que existan en disco. Una referencia recibida puede
aparecer en la ficha y devolver archivo no encontrado si falta en esta PC.
Las ausencias remotas no eliminan copias locales.

Detener --watch con Ctrl+C antes de aplicar, conservar variables en su terminal.
Aplicar UNA VEZ con postgres LOCAL y su contraseña administrativa local:

```powershell
& 'C:\Program Files\PostgreSQL\18\bin\psql.exe' -X -h 127.0.0.1 -p 5432 -U postgres -d accion_animal_dev -W -v ON_ERROR_STOP=1 -f 'db/local/migrations/006_clinical_resources_inbound.sql'
```

Después de COMMIT, ejecutar la comprobación SQL:

```powershell
& 'C:\Program Files\PostgreSQL\18\bin\psql.exe' -X -h 127.0.0.1 -p 5432 -U postgres -d accion_animal_dev -W -v ON_ERROR_STOP=1 -f 'db/local/tests/clinical_resources_inbound.test.sql'
```

Crea datos ficticios de las seis tablas y termina en ROLLBACK sin conservarlos.
En la terminal que conserva las credenciales, ejecutar después --once. El
sincronizador comprueba columnas de recepción en todas las tablas ANTES de
enviar pendientes; sin 006 cancela y no ejecuta el ciclo.

```powershell
node --env-file-if-exists=.env.local --env-file-if-exists=.env.server scripts/sync-test-data.mjs --once
```

Estado actualizado el 28 de septiembre de 2026: migración 006 presente y prueba
SQL aprobada. En PRUEBAS ya se observaron `received: 1` para pet_notes,
vaccinations y weight_records; el usuario confirmó que la nota recibida aparece
en la ficha. Un ciclo posterior confirmó dos operaciones locales sin conflictos
ni pendientes. No repetir esas pruebas. Medicamentos, alergias y metadatos de
adjuntos se revisaron en ciclos sin cambios; no editar campos que la interfaz
local no ofrece solo para producir otro contador.

### 4.14 Eliminaciones remotas de recursos clínicos

`--once` y `--watch` revisan también las filas locales de vaccinations,
medications, allergies, pet_notes, weight_records, clinical_files y, al final,
clinical_records y pets. Una fila
ausente en Supabase se quita localmente solo si su versión actual proviene de
una recepción remota o de una operación local confirmada y no hay operaciones
sin confirmar. La ausencia se vuelve a verificar con la fila local bloqueada.
No se elimina ningún archivo físico. Un expediente se conserva mientras tenga
adjuntos o medicamentos vinculados en la PC. Una mascota se conserva mientras
tenga cualquier expediente, vacuna, medicamento, alergia, nota o peso local.
Las recepciones anteriores pueden quitar esos vínculos y una vuelta posterior
eliminar al padre. Una operación pendiente o versión local no verificada lo
protege aunque la fila ya no exista en Supabase.

No requiere migración ni cambios en las tablas. Para comprobarlo con datos
ficticios visibles en la interfaz: detener `--watch`, borrar en Supabase de
PRUEBAS una nota (`pet_notes`) y una vacuna (`vaccinations`) ya sincronizadas,
ejecutar `--once` en la terminal con las tres variables cargadas y revisar
`Eliminaciones clínicas de PRUEBAS` con `deleted: 1` para cada tabla. Recargar
la ficha local. Si no hay notas ficticias, omitir esa prueba. Probar después
un expediente ficticio sin adjuntos ni medicamentos vinculados: la línea de
`clinical_records` debe mostrar `deleted: 1` y la consulta desaparecer tras
recargar la ficha. No probar campos que la interfaz local no permite editar.
El usuario verificó `deleted: 4` en clinical_files y `deleted: 1` en
clinical_records, después de eliminar un expediente remoto ficticio. La
recepción de mascotas eliminadas sigue pendiente de verificación conectada:
eliminar en Supabase de PRUEBAS una mascota ficticia, ejecutar `--once` con
`--watch` detenido y comprobar `Eliminaciones de mascotas de PRUEBAS` con
`deleted: 1`. Si tenía recursos clínicos, sus líneas deben mostrar las bajas
primero; los archivos físicos permanecen en la PC. Recargar la lista local.

El usuario verificó después `deleted: 1` para mascotas, sin conflictos ni
pendientes. La prueba usó exclusivamente datos ficticios de PRUEBAS.

### 4.15 Respaldo local inicial

`scripts/backup-local.ps1` crea una copia completa de `accion_animal_dev` con
`pg_dump` y de la carpeta configurada como `AA_STORAGE_ROOT`. La base incluye
las operaciones pendientes de sincronización. No copia contraseñas, certificados
ni archivos `.env`; conserva esos secretos por separado en el gestor de
contraseñas. Exige un destino ya existente, fuera de `uploaded`, por ejemplo un
USB cifrado. Pide la contraseña de **postgres LOCAL**, distinta de la de
`aa_local_app` y de las cuentas de Supabase.

En la PC definitiva, ajustar las rutas reales y ejecutar desde la carpeta del
proyecto:

```powershell
& .\scripts\backup-local.ps1 -Destination 'F:\RespaldosAA' -StorageRoot 'E:\AccionAnimal\uploaded' -PgBin 'C:\Program Files\PostgreSQL\18\bin'
```

El comando crea una carpeta con fecha, verifica que `pg_restore` lea el dump,
compara la copia de archivos con `robocopy /L` y solo entonces escribe
`COMPLETO.txt`. Si falla, la carpeta puede estar incompleta: no usarla como
respaldo verificado. La comprobación definitiva es restaurar periódicamente una
copia en una base y carpeta de ensayo separadas. Aún no se ha ejecutado en la
PC definitiva ni se ha programado una tarea diaria; primero falta verificar una
ejecución real y la restauración de prueba.

Por decisión del usuario, la ejecución y restauración de respaldo quedan fuera
de los objetivos actuales en esta PC de desarrollo. Retomar antes de usar datos
reales en el servidor definitivo.

### 4.16 Recepción incremental después de la carga inicial

La migración local `007_incremental_inbound.sql` se aplicó en esta PC. La
migración remota `20260928184202_incremental_inbound_sync.sql` se aplicó solo al
proyecto de PRUEBAS. El trabajador guarda el ID inicial de `audit_events`,
termina una vuelta de carga por las ocho tablas y después consulta hasta 100
eventos nuevos por ciclo. Las filas protegidas se reintentan cada cinco minutos.
El envío local sigue ejecutándose al comienzo de cada ciclo.

La cuenta `aa_sync_worker` puede leer los identificadores y tipos de evento,
sin recibir los datos clínicos del registro de auditoría. El disparador remoto
ordena los eventos entre transacciones para que el cursor no salte escrituras
que terminan después. La consulta de permisos en PRUEBAS y las pruebas de código
pasaron. Falta observar un ciclo conectado con una edición ficticia reciente;
esto no requiere repetir las pruebas anteriores de notas, vacunas o pesos.

### 4.17 Importación inicial de PRODUCCIÓN a esta PC

La base `accion_animal_produ` se preparó con la estructura local, tres filas de
`sync_state` y una cola vacía. No se cambió el proyecto Supabase de producción.
Antes de importar, aplicar `db/local/migrations/008_multiple_owners.sql` en
`accion_animal_produ` y `accion_animal_dev`: producción contiene dos perfiles
`owner` y el índice único local anterior impide copiarlos. La recepción de
perfiles compartida también admite ahora más de un `owner`.
El modo `--production` de `scripts/import-test-data.mjs` acepta únicamente el
Session pooler del proyecto `hvfubwyzarikudisbwfy` con el usuario `postgres`.
El origen usa una transacción `REPEATABLE READ READ ONLY`; el destino es solo
`accion_animal_produ`. La importación exige que las tablas de negocio y la cola
estén vacías, verifica columnas y recuentos, y nunca envía operaciones.

En PowerShell, desde la raíz del repositorio, tomar el host del Session pooler
en **Connect** del proyecto de producción, sin incluir usuario ni contraseña:

```powershell
$env:AA_PROD_DB_HOST = 'HOST-DEL-SESSION-POOLER'
$env:AA_PROD_DB_PASSWORD = [System.Net.NetworkCredential]::new('', (Read-Host 'Contraseña PostgreSQL de Supabase PRODUCCIÓN' -AsSecureString)).Password
$env:AA_DB_PASSWORD = [System.Net.NetworkCredential]::new('', (Read-Host 'Contraseña local de aa_local_app' -AsSecureString)).Password
node scripts/import-test-data.mjs --production --check
node scripts/import-test-data.mjs --production --apply
```

`--check` deshace todos los cambios locales al terminar. `--apply` confirma
solo la copia local y muestra los recuentos. `scripts/sync-test-data.mjs`
permanece fijado al proyecto de PRUEBAS; para producción usar únicamente
`scripts/sync-production.mjs` después de su preparación. Los adjuntos físicos no están incluidos;
`clinical_files` copia solo metadatos.

### 4.18 Interfaz local de PRODUCCIÓN

`.env.production.local` contiene la URL y la clave publicable copiadas del
proyecto original de producción, junto con `AA_DB_NAME=accion_animal_produ` y
`AA_STORAGE_ROOT=uploaded/production`. El archivo está excluido de Git. La
compilación de pruebas sigue usando `.env.local` y `accion_animal_dev`.

En la misma PowerShell, cargar la contraseña de `aa_local_app` y arrancar:

```powershell
$env:AA_DB_PASSWORD = [System.Net.NetworkCredential]::new('', (Read-Host 'Contraseña local de aa_local_app' -AsSecureString)).Password
npm run local:production
```

La interfaz de producción queda en `http://127.0.0.1:4174`. Este arranque
comprueba que la compilación y PostgreSQL local correspondan a producción.
Por ahora es una vista de la copia inicial: todavía no hay sincronizador de
producción ni archivos físicos de los adjuntos históricos.

### 4.19 Recepción puntual de una mascota de PRODUCCIÓN

Con `AA_PROD_DB_HOST`, `AA_PROD_DB_PASSWORD`, `AA_DB_PASSWORD` y
`AA_SYNC_CA_FILE` cargadas en la PowerShell, `scripts/receive-production-pet.mjs`
permite `--check UUID`, `--once UUID` y `--watch UUID`. `--check` muestra los
campos distintos y las operaciones locales pendientes sin mostrar valores.
`--once` recibe solo ese UUID en `accion_animal_produ`; `--watch` repite la
recepción cada 30 segundos y se detiene si hay una edición local pendiente.
La conexión PostgreSQL de Supabase tiene
transacciones de solo lectura y el comando no ejecuta `sendPending` ni elimina
mascotas. No sustituye la sincronización continua de producción.

Para enviar una edición local pendiente del nombre de una sola mascota,
`scripts/send-production-pet-name.mjs --check UUID_MASCOTA UUID_OPERACIÓN`
comprueba la versión original, el autor y que el único campo cambiado sea
`name`. `--apply` repite las comprobaciones bajo bloqueo, actualiza ese nombre
en Supabase y confirma la operación local. Rechaza eliminaciones, otras
operaciones pendientes y cambios remotos simultáneos.

### 4.20 Sincronización general de PRODUCCIÓN

`scripts/check-production-sync.mjs` consulta la preparación remota y la cola
local sin cambiar datos. Si `scripts/prepare-production-sync.mjs --check`
indica `ready_to_apply: true`, su modo `--apply` aplica en una transacción las
tres migraciones de transporte, lectura de perfiles y auditoría ordenada. Crea
`aa_sync_worker` sin LOGIN; no toca filas clínicas existentes. Configurarle una
contraseña y LOGIN por separado en `psql` conectado al proyecto de PRODUCCIÓN.

```powershell
$env:PGSSLMODE = 'verify-full'
$env:PGSSLROOTCERT = (Resolve-Path .\prod-ca-2021.crt).Path
& 'C:\Program Files\PostgreSQL\18\bin\psql.exe' -X -h $env:AA_PROD_DB_HOST -p 5432 -U postgres.hvfubwyzarikudisbwfy -d postgres -W
```

Dentro de `psql`: `\password aa_sync_worker`, después
`ALTER ROLE aa_sync_worker LOGIN;` y `\q`. En PowerShell, cargar la contraseña
nueva solo en la sesión actual:

```powershell
$env:AA_PROD_WORKER_PASSWORD = [System.Net.NetworkCredential]::new('', (Read-Host 'Contraseña de aa_sync_worker PRODUCCIÓN' -AsSecureString)).Password
node --env-file=.env.production.local scripts/sync-production.mjs --check
```

`scripts/sync-production.mjs --check` verifica la cuenta limitada y muestra
las operaciones locales que se enviarían. `--once` procesa hasta 50 operaciones
pendientes y un lote de 500 registros por tabla; `--watch` repite el ciclo. Solo las
operaciones explícitas de `aa_local.sync_operations` pueden escribir o eliminar
en Supabase. Una fila ausente en la copia local no genera una eliminación
remota. La recepción remota modifica únicamente PostgreSQL local y protege
cambios locales pendientes. Durante el primer recorrido usa pausas de dos
segundos; después consulta la auditoría cada 30 segundos.
