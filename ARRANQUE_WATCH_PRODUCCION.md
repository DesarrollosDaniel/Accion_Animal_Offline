# Arrancar la sincronización de producción con Windows

Haz estos pasos **en la PC que tiene PostgreSQL local y `accion_animal_produ`**. La tarea ejecutará `scripts/sync-production.mjs --watch` al encender Windows, aunque nadie inicie sesión. Es independiente de la tarea que arranca el servidor de la aplicación.

## 1. Comprobar el proyecto

Abre PowerShell en la carpeta del proyecto. Comprueba que existen `node_modules`, `.env.production.local`, `scripts/start-production-watch.ps1` y PostgreSQL local. El archivo `.env.production.local` ya debe contener la configuración de producción indicada en [db/local/README.md](db/local/README.md#420-sincronización-general-de-producción). Añade ahí estas variables **sin contraseñas**:

```dotenv
AA_PROD_DB_HOST=HOST-DEL-SESSION-POOLER
AA_SYNC_CA_FILE=RUTA_COMPLETA_DEL_CERTIFICADO_CA
```

Usa el host real del *Session pooler* de producción y la ruta real del certificado CA. Si PostgreSQL no está instalado en `C:\Program Files\PostgreSQL\18`, indica la ruta de `pg_isready.exe` en los argumentos de la tarea del paso 4.

## 2. Guardar las dos contraseñas para esta cuenta de Windows

Inicia sesión con **la misma cuenta de Windows que ejecutará la tarea**. En PowerShell, desde la carpeta del proyecto, ejecuta:

```powershell
$secretDir = Join-Path $env:APPDATA 'AccionAnimal'
New-Item -ItemType Directory -Force $secretDir | Out-Null
Read-Host 'Contraseña local de aa_local_app' -AsSecureString | ConvertFrom-SecureString | Set-Content (Join-Path $secretDir 'local-db-password.txt')
Read-Host 'Contraseña de aa_sync_worker PRODUCCIÓN' -AsSecureString | ConvertFrom-SecureString | Set-Content (Join-Path $secretDir 'production-worker-password.txt')
```

Windows cifra estos archivos para esa cuenta en esa PC. No los copies a otra cuenta o computadora; allí hay que crearlos de nuevo. Si cambias una contraseña, repite su comando. No guardes las contraseñas en `.env.production.local`.

## 3. Probar antes de automatizar

Desde la misma carpeta, ejecuta (agrega `-PgIsReady "RUTA_COMPLETA\pg_isready.exe"` si PostgreSQL está instalado en otra ruta):

```powershell
powershell.exe -NoProfile -File .\scripts\start-production-watch.ps1
```

El script espera hasta cinco minutos a que PostgreSQL local acepte conexiones. Después inicia el `--watch`. Comprueba que empieza a sincronizar y detén esta prueba con `Ctrl+C` antes de crear la tarea, para no tener dos sincronizadores. Si falla, corrige la ruta de PostgreSQL, la configuración o las contraseñas antes de continuar.

## 4. Crear la tarea programada

Abre **Programador de tareas** como administrador y selecciona **Crear tarea...**:

1. **General:** nombre `Accion Animal - Watch producción`; selecciona la misma cuenta del paso 2 y marca **Ejecutar tanto si el usuario inició sesión como si no**. Deja desmarcada **No almacenar contraseña**, para que Windows pueda descifrar los archivos del paso 2.
2. **Desencadenadores:** **Al iniciar el sistema**; marca **Retrasar la tarea durante 30 segundos**.
3. **Acciones → Iniciar un programa:**
   - **Programa o script:** `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`
   - **Agregar argumentos:** `-NoProfile -File "RUTA_COMPLETA_DEL_PROYECTO\scripts\start-production-watch.ps1"`
   - **Iniciar en:** `RUTA_COMPLETA_DEL_PROYECTO` (sin comillas).
   - Si tu instalación de PostgreSQL usa otra ruta, agrega al final de los argumentos `-PgIsReady "RUTA_COMPLETA\pg_isready.exe"`.
4. **Configuración:** marca **Si la tarea falla, reiniciar cada 1 minuto** y el máximo de intentos disponible; selecciona **No iniciar una instancia nueva** y desmarca **Detener la tarea si se ejecuta durante más de...**.
5. Guarda la tarea. Windows puede pedir la contraseña de esa cuenta.

El retraso da tiempo al arranque de Windows. El script espera la disponibilidad real de PostgreSQL. Si el proceso termina por error, el Programador lo vuelve a iniciar; una caída de Internet durante la ejecución se reintenta dentro del propio `--watch` cada 30 segundos.

## 5. Verificar

Selecciona la tarea y pulsa **Ejecutar**. Debe mostrar estado **En ejecución**. Reinicia la PC y confirma que vuelve a ese estado sin abrir PowerShell. En **Historial** o **Último resultado** del Programador revisa cualquier fallo. Para detenerlo, selecciona **Finalizar**; para impedir que arranque al encender, selecciona **Deshabilitar**.
