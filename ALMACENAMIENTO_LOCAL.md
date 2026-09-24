# Instalación local con Supabase y la carpeta `uploaded`

## Resultado

Una PC Windows funciona como servidor dentro del consultorio:

- Supabase Free conserva la base de datos, usuarios y sesiones.
- El disco de esa PC conserva imágenes y documentos.
- Las demás computadoras abren la aplicación con la IP local de la PC servidor.
- No se necesita dominio, GitHub Pages, Tailscale ni abrir puertos en el módem Arris.
- Las rutas históricas `uploaded/...` y `uploaded/clinicos/...` se mantienen.

La aplicación requiere Internet para comunicarse con Supabase. Si se cae Internet, los archivos siguen en el disco, pero no se podrá iniciar sesión ni consultar la base de datos hasta recuperar la conexión.

## Antes de mover el sistema

1. Elige la PC Windows que permanecerá encendida durante el horario de uso.
2. Conéctala al módem por cable Ethernet si es posible.
3. Instala Node.js 22 LTS o una versión LTS posterior en su ubicación predeterminada de Windows, en `C:`.
4. Usa la unidad `E:` para la aplicación y sus archivos. Debe tener al menos 50 GB libres. Hoy la carpeta ocupa aproximadamente 15.8 GB, pero conviene dejar margen para crecimiento y respaldos.
5. Abre PowerShell y crea las carpetas:

   ```powershell
   New-Item -ItemType Directory -Force E:\AccionAnimal\app
   New-Item -ItemType Directory -Force E:\AccionAnimal\uploaded
   ```

6. Instala Git for Windows y descarga el proyecto:

   ```powershell
   git clone https://github.com/DesarrollosDaniel/Accion-Anima-Supabase.git E:\AccionAnimal\app\accion-animal-supabase
   ```

7. Copia **el contenido** de la carpeta histórica que hoy corresponde a `uploaded\uploaded` dentro de `E:\AccionAnimal\uploaded`.

El resultado debe verse así:

```text
E:\AccionAnimal\uploaded\foto.jpg
E:\AccionAnimal\uploaded\clinicos\36\archivos\1679520418\archivo.pdf
```

No debe quedar un nivel duplicado como `E:\AccionAnimal\uploaded\uploaded\...`.

## Configurar la PC servidor

En `E:\AccionAnimal\app\accion-animal-supabase`, copia `.env.example` como `.env.local`. Cada variable debe estar en su propia línea, sin formato de enlace ni barras antes de los guiones bajos:

```dotenv
VITE_SUPABASE_URL=https://hvfubwyzarikudisbwfy.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=REEMPLAZAR_CON_LA_CLAVE_PUBLICABLE

AA_STORAGE_ROOT=E:\AccionAnimal\uploaded
AA_HOST=0.0.0.0
AA_PORT=4173
AA_MAX_UPLOAD_BYTES=52428800
```

La clave publicable se obtiene en **Supabase → Project Settings → API Keys → Publishable key**. No coloques la clave `service_role` ni una clave secreta en este archivo o en la aplicación.

Abre PowerShell en esa carpeta y ejecuta:

```powershell
npm.cmd ci
npm.cmd run local
```

Se usa `npm.cmd` porque PowerShell puede bloquear `npm.ps1` en una instalación nueva. No es necesario cambiar la política de ejecución. `npm.cmd run local` compila la aplicación y levanta el servidor completo en el puerto fijo `4173`. No uses `npm run dev` en la PC servidor: ese comando solo inicia la interfaz y mostrará que el almacenamiento local no está disponible.

La consola debe mostrar que Acción Animal está disponible y que el almacenamiento local está preparado. Mantén esa ventana abierta mientras uses el sistema; para iniciarlo automáticamente con Windows, sigue [`SERVICIO_SIEMPRE_ACTIVO.md`](SERVICIO_SIEMPRE_ACTIVO.md).

## Permitir acceso en la red local

Abre PowerShell **como administrador** en la PC servidor y revisa el perfil de la conexión:

```powershell
Get-NetConnectionProfile
```

Si `NetworkCategory` aparece como `Public`, usa el `InterfaceIndex` mostrado por ese comando para cambiar la red confiable del consultorio a privada. Por ejemplo:

```powershell
Set-NetConnectionProfile -InterfaceIndex 20 -NetworkCategory Private
Get-NetConnectionProfile
```

No continúes hasta que muestre `NetworkCategory : Private`. Después crea y verifica la regla limitada a ese perfil:

```powershell
New-NetFirewallRule -DisplayName "Accion Animal local 4173" -Direction Inbound -Protocol TCP -LocalPort 4173 -Action Allow -Profile Private
Get-NetFirewallRule -DisplayName "Accion Animal local 4173"
```

Si PowerShell responde `Acceso denegado`, la ventana no se abrió como administrador. En una sesión remota por AnyDesk también se debe solicitar elevación para poder aceptar el aviso de Windows.

No configures `Port Forwarding`, `Virtual Server`, `NAT` ni `DMZ` en el módem Arris.

Comprueba que la conexión de Windows esté marcada como **Red privada**. Obtén la IPv4 de la PC servidor con:

```powershell
ipconfig
```

Desde otra computadora conectada al mismo módem, abre, por ejemplo:

```text
http://192.168.0.25:4173
```

Sustituye `192.168.0.25` por la IPv4 real del servidor. Conviene reservar esa IP para la PC en la configuración DHCP del módem o asignarle una IP fija dentro de la red local.

## Crear accesos

No se necesitan enlaces de invitación, dominio ni configuración de redirecciones. En la sección **Usuarios**, el dueño escribe el nombre, correo, rol y contraseña de la persona.

Supabase valida los datos en ese instante y deja la cuenta confirmada. Si el correo ya existe o la contraseña no cumple las reglas, la pantalla muestra el error y no crea un acceso incompleto. Solamente el rol `owner` puede ejecutar esta operación; las claves administrativas permanecen dentro de la función segura de Supabase.

## Seguridad y permisos

- Nadie puede leer `/uploaded/...` sin iniciar sesión con un usuario activo de Supabase.
- Dueño y Veterinaria pueden escribir y eliminar archivos clínicos.
- Recepción puede agregar fotos principales, pero no modificar archivos clínicos.
- El servidor rechaza rutas que intenten salir de la carpeta configurada y no muestra listados de directorios.
- Las sesiones locales se guardan solamente en memoria; al reiniciar el servidor, cada usuario vuelve a iniciar sesión.

## Respaldos recomendados

Usa dos destinos distintos:

1. copia diaria incremental de `E:\AccionAnimal\uploaded` a un disco USB que no permanezca siempre conectado;
2. copia semanal en otro disco o ubicación física.

Supabase respalda la base de datos según las condiciones del plan, pero no respalda esta carpeta local. Antes de borrar duplicados o archivos sin referencia, conserva una copia completa verificada.

## Comprobación rápida

En la PC servidor abre:

```text
http://localhost:4173/api/health
```

Debe responder con `"ok":true`. Después inicia sesión en `http://localhost:4173`. Las mascotas cuyo campo `photo_path` contenga un nombre o una ruta `uploaded/...` mostrarán la imagen servida desde el disco local.
